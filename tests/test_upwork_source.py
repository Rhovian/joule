import asyncio
import json
from datetime import UTC, datetime

import httpx
import pytest

from joule.sources.upwork import UpworkError, screening_questions, search
from joule.upwork_auth import UpworkAuth

TOKEN = {"access_token": "synthetic-token", "refresh_token": "r", "expires_in": 3600}


def money(value):
    return {"rawValue": str(value), "currency": "EUR"}


def node(**overrides):
    result = json.loads("""
        {"id": "synthetic-id", "title": "Synthetic role", "description": "Synthetic",
         "ciphertext": "~synthetic", "publishedDateTime": "2026-10-08T12:00:00Z",
         "job": {"contractTerms": {"contractType": "HOURLY"}},
         "client": {"totalSpent": {"rawValue": "1000", "currency": "EUR"},
                    "totalHires": 2, "totalPostedJobs": 3, "verificationStatus": "VERIFIED",
                    "location": {"city": "Example", "country": "US", "state": "ID"}}}
    """)
    result.update(
        amount=money(500), hourlyBudgetMin=money(30), hourlyBudgetMax=money(50)
    )
    return result | overrides


def run(tmp_path, handler, operation):
    async def main():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            auth = UpworkAuth(tmp_path, client)
            await auth.save(TOKEN)
            return await operation(auth)

    return asyncio.run(main())


@pytest.mark.parametrize("ciphertext", ["~synthetic", "synthetic"])
@pytest.mark.parametrize(
    "kind, amount, expected",
    [
        ("HOURLY", 0, (30, 50, "hour")),
        ("FIXED", 500, (500, 500, "fixed")),
        ("FIXED", 0, (None, None, "fixed")),
    ],
)
def test_search(tmp_path, ciphertext, kind, amount, expected):
    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        assert request.headers["Authorization"] == "Bearer synthetic-token"
        assert str(request.url) == "https://api.upwork.com/graphql"
        candidate = node(
            ciphertext=ciphertext,
            amount=money(amount),
            job={"contractTerms": {"contractType": kind}},
        )
        if len(requests) == 2:
            candidate["title"] = "Later duplicate"
        result = {"edges": [{"node": candidate}]}
        return httpx.Response(
            200, json={"data": {"marketplaceJobPostingsSearch": result}}
        )

    jobs = run(
        tmp_path, respond, lambda auth: search(auth, ["one", "two"], 25.1, 99.2, True)
    )
    assert len(jobs) == 1 and len(requests) == 2
    for request, role in zip(requests, ["one", "two"]):
        assert "RECENCY" in request["query"]
        assert "screeningQuestions" not in request["query"]
        assert request["variables"]["filter"] == {
            "searchExpression_eq": role,
            "pagination_eq": {"first": 50},
            "hourlyRate_eq": {"rangeStart": 26},
            "budgetRange_eq": {"rangeStart": 100},
            "verifiedPaymentOnly_eq": True,
        }
    job = jobs[0]
    assert job.title == "Synthetic role" and job.source == "upwork"
    assert job.source_id == "synthetic-id" and job.remote is True
    assert job.link == "https://www.upwork.com/jobs/~synthetic"
    assert job.company is None and job.location_raw is None
    assert job.posted_at == datetime(2026, 10, 8, 12, tzinfo=UTC)
    assert (job.pay_min, job.pay_max, job.pay_period) == expected
    assert job.pay_currency == "EUR"
    assert job.extra["client"] == {
        "total_spent": 1000,
        "total_hires": 2,
        "total_posted_jobs": 3,
        "payment_verified": True,
        "location": {"city": "Example", "country": "US", "state": "ID"},
    }


@pytest.mark.parametrize(
    "status, body, message",
    [
        (200, {"errors": [{"message": "Synthetic error"}]}, "Synthetic error"),
        (503, {}, "503"),
    ],
)
def test_errors(tmp_path, status, body, message):
    with pytest.raises(UpworkError, match=message):
        run(
            tmp_path,
            lambda r: httpx.Response(status, json=body),
            lambda auth: search(auth, ["role"], None, None, False),
        )


def test_screening_questions(tmp_path):
    def respond(request):
        assert json.loads(request.content)["variables"] == {"id": "synthetic-id"}
        questions = [
            {"question": "Second?", "sequenceNumber": 2},
            {"question": "First?", "sequenceNumber": 1},
        ]
        job = {
            "contractorSelection": {
                "proposalRequirement": {"screeningQuestions": questions}
            }
        }
        return httpx.Response(200, json={"data": {"marketplaceJobPosting": job}})

    assert run(
        tmp_path, respond, lambda auth: screening_questions(auth, "synthetic-id")
    ) == ["First?", "Second?"]
