import json

import httpx
from test_hotfix_source import run

from joule.sources.golangjobs import ANON_KEY, JOBS_URL, search


def test_search():
    offsets = iter(["0", "200"])
    node = json.loads(
        '{"id":"job-id","slug":"engineer","title":"Engineer","company":"Example", "description":"<p>Full text</p>","posted_at":"2026-10-08T12:00:00Z", "cities":{"name":"Remote","country":"Global"},"application_url":"https://example.com/apply"}'
    )

    def respond(request):
        assert request.method == "GET" and str(request.url).split("?")[0] == JOBS_URL
        assert request.headers["apikey"] == ANON_KEY
        assert request.headers["Authorization"] == f"Bearer {ANON_KEY}"
        offset = next(offsets)
        assert dict(request.url.params) == {
            "select": "id,title,company,application_url,slug,posted_at,description,cities(name,country)",
            "is_archived": "eq.false",
            "order": "posted_at.desc",
            "limit": "200",
            "offset": offset,
        }
        return httpx.Response(200, json=[node] * (200 if offset == "0" else 1))

    (job,) = run(respond, search)
    assert (job.source, job.source_id) == ("golangjobs", "job-id")
    assert job.link == "https://www.golangjobs.tech/golang-jobs/engineer"
    assert (job.city, job.country, job.location_raw) == (
        None,
        "Global",
        "Remote, Global",
    )
    assert job.remote is True and job.extra == {
        "application_url": node["application_url"]
    }
    assert job.posted_at.isoformat() == "2026-10-08T12:00:00+00:00"
    assert all(
        getattr(job, key) == node[key] for key in ("title", "company", "description")
    )
    assert next(offsets, None) is None
