import httpx

from joule.sources import Candidate

JOBS_URL = "https://mvjyjzestmcxxmmmakec.supabase.co/rest/v1/jobs"
# Public browser anon key, published by job-ops' Golang Jobs extractor.
ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12anlqemVzdG1jeHhtbW1ha2VjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDM2NDMyNzksImV4cCI6MjA1OTIxOTI3OX0."
    "AEucvhTZofaPFnPmnCMM2ptuE3Iy06_uao4n-6AmEgM"
)


async def search(client: httpx.AsyncClient) -> list[Candidate]:
    candidates = {}
    for offset in range(0, 2000, 200):
        response = await client.get(
            JOBS_URL,
            headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
            params={
                "select": "id,title,company,application_url,slug,posted_at,description,cities(name,country)",
                "is_archived": "eq.false",
                "order": "posted_at.desc",
                "limit": 200,
                "offset": offset,
            },
        )
        response.raise_for_status()
        nodes = response.json()
        for node in nodes:
            city = node.get("cities") or {}
            name, country = city.get("name"), city.get("country")
            id = node["id"]
            if id not in candidates:
                candidates[id] = Candidate(
                    source="golangjobs",
                    source_id=id,
                    link=f"https://www.golangjobs.tech/golang-jobs/{node['slug']}",
                    title=node["title"],
                    company=node.get("company"),
                    description=node.get("description"),
                    posted_at=node.get("posted_at"),
                    city=None if name in {"Remote", "Global"} else name,
                    country=country,
                    location_raw=", ".join(value for value in (name, country) if value)
                    or None,
                    remote=True if name in {"Remote", "Global"} else None,
                    extra={"application_url": node.get("application_url")},
                )
        if len(nodes) < 200:
            break
    return list(candidates.values())
