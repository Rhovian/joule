import asyncio
import json

import httpx
import pytest

from joule.sources import Candidate
from joule.sources.hn import parse_header, search


def run(handler):
    async def main():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await search(client)

    return asyncio.run(main())


def fixture(key, nodes):
    return httpx.Response(200, json={key: json.loads(nodes.replace("LONG", "A" * 201))})


def test_thread_selection_and_mapping():
    requests = []

    def respond(request):
        requests.append(request)
        assert request.method == "GET" and request.url.host == "hn.algolia.com"
        if len(requests) == 1:
            assert request.url.path == "/api/v1/search_by_date"
            params = {"tags": "story,author_whoishiring", "hitsPerPage": "20"}
            assert dict(request.url.params) == params
            return fixture(
                "hits",
                """[
                {"objectID": "3", "title": "Ask HN: Who wants to be hired?"},
                {"objectID": "2", "title": "Ask HN: Who is hiring? (October 2026)"},
                {"objectID": "1", "title": "Ask HN: Who is hiring? (September 2026)"}
            ]""",
            )
        assert request.url.path == "/api/v1/items/2"
        return fixture(
            "children",
            """[
            {"id": 10, "text": " Acme &amp; Co | Engineer | rEmOtE <p>Details",
             "created_at": "2026-10-08T12:00:00Z", "children": [{"id": 99, "text": "Reply"}]},
            {"id": 11, "text": "<b>Engineer</b><p>Remote in body only"},
            {"id": 12, "text": null}, {"id": 13, "text": ""}, {"id": 14, "text": "LONG | Remote"}
        ]""",
        )

    jobs = run(respond)
    assert len(requests) == 2
    expected_json = """[
        {"source": "hn", "source_id": "10", "link": "https://news.ycombinator.com/item?id=10",
         "title": "Engineer", "company": "Acme & Co", "remote": true, "description": " Acme &amp; Co | Engineer | rEmOtE <p>Details",
         "posted_at": "2026-10-08T12:00:00Z"},
        {"source": "hn", "source_id": "11", "title": "Engineer", "link": "https://news.ycombinator.com/item?id=11", "description": "<b>Engineer</b><p>Remote in body only"},
        {"source": "hn", "source_id": "14", "link": "https://news.ycombinator.com/item?id=14", "title": "CAP", "company": "LONG", "remote": true, "description": "LONG | Remote"}
    ]"""
    expected = json.loads(
        expected_json.replace("LONG", "A" * 201).replace("CAP", "A" * 200)
    )
    assert [job.model_dump() for job in jobs] == [
        Candidate.model_validate(node).model_dump() for node in expected
    ]


def test_no_matching_story():
    def respond(request):
        assert request.url.path == "/api/v1/search_by_date"
        return fixture("hits", '[{"objectID":"3","title":"Who wants to be hired?"}]')

    with pytest.raises(ValueError, match="No HN Who is hiring"):
        run(respond)


@pytest.mark.parametrize(
    "header, expected",
    json.loads("""[
["Mesmer (YC P25) | Founding Engineer | Berlin | ONSITE | VISA + relocation | €100–140k + 0.5–1% equity", {"company": "Mesmer", "title": "Founding Engineer", "location_raw": "Berlin", "remote": false, "arrangement": "onsite", "pay": [100000, 140000, "EUR", "year"]}],
["Snout  https://snout.com/  | Multiple Engineering + Product Roles | Remote US or Ontario, Canada | Full Time", {"company": "Snout", "title": "Multiple Engineering + Product Roles", "location_raw": "US or Ontario, Canada", "remote": true, "arrangement": null, "pay": [null, null, null, null]}],
["PrairieLearn (Remote US) — Full-Stack Software Engineer — TypeScript / Postgres / React / AI", {"company": "PrairieLearn", "title": "Full-Stack Software Engineer", "location_raw": null, "remote": true, "arrangement": null, "pay": [null, null, null, null]}],
["Shepherd (Series B) | ONSITE | San Francisco, CA & New York City, NY", {"company": "Shepherd", "title": "Shepherd (Series B) | ONSITE | San Francisco, CA & New York City, NY", "location_raw": "San Francisco, CA & New York City, NY", "remote": false, "arrangement": "onsite", "pay": [null, null, null, null]}],
["Planlab.ai | | Product Engineer (Design) & Platform Engineer | ONSITE in London, UK | 100k-160k GBP + 0.25-0. ...", {"company": "Planlab.ai", "title": "Product Engineer (Design) & Platform Engineer", "location_raw": "London, UK", "remote": false, "arrangement": "onsite", "pay": [100000, 160000, "GBP", "year"]}],
["Sidekick Labs | Senior SWE, R&D Engineer, Intelligence Engineer | REMOTE (US Timezones) | Full-time | $170k t ...", {"company": "Sidekick Labs", "title": "Senior SWE, R&D Engineer, Intelligence Engineer", "location_raw": "US Timezones", "remote": true, "arrangement": null, "pay": [null, null, null, null]}]
]"""),
)
def test_real_headers(header, expected):
    parsed = parse_header(header)
    assert list(salary(parsed)) == expected.pop("pay")
    assert {key: parsed.get(key) for key in expected} == expected
    assert parsed["extra"] == (
        {"urls": ["https://snout.com/"]} if expected["company"] == "Snout" else {}
    )


