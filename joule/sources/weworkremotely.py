from email.utils import parsedate_to_datetime
from xml.etree import ElementTree

import httpx

from joule.sources import BROWSER_USER_AGENT, Candidate

JOBS_URL = "https://weworkremotely.com/remote-jobs.rss"


def _candidate(item: ElementTree.Element) -> Candidate:
    title = item.findtext("title") or ""
    company, separator, role = title.partition(": ")
    link = item.findtext("link") or ""
    published = item.findtext("pubDate")
    return Candidate(
        source="weworkremotely",
        source_id=item.findtext("guid") or link,
        link=link,
        title=role if separator else title,
        company=company if separator else None,
        description=item.findtext("description"),
        location_raw=item.findtext("region"),
        country=item.findtext("country"),
        remote=True,
        posted_at=parsedate_to_datetime(published) if published else None,
    )


async def search(client: httpx.AsyncClient) -> list[Candidate]:
    response = await client.get(JOBS_URL, headers={"User-Agent": BROWSER_USER_AGENT})
    response.raise_for_status()
    feed = ElementTree.fromstring(response.content)
    return [_candidate(item) for item in feed.findall("./channel/item")]
