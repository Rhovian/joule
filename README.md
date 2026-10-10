# joule

Job pipeline: job discovery, tailoring and applications (in the spirit of [job-ops](https://github.com/DaKheera47/job-ops)), plus Upwork job matching and proposals (in the spirit of [Upwork-AI-jobs-applier](https://github.com/kaymen99/Upwork-AI-jobs-applier)), built by coding agents coordinated with [Niles](https://github.com/Rhovian/niles).

Build spec: [docs/spec.md](docs/spec.md), charted as a Wayfinder map in this repo's GitHub Issues ([#1](https://github.com/Rhovian/joule/issues/1)).

Skills under `.claude/skills/` are vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at `24fe0ef` (MIT, see `.claude/skills/LICENSE`).

## Status

Working now:

- **Scans** from the dashboard, per Source or all at once: HN Who's Hiring, We Work Remotely, RemoteOK, Hotfix, Upwork, Working Nomads, FreeHire, Golang Jobs, getarustjob, plus opt-in Indeed, LinkedIn, Glassdoor and Adzuna US. New Jobs are deduplicated across Sources (Duplicates link to their Primary) and run through the cheap filters (deal-breakers, work type, pay floor, location, Upwork client floors).
- **Fit Score** from Codex, with a reason and for/against points; new surviving Primaries score during Scans, with manual retry and stale-score flags.
- **Dashboard** at `/`: triage table with unscored / Filtered / dismissed / applied toggles and a Source picker, Job drawer, Scan sidebar with live progress and last-Scan counts per Source, Connect Upwork in a popup. Keys: `j`/`k` move, `o` open, `d` dismiss/restore, `a` applied/unmark, `s` Scans, `Esc` close.
- **Upwork** OAuth sign-in with token refresh; job search and screening questions.
- **Drafts** from the Job drawer: Cover Letter (board Jobs) or Proposal with one answer per screening question (Upwork), and a Tailored CV rendered to PDF from `profile/cv.yaml`. Regenerate with a note keeps every version.

- **Scheduled Upwork Scans** every `schedule.upwork_minutes`, off until switched on in the Scan sidebar; Upwork content is purged after `upwork.retention_hours`.

- **Telegram** manual review queue with automatic Drafts, Start, Apply, Rework and Skip; Apply marks state and provides the submission link.

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
  joule.db                # SQLite, created on first start
  upwork-token.json       # written by Connect Upwork
```

Scoring uses the host’s Codex login; work history must live under `~/.joule` to be visible in Docker.

`settings.yaml` and `preferences.yaml` are re-read on every Scan; no restart needed.

## Develop

```sh
uv run pytest && uv run ruff check && uv run ruff format --check
cd web && npm install && npm run build   # dashboard → web/dist
uv run python -m joule                   # http://localhost:8000, reads ~/.joule
```
