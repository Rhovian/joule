import sqlite3
from contextlib import closing

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from joule.app import create_app
from joule.config import load_env, load_settings
from joule.db import connect, init_db


def test_missing_settings_use_defaults(tmp_path):
    settings = load_settings(tmp_path)
    assert settings.sources == [
        "hn",
        "weworkremotely",
        "remoteok",
        "upwork",
        "hotfix",
        "getarustjob",
    ]
    assert settings.models.scoring.model == "gpt-6-luna"
    assert settings.models.scoring.provider == "codex"
    assert settings.models.drafts.model is None
    assert settings.models.drafts.provider == "codex"


def test_partial_settings_keep_nested_defaults_and_reread(tmp_path):
    path = tmp_path / "settings.yaml"
    path.write_text("upwork:\n  scoring: false\n")
    settings = load_settings(tmp_path)
    assert settings.upwork.scoring is False
    assert settings.upwork.retention_hours == 24
    assert settings.schedule.upwork_minutes == 15
    path.write_text("schedule:\n  upwork_minutes: null\n")
    assert load_settings(tmp_path).schedule.upwork_minutes is None


@pytest.mark.parametrize(
    "yaml",
    [
        "typo: true",
        "upwork:\n  typo: true",
        "models:\n  scoring:\n    provider: openai\n    model: x\n    typo: true",
    ],
)
def test_unknown_settings_raise(tmp_path, yaml):
    (tmp_path / "settings.yaml").write_text(yaml)
    with pytest.raises(ValidationError):
        load_settings(tmp_path)


@pytest.mark.parametrize("kind", ["scoring", "drafts"])
@pytest.mark.parametrize("override", ["provider: openai", "model: x"])
def test_model_overrides_require_provider_and_model(tmp_path, kind, override):
    (tmp_path / "settings.yaml").write_text(f"models:\n  {kind}:\n    {override}\n")
    with pytest.raises(ValidationError):
        load_settings(tmp_path)


def test_env_file_and_process_override(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert load_env(tmp_path) == {}
    (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=file-key\n")
    assert load_env(tmp_path) == {"ANTHROPIC_API_KEY": "file-key"}
    monkeypatch.setenv("ANTHROPIC_API_KEY", "process-key")
    assert load_env(tmp_path) == {"ANTHROPIC_API_KEY": "process-key"}


def test_db_initialization_and_unique_jobs(tmp_path):
    path = tmp_path / "joule.db"
    init_db(path)
    init_db(path)
    with closing(connect(path)) as db, db:
        sql = (
            "INSERT INTO jobs (source, source_id, link, title, first_seen_at) "
            "VALUES (?, ?, ?, ?, '2026-10-08T00:00:00+00:00')"
        )
        values = ("hn", "1", "https://example.com", "Engineer")
        db.execute(sql, values)
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(sql, values)
        with pytest.raises(sqlite3.IntegrityError, match="jobs.source_id"):
            db.execute(sql, ("hn", None, "https://example.com", "Engineer"))


def test_startup_interrupts_running_scans(tmp_path):
    path = tmp_path / "joule.db"
    init_db(path)
    with closing(connect(path)) as db, db:
        db.execute(
            "INSERT INTO scans (sources, trigger, started_at, status) "
            "VALUES ('[\"hn\"]', 'manual', '2026-10-08T00:00:00+00:00', 'running')"
        )
    init_db(path)
    with closing(connect(path)) as db:
        scan = db.execute("SELECT status, finished_at FROM scans").fetchone()
        assert scan["status"] == "interrupted"
        assert scan["finished_at"].endswith("+00:00")


def test_app_startup_creates_only_the_database(tmp_path):
    directory = tmp_path / "data"
    with TestClient(create_app(directory), base_url="http://localhost") as client:
        assert client.app.state.data_dir == directory
        assert [path.name for path in directory.iterdir()] == ["joule.db"]


def test_host_validation_and_framing_headers(tmp_path):
    (tmp_path / ".env").write_text(
        "UPWORK_REDIRECT_URI=https://joule.example.ts.net/auth/upwork/callback\n"
    )
    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
        for host, status in [("evil.com", 400), ("joule.example.ts.net", 200)]:
            response = client.get("/api/upwork/status", headers={"Host": host})
            assert response.status_code == status
            assert response.headers["X-Frame-Options"] == "DENY"
            assert (
                response.headers["Content-Security-Policy"] == "frame-ancestors 'none'"
            )


def test_codex_model_override_is_optional(tmp_path):
    (tmp_path / "settings.yaml").write_text(
        "models:\n  scoring:\n    provider: codex\n  drafts:\n    provider: codex\n    model: chosen\n"
    )
    settings = load_settings(tmp_path)
    assert settings.models.scoring.model is None
    assert settings.models.drafts.model == "chosen"
