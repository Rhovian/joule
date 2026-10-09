# joule

Job pipeline: job discovery, tailoring and applications (in the spirit of [job-ops](https://github.com/DaKheera47/job-ops)), plus Upwork job matching and proposals (in the spirit of [Upwork-AI-jobs-applier](https://github.com/kaymen99/Upwork-AI-jobs-applier)), built by coding agents coordinated with [Niles](https://github.com/Rhovian/niles).

Build spec: [docs/spec.md](docs/spec.md), charted as a Wayfinder map in this repo's GitHub Issues ([#1](https://github.com/Rhovian/joule/issues/1)).

Skills under `.claude/skills/` are vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at `24fe0ef` (MIT, see `.claude/skills/LICENSE`).

## Status

Working now:

- **Scans** from the dashboard, per Source or all at once: HN Who's Hiring, We Work Remotely, RemoteOK, Hotfix, Upwork, Indeed, LinkedIn and Glassdoor (the last three opt-in). New Jobs are deduplicated across Sources (Duplicates link to their Primary) and run through the cheap filters (deal-breakers, work type, pay floor, location, Upwork client floors).
- **Fit Score** from Codex, with a reason and for/against points; new surviving Primaries score during Scans, with manual retry and stale-score flags.
- **Dashboard** at `/`: triage table with unscored / Filtered / dismissed toggles, Job drawer, Scan sidebar with live progress and last-Scan counts per Source, Connect Upwork in a popup. Keys: `j`/`k` move, `o` open, `d` dismiss/restore, `s` Scans, `Esc` close.
- **Upwork** OAuth sign-in with token refresh; job search and screening questions.

Not built yet: Telegram alerts, Drafts (Tailored CV, Cover Letter, Proposal), web3.career, scheduled Upwork Scans and the 24h Upwork purge.

## Run

```sh
docker compose up -d --build
```

Open http://localhost:8000. The port is bound to `127.0.0.1` only; on a server, expose it with Tailscale Serve and set `UPWORK_REDIRECT_URI` to the tailnet URL, whose host is then also allowed.

Everything joule reads and writes lives in `~/.joule`, mounted into the container:

```
~/.joule/
  .env                    # UPWORK_CLIENT_ID, UPWORK_CLIENT_SECRET, UPWORK_REDIRECT_URI, …
  settings.yaml           # optional; enabled Sources, timeouts, … (spec §3)
  profile/preferences.yaml  # roles, pay floors, locations, deal-breakers (spec §4)
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
