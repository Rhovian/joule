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
    provider: Literal["codex"]
    model: str | None = None


class Models(StrictModel):
    scoring: Model = Field(
        default_factory=lambda: Model(provider="codex", model="gpt-6-luna")
    )
    drafts: Model = Field(default_factory=lambda: Model(provider="codex"))


class Settings(StrictModel):
    sources: list[
        Literal[
            "hn",
            "weworkremotely",
            "remoteok",
            "web3career",
            "indeed",
            "upwork",
            "hotfix",
            "getarustjob",
            "adzuna",
        ]
    ] = Field(
        default_factory=lambda: [
            "hn",
            "weworkremotely",
            "remoteok",
            "upwork",
            "hotfix",
            "getarustjob",
        ]
    )
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


class Pay(StrictModel):
    salary_floor: float | None = None
    currency: str | None = None
    hourly_floor: float | None = None
    fixed_floor: float | None = None


class Remote(StrictModel):
    ok: bool = True
    countries: list[str] = []
    timezones: list[str] = []


class City(StrictModel):
    city: str
    country: str
    arrangements: list[Literal["onsite", "hybrid"]] = ["onsite", "hybrid"]


class Locations(StrictModel):
    remote: Remote = Field(default_factory=Remote)
    cities: list[City] = []
    aliases: dict[str, str] = {}


class DealBreakers(StrictModel):
    keywords: list[str] = []
    companies: list[str] = []
    industries: list[str] = []


class UpworkClient(StrictModel):
    min_spend: float | None = None
    min_hire_rate: float | None = None
    payment_verified: bool = False


class Preferences(StrictModel):
    roles: list[str]
    seniority: str | None = None
    work_types: list[Literal["full-time", "contract", "freelance"]] = []
    pay: Pay = Field(default_factory=Pay)
    locations: Locations = Field(default_factory=Locations)
    deal_breakers: DealBreakers = Field(default_factory=DealBreakers)
    upwork_client: UpworkClient = Field(default_factory=UpworkClient)
    scoring_notes: str | None = None
    work_history_path: Path | None = None


def load_preferences(data_dir: Path) -> Preferences:
    with (data_dir / "profile" / "preferences.yaml").open() as file:
        values = yaml.safe_load(file)
    return Preferences.model_validate({} if values is None else values)
