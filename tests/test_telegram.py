import asyncio
import json
from contextlib import closing
from unittest.mock import AsyncMock

import httpx
import pytest

from joule import drafts
from joule.config import Settings
from joule.db import connect, init_db
from joule.telegram import Telegram, queue
from joule.upwork_auth import UpworkAuth, UpworkNotConnected
from tests.test_scan import setup  # noqa: F401 — registers the shared pytest fixture


@pytest.fixture
def bot(tmp_path):
    init_db(tmp_path / "joule.db")
    sent = []

    def respond(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"result": []})

    client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    with closing(connect(tmp_path / "joule.db")) as db:
        db.isolation_level = None
        yield (
            Telegram(tmp_path, client, "token", "42", UpworkAuth(tmp_path, client)),
            db,
            sent,
        )
    asyncio.run(client.aclose())


def seed(db, id=1, source="hn", **fields):
    db.execute(
        "INSERT INTO jobs (id,source,source_id,title,link,first_seen_at,score,posted_at) "
        "VALUES (?,?,?,'Engineer','url','now',80,?)",
        (id, source, str(id), str(id)),
    )
    for key, value in fields.items():
        db.execute(f"UPDATE jobs SET {key}=? WHERE id=?", (value, id))
    seed_draft(db, id, "proposal" if source == "upwork" else "cover_letter")


def callback(data, chat=42):
    return {
        "callback_query": {
            "id": "cb",
            "data": data,
            "from": {"id": 42},
            "message": {"chat": {"id": chat}},
        }
    }


def test_queue_rule_and_order(bot):
    _, db, _ = bot
    seed(db)
    seed(db, 2)
    seed(db, 3, "upwork", score=None)
    keys = ["primary_id", "filtered_reason", "state", "content_purged_at"]
    for id, (key, value) in enumerate(
        zip(keys + ["score"] * 2, [1, "no", "seen", "now", 74, None]), 4
    ):
        seed(db, id, **{key: value})
    seed(db, 10)
    db.execute("UPDATE drafts SET kind='proposal' WHERE job_id=10")
    seed(db, 11)
    db.execute("DELETE FROM drafts WHERE job_id=11")
    seed(db, 12, score=90, posted_at="0")
    assert [r["id"] for r in queue(db, 75)] == [2, 1, 12, 3]


@pytest.mark.parametrize(
    "case", ["apply new applied", "skip new seen", "skip applied applied"]
)
def test_actions(bot, case):
    action, before, state = case.split()
    telegram, db, sent = bot
    seed(db, state=before)
    asyncio.run(telegram.handle(callback(f"{action}:1")))
    assert db.execute("SELECT state FROM jobs").fetchone()[0] == state
    assert sent[-1]["text"] == "Queue empty"
    if action == "apply":
        assert sent[-2]["text"] == "Marked applied — submit here: url"


def test_start_rework_chat_and_split(bot, monkeypatch):
    telegram, db, sent = bot
    seed(db, source="upwork", extra='{"screening_questions":["Why?"]}')
    content = {"cover": "x" * 8000, "answers": ["[LOOM LINK]"]}
    db.execute("UPDATE drafts SET text=?", (json.dumps(content),))
    monkeypatch.setattr(drafts, "write", AsyncMock())
    asyncio.run(telegram.handle(callback("start", 99)))
    assert not sent
    asyncio.run(telegram.handle(callback("start")))
    parts = [p for p in sent if "text" in p]
    assert all(len(p["text"]) <= 4000 for p in parts)
    assert all("reply_markup" not in p for p in parts[:-1])
    assert parts[0]["text"].startswith("⚠ needs Loom video\n")
    assert "Q: Why?\nA: [LOOM LINK]" in parts[-1]["text"]
    asyncio.run(telegram.handle(callback("rework:1")))
    assert sent[-1]["text"] == "Send direction for Engineer"
    asyncio.run(
        telegram.handle(
            {"message": {"chat": {"id": 42}, "from": {"id": 42}, "text": "shorter"}}
        )
    )
    assert drafts.write.call_args.args[2:4] == ("proposal", "shorter")


