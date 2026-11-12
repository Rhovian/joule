import json
from contextlib import closing
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import Field

from joule import ai, cv, drafts, job_urls, score
from joule.config import StrictModel, load_settings
from joule.db import connect
from joule.scan import ADAPTERS, ScanInProgress

router = APIRouter(prefix="/api")
SOURCE_FILTER = (
    "(? OR source IN (SELECT value FROM json_each(?)) OR EXISTS "
    "(SELECT 1 FROM jobs d WHERE d.primary_id = jobs.id "
    "AND d.source IN (SELECT value FROM json_each(?))))"
)

SHOW_CATEGORY = (
    "CASE WHEN state='applied' THEN 'applied' "
    "WHEN state='dismissed' THEN 'dismissed' "
    "WHEN filtered_reason IS NOT NULL THEN 'filtered' "
    "WHEN score IS NULL THEN 'unscored' ELSE 'new' END"
)


SEARCH_FILTER = (
    "instr(casefold(title || ' ' || COALESCE(company, '') || ' ' || "
    "COALESCE(score_reason, '') || ' ' || COALESCE(filtered_reason, '')), ?) > 0"
)


MIN_SCORE_FILTER = "(? IS NULL OR score >= ?)"


def source_params(source):
    return (not source, json.dumps(source or []), json.dumps(source or []))


def duplicates(db, job_id):
    return [
        dict(row)
        for row in db.execute(
            "SELECT id, source, link FROM jobs WHERE primary_id=? ORDER BY id",
            (job_id,),
        )
    ]


@router.get("/jobs")
async def list_jobs(
    request: Request,
    unscored: bool = True,
    new: bool = True,
    filtered: bool = False,
    dismissed: bool = False,
    applied: bool = False,
    source: Annotated[list[str] | None, Query()] = None,
    sort: Literal["rank", "score", "newest"] = "rank",
    q: str = "",
    min_score: Annotated[int | None, Query(ge=0, le=100)] = None,
):
    directory = request.app.state.data_dir
    stamp = score.fingerprint(directory, load_settings(directory))
    with closing(connect(directory / "joule.db")) as db:
        rows = db.execute(
            f"SELECT jobs.*, {score.RANK} AS rank, drafted.job_id IS NOT NULL AS has_drafts "
            "FROM jobs LEFT JOIN (SELECT DISTINCT job_id FROM drafts) drafted "
            "ON drafted.job_id=jobs.id WHERE primary_id IS NULL "
            f"AND {SHOW_CATEGORY} IN (SELECT value FROM json_each(?)) "
            f"AND {SOURCE_FILTER} "
            f"AND {SEARCH_FILTER} AND {MIN_SCORE_FILTER} "
            f"ORDER BY {'COALESCE(posted_at, first_seen_at)' if sort == 'newest' else sort} "
            "DESC NULLS LAST, posted_at DESC, jobs.id DESC LIMIT 500",
            (
                json.dumps(
                    [
                        name
                        for name, enabled in zip(
                            ["new", "unscored", "filtered", "applied", "dismissed"],
                            [new, unscored, filtered, applied, dismissed],
                        )
                        if enabled
                    ]
                ),
                *source_params(source),
                q.strip().casefold(),
                min_score,
                min_score,
            ),
        ).fetchall()
        return [
            {
                k: value
                for k, value in dict(row).items()
                if k not in ("description", "extra", "score_points")
            }
            | {
                "duplicates": duplicates(db, row["id"]),
                "has_drafts": bool(row["has_drafts"]),
                "score_stale": row["score"] is not None
                and row["score_fingerprint"] != stamp,
            }
            for row in rows
        ]


@router.get("/jobs/counts")
def job_counts(
    request: Request,
    source: Annotated[list[str] | None, Query()] = None,
    q: str = "",
    min_score: Annotated[int | None, Query(ge=0, le=100)] = None,
):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        rows = db.execute(
            f"SELECT {SHOW_CATEGORY} AS category, COUNT(*) AS count "
            f"FROM jobs WHERE primary_id IS NULL AND {SOURCE_FILTER} "
            f"AND {SEARCH_FILTER} AND {MIN_SCORE_FILTER} GROUP BY category",
            (*source_params(source), q.strip().casefold(), min_score, min_score),
        ).fetchall()
        return dict.fromkeys(
            ["new", "unscored", "filtered", "applied", "dismissed"], 0
        ) | {row["category"]: row["count"] for row in rows}


