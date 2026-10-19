"""Bounded, local Fill diagnostics; never accept answer values or raw errors."""

import json
import os
import re
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from fastapi import APIRouter, Request
from pydantic import Field, field_validator

from joule.config import StrictModel

router = APIRouter(prefix="/api/fill")


class TraceField(StrictModel):
    ref: tuple[int, int]
    selector: str = Field(max_length=2000)
    label: str = Field(max_length=300)
    type: str = Field(max_length=100)
    action: Literal["set", "ask", "leave", "upload"]
    outcome: Literal["written", "preserved", "not-written", "skipped", "error"]
    error: Literal["apply-failed", "frame-unavailable"] | None
    before: bool | None
    after: bool | None
    signals: list[
        Literal[
            "native-value-missing",
            "aria-invalid",
            "required-error",
            "required-empty",
            "value-lost",
            "field-detached",
            "submit-native-value-missing",
            "submit-native-invalid",
            "submit-aria-invalid",
            "submit-required-error",
            "submit-validation-error",
            "submit-field-unavailable",
        ]
    ] = Field(max_length=12)


class SubmitValidation(StrictModel):
    status: Literal[
        "clicked",
        "no-submit-control",
        "ambiguous-submit-control",
        "submit-click-failed",
    ]
    network_blocked: Literal[True]
    blocked_requests: int = Field(ge=0)


class FillTrace(StrictModel):
    version: Literal[1]
    url: str = Field(max_length=8000)
    job_id: int | None = Field(default=None, gt=0)
    fields: list[TraceField] = Field(max_length=200)
    errors: list[str] = Field(max_length=200)
    validation: SubmitValidation | None = None

    @field_validator("url")
    @classmethod
    def public_url(cls, value):
        url = urlsplit(value)
        if url.scheme not in ("http", "https") or not url.hostname:
            raise ValueError("Expected an application form URL")
        return urlunsplit((url.scheme, url.netloc.rsplit("@", 1)[-1], url.path, "", ""))

    @field_validator("errors")
    @classmethod
    def frame_errors(cls, values):
        if any(
            v != "fill-failed"
            and not re.fullmatch(r"frame-\d+-(?:trace-unavailable|unavailable)", v)
            for v in values
        ):
            raise ValueError("Expected a frame error category")
        return values


@router.post("/traces")
def save_trace(request: Request, body: FillTrace):
    directory = request.app.state.data_dir / "traces"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    now = datetime.now(UTC)
    name = f"{now:%Y%m%dT%H%M%S}-{uuid4().hex}.json"
    payload = {**body.model_dump(), "recorded_at": now.isoformat()}
    # Exclusive open provides unique private files; JSON itself has no file sink.
    # https://docs.python.org/3.12/library/os.html#os.open
    fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return {"file": str(directory / name)}
