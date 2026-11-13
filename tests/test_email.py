import json
from contextlib import closing
from datetime import UTC, datetime
from email.message import EmailMessage
from functools import partial
from stat import S_IMODE

from fastapi.testclient import TestClient

from joule import ai
from joule.app import create_app
from joule.db import connect, enter_pipeline
from tests.imap_fixture import PASSWORD, USERNAME, imap_server


def test_email_connect_validate_private_and_disconnect(tmp_path, monkeypatch):
    directory = tmp_path / "joule"
    responses = []
    with (
        imap_server(tmp_path / "tls") as server,
        TestClient(create_app(directory), base_url="http://localhost") as client,
    ):
        monkeypatch.setenv("SSL_CERT_FILE", str(server.certificate))
        config = {
            "inbox": "imap",
            "host": "localhost",
            "port": server.server_address[1],
            "username": USERNAME,
            "password": PASSWORD,
        }
        path = directory / "email.json"
        assert client.get("/api/email").json() == {
            "state": "not_connected",
            "config": None,
        }
        response = client.put("/api/email", json=config | {"password": "wrong"})
        responses.append(response)
        assert response.status_code == 401 and not path.exists()
        response = client.put("/api/email", json=config)
        responses.append(response)
        assert response.status_code == 200 and response.json()["state"] == "connected"
        assert S_IMODE(path.stat().st_mode) == 0o600
        assert json.loads(path.read_text()) == config | {
            "tls": True,
            "scope": "pipeline",
            "folder": "INBOX",
            "check_minutes": 15,
        }
        original = path.read_bytes()
        assert (
            client.put(
                "/api/email", json=config | {"username": "other user", "password": None}
            ).status_code
            == 400
            and path.read_bytes() == original
        )
        assert (
            client.put(
                "/api/email", json=config | {"password": "new wrong password"}
            ).status_code
            == 401
            and client.get("/api/email").json()["state"] == "connected"
        )
        response = client.put("/api/email", json=config | {"password": [PASSWORD]})
        responses.append(response)
        assert response.status_code == 422 and path.read_bytes() == original
        response = client.put(
            "/api/email",
            json=config | {"password": None, "scope": "folder", "folder": "missing"},
        )
        responses.append(response)
        assert response.status_code == 400 and path.read_bytes() == original
        server.drop_on_login = True
        assert (
            client.put("/api/email", json=config | {"password": None}).status_code
            == 502
        )
        assert client.get("/api/email").json()["state"] == "connected"
        server.drop_on_login = False
        server.allow_login = False
        response = client.put("/api/email", json=config | {"password": None})
        responses.append(response)
        assert response.status_code == 401 and path.read_bytes() == original
        responses.append(client.get("/api/email"))
        assert responses[-1].json()["state"] == "expired"
        server.allow_login = True
        updated = config | {
            "password": None,
            "scope": "folder",
            "folder": "Jobs & 台北",
            "check_minutes": 60,
        }
        responses.append(client.put("/api/email", json=updated))
        assert responses[-1].json()["state"] == "connected"
        assert server.folders[-1] == "Jobs &- &U,BTFw-"
        assert json.loads(path.read_text())["password"] == PASSWORD
        with imap_server(tmp_path / "starttls", implicit=False) as upgrade:
            monkeypatch.setenv("SSL_CERT_FILE", str(upgrade.certificate))
            response = client.put(
                "/api/email",
                json=config | {"port": upgrade.server_address[1], "tls": False},
            )
            responses.append(response)
            assert response.status_code == 200
            assert ("STARTTLS", False) in upgrade.commands and (
                "LOGIN",
                True,
            ) in upgrade.commands
            assert not any(
                command == "LOGIN" and not secure
                for command, secure in upgrade.commands
            )
        responses.append(client.delete("/api/email"))
        assert responses[-1].json()["state"] == "not_connected" and not path.exists()
        for response in responses:
            assert PASSWORD not in response.text and "password" not in (
                response.json().get("config") or {}
            )
        assert {command for command, _ in server.commands} <= {
            "CAPABILITY",
            "LOGIN",
            "EXAMINE",
            "LOGOUT",
        }