@router.get("/jobs/resolve")
def resolve_job(request: Request, url: Annotated[str, Query(max_length=8192)]):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        return job_urls.resolve(db, url)


class ScoreAllRequest(StrictModel):
    ids: list[Annotated[int, Field(gt=0)]] = Field(min_length=1, max_length=500)


@router.post("/jobs/score", status_code=202)
async def score_all(request: Request, body: ScoreAllRequest):
    directory = request.app.state.data_dir
    with closing(connect(directory / "joule.db")) as db:
        sources = [
            row[0]
            for row in db.execute(
                "SELECT DISTINCT source FROM jobs WHERE id IN "
                "(SELECT value FROM json_each(?))",
                (json.dumps(body.ids),),
            )
        ]
    try:
        return {
            "id": request.app.state.scanner.start(
                sources, "manual", load_settings(directory), None, job_ids=body.ids
            )
        }
    except ScanInProgress:
        raise HTTPException(409, "Scan or scoring in progress") from None


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: int):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Job not found")
        result = dict(row) | {"duplicates": duplicates(db, job_id)}
        result["draft_versions"] = {}
        for draft in db.execute(
            "SELECT id,kind,text AS content,note,created_at FROM drafts "
            "WHERE job_id=? ORDER BY id",
            (job_id,),
        ):
            result["draft_versions"].setdefault(draft["kind"], []).append(
                dict(draft) | {"content": json.loads(draft["content"])}
            )
        result["drafts"] = {
            kind: versions[-1] for kind, versions in result["draft_versions"].items()
        }
    directory = request.app.state.data_dir
    result["score_stale"] = result["score"] is not None and result[
        "score_fingerprint"
    ] != score.fingerprint(directory, load_settings(directory))
    for key in ("extra", "score_points"):
        result[key] = json.loads(result[key]) if result[key] is not None else None
    return result


@router.post("/jobs/{job_id}/score")
async def rescore_job(request: Request, job_id: int, body: StrictModel):
    directory = request.app.state.data_dir
    with closing(connect(directory / "joule.db")) as db:
        if not db.execute(
            "SELECT 1 FROM jobs WHERE id=? AND primary_id IS NULL", (job_id,)
        ).fetchone():
            raise HTTPException(404, "Job not found")
        settings = load_settings(directory)
        try:
            await score.score_job(
                db,
                job_id,
                settings,
                directory,
                score.fingerprint(directory, settings),
            )
        except ai.AIError as error:
            raise HTTPException(502, str(error)) from error
    return await get_job(request, job_id)


class DraftRequest(StrictModel):
    kind: Literal["cover_letter", "proposal", "tailored_cv"]
    note: str | None = Field(None, max_length=2000)


def primary(db, job_id):
    job = db.execute(
        "SELECT * FROM jobs WHERE id=? AND primary_id IS NULL", (job_id,)
    ).fetchone()
    if job is None:
        raise HTTPException(404, "Job not found")
    return job


@router.post("/jobs/{job_id}/drafts")
async def write_draft(request: Request, job_id: int, body: DraftRequest):
    directory = request.app.state.data_dir
    with closing(connect(directory / "joule.db")) as db:
        job = primary(db, job_id)
        if body.kind != "tailored_cv" and (body.kind == "proposal") != (
            job["source"] == "upwork"
        ):
            raise HTTPException(400, "Draft kind does not match Job source")
        try:
            await drafts.write(
                db,
                job,
                body.kind,
                body.note,
                load_settings(directory),
                directory,
                request.app.state.upwork_auth,
            )
        except ai.AIError as error:
            raise HTTPException(502, str(error)) from error
    return await get_job(request, job_id)


@router.post("/jobs/{job_id}/queue")
async def queue_job(request: Request, job_id: int, body: StrictModel):
    directory = request.app.state.data_dir
    with closing(connect(directory / "joule.db")) as db:
        job = primary(db, job_id)
        if job["source"] != "upwork" or job["content_purged_at"]:
            raise HTTPException(400, "Only live Upwork Jobs can be queued")
        with db:
            db.execute("UPDATE jobs SET queued=1, state='new' WHERE id=?", (job_id,))
        if not db.execute(
            "SELECT 1 FROM drafts WHERE job_id=? AND kind='proposal'", (job_id,)
        ).fetchone():
            try:
                await drafts.write(
                    db,
                    job,
                    "proposal",
                    None,
                    load_settings(directory),
                    directory,
                    request.app.state.upwork_auth,
                )
            except ai.AIError as error:
                raise HTTPException(502, str(error)) from error
    return await get_job(request, job_id)


