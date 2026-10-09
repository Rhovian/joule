from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class Candidate(BaseModel):
    source: str
    source_id: str
    link: str
    title: str
    company: str | None = None
    description: str | None = None
    location_raw: str | None = None
    remote: bool | None = None
    city: str | None = None
    country: str | None = None
    arrangement: str | None = None
    pay_min: float | None = None
    pay_max: float | None = None
    pay_currency: str | None = None
    pay_period: Literal["hour", "year", "fixed"] | None = None
    posted_at: datetime | None = None
    extra: dict = Field(default_factory=dict)


BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36"
)
