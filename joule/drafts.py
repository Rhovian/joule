import json
from datetime import UTC, datetime

from pydantic import Field, create_model

from joule import ai, score
from joule.config import StrictModel

KINDS = {"cover_letter": "Cover Letter", "proposal": "Proposal"}


class CoverLetter(StrictModel):
    text: str


async def write(db, job, kind, note, settings, data_dir):
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
    samples = data_dir / "profile" / "samples"
    files = score.profile_files(data_dir) + [
        (f"samples/{p.relative_to(samples).as_posix()}", p.read_bytes())
        for p in sorted(samples.rglob("*"))
        if p.is_file() and p.suffix in {".md", ".txt", ".yaml"}
    ]
    profile = "\n".join(f"## {name}\n{contents.decode()}" for name, contents in files)
    prompt = (
        f"Write a {KINDS[kind]} in the owner's voice from the Profile. "
        "Use samples as style examples only. Never state pay floors or preferences. "
        "Never invent experience. For a Proposal, give one answer per screening "
        "question, in order.\n"
        f"Profile:\n{profile}\nFit Score reason: {job['score_reason'] or ''}\n"
        f"Owner's note: {note or ''}\n{score.job_block(job)}"
    )
    result = await ai.retry_structured(settings.models.drafts, prompt, schema)
    with db:
        db.execute(
            "INSERT INTO drafts (job_id,kind,text,note,model,created_at) VALUES (?,?,?,?,?,?)",
            (
                job["id"],
                kind,
                result.model_dump_json(),
                note,
                settings.models.drafts.model,
                datetime.now(UTC).isoformat(),
            ),
        )