@router.post("/telegram/start")
async def start_telegram(request: Request, body: StrictModel):
    if request.app.state.telegram is None:
        raise HTTPException(409, "Telegram not configured")
    try:
        await request.app.state.telegram.start()
    except RuntimeError as error:
        raise HTTPException(502, str(error)) from error
    return {}


class AskRequest(StrictModel):
    question: str = Field(min_length=1, max_length=2000)


@router.post("/jobs/{job_id}/ask")
async def ask(request: Request, job_id: int, body: AskRequest):
    directory = request.app.state.data_dir
    with closing(connect(directory / "joule.db")) as db:
        job = primary(db, job_id)
    try:
        text = await drafts.answer(
            job, body.question, load_settings(directory), directory
        )
    except ai.AIError as error:
        raise HTTPException(502, str(error)) from error
    return {"answer": text}


@router.get("/drafts/{draft_id}/pdf")
def draft_pdf(request: Request, draft_id: int):
    directory = request.app.state.data_dir
    with closing(connect(directory / "joule.db")) as db:
        row = db.execute(
            "SELECT drafts.kind, drafts.text, jobs.company FROM drafts "
            "JOIN jobs ON jobs.id=drafts.job_id "
            "WHERE drafts.id=?",
            (draft_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(404, "Draft not found")
    content, files = json.loads(row["text"]), load_settings(directory).files
    if row["kind"] == "tailored_cv":
        pdf, prefix = cv.render(content), files.cv_prefix
    else:
        pdf, prefix = (
            cv.render_letter(content.get("text") or content["cover"], directory),
            files.cover_letter_prefix,
        )
    name = cv.filename(prefix, row["company"] or "Job")
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{name}"'},
    )


class StateRequest(StrictModel):
    state: Literal["new", "seen", "dismissed", "applied"]


@router.patch("/jobs/{job_id}")
async def update_job(request: Request, job_id: int, body: StateRequest):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db, db:
        updated = db.execute(
            "UPDATE jobs SET state=? WHERE id=? AND primary_id IS NULL",
            (body.state, job_id),
        ).rowcount
    if not updated:
        raise HTTPException(404, "Job not found")
    return {"id": job_id, "state": body.state}


@router.get("/sources")
async def get_sources(request: Request):
    settings = load_settings(request.app.state.data_dir)
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        new_jobs = dict(
            db.execute(
                "WITH inbox AS (SELECT id, source FROM jobs WHERE primary_id IS NULL "
                "AND state IN ('new', 'seen') AND filtered_reason IS NULL), "
                "memberships AS (SELECT id, source FROM inbox UNION "
                "SELECT inbox.id, d.source FROM inbox JOIN jobs d ON d.primary_id=inbox.id) "
                "SELECT source, COUNT(*) FROM memberships GROUP BY source"
            ).fetchall()
        )
        scans = db.execute(
            "WITH latest AS (SELECT json_each.value AS source, MAX(scans.id) AS id, "
            "MAX(CASE WHEN status != 'running' THEN scans.id END) AS finished_id "
            "FROM scans, json_each(scans.sources) GROUP BY json_each.value) "
            "SELECT scans.*, latest.source FROM latest JOIN scans "
            "ON scans.id IN (latest.id, latest.finished_id) ORDER BY scans.id"
        ).fetchall()
        running = db.execute(
            "SELECT id FROM scans WHERE status='running' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    sources = []
    for name in settings.sources:
        if name not in ADAPTERS:
            continue
        history = [
            {k: row[k] for k in ("id", "status", "started_at", "finished_at")}
            | {"counts": json.loads(row["per_source"] or "{}").get(name)}
            for row in scans
            if row["source"] == name
        ]
        sources.append(
            {
                "name": name,
                "new_jobs": new_jobs.get(name, 0),
                "last": history[-1] if history else None,
                "last_finished": next(
                    (s for s in reversed(history) if s["status"] != "running"), None
                ),
            }
        )
    return {
        "sources": sources,
        "running": running["id"] if running else None,
        "scheduled": request.app.state.scanner.schedule_flag.exists(),
    }
