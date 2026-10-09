import httpx

from joule.sources import Candidate

JOBS_URL = "https://freehire.me/api/v1/agent/jobs/search"


async def search(client: httpx.AsyncClient, roles: list[str]) -> list[Candidate]:
    candidates = {}
    for role in roles:
        response = await client.get(
            JOBS_URL,
            params={
                "q": role,
                "countries": "us",
                "description_format": "markdown",
                "sort": "posted_at",
                "order": "desc",
                "limit": 100,
            },
        )
        response.raise_for_status()
        for node in response.json()["data"]:
            id = node["public_slug"]
            if id not in candidates:
                cities, countries = (
                    node.get("cities") or [],
                    node.get("countries") or [],
                )
                mode = node.get("work_mode")
                candidates[id] = Candidate(
                    source="freehire",
                    source_id=id,
                    link=node["url"],
                    title=node["title"],
                    company=node.get("company"),
                    description=node.get("description"),
                    location_raw=node.get("location"),
                    remote={"remote": True, "hybrid": False, "onsite": False}.get(mode),
                    arrangement=mode if mode in {"hybrid", "onsite"} else None,
                    city=cities[0] if len(cities) == 1 else None,
                    country=countries[0] if len(countries) == 1 else None,
                    posted_at=node.get("posted_at"),
                )
    return list(candidates.values())
