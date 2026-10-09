import re

from joule.config import Preferences
from joule.sources import Candidate


def tidy(text: str) -> str:
    words = re.sub(r"[^\w\s]", " ", text.lower()).split()
    return " ".join(word for word in words if word not in {"inc", "ltd"})


def location_unclear(candidate: Candidate) -> bool:
    return not candidate.remote and candidate.city is None


def filter_reason(candidate: Candidate, preferences: Preferences) -> str | None:
    breakers = preferences.deal_breakers
    if candidate.company is not None and any(
        tidy(candidate.company) == tidy(company) for company in breakers.companies
    ):
        return f"deal_breaker: company {candidate.company}"
    text = f"{candidate.title}\n{candidate.description or ''}"
    for keyword in breakers.keywords:
        if re.search(rf"(?<!\w){re.escape(keyword)}(?!\w)", text, re.IGNORECASE):
            return f"deal_breaker: keyword {keyword}"

    if (
        candidate.source == "upwork"
        and preferences.work_types
        and "freelance" not in preferences.work_types
    ):
        return "work_type: freelance not allowed"

    amounts = [p for p in (candidate.pay_min, candidate.pay_max) if p is not None]
    pay = preferences.pay
    floor = {"hour": pay.hourly_floor, "fixed": pay.fixed_floor}.get(
        candidate.pay_period
    )
    if candidate.pay_period == "year" and not (
        candidate.pay_currency
        and pay.currency
        and candidate.pay_currency.casefold() != pay.currency.casefold()
    ):
        floor = pay.salary_floor
    if amounts and floor is not None and max(amounts) < floor:
        return f"pay: {max(amounts):g} below {floor:g} per {candidate.pay_period}"

    locations = preferences.locations
    if candidate.remote is True:
        if not locations.remote.ok:
            return "location: remote not allowed"
        if (
            locations.remote.countries
            and candidate.country
            and candidate.country.casefold()
            not in {country.casefold() for country in locations.remote.countries}
        ):
            return f"location: remote country {candidate.country} not allowed"
    elif candidate.remote is False and candidate.city is not None:
        aliases = {tidy(key): tidy(value) for key, value in locations.aliases.items()}

        def city_name(name: str) -> str:
            return aliases.get(tidy(name), tidy(name))

        match = next(
            (
                city
                for city in locations.cities
                if city_name(candidate.city) == city_name(city.city)
                and (
                    not candidate.country
                    or not city.country
                    or candidate.country.casefold() == city.country.casefold()
                )
            ),
            None,
        )
        if match is None:
            return f"location: city {candidate.city} not allowed"
        if candidate.arrangement and candidate.arrangement not in match.arrangements:
            return f"location: arrangement {candidate.arrangement} not allowed"

    if candidate.source == "upwork":
        client = candidate.extra.get("client") or {}
        limits = preferences.upwork_client
        spent = client.get("total_spent")
        if (
            spent is not None
            and limits.min_spend is not None
            and spent < limits.min_spend
        ):
            return "upwork_client: spend below minimum"
        hires, posted = client.get("total_hires"), client.get("total_posted_jobs")
        if (
            hires is not None
            and posted
            and limits.min_hire_rate is not None
            and hires / posted < limits.min_hire_rate
        ):
            return "upwork_client: hire rate below minimum"
        if limits.payment_verified and client.get("payment_verified") is False:
            return "upwork_client: payment unverified"
    return None
