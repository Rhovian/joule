import asyncio
import base64
import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse

from joule.config import load_env

AUTHORIZE_URL = "https://www.upwork.com/ab/account-security/oauth2/authorize"
TOKEN_URL = "https://www.upwork.com/api/v3/oauth2/token"
COOKIE_PATH = "/auth/upwork"
router = APIRouter()


class UpworkNotConnected(Exception):
    pass


def credentials(data_dir: Path) -> dict[str, str]:
    env = load_env(data_dir)
    keys = ("client_id", "client_secret", "redirect_uri")
    if not all(env.get(f"UPWORK_{key.upper()}") for key in keys):
        raise UpworkNotConnected("Upwork not configured")
    return {key: env[f"UPWORK_{key.upper()}"] for key in keys}


class UpworkAuth:
    def __init__(self, data_dir: Path, client: httpx.AsyncClient):
        self.data_dir = data_dir
        self.path = data_dir / "upwork-token.json"
        self.client = client
        self.lock = asyncio.Lock()

    def _save(self, token_response: dict):
        token = {
            "access_token": token_response["access_token"],
            "refresh_token": token_response["refresh_token"],
            "expires_at": time.time() + float(token_response["expires_in"]),
        }
        temporary = self.path.with_name(f".upwork-token-{secrets.token_hex(16)}.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w") as file:
                json.dump(token, file)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    async def save(self, token_response: dict):
        async with self.lock:
            self._save(token_response)

    async def access_token(self) -> str:
        async with self.lock:
            if not self.path.exists():
                raise UpworkNotConnected
            token = json.loads(self.path.read_text())
            if token["expires_at"] - time.time() > 300:
                return token["access_token"]
            config = credentials(self.data_dir)
            response = await self.client.post(
                TOKEN_URL,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": token["refresh_token"],
                    "client_id": config["client_id"],
                    "client_secret": config["client_secret"],
                },
            )
            if response.status_code in (400, 401) and "invalid_grant" in response.text:
                self.path.unlink()
                raise UpworkNotConnected
            response.raise_for_status()
            refreshed = response.json()
            refreshed.setdefault("refresh_token", token["refresh_token"])
            self._save(refreshed)
            return refreshed["access_token"]


@router.get("/auth/upwork/connect")
async def connect(request: Request):
    config = credentials(request.app.state.data_dir)
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    response = RedirectResponse(
        AUTHORIZE_URL
        + "?"
        + urlencode(
            {
                "response_type": "code",
                "client_id": config["client_id"],
                "redirect_uri": config["redirect_uri"],
                "state": state,
                "code_challenge": challenge.decode().rstrip("="),
                "code_challenge_method": "S256",
            }
        ),
        status_code=302,
    )
    response.set_cookie(
        "upwork_oauth",
        f"{state}.{verifier}",
        httponly=True,
        samesite="lax",
        path=COOKIE_PATH,
        max_age=600,
        secure=config["redirect_uri"].startswith("https://"),
    )
    return response


@router.get("/auth/upwork/callback")
async def callback(request: Request):
    query = request.query_params
    if "error" in query:
        raise HTTPException(400, query["error"])
    cookie = request.cookies.get("upwork_oauth", "")
    state, separator, verifier = cookie.partition(".")
    if (
        not separator
        or not verifier
        or not secrets.compare_digest(state.encode(), query.get("state", "").encode())
        or not query.get("code")
    ):
        raise HTTPException(400, "Invalid Upwork callback")
    auth = request.app.state.upwork_auth
    config = credentials(auth.data_dir)
    try:
        response = await auth.client.post(
            TOKEN_URL,
            data={
                **config,
                "grant_type": "authorization_code",
                "code": query["code"],
                "code_verifier": verifier,
            },
        )
        response.raise_for_status()
        token = response.json()
        await auth.save(token)
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        raise HTTPException(502, "Upwork token exchange failed") from None
    redirect = RedirectResponse("/", status_code=303)
    redirect.delete_cookie("upwork_oauth", path=COOKIE_PATH)
    return redirect


@router.get("/api/upwork/status")
async def status(request: Request):
    return {"connected": request.app.state.upwork_auth.path.exists()}
