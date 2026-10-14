# ADR-0001: Browser Extension Fill

Accepted: 2026-10-14. Parent issue: #74. Implementation is delivered in the independent slices in §10.
Status: final record, operator rulings incorporated (Q1 no token, Q2 shared answers, Q3 ignore sensitive fields, Q4 keep Greenhouse custom-host pages; operator tests manually). Author: designer (sole). This record describes the complete design; slice 1 implements identity matching only.

## 0. Summary

A personal unpacked MV3 Chrome extension, plus a small joule router `/api/fill/*`. The operator opens an employer-hosted ATS form, picks (or already has) the active Job, clicks **Fill**: joule returns values for identity fields (name, email, phone, LinkedIn, GitHub, site, current company) and the extension writes them into empty fields and attaches the latest Tailored CV PDF. Fields it can't match are listed; the operator clicks **Ask** per field to get a Codex answer from the Profile/`answers.yaml`. The extension never submits and never touches `jobs.state`; "applied" stays the operator's `a` key.

Reuses unchanged: `drafts.answer`/`context()` (Profile + `answers.yaml` prompt), `drafts.write` (Tailored CV), `GET /drafts/{id}/pdf`, `GET /api/jobs`, `cv.load`, `ai.structured` sandbox (read-only, tools disabled).

## 1. Verified facts this design rests on

Checked against code or live public pages 2026-10-14 (read-only GETs, nothing submitted):

