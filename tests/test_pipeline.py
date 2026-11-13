from contextlib import closing
from datetime import datetime

from joule.db import connect
from tests import test_jobs

client = test_jobs.client  # Reuse the existing Jobs fixture.


def test_pipeline_moves_and_reapplication(client):
    assert client.patch("/api/jobs/1", json={"state": "applied"}).status_code == 200
    first = client.get("/api/pipeline/1").json()
    assert first["stage"] == "applied" and first["closed_reason"] is None
    assert len(first["history"]) == 1 and first["history"][0]["how"] == "manual"
    history = first["history"]
    for payload, stage, reason in [
        ({"stage": "screen", "note": "Recruiter call"}, "screen", None),
        (
            {
                "stage": "interview",
                "next_at": "2027-01-07T14:00:00+02:00",
                "next_label": "Technical",
            },
            "interview",
            None,
        ),
        ({"stage": "screen"}, "screen", None),  # Move back.
        ({"stage": "offer"}, "offer", None),
        ({"stage": "accepted"}, "accepted", None),
        ({"closed_reason": "rejected"}, "accepted", "rejected"),
        ({"stage": "offer"}, "offer", None),  # Reopen.
        ({"closed_reason": "no_reply", "how": "auto"}, "offer", "no_reply"),
        ({"stage": "interview"}, "interview", None),
        ({"closed_reason": "withdrawn"}, "interview", "withdrawn"),
    ]:
        response = client.patch("/api/pipeline/1", json=payload)
        assert response.status_code == 200
        current = response.json()
        assert (current["stage"], current["closed_reason"]) == (stage, reason)
        assert current["history"][:-1] == history
        history = current["history"]
        move = history[-1]
        assert move["id"] == current["id"] and move["how"] == payload.get(
            "how", "manual"
        )
        assert move["note"] == payload.get("note")
        assert datetime.fromisoformat(move["created_at"]).tzinfo is not None
    assert (current["next_at"], current["next_label"]) == (
        "2027-01-07T12:00:00+00:00",
        "Technical",
    )
    cleared = client.patch("/api/pipeline/1", json={"next_at": None}).json()
    assert cleared["next_at"] is None and cleared["next_label"] is None
    assert (
        client.patch("/api/pipeline/1", json={"closed_reason": "withdrawn"}).json()
        == cleared
    )
    assert client.patch("/api/jobs/1", json={"state": "applied"}).status_code == 200
    assert (
        client.get("/api/pipeline/1").json() == cleared
    )  # No reset on repeated Applied.
    assert [row["job_id"] for row in client.get("/api/pipeline").json()] == [1]
    for invalid in [
        {},
        {"stage": "draft"},
        {"closed_reason": "ghost"},
        {"how": "email", "note": "bad"},
        {"next_at": "2027-01-07T14:00:00"},
    ]:
        assert client.patch("/api/pipeline/1", json=invalid).status_code == 422
    for job_id in (2, 6, 999):  # Non-applied, Duplicate, missing.
        assert (
            client.patch(
                f"/api/pipeline/{job_id}", json={"stage": "screen"}
            ).status_code
            == 404
        )
    count = len(cleared["history"])
    history_sql = "SELECT COUNT(*) FROM pipeline_moves WHERE job_id=1"
    client.patch("/api/jobs/1", json={"state": "seen"})
    assert client.get("/api/pipeline/1").status_code == 404
    assert client.get("/api/pipeline").json() == []
    with closing(connect(client.app.state.data_dir / "joule.db")) as db:
        assert db.execute(history_sql).fetchone()[0] == count
    client.patch("/api/jobs/1", json={"state": "applied"})
    again = client.get("/api/pipeline/1").json()
    assert again["stage"] == "applied" and again["closed_reason"] is None
    assert again["next_at"] is None and again["next_label"] is None
    assert len(again["history"]) == 1 and again["first_move_id"] > cleared["id"]
    with closing(connect(client.app.state.data_dir / "joule.db")) as db:
        assert db.execute(history_sql).fetchone()[0] == count + 1
