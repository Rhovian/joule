"""Dashboard appearance, shared with Joule Fill, and observable connection signals."""

import json
import logging
from contextlib import closing
from typing import Literal

import yaml
from fastapi import APIRouter, HTTPException, Request

from joule.config import StrictModel, load_preferences
from joule.db import connect
from joule.files import atomic_write

router = APIRouter()
logger = logging.getLogger(__name__)


class Appearance(StrictModel):
    theme: Literal["system", "light", "dark"] = "system"
    density: Literal["compact", "comfortable"] = "compact"


@router.get("/api/appearance")
def get_appearance(request: Request):
    path = request.app.state.data_dir / "appearance.json"
    try:
        return Appearance.model_validate_json(path.read_text())
    except (OSError, ValueError) as error:
        if not isinstance(error, FileNotFoundError):
            logger.warning(
                "Using default appearance: %s (%s)", path, type(error).__name__
            )
        return Appearance()


@router.put("/api/appearance")
def set_appearance(request: Request, body: Appearance):
    atomic_write(
        request.app.state.data_dir / "appearance.json", body.model_dump_json() + "\n"
    )
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


@router.get("/api/rules")
def filtered_rules(request: Request):
    directory = request.app.state.data_dir
    path = directory / "profile" / "preferences.yaml"
    try:
        values = load_preferences(directory).model_dump(mode="json")
    except FileNotFoundError:
        values = {}
    except (OSError, ValueError, yaml.YAMLError) as error:
        raise HTTPException(422, "Cannot read profile/preferences.yaml") from error
    rules = [
        {
            "key": key,
            "label": label,
            "scope": scope,
            "values": values.get(field),
            "count": 0,
        }
        for key, field, label, scope in (
            ("deal_breaker", "deal_breakers", "Deal-breakers", "all Sources"),
            ("work_type", "work_types", "Work type", "Upwork only"),
            ("pay", "pay", "Pay floor", "all Sources"),
            ("location", "locations", "Location", "all Sources"),
            ("upwork_client", "upwork_client", "Upwork client floors", "Upwork only"),
        )
    ]
    other = {
        "key": "other",
        "label": "Other stored reasons",
        "scope": "all Sources",
        "values": "Unrecognised or legacy reasons",
        "count": 0,
    }
    by_key = {row["key"]: row for row in rules}
    with closing(connect(directory / "joule.db")) as db:
        for row in db.execute(
            "SELECT filtered_reason, COUNT(*) AS n FROM jobs WHERE primary_id IS NULL AND filtered_reason IS NOT NULL GROUP BY filtered_reason"
        ):
            # Current cheap filters store one first-failing prefix; never guess legacy prose.
            target = by_key.get(row["filtered_reason"].partition(":")[0], other)
            target["count"] += row["n"]
    if other["count"]:
        rules.append(other)
    return {
        "path": str(path.resolve()),
        "rules": rules,
        "total": sum(row["count"] for row in rules),
    }