| Fact | Evidence |
| --- | --- |
| Telegram queue is Upwork-only; board Apply never marks `applied` in code (spec §9 text is stale) | `joule/telegram.py:18-21` `source='upwork'` |
| Only `PATCH /api/jobs/{id}` and Telegram write `state`; opening a drawer marks `seen` client-side via that PATCH | `joule/jobs.py:246`, `telegram.py:230` |
| No CORS middleware; mutations take JSON bodies; Host allowlist = `localhost`, `127.0.0.1`, host of `UPWORK_REDIRECT_URI` | `joule/app.py:60-72` |
| `answers.yaml` is appended by Telegram Fill and read whole into every Draft/Ask prompt | `telegram.py:179`, `drafts.py:65` |
| Greenhouse `job-boards.greenhouse.io` form is server-rendered; **no `name` attributes**, system inputs have `id`=`first_name`/`last_name`/`email`/`phone` and `autocomplete=given-name/family-name/email`, `aria-label`; **LinkedIn is a custom question** (`id=question_66210918`, label "LinkedIn Profile"); selects/country/location are react-select **comboboxes** (`role=combobox`) each shadowed by an `aria-hidden` required `<input>`; resume is `<input type=file class=visually-hidden id=resume>` | curl of `job-boards.greenhouse.io/reddit/jobs/7868511` |
| Greenhouse public `boards-api…/jobs/{id}?questions=true` returns typed questions, required flags, field names matching DOM ids, with no credential | same job |
| Lever `jobs.lever.co/*/apply` is plain server-rendered HTML: `name="name"` (single full name), `email`, `phone`, `org`, `location`, `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `resume` (file); **no `autocomplete`, no ARIA**; labels wrap text ("Full name ✱"); EEO/pronoun checkbox groups on the same page | curl of a Spotify apply page |
| Ashby application form is **not** in the server HTML (client-rendered; `window.__appData` holds no form fields). `_systemfield_*` names are from Ashby's API docs, **not confirmed in the DOM** | curl of `jobs.ashbyhq.com/ashby/…/application` |
| `chrome.storage.local` is exposed to content scripts by default; `storage.session` is not; `setAccessLevel` switches it | developer.chrome.com storage reference |
| `activeTab` is granted by action click, context-menu item, keyboard command, omnibox suggestion; docs name only the **main frame origin**, say nothing of cross-origin subframes | developer.chrome.com activeTab |
| Content-script `fetch` runs under the page's origin; extension service worker with host permission does not need CORS | research §4 (Chrome networking docs) |

Destination weights (research §2, snapshot of 565 non-Upwork rows; "clue, not proof" for `gh_jid`): Greenhouse 108 by domain + 116 `gh_jid` on custom hosts (≈40%), Ashby 78 (13.8%), Lever 16 (2.8%), Workday 4 (0.7%), other named ATS 17, unclassified custom 33 after removing `gh_jid`, aggregators 18% (not destinations), unresolved 16%. Greenhouse+Ashby+Lever ≈ 56% of rows and ≈ 85% of the rows that resolve to a recognizable ATS.

## 2. Invariants

1. **Applied is manual.** No `/api/fill/*` handler and no extension code writes `jobs.state`. Test: state unchanged after match/ask/resume/save.
2. **No submit.** Extension never calls `submit()`/`requestSubmit()`, never clicks a page button, never dispatches `submit`. Only writes `value`/`checked`/`files` plus `input`/`change` events.
3. **Fill is non-Upwork only.** `/api/fill/*` returns 400 for `source='upwork'`. Extension injects nowhere on `upwork.com`, `linkedin.com`, `indeed.com`, `glassdoor.com` (static matches never list them; the on-request path refuses by host). Encodes research §6 and the operator's "not for upwork / no LinkedIn/Indeed/Glassdoor".
4. **Write only into empty, visible, enabled, non-honeypot fields.** Never overwrites existing values; skips `type=hidden`, `aria-hidden`, `display:none`, zero-size, `disabled`/`readonly`. (File inputs are exempt from the size test: Greenhouse's is `visually-hidden`.)
5. **Page text is data.** Page-derived strings (labels, names, option text) never become a URL, path, header or instruction: SW builds URLs only from the configured joule origin, constant paths and an integer Job id. In prompts they sit inside an untrusted-data block like `score.job_block`.
6. **Sensitive fields are left alone.** EEO/demographic, disability, veteran, pronouns, criminal history, and consent/attestation/privacy checkboxes: no Codex, no bank replay, never auto-checked; the panel lists them as `leave` (required ones first). Operator ruled: these are usually optional, ignore them.
7. **No new exposure.** No CORS headers on `/api/fill/*`; no `externally_connectable`; token-less (see §4b).
8. **One Job at a time, shown.** Side panel always shows active Job title/company/source before Fill (guards wrong-Job and the observed getarustjob link mismatch).

## 3. Design

### 3a. Field matching: recommendation

**One generic engine in joule (Python), fed by DOM descriptors, with a small per-ATS name-hint table as extra rows. No per-ATS adapters. Codex is not used for matching, only for Ask.**

The extension (dumb DOM worker) sends, per visible fillable control: `ref`, `tag`, `type`, `role`, `name`, `id`, `autocomplete`, `label` (resolved from `label[for]`, wrapping label, `aria-labelledby`, `aria-label`, fieldset legend, placeholder, in that order), `required`, `options[{value,label}]` for select/radio group, `accept` for file, `maxlength`. Joule classifies, in priority order, first hit wins:

1. `type=file`: label/id/name `resume|cv` → upload `resume`; `cover` → upload `cover_letter`; else leave.
2. `autocomplete` token: `given-name`→first_name, `family-name`→last_name, `name`→full_name, `email`, `tel`→phone, `url`.
3. `type=email|tel`.
4. Hint table on `id`/`name`: Greenhouse `first_name,last_name,email,phone`; Lever `name,email,phone,org,urls[LinkedIn],urls[GitHub],urls[Portfolio]`; Ashby `_systemfield_name,_systemfield_email` (**unverified in DOM; delete if live capture disagrees**).
5. Normalized label regexes (lowercase, strip `*✱`, collapse space): first/given, last/family/surname, full name/`^name$`/your name, email, phone/mobile, linkedin, github, portfolio/website/personal site, current company/employer.
6. Sensitive label (EEO/demographic/disability/veteran/pronoun/criminal/consent regex) → `leave`, checked **before** the bank so nothing sensitive is replayed or generated.
7. Exact normalized match of label against `answers.yaml` questions → replay saved answer (for select/radio: option whose label equals the answer, normalized).
8. Else `ask`; `leave` for combobox, hidden, missing value.

Values: `cv.load(...)["basics"]` JSON Resume keys (`name`, `email`, `phone`, `url`, `profiles[network=LinkedIn|GitHub].url`); `current_company` = the `work` entry with no `endDate`, else none. Absent value → `leave` with reason `missing in cv.yaml`. "Preferred first name" is deliberately unmatched (becomes `ask`; accuracy over coverage). Combobox widgets (`role=combobox`, react-select) are `leave` in v1: setting `.value` does not drive them; listed for the operator, attempted later only if the trial shows they dominate leftover typing.

**Why this, grounded in data:** Greenhouse+Ashby+Lever ≈ 56% of all stored Jobs, and the verified markup shows three different mechanisms (Greenhouse: `id`+`autocomplete`+aria; Lever: `name`+wrapping label only; LinkedIn on Greenhouse: custom-question label). All three are rows in one table, not three adapters. A per-ATS adapter would still have to find and write DOM controls, so it saves nothing on the hard part. Long tail (Workday 0.7%, applytojob, Rippling, Comeet…) works through the same engine on request with no extra code.

**Strongest rejected alternative: per-ATS adapters driven by each ATS's public schema** (Greenhouse `?questions=true` verified to be public). Gives requiredness and canonical option values. Rejected: (a) the DOM already carries label/options/required; (b) needs a joule outbound call built from page-supplied board token and job id (SSRF-shaped, invariant 5); (c) Lever's postings API explicitly omits custom questions and Ashby's form needs a credential (research §3), so the approach is not uniform and leaves the larger code per ATS. Revisit only if the operator's manual testing (slice 7) shows option-value mismatches on Greenhouse selects.

Also rejected: Codex classifying every field per page (30–300 s per page, nondeterministic, ships whole-page text and PII to a model by default).

### 3b. Pairing/auth: recommendation

**No new credential. The extension is configured with the joule origin and is a client of the existing tailnet perimeter; protection is placed at the page/extension boundary, not on the wire.** Operator pairing = options page: paste joule URL → extension requests that single origin via `chrome.permissions.request` → "Test" calls `GET /api/jobs?unscored=false` style cheap read. No code, token, or file in joule.

Threat model (who can do what):

| Actor | Today | With this change | Mitigation |
| --- | --- | --- | --- |
| Malicious web page in operator's browser, reads joule | No CORS → responses unreadable; DNS rebinding blocked by Host allowlist | Same; `/api/fill/*` adds no CORS headers | test asserts no `Access-Control-*`; POSTs require `application/json` (test sends `text/plain` simple POST, expects 4xx and no effect; **believed** FastAPI 422, unverified, test decides) |
| Malicious page, tries to drive the extension | n/a | Page can't message SW (no `externally_connectable`); can only influence labels/options | UI lives in the **side panel**, not page DOM, so a page cannot synthesize clicks on Ask/Fill; prompt wraps labels as untrusted; field refs are integers |
| Malicious page, tries to harvest filled PII | n/a | Anything written into its fields is readable by the page, inherently | Fill only on operator gesture, only on a site the operator opened; hidden/honeypot fields skipped (invariant 4); sensitive fields left alone (D10) |
| Other tailnet device / local process | Full `/api/*` incl. `PATCH` state, drafts, CV PDF | Same | A token on `/api/fill/*` would protect a **subset** of what `/api/*` already exposes unauthenticated (§spec 2 "no login"): it changes nothing |
| Compromised content script (page exploit) | n/a | Can message SW only | Token/`active Job` live in SW; `storage.local.setAccessLevel(TRUSTED_CONTEXTS)` so content scripts can't read config |

How the no-login model changes: it doesn't. Two things become explicit: (1) `/api/fill/*` joins the "JSON body for mutations, no CORS, Host allowlist" guarantees and is tested for them; (2) on Tailscale Serve the tailnet host is allowed only via `UPWORK_REDIRECT_URI` (`app.py:62`); the README already says to set it for server use, no new setting. If the operator runs joule on a server without ever setting it, the extension gets 400 from TrustedHost; the options-page Test surfaces that.

**Strongest rejected alternative: dashboard-minted bearer token** ("Pair extension" button → `POST /api/fill/token` returns `secrets.token_urlsafe(32)` once, sha256 stored in `~/.joule/fill-token` 0600 atomic write, `Depends` on `/api/fill/*`, extension keeps it in `storage.local` TRUSTED_CONTEXTS; ~35 prod + 40 test lines). Rejected: it adds a secret the whole unauthenticated `/api/*` makes moot; operator must paste it; revocation theatre. **Adopt it the day joule gates the rest of `/api`** (then it is the extension's credential); cost then is one header in SW. Operator ruled "no token" (D7).

Also rejected: `Origin: chrome-extension://<id>` allowlist (forgeable by any non-browser client, redundant against pages); Tailscale identity headers (identifies the user/device, not the software; only present via Serve, not localhost; adds config).

### 3c. Static happy path

1. Operator opens the employer form (Greenhouse/Lever/Ashby static content script; others via §3e).
2. Side panel shows active Job. None → picker built from existing `GET /api/jobs` (client drops `source='upwork'`, sorts by Jobs with Drafts first then `rank`, text filter). Selection stored in `chrome.storage.session` (SW-owned, global, one Job).
3. **Fill**: SW asks every frame of the tab for descriptors (content scripts push `{frameId, descriptors}`; refs are `(frameId,index)`), POSTs `/api/fill/jobs/{id}/match`.
4. Response per ref: `set{value}`, `upload{file}`, `ask`, `leave{reason}`; plus `resume_draft_id`, `cover_letter_draft_id` (latest rows or null).
5. Content scripts apply `set` with the native value setter + `input`/`change` (React-controlled inputs), highlight touched fields. Panel lists counts and every `ask`/`leave` field with reason.
6. **Attach resume**: panel button (explicit, never automatic). If `resume_draft_id` null → `POST /api/jobs/{id}/drafts {kind:"tailored_cv"}` (spinner; up to the 300 s Codex timeout), re-match. SW `fetch`es `GET /drafts/{id}/pdf`, reads filename from `Content-Disposition` (`files.cv_prefix`+company, e.g. `JB_CV_Acme.pdf`), base64 → content script → `File` → `DataTransfer` → `input.files`, then `input`/`change`. Base64 because Chrome message passing is JSON; content-script fetch is not allowed (page origin rules).
7. Cover letter textarea: `set` from latest `cover_letter` draft `text`; cover-letter file input: same PDF path via `/drafts/{id}/pdf`. No draft → `leave "no Cover Letter Draft"`; extension never generates one.
8. Operator reviews, edits, submits themselves, returns to dashboard, presses `a`.
9. Re-clicking Fill is idempotent (invariant 4): covers ATS resume-parsers that repopulate or clear fields after upload. Whether they overwrite is **unverified** until the live trial.

### 3d. Ask path (custom questions)

Per-field **Ask** in the side panel for each `ask` ref: `POST /api/fill/jobs/{id}/ask {question, options?[{value,label}]}`. Joule: re-runs the sensitive classifier on `question` (defense in depth; returns `{value:null, reason:"sensitive"}` without Codex), then Codex with the existing `RULES` + `context()` (Profile, samples, portfolio, `answers.yaml`, Fit reason, Job block) and the question inside an untrusted block. Free text → `Answer` (existing, 5000 chars; clipped to `maxlength`). Options → structured `choice: Literal[option values] | None`; None means "not answerable from Profile" and the panel says so (no placeholder text injected into a dropdown). Result is written into the field, highlighted, operator edits. Nothing stored. Existing dashboard `POST /api/jobs/{id}/ask` is untouched.

**Save to bank** (slice 6): panel button after an Ask or any answered field → `POST /api/fill/answers {question, answer}` where the extension sends the field's **current** value (what the operator finally chose; for selects the option label). Server appends one YAML list entry to `profile/answers.yaml` in a single `write()` (same format as `telegram.py:179`). Next Fill replays it deterministically (step 7 of §3a) with no Codex call. Size cap: reject when file > 200 KB.

### 3e. Unknown sites ("ask on the current site")

Static content scripts exist only for the Greenhouse/Lever/Ashby hosts (`boards.greenhouse.io`, `job-boards.greenhouse.io`, `job-boards.eu.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`), `all_frames: true` so company-hosted pages with an embedded Greenhouse/Ashby iframe (the `gh_jid` 21%) work. Any other site: context-menu item "Fill with Joule" and keyboard command (both documented `activeTab` triggers) → `chrome.scripting.executeScript` of the same content script, then open the side panel. No `<all_urls>` host permission. Whether `activeTab` also covers a cross-origin iframe on such a site is **unverified**; documented fallback is the operator opening the iframe URL directly. Whether clicking the toolbar action with `openPanelOnActionClick` also grants `activeTab` is **unverified**; that is why the gesture is the context menu/command, not the action.

## 4. What lives where

| Joule (Python, tested with pytest) | Extension (plain JS, no build) |
| --- | --- |
| All classification (§3a), identity values from `cv.yaml`, bank lookup | Descriptor extraction, label resolution, visibility test |
| Sensitive classifier, Ask prompt/schema, bank append | Native-setter filling, highlight, `DataTransfer` upload |
| Draft/PDF generation and selection | Picker, active Job, side panel UI, options page, permissions |
| Source/Upwork refusal | Host denylist, frame routing |

No data-model change: no tables, no columns. Active Job, joule URL in `chrome.storage`. Writes: `profile/answers.yaml` only (slice 6).

### API surface (`joule/fill.py`, router prefix `/api/fill`, included next to `manual_router`)

| Route | Body → Response |
| --- | --- |
| `POST /jobs/{id}/match` | `{fields:[Descriptor]≤200}` → `{job:{id,title,company,source}, actions:[{ref,action,value?,file?,reason?}], resume_draft_id, cover_letter_draft_id}`; 404 not a Primary; 400 Upwork |
| `POST /jobs/{id}/ask` | `{question≤2000, options?≤100×{value,label≤200}}` → `{value:str\|null, reason?}`; 502 on `AIError` as today |
| `POST /answers` | `{question≤500, answer≤5000}` → `{}` |

Reused unchanged by the extension: `GET /api/jobs`, `POST /api/jobs/{id}/drafts`, `GET /drafts/{id}/pdf`.

All three accept `StrictModel` (extra forbidden) with the limits above; a page can't make joule store or compute more than those caps per operator click.

### Repo layout

```
extension/
  manifest.json        # MV3; permissions: storage, activeTab, scripting, sidePanel, contextMenus; optional_host_permissions for joule origin only
  background.js        # SW: config, active Job, fetch to joule, frame aggregation, injection, denylist
  content.js           # classic script: descriptors, fill, upload; `module.exports` guard for tests
  sidepanel.html/.js   # Job header, picker, Fill, Attach resume, Ask/Save per field
  options.html/.js     # joule URL, permission request, Test
  package.json         # devDependency jsdom only; `node --test`
  test/*.test.js, test/fixtures/*.html
```

Loaded unpacked from the checkout; not in the Docker image (container has no browser). README gains a short "Extension" section. This is the repo's first JS outside `web/`; it needs its own `npm test` and CI line (departure from "Python + Astro only" in spec §2, stated here).

## 5. Testing

Joule (pytest, existing `TestClient` + monkeypatched `ai.structured` pattern): classifier table on descriptors from saved real fixtures (Greenhouse job-boards page, Lever apply page; Ashby hand-built from API-doc names and labelled as such); bank exact-match; sensitive refusal never reaches `ai.structured`; Upwork 400; state unchanged; text/plain POST rejected; no CORS headers; options schema rejects an out-of-list value; Host allowlist still 400 for `evil.com` on `/api/fill/*`.

Extension (`node --test` + jsdom): descriptor extraction from the same fixtures (label resolution order, hidden/aria-hidden skip, combobox flagged); filling sets value via native setter and fires `input`/`change`; non-empty field untouched; checkbox consent never set; `File` assignment via `DataTransfer` where jsdom supports it (else stub and assert the call).

**Cannot be tested without live sites** (slice 7: the operator tests these manually, per ruling Q4; list doubles as their checklist): react-select/combobox behavior; ATS resume-parser overwriting filled fields; `DataTransfer` assignment accepted by each ATS uploader and upload-complete state; cross-origin iframe injection (Greenhouse embed on a `gh_jid` page); `activeTab` frame coverage; Ashby real DOM names; Chrome Local Network Access prompt for a tailnet origin; intl-tel phone widgets; ATS bot checks (Greenhouse reCAPTCHA, Lever hCaptcha) reacting to scripted input events.

## 6. Check-then-act

| Site | Safety |
| --- | --- |
| Generate Tailored CV when `resume_draft_id` null | Double click / two tabs → two draft versions. `race accepted: duplicate append-only Draft version, newest wins as designed; costs one extra Codex run`. Cheapest fix (per-Job asyncio lock, ~6 lines) not taken; panel disables the button in flight |
| `answers.yaml` append (read to test "already present", then write) | Skip the presence check: always append one entry in one `write()`. Concurrent Telegram Fill appends are `O_APPEND` small writes. `race accepted: duplicate or interleaved-adjacent entries; both are valid YAML list items and exact-match takes the last`. Test: two saves leave a parseable list |
| DOM "field empty" then write | Operator typing in that 100 ms window loses a keystroke. `race accepted` |
| Active Job in `storage.session` vs Job later marked applied/dismissed | Match returns 404/`state` info; extension clears active Job on 404; header always visible |
| `match` reading `cv.yaml`/`answers.yaml`/drafts | Read-only; files re-read per call (existing convention) |

## 7. Deletions

None. No row, file or key is deleted or stops being kept. `answers.yaml` gains entries; its only readers are `drafts.context` (prompt) and the new bank lookup, which treats an unparseable file as empty and logs.

## 8. Timeline (real use)

Wed 2026-10-14. 09:00 Scan finds Hotfix "Staff Backend Engineer, Acme" → Ashby link, Fit 82. 09:10 operator writes a Tailored CV in the drawer (≈1 min). 09:12 opens the Ashby page, side panel header "Staff Backend Engineer — Acme (hotfix)". Fill: name, email, phone, LinkedIn set (4 fields); 2 custom questions and a location combobox listed. Attach resume → `JB_CV_Acme.pdf` appears in the uploader. Ask "Why do you want to work at Acme?" → 20 s → edited. Work-authorization select: bank hit from 3 weeks ago replays. Operator reads, clicks Submit. 09:20 back on dashboard, `a`. Extension never knew. If the operator forgets `a`, the Job reappears in the list; nothing automatic.

## 9. Decisions

| # | Decision | Tag |
| --- | --- | --- |
| D1 | Intent: less typing, human reviews and submits | operator |
| D2 | Destinations: employer-hosted ATS only; no LinkedIn/Indeed/Glassdoor/Upwork | operator |
| D3 | Unpacked personal extension; Tailscale | operator |
| D4 | Applied = manual mark only | operator |
| D5 | Scope: static happy path plus on-request Ask on the current site | operator |
| D6 | Matching: one generic engine in joule + hint rows; no adapters (§3a) | designer |
| D7 | Auth: no token, no new credential; boundary hardening (§3b). Ruling: "no token" | operator |
| D8 | Side panel UI, not injected page UI | designer |
| D9 | Resume attach is explicit; Tailored CV generated only on click | designer |
| D10 | Sensitive/consent fields ignored: left untouched, no generation, no replay. Ruling: "usually optional, ignore" | operator (mechanism: designer) |
| D11 | Saved answers share the existing `answers.yaml`. Ruling: "shared answers" | operator |
| D12 | Combobox widgets `leave` in v1 | designer |
| D15 | Greenhouse custom-host (`gh_jid`) pages stay in scope via all-frames static script; operator tests everything manually. Ruling: "i do not want them excluded. assume i will test everything manually" | operator |
| D13 | Router named `fill`, not "application" (GLOSSARY avoids "Application") | designer |
| D14 | First JS outside `web/`, with its own `package.json`/tests | designer, departure from spec §2 stack line |

Glossary additions: **Fill** — writing the owner's saved identity and answers into a form on a destination site from the browser extension; the owner reviews and submits. **Extension** — the unpacked Chrome extension that performs Fills. Spec §1 "auto-submitting is out of scope" and "no in-app login" stay as written; add §13 "Browser extension" pointing at the ADR.

### Alternatives and why not (materially simpler first)

- **No extension; dashboard "Copy identity block" + PDF download.** ~40 lines, but the operator still pastes each field and attaches the file: it removes only the "typing" half and not the field-by-field clicking. Rejected by D1/D5.
- **Identity-only extension (slices 1–3 only).** This *is* the shippable minimum; Ask/bank/unknown-site are separable slices 4–6.
- **Bookmarklet.** Blocked by page CSP/CORS and mixed content; no side panel. Rejected.
- **Playwright/CDP-controlled browser.** Research §4; heavier trust boundary, operator chose extension.
- **In-page floating panel.** Reachable by page script (synthetic clicks, CSS), awkward inside tall embed iframes. Rejected for the side panel.
- **Fragment `#joule=<id>` on dashboard links.** Lost on JS redirects (Working Nomads `/job/go/`) and absent in iframes; picker covers all cases. Dropped.

## 10. Slices

Each merges alone and keeps `uv run pytest && ruff` green; usable value starts at slice 3. Sizes are best estimates (prod / test lines).

| # | Slice | Acceptance | Prod / test |
| --- | --- | --- | --- |
| 1 | **Match API (identity)**: `joule/fill.py`, router wired, glossary, spec §13, ADR | Fixtures (Greenhouse, Lever, Ashby-by-doc) classify first/last/full name, email, phone, LinkedIn (custom-question label), GitHub, portfolio, current company; file inputs → resume/cover_letter; unmatched → `ask`; combobox/hidden/consent → `leave`; Upwork Job 400; non-Primary 404; limits enforced; `jobs.state` unchanged; text/plain POST rejected; no CORS headers | 190 / 240 |
| 2 | **Extension: connect + fill text** (manifest, options, SW, content script on 5 ATS hosts, side panel, picker, Fill) | Options Test succeeds against a local joule; picker lists non-Upwork Jobs; Fill sets identity fields on Greenhouse and Lever fixtures in jsdom, skips non-empty and hidden; no submit call exists (grep test); denylist hosts refused | 380 / 200 |
| 3 | **Resume and cover letter attach** | Panel shows latest Tailored CV version/date or "Generate"; generate path calls existing drafts endpoint; file lands in `input.files` with `JB_CV_<company>.pdf`; change events fire; match returns both draft ids | 110 / 90 |
| 4 | **Ask + bank replay** | Ask returns text or option value; sensitive question returns null without invoking `ai.structured` (test fails if guard removed); prompt contains label inside untrusted block; out-of-list value rejected; exact `answers.yaml` hit replays in match with no Codex, except a sensitive label, which stays `leave` even when the bank has it; select maps saved answer to option | 180 / 160 |
| 5 | **Unknown-site injection** | Context-menu/command injects on a non-listed host with only `activeTab`; refused on `*.upwork.com`/`linkedin`/`indeed`/`glassdoor`; no `<all_urls>` in manifest (test reads manifest) | 60 / 40 |
| 6 | **Save to bank** | Saved question/answer appears on next match as a replay; two saves leave parseable list; >200 KB refused; state untouched | 50 / 60 |
| 7 | **Operator manual testing (no worker build; no telemetry)** | Operator runs real Jobs across Greenhouse (incl. `gh_jid` custom-host iframes), Ashby, Lever and unknown sites using the §5 "cannot be tested" list as checklist; findings become fix issues against slices 1–6 (hint-table rows, Ashby DOM names, combobox decision) | reserve 30 / 30 for resulting table fixes |

Totals ≈ 1000 prod / 820 test. Over-target rule: re-budget from the measured diff minus named excess.

## 11. Done-when map

The brief's issue is a request, not a checklist; acceptance is the slice table. Operator's stated criteria map as: "less typing" → slices 2–3 identity+resume without retyping; "minutes saved" and "field accuracy" → judged by the operator's own manual testing in slice 7 (no telemetry built: nothing automated reports them, acceptable at one user), backed by the classifier's fixture tests; "no budget" → no paid components, Codex use only on explicit Ask/Generate.

## 12. Security: yes

Untrusted page strings (labels, names, options) flow into a Codex prompt; joule PII flows into untrusted pages; a new write path (`answers.yaml`) fed by page-derived question text; new routes on a no-login server. Covered by invariants 3–7, caps, no CORS, side-panel UI, sensitive guard, honeypot skip, untrusted-block prompt (same pattern as `score.job_block`), existing no-tools read-only Codex sandbox.

## 13. Open for the operator

None. Q1 to Q4 are ruled (D7, D11, D10, D15). Remaining unknowns are live-site behaviors listed in §5, owned by the operator's manual testing (slice 7).
