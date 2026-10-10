import asyncio
import json
import logging
import re
from contextlib import closing, suppress

from joule import drafts
from joule.config import load_settings
from joule.db import connect
from joule.sources import upwork
from joule.upwork_auth import UpworkNotConnected

logger = logging.getLogger(__name__)
ELIGIBLE = (
    "primary_id IS NULL AND filtered_reason IS NULL AND state='new' "
    "AND content_purged_at IS NULL "
    "AND (score >= ? OR (source='upwork' AND score IS NULL))"
)


def kind(job):
    return "proposal" if job["source"] == "upwork" else "cover_letter"


def queue(db, threshold):
    return db.execute(
        f"SELECT * FROM jobs WHERE {ELIGIBLE} AND EXISTS "
        "(SELECT 1 FROM drafts WHERE job_id=jobs.id AND kind=CASE "
        "WHEN jobs.source='upwork' THEN 'proposal' ELSE 'cover_letter' END) "
        "ORDER BY posted_at DESC NULLS LAST, score DESC",
        (threshold,),
    ).fetchall()


def proposal(db, job):
    draft = db.execute(
        "SELECT text FROM drafts WHERE job_id=? AND kind=? ORDER BY id DESC LIMIT 1",
        (job["id"], kind(job)),
    ).fetchone()
    content = json.loads(draft["text"])
    questions = json.loads(job["extra"] or "{}").get("screening_questions", [])
    answers = zip(questions, content.get("answers", []))
    return content, [{"question": q, "answer": a} for q, a in answers]


