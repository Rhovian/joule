import asyncio
import logging
import re
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree

import httpx

from joule.sources import Candidate

JOBS_URLS = tuple(
    f"https://www.reddit.com/r/{subreddit}/new/.rss"
    for subreddit in ("forhire", "hiring")
)
USER_AGENT = "joule/0.1 (job discovery; https://github.com/Rhovian/joule)"
ATOM = "{http://www.w3.org/2005/Atom}"
# Source vocabulary on top of stdlib word boundaries (no built-in role classifier):
# https://docs.python.org/3.12/library/re.html
# Bare engineer is deliberately broad; Go needs language context, unlike golang.
SOFTWARE = re.compile(
    r"\b(?:developers?|engineers?|programmers?|software|back[ -]?end|front[ -]?end|"
    r"full[ -]?stack|devops|sre|golang|go (?:language|programming)|rust|python|"
    r"javascript|typescript|react|node\.?js|java|kotlin|swift|csharp|dotnet)\b",
    re.IGNORECASE,
)


def _candidate(entry: ElementTree.Element) -> Candidate | None:
    title = entry.findtext(f"{ATOM}title") or ""
    source_id = entry.findtext(f"{ATOM}id")
    link = next(
        (
            node.get("href")
            for node in entry.findall(f"{ATOM}link")
            if node.get("rel", "alternate") == "alternate"
        ),
        None,
    )
    if not title.lstrip().lower().startswith("[hiring]") or not source_id or not link:
        return None
    description = entry.findtext(f"{ATOM}content")
    if not SOFTWARE.search(f"{title} {description or ''}"):
        return None
    published = entry.findtext(f"{ATOM}published") or entry.findtext(f"{ATOM}updated")
    return Candidate(
        source="reddit",
        source_id=source_id,
        link=link,
        title=title,
        description=description,
        posted_at=datetime.fromisoformat(published) if published else None,
    )


def _retry_delay(response: httpx.Response) -> float:
    value = response.headers.get("Retry-After", "15")
    try:
        delay = float(value)
    except ValueError:
        try:
            delay = (parsedate_to_datetime(value) - datetime.now(UTC)).total_seconds()
        except (ValueError, TypeError, OverflowError):
            delay = 15
    return max(0, min(delay, 20))


async def search(client: httpx.AsyncClient) -> list[Candidate]:
    candidates, failures = {}, []
    for index, url in enumerate(JOBS_URLS):
        if index:
            await asyncio.sleep(5)
        try:
            response = await client.get(url, headers={"User-Agent": USER_AGENT})
            # HTTPX 0.28.1 transports only retry connection failures, not 429s:
            # https://github.com/encode/httpx/blob/0.28.1/httpx/_transports/default.py
            if response.status_code == 429:
                await asyncio.sleep(_retry_delay(response))
                response = await client.get(url, headers={"User-Agent": USER_AGENT})
            response.raise_for_status()
            # Python 3.12 ElementTree handles Atom namespaces, but not Job selection
            # or ID dedup: https://docs.python.org/3.12/library/xml.etree.elementtree.html
            feed = ElementTree.fromstring(response.content)
        except (httpx.HTTPError, ElementTree.ParseError) as error:
            logging.getLogger(__name__).exception("Reddit feed %s failed", url)
            failures.append(error)
            continue
        for entry in feed.findall(f"{ATOM}entry"):
            candidate = _candidate(entry)
            if candidate is not None:
                candidates.setdefault(candidate.source_id, candidate)
    if len(failures) == len(JOBS_URLS):
        raise failures[-1]
    return list(candidates.values())
