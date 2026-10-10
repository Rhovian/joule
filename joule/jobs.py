import json
from contextlib import closing
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import Field

from joule import ai, cv, drafts, score
from joule.config import StrictModel, load_settings
from joule.db import connect
from joule.scan import ADAPTERS

router = APIRouter(prefix="/api")


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
    filtered: bool = False,
    dismissed: bool = False,
    applied: bool = False,
    source: str | None = None,
):
    directory = request.app.state.data_dir
    stamp = score.fingerprint(directory, load_settings(directory))
    with closing(connect(directory / "joule.db")) as db:
        rows = db.execute(
            f"SELECT *, {score.RANK} AS rank FROM jobs WHERE primary_id IS NULL "
            "AND (? OR score IS NOT NULL) AND (? OR filtered_reason IS NULL) "
            "AND (? OR state != 'dismissed') "
            "AND (? OR state != 'applied') "
            "AND (? IS NULL OR source = ? OR EXISTS "
            "(SELECT 1 FROM jobs d WHERE d.primary_id = jobs.id AND d.source = ?)) "
            "ORDER BY rank DESC NULLS LAST, posted_at DESC LIMIT 500",
            (unscored, filtered, dismissed, applied, source, source, source),
        ).fetchall()
        return [
            {
                k: value
                for k, value in dict(row).items()
                if k not in ("description", "extra", "score_points")
            }
            | {
                "duplicates": duplicates(db, row["id"]),
                "score_stale": row["score"] is not None
                and row["score_fingerprint"] != stamp,
            }
            for row in rows
        ]


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: int):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Job not found")
        result = dict(row) | {"duplicates": duplicates(db, job_id)}
        result["drafts"] = {
            draft["kind"]: dict(draft) | {"content": json.loads(draft["content"])}
            for draft in db.execute(
                "SELECT id,kind,text AS content,note,created_at FROM drafts "
                "WHERE job_id=? AND id IN "
                "(SELECT MAX(id) FROM drafts WHERE job_id=? GROUP BY kind)",
                (job_id, job_id),
            )
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
    state: Literal["seen", "dismissed", "applied"]


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
        scans = db.execute("SELECT * FROM scans ORDER BY id DESC LIMIT 50").fetchall()
        running = db.execute(
            "SELECT id FROM scans WHERE status='running' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    sources = []
    for name in settings.sources:
        if name not in ADAPTERS:
            continue
        last = None
        for row in scans:
            if name in json.loads(row["sources"]):
                last = {
                    k: row[k] for k in ("id", "status", "started_at", "finished_at")
                }
                last["counts"] = json.loads(row["per_source"] or "{}").get(name)
                break
        sources.append({"name": name, "last": last})
    return {
        "sources": sources,
        "running": running["id"] if running else None,
        "scheduled": request.app.state.scanner.schedule_flag.exists(),
    }
