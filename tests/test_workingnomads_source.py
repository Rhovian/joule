import json

import httpx
from test_hotfix_source import run

from joule.sources.workingnomads import JOBS_URL, search


def test_search():
    roles = iter(["one", "two"])
    node = json.loads(
        '{"id":7,"slug":"engineer","title":"Engineer","company":"Example", "description":"<p>Full text</p>","locations":["USA"],"pub_date":"2026-10-08T12:00:00Z"}'
    )

    def respond(request):
        assert request.method == "POST" and str(request.url) == JOBS_URL
        body = json.loads(request.content)
        query = {
            "query": f'"{next(roles)}"',
            "fields": ["title^2", "description", "company"],
        }
        terms = {"locations": ["USA", "North America", "Anywhere"]}
        filters = body.pop("query")["bool"]
        assert filters == {
            "must": [{"query_string": query}],
            "filter": [{"terms": terms}],
        }
        assert body == dict(
            size=100,
            **{"from": 0},
            min_score=2,
            sort=[{"premium": {"order": "desc"}}, {"pub_date": {"order": "desc"}}],
        )
        return httpx.Response(200, json={"hits": {"hits": [{"_source": node}]}})

    (job,) = run(respond, lambda c: search(c, ["one", "two"]))
    assert (job.source, job.source_id) == ("workingnomads", "7")
    assert job.link == "https://www.workingnomads.com/jobs/engineer"
    assert (job.location_raw, job.remote) == ("USA", True)
    assert job.posted_at.isoformat() == "2026-10-08T12:00:00+00:00"
    assert all(
        getattr(job, key) == node[key] for key in ("title", "company", "description")
    )
    assert next(roles, None) is None
