import asyncio
import json
from contextlib import closing
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi.testclient import TestClient

from joule import ai, filters, scan
from joule.app import create_app
from joule.config import Preferences, Settings
from joule.db import connect
from joule.score import Score
from joule.sources import Candidate


def test_tick_purges_only_expired_upwork_content(setup):
    _, scanner, _, rows, _ = setup
    now = datetime.now(UTC)
    fields = [
        "description",
        "pay_min",
        "pay_max",
        "pay_currency",
        "pay_period",
        "extra",
    ]
    with closing(connect(scanner.path)) as db, db:
        for id, source, age in [(1, "upwork", 3), (2, "upwork", 1), (3, "hn", 3)]:
            db.execute(
                "INSERT INTO jobs (id, source, source_id, title, link, first_seen_at, "
                "description, pay_min, pay_max, pay_currency, pay_period, extra, "
                "state, score, score_reason) "
                "VALUES (?, ?, ?, 'Engineer', 'https://example.com', ?, "
                "'content', 10, 20, 'USD', 'hour', '{}', 'seen', 70, 'fit')",
                (id, source, str(id), (now - timedelta(hours=age)).isoformat()),
            )
        db.execute(
            "INSERT INTO drafts (job_id, kind, text, created_at) "
            "VALUES (1, 'proposal', 'draft', ?)",
            (now.isoformat(),),
        )
    (scanner.data_dir / "settings.yaml").write_text("upwork: {retention_hours: 2}\n")
    before = rows()
    scanner.tick()
    old, recent, board = rows()
    assert all(old[field] is None for field in fields)
    assert datetime.fromisoformat(old["content_purged_at"]) >= now
    assert old == before[0] | dict.fromkeys(fields) | {
        "content_purged_at": old["content_purged_at"]
    }
    assert [recent, board] == before[1:]
    assert rows("drafts")[0]["text"] == "draft"
    scanner.tick()
    assert rows()[0] == old


@pytest.mark.parametrize(
    "skip", [None, "deadline", "token", "off", "disabled", "source", "busy"]
)
def test_tick_schedule_conditions_and_busy_retry(setup, monkeypatch, skip):
    _, scanner, _, _, _ = setup
    scanner.auth.path.touch()
    if skip != "off":
        scanner.schedule_flag.touch()
    monkeypatch.setattr(scan.time, "monotonic", lambda: 100.0)
    if skip == "deadline":
        scanner.next_upwork = 101.0
    if skip == "token":
        scanner.auth.path.unlink()
    if skip in ("disabled", "source"):
        (scanner.data_dir / "settings.yaml").write_text(
            "schedule: {upwork_minutes: null}"
            if skip == "disabled"
            else "sources: [hn]"
        )
    if skip == "busy":
        scanner.busy = True
        scanner.tick()
        assert scanner.next_upwork == 0.0
        scanner.busy = False
    start = Mock()
    monkeypatch.setattr(scanner, "start", start)
    scanner.tick()
    if skip not in (None, "busy"):
        start.assert_not_called()
    else:
        start.assert_called_once_with(
            ["upwork"], "scheduled", Settings(), Preferences(roles=["Engineer"])
        )
        assert scanner.next_upwork == 100.0 + 15 * 60
        scanner.tick()
        assert start.call_count == 1


@pytest.fixture
def setup(tmp_path, monkeypatch):
    (tmp_path / "profile").mkdir()
    (tmp_path / "profile" / "preferences.yaml").write_text("roles: [Engineer]\n")

    async def structured(*args):
        return Score(score=70, reason="pay not stated", points=[])

    monkeypatch.setattr(ai, "structured", structured)
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

    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
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
    result = client.get(f"/api/scans/{id}").json()
    assert result["status"] == "done" and result["finished_at"]
    assert result["sources"] == ["hotfix"]
    assert result["per_source"]["hotfix"] == {
        "new": 0,
        "duplicate": 0,
        "filtered": 0,
        "scored": 0,
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
    run(["hotfix"], Settings(max_scored_per_scan=0))
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
        "scored": 0,
        "errors": ["ValueError: detail failed"],
    }


def test_routes_busy_validation_and_reload(setup, monkeypatch):
    client, scanner, _, _, _ = setup

    async def blocked(ctx):
        await asyncio.Event().wait()

    monkeypatch.setitem(scan.ADAPTERS, "hotfix", (blocked, scan.enrich_hotfix))
    for source in ["unknown", "indeed"]:
        assert client.post("/api/scans", json={"sources": [source]}).status_code == 422
    # Body required, so a cross-site empty POST cannot start a Scan.
    assert client.post("/api/scans").status_code == 422
    response = client.post("/api/scans", json={"sources": ["hotfix"]})
    assert response.status_code == 202
    assert client.post("/api/scans", json={}).json() == {"detail": "Scan in progress"}
    assert client.post("/api/scans", json={}).status_code == 409

    async def finish():
        with pytest.raises(scan.ScanInProgress):
            scanner.start([], "manual", Settings(), Preferences(roles=[]))
        scanner.task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await scanner.task
        scanner.task = None

    client.portal.call(finish)
    assert not scanner.busy
    assert client.get("/api/scans/999").status_code == 404
    (scanner.path.parent / "settings.yaml").write_text("sources: [upwork]\n")
    assert client.post("/api/scans", json={"sources": ["hotfix"]}).status_code == 422
    (scanner.path.parent / "profile" / "preferences.yaml").write_text("broken: true\n")
    assert client.post("/api/scans", json={}).status_code == 422


