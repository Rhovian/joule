import json
import stat
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from joule.app import create_app


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
        yield client


def trace():
    return {
        "version": 1,
        "url": "https://user:password@forms.example/apply?token=secret#private",
        "job_id": 1,
        "errors": [],
        "fields": [
            {
                "ref": [0, 1],
                "selector": "#email",
                "label": "Email",
                "type": "email",
                "action": "set",
                "outcome": "written",
                "error": None,
                "before": False,
                "after": True,
                "signals": ["aria-invalid"],
            }
        ],
    }


def test_trace_private_unique_redacted_files(client, tmp_path):
    paths = [
        client.post("/api/fill/traces", json=trace()).json()["file"] for _ in range(2)
    ]
    assert paths[0] != paths[1]
    directory = tmp_path / "traces"
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    files = list(directory.glob("*.json"))
    assert len(files) == 2
    for path in files:
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        body = json.loads(path.read_text())
        assert body["url"] == "https://forms.example/apply"
        assert body["recorded_at"]
        assert body["fields"] == trace()["fields"]
        assert "secret" not in path.read_text()


@pytest.mark.parametrize(
    "change",
    [
        {"answer": "private"},
        {"errors": ["raw private exception"]},
        {"url": "file:///private"},
        {"fields": trace()["fields"] * 201},
        {
            "validation": {
                "status": "clicked",
                "network_blocked": False,
                "blocked_requests": 0,
            }
        },
    ],
)
def test_trace_rejects_unknown_values_and_bounds(client, tmp_path, change):
    response = client.post("/api/fill/traces", json={**trace(), **change})
    assert response.status_code == 422
    assert not (tmp_path / "traces").exists()


def test_trace_has_no_cors_or_simple_post(client, tmp_path):
    response = client.post(
        "/api/fill/traces",
        content=json.dumps(trace()),
        headers={"Content-Type": "text/plain", "Origin": "https://evil.example"},
    )
    assert response.status_code == 422
    assert "access-control-allow-origin" not in response.headers
    assert not (tmp_path / "traces").exists()


def test_url_only_replay_uses_profile_without_creating_job(client, tmp_path):
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / "cv.yaml").write_text(
        "basics:\n  name: Ada Lovelace\n  email: ada@example.com\n"
    )
    response = client.post(
        "/api/fill/replay-match",
        json={"fields": [{"ref": [0, 0], "type": "email", "required": True}]},
    )
    assert response.status_code == 200
    assert response.json()["actions"] == [
        {"ref": [0, 0], "action": "set", "value": "ada@example.com"}
    ]
    assert client.get("/api/jobs").json() == []


def test_submit_validation_categories_round_trip_without_text(client):
    body = trace()
    body["validation"] = {
        "status": "clicked",
        "network_blocked": True,
        "blocked_requests": 4,
    }
    body["fields"][0]["signals"] += ["submit-required-error", "submit-aria-invalid"]
    response = client.post("/api/fill/traces", json=body)
    assert response.status_code == 200
    saved = json.loads(Path(response.json()["file"]).read_text())
    assert saved["validation"] == body["validation"]
    assert saved["fields"][0]["signals"] == body["fields"][0]["signals"]
