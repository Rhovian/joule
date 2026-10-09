import json
from datetime import UTC, datetime

import httpx
import pytest

from joule.sources.getarustjob import description, search
from tests.test_hotfix_source import run

JOB = {
    "id": "rust-1",
    "slug": "example-rust",
    "title": "Rust engineer",
    "company_name": "Example",
    "location": "New York",
    "countries": ["United States"],
    "remote_types": ["Remote"],
    "approved_at": "2026-10-08T12:00:00Z",
}


def html(payload):
    return "<script>self.__next_f.push(" + json.dumps([1, payload]) + ")</script>"


def test_list_and_pagination():
    pages = []

    def respond(request):
        page = int(request.url.params["page"])
        pages.append(page)
        assert request.url.path == "/jobs"
        if page == 3:
            payload = '3d:["$","$L3e",null,{"listingPath":"/jobs","children":"No more jobs on this page."}]'
        else:
            node = (
                JOB
                if page == 1
                else JOB | {"id": "rust-2", "remote_types": ["On-site"]}
            )
            payload = '3d:["$","$L41",null,{"jobs":' + json.dumps([node]) + "}]"
        return httpx.Response(200, text=html(payload))

    jobs = run(respond, search)
    assert pages == [1, 2, 3] and len(jobs) == 2
    job = jobs[0]
    assert job.source == "getarustjob" and job.source_id == "rust-1"
    assert job.link == "https://getarustjob.com/jobs/example-rust"
    assert job.title == "Rust engineer" and job.company == "Example"
    assert job.location_raw == "New York; United States"
    assert job.remote is True and jobs[1].remote is None
    assert job.posted_at == datetime(2026, 10, 8, 12, tzinfo=UTC)
    assert job.extra["slug"] == "example-rust"


@pytest.mark.parametrize(
    "payload", ['3d:{"jobs":[]}', "changed page", '3d:{"jobs":{}}']
)
def test_empty_or_unparseable(payload):
    if '"jobs":[]' in payload:
        assert run(lambda r: httpx.Response(200, text=html(payload)), search) == []
    else:
        with pytest.raises(ValueError, match="getarustjob"):
            run(lambda r: httpx.Response(200, text=html(payload)), search)


@pytest.mark.parametrize("unit", ["YEAR", "HOUR"])
def test_description_and_pay(unit):
    from joule.sources import Candidate

    job = Candidate(
        source="getarustjob",
        source_id="rust-1",
        link="https://example.com",
        title="Rust",
    )
    node = {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "description": "<p>Full description</p>",
        "baseSalary": {
            "currency": "USD",
            "value": {"minValue": 100000, "maxValue": 150000, "unitText": unit},
        },
    }

    def respond(request):
        assert request.url.path == "/jobs/example-rust"
        return httpx.Response(200, text=html(json.dumps(node)))

    assert (
        run(respond, lambda c: description(c, "example-rust", job))
        == node["description"]
    )
    assert (job.pay_min, job.pay_max, job.pay_currency, job.pay_period) == (
        (100000, 150000, "USD", "year") if unit == "YEAR" else (None, None, None, None)
    )