def test_email_suggestions_require_confirmation_and_remember_exclusions(
    tmp_path, monkeypatch
):
    def message(subject, sender="Acme Talent <talent@acme.com>", old=False):
        mail = EmailMessage()
        mail["From"], mail["Subject"], mail["Message-ID"] = (
            sender,
            subject,
            f"<{subject.replace(' ', '-')}@fixture>",
        )
        mail["Date"] = datetime(2000, 1, 1, tzinfo=UTC) if old else datetime.now(UTC)
        mail.set_content(
            "Intro call on Friday. "
            + "x" * 200
            + "\n> quoted old message\nPRIVATE BODY TAIL"
        )
        return mail.as_bytes()

    calls = []

    async def classify(model, prompt, schema):
        calls.append(prompt)
        action = (
            "reject"
            if "Update" in prompt
            else "date"
            if "Technical" in prompt
            else "move"
        )
        return schema(
            action=action,
            stage="screen" if action == "move" else None,
            next_at="2027-01-07T14:00:00Z" if action == "date" else None,
            next_label="Technical" if action == "date" else None,
        )

    monkeypatch.setattr(ai, "structured", classify)
    with (
        imap_server(tmp_path / "tls") as server,
        TestClient(
            create_app(tmp_path / "joule"), base_url="http://localhost"
        ) as client,
    ):
        monkeypatch.setenv("SSL_CERT_FILE", str(server.certificate))
        service = client.app.state.email_suggestions
        check = lambda: client.portal.call(partial(service.check, scan=True))
        db_path = tmp_path / "joule" / "joule.db"
        with closing(connect(db_path)) as db, db:
            for name in ["Acme", "Phantom", "Pinterest", "Ambiguous", "Ambiguous"]:
                job_id = db.execute(
                    "INSERT INTO jobs(source,source_id,link,title,company,first_seen_at,state) VALUES ('hn',?,'https://jobs.example/role','Engineer',?,?,'applied')",
                    (name + str(db.total_changes), name, datetime.now(UTC).isoformat()),
                ).lastrowid
                enter_pipeline(db, job_id)
        assert (
            client.put(
                "/api/email",
                json={
                    "inbox": "imap",
                    "host": "localhost",
                    "port": server.server_address[1],
                    "username": USERNAME,
                    "password": PASSWORD,
                },
            ).status_code
            == 200
        )
        server.messages = {
            1: message("Next steps"),
            2: message("Update Pinterest", "Recruiting <jobs@greenhouse.io>"),
            3: message("Technical", "Phantom <jobs@phantom.com>"),
            4: message("Unmatched", "Other <other@elsewhere.com>"),
            5: message("Ambiguous", "Other <jobs@ambiguous.com>"),
            6: message("Too old", old=True),
        }
        check()
        requests = len(server.uid_requests)
        client.portal.call(service.check)
        assert len(server.uid_requests) == requests
        client.put(
            "/api/email",
            json=client.get("/api/email").json()["config"]
            | {"password": None, "check_minutes": None},
        )
        suggestions = client.get("/api/email/suggestions").json()["suggestions"]
        assert len(suggestions) == len(calls) == 3
        assert all(
            row["stage"] == "applied" for row in client.get("/api/pipeline").json()
        )
        assert {
            row["job_id"]: row["email_count"]
            for row in client.get("/api/pipeline").json()
        } == {1: 1, 2: 1, 3: 1, 4: 0, 5: 0}
        by_subject = {row["subject"]: row for row in suggestions}
        assert len(by_subject["Next steps"]["quote"]) == 140
        for subject, action in [
            ("Next steps", "exclude"),
            ("Update Pinterest", "confirm"),
            ("Technical", "confirm"),
        ]:
            row = by_subject[subject]
            assert (
                client.post(f"/api/email/suggestions/{row['id']}/{action}").status_code
                == 200
            )
        assert client.get("/api/pipeline/3").json()["closed_reason"] == "rejected"
        dated = client.get("/api/pipeline/2").json()
        assert (
            dated["next_at"] == "2027-01-07T14:00:00+00:00"
            and "Technical" in dated["history"][-1]["note"]
        )
        assert "Phantom" in dated["history"][-1]["note"]
        # Reset UIDVALIDITY and redeliver the excluded Message-ID: durable exclusion wins.
        server.validity = "2"
        server.messages[7] = server.messages[1]
        check()
        assert (
            len(calls) == 3
            and not client.get("/api/email/suggestions").json()["suggestions"]
        )
        server.messages[8] = message("Another next step")
        check()
        pending = client.get("/api/email/suggestions").json()["suggestions"][0]
        client.patch("/api/pipeline/1", json={"stage": "offer"})
        assert (
            client.post(f"/api/email/suggestions/{pending['id']}/confirm").status_code
            == 409
        )
        assert (
            client.post(f"/api/email/suggestions/{pending['id']}/ignore").status_code
            == 200
        )
        assert not client.get("/api/email/suggestions").json()["suggestions"]
        with closing(connect(db_path)) as db:
            stored = " ".join(
                str(tuple(row)) for row in db.execute("SELECT * FROM email_suggestions")
            )
            assert (
                "PRIVATE BODY TAIL" not in stored
                and "Unmatched" not in stored
                and "Ambiguous" not in stored
            )
        assert all(
            args[2] == "(BODY.PEEK[]<0.16384>)"
            for args in server.uid_requests
            if args[0] == "FETCH"
        )
        assert server.uid_requests[-2] == ["SEARCH", "UID", "8:*"]
        server.drop_on_login = True
        check()
        transport_state = client.get("/api/email").json()["state"]
        server.drop_on_login, server.allow_login = False, False
        check()
        assert (transport_state, client.get("/api/email").json()["state"]) == (
            "connected",
            "expired",
        )
        with closing(connect(db_path)) as db, db:
            db.execute(
                "INSERT INTO email_dedup VALUES ('account','message',1,'ignored')"
            )
        client.delete("/api/email")
        with closing(connect(db_path)) as db:
            assert all(
                db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
                for table in ("email_suggestions", "email_dedup", "email_checks")
            )