class Telegram:
    def __init__(self, data_dir, client, token, chat_id, upwork_auth=None):
        self.data_dir, self.client, self.auth = data_dir, client, upwork_auth
        self.url = f"https://api.telegram.org/bot{token}/"
        self.chat_id, self.awaiting = str(chat_id), None

    async def api(self, method, **payload):
        response = await self.client.post(self.url + method, json=payload, timeout=60)
        if response.is_error:
            try:
                description = response.json().get("description", "")
            except ValueError:
                description = response.text[:200]
            raise RuntimeError(
                f"Telegram {method} failed: {response.status_code} {description}"
            )
        return response.json()["result"]

    async def send(self, text, buttons=None):
        for i in range(0, len(text), 4000):
            payload = {"chat_id": self.chat_id, "text": text[i : i + 4000]}
            if buttons and i + 4000 >= len(text):
                payload["reply_markup"] = {"inline_keyboard": [buttons]}
            await self.api("sendMessage", **payload)

    async def alert(self, count, threshold):
        with closing(connect(self.data_dir / "joule.db")) as db:
            total = len(queue(db, threshold))
        await self.send(
            f"{count} new Jobs queued ({total} in queue)",
            [{"text": "Start", "callback_data": "start"}],
        )

    async def card(self, db, job=None):
        if job is None:
            jobs = queue(db, load_settings(self.data_dir).alert_threshold)
            if not jobs:
                return await self.send("Queue empty")
            job = jobs[0]
        content, answers = proposal(db, job)
        text = content.get("text", content.get("cover", ""))
        for question, answer in (a.values() for a in answers):
            text += f"\n\nQ: {question}\nA: {answer}"
        flag = "⚠ needs Loom video\n" if "[LOOM LINK]" in text else ""
        await self.send(
            f"{flag}{job['title']}\n{job['company'] or ''}\n{job['source']}\n"
            f"Fit Score: {job['score'] if job['score'] is not None else 'unscored'} "
            f"— {job['score_reason'] or ''}\n{job['link']}\n\n{text}",
            [
                {"text": action.title(), "callback_data": f"{action}:{job['id']}"}
                for action in ("apply", "rework", "skip")
            ],
        )

    async def handle(self, update):
        callback = update.get("callback_query")
        message = (callback or update).get("message", {})
        if str(message.get("chat", {}).get("id")) != self.chat_id:
            return
        if str((callback or message).get("from", {}).get("id")) != self.chat_id:
            return
        if callback:
            await self.api("answerCallbackQuery", callback_query_id=callback["id"])
            data = callback.get("data", "")
            if data == "start":
                self.awaiting = None
                with closing(connect(self.data_dir / "joule.db")) as db:
                    return await self.card(db)
            action, _, value = data.partition(":")
            if action not in ("apply", "skip", "rework", "send", "cancel"):
                return
            job_id = int(value.split(":")[0])
        elif self.awaiting is not None and isinstance(message.get("text"), str):
            action, job_id = self.awaiting
        else:
            return
        with closing(connect(self.data_dir / "joule.db")) as db:
            job = db.execute(
                "SELECT * FROM jobs WHERE id=? AND primary_id IS NULL", (job_id,)
            ).fetchone()
            if job is None:
                self.awaiting = None
                return await self.send("Job not found")
            title = job["title"]
            period = "hourly" if job["pay_period"] == "hour" else "fixed"
            if action == "rework":
                self.awaiting = ("note", job_id)
                return await self.send(f"Send direction for {job['title']}")
            if action == "apply" and job["source"] == "upwork":
                self.awaiting = ("bid", job_id)
                values = (job["pay_min"], job["pay_max"])
                amounts = "–".join(f"{v:g}" for v in values if v is not None)
                pay = f"{period} ${amounts}" if amounts else "pay not stated"
                text = f"Bid for {title} ({pay}). Reply: <amount> [boost Connects]."
                with suppress(Exception):
                    text += f" Connects available: {await upwork.connects_balance(self.auth)}"
                return await self.send(text)
            if action == "bid":
                text = message["text"].strip()
                m = re.fullmatch(r"(\d+(?:\.\d+)?)(?:\s+(\d+))?", text)
                if not m or float(m[1]) <= 0:
                    return await self.send("Reply like: 95 or 95 10")
                amount, boost = m[1], int(m[2] or 0)
                send_data = f"send:{job_id}:{amount}:{boost}"
                self.awaiting = None
                return await self.send(
                    f"Send proposal for {title}: ${amount} ({period}), boost {boost} Connects?",
                    [
                        {"text": "Send", "callback_data": send_data},
                        {"text": "Cancel", "callback_data": f"cancel:{job_id}"},
                    ],
                )
            self.awaiting = None
            if action == "cancel":
                return await self.card(db, job)
            if action == "send" and job["source"] == "upwork":
                return await self.submit(db, job, value)
            if action == "note":
                settings = load_settings(self.data_dir)
                await drafts.write(
                    db, job, kind(job), message["text"], settings, self.data_dir
                )
                return await self.card(db, job)
            with db:
                db.execute(
                    "UPDATE jobs SET state=? WHERE id=? AND primary_id IS NULL"
                    + (" AND state='new'" if action == "skip" else ""),
                    ("applied" if action == "apply" else "seen", job_id),
                )
            if action == "apply":
                await self.send(f"Marked applied — submit here: {job['link']}")
            await self.card(db)

    async def submit(self, db, job, value):
        job_id, state = job["id"], job["state"]
        _, amount, boost = value.split(":")
        amount, boost = float(amount), int(boost)
        claim = "UPDATE jobs SET state='applied' WHERE id=? AND primary_id IS NULL AND state=? AND state!='applied'"
        with db:
            claimed = db.execute(claim, (job_id, state)).rowcount
        if not claimed:
            return await self.send("Already applied")
        try:
            content, answers = proposal(db, job)
            result = await upwork.submit_proposal(
                self.auth, job["source_id"], amount, content["cover"], answers, boost
            )
        except Exception as error:
            logger.exception("Upwork submission failed")
            restore = "UPDATE jobs SET state=? WHERE id=? AND state='applied'"
            with db:
                db.execute(restore, (state, job_id))
            return await self.send(
                "Upwork not connected — reconnect in the dashboard"
                if isinstance(error, UpworkNotConnected)
                else f"Upwork rejected: {error}"
            )
        text = f"Submitted — proposal {result['newProposalId']} ({result['status']})"
        await self.send(text)
        await self.card(db)

    async def run(self):
        offset = -1
        while True:
            try:
                updates = await self.api(
                    "getUpdates", offset=offset, timeout=0 if offset == -1 else 50
                )
                for update in updates:
                    if offset != -1:
                        try:
                            await self.handle(update)
                        except Exception:
                            logger.exception("Telegram update failed")
                offset = updates[-1]["update_id"] + 1 if updates else max(offset, 0)
            except Exception:
                logger.exception("Telegram polling failed")
                await asyncio.sleep(5)
