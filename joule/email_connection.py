"""Validate and store an IMAP connection; never fetch mail or alter a Job."""

import base64
import imaplib
import json
import re
import ssl
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, HTTPException, Request
from pydantic import Field, SecretStr

from joule.config import StrictModel
from joule.files import atomic_write

router = APIRouter(prefix="/api/email")


class EmailConfig(StrictModel):
    inbox: Literal["gmail", "imap"] = "gmail"
    host: str = Field(default="imap.gmail.com", pattern=r"^[a-zA-Z0-9.:-]+$")
    port: int = Field(default=993, ge=1, le=65535)
    tls: bool = True
    username: str = Field(min_length=1, max_length=320, pattern=r"^[^\r\n\x00]+$")
    password: SecretStr | None = None
    scope: Literal["pipeline", "folder"] = "pipeline"
    folder: str = Field(
        default="INBOX", min_length=1, max_length=200, pattern=r"^[^\r\n\x00]+$"
    )
    check_minutes: int | None = Field(default=15, ge=1)


def mailbox_name(value):
    # select() leaves wire-name encoding to callers: cpython v3.13.7/Lib/imaplib.py.
    # Modified UTF-7: https://www.rfc-editor.org/rfc/rfc3501#section-5.1.3
    return re.sub(
        r"[^ -~]+|&",
        lambda match: (
            "&-"
            if match[0] == "&"
            else "&"
            + base64.b64encode(match[0].encode("utf-16-be"))
            .decode()
            .rstrip("=")
            .replace("/", ",")
            + "-"
        ),
        value,
    )


class EmailConnection:
    def __init__(self, directory: Path):
        self.path = directory / "email.json"
        self.auth_failed = False

    def load(self):
        try:
            return EmailConfig.model_validate_json(self.path.read_text())
        except FileNotFoundError:
            return None
        except (OSError, ValueError):
            raise HTTPException(
                503, "Saved email settings are unreadable. Reconnect or disconnect."
            ) from None

    def status(self):
        saved = self.load()
        return {
            "state": "not_connected"
            if saved is None
            else "expired"
            if self.auth_failed
            else "connected",
            "config": saved.model_dump(mode="json", exclude={"password"})
            if saved
            else None,
        }

    def validate(self, config, *, saved_password=False):
        context = ssl.create_default_context()
        try:
            client = (
                imaplib.IMAP4_SSL(
                    config.host, config.port, ssl_context=context, timeout=10
                )
                if config.tls
                else imaplib.IMAP4(config.host, config.port, timeout=10)
            )
            with client:
                if not config.tls:
                    client.starttls(ssl_context=context)
                try:
                    # imaplib quotes the password, but not LOGIN's username or EXAMINE's folder.
                    # https://github.com/python/cpython/blob/v3.13.7/Lib/imaplib.py
                    client.login(
                        client._quote(config.username),
                        config.password.get_secret_value(),
                    )
                except imaplib.IMAP4.abort:
                    raise
                except imaplib.IMAP4.error:
                    if saved_password:
                        self.auth_failed = True
                    raise HTTPException(
                        401, "Sign-in failed. Check your username and app password."
                    ) from None
                try:
                    result, _ = client.select(
                        client._quote(mailbox_name(config.folder)), readonly=True
                    )
                    if result != "OK":
                        raise imaplib.IMAP4.error()
                except imaplib.IMAP4.abort:
                    raise
                except (imaplib.IMAP4.error, UnicodeError):
                    raise HTTPException(
                        400, "Could not open that folder. Check its name and access."
                    ) from None
        except (OSError, imaplib.IMAP4.error, UnicodeError):
            raise HTTPException(
                502,
                "Could not connect securely. Check the host, port and TLS certificate.",
            ) from None

    def save(self, body):
        config = body.model_copy(
            update={
                **(
                    {"host": "imap.gmail.com", "port": 993, "tls": True}
                    if body.inbox == "gmail"
                    else {}
                ),
                "folder": "INBOX" if body.scope == "pipeline" else body.folder,
            }
        )
        reused = config.password is None or not config.password.get_secret_value()
        if reused:
            saved = self.load()
            if saved is None or any(
                getattr(saved, key) != getattr(config, key)
                for key in ("inbox", "host", "port", "tls", "username")
            ):
                raise HTTPException(400, "Enter an app password for this connection.")
            config.password = saved.password
        if config.password is None or any(
            c in config.password.get_secret_value() for c in "\r\n\x00"
        ):
            raise HTTPException(400, "Enter a valid app password.")
        self.validate(config, saved_password=reused)
        document = config.model_dump(mode="json", exclude={"password"}) | {
            "password": config.password.get_secret_value()
        }
        # atomic_write uses tempfile's private (0600) file before atomic replacement.
        atomic_write(self.path, json.dumps(document) + "\n")
        self.auth_failed = False
        return self.status()


@router.get("")
def status(request: Request):
    return request.app.state.email.status()


@router.put("")
def connect(request: Request, body: Annotated[Any, Body()]):
    # FastAPI's default validation errors include raw input, which may be a password.
    try:
        config = EmailConfig.model_validate(body)
    except ValueError:
        raise HTTPException(
            422, "Invalid email connection settings. Check the fields."
        ) from None
    return request.app.state.email.save(config)


@router.delete("")
def disconnect(request: Request):
    connection = request.app.state.email
    connection.path.unlink(missing_ok=True)
    connection.auth_failed = False
    return connection.status()
