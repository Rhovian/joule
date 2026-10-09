import asyncio
from datetime import UTC, datetime

import httpx
import pytest

from joule.sources import BROWSER_USER_AGENT
from joule.sources.weworkremotely import JOBS_URL, search


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
        assert request.method == "GET" and str(request.url) == JOBS_URL
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
    assert len(requests) == len(jobs) == 1
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


def test_errors():
    with pytest.raises(httpx.HTTPStatusError, match="403"):
        run(lambda r: httpx.Response(403))
