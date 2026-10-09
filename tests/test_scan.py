import asyncio
import json
from contextlib import closing
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from joule import filters, scan
from joule.app import create_app
from joule.config import Preferences, Settings
from joule.db import connect
from joule.sources import Candidate


@pytest.fixture
def setup(tmp_path, monkeypatch):
    (tmp_path / "profile").mkdir()
    (tmp_path / "profile" / "preferences.yaml").write_text("roles: [Engineer]\n")
    calls = []

    def respond(request):
        calls.append(request.url.path)
        if request.url.path == "/v1/jobs":
            nodes = [
                {
                    "id": id,
                    "title": "Engineer",
                    "company_name": id,
                    "work_type": "remote",
                    "posted_at": (datetime.now(UTC) - timedelta(days=age)).isoformat(),
                }
                for id, age in [("recent", 0), ("old", 30)]
            ]
            return httpx.Response(200, json={"data": nodes})
        return httpx.Response(200, json={"description": "Full description"})

    with TestClient(create_app(tmp_path)) as client:
        scanner = client.app.state.scanner
        original = scanner.client
        mocked = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        scanner.client = mocked
        monkeypatch.setattr(filters, "filter_reason", lambda c, p: None)

        def rows(table="jobs"):
            with closing(connect(scanner.path)) as db:
                return [dict(row) for row in db.execute(f"SELECT * FROM {table}")]

        async def run(sources, settings=None):
            id = scanner.start(
                sources,
                "manual",
                settings or Settings(),
                Preferences(roles=["Engineer"]),
            )
            await scanner.task
            return client.app.state.scanner.busy, id

        yield (
            client,
            scanner,
            calls,
            rows,
            lambda sources, settings=None: client.portal.call(run, sources, settings),
        )
        client.portal.call(mocked.aclose)
        scanner.client = original


def test_first_scan_age_enrichment_then_seen_ids(setup):
    client, _scanner, calls, rows, run = setup
    assert run(["hotfix"])[0] is False
    assert len(rows()) == 1 and rows()[0]["description"] == "Full description"
    assert rows()[0]["first_seen_at"].endswith("+00:00")
    assert rows()[0]["remote"] == 1 and rows()[0]["location_unclear"] == 0
    # The age cutoff stops applying once this Source has a Job.
    run(["hotfix"])
    assert len(rows()) == 2
    calls.clear()
    _, id = run(["hotfix"])
    assert calls == ["/v1/jobs"]
    result = client.get(f"/scans/{id}").json()
    assert result["status"] == "done" and result["finished_at"]
    assert result["sources"] == ["hotfix"]
    assert result["per_source"]["hotfix"] == {
        "new": 0,
        "duplicate": 0,
        "filtered": 0,
        "errors": [],
    }


@pytest.mark.parametrize(
    "remote,city,source,linked",
    [
        (True, None, "remoteok", True),
        (False, "boise", "remoteok", True),
        (False, "Paris", "remoteok", False),
        (True, None, "upwork", False),
    ],
)
def test_duplicate_locations_and_upwork(
    setup, monkeypatch, remote, city, source, linked
):
    _, _, _, rows, run = setup

    async def fetch(ctx):
        return [
            Candidate(
                source=s,
                source_id=s,
                link="https://example.com",
                title=t,
                company=c,
                remote=r,
                city=loc,
            )
            for s, t, c, r, loc in [
                ("hotfix", "Engineer!", "Acme, Inc.", True, "Boise"),
                (source, "ENGINEER", "ACME Ltd", remote, city),
            ]
        ]

    async def enrich(ctx, candidate):
        pass

    monkeypatch.setitem(scan.ADAPTERS, "hotfix", (fetch, enrich))
    filtered = []
    monkeypatch.setattr(
        filters, "filter_reason", lambda c, p: filtered.append(c.source)
    )
    run(["hotfix"])
    primary, second = rows()
    assert second["primary_id"] == (primary["id"] if linked else None)
    assert len(filtered) == (1 if linked else 2)
    counts = json.loads(rows("scans")[0]["per_source"])["hotfix"]
    assert counts["duplicate"] == int(linked)


