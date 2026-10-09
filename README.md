# joule

Job pipeline: job discovery, tailoring and applications (in the spirit of [job-ops](https://github.com/DaKheera47/job-ops)), plus Upwork job matching and proposals (in the spirit of [Upwork-AI-jobs-applier](https://github.com/kaymen99/Upwork-AI-jobs-applier)), built by coding agents coordinated with [Niles](https://github.com/Rhovian/niles).

Build spec: [docs/spec.md](docs/spec.md), charted as a Wayfinder map in this repo's GitHub Issues ([#1](https://github.com/Rhovian/joule/issues/1)).

Skills under `.claude/skills/` are vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at `24fe0ef` (MIT, see `.claude/skills/LICENSE`).

## Run

```sh
mkdir -p ~/.joule/profile
$EDITOR ~/.joule/profile/preferences.yaml   # at least `roles: [...]`; see docs/spec.md §4
docker compose up -d --build
```

Open http://localhost:8000. Data lives in `~/.joule` (override with `JOULE_DATA_DIR`); secrets go in `~/.joule/.env`. The port is bound to `127.0.0.1` only; on a server, expose it with Tailscale Serve and set `UPWORK_REDIRECT_URI` to the tailnet URL, whose host is then also allowed. On Linux, set `JOULE_UID`/`JOULE_GID` if your user isn't 1000.
