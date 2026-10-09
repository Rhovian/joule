from datetime import UTC, datetime

import httpx
import pytest

from joule.sources.adzuna import AdzunaError, search
from tests.test_hotfix_source import run

JOB = {
    "id": 123,
    "redirect_url": "https://example.com/job",
    "title": "Engineer",
    "company": {"display_name": "Example"},
    "description": "Short snippet",
    "location": {"display_name": "New York, US"},
    "created": "2026-10-08T12:00:00Z",
    "salary_min": 100000,
    "salary_max": 150000,
    "salary_is_predicted": "0",
}


@pytest.mark.parametrize("predicted", ["0", "1", 1])
def test_search(predicted):
    requests = []

    def respond(request):
        assert request.method == "GET"
        assert request.url.path == "/v1/api/jobs/us/search/1"
        assert request.headers["Accept"] == "application/json"
        assert dict(request.url.params) == {
            "app_id": "test-id",
            "app_key": "test-secret",
            "what": ["one", "two"][len(requests)],
            "results_per_page": "50",
        }
        requests.append(request)
        return httpx.Response(
            200, json={"results": [JOB | {"salary_is_predicted": predicted}]}
        )

    jobs = run(respond, lambda c: search(c, ["one", "two"], "test-id", "test-secret"))
    assert len(requests) == 2 and len(jobs) == 1
    job = jobs[0]
    assert job.source == "adzuna" and job.source_id == "123"
    assert job.link == JOB["redirect_url"] and job.title == "Engineer"
    assert job.company == "Example" and job.description == "Short snippet"
    assert job.location_raw == "New York, US"
    assert job.posted_at == datetime(2026, 10, 8, 12, tzinfo=UTC)
    assert job.pay_period is None and job.remote is None
    assert (job.pay_min, job.pay_max, job.pay_currency) == (
        (100000, 150000, "USD") if predicted == "0" else (None, None, None)
    )
    assert job.extra == {
        "salary_min": 100000,
        "salary_max": 150000,
        "salary_is_predicted": predicted,
    }


@pytest.mark.parametrize(
    "app_id, app_key", [(None, "secret"), ("id", None), ("id", "")]
)
def test_missing_credentials(app_id, app_key):
    def respond(request):
        pytest.fail("Missing credentials must fail before HTTP")

    with pytest.raises(AdzunaError, match="ADZUNA_APP_ID and ADZUNA_APP_KEY") as error:
        run(respond, lambda c: search(c, ["one"], app_id, app_key))
    assert "secret" not in str(error.value)


@pytest.mark.parametrize("status", [401, 429, None])
def test_errors_hide_key(status):
    def respond(request):
        if status is None:
            raise httpx.ConnectError(str(request.url), request=request)
        return httpx.Response(status)

    with pytest.raises(AdzunaError) as error:
        run(respond, lambda c: search(c, ["one"], "id", "secret"))
    assert "secret" not in str(error.value)
    assert error.value.__suppress_context__ or status is not None
