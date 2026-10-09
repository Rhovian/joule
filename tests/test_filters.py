import pytest

from joule.config import Preferences
from joule.filters import filter_reason
from joule.sources import Candidate


def breakers(**values):
    return {"deal_breakers": values}


def pay(period, low=None, high=None, currency=None):
    return {
        "pay_period": period,
        "pay_min": low,
        "pay_max": high,
        "pay_currency": currency,
    }


def floor(**values):
    return {"pay": values}


def remote(**values):
    return {"locations": {"remote": values}}


def city(name="New York", country="US", **values):
    return dict(remote=False, city=name, country=country, **values)


def cities(name="New York", country="US", arrangements=None, aliases=None):
    entry = {"city": name, "country": country}
    if arrangements is not None:
        entry["arrangements"] = arrangements
    return {"locations": {"cities": [entry], "aliases": aliases or {}}}


def client(**values):
    return {"source": "upwork", "extra": {"client": values}}


def limits(**values):
    return {"upwork_client": values}


@pytest.mark.parametrize(
    "job, preferences, expected",
    [
        ({}, {}, None),
        ({"company": "ACME, Inc."}, breakers(companies=["Acme Ltd"]), "deal_breaker"),
        ({"company": "Acme Labs"}, breakers(companies=["Acme"]), None),
        ({}, breakers(companies=["Acme"]), None),
        ({"title": "Senior C++ engineer"}, breakers(keywords=["c++"]), "deal_breaker"),
        ({"title": "C++Builder"}, breakers(keywords=["C++"]), None),
        (
            {"description": "Use JAVA daily"},
            breakers(keywords=["java"]),
            "deal_breaker",
        ),
        (
            {"description": '<span class="x">Rust &amp; Go</span>'},
            breakers(keywords=["span", "class", "amp"]),
            None,
        ),
        (
            {"description": "<p>Rust&nbsp;C++</p>"},
            breakers(keywords=["c++"]),
            "deal_breaker",
        ),
        ({"description": "JavaScript"}, breakers(keywords=["java"]), None),
        ({"title": "a.b"}, breakers(keywords=["a.b"]), "deal_breaker"),
        ({"title": "axb"}, breakers(keywords=["a.b"]), None),
        ({}, breakers(keywords=["java"], industries=["software"]), None),
        ({"source": "upwork"}, {"work_types": ["full-time"]}, "work_type"),
        ({"source": "upwork"}, {"work_types": ["freelance"]}, None),
        ({"source": "upwork"}, {}, None),
        ({}, {"work_types": ["freelance"]}, None),
        (pay("hour", 10, 20), floor(hourly_floor=30), "pay"),
        (pay("hour", 10, 30), floor(hourly_floor=30), None),
        (pay("hour", high=20), floor(hourly_floor=30), "pay"),
        (pay("hour", 0), floor(hourly_floor=1), "pay"),
        (pay("fixed", 20), floor(fixed_floor=30), "pay"),
        (pay("fixed", 30), floor(fixed_floor=30), None),
        (
            pay("year", 20, currency="usd"),
            floor(salary_floor=30, currency="USD"),
            "pay",
        ),
        (pay("year", 20, currency="EUR"), floor(salary_floor=30, currency="USD"), None),
        (pay("year", 30), floor(salary_floor=30), None),
        (pay("year", 20), floor(salary_floor=30, currency="USD"), "pay"),
        (pay("year", 20, currency="USD"), floor(salary_floor=30), "pay"),
        (pay("hour", 20), {}, None),
        ({}, floor(hourly_floor=30, fixed_floor=30, salary_floor=30), None),
        (pay(None, 20), floor(hourly_floor=30), None),
        ({"remote": True}, remote(ok=False), "location"),
        ({"remote": True}, remote(ok=True), None),
        ({"remote": True, "country": "CA"}, remote(countries=["US"]), "location"),
        ({"remote": True, "country": "us"}, remote(countries=["US"]), None),
        ({"remote": True}, remote(countries=["US"]), None),
        ({"remote": True, "country": "CA"}, remote(timezones=["UTC"]), None),
        (city("Boston"), cities(), "location"),
        (city(), cities(), None),
        (city(country="us"), cities(), None),
        (city(country=None), cities(), None),
        (city(), cities(country=""), None),
        (city(country="CA"), cities(), "location"),
        (city("NYC"), cities(aliases={"NYC": "New York"}), None),
        (city(), cities("NYC", aliases={"NYC": "New York"}), None),
        (city("NEW-YORK"), cities(), None),
        (city(arrangement="hybrid"), cities(arrangements=["onsite"]), "location"),
        (city(arrangement="onsite"), cities(arrangements=["onsite"]), None),
        (city(), cities(arrangements=[]), None),
        ({"remote": False}, cities(), None),
        ({"city": "Boston", "remote": None}, cities(), None),
        (client(total_spent=10), limits(min_spend=20), "upwork_client"),
        (client(total_spent=20), limits(min_spend=20), None),
        (
            client(total_hires=1, total_posted_jobs=4),
            limits(min_hire_rate=0.5),
            "upwork_client",
        ),
        (client(total_hires=2, total_posted_jobs=4), limits(min_hire_rate=0.5), None),
        (client(total_hires=0, total_posted_jobs=0), limits(min_hire_rate=0.5), None),
        (client(total_hires=0), limits(min_hire_rate=0.5), None),
        (client(total_posted_jobs=4), limits(min_hire_rate=0.5), None),
        (
            client(payment_verified=False),
            limits(payment_verified=True),
            "upwork_client",
        ),
        (client(payment_verified=True), limits(payment_verified=True), None),
        (client(payment_verified=False), limits(payment_verified=False), None),
        (
            client(),
            limits(min_spend=20, min_hire_rate=0.5, payment_verified=True),
            None,
        ),
        ({}, limits(min_spend=20, min_hire_rate=0.5, payment_verified=True), None),
        (client(total_spent=0) | {"source": "hotfix"}, limits(min_spend=20), None),
        (
            {"source": "upwork", "company": "Acme"},
            breakers(companies=["Acme"]) | {"work_types": ["contract"]},
            "deal_breaker",
        ),
        (
            pay("hour", 1) | {"source": "upwork"},
            floor(hourly_floor=20) | {"work_types": ["contract"]},
            "work_type",
        ),
        (
            pay("hour", 1) | {"remote": True},
            floor(hourly_floor=20) | remote(ok=False),
            "pay",
        ),
        (
            client(total_spent=0) | {"remote": True},
            limits(min_spend=20) | remote(ok=False),
            "location",
        ),
    ],
)
def test_filter_reason(job, preferences, expected):
    candidate = Candidate.model_validate(
        {
            "source": "hotfix",
            "source_id": "1",
            "link": "https://example.com/1",
            "title": "Engineer",
        }
        | job
    )
    reason = filter_reason(
        candidate, Preferences.model_validate({"roles": []} | preferences)
    )
    if expected is None:
        assert reason is None
    else:
        assert reason is not None and reason.startswith(f"{expected}: ")
        assert reason.removeprefix(f"{expected}: ").strip()
