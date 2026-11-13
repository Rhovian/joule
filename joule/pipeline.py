"""Current Pipeline entries point into append-only Move history."""

from contextlib import closing
from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import AwareDatetime, Field

from joule.config import StrictModel, load_settings
from joule.db import connect
from joule.pipeline_stats import summarize

router = APIRouter(prefix="/api/pipeline")
CURRENT = (
    " FROM pipeline p JOIN pipeline_moves m ON m.id=p.move_id "
    "JOIN pipeline_moves a ON a.id=p.first_move_id JOIN jobs j ON j.id=p.job_id WHERE j.state='applied' AND j.primary_id IS NULL"
)


def evaluate(db, settings, now=None):
    """Evaluate in the caller's transaction, keeping subsequent reads under the lock."""
    now = now or datetime.now(UTC)
    follow_up = set()
    db.execute("BEGIN IMMEDIATE")
    for row in db.execute(
        "SELECT m.*,a.created_at AS applied_at"
        + CURRENT
        + " AND m.stage='applied' AND m.closed_reason IS NULL AND NOT EXISTS "
        "(SELECT 1 FROM pipeline_moves h WHERE h.job_id=p.job_id AND h.id>=p.first_move_id "
        "AND (h.stage!='applied' OR h.closed_reason='rejected' "
        "OR (h.closed_reason='no_reply' AND h.how='auto')))"
    ).fetchall():
        days = (now - datetime.fromisoformat(row["applied_at"])).total_seconds() / 86400
        if days >= settings.pipeline.no_reply_days:
            move = db.execute(
                "INSERT INTO pipeline_moves(job_id,stage,closed_reason,next_at,next_label,created_at,how,note) "
                "VALUES (?,'applied','no_reply',?,?,?,'auto',?)",
                (
                    row["job_id"],
                    row["next_at"],
                    row["next_label"],
                    now.isoformat(),
                    f"No reply after {settings.pipeline.no_reply_days} days",
                ),
            ).lastrowid
            db.execute(
                "UPDATE pipeline SET move_id=? WHERE job_id=?",
                (move, row["job_id"]),
            )
        elif days >= settings.pipeline.follow_up_days:
            follow_up.add(row["job_id"])
    return follow_up


def entry(db, job_id):
    row = db.execute(
        "SELECT m.*,p.first_move_id,a.created_at AS applied_at"
        + CURRENT
        + " AND p.job_id=?",
        (job_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Job not in Pipeline")
    return dict(row) | {
        "history": [
            dict(move)
            for move in db.execute(
                "SELECT * FROM pipeline_moves WHERE job_id=? AND id>=? ORDER BY id",
                (job_id, row["first_move_id"]),
            )
        ]
    }


def cohort(db, days):
    cutoff = (
        (datetime.now(UTC) - timedelta(days=int(days))).isoformat() if days else None
    )
    return [
        dict(row)
        for row in db.execute(
            "SELECT m.*, j.title, j.company, j.source, j.link, j.score, p.first_move_id, a.created_at AS applied_at"
            + CURRENT
            + " AND (? IS NULL OR julianday(a.created_at)>=julianday(?)) ORDER BY p.first_move_id",
            (cutoff, cutoff),
        )
    ]


@router.get("")
def list_entries(request: Request, days: Literal["30", "90"] | None = None):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db, db:
        settings = load_settings(request.app.state.data_dir)
        evaluate(db, settings)
        return cohort(db, days)


@router.get("/stats")
def statistics(request: Request, days: Literal["30", "90"] | None = None):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db, db:
        settings = load_settings(request.app.state.data_dir)
        follow_up = evaluate(db, settings)
        rows = cohort(db, days)
        return summarize(db, rows) | {
            "follow_up_ids": [
                row["job_id"] for row in rows if row["job_id"] in follow_up
            ],
            "follow_up_days": settings.pipeline.follow_up_days,
            "no_reply_days": settings.pipeline.no_reply_days,
        }


@router.get("/{job_id}")
def get_entry(request: Request, job_id: int):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db, db:
        evaluate(db, load_settings(request.app.state.data_dir))
        return entry(db, job_id)


class MoveRequest(StrictModel):
    stage: Literal["applied", "screen", "interview", "offer", "accepted"] | None = None
    closed_reason: Literal["rejected", "no_reply", "withdrawn"] | None = None
    next_at: AwareDatetime | None = None
    next_label: str | None = Field(default=None, max_length=200)
    how: Literal["manual", "auto"] = "manual"
    note: str | None = Field(default=None, max_length=10000)


@router.patch("/{job_id}")
def move_job(request: Request, job_id: int, body: MoveRequest):
    if not body.model_fields_set - {"how"}:
        raise HTTPException(422, "Specify a Stage, Closed reason, next date or note")
    with closing(connect(request.app.state.data_dir / "joule.db")) as db, db:
        # sqlite3 starts implicit transactions only on writes; lock before reading the current Move.
        # https://docs.python.org/3.13/library/sqlite3.html#transaction-control-via-the-isolation_level-attribute
        db.execute("BEGIN IMMEDIATE")
        current = entry(db, job_id)
        fields = ("stage", "closed_reason", "next_at", "next_label")
        values = {key: current[key] for key in fields}
        if body.stage is not None:
            values.update(stage=body.stage, closed_reason=None)
        values.update(
            body.model_dump(
                exclude_unset=True, exclude={"stage", "how", "note", "next_at"}
            )
        )
        if "next_at" in body.model_fields_set:
            values["next_at"] = (
                body.next_at.astimezone(UTC).isoformat() if body.next_at else None
            )
            if body.next_at is None:
                values["next_label"] = None
        if values["next_label"] and not values["next_at"]:
            raise HTTPException(422, "Set next_at for a next_label")
        if values == {key: current[key] for key in fields} and body.note is None:
            return current
        move_id = db.execute(
            "INSERT INTO pipeline_moves (job_id,stage,closed_reason,next_at,next_label,created_at,how,note) VALUES (?,?,?,?,?,?,?,?)",
            (
                job_id,
                *(values[key] for key in fields),
                datetime.now(UTC).isoformat(),
                body.how,
                body.note,
            ),
        ).lastrowid
        db.execute("UPDATE pipeline SET move_id=? WHERE job_id=?", (move_id, job_id))
        return entry(db, job_id)
