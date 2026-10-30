# joule

Job pipeline: job discovery, tailoring and applications (in the spirit of [job-ops](https://github.com/DaKheera47/job-ops)), plus Upwork job matching and proposals (in the spirit of [Upwork-AI-jobs-applier](https://github.com/kaymen99/Upwork-AI-jobs-applier)), built by coding agents coordinated with [Niles](https://github.com/Rhovian/niles).

Build spec: [docs/spec.md](docs/spec.md), charted as a Wayfinder map in this repo's GitHub Issues ([#1](https://github.com/Rhovian/joule/issues/1)).

Skills under `.claude/skills/` are vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at `24fe0ef` (MIT, see `.claude/skills/LICENSE`).

## Status

Working now:

- **Scans** from the dashboard, per Source or all at once: HN Who's Hiring, We Work Remotely, Reddit, RemoteOK, Hotfix, Upwork, Working Nomads, FreeHire, Golang Jobs, getarustjob, plus opt-in Indeed, LinkedIn, Glassdoor and Adzuna US. New Jobs are deduplicated across Sources (Duplicates link to their Primary) and run through the cheap filters (deal-breakers, work type, pay floor, location, Upwork client floors).
  We Work Remotely uses the full-stack, back-end, DevOps/sysadmin and programming category RSS feeds, with repeated Jobs returned once.
  Reddit uses the latest r/forhire and r/hiring RSS entries marked `[Hiring]`, enabled by default without credentials. Requests pause 5 seconds between feeds; a 429 retries once after `Retry-After` (capped at 20 seconds, default 15). Failed feeds are logged while successful feeds keep their Jobs; if both fail, the Scan reports a Source error. Feed coverage is limited to the returned recent entries.
- **Fit Score** from Codex, with a reason and for/against points; Scans queue unscored eligible Primaries from their Sources, including earlier failures and Jobs left by the Scan cap. Scoring is serial, with three attempts per Job and 30/60-second retry delays; an exhausted failure pauses the queue for 120 seconds before the next Job. Remaining unscored Jobs are retried on a later Scan. The triage **Score all** button queues the visible unscored Jobs (including Filtered or dismissed Jobs if shown), without the automatic Scan cap. Purged Jobs cannot be scored. Manual retry and stale-score flags are available.
- **Dashboard** at `/`: triage table with unscored / Filtered / dismissed / applied toggles and Source checkboxes, Job drawer, Scan sidebar with live progress and last-Scan counts per Source, Connect Upwork in a popup. Keys: `j`/`k` move, `o` open, `d` dismiss/restore, `a` applied/unmark, `s` Scans, `Esc` close.
- **Upwork** OAuth sign-in with token refresh; job search and screening questions.
- **Manual input** in the dashboard: paste an Upwork Job description and screening questions for a one-off Proposal (cover text and answers), or a Job title and description from another Source for a Tailored CV PDF. Copy or download the output before leaving; inputs and outputs are not saved or queued.
- **Drafts** from the Job drawer: Cover Letter (board Jobs) or Proposal with one answer per screening question (Upwork), and a Tailored CV rendered to PDF from `profile/cv.yaml`. Regenerate with a note keeps every version.

- **Scheduled Upwork Scans** every `schedule.upwork_minutes`, off until switched on in the Scan sidebar; Upwork content is purged after `upwork.retention_hours`.

- **Telegram** Upwork-only manual review queue with automatic Drafts, Start, Apply, Rework and Skip; Apply asks for bid and boost Connects, then submits an Upwork Proposal only after Send confirmation. Add to queue in the Job drawer queues any Upwork Job; Start Telegram queue in the Scan sidebar begins review.

- **Browser extension** (unpacked, `extension/`, see its README): on Greenhouse, Lever and Ashby application forms, the side panel detects the Job from the page URL (with a manual picker when unmatched). Fill your name, email, phone, LinkedIn, GitHub, site and current company from `profile/cv.yaml` into empty fields. Saved answers replay from `profile/answers.yaml`; **Ask** answers custom questions from your Profile. **Save to bank** keeps the field's current answer after your edits for replay on the next Fill. Fill also attaches the latest Tailored CV, generating one only when none exists, and waits before reporting completion. Missing Jobs, resume inputs, and attachment failures are reported in the Fill result. On other sites, use the **Fill with Joule** context menu or keyboard shortcut to open the side panel. It never submits or marks a Job applied; you review, submit and press `a`. Not for Upwork, LinkedIn, Indeed or Glassdoor. Every Fill saves a private diagnostic JSON file under `~/.joule/traces/` on the joule server; an agent can replay a public form URL with `cd extension && npm run replay -- URL` (setup and limits in `extension/README.md`). Replay also clicks Submit with browser networking blocked to capture the page’s submit-time validation; no application reaches the employer.

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
