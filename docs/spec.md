# joule build spec

The destination of [Wayfinder: joule build spec](https://github.com/Rhovian/joule/issues/1). Every section restates a decision from a closed ticket, linked in its heading; the ticket holds the reasoning. Terms are defined in [GLOSSARY.md](../GLOSSARY.md).

## 1. What joule is

A single-user, self-hosted tool that Scans job boards and Upwork, filters Jobs against the owner's Preferences, gives each a Fit Score, and writes Drafts (Tailored CV, Cover Letter, Proposal) on request. It never submits anything.

Out of scope: auto-submitting; application tracking and inbox sync; multiple users, accounts or in-app login; adding Jobs by hand; tracking AI spend or token usage; scraping Upwork.

## 2. Architecture

- **Backend:** Python, FastAPI, SQLite. One process, started with **one worker**. That process owns every Scan, the schedule and the Upwork content purge ([#11](https://github.com/Rhovian/joule/issues/11)).
- **Frontend:** Astro, built to static files and served by FastAPI. Plain CSS, vanilla client-side JS ([#10](https://github.com/Rhovian/joule/issues/10)).
- **AI:** Codex CLI on the owner’s subscription via `codex exec --output-schema`; every call returns Pydantic-validated output. Providers can be plugged in later.
- **Deployment:** one Docker container with the data dir mounted from outside. Runs on a Mac or Linux. The dashboard is reachable only over Tailscale (Tailscale Serve for HTTPS on a server) and has no login.

## 3. Data dir

Default `~/.joule/`, path configurable, never in git. Mounted into the container.

```
~/.joule/
  .env              # secrets (see .env.example)
  settings.yaml     # operating settings
  joule.db          # SQLite
  upwork-token.json # OAuth tokens, owner-only permissions
  drafts/           # rendered Tailored CV PDFs
  profile/
    cv.yaml         # Master CV
    preferences.yaml
    samples/        # optional writing samples
```

Settings and Profile files are re-read on every Scan and every Draft, so editing them needs no restart.

### `.env`
`UPWORK_CLIENT_ID`, `UPWORK_CLIENT_SECRET`, `UPWORK_REDIRECT_URI`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, plus provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and `WEB3_CAREER_TOKEN`.

### `settings.yaml` ([#11](https://github.com/Rhovian/joule/issues/11), [#13](https://github.com/Rhovian/joule/issues/13), [#14](https://github.com/Rhovian/joule/issues/14), [#7](https://github.com/Rhovian/joule/issues/7))

| Key | Default | Meaning |
| --- | --- | --- |
| `sources` | HN, WWR, RemoteOK, Upwork, Hotfix on; web3.career, Indeed off | enabled Sources |
| `schedule.upwork_minutes` | 15 | scheduled Upwork Scan interval ([#9](https://github.com/Rhovian/joule/issues/9)) |
| `upwork.scoring` | on | AI-score Upwork Jobs ([#9](https://github.com/Rhovian/joule/issues/9)) |
| `upwork.retention_hours` | 24 | Upwork content purge window |
| `models.scoring` / `models.drafts` | `{provider: codex, model: gpt-6-luna}` / `{provider: codex, model: null}` | model name; null uses the Codex default |
| `alert_threshold` | 75 | Telegram alert at or above this Fit Score |
| `max_scored_per_scan` | 100 | newest first; the rest stay unscored |
| `results_per_search` | 50 | per Indeed search |
| `max_age_days` | 14 | first Scan of a Source only |
| `source_timeout_seconds` | 120 | per Source within a Scan; detail calls run 5 at a time |

## 4. Profile ([#6](https://github.com/Rhovian/joule/issues/6))

One Profile, no personas.

- **`cv.yaml`, the Master CV:** JSON Resume layout (basics, work, projects, skills, education). Every entry has a stable ID so Tailored CVs can select it. Converted once, by hand, from the owner's PDF in a Claude Code session. joule has no import feature.
- **`preferences.yaml`:**
  - `roles` (target titles) and `seniority`
  - `work_types`: full-time / contract / freelance
  - `pay`: salary floor with currency, hourly floor, Upwork fixed-budget floor
  - `locations`:
    ```yaml
    locations:
      remote: { ok: true, countries: [..], timezones: [..] }
      cities:
        - { city: Lisbon, country: PT, arrangements: [onsite, hybrid] }
      aliases: { NYC: New York }
    ```
  - `deal_breakers`: keywords, companies, industries
  - `upwork_client`: minimum spend, minimum hire rate, payment verified
  - `scoring_notes`: free text for the scorer
  - `work_history_path`: e.g. `../work-history-notes`, read in place, never copied
  - No stack field: the owner is stack-agnostic.
- **`samples/`:** optional past Cover Letters and Proposals, used as style examples.

## 5. Data model ([#8](https://github.com/Rhovian/joule/issues/8), [#11](https://github.com/Rhovian/joule/issues/11), [#12](https://github.com/Rhovian/joule/issues/12))

### `jobs`
| Column | Notes |
| --- | --- |
| `id` | |
| `source`, `source_id` | **unique together**. `source_id` falls back to the link when a Source has no stable ID |
| `link`, `title` | **required**; a Job missing either is skipped and counted as a Scan error |
| `company` | the client on Upwork |
| `description` | raw |
| `location_raw`, `remote`, `city`, `country`, `arrangement`, `location_unclear` | parsed location |
| `pay_min`, `pay_max`, `pay_currency`, `pay_period` | `pay_period` is hour, year or fixed. Zero from a Source counts as unknown |
| `posted_at`, `first_seen_at` | |
| `state` | new / seen / dismissed; lives on the Primary only |
| `primary_id` | null on a Primary; set on a Duplicate |
| `filtered_reason` | null unless Filtered |
| `score`, `score_reason`, `score_points`, `scored_at`, `score_fingerprint` | Fit Score columns |
| `extra` | JSON of Source-only fields (Upwork client stats and screening questions, attribution links) |
| `content_purged_at` | Upwork only |

Blank means unknown. A blank never fails a filter.

### `drafts`
`id`, `job_id`, `kind` (tailored_cv / cover_letter / proposal), `text`, `pdf_path`, `note` (the regenerate note), `model`, `created_at`. Regenerating inserts a new row; the newest is shown.

### `scans`
`id`, `sources`, `trigger` (manual / scheduled), `started_at`, `finished_at`, `status` (running / done / interrupted / failed), `per_source` JSON: counts of new, Duplicate, Filtered, scored and skipped, errors, and alert-send failures.

## 6. Sources ([#3](https://github.com/Rhovian/joule/issues/3), [#14](https://github.com/Rhovian/joule/issues/14), [#2](https://github.com/Rhovian/joule/issues/2))

Each Source is an adapter that returns candidate Jobs in the common fields plus `extra`.

| Source | Access | Search input | Notes |
| --- | --- | --- | --- |
| HN Who's Hiring | HN Algolia API: newest `whoishiring` 'Who is hiring?' story → `items/<id>` top-level children | whole thread | Header line ('Company \| Role \| …') gives title, company, remote; no model call |
| We Work Remotely | all-jobs RSS | whole feed | Title is "Company: Role"; attribution link required; browser User-Agent |
| RemoteOK | `/api` JSON | whole feed | Skip the first (metadata) entry; attribution link required; salary 0 = unknown; USD, period yearly only when ≥10000, else unknown |
| web3.career (opt-in) | token API, `limit=100`, descriptions on | whole feed, no tag | Attribution required; verify field names against a live response |
| Indeed (opt-in) | JobSpy, pinned version | each Preferences role × (each city + remote) | `results_per_search` cap; surface partial or failed results as Scan errors |
| Upwork | GraphQL `marketplaceJobPostingsSearch` + detail query | each Preferences role, plus the API-side filters it supports (hourly floor, fixed-budget floor, payment verified) | No scraping, no RSS |
| Hotfix | public `/v1/jobs` JSON API | each Preferences role, newest 100 | Detail call for full description on new Jobs; no pay period: amounts kept, period set to yearly only when ≥10000, else unknown |

Out of scope for now: LinkedIn and Glassdoor (deferred), Google Jobs (unavailable).

## 7. Scan pipeline ([#11](https://github.com/Rhovian/joule/issues/11), [#7](https://github.com/Rhovian/joule/issues/7), [#8](https://github.com/Rhovian/joule/issues/8), [#13](https://github.com/Rhovian/joule/issues/13))

A Scan starts when the owner clicks Scan in the dashboard (any Source) or on the schedule (Upwork only, once enabled). For each Source in turn, each with its own timeout (a failing Source is recorded and the rest continue):

1. **Fetch** candidates; on a Source's first Scan, keep only those within `max_age_days`.
2. **Insert** new `(source, source_id)` rows; already-seen IDs are ignored.
3. **Link Duplicates:** match on tidied company + title (lowercase, punctuation stripped, Inc./Ltd dropped) **and** a compatible location (both remote, or the same city) against existing Primaries. Upwork Jobs are never matched. A match sets `primary_id`; the Duplicate takes the Primary's state and score.
4. **Cheap filters**, in order: deal-breakers (companies and industries by tidied name; keywords as whole words, case-insensitive, in title + description, no regex) → work type → pay floor (only when pay is given) → location rules → Upwork client floors. A failure sets `filtered_reason`. Matching is city + country plus aliases, no geocoding; a missing or unclear location sets `location_unclear` and passes.
5. **Score** surviving Primaries, newest first, up to `max_scored_per_scan` (Upwork only when `upwork.scoring` is on).
6. After all Sources: **one Telegram message** listing new Jobs that scored ≥ `alert_threshold`, or that are unscored Upwork Jobs that passed the filters. A send failure is recorded on the Scan and never fails it.

**One Scan at a time** — check-then-act on "is a Scan running?" and on Duplicate linking (read existing Jobs, then write). **Guarantee:** a single process with one worker owns all Scans, and an in-process lock is held for the whole Scan. A manual request during a Scan gets "Scan in progress"; a scheduled tick during a Scan is skipped; nothing is queued. On startup, any `running` Scan becomes `interrupted`. Running more than one server worker breaks this and is unsupported.

The same timer loop runs the **Upwork purge**: content (description, pay, client stats, questions) of Upwork Jobs older than `upwork.retention_hours` is deleted. ID, state and Drafts stay, and the Job shows "expired; open on Upwork".

## 8. Fit Score ([#7](https://github.com/Rhovian/joule/issues/7), [#4](https://github.com/Rhovian/joule/issues/4))

- **Output:** 0–100, a one-line reason, and up to three for/against points.
- **Prompt rubric:**

  | Part | Points |
  | --- | --- |
  | Experience relevance (Master CV + work history) | 40 |
  | Role and seniority | 25 |
  | Pay vs floor | 15 |
  | Location and arrangement | 10 |
  | `scoring_notes` | 10 |

- **Missing fields:** the scorer is told which fields are missing. Missing pay scores neutral and the reason says "pay not stated".
- **Failure:** one automatic retry, then the Job is left unscored (never scored low), with a "score again" action.
- **Fingerprint:** `score_fingerprint` hashes the Profile files, work-history notes and scoring model. A mismatch marks the score out of date.

## 9. Drafts ([#12](https://github.com/Rhovian/joule/issues/12))

Written only on request, per Job, from the drawer.

- **Tailored CV:**
  - The AI returns the IDs of the Master CV entries to include and their order, plus rewritten headline, summary and text for the bullet points it selected.
  - Code copies employers, titles and dates from the Master CV.
  - No second AI check; the owner reads every Draft.
  - Rendered to PDF with the `typst` Python package and one original template, not derived from job-ops.
- **Cover Letter** (board Jobs) and **Proposal** (Upwork; answers each screening question separately):
  - Text only, with a copy button.
  - Context: the Job, Master CV, all work-history notes, `samples/`, and the Fit Score reason.
- **Regenerate** with an optional note, which creates a new version. No in-app editor.

## 10. Upwork ([#2](https://github.com/Rhovian/joule/issues/2), [#16](https://github.com/Rhovian/joule/issues/16), [#9](https://github.com/Rhovian/joule/issues/9))

- **Scopes:** Read marketplace Job Postings, Common Entities (read), Job Details Entities (read), View UserDetails, Ontology (read). Nothing that writes.
- **Sign-in:** OAuth2 Authorization Code with PKCE from a "Connect Upwork" button. The callback is `UPWORK_REDIRECT_URI`, used identically in authorize and token exchange:
  - Locally: `http://localhost:8000/auth/upwork/callback`.
  - On a server: `https://<host>.<tailnet>.ts.net/auth/upwork/callback`.
- **Tokens:** kept in `upwork-token.json` (owner-only permissions), written atomically (temp file + rename). Refreshed shortly before the 24h access expiry, keeping any replacement refresh token. If the refresh token is dead (unused for over 2 weeks), the dashboard shows "Connect Upwork" again.
- **Refresh races:** check-then-act on token expiry — guarded by a single in-process lock around refresh, since one process owns all Upwork calls.
- **Scheduled Scans and scoring ([#9](https://github.com/Rhovian/joule/issues/9)):** Upwork approved the key with the requested scopes and callbacks but sent no written answer on scheduled search, scoring or retention. The owner treats them as permitted: scheduled Upwork Scans and Upwork scoring are on by default; retention stays 24h. Each remains a setting.

## 11. Dashboard ([#10](https://github.com/Rhovian/joule/issues/10))

Layout A from branch `prototype/dashboard` (`0c14dd1`), rewritten for production rather than promoted.

- **Left sidebar, always visible:**
  - Scan button per enabled Source.
  - Progress while a Scan runs, polling the Scan record every 2s.
  - "Scan in progress" refusal.
  - Last Scan per Source, with its counts and errors.
  - "Connect Upwork" when needed.
  - Collapses to a "Scans" button under 900px.
- **Main: a dense table of Primaries:**
  - Source links for each Duplicate.
  - Fit Score and reason; state.
  - Flags: location unclear, out-of-date score, Upwork expired.
  - Toggles: show unscored, show Filtered (with reason), show dismissed.
- **Right drawer, over the table:**
  - Job detail, including Upwork client stats and screening questions.
  - For/against points.
  - Draft buttons; version list; regenerate with note; copy; PDF link.
  - Unlink, on a Duplicate.
  - Score again, on an unscored Job.
- **Keys:** `j`/`k` move, `o` open, `d` dismiss (and restore), `s` focus Scans.

Opening a Job's drawer marks it seen.

Job text, `extra` and links come from outside sources: the dashboard escapes every field (descriptions are raw HTML) and makes only `http`/`https` links clickable. State-changing requests take a JSON body, so a cross-site form or empty POST cannot trigger them. The server answers only to `localhost`, `127.0.0.1` and the host of `UPWORK_REDIRECT_URI` (DNS rebinding), and forbids framing.

## 12. Open

Nothing open.
