from datetime import datetime
from xml.etree import ElementTree

import httpx

from joule.sources import Candidate

JOBS_URLS = tuple(
    f"https://www.reddit.com/r/{subreddit}/new/.rss"
    for subreddit in ("forhire", "hiring")
)
USER_AGENT = "joule/0.1 (job discovery; https://github.com/Rhovian/joule)"
ATOM = "{http://www.w3.org/2005/Atom}"


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
    published = entry.findtext(f"{ATOM}published") or entry.findtext(f"{ATOM}updated")
    return Candidate(
        source="reddit",
        source_id=source_id,
        link=link,
        title=title,
        description=entry.findtext(f"{ATOM}content"),
        posted_at=datetime.fromisoformat(published) if published else None,
    )


async def search(client: httpx.AsyncClient) -> list[Candidate]:
    candidates = {}
    for url in JOBS_URLS:
        response = await client.get(url, headers={"User-Agent": USER_AGENT})
        response.raise_for_status()
        # Python 3.12 ElementTree handles Atom namespaces, but not Job selection
        # or ID dedup: https://docs.python.org/3.12/library/xml.etree.elementtree.html
        feed = ElementTree.fromstring(response.content)
        for entry in feed.findall(f"{ATOM}entry"):
            candidate = _candidate(entry)
            if candidate is not None:
                candidates.setdefault(candidate.source_id, candidate)
    return list(candidates.values())
