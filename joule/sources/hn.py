import re
from html.parser import HTMLParser

import httpx

from joule.countries import COUNTRY_NAMES
from joule.filters import plain_text
from joule.sources import Candidate

API_URL = "https://hn.algolia.com/api/v1"
COUNTRIES = re.compile(
    r"\b(?:"
    + "|".join(re.escape(n) for names in COUNTRY_NAMES for n in names[2:])
    + r")\b",
    re.IGNORECASE,
)
PLACES = re.compile(
    r"\b(?:US|USA|UK|EU|EEA|EMEA|APAC|LATAM|NYC|SF|Berlin|London|San Francisco|New York|"
    r"North America|South America|Europe|Worldwide|Global|Toronto|Utrecht|Amsterdam|"
    r"Boston|Seattle|Austin|Dallas|Chicago|Paris|Munich|Zurich|Los Angeles|San Diego|"
    r"San Mateo|Berkeley|Copenhagen|Stockholm|Vancouver|Tokyo|Sydney|Hong Kong)\b"
)


# httpx==0.28.1 (uv.lock), httpx/_models.py:Response.json only decodes JSON;
# HN's free-text header has no structured fields supplied by the dependency.
ROLE = re.compile(
    r"\b(engineers?|engineering|developers?|SWE|roles?|manager|designer|lead)\b",
    re.IGNORECASE,
)
MONEY = re.compile(
    r"(?P<currency>[$€£]|USD|EUR|GBP)?\s*(?P<low>\d[\d,]*(?:\.\d+)?)\s*(?P<lk>[kK])?"
    r"(?:\s*(?:[-–—]|to)\s*(?P<hcurrency>[$€£]|USD|EUR|GBP)?\s*(?P<high>\d[\d,]*(?:\.\d+)?)\s*(?P<hk>[kK])?)?"
    r"\s*(?P<suffix>USD|EUR|GBP|[$€£])?"
    r"\s*(?:base|salary)?\s*(?:per year|/year|/yr|annually|yearly)?\s*",
    re.IGNORECASE,
)


def parse_header(header: str) -> dict:
    urls = re.findall(r"https?://[^\s|<>()]+", header)
    clean = re.sub(r"https?://[^\s|<>()]+", "", header)
    parts = [
        p.strip()
        for p in re.split(
            r"\s*[|]\s*|\s+[—–-]\s+(?!(?:[$€£]|[A-Za-z]{3}\s*)?\d)", clean
        )
        if p.strip()
    ]
    fields = {"title": header[:200], "extra": {"urls": urls} if urls else {}}
    modes = set(re.findall(r"\b(remote|onsite|on-site|hybrid)\b", clean, re.IGNORECASE))
    modes = {m.lower().replace("-", "") for m in modes}
    if "remote" in modes:
        fields["remote"] = True
    elif modes and "remote" not in modes:
        fields.update(
            remote=False, arrangement="hybrid" if "hybrid" in modes else "onsite"
        )
    if len(parts) < 2:
        return fields
    fields["company"] = (
        re.sub(
            r"\((?:YC\b|Series\b|Remote\b)[^)]*\)|\(\s*\)",
            "",
            parts[0],
            flags=re.IGNORECASE,
        ).strip()
        or None
    )
    for part in parts[1:]:
        if ROLE.search(part):
            if fields["title"] == header[:200]:
                fields["title"] = part[:200]
            continue
        # Full consumption rejects unsupported periods and partial range matches.
        cash = re.split(r"\+|\bequity\b", part, flags=re.IGNORECASE)[0]
        match = MONEY.fullmatch(cash.strip())
        if match:
            g = match.groupdict()
            currencies = {
                {"$": "USD", "€": "EUR", "£": "GBP"}.get(c, c.upper())
                for c in (g["currency"], g["hcurrency"], g["suffix"])
                if c
            }
            currency = next(iter(currencies)) if len(currencies) == 1 else None
            if currency and (
                g["lk"] or g["hk"] or float(g["low"].replace(",", "")) >= 10000
            ):
                lo = float(g["low"].replace(",", "")) * (
                    1000 if g["lk"] or g["hk"] else 1
                )
                hi = (
                    float(g["high"].replace(",", "")) * (1000 if g["hk"] else 1)
                    if g["high"]
                    else lo
                )
                if hi >= lo:
                    fields.update(
                        pay_min=lo,
                        pay_max=hi,
                        pay_period="year",
                        pay_currency=currency,
                    )
                continue
        if re.search(
            r"full.?time|part.?time|visa|relocation|salary|equity|sponsor|https|/|\d",
            part,
            re.IGNORECASE,
        ):
            continue
        location = re.sub(
            r"\b(remote|onsite|on-site|hybrid)\b\s*(?:in\b)?",
            "",
            part,
            flags=re.IGNORECASE,
        ).strip(" ():,-")
        # Keep raw geography only: multiple cities and remote regions are not a
        # single city/country and must not activate those stricter cheap filters.
        if location and (COUNTRIES.search(location) or PLACES.search(location)):
            fields.setdefault("location_raw", location)
    return fields


# Python >=3.12 (pyproject.toml), html/parser.py:HTMLParser handles quoted
# attributes and entity decoding; use it rather than a custom HTML matcher.
class HeaderLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        href = dict(attrs).get("href")
        if tag == "a" and href and href.startswith(("https://", "http://")):
            self.urls.append(href)


async def search(client: httpx.AsyncClient) -> list[Candidate]:
    response = await client.get(
        f"{API_URL}/search_by_date",
        params={"tags": "story,author_whoishiring", "hitsPerPage": 20},
    )
    response.raise_for_status()
    thread = next(
        (
            hit["objectID"]
            for hit in response.json()["hits"]
            if (hit.get("title") or "").startswith("Ask HN: Who is hiring?")
        ),
        None,
    )
    if thread is None:
        raise ValueError("No HN Who is hiring? story found")
    response = await client.get(f"{API_URL}/items/{thread}")
    response.raise_for_status()
    candidates = []
    for comment in response.json()["children"]:
        text = comment.get("text")
        if not text:
            continue
        header_html = text.split("<p>", 1)[0]
        header = plain_text(header_html).strip()
        fields = parse_header(header)
        links = HeaderLinks()
        links.feed(header_html)
        urls = list(dict.fromkeys(fields["extra"].get("urls", []) + links.urls))
        if urls:
            fields["extra"]["urls"] = urls
        candidates.append(
            Candidate(
                source="hn",
                source_id=str(comment["id"]),
                link=f"https://news.ycombinator.com/item?id={comment['id']}",
                **fields,
                description=text,
                posted_at=comment.get("created_at"),
            )
        )
    return candidates
