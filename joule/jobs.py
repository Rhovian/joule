import json
from contextlib import closing
from typing import Literal

from fastapi import APIRouter, HTTPException, Request

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
):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        rows = db.execute(
            "SELECT * FROM jobs WHERE primary_id IS NULL "
            "AND (? OR score IS NOT NULL) AND (? OR filtered_reason IS NULL) "
            "AND (? OR state != 'dismissed') "
            "ORDER BY score DESC NULLS LAST, posted_at DESC LIMIT 500",
            (unscored, filtered, dismissed),
        ).fetchall()
        return [
            {
                k: value
                for k, value in dict(row).items()
                if k not in ("description", "extra", "score_points")
            }
            | {"duplicates": duplicates(db, row["id"])}
            for row in rows
        ]


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: int):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Job not found")
        result = dict(row) | {"duplicates": duplicates(db, job_id)}
    for key in ("extra", "score_points"):
        result[key] = json.loads(result[key]) if result[key] is not None else None
    return result


class StateRequest(StrictModel):
    state: Literal["seen", "dismissed"]


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
    return {"sources": sources, "running": running["id"] if running else None}
