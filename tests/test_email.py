"""Gmail replaces the old connection and confirmed-suggestion contracts."""

import asyncio
import json
from contextlib import closing
from datetime import UTC, datetime, timedelta

from joule.db import connect
from joule.gmail_agent import MailResult, MailRun
from joule.gmail_server import SCOPE, TOOLS
from tests import test_jobs

client = test_jobs.client


def test_gmail_status_and_retired_connection_routes(client, monkeypatch):
    service = client.app.state.gmail
    monkeypatch.setattr(service, "account", lambda: "owner@example.com")
    root = service.directory / "gmail" / "credentials"
    root.mkdir(parents=True)
    token = root / "owner@example.com.json"
    for scopes, expected in [
        ([SCOPE, "openid"], "not_connected"),
        ([SCOPE], "configured"),
    ]:
        token.write_text(json.dumps({"refresh_token": "secret", "scopes": scopes}))
        status = client.get("/api/email").json()
        assert status["state"] == expected
        assert "secret" not in json.dumps(status)
    routes = client.app.openapi()["paths"]
    assert set(routes["/api/email"]) == {"get"}
    assert "/api/email/suggestions/{suggestion_id}/{action}" not in routes


def test_email_automatic_moves_flags_and_stale_applications(client, monkeypatch):
    service = client.app.state.gmail
    monkeypatch.setattr(service, "account", lambda: "owner@example.com")
    monkeypatch.setattr(service, "configured", lambda: True)
    for job_id in (1, 2):
        client.patch(f"/api/jobs/{job_id}", json={"state": "applied"})
    with closing(connect(service.path)) as db, db:
        db.execute("UPDATE jobs SET company='Known' WHERE id=3")
        db.execute(
            "UPDATE jobs SET extra=? WHERE id=4",
            (
                json.dumps(
                    {"application_url": "https://jobs.ashbyhq.com/known/44/application"}
                ),
            ),
        )
    calls = []
    snapshots = []
    stamp = datetime.now(UTC)
    apply = service.apply

    def tracked(account, jobs, result):
        snapshots.append(jobs)
        return apply(account, jobs, result)

    monkeypatch.setattr(service, "apply", tracked)

    def deliver(jobs, *rows):
        service.apply(
            service.account(), jobs, MailRun(complete=True, results=list(rows))
        )

    def mail(message_id, job_ids, **kwargs):
        return MailResult(
            message_id=message_id,
            job_ids=job_ids,
            sender="Acme <jobs@acme.com>",
            subject="Application reply",
            quote="One line\n> quoted tail",
            date=stamp + timedelta(minutes=1),
            action="move",
            stage="screen",
        ).model_copy(update=kwargs)

    async def agent(model, prompt, schema, **kwargs):
        calls.append(kwargs)
        return MailRun(
            complete=False,
            results=[
                mail("screen", [1]),
                mail("ambiguous", [1, 2], action="uncertain"),
                mail(
                    "external",
                    [],
                    action="add",
                    title="Developer",
                    company="External",
                    url="https://jobs.lever.co/external/42/apply",
                ),
                mail(
                    "external-repeat",
                    [],
                    action="add",
                    title="Another title",
                    company="external",
                    url="https://jobs.lever.co/external/42?utm_source=mail",
                ),
                mail(
                    "known", [], action="add", title="Engineer B ", company="Known Inc."
                ),
                mail("known-flag", [3], action="uncertain"),
                mail(
                    "known-url",
                    [],
                    action="add",
                    title="Different title",
                    company="Different label",
                    url="https://jobs.ashbyhq.com/known/44",
                ),
            ],
        )

    monkeypatch.setattr("joule.gmail_agent.ai.structured", agent)
    asyncio.run(service.check())
    assert calls[0]["mcp"]["enabled_tools"] == TOOLS
    assert calls[0]["mcp"]["required"] is True
    current = client.get("/api/pipeline/1").json()
    assert current["stage"] == "screen" and current["history"][-1]["how"] == "auto"
    assert client.get("/api/pipeline/2").json()["stage"] == "applied"
    flags = client.get("/api/email").json()["flags"]
    assert {1, 2, 3} <= {flag["job_id"] for flag in flags}
    with closing(connect(service.path)) as db:
        assert db.execute("SELECT through_at FROM gmail_checks").fetchone()[0] is None
        discovered = db.execute(
            "SELECT id FROM jobs WHERE company='External'"
        ).fetchone()[0]
    assert {flag["job_id"] for flag in flags} == {1, 2, 3, discovered}
    assert all(
        client.get(f"/api/jobs/{job_id}").json()["state"] == "applied"
        for job_id in (3, 4)
    )
    assert all(
        client.get(f"/api/pipeline/{job_id}").json()["history"][0]["how"] == "auto"
        for job_id in (3, 4)
    )
    assert (
        client.get(f"/api/pipeline/{discovered}").json()["history"][0]["how"] == "auto"
    )
    assert all(
        len(client.get(f"/api/pipeline/{job_id}").json()["history"]) == 1
        for job_id in (3, 4, discovered)
    )
    assert (
        client.get(f"/api/pipeline/{discovered}").json()["applied_at"]
        == (stamp + timedelta(minutes=1)).isoformat()
    )
    # Replaying the old output, including discovery, must not append anything.
    replay = asyncio.run(agent(None, json.dumps({"jobs": snapshots[0]}), None))
    service.apply(service.account(), snapshots[0], replay)
    assert client.get("/api/pipeline/1").json() == current
    assert len(client.get("/api/pipeline").json()) == 5
    for flag in flags:
        assert client.post(f"/api/email/flags/{flag['id']}/dismiss").status_code == 200
    assert not client.get("/api/email").json()["flags"]
    # Re-apply changes the Move ID. The future mail date keeps the independent
    # date guard out of this assertion; no first_move_id guard remains.
    client.patch("/api/jobs/2", json={"state": "seen"})
    client.patch("/api/jobs/2", json={"state": "applied"})
    deliver(snapshots[0], mail("stale-application", [2]))
    assert client.get("/api/pipeline/2").json()["stage"] == "applied"
    # Retry with a fresh snapshot exercises date, rejection and backward protection.
    with closing(connect(service.path)) as db, db:
        db.execute(
            "UPDATE gmail_checks SET checked_at=?",
            ((stamp - timedelta(hours=1)).isoformat(),),
        )

    async def finish(model, prompt, schema, **kwargs):
        return MailRun(
            complete=True,
            results=[
                mail(
                    "date",
                    [1],
                    action="date",
                    next_at=stamp + timedelta(days=2),
                    next_label="Technical",
                ),
                mail("reject", [2], action="reject"),
            ],
        )

    monkeypatch.setattr("joule.gmail_agent.ai.structured", finish)
    asyncio.run(service.check())
    assert client.get("/api/pipeline/1").json()["next_label"] == "Technical"
    assert client.get("/api/pipeline/2").json()["closed_reason"] == "rejected"
    fresh = snapshots[-1]
    one = client.get("/api/pipeline/1").json()
    snapshot = [
        dict(job, move_id=one["id"]) if job["id"] == 1 else job for job in fresh
    ]
    deliver(
        snapshot,
        mail("backward", [1]),
        mail("old-mail", [1], stage="offer", date=stamp - timedelta(days=1)),
        mail("unknown", [999]),
    )
    assert client.get("/api/pipeline/1").json() == one
    for reason, action in [
        ("rejected", "reject"),
        ("no_reply", "move"),
        ("withdrawn", "date"),
    ]:
        client.patch("/api/pipeline/2", json={"closed_reason": reason})
        closed = client.get("/api/pipeline/2").json()
        deliver(
            [dict(id=2, move_id=closed["id"])],
            mail(
                f"closed-{action}",
                [2],
                action=action,
                next_at=stamp + timedelta(days=3),
            ),
        )
        assert client.get("/api/pipeline/2").json() == closed
    for action in ("move", "reject", "date"):
        client.patch(
            "/api/pipeline/2",
            json={
                "closed_reason": "no_reply",
                "how": "auto",
                "note": f"Automatic closure for {action}",
            },
        )
        closed = client.get("/api/pipeline/2").json()
        deliver(
            [dict(id=2, move_id=closed["id"])],
            mail(
                f"late-{action}",
                [2],
                action=action,
                stage="interview",
                next_at=stamp + timedelta(days=3),
            ),
        )
        reopened = client.get("/api/pipeline/2").json()
        assert reopened["closed_reason"] == ("rejected" if action == "reject" else None)
        assert (
            reopened["history"][-1]["how"] == "auto"
            and reopened["first_move_id"] == closed["first_move_id"]
        )
        if action == "move":
            assert reopened["stage"] == "interview"
        # A message predating this automatic closure must not reopen it.
        if action == "date":
            client.patch(
                "/api/pipeline/2", json={"closed_reason": "no_reply", "how": "auto"}
            )
            closed = client.get("/api/pipeline/2").json()
            deliver(
                [dict(id=2, move_id=closed["id"])],
                mail(
                    "before-closure",
                    [2],
                    stage="offer",
                    date=datetime.fromisoformat(closed["created_at"])
                    - timedelta(microseconds=1),
                ),
            )
            assert client.get("/api/pipeline/2").json() == closed
    for job_id in (1, 2):
        # Open and auto-No reply entries both stop at Offer on acceptance mail.
        before = client.get(f"/api/pipeline/{job_id}").json()
        deliver(
            [dict(id=job_id, move_id=before["id"])],
            mail(f"accepted-{job_id}", [job_id], stage="accepted"),
        )
        after = client.get(f"/api/pipeline/{job_id}").json()
        assert after["stage"] == "offer" and after["closed_reason"] is None
        assert all(item["stage"] != "accepted" for item in after["history"])
        assert any(
            flag["message_id"] == f"accepted-{job_id}"
            for flag in service.status()["flags"]
        )
    for message_id in ("accepted-at-offer", "accepted-manual"):
        if message_id == "accepted-manual":
            client.patch("/api/pipeline/1", json={"stage": "accepted"})
        before = client.get("/api/pipeline/1").json()
        deliver(
            [dict(id=1, move_id=before["id"])], mail(message_id, [1], stage="accepted")
        )
        assert client.get("/api/pipeline/1").json() == before
        assert any(
            flag["message_id"] == message_id for flag in service.status()["flags"]
        )
    with closing(connect(service.path)) as db, db:
        db.execute(
            "UPDATE jobs SET title='Shared',company='Shared',state='new' WHERE id=7"
        )
        db.execute("UPDATE jobs SET title='Shared',company='Shared' WHERE id=5")
    deliver(
        [
            dict(id=5, state="dismissed", move_id=None),
            dict(id=7, state="new", move_id=None),
        ],
        mail("ambiguous-discovery", [], action="add", title="Shared", company="Shared"),
    )
    assert {
        flag["job_id"]
        for flag in service.status()["flags"]
        if flag["message_id"] == "ambiguous-discovery"
    } == {5, 7}
    with closing(connect(service.path)) as db, db:
        db.execute("UPDATE jobs SET title='Stale',company='Stale' WHERE id=5")
    deliver(
        [dict(id=5, state="new", move_id=None)],
        mail("stale-discovery", [], action="add", title="Stale", company="Stale"),
    )
    assert client.get("/api/jobs/5").json()["state"] == "dismissed"
    assert len(client.get("/api/pipeline").json()) == 5
    with closing(connect(service.path)) as db:
        assert db.execute("SELECT through_at FROM gmail_checks").fetchone()[0]
        assert {
            row["message_id"]: row["state"]
            for row in db.execute(
                "SELECT message_id,state FROM gmail_events WHERE message_id IN ('backward','closed-reject','closed-move','closed-date')"
            )
        } == {
            "backward": "uncertain",
            "closed-reject": "uncertain",
            "closed-move": "uncertain",
            "closed-date": "uncertain",
        }
        stored = " ".join(
            str(tuple(row)) for row in db.execute("SELECT * FROM gmail_events")
        )
        assert (
            "old-mail" not in stored
            and "unknown" not in stored
            and "quoted tail" not in stored
        )
    before = len(calls)
    asyncio.run(service.check())
    assert len(calls) == before


