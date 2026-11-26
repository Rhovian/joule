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
from joule.email_suggestions import match, metadata
from joule.pipeline import MoveRequest, move
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


def test_email_rejections_and_informational_mail_preserve_history_and_dedup(
    tmp_path, monkeypatch
):
    def message(subject, sender="Acme Talent <talent@acme.com>", old=False, body=None):
        mail = EmailMessage()
        mail["From"], mail["Subject"], mail["Message-ID"] = (
            sender,
            subject,
            f"<{subject.replace(' ', '-')}@fixture>",
        )
        mail["Date"] = datetime(2000, 1, 1, tzinfo=UTC) if old else datetime.now(UTC)
        mail.set_content(
            body
            or "Intro call on Friday. "
            + "x" * 200
            + "\n> quoted old message\nPRIVATE BODY TAIL",
            subtype="html" if body else "plain",
        )
        return mail.as_bytes()

    calls = []

    async def classify(model, prompt, schema):
        calls.append(prompt)
        if "Retry" in prompt and sum("Retry" in p for p in calls) == 1:
            raise ai.AIError("Provider unavailable")
        if "Invalid" in prompt:
            try:
                schema(action="invalid")
            except ValueError as error:
                raise ai.AIError("Invalid output") from error
        if "Another next step" in prompt:
            with closing(connect(db_path)) as db, db:
                move(db, 1, MoveRequest(stage="offer"))
        return schema(
            action="reject"
            if "Update" in prompt or "Another next step" in prompt
            else "received"
            if "Acknowledgement" in prompt or "Retry" in prompt
            else "none"
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
            db.execute("UPDATE jobs SET link='https://remoteok.com/role' WHERE id=4")
            db.execute("UPDATE jobs SET title='Frontend Developer' WHERE id=5")
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
            1: message("Next steps", "Acme <noreply@acme.com>"),
            2: message("Update Pinterest", "Recruiting <jobs@greenhouse.io>"),
            3: message(
                "Technical",
                "Phantom <no-reply@careers.phantom.com>",
                body="<style>" + "x" * 4500 + "</style><p>Real reply.</p>",
            ),
            4: message("Unmatched", "Other <other@elsewhere.com>"),
            5: message(
                "Update Ambiguous",
                "jobs@ambiguous.com",
                body="We will not proceed. Try our Frontend Developer role.",
            ),
            6: message("Too old", old=True),
            7: message("Newsletter", "jobs@remoteok.com"),
            8: message("Account", "accounts@accounts.acme.com"),
            9: message("Acknowledgement"),
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
        paths = client.app.openapi()["paths"]
        assert not any(path.startswith("/api/email/suggestions") for path in paths)
        with closing(connect(db_path)) as db:
            by_subject = {
                row["subject"]: dict(row)
                for row in db.execute("SELECT * FROM email_suggestions")
            }
        assert len(by_subject) == 3 and len(calls) == 5
        rejected = client.get("/api/pipeline/3").json()
        assert rejected["closed_reason"] == "rejected" and rejected["how"] == "auto"
        assert "Update Pinterest" in rejected["history"][-1]["note"]
        assert all(
            len(client.get(f"/api/pipeline/{i}").json()["history"]) == 1
            for i in (1, 2, 4, 5)
        )
        assert {
            row["job_id"]: row["email_count"]
            for row in client.get("/api/pipeline").json()
        } == {1: 1, 2: 0, 3: 1, 4: 0, 5: 1}
        received = by_subject["Acknowledgement"]
        assert json.loads(received["proposal"]) == {"action": "received"}
        assert by_subject["Update Ambiguous"]["state"] == received["state"] == "ignored"
        assert len(received["quote"]) == 140
        assert metadata(server.messages[3])[0]["quote"] == "Real reply."
        # Retire historical proposals, preserving all stored metadata and exclusions.
        with closing(connect(db_path)) as db, db:
            for identity, payload in (
                ("legacy-stage", {"stage": "screen"}),
                ("legacy-date", {"next_at": "2027-01-07T14:00:00Z"}),
            ):
                db.execute(
                    "INSERT INTO email_suggestions(account,message_id,job_id,first_move_id,move_id,folder,uid,sender_name,sender_address,subject,quote,date,proposal,state) SELECT account,?,job_id,first_move_id,move_id,folder,uid,sender_name,sender_address,subject,quote,date,?,'pending' FROM email_suggestions WHERE id=?",
                    (identity, json.dumps(payload), received["id"]),
                )
            db.execute(
                "UPDATE email_suggestions SET state='excluded' WHERE id=?",
                (received["id"],),
            )
        client.portal.call(service.check)  # Resolve even when no Scan/check is due.
        with closing(connect(db_path)) as db:
            legacy = db.execute(
                "SELECT * FROM email_suggestions WHERE message_id LIKE 'legacy-%'"
            ).fetchall()
            assert len(legacy) == 2 and all(
                row["state"] == "ignored" and row["quote"] == received["quote"]
                for row in legacy
            )
        config = service.connection.load()
        with monkeypatch.context() as account:
            account.setattr(
                service.connection,
                "load",
                lambda: config.model_copy(update={"username": "other@fixture"}),
            )
            assert not any(
                row["email_count"] for row in client.get("/api/pipeline").json()
            )
        # Reset UIDVALIDITY and redeliver the excluded Message-ID: durable exclusion wins.
        server.validity = "2"
        server.messages[10] = server.messages[2]  # Redeliver the rejection too.
        check()
        assert len(calls) == 5 and client.get("/api/pipeline/3").json() == rejected
        server.messages[11] = message("Invalid", "noreply@phantom.com")
        server.messages[12] = message("Retry", "noreply@phantom.com")
        server.messages[13] = message("Another next step")
        check()
        assert client.get("/api/pipeline/1").json()["stage"] == "offer"
        with closing(connect(db_path)) as db:
            failed = db.execute("SELECT * FROM email_dedup WHERE outcome='failed'")
            assert [tuple(row)[1:] for row in failed] == [
                ("<Invalid@fixture>", 2, "failed")
            ]
        check()
        assert len(calls) == 9
        assert client.get("/api/pipeline/1").json()["closed_reason"] is None
        client.patch("/api/jobs/3", json={"state": "seen"})
        client.patch("/api/jobs/3", json={"state": "applied"})
        check()
        assert len(client.get("/api/pipeline/3").json()["history"]) == 1
        cards = {row["job_id"]: row for row in client.get("/api/pipeline").json()}
        assert cards[3]["email_count"] == 0
        with closing(connect(db_path)) as db:
            stored = " ".join(
                str(tuple(row)) for row in db.execute("SELECT * FROM email_suggestions")
            )
            assert "PRIVATE BODY TAIL" not in stored and "Unmatched" not in stored
            assert not db.execute(
                "SELECT 1 FROM email_suggestions WHERE state='pending'"
            ).fetchone()
        assert all(
            args[2] == "(BODY.PEEK[]<0.16384>)"
            for args in server.uid_requests
            if args[0] == "FETCH"
        )
        assert ["SEARCH", "UID", "12:*"] in server.uid_requests
        server.drop_on_login = True
        check()
        transport_state = client.get("/api/email").json()["state"]
        server.drop_on_login, server.allow_login = False, False
        check()
        assert (transport_state, client.get("/api/email").json()["state"]) == (
            "connected",
            "expired",
        )
        requests = len(server.commands)
        check()
        assert len(server.commands) == requests
        client.delete("/api/email")
        with closing(connect(db_path)) as db:
            assert all(
                db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0
                for table in ("email_suggestions", "email_dedup", "email_checks")
            )


def test_email_matching_disambiguates_company_roles():
    jobs = [
        dict(id=index, title=title, company="Widget", link="https://ashbyhq.com/demo")
        for index, title in enumerate(
            [
                "Senior Software Engineer - Tools",
                "Staff Infrastructure Engineer - Storage",
                "Senior Software Engineer - Platform",
            ]
        )
    ]
    mail = EmailMessage()
    mail["From"], mail["Subject"] = (
        "no-reply@ashbyhq.com",
        "Thanks for applying to Widget!",
    )
    mail.set_content(
        "Hi Reader,\nThanks for applying to our Sr. Software Engineer - Platform role!"
    )
    fields, excerpt = metadata(mail.as_bytes())
    assert fields["quote"] == "Hi Reader,"
    for body, expected in [
        (excerpt, 2),
        ("Our SR. SOFTWARE ENG. — Platform role", 2),
        ("Hi Reader, thanks for applying!", None),
        ("Sr. Software Engineer - Platform and Senior Software Engineer - Tools", None),
        ("Sr. Software Engineer - PlatformX", None),
        ("x" * 4000 + excerpt, None),
    ]:
        result = match(
            jobs, fields["sender_address"], fields["subject"], fields["quote"], body
        )
        assert (result["id"] if result else None) == expected
    args = (fields["sender_address"], fields["subject"], fields["quote"], excerpt)
    assert match(list(reversed(jobs)), *args)["id"] == 2
    assert match(jobs + [jobs[2] | {"id": 3}], *args) is None
    assert match([jobs[0]], *args)["id"] == 0
    assert (
        match(jobs, fields["sender_address"], "Thanks!", "Hi Reader,", excerpt) is None
    )
