import os
from pathlib import Path
from typing import Literal

import yaml
from dotenv import dotenv_values
from pydantic import BaseModel, ConfigDict, Field


def data_dir() -> Path:
    return Path(os.environ.get("JOULE_DATA_DIR", "~/.joule")).expanduser()


def load_env(data_dir: Path) -> dict[str, str]:
    values = dotenv_values(data_dir / ".env")
    return {
        key: os.environ.get(key, value)
        for key, value in values.items()
        if value is not None or key in os.environ
    }


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Schedule(StrictModel):
    upwork_minutes: int | None = 15


class Upwork(StrictModel):
    scoring: bool = True
    retention_hours: int = 24


class Model(StrictModel):
    provider: Literal["anthropic", "openai", "ollama"]
    model: str


class Models(StrictModel):
    scoring: Model = Field(
        default_factory=lambda: Model(
            provider="anthropic", model="claude-haiku-4-5-20251001"
        )
    )
    drafts: Model = Field(
        default_factory=lambda: Model(provider="anthropic", model="claude-sonnet-5-5")
    )
    ollama_base_url: str | None = None


class Settings(StrictModel):
    sources: list[
        Literal["hn", "weworkremotely", "remoteok", "web3career", "indeed", "upwork"]
    ] = Field(default_factory=lambda: ["hn", "weworkremotely", "remoteok", "upwork"])
    schedule: Schedule = Field(default_factory=Schedule)
    upwork: Upwork = Field(default_factory=Upwork)
    models: Models = Field(default_factory=Models)
    alert_threshold: int = 75
    max_scored_per_scan: int = 100
    results_per_search: int = 50
    max_age_days: int = 14
    source_timeout_seconds: int = 120


def load_settings(data_dir: Path) -> Settings:
    path = data_dir / "settings.yaml"
    if not path.exists():
        return Settings()
    with path.open() as file:
        values = yaml.safe_load(file)
    return Settings.model_validate({} if values is None else values)
