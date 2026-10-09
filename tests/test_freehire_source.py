import json

import httpx
import pytest
from test_hotfix_source import run

from joule.sources.freehire import JOBS_URL, search


@pytest.mark.parametrize("mode", ["remote", "hybrid"])
def test_search(mode):
    roles = iter(["one", "two"])
    node = json.loads(
        '{"public_slug":"engineer","url":"https://example.com/job","title":"Engineer", "company":"Example","description":"## Full text","location":"Boise, US", "cities":["Boise"],"countries":["us"],"posted_at":"2026-10-08T12:00:00Z"}'
    ) | {"work_mode": mode}

    def respond(request):
        assert request.method == "GET" and str(request.url).split("?")[0] == JOBS_URL
        assert dict(request.url.params) == {
            "q": next(roles),
            "countries": "us",
            "description_format": "markdown",
            "sort": "posted_at",
            "order": "desc",
            "limit": "100",
        }
        return httpx.Response(200, json={"data": [node]})

    (job,) = run(respond, lambda c: search(c, ["one", "two"]))
    assert (job.source, job.source_id, job.link) == (
        "freehire",
        "engineer",
        node["url"],
    )
    assert (job.location_raw, job.city, job.country) == ("Boise, US", "Boise", "us")
    assert job.remote == (mode == "remote")
    assert job.arrangement == ("hybrid" if mode == "hybrid" else None)
    assert job.posted_at.isoformat() == "2026-10-08T12:00:00+00:00"
    assert all(
        getattr(job, key) == node[key] for key in ("title", "company", "description")
    )
    assert next(roles, None) is None
