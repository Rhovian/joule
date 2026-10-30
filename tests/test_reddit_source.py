import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from xml.etree.ElementTree import ParseError

import httpx
import pytest

from joule.scan import ADAPTERS

URLS = [f"https://www.reddit.com/r/{sub}/new/.rss" for sub in ("forhire", "hiring")]


def entry(id="t3_one", title="[Hiring] Engineer", date="published"):
    timestamp = f"<{date}>2026-10-29T12:00:00Z</{date}>" if date else ""
    return f"""<entry><id>{id}</id><title>{title}</title>
    <author><name>/u/not-an-employer</name></author>
    <link rel="self" href="https://www.reddit.com/wrong" />
    <link href="https://www.reddit.com/r/forhire/comments/{id}/role/" />
    <content type="html">&lt;p&gt;Role details&lt;/p&gt;</content>{timestamp}</entry>"""


def run(handler):
    async def main():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            fetch, enrich = ADAPTERS["reddit"]
            assert enrich is None
            return await fetch(SimpleNamespace(client=client))

    return asyncio.run(main())


def feed(entries):
    return f'<feed xmlns="http://www.w3.org/2005/Atom">{entries}</feed>'


@pytest.mark.parametrize("date", ["published", "updated", None])
def test_atom_mapping_and_same_post_dedup(date):
    requests = []

    def respond(request):
        requests.append(str(request.url))
        assert request.method == "GET"
        assert request.headers["User-Agent"].startswith("joule/0.1 ")
        return httpx.Response(200, text=feed(entry(date=date)))

    jobs = run(respond)
    assert requests == URLS
    assert len(jobs) == 1
    job = jobs[0]
    assert (job.source, job.source_id, job.title) == (
        "reddit",
        "t3_one",
        "[Hiring] Engineer",
    )
    assert job.link == "https://www.reddit.com/r/forhire/comments/t3_one/role/"
    assert job.description == "<p>Role details</p>"
    assert job.posted_at == (datetime(2026, 10, 29, 12, tzinfo=UTC) if date else None)
    for field in (
        "company",
        "location_raw",
        "remote",
        "country",
        "city",
        "arrangement",
        "pay_min",
        "pay_max",
        "pay_currency",
        "pay_period",
    ):
        assert getattr(job, field) is None
    assert job.extra == {}


def test_selection_and_distinct_reposts():
    entries = entry() + entry("t3_repost", "[hIrInG] Engineer")
    entries += entry("seeker", "[For Hire] Engineer") + entry(
        "discussion", "Discussion"
    )
    entries += entry("", "[Hiring] Missing ID")
    entries += "<entry><id>missing-link</id><title>[Hiring] Role</title></entry>"
    entries += "<entry><id>missing-title</id></entry>"
    jobs = run(lambda r: httpx.Response(200, text=feed(entries)))
    assert [job.source_id for job in jobs] == ["t3_one", "t3_repost"]


def test_empty_feeds():
    assert run(lambda r: httpx.Response(200, text=feed(""))) == []


@pytest.mark.parametrize("status", [403, 429])
@pytest.mark.parametrize("url", URLS)
def test_source_errors(status, url):
    with pytest.raises(httpx.HTTPStatusError, match=str(status)):
        run(
            lambda r: httpx.Response(
                status if str(r.url) == url else 200, text=feed("")
            )
        )


def test_malformed_feed_is_a_source_error():
    with pytest.raises(ParseError):
        run(lambda r: httpx.Response(200, text="<feed>"))
