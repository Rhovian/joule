import json
from contextlib import closing

import pytest
from fastapi.testclient import TestClient

from joule.app import create_app
from joule.db import connect


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
        with closing(connect(tmp_path / "joule.db")) as db, db:
            for id, score, posted, reason, state, primary in [
                (1, 80, "2026-01-01", None, "new", None),
                (2, 80, "2026-01-02", None, "new", None),
                (3, None, "2026-01-03", None, "new", None),
                (4, 90, "2026-01-04", "pay", "new", None),
                (5, 95, "2026-01-05", None, "dismissed", None),
                (6, 100, "2026-01-06", None, "new", 1),
            ]:
                db.execute(
                    "INSERT INTO jobs (id, source, source_id, link, title, first_seen_at, "
                    "score, posted_at, filtered_reason, state, primary_id, description, "
                    "extra, score_points, remote, location_unclear) "
                    "VALUES (?, 'hotfix', ?, 'https://example.com', 'Engineer', 'now', "
                    "?, ?, ?, ?, ?, 'text', ?, ?, 1, 0)",
                    (
                        id,
                        str(id),
                        score,
                        posted,
                        reason,
                        state,
                        primary,
                        '{"a": 1}',
                        "[]",
                    ),
                )
        yield client


@pytest.mark.parametrize(
    "query,ids",
    [
        ("", [2, 1, 3]),
        ("?unscored=false", [2, 1]),
        ("?filtered=true", [4, 2, 1, 3]),
        ("?dismissed=true", [5, 2, 1, 3]),
        ("?filtered=true&dismissed=true", [5, 4, 2, 1, 3]),
    ],
)
def test_list(client, query, ids):
    rows = client.get("/api/jobs" + query).json()
    assert [row["id"] for row in rows] == ids
    assert not {"description", "extra", "score_points"} & rows[0].keys()
    assert type(rows[0]["remote"]) is int and rows[0]["location_unclear"] == 0
    primary = next(row for row in rows if row["id"] == 1)
    assert primary["duplicates"] == [
        {"id": 6, "source": "hotfix", "link": "https://example.com"}
    ]


def test_detail(client):
    row = client.get("/api/jobs/1").json()
    assert row["description"] == "text" and row["extra"] == {"a": 1}
    assert row["score_points"] == [] and row["duplicates"][0]["id"] == 6
    assert client.get("/api/jobs/6").json()["primary_id"] == 1
    assert client.get("/api/jobs/999").status_code == 404
    with closing(connect(client.app.state.data_dir / "joule.db")) as db, db:
        db.execute("UPDATE jobs SET extra=NULL, score_points=NULL WHERE id=1")
    row = client.get("/api/jobs/1").json()
    assert row["extra"] is None and row["score_points"] is None


def test_patch(client):
    for state in ("dismissed", "seen"):
        response = client.patch("/api/jobs/1", json={"state": state})
        assert response.status_code == 200 and response.json() == {
            "id": 1,
            "state": state,
        }
        assert client.get("/api/jobs/1").json()["state"] == state
    for id in (6, 999):
        assert (
            client.patch(f"/api/jobs/{id}", json={"state": "seen"}).status_code == 404
        )
    for body in ({"state": "new"}, {}, {"state": "seen", "extra": True}):
        assert client.patch("/api/jobs/1", json=body).status_code == 422
    assert client.patch("/api/jobs/1").status_code == 422


def test_sources(client):
    directory = client.app.state.data_dir
    (directory / "settings.yaml").write_text(
        "sources: [hotfix, hn, remoteok, upwork]\n"
    )
    assert client.get("/api/sources").json() == {
        "sources": [
            {"name": name, "last": None}
            for name in ("hotfix", "hn", "remoteok", "upwork")
        ],
        "running": None,
    }
    counts = {"new": 2, "duplicate": 1, "filtered": 3, "errors": ["error"]}
    with closing(connect(directory / "joule.db")) as db, db:
        for id, sources, status in [
            (1, ["hotfix", "remoteok"], "done"),
            (2, ["hotfix", "remoteok"], "running"),
        ]:
            db.execute(
                "INSERT INTO scans VALUES (?, ?, 'manual', 'start', ?, ?, ?)",
                (
                    id,
                    json.dumps(sources),
                    "end" if id == 1 else None,
                    status,
                    json.dumps({sources[0]: counts}),
                ),
            )
    result = client.get("/api/sources").json()
    assert result["running"] == 2
    assert [s["last"]["id"] if s["last"] else None for s in result["sources"]] == [
        2,
        None,
        2,
        None,
    ]
    assert result["sources"][0]["last"]["counts"] == counts
    # The running Scan hasn't reached remoteok yet: no counts, not zeros.
    assert result["sources"][2]["last"]["counts"] is None


def test_missing_static_build(tmp_path):
    app = create_app(tmp_path)
    app.routes[-1].app.directory = str(tmp_path / "absent")
    with TestClient(app, base_url="http://localhost") as client:
        assert client.get("/api/jobs").json() == []
        assert client.get("/api/upwork/status").json() == {"connected": False}


def test_score_route_and_stale(client, monkeypatch):
    from joule import ai
    from joule.score import Score

    directory = client.app.state.data_dir
    (directory / "profile").mkdir()
    (directory / "profile" / "preferences.yaml").write_text("roles: [Engineer]\n")

    async def structured(*args):
        return Score(score=88, reason="pay not stated", points=[])

    monkeypatch.setattr(ai, "structured", structured)
    assert client.post("/api/jobs/3/score").status_code == 422
    for id in (6, 999):
        assert client.post(f"/api/jobs/{id}/score", json={}).status_code == 404
    result = client.post("/api/jobs/3/score", json={})
    assert result.status_code == 200 and result.json()["score"] == 88
    rows = client.get("/api/jobs").json()
    assert next(r for r in rows if r["id"] == 3)["score_stale"] is False
    (directory / "profile" / "cv.yaml").write_text("changed")
    assert client.get("/api/jobs").json()[0]["score_stale"] is True

    async def fail(*args):
        raise ai.AIError("Codex failed")

    monkeypatch.setattr(ai, "structured", fail)
    response = client.post("/api/jobs/3/score", json={})
    assert response.status_code == 502 and response.json() == {"detail": "Codex failed"}
