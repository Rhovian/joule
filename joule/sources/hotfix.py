import httpx

from joule.sources import Candidate

JOBS_URL = "https://rest.hotfix.jobs/v1/jobs"


class HotfixError(Exception):
    pass


async def _get(client: httpx.AsyncClient, url: str, **kwargs) -> dict:
    response = await client.get(url, **kwargs)
    if not response.is_success:
        raise HotfixError(response.status_code)
    return response.json()


def _candidate(node: dict) -> Candidate:
    hotfix_url = f"https://hotfix.jobs/jobs/{node['id']}"
    countries = node.get("countries") or []
    work_type = node.get("work_type")
    low, high = node.get("salary_min") or None, node.get("salary_max") or None
    amounts = [amount for amount in (low, high) if amount is not None]
    yearly = bool(amounts) and all(amount >= 10000 for amount in amounts)
    return Candidate(
        source="hotfix",
        source_id=node["id"],
        link=node.get("apply_url") or hotfix_url,
        title=node["title"],
        company=node.get("company_name"),
        description=node.get("summary"),
        location_raw="; ".join(node.get("locations") or []) or None,
        country=countries[0] if len(countries) == 1 else None,
        remote={"remote": True, "hybrid": False, "onsite": False}.get(work_type),
        arrangement=work_type if work_type in {"hybrid", "onsite"} else None,
        pay_min=low,
        pay_max=high,
        pay_currency=node.get("salary_currency") if amounts else None,
        pay_period="year" if yearly else None,
        posted_at=node.get("posted_at"),
        extra={"hotfix_url": hotfix_url},
    )


async def search(client: httpx.AsyncClient, roles: list[str]) -> list[Candidate]:
    candidates = {}
    for role in roles:
        data = await _get(
            client, JOBS_URL, params={"query": role, "page": 1, "limit": 100}
        )
        for node in data["data"]:
            if node["id"] not in candidates:
                candidates[node["id"]] = _candidate(node)
    return list(candidates.values())


async def description(client: httpx.AsyncClient, job_id: str) -> str | None:
    data = await _get(client, f"{JOBS_URL}/{job_id}")
    return data.get("description")
