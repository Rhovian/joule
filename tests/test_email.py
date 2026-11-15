import json
from stat import S_IMODE

from fastapi.testclient import TestClient

from joule.app import create_app
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
