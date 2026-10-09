import httpx

from joule.sources import Candidate

JOBS_URL = "https://www.workingnomads.com/jobsapi/_search"


async def search(client: httpx.AsyncClient, roles: list[str]) -> list[Candidate]:
    candidates = {}
    for role in roles:
        query = {"query": f'"{role}"', "fields": ["title^2", "description", "company"]}
        locations = {"locations": ["USA", "North America", "Anywhere"]}
        response = await client.post(
            JOBS_URL,
            json={
                "size": 100,
                "from": 0,
                "sort": [
                    {"premium": {"order": "desc"}},
                    {"pub_date": {"order": "desc"}},
                ],
                "min_score": 2,
                "query": {
                    "bool": {
                        "must": [{"query_string": query}],
                        "filter": [{"terms": locations}],
                    }
                },
            },
        )
        response.raise_for_status()
        for hit in response.json()["hits"]["hits"]:
            node = hit["_source"]
            id = str(node["id"])
            if id not in candidates:
                candidates[id] = Candidate(
                    source="workingnomads",
                    source_id=id,
                    link=f"https://www.workingnomads.com/jobs/{node['slug']}",
                    title=node["title"],
                    company=node.get("company"),
                    description=node.get("description"),
                    location_raw="; ".join(node.get("locations") or []) or None,
                    remote=True,
                    posted_at=node.get("pub_date"),
                )
    return list(candidates.values())
