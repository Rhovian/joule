"""Compare stored Job destinations without following page-supplied URLs."""

import json
from urllib.parse import parse_qsl, urlsplit


def url_key(value):
    # urllib parses URLs but does not equate ATS form routes or tracking parameters:
    # https://docs.python.org/3.12/library/urllib.parse.html
    try:
        url = urlsplit(value or "")
        if url.scheme not in ("http", "https") or not url.hostname:
            return None
        path = url.path.rstrip("/")
        if url.hostname == "jobs.lever.co":
            path = path.removesuffix("/apply")
        if url.hostname == "jobs.ashbyhq.com":
            path = path.removesuffix("/application")
        query = tuple(
            sorted(
                (k, v)
                for k, v in parse_qsl(url.query, keep_blank_values=True)
                if not k.startswith("utm_") and k not in ("gh_src", "lever-source")
            )
        )
        return url.scheme, url.netloc.lower(), path, query
    except ValueError:
        return None


def resolve(db, url):
    key = url_key(url)
    matches = set()
    for row in db.execute(
        "SELECT id, primary_id, link, extra FROM jobs WHERE source!='upwork'"
    ):
        extra = json.loads(row["extra"] or "{}")
        links = (row["link"], extra.get("apply_url"), extra.get("application_url"))
        if key and any(url_key(link) == key for link in links):
            matches.add(row["primary_id"] or row["id"])
    # URL normalization can collide; leave ambiguous matches to the operator.
    if len(matches) == 1:
        row = db.execute(
            "SELECT id,title,company,source FROM jobs WHERE id=? AND source!='upwork' AND primary_id IS NULL",
            (matches.pop(),),
        ).fetchone()
        return dict(row) if row else None
    return None
