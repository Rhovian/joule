import json
from contextlib import closing
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from joule.app import create_app
from joule.db import connect

URL = "/api/fill/jobs/1/match"
FIXTURES = Path(__file__).parent / "fixtures" / "fill"
CV = {
    "basics": {
        "name": "Ada Lovelace",
        "email": "ada@example.com",
        "phone": "+1 555 0100",
        "url": "https://ada.example.com",
        "profiles": [
            {"network": "LinkedIn", "url": "https://linkedin.com/in/ada"},
            {"network": "GitHub", "url": "https://github.com/ada"},
        ],
    },
    "work": [
        {"name": "Previous", "endDate": "2025-01"},
        {"name": "Current"},
    ],
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    def no_ai(*args, **kwargs):
        pytest.fail("Match must never invoke Codex")

    monkeypatch.setattr("joule.ai.structured", no_ai)
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / "cv.yaml").write_text(yaml.safe_dump(CV))
    with TestClient(create_app(tmp_path), base_url="http://localhost") as client:
        with closing(connect(tmp_path / "joule.db")) as db, db:
            for id, source, primary in (
                (1, "hotfix", None),
                (2, "upwork", None),
                (3, "hn", 1),
            ):
                db.execute(
                    "INSERT INTO jobs (id,source,source_id,link,title,company,"
                    "first_seen_at,primary_id,state) VALUES (?,?,?,'https://example.com',"
                    "'Engineer','Acme','now',?,'seen')",
                    (id, source, str(id), primary),
                )
        yield client


def post(client, fields):
    return client.post(URL, json={"fields": fields})


@pytest.mark.parametrize("name", ["greenhouse", "lever", "ashby-by-doc"])
def test_ats_fixtures(client, name):
    fixture = json.loads((FIXTURES / f"{name}.json").read_text())
    fields = [
        dict(ref=[7, index], **item["field"])
        for index, item in enumerate(fixture["cases"])
    ]
    response = post(client, fields)
    assert response.status_code == 200
    assert response.json() == {
        "job": {"id": 1, "title": "Engineer", "company": "Acme", "source": "hotfix"},
        "actions": [
            dict(
                ref=[7, index],
                **(
                    {"action": "leave", "reason": "no Cover Letter Draft"}
                    if item["expected"].get("file") == "cover_letter"
                    else item["expected"]
                ),
            )
            for index, item in enumerate(fixture["cases"])
        ],
        "resume_draft_id": None,
        "cover_letter_draft_id": None,
        "resume_draft": None,
    }


@pytest.mark.parametrize(
    "field,value",
    [
        ({"autocomplete": "section-contact given-name", "id": "last_name"}, "Ada"),
        ({"autocomplete": "family-name", "type": "email"}, "Lovelace"),
        ({"autocomplete": "name"}, "Ada Lovelace"),
        ({"autocomplete": "email"}, "ada@example.com"),
        ({"autocomplete": "tel"}, "+1 555 0100"),
        ({"autocomplete": "url"}, "https://ada.example.com"),
        ({"type": "email", "name": "name"}, "ada@example.com"),
        ({"type": "tel"}, "+1 555 0100"),
        ({"label": "  Given name ✱ * "}, "Ada"),
        ({"label": "Family name"}, "Lovelace"),
        ({"label": "Surname"}, "Lovelace"),
        ({"label": "Your name"}, "Ada Lovelace"),
        ({"label": "E-mail address"}, "ada@example.com"),
        ({"label": "Mobile number"}, "+1 555 0100"),
        ({"label": "Personal site"}, "https://ada.example.com"),
        ({"label": "Current employer"}, "Current"),
    ],
)
def test_priority_and_generic_labels(client, field, value):
    assert post(client, [{"ref": [0, 0], **field}]).json()["actions"] == [
        {"ref": [0, 0], "action": "set", "value": value}
    ]


@pytest.mark.parametrize(
    "label",
    [
        "EEO",
        "Demographic",
        "Disability",
        "Veteran status",
        "Pronouns",
        "Criminal history",
        "Consent",
        "Privacy",
        "Attestation",
        "Gender",
        "Ethnicity",
        "I agree to terms",
    ],
)
def test_sensitive_identity_collision_is_left(client, label):
    action = post(
        client, [{"ref": [0, 0], "label": label, "autocomplete": "email"}]
    ).json()["actions"][0]
    assert action == {"ref": [0, 0], "action": "leave", "reason": "sensitive"}


