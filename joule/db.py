import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    link TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT,
    description TEXT,
    location_raw TEXT,
    remote INTEGER CHECK (remote IN (0, 1)),
    city TEXT,
    country TEXT,
    arrangement TEXT,
    location_unclear INTEGER CHECK (location_unclear IN (0, 1)),
    pay_min REAL,
    pay_max REAL,
    pay_currency TEXT,
    pay_period TEXT CHECK (pay_period IN ('hour', 'year', 'fixed')),
    posted_at TEXT,
    first_seen_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'seen', 'dismissed')),
    primary_id INTEGER REFERENCES jobs(id),
    filtered_reason TEXT,
    score INTEGER,
    score_reason TEXT,
    score_points TEXT,
    scored_at TEXT,
    score_fingerprint TEXT,
    extra TEXT,
    content_purged_at TEXT,
    UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS jobs_primary_id ON jobs(primary_id);
CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL CHECK (kind IN ('tailored_cv', 'cover_letter', 'proposal')),
    text TEXT NOT NULL,
    pdf_path TEXT,
    note TEXT,
    model TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY,
    sources TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'interrupted', 'failed')),
    per_source TEXT
);
"""


def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def init_db(path: Path) -> None:
    new = not path.exists()
    if new:
        path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(path)) as connection:
        if new:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(SCHEMA)
        with connection:
            connection.execute(
                "UPDATE scans SET status='interrupted', finished_at=? "
                "WHERE status='running'",
                (datetime.now(UTC).isoformat(),),
            )
