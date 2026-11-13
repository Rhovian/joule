# joule

Job pipeline: job discovery, tailoring and applications (in the spirit of [job-ops](https://github.com/DaKheera47/job-ops)), plus Upwork job matching and proposals (in the spirit of [Upwork-AI-jobs-applier](https://github.com/kaymen99/Upwork-AI-jobs-applier)), built by coding agents coordinated with [Niles](https://github.com/Rhovian/niles).

Build spec: [docs/spec.md](docs/spec.md), charted as a Wayfinder map in this repo's GitHub Issues ([#1](https://github.com/Rhovian/joule/issues/1)).

Skills under `.claude/skills/` are vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at `24fe0ef` (MIT, see `.claude/skills/LICENSE`).

## Status

Working now:

- **Scans** from the dashboard, per Source or all at once: HN Who's Hiring, We Work Remotely, RemoteOK, Hotfix, Upwork, Working Nomads, FreeHire, Golang Jobs, getarustjob, plus opt-in Indeed, LinkedIn, Glassdoor and Adzuna US. New Jobs are deduplicated across Sources (Duplicates link to their Primary) and run through the cheap filters (deal-breakers, work type, pay floor, location, Upwork client floors).
  We Work Remotely uses the full-stack, back-end, DevOps/sysadmin and programming category RSS feeds, with repeated Jobs returned once.
- **Fit Score** from Codex, with a reason and for/against points; Scans queue unscored eligible Primaries from their Sources, including earlier failures and Jobs left by the Scan cap. Scoring is serial, with three attempts per Job and 30/60-second retry delays; an exhausted failure pauses the queue for 120 seconds before the next Job. Remaining unscored Jobs are retried on a later Scan. The triage **Score all** button queues the visible unscored Jobs (including Filtered or dismissed Jobs if shown), without the automatic Scan cap. Purged Jobs cannot be scored. Manual retry and stale-score flags are available.
- **Dashboard** at `/`: triage table with built-in Inbox / 90+ only / Upwork views (last chosen preset remembered in this browser; filter edits are marked modified; Fit ≥ 90 is a removable chip applied before the row cap), title/company/reason search, Rank / Fit Score / Newest sorting, row selection and bulk Dismiss / Applied / Score, undo for state changes, Dismiss below 70 for unfiltered inbox Jobs, New / Unscored / Filtered / Applied / Dismissed toggles with counts and a searchable Sources menu (All / None / With new Jobs), split Job drawer with Draft versions and regeneration notes, Scans page with live progress, inline errors, Source search and All / Failed / Stale / Never scanned filters, Connect Upwork in a popup. Keys: `j`/`k` move (also with the drawer open), `o` open, `1`–`4` jump drawer sections, `c` copy Draft, `d` dismiss/restore, `a` applied/unmark, `s` Scans, `f` Sources, `/` search, `x` select row, `z` undo, `?` all shortcuts, `Esc` clear selection / close / return to Triage. On phones, Triage uses swipeable cards and a filter sheet; bottom Triage / Scans tabs become Dismiss / Applied / Copy in the Job view. Desktop tabs share the top bar; colours follow the system theme by default.
- **Pipeline** (top tab or `p`): Applied / Screen / Interview / Offer / Closed board, with Accepted tagged under Offer, drawer history and date/note editing. Keys: `h`/`l` column, `j`/`k` card, `o` open, `[`/`]` back/on, `x` close, `e` date/note, `z` undo. Pointer controls offer the same moves. Flow, headline reply rates and Fit Score / Source reply rates share an application-period filter; `v` hides the flow. Pipeline move undo appends a manual Move recording the prior Stage, closure and next date with an “Undo” note; it never deletes history. Unmark leaves Pipeline; re-applying, including through state undo, starts a fresh Applied entry. See the [API contract](docs/spec.md#pipeline-135).
- **Upwork** OAuth sign-in with token refresh; job search and screening questions.
- **Settings** (top bar or `,`): System / Light / Dark theme and Compact / Comfortable Triage density, persisted in `appearance.json` beside the database. Connections use Upwork’s live check, Telegram worker configuration/reply state, and the latest Joule Fill trace (not an extension heartbeat). `GET /api/appearance` exposes the shared theme for the panel integration.
- **Master CV & profile** in Settings: Open renders the complete `profile/cv.yaml` as an untailored PDF. Replace validates the YAML and renderer before atomically installing it, keeping the previous file as `profile/cv.yaml.bak`. Names and title are public in the card; contact details, location, links, salary, notes and unknown fields show only whether they are set. Section counts summarise the CV. The out-of-date Fit Score banner queues all stale retained Primary Jobs, across Sources and states, excluding unscored, Duplicate and purged Jobs. The next score and Draft use the replacement.
- **Filtered rules** in Settings is read-only: effective deal-breakers, work type, pay floor, location and Upwork client floors from `profile/preferences.yaml`, including loader defaults. Edit that file; each Scan re-reads it. Counts include all Primary Jobs with stored Filtered reasons across Sources and states: recognised reason prefixes map to the five filters; other/legacy reasons have their own bucket. Counts describe the first failed filter at Scan time, not a re-evaluation against today's file. Review Filtered enables the existing Triage toggle without resetting other controls. Industry and timezone preferences are shown but not evaluated by cheap filters.
- **Answer bank** in Settings: search, add and edit the effective answers in `profile/answers.yaml`; the next Joule Fill replays edited answers. New extension saves carry a “saved from Fill” mark; existing entries have unknown origin. Additions from Settings, Fill and Telegram append under a shared lock, preserving comments and formatting in the block-style YAML list. An explicit Settings edit atomically replaces and re-serialises the file, so comments and hand formatting are lost on edit. Use counts are not recorded.
- **Fill a Job** in the dashboard (or `n`): paste a posting, correct its detected kind, title, company and CV filename, then choose outputs. Put screening questions one per line under “Application questions”. Upwork supports a Proposal and its answers; any posting supports a Cover Letter and a Tailored CV PDF. Standalone board-question answers remain unavailable. Detection is local; copy or download before leaving, because inputs and outputs are not saved or queued.
- **Drafts** from the Job drawer: Cover Letter (board Jobs) or Proposal with one answer per screening question (Upwork), and a Tailored CV rendered to PDF from `profile/cv.yaml`. Regenerate with a note keeps every version.

- **Scheduled Upwork Scans** every `schedule.upwork_minutes`, off until switched on in the Scan sidebar; Upwork content is purged after `upwork.retention_hours`.

- **Telegram** Upwork-only manual review queue with automatic Drafts, Start, Apply, Rework and Skip; Apply asks for bid and boost Connects, then submits an Upwork Proposal only after Send confirmation. Add to queue in the Job drawer queues any Upwork Job; Start Telegram queue in the Scan sidebar begins review.

- **Browser extension** (unpacked, `extension/`, see its README): on Greenhouse, Lever and Ashby application forms, the side panel detects the Job from the page URL (with a manual picker when unmatched). Fill your name, email, phone, LinkedIn, GitHub, site and current company from `profile/cv.yaml` into empty fields. Saved answers replay from `profile/answers.yaml`; **Ask** answers custom questions from your Profile. **Save to bank** keeps the field's current answer after your edits for replay on the next Fill. Fill also attaches the latest Tailored CV, generating one only when none exists, and waits before reporting completion. Missing Jobs, resume inputs, and attachment failures are reported in the Fill result. When a Tailored CV cannot be attached, Fill offers **Download Tailored CV** if the PDF is available, including when no resume input is found or an existing file is preserved. On other sites, use the **Fill with Joule** context menu or keyboard shortcut to open the side panel. It never submits or marks a Job applied; you review, submit and press `a`. Not for Upwork, LinkedIn, Indeed or Glassdoor. Every Fill saves a private diagnostic JSON file under `~/.joule/traces/` on the joule server; an agent can replay a public form URL with `cd extension && npm run replay -- URL` (setup and limits in `extension/README.md`). Replay also clicks Submit with browser networking blocked to capture the page’s submit-time validation; no application reaches the employer.

Not built yet: web3.career.

## Run

```sh
docker compose up -d --build
```

Open http://localhost:8000. The port is bound to `127.0.0.1` only; on a server, expose it with Tailscale Serve and set `UPWORK_REDIRECT_URI` to the tailnet URL, whose host is then also allowed.

Everything joule reads and writes lives in `~/.joule`, mounted into the container:

```
~/.joule/
  .env                    # UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET, UPWORK_REDIRECT_URI, ADZUNA_APP_ID, ADZUNA_APP_KEY, …
  settings.yaml           # optional; enabled Sources, timeouts, … (spec §3)
  profile/preferences.yaml  # roles, pay floors, locations, deal-breakers (spec §4)
  profile/cv.yaml         # Master CV, JSON Resume layout with stable ids (spec §4)
  profile/samples/        # optional past Cover Letters and Proposals, used as style examples
  profile/portfolio.yaml  # optional links (sites, Loom videos) only drafts cite
  profile/answers.yaml    # screening answers saved by Telegram Fill, adapted by later Proposals
  joule.db                # SQLite, created on first start
  upwork-token.json       # written by Connect Upwork
```

Scoring uses the host’s file-backed Codex login and one persistent, serialized Codex session shared by Scans and manual rescoring. The Profile and rubric are loaded once per session; logs show input and cached token counts. Sessions rotate after an hour, 100 attempts, a context limit, or a Profile/model change (spec §8). Cache hits reduce repeated context processing but are not guaranteed or necessarily free. Drafts and Fill keep separate per-call runs. Work history must live under `~/.joule` to be visible in Docker.

`settings.yaml` and `preferences.yaml` are re-read on every Scan; no restart needed. Job age cutoffs default to 3 days, with 7-day overrides for `golangjobs` and `getarustjob`; edit `source_max_age_days` in `settings.yaml` (spec §3) to change them.

## Develop

```sh
uv run pytest && uv run ruff check && uv run ruff format --check
cd web && npm install && npm run build   # dashboard → web/dist
cd extension && npm install && npm test  # browser extension; load extension/ unpacked in Chrome
uv run python -m joule                   # http://localhost:8000, reads ~/.joule
```
