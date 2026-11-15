"""Current Pipeline entries point into append-only Move history."""

from contextlib import closing
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import AwareDatetime, Field

from joule.config import StrictModel
from joule.db import connect

router = APIRouter(prefix="/api/pipeline")
CURRENT = (
    " FROM pipeline p JOIN pipeline_moves m ON m.id=p.move_id "
    "JOIN pipeline_moves a ON a.id=p.first_move_id JOIN jobs j ON j.id=p.job_id WHERE j.state='applied' AND j.primary_id IS NULL"
)


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


@router.get("")
def list_entries(request: Request):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        return [
            dict(row)
            for row in db.execute(
                "SELECT m.*, j.title, j.company, j.source, j.link, j.score, p.first_move_id, a.created_at AS applied_at"
                + CURRENT
                + " ORDER BY p.first_move_id",
            )
        ]


@router.get("/{job_id}")
def get_entry(request: Request, job_id: int):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
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
