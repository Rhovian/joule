from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from joule import ai, drafts, scan, score
from joule.config import Preferences, Settings
from joule.sources import Candidate
from joule.upwork_auth import UpworkNotConnected
from tests.test_scan import setup  # noqa: F401 — registers the shared pytest fixture


@pytest.mark.parametrize("failure", ["token", "source", "timeout", "score", "draft"])
def test_scheduled_upwork_failure_alert_once_until_recovery(
    request, monkeypatch, failure
):
    client, scanner, _, rows, run = request.getfixturevalue("setup")
    telegram = SimpleNamespace(send=AsyncMock(), alert=AsyncMock())
    scanner.telegram = telegram
    original_score_job = score.score_job
    settings = Settings(alert_threshold=60)
    fetch = AsyncMock(return_value=[])
    if failure == "token":
        monkeypatch.setattr(
            scanner.auth, "access_token", AsyncMock(side_effect=UpworkNotConnected)
        )
        fetch = scan.fetch_upwork
    elif failure == "source":
        fetch.side_effect = scan.upwork.UpworkError("API unavailable")
    elif failure == "timeout":
        fetch.side_effect = TimeoutError()
    else:
        fetch.return_value = [
            Candidate(source="upwork", source_id="1", title="Engineer", link="x")
        ]
        target = score if failure == "score" else drafts
        name = "score_job" if failure == "score" else "write"
        monkeypatch.setattr(target, name, AsyncMock(side_effect=ai.AIError("offline")))
    monkeypatch.setitem(scan.ADAPTERS, "upwork", (fetch, None))

    # A manual Scan reports errors in the dashboard without schedule alerts.
    run(["upwork"], settings)
    telegram.send.assert_not_awaited()
    for _ in range(2):
        run(["upwork"], settings, "scheduled")
        assert rows("scans")[-1]["status"] == "done"
    telegram.send.assert_awaited_once()
    message = telegram.send.call_args.args[0]
    assert "Scheduled Upwork Scan" in message and "dashboard" in message
    if failure == "token":
        assert "reconnect" in message.casefold()

    # Suppression survives reconstructing the Scanner (a process restart).
    replacement = scan.Scanner(
        scanner.data_dir, scanner.client, scanner.auth, telegram=telegram
    )

    async def restarted_scan():
        replacement.start(
            ["upwork"], "scheduled", settings, Preferences(roles=["Engineer"])
        )
        await replacement.task

    client.portal.call(restarted_scan)
    telegram.send.assert_awaited_once()

    monkeypatch.setitem(scan.ADAPTERS, "upwork", (AsyncMock(return_value=[]), None))
    if failure == "score":
        # Recovery really scores the pending Job using the fixture's AI mock.
        monkeypatch.setattr(score, "score_job", original_score_job)
    monkeypatch.setattr(drafts, "write", AsyncMock())
    run(["upwork"], settings, "scheduled")
    monkeypatch.setitem(
        scan.ADAPTERS,
        "upwork",
        (AsyncMock(side_effect=scan.upwork.UpworkError("x")), None),
    )
    run(["upwork"], settings, "scheduled")
    assert telegram.send.await_count == 2


def test_scheduled_failure_send_error_does_not_fail_scan_or_suppress_retry(
    request, monkeypatch, caplog
):
    _, scanner, _, rows, run = request.getfixturevalue("setup")
    send = AsyncMock(side_effect=httpx.HTTPError("Telegram offline"))
    scanner.telegram = SimpleNamespace(send=send, alert=AsyncMock())
    monkeypatch.setitem(
        scan.ADAPTERS,
        "upwork",
        (AsyncMock(side_effect=scan.upwork.UpworkError("x")), None),
    )
    run(["upwork"], trigger="scheduled")
    assert rows("scans")[-1]["status"] == "done"
    assert "Scheduled Upwork failure alert failed" in caplog.text
    send.side_effect = None
    run(["upwork"], trigger="scheduled")
    assert send.await_count == 2
    assert rows("scans")[-1]["status"] == "done"
    run(["upwork"], trigger="scheduled")
    assert send.await_count == 2


def test_schedule_errors_without_telegram_do_not_fail_scan(request, monkeypatch):
    _, _, _, rows, run = request.getfixturevalue("setup")
    monkeypatch.setitem(
        scan.ADAPTERS,
        "upwork",
        (AsyncMock(side_effect=scan.upwork.UpworkError("x")), None),
    )
    run(["upwork"], trigger="scheduled")
    assert rows("scans")[-1]["status"] == "done"
