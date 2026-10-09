from datetime import UTC, datetime

import httpx

from joule.sources import BROWSER_USER_AGENT, Candidate

JOBS_URL = "https://remoteok.com/api"


def repair_text(text: str | None) -> str | None:
    if text is not None:
        try:
            return text.encode("latin-1").decode("utf-8")
        except UnicodeError:
            pass
    return text


def _candidate(node: dict) -> Candidate:
    low, high = node.get("salary_min") or None, node.get("salary_max") or None
    amounts = [amount for amount in (low, high) if amount is not None]
    yearly = bool(amounts) and all(amount >= 10000 for amount in amounts)
    epoch = node.get("epoch")
    apply_url = node.get("apply_url")
    return Candidate(
        source="remoteok",
        source_id=str(node["id"]),
        link=node["url"],
        title=repair_text(node["position"]),
        company=repair_text(node.get("company")),
        description=repair_text(node.get("description")),
        location_raw=repair_text(node.get("location")),
        remote=True,
        posted_at=datetime.fromtimestamp(epoch, UTC) if epoch is not None else None,
        pay_min=low,
        pay_max=high,
        pay_currency="USD" if amounts else None,
        pay_period="year" if yearly else None,
        extra={"apply_url": apply_url} if apply_url else {},
    )


async def search(client: httpx.AsyncClient) -> list[Candidate]:
    response = await client.get(JOBS_URL, headers={"User-Agent": BROWSER_USER_AGENT})
    response.raise_for_status()
    return [_candidate(node) for node in response.json()[1:]]
