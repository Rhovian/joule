# Job-ops Sources for joule

**Answer:** Working Nomads, FreeHire and Golang Jobs all returned Jobs through ordinary HTTP JSON requests; plain `httpx` is feasible for their discovery paths. Adzuna is a documented HTTP API, feasible with an App ID and App Key, but authenticated US results were **not verified** because no keys were available. Detailed verdicts and reproducible probe evidence follow; terms of use are out of scope. [Probe evidence](#command-evidence), [Adzuna authentication](https://developer.adzuna.com/overview).

These are **proposed fetch/mapping designs**, not existing joule adapters: the current adapter registry contains Hotfix, Upwork, WWR and RemoteOK, not these four. Role-search adapters receive Preferences roles; feed adapters can fetch once and filter locally. [Registry](/Users/j/code/joule/joule/scan.py:19), [Candidate contract](/Users/j/code/joule/joule/sources/__init__.py:7). Structure follows [more-sources.md](/Users/j/code/joule/docs/research/more-sources.md:1).

| Source | Access established | One-line verdict (engineering judgment) |
| --- | --- | --- |
| Working Nomads | Public JSON POST; 50 and 100 Jobs/request, distinct offset pages | **Feasible with httpx:** per-role US-inclusive searches, HTML descriptions in response; use bounded offset pagination. [WN code], probes W1–W5. |
| FreeHire | Public JSON GET; 50 Jobs/page with full Markdown descriptions | **Feasible with httpx:** per-role search, `countries=us`, offset pages; observe the documented budget and geography OR semantics. [FH code], [FH API], probes F1–F2. |
| Golang Jobs (`golangjobs`) | Public Supabase JSON GET using the site's public anon key; 1,199 distinct Jobs | **Feasible with httpx:** fetch the whole unarchived feed once, filter roles and US relevance locally; descriptions missing on 278 Jobs. [GO code], probes G1–G4. |
| Adzuna (`us`) | Documented keyed JSON GET; keyless probe HTTP 400 | **Feasible conditionally:** keys required for discovery; descriptions are snippets and full-description retrieval remains unverified. [AZ code], [AZ API], probe A1. |

Checked **2026-10-09 21:33:14–21:35:10 UTC / 15:33–15:35 Boise**. Counts are snapshots, not sustained-availability guarantees. Remote eligibility still needs original description evidence; a country/region label does not prove work authorization or unrestricted remote access. This is mapping judgment based on the location fields below and the nullable [Candidate fields](/Users/j/code/joule/joule/sources/__init__.py:14).

## Command evidence

Upstream files were read exactly with `gh api repos/DaKheera47/job-ops/contents/<path> -H 'Accept: application/vnd.github.raw'`. `gh api repos/DaKheera47/job-ops/commits/main --jq .sha` printed **`cb8803c0566a1d8ec789f1f1ecf121f58ac8b769`**; code citations below pin that inspected revision. Documentation inspected: `docs-site/docs/extractors/{working-nomads,freehire,golang-jobs,adzuna}.md`, plus `extractors/adzuna/README.md`. [WN docs], [FH docs], [GO docs], [AZ docs], [AZ README].

All live probes used Python 3 `urllib.request`, `User-Agent: joule/0.1`, `Accept: application/json`, 35-second timeout, no cookies, accounts or private credentials. Working Nomads additionally sent `Content-Type: application/json`; Golang Jobs additionally sent the public browser anon key as `apikey` and `Authorization: Bearer <same key>`, obtained from [GO code lines 9–14][GO code]. HTTP errors were caught and recorded, not interpreted as empty feeds. Command outputs below are the research evidence; repeat the script to obtain a new snapshot.

| Probe / UTC timestamp (2026-10-09) | Exact request / printed result |
| --- | --- |
| **W1**, 21:33:14 | `POST https://www.workingnomads.com/jobsapi/_search`, JSON body printed below, `size=50`: **HTTP 200**, `len(hits.hits)=50`, `hits.total={value:648,relation:eq}`. First `id=1923073`, HTML description **6,096 characters**, `pub_date=2026-10-07T12:31:06+00:00`. |
| **W2/W3**, 21:33:44 | Same body, `size=100`, respectively `from=0` and `from=100`: each **200**, **100** Jobs, same total **648**, ID intersection **0**. Total is for this role/location query, not the entire Source. |
| **W4**, 21:35:01 | Same query, `size=1`, omit `_source` projection: **200**, **1** Job; extra keys include `salary_range`, `salary_range_short`, `annual_salary_usd`, `location_extra`, `experience_level`, `expired`, `instructions`, application-email fields. |
| **W5**, 21:35:09 | Same query, `size=50`, `_source=["id","salary_range","salary_range_short","annual_salary_usd"]`: **200**, **50** Jobs; **37** with nonempty salary range or annual-USD value. Sample `id=1928260`: `salary_range="$388k-$619k per year"`, `annual_salary_usd=619000.0`. |
| **F1**, 21:33:14 | `GET https://freehire.me/api/v1/agent/jobs/search?q=software+engineer&description_format=markdown&sort=posted_at&order=desc&limit=50&offset=0&countries=US`: **200**, **50** `data` Jobs, `meta={limit:50,offset:0,total:85800}`. Headers `x-ratelimit-limit=300`, `remaining=299`, `reset=1`. |
| **F2**, 21:33:44 | Same URL with `offset=50&countries=us`: **200**, **50** Jobs, same total, URL/public-slug intersection with F1 **0**; every Job in both samples includes `us` in `countries`. F1 description lengths **2,531–17,532**, F2 **2,895–11,229**. First F1 description **7,563**; `posted_at=2026-10-09T21:26:04Z`. One enrichment has `salary_min=79800`, `salary_max=87800`, `salary_currency=USD`, `salary_period=year`. |
| **G1**, 21:33:14–21:34:19 | `GET https://mvjyjzestmcxxmmmakec.supabase.co/rest/v1/jobs?select=id,title,company,type,application_url,slug,posted_at,description,requirements,cities(name,country)&is_archived=eq.false&order=posted_at.desc&limit=200&offset=N`, URL-encoded by `urlencode`, `N=0,200,400,600,800,1000`: all **200**, counts **200/200/200/200/200/199**. First two `Content-Range` values `0-199/*`, `200-399/*`; ID intersection **0**. Across all six pages **1,199 rows/1,199 unique IDs**, **194** `cities.country="United States"`, **130** `Global`, of which **126** also `cities.name="Remote"`. |
| **G2**, same G1 bodies | **278** empty descriptions; description lengths **0–9,119**. First row HTML description **2,139**, `posted_at=2026-10-06T11:03:20.165073+00:00`. |
| **G3**, 21:34:46 | Same base route, `?select=*&id=eq.79c5a586-dd0a-4866-8b34-55750379fe52`: **200**, **1** Job, `description=""`, `requirements=[]`; all-column keys include `salary_min/max/currency` but no salary-period or richer-description column. |
| **G4**, 21:34:55 | Same base route, `?select=id,salary_min,salary_max,salary_currency&is_archived=eq.false&order=posted_at.desc&limit=200&offset=0`: **200**, **200** Jobs, **37** with a non-null pay bound. Sample `id=1454bf7a-21e4-49f3-8127-c389ee5b3074`, `salary_min=220000`, `salary_max=280000`, `salary_currency=USD`. |
| **D1/D2**, 21:34:20/21 | `GET https://www.workingnomads.com/jobs/senior-vue-developer-lemonio-1923073`; `GET https://www.golangjobs.tech/golang-jobs/golang-jobs-at-rubix-network-0d9933eb`: both **200** HTML. No JobPosting JSON-LD extracted; Golang detail has site/organization JSON-LD, not Job data. These HTML reads do not establish an alternate full-description API. |
| **A1**, 21:33:14 | `GET https://api.adzuna.com/v1/api/jobs/us/search/1?what=software%20engineer&results_per_page=50`, no `app_id/app_key`: **400**, HTML error, item count **unavailable**, not zero. Authenticated status, count and payload remain **unverified**. |

Reproduce discovery probes without a browser (Golang's anon key is deliberately read from the pinned public source rather than copied as a private credential):

```sh
python3 - <<'PY'
import datetime, json, re, subprocess, urllib.request, urllib.error
from urllib.parse import urlencode
ref = 'cb8803c0566a1d8ec789f1f1ecf121f58ac8b769'
raw = subprocess.check_output([
    'gh', 'api', 'repos/DaKheera47/job-ops/contents/extractors/golangjobs/src/run.ts?ref='+ref,
    '-H', 'Accept: application/vnd.github.raw'], text=True)
key = re.search(r'"(eyJ[^\"]+)"', raw).group(1)
wn = {
    'size': 50,
    '_source': ['id','slug','title','company','category_name','description',
                'position_type','tags','locations','location_base','pub_date','apply_url'],
    'sort': [{'premium': {'order':'desc'}}, {'pub_date': {'order':'desc'}}],
    'min_score': 2,
    'query': {'bool': {
        'must': [{'query_string': {'query':'"software engineer"',
                                   'fields':['title^2','description','company']}}],
        'filter': [{'terms': {'locations':['USA','North America','Anywhere']}}]}}
}
fq = dict(q='software engineer', description_format='markdown', sort='posted_at',
          order='desc', limit=50, offset=0, countries='us')
gq = dict(select='id,title,company,type,application_url,slug,posted_at,description,requirements,cities(name,country)',
          is_archived='eq.false', order='posted_at.desc', limit=200, offset=0)
cases = [
    ('WN', 'https://www.workingnomads.com/jobsapi/_search', wn, {}),
    ('FH', 'https://freehire.me/api/v1/agent/jobs/search?'+urlencode(fq), None, {}),
    ('GO', 'https://mvjyjzestmcxxmmmakec.supabase.co/rest/v1/jobs?'+urlencode(gq), None,
     {'apikey':key, 'Authorization':'Bearer '+key}),
    ('AZ', 'https://api.adzuna.com/v1/api/jobs/us/search/1?what=software%20engineer&results_per_page=50', None, {})
]
for name, url, body, headers in cases:
    h = {'User-Agent':'joule/0.1','Accept':'application/json',**headers}
    if body is not None: h['Content-Type']='application/json'
    req = urllib.request.Request(url, headers=h,
        data=json.dumps(body).encode() if body is not None else None)
    print(name, datetime.datetime.now(datetime.timezone.utc).isoformat(), url)
    try:
        with urllib.request.urlopen(req, timeout=35) as r:
            d = json.load(r)
            rows = d if isinstance(d,list) else d.get('data',d.get('results',d.get('hits',{}).get('hits',[])))
            print('HTTP',r.status,'Jobs',len(rows),
                  'meta',d.get('meta') if isinstance(d,dict) else None,
                  'total',d.get('hits',{}).get('total') if isinstance(d,dict) else None)
    except urllib.error.HTTPError as e:
        print('HTTP',e.code,'item count unavailable')
PY
```

Pagination evidence above came from the same request code with WN `size=100, from=0/100`, FH `offset=50`, and GO successive 200-row offsets until a short page. Counts and intersections used `len(rows)` and ID/public-slug sets; geography/missing-description counts used the exact response fields stated in G1/G2. First-party machine contracts were read via `curl -sS --max-time 25 https://freehire.me/openapi.yaml` and `curl -sS --max-time 25 https://developer.adzuna.com/swagger/spec/test2.json`; JSON schema inspection used `json.load`, `paths['/jobs/{country}/search/{page}']`, and `components.schemas.{Job,JobSearchResults}`. [FH API], [AZ API].

## Working Nomads

**Access / fetch.** `POST https://www.workingnomads.com/jobsapi/_search`, JSON body as above, `Accept`/`Content-Type: application/json`; no key required in the successful probes. This is **per-role search**, despite job-ops docs calling it a broad feed: implementation supplies an upstream quoted `query_string` across `title^2`, `description`, `company`, `min_score=2`, plus local term checking. US selection sends `terms.locations=["USA","North America","Anywhere"]`; these broaden US relevance rather than enforce US-only territory. Explicit city selection disables that country query in job-ops and applies city matching locally. [WN code lines 336–459, 598–665][WN code], [WN docs lines 30–40][WN docs], W1–W3.

**Pagination / volume.** job-ops sends one request per term, defaults to 50 retained Jobs, and clamps request `size` between 50 and 100; it does **not paginate**. The live API accepted `size=100` and `from=100` with distinct results, so proposed joule pagination is `from=0,100,200,…`, fixed `size=100`, stop on a short page/total and a Scan budget. 100 is an established working size and job-ops cap, **not a verified upstream maximum**; deep offset limits/cursors are unverified. Sort is premium-first, then publication date, so stopping solely on the first old Job risks missing newer non-premium Jobs (inference from sort). [WN code lines 405–459, 636–665][WN code], W2/W3.

**Fields → Candidate (proposed).** `source="workingnomads"`; stringified `id` → `source_id`; canonical `https://www.workingnomads.com/jobs/{slug}` → `link`, with `/job/go/{id}/` fallback; `title`, `company` (legacy `company_name`) → title/company; `description` → HTML description. The search response already carries a substantial body (W1); no detail request is needed to obtain that supplied text, though completeness against every employer original is **unverified**. `pub_date` → timezone-aware `posted_at`. [WN code lines 506–588][WN code], W1.

Use `location_base` then legacy `location`, otherwise joined `locations` → `location_raw`; remote-only source semantics → `remote=true`, `arrangement="remote"`. City and country require careful normalization of actual geographic restrictions; `USA` plus other regions is multi-location, not proof of a single US-only country. Preserve the full list rather than selecting its first element. [WN docs lines 38–42][WN docs], [WN code lines 527–544, 587][WN code], W1.

job-ops' projection omits pay, but live unprojected data exposes `salary_range`, `salary_range_short`, `annual_salary_usd`: add those to joule's `_source` list. Parse stated `salary_range` for min/max/currency/period (W5 explicitly states a yearly dollar range); resolve ambiguous currency from prose or leave unknown. Keep `annual_salary_usd` in `extra`: its semantics as one scalar are **unverified**, and the sample equals the high bound, so do not manufacture two pay bounds from it. Store `apply_url`, category, tags, `position_type`, all locations, raw pay strings/scalar and any application instructions/experience evidence in `extra`. Employment type is distinct from remote arrangement. [WN code lines 415–428, 555–587][WN code], W4/W5, [Candidate](/Users/j/code/joule/joule/sources/__init__.py:18).

**Feasibility / verdict.** **Feasible with plain httpx**, per Preferences role plus local verification of US eligibility. No browser/JS challenge, authentication failure or 429 occurred in these probes; no numeric upstream rate budget or sustained reliability was established. Treat unknown response shapes/timeouts/429 as failed or partial Scans, and pace bounded requests. This is engineering judgment from W1–W5 and [WN code lines 483–503][WN code].

## FreeHire

**Access / fetch.** `GET https://freehire.me/api/v1/agent/jobs/search`, no key, `Accept: application/json`, optional identifying User-Agent. Send each Preferences role as `q`, `description_format=markdown`, `sort=posted_at`, `order=desc`, `countries=us`, `limit=50` (or up to 100), `offset=0`; optional `work_mode=remote/hybrid/onsite` and `cities`. job-ops sends comma-joined city/work-mode values; the current contract specifies repeated array parameters, so use its documented encoding for multiple values. The US spelling is lowercase canonical but matching is case-insensitive (both F1/F2 worked). [FH code lines 146–195][FH code], [FH API parameters Countries/Cities/WorkMode][FH API], F1/F2.

**Pagination / US scope.** **Per-role**, not whole feed. Responses `{data,meta:{limit,offset,total}}`; advance offset by a fixed requested page size. Contract default 10, maximum 100, with **`offset+limit≤10000`**; deeper paging returns 400. job-ops currently takes one page per term (default 50, capped 100), although its helper accepts offsets. `countries`, `cities` and `regions` join one **OR-group**: adding `cities=Boise` alongside `countries=us` does not narrow to Boise. US-relevant worldwide remote coverage can add documented `regions=global` and then verify description restrictions locally; that broadened query was **not live-probed**. Check `meta.ignored_params` so unknown parameters do not silently broaden results. [FH code lines 214–255][FH code], [FH API info/Offset][FH API], [FH guidance](https://freehire.me/llms.txt), F1/F2.

**Fields → Candidate (proposed).** `source="freehire"`; `public_slug` → `source_id` (fallback `external_id`, retaining upstream `source`); `url` → `link` (original upstream Job URL); `title`, `company`, `description`, `location`, `posted_at` map directly. Agent endpoint supplies the full stored description in requested format, so **no detail call** for its body; `enrichment.summary` is synthesized summary, not an equivalent full description. Work mode maps to arrangement and remote (`remote=true`, known hybrid/onsite → false, missing mode → unknown). Single unambiguous `cities`/`countries` can map city/country; preserve multiple values in `extra`. [FH code lines 105–143][FH code], [FH API agentSearchJobs/Enrichment][FH API], F1/F2.

`enrichment.salary_min/max/currency/period` → pay; normalize recognized hour/year/fixed periods, leave unsupported or absent periods unknown. These are upstream model-extracted fields, so preserve enrichment/provenance and confirm important pay/geography against the original body. Put upstream `source`, `external_id`, company slug, countries/regions/cities arrays, skills, enrichment, `reality`, `created_at/updated_at/last_seen_at/closed_at` in `extra`; do not replace `posted_at` with the aggregator's creation time. [FH code lines 112–143][FH code], [FH API Enrichment][FH API], F1/F2, [Candidate](/Users/j/code/joule/joule/sources/__init__.py:19).

**Feasibility / verdict.** **Feasible with plain httpx**, with complete stored descriptions in one search request. Current first-party guidance documents **300 requests/minute** for agent search, 600/minute shared across ordinary reads; inspect `X-RateLimit-Limit/Remaining/Reset`, handle 429. F1/F2 returned the 300 budget headers; no JS challenge, 429 or 503 was observed. job-ops docs' “no documented rate-limit allowance” statement is stale relative to current first-party guidance. Sustained availability/SLA was not measured. [FH guidance](https://freehire.me/llms.txt), [FH docs lines 32, 49][FH docs], F1/F2.

## Golang Jobs (`golangjobs`)

**Access / fetch.** Browser-facing Supabase/PostgREST endpoint `GET https://mvjyjzestmcxxmmmakec.supabase.co/rest/v1/jobs`. Required headers in the working request: `apikey: <public anon JWT>`, `Authorization: Bearer <same JWT>`, `Accept: application/json`. The exact public JWT is published at [GO code lines 9–14][GO code] and obtained by the reproduction script; this is not a user-account/private API credential. Key override in job-ops: `GOLANG_JOBS_SUPABASE_ANON_KEY`. No browser execution is required even though the site's detail HTML is an app shell. [GO code lines 279–301, 363–367][GO code], G1, D2.

**Pagination / US scope.** Query `select=id,title,company,type,application_url,slug,posted_at,description,requirements,cities(name,country)`, `is_archived=eq.false`, `order=posted_at.desc`, `limit=200`, `offset=0,200,…`. Responses are top-level arrays. Fetch the **whole paginated feed once**, then match all Preferences roles locally; job-ops stops on a short page and caps at ten pages/2,000 rows. 200 is its page size, not a verified Supabase maximum. Measured six-page feed **1,199 distinct Jobs**, including **194 US-country** and **126 Remote/Global** Jobs before role filtering. job-ops selected-US logic uses exact normalized country equality and **excludes Global**; a US-relevant joule design should retain worldwide candidates pending description restrictions rather than copy that exclusion. Hybrid is not structurally distinguished: job-ops infers Remote by city name and everything else as onsite. [GO code lines 188–229, 279–337, 378–409][GO code], G1.

**Fields → Candidate (proposed).** `source="golangjobs"`; UUID `id` → `source_id`; `https://www.golangjobs.tech/golang-jobs/{slug}` → `link`, retain `application_url` in `extra`; `title`, `company`, `description`, `posted_at` map directly. Descriptions are HTML when present, supplied in the feed; preserve `requirements` too, appending to description only if useful and clearly marked as source requirements. Feed contains **278 empty descriptions**, and the sampled all-column read for an empty row supplies no richer text. A feed/detail-by-ID call therefore does not solve that sample; full text would require reading its linked upstream application site, whose feasibility is **unverified** and varies by host. [GO code lines 231–276][GO code], G2/G3.

`cities.name/country` → location: `Remote (country)` for Remote, otherwise joined name/country; actual city only when it is a locality, not `Remote`. Normalize true country labels; `Global`, `Europe`, `APAC`, `EMEA` are geography scope, not ISO countries. Set Remote rows to `remote=true, arrangement="remote"`; keep other arrangement/remote values unknown unless prose establishes them, rather than treating non-Remote city as proof of onsite work. Keep the relationship and raw labels in `extra`. [GO code lines 108–130, 211–229][GO code], G1.

job-ops does not request pay, but live table columns **do** expose `salary_min/max/currency`: add these to joule's `select` and map available values. G4 found pay bounds in **37/200** recent Jobs. No pay-period column appeared in G3; do not assume yearly from numeric size alone. Recover stated period from original text or leave unknown. `extra`: slug, application URL, `type` employment type, requirements, city/country relationship, raw pay fields, and optional upstream creation/update/archive metadata if requested. [GO code lines 286–294][GO code], G3/G4, [Candidate](/Users/j/code/joule/joule/sources/__init__.py:18).

**Feasibility / verdict.** **Feasible with plain httpx** for discovery and supplied descriptions; incomplete text coverage is a data limitation. All probed JSON pages succeeded without anti-bot/JS challenges or rate errors; numeric quota and long-term reliability are **unverified**. Public key rotation, Supabase project/schema/relationship changes and archive semantics are structural dependencies; report failures rather than empty results. A rotating feed can shift offsets during a Scan; deduplicate by UUID. [GO docs lines 38–42, 50–53][GO docs], G1–G4.

## Adzuna US (`us`)

**Access / fetch.** `GET https://api.adzuna.com/v1/api/jobs/us/search/{page}`. Required query `app_id=<App ID>&app_key=<App Key>`; `Accept: application/json` (or `content-type=application/json` query). job-ops sends each role in `what`, optional geographic text in `where`, and `results_per_page`; page numbers start at **1**. Set country explicitly to **`us`**, since job-ops extractor default is `gb`. No bearer token/browser flow is needed for the documented API. [AZ code lines 101–145][AZ code], [AZ README], [Adzuna overview](https://developer.adzuna.com/overview), [AZ API].

**Pagination / volume.** **Per-role**, not a whole-feed fetch. job-ops default/cap `results_per_page=50`, default retained budget 50/term, increment page until a short page or budget, hard stop after page 100. This 50 cap is a job-ops constraint: the inspected official schema specifies minimum 1 but **no maximum**, so an upstream maximum was not independently established. Proposed joule keeps a **fixed** page size (up to the established code choice 50) and truncates locally; job-ops reduces the final request size to the remaining budget, which may shift page boundaries if the server offsets using current page size (unverified behavior; avoid copying it). Response `results` is the page, `count` is total matching Jobs; actual US count per page is **unverified without keys**. [AZ code lines 128–130, 168–205][AZ code], [AZ API JobSearchResults/search].

Optional documented controls include `what_and/what_phrase/what_or/what_exclude/title_only`, `where/distance` (distance documented in km), `location0…5`, `max_days_old`, `category`, `sort_by/sort_dir`, salary filters and full-time/part-time/contract/permanent filters. These are optional extensions, not parameters job-ops presently sends besides `what/where/results_per_page`. No structured remote-search parameter appears in the inspected search schema; US market selection is not proof of remote eligibility. [AZ API search], [AZ code lines 110–123][AZ code].

**Fields → Candidate (documented, not live verified).** `source="adzuna"`; string `id` → `source_id`; `redirect_url` → `link`; `title`, `company.display_name`, `description`, `location.display_name`, `created` → title/company/description/location_raw/posted_at. Official Job schema says description is **truncated to 500 characters**, and first-party search docs expressly call it a snippet; no full-text detail call is made by job-ops. The inspected official paths expose no full-description Job detail endpoint. Fetching redirected upstream pages to obtain full bodies would need separate host-by-host HTTP probing; that route is **unverified**, so snippet-only discovery is feasible but complete Extraction cannot be assumed. [AZ code lines 74–98][AZ code], [AZ API Job/paths], [Adzuna search docs](https://developer.adzuna.com/docs/search).

Use country `US` as selected-market provenance, normalize `location.area` hierarchy carefully for country/city; the most-specific area may not be a city. Remote/arrangement remain unknown unless prose establishes them; `contract_time/type` describe employment, not remote work. `salary_min/max` are local-currency pay bounds, but **exclude predicted pay** from Candidate pay (retain as estimates in `extra`) when `salary_is_predicted` is `1` or equivalent. Treat `USD` for the US market as a normalization assumption, since no currency field is documented; confirm before relying on it. No period is documented; leave `pay_period` unknown unless stated. Preserve `salary_is_predicted`, raw salary values, market, `location.area`, coordinates, category, contract fields and optional `adref` in `extra`. [AZ API Job/Location], [AZ code lines 60–98][AZ code], [Candidate](/Users/j/code/joule/joule/sources/__init__.py:19).

**Feasibility / verdict.** **HTTP API feasible with credentials; authenticated US access unverified.** Keyless A1 was **400**, not a successful empty response and not evidence of anti-bot blocking. No rate allowance could be established for an actual account, and authenticated latency, paging stability, 429 behavior, response fields/US inventory and full-description retrieval are unverified. Verify with valid keys against pages 1/2 using fixed `results_per_page=50`, inspect headers/account quota, and separately probe selected redirect destinations. The no-browser conclusion applies to the documented search API, not every employer detail host. [AZ docs lines 25–28, 59–61][AZ docs], [AZ code lines 121–130][AZ code], A1.

[WN code]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/extractors/workingnomads/src/run.ts
[WN docs]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/docs-site/docs/extractors/working-nomads.md
[FH code]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/extractors/freehire/src/run.ts
[FH docs]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/docs-site/docs/extractors/freehire.md
[FH API]: https://freehire.me/openapi.yaml
[GO code]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/extractors/golangjobs/src/run.ts
[GO docs]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/docs-site/docs/extractors/golang-jobs.md
[AZ code]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/extractors/adzuna/src/main.ts
[AZ docs]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/docs-site/docs/extractors/adzuna.md
[AZ README]: https://github.com/DaKheera47/job-ops/blob/cb8803c0566a1d8ec789f1f1ecf121f58ac8b769/extractors/adzuna/README.md
[AZ API]: https://developer.adzuna.com/swagger/spec/test2.json
[AZ API JobSearchResults/search]: https://developer.adzuna.com/swagger/spec/test2.json
[AZ API search]: https://developer.adzuna.com/swagger/spec/test2.json
[AZ API Job/paths]: https://developer.adzuna.com/swagger/spec/test2.json
[AZ API Job/Location]: https://developer.adzuna.com/swagger/spec/test2.json
