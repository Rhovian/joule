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
    state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'seen', 'dismissed', 'applied')),
    primary_id INTEGER REFERENCES jobs(id),
    filtered_reason TEXT,
    score INTEGER,
    score_reason TEXT,
    score_points TEXT,
    scored_at TEXT,
    score_fingerprint TEXT,
    extra TEXT,
    content_purged_at TEXT,
    queued INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS jobs_primary_id ON jobs(primary_id);
CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL CHECK (kind IN ('tailored_cv', 'cover_letter', 'proposal', 'follow_up')),
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


EMAIL_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS email_suggestions (
        id INTEGER PRIMARY KEY, account TEXT NOT NULL, message_id TEXT NOT NULL,
        job_id INTEGER NOT NULL REFERENCES jobs(id), first_move_id INTEGER NOT NULL, move_id INTEGER NOT NULL,
        folder TEXT NOT NULL, uid INTEGER NOT NULL, sender_name TEXT NOT NULL,
        sender_address TEXT NOT NULL, subject TEXT NOT NULL, quote TEXT NOT NULL, date TEXT,
        proposal TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','confirmed','ignored','excluded')),
        UNIQUE(account,message_id,job_id)
    )""",
    "CREATE INDEX IF NOT EXISTS email_suggestions_job ON email_suggestions(job_id)",
    """CREATE TABLE IF NOT EXISTS email_checks (
        account TEXT NOT NULL, folder TEXT NOT NULL, validity TEXT NOT NULL,
        uid INTEGER NOT NULL, checked_at TEXT NOT NULL, PRIMARY KEY(account,folder)
    )""",
)


PIPELINE_SCHEMA = (
    """CREATE TABLE IF NOT EXISTS pipeline_moves (
        id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL REFERENCES jobs(id),
        stage TEXT NOT NULL CHECK (stage IN ('applied', 'screen', 'interview', 'offer', 'accepted')),
        closed_reason TEXT CHECK (closed_reason IN ('rejected', 'no_reply', 'withdrawn')),
        next_at TEXT,
        next_label TEXT,
        created_at TEXT NOT NULL,
        how TEXT NOT NULL CHECK (how IN ('manual', 'auto')),
        note TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS pipeline (
        job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
        first_move_id INTEGER NOT NULL REFERENCES pipeline_moves(id),
        move_id INTEGER NOT NULL REFERENCES pipeline_moves(id)
    )""",
    "CREATE INDEX IF NOT EXISTS pipeline_moves_job ON pipeline_moves(job_id, id)",
    """CREATE TRIGGER IF NOT EXISTS pipeline_remove_on_unmark
        AFTER UPDATE OF state ON jobs WHEN NEW.state != 'applied'
        BEGIN DELETE FROM pipeline WHERE job_id=NEW.id; END""",
)


def enter_pipeline(db, job_id, how="manual"):
    missing = db.execute(
        "SELECT 1 FROM jobs WHERE id=? AND state='applied' AND primary_id IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM pipeline WHERE job_id=jobs.id)",
        (job_id,),
    ).fetchone()
    if missing:
        move_id = db.execute(
            "INSERT INTO pipeline_moves (job_id,stage,created_at,how) VALUES (?,'applied',?,?)",
            (job_id, datetime.now(UTC).isoformat(), how),
        ).lastrowid
        db.execute("INSERT INTO pipeline VALUES (?,?,?)", (job_id, move_id, move_id))


def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    # SQLite lower() is ASCII-only; Python's Unicode casefold needs no ICU extension.
    connection.create_function("casefold", 1, str.casefold, deterministic=True)
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def extend_check(connection, table, existing, added):
    sql = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()[0]
    if added not in sql:
        # SQLite's existing CHECK migration: https://sqlite.org/lang_altertable.html#otheralter
        version = connection.execute("PRAGMA schema_version").fetchone()[0]
        connection.execute("PRAGMA writable_schema=ON")
        connection.execute(
            "UPDATE sqlite_master SET sql=? WHERE type='table' AND name=?",
            (sql.replace(existing, f"{existing}, {added}"), table),
        )
        connection.execute(f"PRAGMA schema_version={version + 1}")
        connection.execute("PRAGMA writable_schema=OFF")
    return sql


def init_db(path: Path) -> None:
    new = not path.exists()
    if new:
        path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(path)) as connection:
        if new:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(SCHEMA)
        with connection:
            connection.execute("BEGIN")
            sql = extend_check(connection, "jobs", "'dismissed'", "'applied'")
            extend_check(connection, "drafts", "'proposal'", "'follow_up'")
            if "queued" not in sql:
                connection.execute(
                    "ALTER TABLE jobs ADD COLUMN queued INTEGER NOT NULL DEFAULT 0"
                )
            for statement in PIPELINE_SCHEMA + EMAIL_SCHEMA:
                connection.execute(statement)
            for row in connection.execute(
                "SELECT id FROM jobs WHERE state='applied' AND primary_id IS NULL "
                "AND NOT EXISTS (SELECT 1 FROM pipeline WHERE job_id=jobs.id)"
            ).fetchall():
                enter_pipeline(connection, row["id"], "auto")
            connection.execute(
                "UPDATE scans SET status='interrupted', finished_at=? "
                "WHERE status='running'",
                (datetime.now(UTC).isoformat(),),
            )
