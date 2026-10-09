import asyncio
import base64
import hashlib
import json
import stat
import time
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient

from joule.app import create_app
from joule.upwork_auth import UpworkNotConnected

TOKEN = {"access_token": "access", "refresh_token": "refresh", "expires_in": 3600}
REDIRECT = "http://localhost:8000/auth/upwork/callback"


@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text(
        f"UPWORK_CLIENT_ID=client\nUPWORK_CLIENT_SECRET=secret\nUPWORK_REDIRECT_URI={REDIRECT}\n"
    )
    for key in ("UPWORK_CLIENT_ID", "UPWORK_CLIENT_SECRET", "UPWORK_REDIRECT_URI"):
        monkeypatch.delenv(key, raising=False)
    requests = []
    replies = [httpx.Response(200, json=TOKEN)]

    async def respond(request):
        requests.append(request)
        await asyncio.sleep(0)
        return replies[0]

    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs),
    )
    with TestClient(
        create_app(tmp_path), base_url="http://localhost", follow_redirects=False
    ) as browser:
        browser.requests, browser.replies = requests, replies
        yield browser


def test_connect(client):
    response = client.get("/auth/upwork/connect")
    state, verifier = client.cookies["upwork_oauth"].split(".")
    url = urlparse(response.headers["location"])
    query = parse_qs(url.query)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    assert response.status_code == 302
    assert query["client_id"] == ["client"] and query["redirect_uri"] == [REDIRECT]
    assert query["state"] == [state] and query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"] == [challenge.decode().rstrip("=")]
    (client.app.state.data_dir / ".env").unlink()
    response = client.get("/auth/upwork/connect")
    assert response.status_code == 503
    assert response.json()["detail"] == "Upwork not configured"


@pytest.mark.parametrize("query", ["state=x&code=c", "error=access_denied", "state=x"])
def test_invalid_callback(client, query):
    assert client.get(f"/auth/upwork/callback?{query}").status_code == 400
    client.get("/auth/upwork/connect")
    response = client.get(f"/auth/upwork/callback?{query}")
    assert response.status_code == 400
    if "error=" in query:
        assert response.json()["detail"] == "access_denied"
    assert not client.requests


@pytest.mark.parametrize("failure", [None, 500])
def test_callback(client, failure):
    auth = client.app.state.upwork_auth
    assert client.get("/api/upwork/status").json() == {"connected": False}
    client.get("/auth/upwork/connect")
    state, verifier = client.cookies["upwork_oauth"].split(".")
    if failure:
        client.replies[0] = httpx.Response(failure, text="private body")
    before = time.time()
    response = client.get(f"/auth/upwork/callback?state={state}&code=code")
    request = client.requests[0]
    form = parse_qs(request.content.decode())
    assert form["code_verifier"] == [verifier] and form["redirect_uri"] == [REDIRECT]
    assert request.headers["user-agent"] == "joule/0.1"
    assert form["grant_type"] == ["authorization_code"] and form["code"] == ["code"]
    if failure:
        assert response.status_code == 502
        assert "private" not in response.text
        assert not auth.path.exists()
        return
    assert response.status_code == 303 and response.headers["location"] == "/"
    assert "Max-Age=0" in response.headers["set-cookie"]
    assert "upwork_oauth" not in client.cookies
    token = json.loads(auth.path.read_text())
    assert before + 3600 <= token["expires_at"] <= time.time() + 3600
    assert token["access_token"] == "access" and token["refresh_token"] == "refresh"
    assert stat.S_IMODE(auth.path.stat().st_mode) == 0o600
    assert client.get("/api/upwork/status").json() == {"connected": True}


@pytest.mark.parametrize("expiry", [3600, 0])
def test_access_token_and_concurrent_refresh(client, expiry):
    auth = client.app.state.upwork_auth
    client.portal.call(auth.save, {**TOKEN, "expires_in": expiry})
    client.replies[0] = httpx.Response(
        200, json={"access_token": "new", "expires_in": 3600}
    )

    async def concurrent():
        return await asyncio.gather(auth.access_token(), auth.access_token())

    assert client.portal.call(concurrent) == ["access" if expiry else "new"] * 2
    assert len(client.requests) == (0 if expiry else 1)
    assert json.loads(auth.path.read_text())["refresh_token"] == "refresh"


def test_refresh_failure(client):
    auth = client.app.state.upwork_auth
    with pytest.raises(UpworkNotConnected):
        client.portal.call(auth.access_token)
    client.portal.call(auth.save, {**TOKEN, "expires_in": 0})
    client.replies[0] = httpx.Response(400)
    with pytest.raises(UpworkNotConnected):
        client.portal.call(auth.access_token)
    assert not auth.path.exists()


def test_missing_credentials(client):
    client.get("/auth/upwork/connect")
    state, _ = client.cookies["upwork_oauth"].split(".")
    auth = client.app.state.upwork_auth
    client.portal.call(auth.save, {**TOKEN, "expires_in": 0})
    (auth.data_dir / ".env").unlink()
    with pytest.raises(UpworkNotConnected, match="Upwork not configured"):
        client.portal.call(auth.access_token)
    response = client.get(f"/auth/upwork/callback?state={state}&code=code")
    assert response.status_code == 503
    assert response.json()["detail"] == "Upwork not configured"
