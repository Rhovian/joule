import asyncio

import jobspy
import pandas as pd

from joule.config import Preferences
from joule.sources import Candidate


def _candidate(site: str, row: dict) -> Candidate:
    row = {key: None if pd.isna(value) else value for key, value in row.items()}
    posted = row.get("date_posted")
    return Candidate(
        source=site,
        source_id=row["id"],
        link=row["job_url"],
        title=row["title"],
        company=row.get("company"),
        description=row.get("description"),
        location_raw=row.get("location"),
        remote=row.get("is_remote"),
        pay_min=row.get("min_amount"),
        pay_max=row.get("max_amount"),
        pay_currency=row.get("currency"),
        pay_period={"yearly": "year", "hourly": "hour"}.get(row.get("interval")),
        posted_at=pd.to_datetime(posted, utc=True).to_pydatetime() if posted else None,
    )


async def search(site: str, preferences: Preferences, results: int) -> list[Candidate]:
    locations = [
        (f"{c.city}, {c.country}", False) for c in preferences.locations.cities
    ]
    if preferences.locations.remote.ok:
        locations.append((None, True))
    candidates = {}
    for role in preferences.roles:
        for location, remote in locations:
            data = await asyncio.to_thread(
                jobspy.scrape_jobs,
                site_name=[site],
                search_term=role,
                location=location,
                is_remote=remote,
                results_wanted=results,
                country_indeed="USA",
                fetch_description=True,
            )
            for row in data.to_dict("records"):
                if row["id"] not in candidates:
                    candidates[row["id"]] = _candidate(site, row)
    return list(candidates.values())
