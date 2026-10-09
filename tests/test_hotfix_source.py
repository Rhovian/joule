import asyncio
import json
from datetime import UTC, datetime

import httpx
import pytest

from joule.sources.hotfix import HotfixError, description, search

JOB = json.loads("""
    {"id": "00000000-0000-4000-8000-000000000001", "title": "Synthetic role",
     "company_name": "Example", "summary": "Synthetic summary", "locations": ["A", "B"],
     "countries": ["US"], "work_type": "remote", "salary_min": 10000,
     "salary_max": 20000, "salary_currency": "USD", "posted_at": "2026-10-08T12:00:00Z"}
""")


def run(handler, operation):
    async def main():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), headers={"User-Agent": "joule/0.1"}
        ) as client:
            return await operation(client)

    return asyncio.run(main())


@pytest.mark.parametrize("work_type", ["remote", "onsite", "hybrid"])
@pytest.mark.parametrize(
    "low, high, yearly",
    [(10000, 20000, True), (30, 50, False), (0, 0, False)],
)
def test_search(work_type, low, high, yearly):
    requests = []

    def respond(request):
        assert request.method == "GET" and request.url.path == "/v1/jobs"
        assert request.headers["User-Agent"] == "joule/0.1"
        assert dict(request.url.params) == {
            "query": ["one", "two"][len(requests)],
            "page": "1",
            "limit": "100",
        }
        requests.append(request)
        node = JOB | {"work_type": work_type, "salary_min": low, "salary_max": high}
        if len(requests) == 2:
            node["title"] = "Later duplicate"
        return httpx.Response(200, json={"data": [node]})

    jobs = run(respond, lambda c: search(c, ["one", "two"]))
    assert len(requests) == 2 and len(jobs) == 1
    job = jobs[0]
    assert job.source == "hotfix" and job.source_id == JOB["id"]
    assert job.title == JOB["title"] and job.company == "Example"
    assert job.description == "Synthetic summary"
    url = f"https://hotfix.jobs/jobs/{JOB['id']}"
    assert job.link == job.extra["hotfix_url"] == url
    assert job.location_raw == "A; B" and job.country == "US"
    assert job.remote == (work_type == "remote")
    assert job.arrangement == (None if work_type == "remote" else work_type)
    assert (job.pay_min, job.pay_max, job.pay_currency, job.pay_period) == (
        (low or None, high or None, "USD", "year")
        if yearly
        else (None, None, None, None)
    )
    assert job.posted_at == datetime(2026, 10, 8, 12, tzinfo=UTC)


def test_errors():
    with pytest.raises(HotfixError, match="429"):
        run(lambda r: httpx.Response(429), lambda c: search(c, ["one"]))


def test_description():
    def respond(request):
        assert request.url.path == f"/v1/jobs/{JOB['id']}"
        return httpx.Response(200, json={"description": "Full synthetic description"})

    text = run(respond, lambda c: description(c, JOB["id"]))
    assert text == "Full synthetic description"