def test_shutdown_interrupts_running_scan(tmp_path, monkeypatch):
    async def blocked(ctx):
        await asyncio.Event().wait()

    monkeypatch.setitem(scan.ADAPTERS, "hotfix", (blocked, None))
    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
        (tmp_path / "profile").mkdir()
        (tmp_path / "profile" / "preferences.yaml").write_text("roles: [Engineer]\n")
        response = client.post("/api/scans", json={"sources": ["hotfix"]})
        assert response.status_code == 202
        id = response.json()["id"]
        assert client.get(f"/api/scans/{id}").json()["status"] == "running"
    with closing(connect(tmp_path / "joule.db")) as db:
        row = db.execute("SELECT * FROM scans WHERE id=?", (id,)).fetchone()
        assert row["status"] == "interrupted" and row["finished_at"]
    assert not client.app.state.scanner.busy


def test_scoring_selection_cap_and_failure(setup, monkeypatch):
    _, _, _, rows, run = setup
    calls = []

    async def fetch(ctx):
        return [
            Candidate(
                source="remoteok",
                source_id=str(i),
                title=str(i),
                link="x",
                posted_at=datetime.now(UTC) - timedelta(hours=i),
            )
            for i in range(7)
        ]

    async def structured(model, prompt, schema):
        calls.append(prompt)
        if '"source_id": "1"' in prompt:
            raise ai.AIError("offline")
        return Score(score=50, reason="pay not stated", points=[])

    monkeypatch.setitem(scan.ADAPTERS, "remoteok", (fetch, None))
    monkeypatch.setattr(ai, "structured", structured)
    monkeypatch.setattr(
        filters,
        "filter_reason",
        lambda c, p: "filtered" if c.source_id == "0" else None,
    )
    run(["remoteok"], Settings(max_scored_per_scan=3))
    assert [
        '"source_id": "1"' in calls[0],
        '"source_id": "1"' in calls[1],
        '"source_id": "2"' in calls[2],
        '"source_id": "3"' in calls[3],
    ] == [True] * 4
    assert [r["source_id"] for r in rows() if r["score"] is not None] == ["2", "3"]
    counts = json.loads(rows("scans")[0]["per_source"])["remoteok"]
    assert counts["scored"] == 2 and counts["errors"] == ["Score 2: offline"]
    calls.clear()
    run(["remoteok"])
    assert not calls

    async def upwork_jobs(ctx):
        return [Candidate(source="upwork", source_id="u", title="U", link="x")]

    monkeypatch.setitem(scan.ADAPTERS, "upwork", (upwork_jobs, None))
    run(["upwork"], Settings(upwork={"scoring": False}))
    assert not calls and rows()[-1]["score"] is None


def test_scoring_duplicates_and_concurrency(setup, monkeypatch):
    _, _, _, rows, run = setup
    active = maximum = 0

    async def fetch(ctx):
        return [
            Candidate(
                source=source,
                source_id=str(i),
                title=title,
                company="Acme",
                remote=True,
                link="x",
            )
            for i, source, title in [
                (0, "remoteok", "Same"),
                (1, "hotfix", "Same"),
                (2, "remoteok", "Two"),
                (3, "remoteok", "Three"),
                (4, "remoteok", "Four"),
            ]
            if source == ctx.source
        ]

    async def remote(ctx):
        ctx.source = "remoteok"
        return await fetch(ctx)

    async def hotfix(ctx):
        ctx.source = "hotfix"
        return await fetch(ctx)

    async def structured(*args):
        nonlocal active, maximum
        active += 1
        maximum = max(maximum, active)
        await asyncio.sleep(0.01)
        active -= 1
        return Score(score=50, reason="pay not stated", points=[])

    monkeypatch.setitem(scan.ADAPTERS, "remoteok", (remote, None))
    monkeypatch.setitem(scan.ADAPTERS, "hotfix", (hotfix, None))
    monkeypatch.setattr(ai, "structured", structured)
    run(["remoteok", "hotfix"])
    assert maximum == 3
    assert len([r for r in rows() if r["score"] is not None]) == 4
    assert rows()[-1]["primary_id"] is not None and rows()[-1]["score"] is None


@pytest.mark.parametrize(
    "searches, used", [([], ["Role"]), (["Rust", "Go"], ["Rust", "Go"])]
)
def test_upwork_searches_fall_back_to_roles(monkeypatch, searches, used):
    search = AsyncMock(return_value=[])
    monkeypatch.setattr(scan.upwork, "search", search)
    preferences = Preferences(roles=["Role"], upwork_searches=searches)
    asyncio.run(scan.fetch_upwork(SimpleNamespace(auth=None, preferences=preferences)))
    assert search.call_args.args[1] == used
