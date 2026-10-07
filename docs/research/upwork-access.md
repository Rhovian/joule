# Upwork access for joule

Research date: 2026-10-07. Ticket: [Rhovian/joule#2](https://github.com/Rhovian/joule/issues/2).

**Answer and recommendation**

- Pursue an approved, personal-use GraphQL integration; an active freelancer account alone is insufficient for approval. [API eligibility](https://support.upwork.com/hc/en-us/articles/115015857647-How-to-request-an-API-key-from-Upwork)
- RSS is unavailable: Upwork discontinued it after August 20, 2024. [Official retirement notice](https://support.upwork.com/hc/en-us/articles/52052528243731-RSS-deprecation)
- Avoid scraping an active account: unauthorized automation can cause warnings, temporary restrictions, or permanent blocks, even when it never submits Proposals. [Automation policy](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly)
- Recommendation: start with a bounded, owner-directed Scan after approval; obtain written clarification for scheduled monitoring, AI scoring, and retention before enabling them. These are unresolved under the new terms. [API/MCP terms §§4.1,5.9,8](https://upwork.pactsafe.io/versions/6ac41c2c2bb860f4d1fddb26.pdf)

## Official GraphQL: access and approval

Upwork documents `https://api.upwork.com/graphql`, OAuth2, `marketplaceJobPostingsSearch`, pagination, and `RECENCY` sorting. Request **Read marketplace Job Postings**; `marketplaceJobPostings` is deprecated. The separate `publicMarketplaceJobPostingsSearch` requires **Read public marketplace Job Postings**; “public” does not mean unauthenticated access. [API reference: Getting Started, marketplace queries](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html)

Clients and freelancers on any membership plan may apply. Requirements: authentic name, address, photo, verified payment method, completed identity verification, **$25,000 lifetime earnings/spend combined**, **90%+ Job Success Score** for freelancers/agencies, and good standing. Describe the application, role, internal/public use, and confirm the **40,000 requests/day** limit and no Upwork branding. Personal/internal use only; commercial use is unsupported. Decision takes approximately one week; no sandbox/test accounts are provided. Approval is reviewed rather than automatic. [Official application requirements](https://support.upwork.com/hc/en-us/articles/115015857647-How-to-request-an-API-key-from-Upwork)

## Fields and practical availability

| Access path | Budget | Client history | Screening questions |
| --- | --- | --- | --- |
| Authenticated marketplace GraphQL | Search `amount` (nullable fixed budget), `hourlyBudgetMin`, `hourlyBudgetMax`, `weeklyBudget` | Search `client`: `totalHires`, `totalPostedJobs`, `totalSpent`, `verificationStatus`, `totalReviews`, `totalFeedback`; membership date deprecated | Detail `marketplaceJobPosting` → `contractorSelection` → `proposalRequirement` → `screeningQuestions` (`question`, `sequenceNumber`) |
| Public marketplace GraphQL | Do not assume authenticated-field parity | Public client schema includes hires, posted Jobs, review/feedback counts and location; spend/rating parity unverified | Unverified for public-only scope |

The table describes documented schema, **not a successful call with this owner's permissions**. Client aggregates are not evidence of access to the client's complete contract/review history. [API reference: MarketplaceJobPostingSearchResult, MarketplaceJobPostingSearchClientInfo, MarketplaceContractorSelection, MarketplaceProposalRequirements, MarketplaceQuestion, PublicMarketplaceJobPostingsSearchClient](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html)

| Other path | Budget | Client history | Screening questions |
| --- | --- | --- | --- |
| Official RSS today | None: retired | None: retired | None: retired |
| Historical RSS | Exact former payload unverified | Exact former payload unverified | Exact former payload unverified |
| HTML/browser scraping, including Upwork-AI-jobs-applier | Extracts a string for fixed price/hourly range when visible | Applier requests joined date, location, total spend, hires, company description | Applier has no structured question list; only optional free-text `proposal_requirements` |

RSS status: [Upwork retirement notice](https://support.upwork.com/hc/en-us/articles/52052528243731-RSS-deprecation). Applier fields: [structured_outputs.py, lines 9–38](https://github.com/kaymen99/Upwork-AI-jobs-applier/blob/074dc0dbb38a841a373c1b68bccf5e56b37d1131/src/structured_outputs.py#L9). Historical RSS should not be represented as today's Source, nor should its exact fields be invented from old tutorials; an archived first-party XML response would verify them.

## What Upwork-AI-jobs-applier actually uses

Inspected upstream commit **074dc0dbb38a841a373c1b68bccf5e56b37d1131**, cloned into system temp; no installation or execution.

- It launches headless Firefox through **Playwright**, opens `/nx/search/jobs` with `sort=recency`, parses HTML links with BeautifulSoup, then opens individual Job pages in batches. This fetching path uses neither RSS nor the official GraphQL API. [scraper.py, lines 27–68](https://github.com/kaymen99/Upwork-AI-jobs-applier/blob/074dc0dbb38a841a373c1b68bccf5e56b37d1131/src/scraper.py#L27)
- It extracts the page's `<main id="main">`, converts it to Markdown, and asks `openai/gpt-4o-mini` for structured `JobInformation`; these are LLM extraction targets, not guaranteed page fields. [scraper.py, lines 108–154](https://github.com/kaymen99/Upwork-AI-jobs-applier/blob/074dc0dbb38a841a373c1b68bccf5e56b37d1131/src/scraper.py#L108)
- Its browser context chooses a random user agent; the inspected setup creates fresh contexts without an explicit account login or cookie import. That does not establish permission or prove current reliability. [utils.py, lines 92–114](https://github.com/kaymen99/Upwork-AI-jobs-applier/blob/074dc0dbb38a841a373c1b68bccf5e56b37d1131/src/utils.py#L92)
- `proposal_requirements` means instructions such as a required opening phrase. It must not be mistaken for Upwork's ordered screening questions. [structured_outputs.py, lines 36–38](https://github.com/kaymen99/Upwork-AI-jobs-applier/blob/074dc0dbb38a841a373c1b68bccf5e56b37d1131/src/structured_outputs.py#L36)
- Despite its name, the README describes generated material saved for human review/submission. Draft-only behavior therefore does not distinguish its fetching risk from joule's. [README, workflow steps 2–6](https://github.com/kaymen99/Upwork-AI-jobs-applier/blob/074dc0dbb38a841a373c1b68bccf5e56b37d1131/README.md#L39)

## ToS and active-account risks

**Scraping:** Terms of Use §3.5 prohibits unapproved scraping, including indirectly collected information. [Terms of Use](https://www.upwork.com/legal#terms-of-use)

Upwork explicitly names Job watchers, page monitors, timed refreshes, browser/session-token scripts, and website requests outside approved endpoints as enforcement risks. API approval does not authorize scraping; background polling resembling scraping or exceeding approved scope can also be flagged. There is no verified “safe” scraping frequency or draft-only exemption. Logged-in cookies would associate traffic with the active account; logged-out scraping still falls under the policy, though attribution/detection probability is unverified. [Official automation policy](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly)

**API:** The Legal Center lists API/MCP v2.4 effective **October 5, 2026** alongside older API terms; do not rely solely on the older text. [Legal Center](https://www.upwork.com/legal)

Current terms permit browsing and drafting (§4.1), but restrict corpus monitoring (§4.1), independently determined scoring/ranking (§5.9), and AI training/retrieval augmentation (§5.3). Cache limit: 24 hours, without timer-only refetches (§8.3); longer User Data retention requires consent/transparency (§8.5). Credential misuse can suspend accounts (§6.5); API access is revocable (§17). [Current API/MCP terms](https://upwork.pactsafe.io/versions/6ac41c2c2bb860f4d1fddb26.pdf)

**RSS:** The former supported path has no current account-safe endpoint established here. A third-party service returning RSS is merely an output format; its underlying acquisition requires separate verification against the automation policy. [Retirement notice](https://support.upwork.com/hc/en-us/articles/52052528243731-RSS-deprecation), [automation policy](https://support.upwork.com/hc/en-us/articles/43342677368467-Use-bots-and-other-automation-properly)

## Open risks and verification needed

1. **Owner eligibility and scopes:** unknown. Verify earnings/spend, JSS, verification, and written approval; then make a minimal authorized search/detail call to establish field access. No account-specific API call was attempted. [Eligibility](https://support.upwork.com/hc/en-us/articles/115015857647-How-to-request-an-API-key-from-Upwork)
2. **Scheduled Scan and AI score:** seek written clarification for the exact frequency, owner-selected criteria, and model behavior (§§4.1,5.9). Inference: never submitting does not resolve these restrictions. [Current terms](https://upwork.pactsafe.io/versions/6ac41c2c2bb860f4d1fddb26.pdf)
3. **SQLite retention and external LLM:** clarify retention permission, client-data consent, and model-provider data handling (§§5.3,8.5). Do not presume the owner's consent covers client data. [Current terms](https://upwork.pactsafe.io/versions/6ac41c2c2bb860f4d1fddb26.pdf)
4. **Scraper viability:** untested. A direct documentation fetch returned a page titled `Challenge - Upwork`; this proves that request was challenged, not that all scraping fails. Evidence: `/tmp/joule-upwork-research.pvGZ7B/api.html:6` (2026-10-07 `curl -L -s` of the documentation URL). The indexed official reference supplied schema evidence; authenticated responses remain unverified.
5. **Historical RSS payload and full client history:** unverified; verify via first-party archived XML and approved API responses respectively. Missing evidence must remain unknown, not become inferred fields.

Local inspection: `rg -n -i 'upwork|rss' /Users/j/code/job-ops --glob '!package-lock.json' --glob '!pnpm-lock.yaml' --glob '!yarn.lock'` at commit `cb8803c0566a1d8ec789f1f1ecf121f58ac8b769` returned only four unrelated `headersSent` matches; no Upwork/RSS implementation was identified by that search. This is a bounded search result, not proof that all branches/history lack one. No project checks were run; no source files were edited; `/Users/j/code/work-history-notes` was not read.