def salary(parsed):
    return tuple(
        parsed.get(key) for key in ("pay_min", "pay_max", "pay_currency", "pay_period")
    )


@pytest.mark.parametrize(
    "cash, expected",
    [
        ("$170k to $230k Base + Equity", (170000, 230000, "USD", "year")),
        ("100–140k€", (100000, 140000, "EUR", "year")),
        ("GBP 100,000 - 140,000", (100000, 140000, "GBP", "year")),
        ("£100k", (100000, 100000, "GBP", "year")),
    ],
)
def test_cash_ranges(cash, expected):
    assert salary(parse_header(f"Acme | Engineer | {cash}")) == expected


@pytest.mark.parametrize(
    "unknown",
    [
        "0.5–1% equity",
        "$100/hour",
        "$12K fixed project",
        "100k–140k",
        "TypeScript / React / AI",
        "$10k/month",
        "$140k-$100k",
        "AI",
        "Competitive Compensation",
        "$100,000 funding raised",
    ],
)
def test_uncertain_fields_stay_empty(unknown):
    parsed = parse_header(f"Acme | Engineer | {unknown}")
    assert salary(parsed) == (None,) * 4
    assert all(parsed.get(k) is None for k in ("location_raw", "city", "country"))


def test_parsed_fields_reach_filters():
    from joule.config import Preferences
    from joule.filters import filter_reason

    def reason(header, **prefs):
        job = Candidate(
            source="hn",
            source_id="1",
            link="https://hn.example/1",
            **parse_header(header),
        )
        return filter_reason(job, Preferences(roles=[], **prefs))

    pay = {"salary_floor": 150000, "currency": "USD"}
    assert (
        reason("Acme | Engineer | $100k–$140k", pay=pay)
        == "pay: 140000 below 150000 per year"
    )
    assert reason("Acme | Engineer | €100k–€140k", pay=pay) is None
    assert (
        reason("Acme | Engineer | Berlin | ONSITE", locations={"exclude": ["Berlin"]})
        == "location: Berlin excluded"
    )
    assert (
        reason("Acme | London | ONSITE+PART REMOTE", locations={"exclude": ["London"]})
        is None
    )


def test_parenthesized_and_separate_urls():
    parsed = parse_header(
        "Acme (https://acme.example) | https://acme.example/jobs | Engineer | Berlin"
    )
    assert parsed["company"] == "Acme"
    assert parsed["title"] == "Engineer"
    assert parsed["location_raw"] == "Berlin"
    assert parsed["extra"]["urls"] == [
        "https://acme.example",
        "https://acme.example/jobs",
    ]


@pytest.mark.parametrize(
    "cash", ["$3k/week", "$1k/day", "$3k weekly", "$1k daily", "$3k/wk", "$1k/d"]
)
def test_nonannual_rates_do_not_filter(cash):
    from joule.config import Preferences
    from joule.filters import filter_reason

    parsed = parse_header(f"Acme | Engineer | {cash}")
    assert salary(parsed) == (None,) * 4
    job = Candidate(source="hn", source_id="1", link="https://hn.example/1", **parsed)
    assert (
        filter_reason(
            job, Preferences(roles=[], pay={"salary_floor": 100000, "currency": "USD"})
        )
        is None
    )


@pytest.mark.parametrize(
    "cash, expected",
    [
        ("USD 200k to USD 300k", (200000, 300000, "USD", "year")),
        ("USD 200k - USD 300k", (200000, 300000, "USD", "year")),
        ("$200k–€300k", (None,) * 4),
        ("USD 200k to EUR 300k", (None,) * 4),
        ("USD 200k to CAD 300k", (None,) * 4),
        ("USD 200k - CAD 300k", (None,) * 4),
    ],
)
def test_range_endpoints_do_not_filter(cash, expected):
    from joule.config import Preferences
    from joule.filters import filter_reason

    parsed = parse_header(f"Acme | Engineer | {cash}")
    assert salary(parsed) == expected
    job = Candidate(source="hn", source_id="1", link="https://hn.example/1", **parsed)
    assert (
        filter_reason(
            job, Preferences(roles=[], pay={"salary_floor": 250000, "currency": "USD"})
        )
        is None
    )


def test_search_keeps_header_hyperlink_destinations():
    header = (
        'Acme | Engineer | <a href="https://acme.example/jobs?a=1&amp;b=2">Careers</a>'
    )

    def respond(request):
        if request.url.path.endswith("search_by_date"):
            return httpx.Response(
                200,
                json={"hits": [{"objectID": "1", "title": "Ask HN: Who is hiring?"}]},
            )
        return httpx.Response(
            200,
            json={
                "children": [
                    {
                        "id": 2,
                        "text": header + '<p><a href="https://body.example">Body</a>',
                    }
                ]
            },
        )

    (job,) = run(respond)
    assert job.extra["urls"] == ["https://acme.example/jobs?a=1&b=2"]
    assert job.company == "Acme" and job.title == "Engineer"
    assert job.link == "https://news.ycombinator.com/item?id=2"
