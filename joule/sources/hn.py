import re

import httpx

from joule.filters import plain_text
from joule.sources import Candidate

API_URL = "https://hn.algolia.com/api/v1"


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
        header = plain_text(text.split("<p>", 1)[0]).strip()
        candidates.append(
            Candidate(
                source="hn",
                source_id=str(comment["id"]),
                link=f"https://news.ycombinator.com/item?id={comment['id']}",
                title=header,
                company=header.split("|", 1)[0].strip() if "|" in header else None,
                remote=True
                if re.search(r"\bremote\b", header, re.IGNORECASE)
                else None,
                description=text,
                posted_at=comment.get("created_at"),
            )
        )
    return candidates