def test_source_failure_timeout_and_partial_progress(setup, monkeypatch):
    _, _, _, rows, run = setup

    async def fetch(ctx):
        return [
            Candidate(source="remoteok", source_id=str(i), link="x", title="x")
            for i in range(2)
        ]

    async def enrich(ctx, candidate):
        if candidate.source_id == "1":
            await asyncio.Event().wait()

    monkeypatch.setitem(scan.ADAPTERS, "remoteok", (fetch, enrich))
    run(["upwork", "remoteok", "hotfix"], Settings(source_timeout_seconds=1))
    result = json.loads(rows("scans")[0]["per_source"])
    assert result["upwork"]["errors"][0].startswith("UpworkNotConnected:")
    assert result["remoteok"]["errors"] == ["TimeoutError: "]
    assert result["remoteok"]["new"] == result["hotfix"]["new"] == 1
    assert rows("scans")[0]["status"] == "done"


def test_enrich_failure_still_inserts_and_filters(setup, monkeypatch):
    _, _, _, rows, run = setup

    async def fail(ctx, candidate):
        raise ValueError("detail failed")

    monkeypatch.setitem(scan.ADAPTERS, "hotfix", (scan.fetch_hotfix, fail))
    monkeypatch.setattr(filters, "filter_reason", lambda c, p: "deal breaker")
    run(["hotfix"])
    assert rows()[0]["filtered_reason"] == "deal breaker"
    counts = json.loads(rows("scans")[0]["per_source"])["hotfix"]
    assert counts == {
        "new": 0,
        "duplicate": 0,
        "filtered": 1,
        "errors": ["ValueError: detail failed"],
    }


def test_routes_busy_validation_and_reload(setup, monkeypatch):
    client, scanner, _, _, _ = setup

    async def blocked(ctx):
        await asyncio.Event().wait()

    monkeypatch.setitem(scan.ADAPTERS, "hotfix", (blocked, scan.enrich_hotfix))
    for source in ["unknown", "hn", "indeed"]:
        assert client.post("/scans", json={"sources": [source]}).status_code == 422
    response = client.post("/scans", json={"sources": ["hotfix"]})
    assert response.status_code == 202
    assert client.post("/scans").json() == {"detail": "Scan in progress"}
    assert client.post("/scans").status_code == 409

    async def finish():
        with pytest.raises(scan.ScanInProgress):
            scanner.start([], "manual", Settings(), Preferences(roles=[]))
        scanner.task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await scanner.task
        scanner.task = None

    client.portal.call(finish)
    assert not scanner.busy
    assert client.get("/scans/999").status_code == 404
    (scanner.path.parent / "settings.yaml").write_text("sources: [upwork]\n")
    assert client.post("/scans", json={"sources": ["hotfix"]}).status_code == 422
    (scanner.path.parent / "profile" / "preferences.yaml").write_text("broken: true\n")
    assert client.post("/scans").status_code == 422


def test_shutdown_interrupts_running_scan(tmp_path, monkeypatch):
    async def blocked(ctx):
        await asyncio.Event().wait()

    monkeypatch.setitem(scan.ADAPTERS, "hotfix", (blocked, None))
    with TestClient(create_app(tmp_path)) as client:
        (tmp_path / "profile" / "preferences.yaml").write_text("roles: [Engineer]\n")
        response = client.post("/scans", json={"sources": ["hotfix"]})
        assert response.status_code == 202
        id = response.json()["id"]
        assert client.get(f"/scans/{id}").json()["status"] == "running"
    with closing(connect(tmp_path / "joule.db")) as db:
        row = db.execute("SELECT * FROM scans WHERE id=?", (id,)).fetchone()
        assert row["status"] == "interrupted" and row["finished_at"]
    assert not client.app.state.scanner.busy
