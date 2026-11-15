import html
import re

from joule.config import Preferences
from joule.countries import COUNTRY_KEYS, country_key
from joule.sources import Candidate

US_NAMES = {"us", "usa", "united states", "united states of america"}


def plain_text(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]*>", " ", text))


def tidy(text: str) -> str:
    words = re.sub(r"[^\w\s]", " ", text.lower()).split()
    return " ".join(word for word in words if word not in {"inc", "ltd"})


# httpx==0.28.1 (uv.lock), Response.json() only decodes payloads; it does
# not interpret Source location strings or prose. Keep that interpretation here
# so new Candidates and the startup backfill use identical evidence.
CITY_ALIASES = {"nyc": "New York", "new york city": "New York", "sf": "San Francisco"}
REGIONS = {
    "remote",
    "worldwide",
    "global",
    "europe",
    "north america",
    "united",
    "alabama",
    "alaska",
    "arizona",
    "arkansas",
    "california",
    "colorado",
    "connecticut",
    "delaware",
    "florida",
    "georgia",
    "hawaii",
    "idaho",
    "illinois",
    "indiana",
    "iowa",
    "kansas",
    "kentucky",
    "louisiana",
    "maine",
    "maryland",
    "massachusetts",
    "michigan",
    "minnesota",
    "mississippi",
    "missouri",
    "montana",
    "nebraska",
    "nevada",
    "new hampshire",
    "new jersey",
    "new mexico",
    "north carolina",
    "north dakota",
    "ohio",
    "oklahoma",
    "oregon",
    "pennsylvania",
    "rhode island",
    "south carolina",
    "south dakota",
    "tennessee",
    "texas",
    "utah",
    "vermont",
    "virginia",
    "washington",
    "west virginia",
    "wisconsin",
    "wyoming",
    "england",
    "scotland",
    "wales",
}
PROSE_CITIES = r"New York City|New York|NYC|San Francisco|SF|London|Boston|Seattle|Austin|Chicago|Los Angeles|Toronto|Berlin|Paris|Boise"


def normalize_location(candidate: Candidate) -> Candidate:
    if candidate.source not in {"hotfix", "freehire", "getarustjob"}:
        return candidate
    cities, countries = [], []
    for part in re.split(r";|\s+or\s+|\|", candidate.location_raw or ""):
        part = re.sub(r"\s*-\s*(?:hybrid|on-?site)\b", "", part, flags=re.IGNORECASE)
        fields = [field.strip() for field in part.split(",") if field.strip()]
        if not fields:
            continue
        for field in fields:
            if field.casefold() in COUNTRY_KEYS and (
                len(field) > 3 or len(fields) == 1
            ):
                countries.append(field)
        name = fields[0]
        key = name.casefold()
        if (
            key not in COUNTRY_KEYS
            and key not in REGIONS
            and re.fullmatch(r"[^\W\d_]+(?:[ .’'’-][^\W\d_]+)*", name)
            and not re.search(
                r"\b(remote|zone|technologies|compiler)\b", name, re.IGNORECASE
            )
        ):
            cities.append(CITY_ALIASES.get(key, name))
    # Prose needs an explicit work-location cue; an incidental city mention is
    # not evidence that the Job is based there. Structured fields take priority.
    text = plain_text(candidate.description or "")
    matches = list(
        re.finditer(
            rf"\b(?P<mode>on-?site|hybrid)\s+(?:in\s+)?(?P<city>{PROSE_CITIES})\b",
            text,
            re.IGNORECASE,
        )
    )
    if not cities and not candidate.city:
        cities = [CITY_ALIASES.get(m["city"].casefold(), m["city"]) for m in matches]
        if cities and candidate.remote is None:
            candidate.remote = False
            candidate.arrangement = matches[0]["mode"].lower().replace("-", "")
    if not candidate.city and cities:
        # Preserve every alternative; filtering accepts any permitted city.
        candidate.city = "; ".join(dict.fromkeys(cities))
    if not candidate.country and len({country_key(c) for c in countries}) == 1:
        candidate.country = countries[0]
    return candidate


def location_unclear(candidate: Candidate) -> bool:
    normalize_location(candidate)
    return not candidate.remote and candidate.city is None


def filter_reason(candidate: Candidate, preferences: Preferences) -> str | None:
    normalize_location(candidate)
    breakers = preferences.deal_breakers
    if candidate.company is not None and any(
        tidy(candidate.company) == tidy(company) for company in breakers.companies
    ):
        return f"deal_breaker: company {candidate.company}"
    description = plain_text(candidate.description or "")
    text = f"{candidate.title}\n{description}"
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
    client_country = None
    if candidate.source == "upwork":
        client = candidate.extra.get("client") or {}
        client_country = (client.get("location") or {}).get("country")
    for term in locations.exclude:
        if (
            (client_country and country_key(client_country) == country_key(term))
            or (
                candidate.country
                and country_key(candidate.country) == country_key(term)
            )
            or (
                candidate.remote is not True
                and re.search(
                    rf"\b{re.escape(term)}\b",
                    f"{candidate.location_raw or ''}; {candidate.city or ''}",
                    re.IGNORECASE,
                )
            )
        ):
            return f"location: {term} excluded"
    if (
        candidate.remote is not True
        and locations.onsite_countries
        and candidate.country
        and country_key(candidate.country)
        not in {country_key(country) for country in locations.onsite_countries}
    ):
        return f"location: onsite country {candidate.country} not allowed"
    if candidate.remote is True:
        if not locations.remote.ok:
            return "location: remote not allowed"
        if (
            locations.remote.countries
            and candidate.country
            and country_key(candidate.country)
            not in {country_key(country) for country in locations.remote.countries}
        ):
            return f"location: remote country {candidate.country} not allowed"
    elif candidate.remote is False and candidate.city is not None and locations.cities:
        aliases = {tidy(key): tidy(value) for key, value in locations.aliases.items()}

        def city_name(name: str) -> str:
            name = CITY_ALIASES.get(name.strip().casefold(), name)
            return aliases.get(tidy(name), tidy(name))

        matches = [
            city
            for city in locations.cities
            if any(
                city_name(name) == city_name(city.city)
                for name in candidate.city.split(";")
            )
            and (
                not candidate.country
                or not city.country
                or country_key(candidate.country) == country_key(city.country)
            )
        ]
        if not matches:
            return f"location: city {candidate.city} not allowed"
        if candidate.arrangement and not any(
            candidate.arrangement in city.arrangements for city in matches
        ):
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
        country = (client.get("location") or {}).get("country") or ""
        if (
            limits.require_hires_outside_us
            and country.casefold() not in US_NAMES
            and not client.get("total_hires")
        ):
            return "upwork_client: no hires outside US"
    return None
