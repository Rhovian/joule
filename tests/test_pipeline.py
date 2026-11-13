from contextlib import closing
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from joule.app import create_app
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
    summary = client.get("/api/pipeline").json()
    assert [(r["job_id"], r["score"]) for r in summary] == [(1, 85)]
    assert summary[0]["applied_at"] == current["applied_at"] == first["created_at"]
    for invalid in [
        {},
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


def test_pipeline_flow_and_reply_rates(client):
    def stats(query=""):
        response = client.get("/api/pipeline/stats" + query)
        assert response.status_code == 200
        return response.json()

    assert stats()["total"] == 0
    with closing(connect(client.app.state.data_dir / "joule.db")) as db, db:
        db.execute("UPDATE jobs SET score=69 WHERE id=1")
        db.execute("UPDATE jobs SET score=70 WHERE id=7")
    for job_id, moves in [
        (1, [{"stage": "interview"}, {"stage": "applied"}]),
        (
            2,
            [
                {"closed_reason": "rejected"},
                {"stage": "applied"},
                {"closed_reason": "withdrawn"},
            ],
        ),
        (3, [{"closed_reason": "no_reply"}]),
        (4, [{"stage": "accepted"}]),
        (5, [{"closed_reason": "rejected"}]),
        (7, [{"closed_reason": "withdrawn"}]),
    ]:
        client.patch(f"/api/jobs/{job_id}", json={"state": "applied"})
        for move in moves:
            assert client.patch(f"/api/pipeline/{job_id}", json=move).status_code == 200
    with closing(connect(client.app.state.data_dir / "joule.db")) as db, db:
        for job_id, days in [(2, 45), (5, 95)]:
            db.execute(
                "UPDATE pipeline_moves SET created_at=? WHERE id=(SELECT first_move_id FROM pipeline WHERE job_id=?)",
                ((datetime.now(UTC) - timedelta(days=days)).isoformat(), job_id),
            )
    result = stats()
    assert (result["total"], result["replies"], result["reached"]) == (
        6,
        4,
        [6, 2, 2, 1],
    )
    assert {
        (t["at"], t["stage"], t["closed_reason"]): t["count"]
        for t in result["terminals"]
    } == {
        (2, "applied", None): 1,
        (0, None, "withdrawn"): 2,
        (0, None, "no_reply"): 1,
        (3, "accepted", None): 1,
        (0, None, "rejected"): 1,
    }
    assert [(r["name"], r["applied"], r["replies"]) for r in result["bands"]] == [
        ("90+", 2, 2),
        ("80–89", 1, 1),
        ("70–79", 1, 0),
        ("<70", 1, 1),
        ("Unscored", 1, 0),
    ]
    assert result["sources"] == [
        {"name": "hotfix", "applied": 5, "replies": 3},
        {"name": "remoteok", "applied": 1, "replies": 1},
    ]
    for query, ids, replies in [
        ("?days=30", [1, 3, 4, 7], 2),
        ("?days=90", [1, 2, 3, 4, 7], 3),
    ]:
        filtered = stats(query)
        assert filtered["job_ids"] == ids
        assert [r["job_id"] for r in client.get("/api/pipeline" + query).json()] == ids
        assert (
            filtered["total"]
            == sum(r["applied"] for r in filtered["sources"])
            == sum(r["applied"] for r in filtered["bands"])
            == len(ids)
        )
        assert filtered["replies"] == replies
    client.patch("/api/jobs/1", json={"state": "new"})
    client.patch("/api/jobs/1", json={"state": "applied"})
    assert stats()["reached"] == [6, 1, 1, 1]  # Old application's history stays hidden.


def test_follow_up_thresholds_and_automatic_closure(client, monkeypatch):
    from joule import pipeline

    now = datetime.now(UTC)

    class Clock(datetime):
        @classmethod
        def now(cls, tz):
            return now

    monkeypatch.setattr(pipeline, "datetime", Clock)
    for job_id, move in [
        (1, None),
        (2, None),
        (3, None),
        (4, {"stage": "screen"}),
        (5, {"closed_reason": "rejected"}),
        (7, {"closed_reason": "withdrawn"}),
    ]:
        client.patch(f"/api/jobs/{job_id}", json={"state": "applied"})
        if move:
            client.patch(f"/api/pipeline/{job_id}", json=move)
        if job_id in (4, 5):
            client.patch(f"/api/pipeline/{job_id}", json={"stage": "applied"})
    directory = client.app.state.data_dir
    with closing(connect(directory / "joule.db")) as db, db:
        for job_id, days in [
            (1, 14),
            (2, 21),
            (3, 14 - 1 / 86400),
            (4, 30),
            (5, 30),
            (7, 30),
        ]:
            db.execute(
                "UPDATE pipeline_moves SET created_at=? WHERE id=(SELECT first_move_id FROM pipeline WHERE job_id=?)",
                ((now - timedelta(days=days)).isoformat(), job_id),
            )
    with (
        TestClient(create_app(directory)),
        closing(connect(directory / "joule.db")) as db,
    ):
        assert (
            db.execute(
                "SELECT m.closed_reason FROM pipeline p JOIN pipeline_moves m ON m.id=p.move_id WHERE p.job_id=2"
            ).fetchone()[0]
            == "no_reply"
        )
    rows = client.get("/api/pipeline").json()
    assert [(r["job_id"], r["closed_reason"]) for r in rows] == [
        (1, None),
        (2, "no_reply"),
        (3, None),
        (4, None),
        (5, None),
        (7, "withdrawn"),
    ]
    stats = client.get("/api/pipeline/stats").json()
    assert stats["follow_up_ids"] == [1] and stats["replies"] == 2
    closed = client.get("/api/pipeline/2").json()
    assert len(closed["history"]) == 2
    assert (closed["stage"], closed["how"]) == ("applied", "auto")
    assert client.get("/api/pipeline/2").json() == closed  # Idempotent reads.
    client.patch("/api/pipeline/2", json={"stage": "applied"})
    assert client.get("/api/pipeline/2").json()["closed_reason"] is None
    client.patch("/api/pipeline/7", json={"stage": "applied"})
    assert client.get("/api/pipeline/7").json()["closed_reason"] is None
    (directory / "settings.yaml").write_text(
        "pipeline: {follow_up_days: 13, no_reply_days: 15}\n"
    )
    stats = client.get("/api/pipeline/stats").json()
    assert stats["follow_up_ids"] == [1, 3] and (
        stats["follow_up_days"],
        stats["no_reply_days"],
    ) == (13, 15)
    with closing(connect(directory / "joule.db")) as db, db:
        db.execute(
            "UPDATE pipeline_moves SET created_at=? WHERE id=(SELECT first_move_id FROM pipeline WHERE job_id=1)",
            ((now - timedelta(days=16)).isoformat(),),
        )
    client.patch(
        "/api/pipeline/1", json={"next_at": (now + timedelta(days=1)).isoformat()}
    )
    assert (
        client.get("/api/pipeline/stats").json()["follow_up_ids"] == [3]
        and client.get("/api/pipeline/1").json()["closed_reason"] is None
    )
    client.patch("/api/pipeline/1", json={"next_at": None})
    client.app.state.scanner.tick()  # Same server timer callback, no Pipeline read.
    with closing(connect(directory / "joule.db")) as db:
        assert (
            db.execute(
                "SELECT m.closed_reason FROM pipeline p JOIN pipeline_moves m ON m.id=p.move_id WHERE p.job_id=1"
            ).fetchone()[0]
            == "no_reply"
        )
    client.patch("/api/jobs/1", json={"state": "new"})
    client.patch("/api/jobs/1", json={"state": "applied"})
    # A fresh application can auto-close again; old auto history is hidden.
    now += timedelta(days=16)
    assert client.get("/api/pipeline/1").json()["closed_reason"] == "no_reply"
    (directory / "settings.yaml").write_text("pipeline: {follow_up_days: 0}\n")
    assert client.get("/api/pipeline").status_code == 200
    stats = client.get("/api/pipeline/stats").json()
    assert stats["follow_up_error"] is True
    assert stats["follow_up_days"] is stats["no_reply_days"] is None
