import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from joule.sources import BROWSER_USER_AGENT
from joule.sources.weworkremotely import JOBS_URLS, search

EXPECTED_URLS = [
    "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
    "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
    "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
    "https://weworkremotely.com/categories/remote-programming-jobs.rss",
]


def run(handler):
    async def main():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler), headers={"User-Agent": "joule/0.1"}
        ) as client:
            return await search(client)

    return asyncio.run(main())


@pytest.mark.parametrize("split", [True, False])
def test_search(split):
    title = "Example: Synthetic role: Extra" if split else "Synthetic role"
    guid = "<guid>synthetic-id</guid>" if split else ""
    country = "<country>US</country>" if split else ""
    requests = []

    def respond(request):
        requests.append(request)
        assert request.method == "GET"
        assert request.headers["User-Agent"] == BROWSER_USER_AGENT
        return httpx.Response(
            200,
            text=f"""
            <rss><channel><item><title>{title}</title>{guid}
            <link>https://weworkremotely.com/remote-jobs/synthetic</link>
            <description><![CDATA[<p>Synthetic description</p>]]></description>
            <region>Anywhere</region>{country}
            <pubDate>Thu, 08 Oct 2026 12:00:00 GMT</pubDate>
            </item></channel></rss>
        """,
        )

    jobs = run(respond)
    assert [str(request.url) for request in requests] == EXPECTED_URLS
    assert len(jobs) == 1
    job = jobs[0]
    assert job.source == "weworkremotely"
    assert job.link == "https://weworkremotely.com/remote-jobs/synthetic"
    assert job.source_id == ("synthetic-id" if split else job.link)
    assert job.title == ("Synthetic role: Extra" if split else title)
    assert job.company == ("Example" if split else None)
    assert job.description == "<p>Synthetic description</p>"
    assert job.location_raw == "Anywhere" and job.country == ("US" if split else None)
    assert job.remote is True
    assert job.posted_at == datetime(2026, 10, 8, 12, tzinfo=UTC)
    assert (job.pay_min, job.pay_max, job.pay_currency, job.pay_period) == (None,) * 4


def test_merges_categories_and_keeps_first_duplicate():
    def respond(request):
        index = EXPECTED_URLS.index(str(request.url))
        return httpx.Response(
            200,
            text=f"""
            <rss><channel>
            <item><guid>shared-id</guid><title>Shared role {index}</title>
            <link>https://weworkremotely.com/remote-jobs/shared</link></item>
            <item><guid>unique-{index}</guid><title>Unique role {index}</title>
            <link>https://weworkremotely.com/remote-jobs/unique-{index}</link></item>
            </channel></rss>
            """,
        )

    jobs = run(respond)
    assert [job.source_id for job in jobs] == [
        "shared-id",
        "unique-0",
        "unique-1",
        "unique-2",
        "unique-3",
    ]
    assert jobs[0].title == "Shared role 0"


def test_empty_categories():
    assert run(lambda r: httpx.Response(200, text="<rss><channel /></rss>")) == []


@pytest.mark.parametrize("failed_url", JOBS_URLS)
def test_errors(failed_url):
    with pytest.raises(httpx.HTTPStatusError, match="403"):
        run(
            lambda r: httpx.Response(
                403 if str(r.url) == failed_url else 200,
                text="<rss><channel /></rss>",
            )
        )
