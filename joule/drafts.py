import json
from datetime import UTC, datetime

from pydantic import Field, create_model

from joule import ai, cv, score
from joule.config import StrictModel
from joule.sources import upwork
from joule.upwork_auth import UpworkNotConnected

KINDS = {
    "cover_letter": "Cover Letter",
    "proposal": "Proposal",
    "tailored_cv": "Tailored CV",
}


RULES = (
    "Use samples as style examples only. Never state pay floors or preferences. "
    "Never invent experience. Lead with the experience most relevant to this Job, "
    "not the most recent, and don't default to the same project in every draft. Cite links from portfolio.yaml only where they fit the "
    "Job. When the Job asks for a video such as a Loom, give the best-fitting video "
    "link from portfolio.yaml; if none fits, write [LOOM LINK]. Never invent a URL. "
    "In a Proposal, never include email, phone, LinkedIn or other contact details; "
    "GitHub and portfolio links are fine. Nothing is attached to a Proposal: never "
    "say a CV or resume is attached; give the cv link from portfolio.yaml instead. "
)


class CoverLetter(StrictModel):
    text: str


class Answer(StrictModel):
    answer: str = Field(max_length=5000)


def context(job, data_dir):
    samples = data_dir / "profile" / "samples"
    portfolio = data_dir / "profile" / "portfolio.yaml"
    files = score.profile_files(data_dir) + [
        (f"samples/{p.relative_to(samples).as_posix()}", p.read_bytes())
        for p in sorted(samples.rglob("*"))
        if p.is_file() and p.suffix in {".md", ".txt", ".yaml"}
    ]
    if portfolio.is_file():
        files.append(("portfolio.yaml", portfolio.read_bytes()))
    profile = "\n".join(f"## {name}\n{contents.decode()}" for name, contents in files)
    return (
        f"Profile:\n{profile}\nFit Score reason: {job['score_reason'] or ''}\n"
        f"{score.job_block(job)}"
    )


async def answer(job, question, settings, data_dir):
    prompt = (
        "Answer the owner's application question about this Job in the owner's "
        f"voice from the Profile. {RULES}\nQuestion: {question}\n"
        f"{context(job, data_dir)}"
    )
    result = await ai.retry_structured(settings.models.drafts, prompt, Answer)
    return result.answer


async def write(db, job, kind, note, settings, data_dir, auth=None):
    # Screening questions are fetched once, on the first Proposal, not during Scans.
    if kind == "proposal" and "screening_questions" not in json.loads(
        job["extra"] or "{}"
    ):
        try:
            questions = await upwork.screening_questions(auth, job["source_id"])
        except (upwork.UpworkError, UpworkNotConnected) as error:
            raise ai.AIError(f"Screening questions: {error!r}") from error
        with db:
            db.execute(
                "UPDATE jobs SET extra=json_set(coalesce(extra, '{}'), "
                "'$.screening_questions', json(?)) "
                "WHERE id=? AND content_purged_at IS NULL",
                (json.dumps(questions), job["id"]),
            )
        job = db.execute("SELECT * FROM jobs WHERE id=?", (job["id"],)).fetchone()
    count = len(json.loads(job["extra"] or "{}").get("screening_questions", []))
    schema = (
        CoverLetter
        if kind == "cover_letter"
        else create_model(
            "Proposal",
            __base__=StrictModel,
            cover=(str, ...),
            answers=(list[str], Field(min_length=count, max_length=count)),
        )
    )
    if kind == "tailored_cv":
        master, schema = cv.prepare(data_dir)
    openings = ""
    if kind != "tailored_cv":
        recent = db.execute(
            "SELECT text FROM drafts WHERE kind IN ('proposal', 'cover_letter') "
            "ORDER BY id DESC LIMIT 10"
        ).fetchall()
        openings = "Recent openings of other drafts; lead with different experience "
        openings += "unless this Job clearly calls for the same:\n" + "".join(
            f"- {(c.get('cover') or c.get('text', ''))[:200]}\n"
            for c in (json.loads(text) for (text,) in recent)
        )
    prompt = (
        f"Write a {KINDS[kind]} in the owner's voice from the Profile. {RULES}"
        "For a Proposal, give one answer per screening "
        "question, in order. For a Tailored CV, select only work and projects that fit "
        "this Job, ordered as they should appear. Rewrite selected source bullets and "
        "descriptions; never invent facts, numbers, employers, titles or dates. "
        "Keep it to about two pages.\n"
        f"{openings}Owner's note: {note or ''}\n{context(job, data_dir)}"
    )
    result = await ai.retry_structured(settings.models.drafts, prompt, schema)
    document = (
        cv.resolve(master, result) if kind == "tailored_cv" else result.model_dump()
    )
    with db:
        db.execute(
            "INSERT INTO drafts (job_id,kind,text,note,model,created_at) VALUES (?,?,?,?,?,?)",
            (
                job["id"],
                kind,
                json.dumps(document),
                note,
                settings.models.drafts.model,
                datetime.now(UTC).isoformat(),
            ),
        )
