import logging

logger = logging.getLogger(__name__)


async def scheduled_upwork(data_dir, telegram, trigger, status, progress):
    if trigger != "scheduled" or "upwork" not in progress or status == "interrupted":
        return
    # HTTPX sends each request; it has no concept of a Scan failure episode.
    # https://github.com/encode/httpx/blob/0.28.1/httpx/_client.py#L1594-L1630
    # Persist successful notification until an error-free scheduled Scan, so
    # a restart cannot turn the same ongoing failure into repeated alerts.
    notified = data_dir / "upwork-schedule-failure-alerted"
    try:
        errors = progress["upwork"]["errors"]
        if status == "done" and not errors:
            notified.unlink(missing_ok=True)
            return
        if telegram is None or notified.exists():
            return
        message = (
            "Scheduled Upwork Scan encountered errors. "
            "Check the Scan errors in the dashboard."
        )
        if any(error.startswith("UpworkNotConnected:") for error in errors):
            message += " Reconnect Upwork in the dashboard."
        message += (
            " Further failure alerts are paused until a scheduled Scan succeeds "
            "without errors."
        )
        await telegram.send(message)
        # A failed send must leave the next failing Scan free to try again.
        notified.touch()
    except Exception:
        logger.exception("Scheduled Upwork failure alert failed")
