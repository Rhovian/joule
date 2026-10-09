import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from joule.sources import BROWSER_USER_AGENT
from joule.sources.remoteok import JOBS_URL, search


def run(handler):
    async def main():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), headers={"User-Agent": "joule/0.1"}
        ) as client:
            return await search(client)

    return asyncio.run(main())


@pytest.mark.parametrize(
    "low, high, yearly",
    [
        (10000, 20000, True),
        (0, 0, False),
        (0, 20000, True),
        (10000, 0, True),
        (30, 20000, False),
    ],
)
def test_search(low, high, yearly):
    requests = []
    node = {
        "id": 123,
        "position": "Synthetic role",
        "company": "Example",
        "description": "<p>Synthetic description</p>",
        "location": "Anywhere",
        "url": "https://remoteok.com/remote-jobs/123",
        "epoch": 1791460800,
        "salary_min": low,
        "salary_max": high,
    }
    if low:
        node["apply_url"] = "https://example.com/apply"

    def respond(request):
        requests.append(request)
        assert request.method == "GET" and str(request.url) == JOBS_URL
        assert request.headers["User-Agent"] == BROWSER_USER_AGENT
        return httpx.Response(200, json=[{"legal": "Synthetic metadata"}, node])

    jobs = run(respond)
    assert len(requests) == len(jobs) == 1
    job = jobs[0]
    assert job.source == "remoteok" and job.source_id == "123"
    assert job.link == node["url"] and job.title == node["position"]
    assert job.company == "Example" and job.description == node["description"]
    assert job.location_raw == "Anywhere" and job.remote is True
    assert job.posted_at == datetime(2026, 10, 8, 12, tzinfo=UTC)
    assert (job.pay_min, job.pay_max) == (low or None, high or None)
    assert job.pay_currency == ("USD" if low or high else None)
    assert job.pay_period == ("year" if yearly else None)
    assert job.extra == ({"apply_url": node["apply_url"]} if low else {})


def test_errors():
    with pytest.raises(httpx.HTTPStatusError, match="429"):
        run(lambda r: httpx.Response(429))


def test_mojibake_repaired_and_correct_text_preserved():
    for text in ("fÃ¼r", "für"):
        node = {
            "id": 1,
            "url": "https://remoteok.com/remote-jobs/1",
            "position": text,
            "company": text,
            "location": text,
            "description": text,
        }
        job = run(lambda r, node=node: httpx.Response(200, json=[{}, node]))[0]
        assert (job.title, job.company, job.location_raw, job.description) == (
            "für",
        ) * 4
