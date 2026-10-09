import asyncio
import json
from datetime import UTC, date, datetime

import pandas as pd

from joule.config import Preferences
from joule.sources import Candidate, jobspy


def test_search_fanout(monkeypatch):
    calls = []

    def scrape(**kwargs):
        calls.append(kwargs)
        return pd.DataFrame()

    monkeypatch.setattr(jobspy.jobspy, "scrape_jobs", scrape)
    preferences = Preferences(
        roles=["Role"], locations={"cities": [{"city": "Boise", "country": "US"}]}
    )
    assert asyncio.run(jobspy.search("indeed", preferences, 17)) == []
    common = {
        "site_name": ["indeed"],
        "search_term": "Role",
        "results_wanted": 17,
        "country_indeed": "USA",
        "linkedin_fetch_description": True,
    }
    assert calls == [
        common | {"location": "Boise, US", "is_remote": False},
        common | {"location": None, "is_remote": True},
    ]


def test_row_mapping(monkeypatch):
    row = json.loads("""{
        "id": "1", "job_url": "https://example.com/job", "title": "Role",
        "company": "Example", "description": "Description", "location": "Boise, ID, US",
        "city": "Boise", "state": "ID", "country": "US", "is_remote": true,
        "min_amount": 30, "max_amount": 50, "currency": "USD", "interval": "yearly"
    }""") | {"date_posted": date(2026, 10, 8)}
    blank = {
        key: float("nan")
        for key in row
        if key not in {"id", "job_url", "title", "interval", "date_posted"}
    }
    frames = iter(
        [
            pd.DataFrame([row]),
            pd.DataFrame(
                [
                    row | {"title": "Later duplicate"},
                    row | {"id": "2", "interval": "hourly", "location": None},
                    row
                    | blank
                    | {"id": "3", "interval": "monthly", "date_posted": pd.NaT},
                ]
            ),
        ]
    )
    monkeypatch.setattr(jobspy.jobspy, "scrape_jobs", lambda **kwargs: next(frames))
    jobs = asyncio.run(jobspy.search("indeed", Preferences(roles=["one", "two"]), 50))
    expected = json.loads("""{
        "source": "indeed", "source_id": "1", "link": "https://example.com/job",
        "title": "Role", "company": "Example", "description": "Description",
        "location_raw": "Boise, ID, US", "city": "Boise", "country": "US", "remote": true,
        "pay_min": 30, "pay_max": 50, "pay_currency": "USD", "pay_period": "year",
        "arrangement": null, "extra": {}
    }""") | {"posted_at": datetime(2026, 10, 8, tzinfo=UTC)}
    unknown = Candidate(
        source="indeed", source_id="3", link=row["job_url"], title="Role"
    )
    assert [job.model_dump() for job in jobs] == [
        expected,
        expected | {"source_id": "2", "pay_period": "hour"},
        unknown.model_dump(),
    ]