def test_missing_values_and_reread(client):
    path = client.app.state.data_dir / "profile" / "cv.yaml"
    path.unlink()
    field = {"ref": [0, 0], "name": "email"}
    assert post(client, [field]).json()["actions"][0] == {
        "ref": [0, 0],
        "action": "leave",
        "reason": "missing in cv.yaml",
    }
    path.write_text(yaml.safe_dump(CV))
    assert post(client, [field]).json()["actions"][0]["value"] == "ada@example.com"
    path.write_text(yaml.safe_dump({"basics": {"name": "Ada"}, "work": CV["work"][:1]}))
    actions = post(
        client, [{"ref": [0, 0], "id": "last_name"}, {"ref": [0, 1], "name": "org"}]
    ).json()["actions"]
    assert all(a["reason"] == "missing in cv.yaml" for a in actions)


@pytest.mark.parametrize("id,status", [(2, 400), (3, 404), (999, 404)])
def test_primary_non_upwork_only(client, id, status):
    assert (
        client.post(f"/api/fill/jobs/{id}/match", json={"fields": []}).status_code
        == status
    )


def test_latest_drafts_are_job_scoped_and_state_unchanged(client):
    with closing(connect(client.app.state.data_dir / "joule.db")) as db, db:
        before = [tuple(row) for row in db.execute("SELECT * FROM jobs ORDER BY id")]
        for id, job, kind in [
            (1, 1, "tailored_cv"),
            (2, 1, "cover_letter"),
            (3, 1, "tailored_cv"),
            (4, 2, "cover_letter"),
        ]:
            db.execute(
                "INSERT INTO drafts (id,job_id,kind,text,created_at) VALUES (?,?,?,'{}','now')",
                (id, job, kind),
            )
    result = post(client, [{"ref": [0, 0], "type": "file", "id": "resume"}]).json()
    assert result["resume_draft_id"] == 3 and result["cover_letter_draft_id"] == 2
    assert result["resume_draft"] == {"id": 3, "version": 2, "created_at": "now"}
    with closing(connect(client.app.state.data_dir / "joule.db")) as db:
        assert [
            tuple(row) for row in db.execute("SELECT * FROM jobs ORDER BY id")
        ] == before


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"fields": [], "extra": True},
        {"fields": [{"ref": [0, 0], "extra": True}]},
        {"fields": [{"ref": [0, 0], "label": "x" * 2001}]},
        {"fields": [{"ref": [0, 0], "options": [{"value": "x" * 201, "label": "x"}]}]},
        {"fields": [{"ref": [0, 0], "options": [{"value": "x", "label": "x" * 201}]}]},
        {
            "fields": [
                {
                    "ref": [0, 0],
                    "options": [{"value": "x", "label": "x", "extra": True}],
                }
            ]
        },
        {"fields": [{"ref": [0, 0], "options": [{"value": "x", "label": "x"}] * 101}]},
        {"fields": [{"ref": [0, 0]}] * 201},
        {"fields": [{"ref": [0, "1"]}]},
        {"fields": [{"ref": [False, 1]}]},
        {"fields": [{"ref": [-1, 1]}]},
        {"fields": [{"ref": [1]}]},
        {"fields": [{"ref": [0, 0], "maxlength": -1}]},
    ],
)
def test_limits_and_extra_keys(client, body):
    assert client.post(URL, json=body).status_code == 422


def test_limit_boundaries(client):
    field = {
        "ref": [0, 0],
        "label": "x" * 2000,
        "maxlength": 0,
        "options": [{"value": "v" * 200, "label": "l" * 200}] * 100,
    }
    assert post(client, [field] * 200).status_code == 200


def test_plain_post_cors_and_host(client):
    response = client.post(
        URL,
        content=json.dumps({"fields": []}),
        headers={"Content-Type": "text/plain", "Origin": "https://evil.com"},
    )
    assert response.status_code == 422
    assert not any(h.startswith("access-control-") for h in response.headers)
    response = client.post(
        URL, json={"fields": []}, headers={"Origin": "https://evil.com"}
    )
    assert response.status_code == 200
    assert not any(h.startswith("access-control-") for h in response.headers)
    assert (
        client.post(URL, json={"fields": []}, headers={"Host": "evil.com"}).status_code
        == 400
    )
    assert client.get("/api/jobs/1").json()["state"] == "seen"
