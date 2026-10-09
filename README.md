# joule

Job pipeline: job discovery, tailoring and applications (in the spirit of [job-ops](https://github.com/DaKheera47/job-ops)), plus Upwork job matching and proposals (in the spirit of [Upwork-AI-jobs-applier](https://github.com/kaymen99/Upwork-AI-jobs-applier)), built by coding agents coordinated with [Niles](https://github.com/Rhovian/niles).

Build spec: [docs/spec.md](docs/spec.md), charted as a Wayfinder map in this repo's GitHub Issues ([#1](https://github.com/Rhovian/joule/issues/1)).

Skills under `.claude/skills/` are vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at `24fe0ef` (MIT, see `.claude/skills/LICENSE`).

## Status

Working now:

- **Scans** from the dashboard, per Source or all at once: We Work Remotely, RemoteOK, Hotfix and Upwork. New Jobs are deduplicated across Sources (Duplicates link to their Primary) and run through the cheap filters (deal-breakers, work type, pay floor, location, Upwork client floors).
- **Dashboard** at `/`: triage table with unscored / Filtered / dismissed toggles, Job drawer, Scan sidebar with live progress and last-Scan counts per Source, Connect Upwork in a popup. Keys: `j`/`k` move, `o` open, `d` dismiss/restore, `s` Scans, `Esc` close.
- **Upwork** OAuth sign-in with token refresh; job search and screening questions.

Not built yet: Fit Score, Telegram alerts, Drafts (Tailored CV, Cover Letter, Proposal), HN, web3.career and Indeed, scheduled Upwork Scans and the 24h Upwork purge.

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

`settings.yaml` and `preferences.yaml` are re-read on every Scan; no restart needed.

## Develop

```sh
uv run pytest && uv run ruff check && uv run ruff format --check
cd web && npm install && npm run build   # dashboard → web/dist
uv run python -m joule                   # http://localhost:8000, reads ~/.joule
```
