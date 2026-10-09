import asyncio
import json
import logging
from contextlib import closing
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from fastapi import APIRouter, HTTPException, Request

from joule import ai, filters, score
from joule.config import StrictModel, load_preferences, load_settings
from joule.db import connect
from joule.sources import hn, hotfix, remoteok, upwork, weworkremotely

router = APIRouter()
logger = logging.getLogger(__name__)


async def fetch_hotfix(ctx):
    return await hotfix.search(ctx.client, ctx.preferences.roles)


async def enrich_hotfix(ctx, candidate):
    candidate.description = await hotfix.description(ctx.client, candidate.source_id)


async def fetch_upwork(ctx):
    p = ctx.preferences
    floors = (p.pay.hourly_floor, p.pay.fixed_floor, p.upwork_client.payment_verified)
    return await upwork.search(ctx.auth, p.roles, *floors)


async def enrich_upwork(ctx, candidate):
    candidate.extra["screening_questions"] = await upwork.screening_questions(
        ctx.auth, candidate.source_id
    )


ADAPTERS = {
    "hn": (lambda ctx: hn.search(ctx.client), None),
    "hotfix": (fetch_hotfix, enrich_hotfix),
    "upwork": (fetch_upwork, enrich_upwork),
    "weworkremotely": (lambda ctx: weworkremotely.search(ctx.client), None),
    "remoteok": (lambda ctx: remoteok.search(ctx.client), None),
}


class ScanInProgress(Exception):
    pass


