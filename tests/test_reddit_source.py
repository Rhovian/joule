import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from xml.etree.ElementTree import ParseError

import httpx
import pytest

from joule.scan import ADAPTERS

URLS = [f"https://www.reddit.com/r/{sub}/new/.rss" for sub in ("forhire", "hiring")]


@pytest.fixture(autouse=True)
def sleep(monkeypatch):
    mock = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", mock)
    return mock


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


@pytest.mark.parametrize("entries", ["", entry()])
@pytest.mark.parametrize("failure", [403, 429, "network", "xml"])
@pytest.mark.parametrize("url", URLS)
def test_partial_failure_keeps_jobs(failure, url, entries, caplog, sleep):
    requests = []

    def respond(request):
        requests.append(str(request.url))
        if str(request.url) != url:
            return httpx.Response(200, text=feed(entries))
        if failure == "network":
            raise httpx.ConnectError("offline", request=request)
        return httpx.Response(200 if failure == "xml" else failure, text="<feed>")

    assert len(run(respond)) == bool(entries)
    assert requests.count(url) == (2 if failure == 429 else 1)
    assert url in caplog.text
    assert 5 in [call.args[0] for call in sleep.await_args_list]


@pytest.mark.parametrize("status", [403, 429])
def test_all_feeds_fail(status):
    with pytest.raises(httpx.HTTPStatusError, match=str(status)):
        run(lambda r: httpx.Response(status))


@pytest.mark.parametrize(
    "retry_after, delay",
    [
        (None, 15),
        ("7", 7),
        ("99999", 20),
        ("invalid", 15),
        ("-1", 0),
        ("Thu, 29 Oct 2099 12:00:00 GMT", 20),
        ("Thu, 29 Oct 2020 12:00:00 GMT", 0),
    ],
)
def test_429_retries_once(retry_after, delay, sleep):
    requests = []

    def respond(request):
        requests.append(str(request.url))
        if len(requests) == 1:
            headers = {} if retry_after is None else {"Retry-After": retry_after}
            return httpx.Response(429, headers=headers)
        return httpx.Response(200, text=feed(entry()))

    assert len(run(respond)) == 1
    assert requests == [URLS[0], *URLS]
    assert [call.args[0] for call in sleep.await_args_list] == [delay, 5]


def test_malformed_feed_is_a_source_error():
    with pytest.raises(ParseError):
        run(lambda r: httpx.Response(200, text="<feed>"))


@pytest.mark.parametrize(
    "text, keep",
    [
        ("Experienced English Voice-Over Artists", False),
        ("Google Ads Specialist", False),
        ("Require editors (from india)", False),
        (
            "Native speakers (FR/AR/DE/IT) for paid remote conversation recordings",
            False,
        ),
        ("Ready to go on recordings", False),
        ("Go get paid", False),
        ("Logo designer", False),
        ("Django developer", True),
        ("DEVELOPER", True),
        ("Engineer", True),
        ("Audio engineer", True),
        ("Sound engineer", True),
        ("Backend", True),
        ("front-end", True),
        ("Full stack", True),
        ("DevOps", True),
        ("Golang", True),
        ("Go programming", True),
        ("Rust", True),
        ("Python", True),
        ("TypeScript", True),
        ("React", True),
        ("Programmer", True),
    ],
)
@pytest.mark.parametrize("in_body", [False, True])
def test_software_terms_in_title_or_body(text, keep, in_body):
    title = "[Hiring] Role" if in_body else f"[Hiring] {text}"
    atom = entry(title=title)
    if in_body:
        atom = atom.replace("Role details", text)
    assert bool(run(lambda r: httpx.Response(200, text=feed(atom)))) == keep


def test_software_body_still_requires_hiring_title():
    atom = entry(title="[For Hire] Role").replace("Role details", "Rust developer")
    assert run(lambda r: httpx.Response(200, text=feed(atom))) == []
