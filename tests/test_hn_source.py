import asyncio
import json

import httpx
import pytest

from joule.sources import Candidate
from joule.sources.hn import search


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
         "title": "Acme & Co | Engineer | rEmOtE", "company": "Acme & Co", "remote": true, "description": " Acme &amp; Co | Engineer | rEmOtE <p>Details",
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