class Scanner:
    def __init__(self, data_dir, client, auth):
        self.client, self.auth = client, auth
        self.data_dir = data_dir
        self.path = data_dir / "joule.db"
        self.busy = False
        self.task = None

    def start(self, sources, trigger, settings, preferences):
        if self.busy:
            raise ScanInProgress
        with closing(connect(self.path)) as db, db:
            scan_id = db.execute(
                "INSERT INTO scans (sources, trigger, started_at, status, per_source) "
                "VALUES (?, ?, ?, 'running', '{}')",
                (json.dumps(sources), trigger, datetime.now(UTC).isoformat()),
            ).lastrowid
        ctx = SimpleNamespace(
            client=self.client, auth=self.auth, preferences=preferences, inserted=[]
        )
        self.task = asyncio.create_task(self._run(scan_id, sources, settings, ctx))
        self.busy = True
        return scan_id

    async def _run(self, scan_id, sources, settings, ctx):
        progress, status = {}, "failed"
        try:
            with closing(connect(self.path)) as db:
                db.create_function("tidy", 1, filters.tidy)
                for source in sources:
                    counts = progress[source] = dict.fromkeys(
                        ("new", "duplicate", "filtered", "scored"), 0
                    )
                    counts["errors"] = []
                    try:
                        async with asyncio.timeout(settings.source_timeout_seconds):
                            await self._scan_source(db, source, settings, ctx, counts)
                    except Exception as error:
                        logger.exception("Scan Source %s failed", source)
                        counts["errors"].append(f"{type(error).__name__}: {error}")
                    with db:
                        db.execute(
                            "UPDATE scans SET per_source=? WHERE id=?",
                            (json.dumps(progress), scan_id),
                        )
                stamp = score.fingerprint(self.data_dir, settings)
                jobs = sorted(ctx.inserted, key=lambda j: j[2] or "", reverse=True)
                jobs = [j for j in jobs if j[1] != "upwork" or settings.upwork.scoring]
                limit = asyncio.Semaphore(3)

                async def grade(job):
                    id, source, _ = job
                    async with limit:
                        try:
                            await score.score_job(
                                db, id, settings, self.data_dir, stamp
                            )
                            progress[source]["scored"] += 1
                        except ai.AIError as error:
                            progress[source]["errors"].append(f"Score {id}: {error}")

                await asyncio.gather(*map(grade, jobs[: settings.max_scored_per_scan]))
                status = "done"
        except asyncio.CancelledError:
            status = "interrupted"
            raise
        finally:
            self.busy = False
            with closing(connect(self.path)) as db, db:
                db.execute(
                    "UPDATE scans SET status=?, finished_at=?, per_source=? WHERE id=?",
                    (
                        status,
                        datetime.now(UTC).isoformat(),
                        json.dumps(progress),
                        scan_id,
                    ),
                )

    async def _scan_source(self, db, source, settings, ctx, counts):
        first = not db.execute(
            "SELECT 1 FROM jobs WHERE source=? LIMIT 1", (source,)
        ).fetchone()
        cutoff = datetime.now(UTC) - timedelta(days=settings.max_age_days)
        fetch, enrich = ADAPTERS[source]
        new = [
            candidate
            for candidate in await fetch(ctx)
            if not (first and candidate.posted_at and candidate.posted_at < cutoff)
            and not db.execute(
                "SELECT 1 FROM jobs WHERE source=? AND source_id=?",
                (candidate.source, candidate.source_id),
            ).fetchone()
        ]
        limit = asyncio.Semaphore(5)

        async def add(candidate):
            if enrich:
                async with limit:
                    try:
                        await enrich(ctx, candidate)
                    except Exception as error:
                        logger.exception(
                            "Enrichment failed for %s", candidate.source_id
                        )
                        counts["errors"].append(f"{type(error).__name__}: {error}")
            self._insert(db, candidate, ctx.preferences, counts, ctx.inserted)

        await asyncio.gather(*map(add, new))

    def _insert(self, db, candidate, preferences, counts, ids):
        primary = None
        if candidate.source != "upwork" and candidate.company:
            names = tuple(map(filters.tidy, (candidate.company, candidate.title)))
            primary = db.execute(
                "SELECT id FROM jobs WHERE primary_id IS NULL AND source != 'upwork' "
                "AND tidy(COALESCE(company, ''))=? AND tidy(title)=? "
                "AND ((remote=1 AND ?=1) OR city COLLATE NOCASE=?) ORDER BY id LIMIT 1",
                (*names, candidate.remote, candidate.city),
            ).fetchone()
        reason = None if primary else filters.filter_reason(candidate, preferences)
        values = candidate.model_dump(mode="json") | {
            "extra": json.dumps(candidate.extra),
            "first_seen_at": datetime.now(UTC).isoformat(),
            "primary_id": primary["id"] if primary else None,
            "filtered_reason": reason,
            "location_unclear": int(filters.location_unclear(candidate)),
        }
        columns = ", ".join(values)
        placeholders = ", ".join("?" for _ in values)
        with db:
            cursor = db.execute(
                f"INSERT OR IGNORE INTO jobs ({columns}) VALUES ({placeholders})",
                tuple(values.values()),
            )
        if cursor.rowcount:
            counts["duplicate" if primary else "filtered" if reason else "new"] += 1
            if not primary and not reason:
                ids.append((cursor.lastrowid, candidate.source, values["posted_at"]))


class ScanRequest(StrictModel):
    sources: list[str] | None = None


@router.post("/api/scans", status_code=202)
async def start_scan(request: Request, body: ScanRequest):
    try:
        settings = load_settings(request.app.state.data_dir)
        preferences = load_preferences(request.app.state.data_dir)
    except Exception as error:
        raise HTTPException(422, str(error)) from error
    requested = body.sources
    if requested is not None and any(
        source not in settings.sources or source not in ADAPTERS for source in requested
    ):
        raise HTTPException(422, "Unknown or disabled source")
    sources = requested or [s for s in settings.sources if s in ADAPTERS]
    try:
        scanner = request.app.state.scanner
        return {"id": scanner.start(sources, "manual", settings, preferences)}
    except ScanInProgress:
        raise HTTPException(409, "Scan in progress") from None


@router.get("/api/scans/{scan_id}")
async def get_scan(request: Request, scan_id: int):
    with closing(connect(request.app.state.data_dir / "joule.db")) as db:
        row = db.execute("SELECT * FROM scans WHERE id=?", (scan_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Scan not found")
    result = dict(row)
    for key in ("sources", "per_source"):
        result[key] = json.loads(result[key] or "{}")
    return result
