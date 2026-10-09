import json
import re

import httpx

from joule.sources import Candidate

JOBS_URL = "https://getarustjob.com/jobs"


async def _payload(client: httpx.AsyncClient, url: str) -> str:
    response = await client.get(url)
    response.raise_for_status()
    chunks = []
    for match in re.finditer(r"self\.__next_f\.push\((.*?)\)</script>", response.text):
        data = json.loads(match[1])
        if len(data) > 1 and data[0] == 1:
            chunks.append(data[1])
    return "".join(chunks)


async def search(client: httpx.AsyncClient) -> list[Candidate]:
    candidates = {}
    for page in range(1, 21):
        payload = await _payload(client, f"{JOBS_URL}?page={page}")
        match = re.search(r'"jobs":', payload)
        if match:
            jobs, _ = json.JSONDecoder().raw_decode(payload[match.end() :])
            if not isinstance(jobs, list):
                raise ValueError("getarustjob: invalid Jobs list")
        elif (
            '"listingPath":"/jobs"' in payload
            and '"children":"No more jobs on this page."' in payload
        ):
            jobs = []
        else:
            raise ValueError("getarustjob: Jobs list not found")
        if not jobs:
            break
        for node in jobs:
            candidates[node["id"]] = Candidate(
                source="getarustjob",
                source_id=node["id"],
                link=f"{JOBS_URL}/{node['slug']}",
                title=node["title"],
                company=node.get("company_name"),
                location_raw="; ".join(
                    filter(None, [node.get("location"), *(node.get("countries") or [])])
                )
                or None,
                remote=True if "Remote" in (node.get("remote_types") or []) else None,
                posted_at=node.get("approved_at"),
                extra={"slug": node["slug"]},
            )
    return list(candidates.values())


async def description(
    client: httpx.AsyncClient, slug: str, candidate: Candidate | None = None
) -> str | None:
    payload = await _payload(client, f"{JOBS_URL}/{slug}")
    for match in re.finditer(r'\{"@context":', payload):
        node, _ = json.JSONDecoder().raw_decode(payload[match.start() :])
        if node.get("@type") != "JobPosting":
            continue
        salary = node.get("baseSalary") or {}
        value = salary.get("value") or {}
        if candidate is not None and value.get("unitText") == "YEAR":
            candidate.pay_min = value.get("minValue") or None
            candidate.pay_max = value.get("maxValue") or None
            candidate.pay_currency = salary.get("currency")
            candidate.pay_period = "year"
        return node.get("description")
    raise ValueError("getarustjob: JobPosting not found")
