from math import ceil

from joule.sources import Candidate
from joule.upwork_auth import GRAPHQL_URL, UpworkAuth

SEARCH_QUERY = """
query Search($filter: MarketplaceJobPostingsSearchFilter) {
  marketplaceJobPostingsSearch(
    marketPlaceJobFilter: $filter, sortAttributes: [{field: RECENCY}]
  ) {
    edges { node {
      id title description ciphertext publishedDateTime
      amount { rawValue currency }
      hourlyBudgetMin { rawValue currency }
      hourlyBudgetMax { rawValue currency }
      job { contractTerms { contractType } }
      client {
        totalSpent { rawValue currency } totalHires totalPostedJobs
        verificationStatus location { city country state }
      }
    } }
  }
}
"""
SCREENING_QUERY = """
query Screening($id: ID!) {
  marketplaceJobPosting(id: $id) {
    contractorSelection { proposalRequirement {
      screeningQuestions { question sequenceNumber }
    } }
  }
}
"""


class UpworkError(Exception):
    pass


async def _query(auth: UpworkAuth, query: str, variables: dict) -> dict:
    token = await auth.access_token()
    response = await auth.client.post(
        GRAPHQL_URL,
        headers={"Authorization": f"Bearer {token}"},
        json={"query": query, "variables": variables},
    )
    if not response.is_success:
        raise UpworkError(response.status_code)
    body = response.json()
    if body.get("errors"):
        raise UpworkError(body["errors"][0]["message"])
    return body["data"]


def _amount(money: dict | None) -> float | None:
    return (float(money["rawValue"]) or None) if money else None


def _candidate(node: dict) -> Candidate:
    terms = (node.get("job") or {}).get("contractTerms") or {}
    period = {"HOURLY": "hour", "FIXED": "fixed"}.get(terms.get("contractType"))
    low = node.get("hourlyBudgetMin") if period == "hour" else node.get("amount")
    high = node.get("hourlyBudgetMax") if period == "hour" else low
    client = node.get("client") or {}
    verification = client.get("verificationStatus")
    ciphertext = node["ciphertext"]
    link = "https://www.upwork.com/jobs/" + (
        ciphertext if ciphertext.startswith("~") else "~" + ciphertext
    )
    return Candidate(
        source="upwork",
        source_id=node["id"],
        link=link,
        title=node["title"],
        description=node.get("description"),
        remote=True,
        posted_at=node.get("publishedDateTime"),
        pay_min=_amount(low),
        pay_max=_amount(high),
        pay_currency=(low or high or {}).get("currency"),
        pay_period=period,
        extra={
            "client": {
                "total_spent": _amount(client.get("totalSpent")),
                "total_hires": client.get("totalHires"),
                "total_posted_jobs": client.get("totalPostedJobs"),
                "payment_verified": verification == "VERIFIED",
                "location": client.get("location"),
            }
        },
    )


async def search(
    auth: UpworkAuth,
    roles: list[str],
    hourly_floor: float | None,
    fixed_floor: float | None,
    payment_verified: bool,
) -> list[Candidate]:
    filters = {
        "pagination_eq": {"first": 50},
        "verifiedPaymentOnly_eq": payment_verified,
    }
    if hourly_floor is not None:
        filters["hourlyRate_eq"] = {"rangeStart": ceil(hourly_floor)}
    if fixed_floor is not None:
        filters["budgetRange_eq"] = {"rangeStart": ceil(fixed_floor)}
    candidates = {}
    for role in roles:
        data = await _query(
            auth, SEARCH_QUERY, {"filter": {**filters, "searchExpression_eq": role}}
        )
        for edge in data["marketplaceJobPostingsSearch"]["edges"]:
            node = edge["node"]
            if node["id"] not in candidates:
                candidates[node["id"]] = _candidate(node)
    return list(candidates.values())


async def screening_questions(auth: UpworkAuth, job_id: str) -> list[str]:
    data = await _query(auth, SCREENING_QUERY, {"id": job_id})
    job = data["marketplaceJobPosting"] or {}
    selection = job.get("contractorSelection") or {}
    requirement = selection.get("proposalRequirement") or {}
    questions = requirement.get("screeningQuestions") or []
    return [q["question"] for q in sorted(questions, key=lambda q: q["sequenceNumber"])]


async def submit_proposal(auth, job_reference, amount, cover, answers, boost):
    identity = await _query(auth, "{ user { id nid } organization { id } }", {})
    user = identity["user"]
    payload = {
        "jobReference": job_reference,
        "chargedAmount": amount,
        "coverLetter": cover,
        "teamOrgId": identity["organization"]["id"],
        "selectedContractor": {"id": user["id"], "oDeskUserID": user["nid"]},
    }
    if answers:
        payload["questions"] = answers
    if boost > 0:
        payload["boostBidAmount"] = boost
    mutation = "mutation Submit($input: CreateJobProposalInput!) { createJobProposal(input: $input) { newProposalId status error } }"
    data = await _query(auth, mutation, {"input": payload})
    result = data["createJobProposal"]
    if result.get("error"):
        raise UpworkError(result["error"])
    return result


async def connects_balance(auth):
    data = await _query(auth, "{ connectsSummary { connectsBalance } }", {})
    return data["connectsSummary"]["connectsBalance"]