def test_run_drops_backlog_then_handles(bot):
    telegram, _, _ = bot

    async def run():
        handled = asyncio.Event()
        telegram.api = AsyncMock(side_effect=[[{"update_id": 4}], [{"update_id": 5}]])

        async def handle(update):
            handled.set()
            await asyncio.Event().wait()

        telegram.handle = AsyncMock(side_effect=handle)
        task = asyncio.create_task(telegram.run())
        await asyncio.wait_for(handled.wait(), 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert telegram.api.call_args_list[0].kwargs == {"offset": -1, "timeout": 0}
        assert telegram.api.call_args_list[1].kwargs == {"offset": 5, "timeout": 50}
        telegram.handle.assert_awaited_once_with({"update_id": 5})

    asyncio.run(run())


@pytest.mark.parametrize("mode", ["off", "below", "on", "fail"])
def test_scan_drafts_and_alert(request, bot, monkeypatch, mode):
    configured, fail = mode != "off", mode == "fail"
    threshold = 75 if mode == "below" else 60
    _, scanner, _, rows, run = request.getfixturevalue("setup")
    telegram, _, sent = bot
    telegram.data_dir = scanner.data_dir
    scanner.telegram = telegram if configured else None
    if fail:
        monkeypatch.setattr(
            telegram, "api", AsyncMock(side_effect=httpx.HTTPError("offline"))
        )
    write = AsyncMock(side_effect=lambda db, job, *args: seed_draft(db, job["id"]))
    monkeypatch.setattr(drafts, "write", write)
    run(["hotfix"], Settings(alert_threshold=threshold))
    assert write.await_count == int(configured and threshold <= 70)
    assert rows("scans")[0]["status"] == "done"
    assert [p["text"] for p in sent] == (
        ["1 new Jobs queued (1 in queue)"] if write.await_count and not fail else []
    )


def seed_draft(db, job_id, kind="cover_letter"):
    with db:
        db.execute(
            "INSERT INTO drafts (job_id,kind,text,created_at) VALUES (?,?,'{}','now')",
            (job_id, kind),
        )


@pytest.mark.parametrize("body", ['{"description":"Bad Request"}', "Bad Request"])
def test_send_error_does_not_expose_token(tmp_path, body):
    async def run():
        transport = httpx.MockTransport(lambda request: httpx.Response(400, text=body))
        async with httpx.AsyncClient(transport=transport) as client:
            telegram = Telegram(tmp_path, client, "secret-bot-token", "42")
            with pytest.raises(RuntimeError) as error:
                await telegram.send("Hello")
            assert str(error.value) == "Telegram sendMessage failed: 400 Bad Request"
            assert "secret-bot-token" not in str(error.value)
            assert error.value.__context__ is None

    asyncio.run(run())


@pytest.mark.parametrize(
    "mode", ["send", "boost", "reject", "disconnected", "cancel", "balance"]
)
def test_upwork_apply(bot, mode):
    telegram, db, sent = bot
    boost = 10 if mode == "boost" else 0
    period = "fixed" if boost else "hour"
    seed(db, source="upwork", pay_period=period, pay_min=50)
    questions = ["Why?", "More?"] if boost else []
    db.execute(
        "UPDATE jobs SET extra=?", (json.dumps({"screening_questions": questions}),)
    )
    seed_draft(db, 1, "proposal")
    content = json.dumps({"cover": "Latest", "answers": ["Because"]})
    db.execute("UPDATE drafts SET text=? WHERE id=2", (content,))
    calls = []

    async def respond(request):
        body = json.loads(request.content)
        query = body["query"]
        if "connectsSummary" in query:
            data = {"connectsSummary": {"connectsBalance": 123}}
            return httpx.Response(
                400 if mode == "balance" else 200, json={"data": data}
            )
        if "createJobProposal" not in query:
            data = {"user": {"id": "u", "nid": "n"}, "organization": {"id": "o"}}
            return httpx.Response(200, json={"data": data})
        calls.append(body["variables"]["input"])
        await asyncio.sleep(0)  # Keep the first submit in flight for the second Send.
        result = {
            "newProposalId": "p",
            "status": "OK",
            "error": "Nope" if mode == "reject" else None,
        }
        return httpx.Response(200, json={"data": {"createJobProposal": result}})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            telegram.auth = UpworkAuth(telegram.data_dir, client)
            telegram.auth.access_token = AsyncMock(return_value="token")
            await telegram.handle(callback("apply:1"))
            prompt = f"Bid for Engineer ({'fixed' if boost else 'hourly'} $50). Reply: <amount> [boost Connects]."
            assert sent[-1]["text"] == prompt + (
                "" if mode == "balance" else " Connects available: 123"
            )
            for text in ("no", "0", "-1", "95 -1", "95 1.5", "95 10 extra", "nan"):
                message = {"chat": {"id": 42}, "from": {"id": 42}, "text": text}
                await telegram.handle({"message": message})
                assert sent[-1]["text"] == "Reply like: 95 or 95 10"
                assert telegram.awaiting == ("bid", 1)
            message["text"] = "95 10" if boost else "95"
            await telegram.handle({"message": message})
            buttons = sent[-1]["reply_markup"]["inline_keyboard"][0]
            assert [b["text"] for b in buttons] == ["Send", "Cancel"]
            assert [b["callback_data"] for b in buttons] == [
                f"send:1:95:{boost}",
                "cancel:1",
            ]
            assert len(buttons[0]["callback_data"].encode()) <= 64
            confirm = f"Send proposal for Engineer: $95 ({'fixed' if boost else 'hourly'}), boost {boost} Connects?"
            assert sent[-1]["text"] == confirm and telegram.awaiting is None
            if mode == "disconnected":
                telegram.auth.access_token.side_effect = UpworkNotConnected
            if mode == "cancel":
                await telegram.handle(callback("cancel:1"))
                assert "Latest" in sent[-1]["text"]
            else:
                update = callback(f"send:1:95:{boost}")
                await asyncio.gather(telegram.handle(update), telegram.handle(update))

    asyncio.run(run())
    failed = mode in ("reject", "disconnected")
    state = "new" if failed or mode == "cancel" else "applied"
    assert db.execute("SELECT state FROM jobs").fetchone()[0] == state
    assert len(calls) == (0 if mode in ("cancel", "disconnected") else 1)
    if calls:
        expected = {"jobReference": "1", "chargedAmount": 95.0, "coverLetter": "Latest"}
        expected.update(
            teamOrgId="o", selectedContractor={"id": "u", "oDeskUserID": "n"}
        )
        if boost:
            expected["boostBidAmount"] = 10
            expected["questions"] = [{"question": "Why?", "answer": "Because"}]
        assert calls[0] == expected
    texts = [p["text"] for p in sent if "text" in p]
    if failed:
        error = (
            "Upwork not connected — reconnect in the dashboard"
            if mode == "disconnected"
            else "Upwork rejected: Nope"
        )
        assert error in texts
    elif mode != "cancel":
        assert "Submitted — proposal p (OK)" in texts
        assert "Already applied" in texts and "Queue empty" in texts


@pytest.mark.parametrize("is_callback", [True, False])
def test_matching_chat_other_sender_ignored(bot, is_callback):
    telegram, db, sent = bot
    seed(db)
    telegram.awaiting = ("note", 1)
    update = (
        callback("apply:1")
        if is_callback
        else {"message": {"chat": {"id": 42}, "text": "shorter"}}
    )
    update["callback_query" if is_callback else "message"]["from"] = {"id": 99}
    asyncio.run(telegram.handle(update))
    assert not sent and telegram.awaiting == ("note", 1)
    assert db.execute("SELECT state FROM jobs").fetchone()[0] == "new"
