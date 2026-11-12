"""Dashboard appearance, shared with Joule Fill, and observable connection signals."""

import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal

from fastapi import APIRouter, Request

from joule.config import StrictModel

router = APIRouter()


class Appearance(StrictModel):
    theme: Literal["system", "light", "dark"] = "system"
    density: Literal["compact", "comfortable"] = "compact"


@router.get("/api/appearance")
def get_appearance(request: Request):
    path = request.app.state.data_dir / "appearance.json"
    return (
        Appearance.model_validate_json(path.read_text())
        if path.exists()
        else Appearance()
    )


@router.put("/api/appearance")
def set_appearance(request: Request, body: Appearance):
    directory = request.app.state.data_dir
    # tempfile provides unique writers; Path.replace atomically publishes a complete file.
    # https://docs.python.org/3.13/library/tempfile.html#tempfile.NamedTemporaryFile
    with NamedTemporaryFile(mode="w", dir=directory, delete=False) as file:
        file.write(body.model_dump_json() + "\n")
    Path(file.name).replace(directory / "appearance.json")
    return body


@router.get("/api/connections")
def connections(request: Request):
    telegram = request.app.state.telegram
    latest = max(
        (request.app.state.data_dir / "traces").glob("*.json"),
        key=lambda path: path.stat().st_mtime_ns,
        default=None,
    )
    stamp = None
    if latest:
        try:
            stamp = json.loads(latest.read_text())["recorded_at"]
        except (OSError, ValueError, KeyError):
            pass
    return {
        "telegram": {
            "configured": telegram is not None,
            "awaiting_reply": telegram is not None and telegram.awaiting is not None,
        },
        # A diagnostic trace is evidence of a Fill, not an installation or heartbeat.
        "extension": {"last_fill_at": stamp},
    }
