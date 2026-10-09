import httpx

from joule.sources import Candidate

JOBS_URL = "https://api.adzuna.com/v1/api/jobs/us/search/1"


class AdzunaError(Exception):
    pass


async def search(
    client: httpx.AsyncClient, roles: list[str], app_id: str | None, app_key: str | None
) -> list[Candidate]:
    if not app_id or not app_key:
        raise AdzunaError("ADZUNA_APP_ID and ADZUNA_APP_KEY are required")
    candidates = {}
    for role in roles:
        try:
            response = await client.get(
                JOBS_URL,
                headers={"Accept": "application/json"},
                params={
                    "app_id": app_id,
                    "app_key": app_key,
                    "what": role,
                    "results_per_page": 50,
                },
            )
        except httpx.RequestError:
            raise AdzunaError("Adzuna request failed") from None
        if not response.is_success:
            raise AdzunaError(f"Adzuna HTTP {response.status_code}")
        for node in response.json()["results"]:
            id = str(node["id"])
            if id in candidates:
                continue
            predicted = str(node.get("salary_is_predicted")) == "1"
            low, high = node.get("salary_min") or None, node.get("salary_max") or None
            candidates[id] = Candidate(
                source="adzuna",
                source_id=id,
                link=node["redirect_url"],
                title=node["title"],
                company=(node.get("company") or {}).get("display_name"),
                description=node.get("description"),
                location_raw=(node.get("location") or {}).get("display_name"),
                posted_at=node.get("created"),
                pay_min=None if predicted else low,
                pay_max=None if predicted else high,
                pay_currency="USD" if not predicted and (low or high) else None,
                extra={
                    key: node.get(key)
                    for key in ("salary_is_predicted", "salary_min", "salary_max")
                },
            )
    return list(candidates.values())