def test_gmail_pages_freeze_window_and_bound_context(client, monkeypatch):
    service = client.app.state.gmail
    monkeypatch.setattr(service, "account", lambda: "owner@example.com")
    monkeypatch.setattr(service, "configured", lambda: True)
    prompts = []
    pages = iter(
        [
            MailRun(complete=True, next_page_token="page-2", results=[]),
            RuntimeError("private failure"),
            MailRun(complete=True, next_page_token=None, results=[]),
        ]
    )

    async def agent(model, prompt, schema, **kwargs):
        data = json.loads(prompt[prompt.index("{") :])
        prompts.append(data)
        assert "jobs" not in data and kwargs["timeout"] > 300
        page = next(pages)
        if isinstance(page, Exception):
            raise page
        return page

    monkeypatch.setattr("joule.gmail_agent.ai.structured", agent)
    states = []
    for _ in range(3):
        with closing(connect(service.path)) as db, db:
            db.execute("UPDATE gmail_checks SET checked_at='2000-01-01T00:00:00+00:00'")
        asyncio.run(service.check())
        states.append(service.status()["state"])
    assert states == ["checking", "unavailable", "configured"]
    assert prompts[0]["through"] == prompts[1]["through"] == prompts[2]["through"]
    assert prompts[0]["page_token"] is None
    assert prompts[1]["page_token"] == prompts[2]["page_token"] == "page-2"
    with closing(connect(service.path)) as db, db:
        checkpoint = db.execute("SELECT * FROM gmail_checks").fetchone()
        assert (
            checkpoint["through_at"] == prompts[0]["through"]
            and checkpoint["page_token"] is None
        )
        db.execute("UPDATE gmail_checks SET checked_at='2000-01-01T00:00:00+00:00'")
    monkeypatch.setattr(
        "joule.gmail_agent.ai.structured",
        lambda *args, **kwargs: agent(*args, **kwargs),
    )
    # The next window's actual overlap is computed by Joule, not delegated to the model.
    asyncio.run(service.check())
    assert datetime.fromisoformat(prompts[-1]["since"]) == datetime.fromisoformat(
        prompts[0]["through"]
    ) - timedelta(days=1)
    row = dict(
        message_id="large",
        sender="s" * 400,
        subject="s" * 600,
        quote="q" * 200 + "\n>quoted",
        date=datetime.now(UTC).isoformat(),
        action="uncertain",
        job_ids=[],
        next_label="l" * 300,
        title="t" * 600,
        company="c" * 600,
    )
    parsed = MailRun.model_validate(
        {"complete": True, "next_page_token": None, "results": [row] * 101}
    )
    assert len(parsed.results) == 101 and len(parsed.results[0].quote) == 140
    assert (
        len(parsed.results[0].subject) == 500 and len(parsed.results[0].sender) == 320
    )

    assert len(parsed.results[0].next_label) == 200
    assert len(parsed.results[0].title) == len(parsed.results[0].company) == 500
    schema = MailRun.model_json_schema()
    assert "maxItems" not in schema["properties"]["results"]
    assert "maxLength" not in schema["$defs"]["MailResult"]["properties"]["quote"]
