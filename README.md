# joule

Job pipeline: job discovery, tailoring and applications (in the spirit of [job-ops](https://github.com/DaKheera47/job-ops)), plus Upwork job matching and proposals (in the spirit of [Upwork-AI-jobs-applier](https://github.com/kaymen99/Upwork-AI-jobs-applier)), built by coding agents coordinated with [Niles](https://github.com/Rhovian/niles).

Build spec: [docs/spec.md](docs/spec.md), charted as a Wayfinder map in this repo's GitHub Issues ([#1](https://github.com/Rhovian/joule/issues/1)).

Skills under `.claude/skills/` are vendored from [mattpocock/skills](https://github.com/mattpocock/skills) at `24fe0ef` (MIT, see `.claude/skills/LICENSE`).

## Status

Working now:

- **Scans** from the dashboard, per Source or all at once: HN Who's Hiring, We Work Remotely, RemoteOK, Hotfix, Upwork, Working Nomads, FreeHire, Golang Jobs, getarustjob, plus opt-in Indeed, LinkedIn, Glassdoor and Adzuna US. New Jobs are deduplicated across Sources (Duplicates link to their Primary) and run through the cheap filters (deal-breakers, work type, pay floor, location, Upwork client floors).
  We Work Remotely uses the full-stack, back-end, DevOps/sysadmin and programming category RSS feeds, with repeated Jobs returned once.
- **Fit Score** from Codex, with a reason and for/against points; Scans queue unscored eligible Primaries from their Sources, including earlier failures and Jobs left by the Scan cap. Scoring is serial, with three attempts per Job and 30/60-second retry delays; an exhausted failure pauses the queue for 120 seconds before the next Job. Remaining unscored Jobs are retried on a later Scan. To score Jobs in bulk, select rows and use **Score** in the selection toolbar, without the automatic Scan cap. The Filters bar has no Score all button; the unscored Job drawer retains **Score this Job** and **Score all** visible unscored Jobs (including Filtered or dismissed Jobs if shown). Purged Jobs cannot be scored. Manual retry and stale-score flags are available.
- **Dashboard** at `/`: triage table with title/company/reason search; click Fit, Job, Reason, Sources, Age or State headers to sort, clicking again to reverse direction (Fit descending by default; unscored Jobs stay last). Sorting applies before the 500-row cap. Select individual rows or use the checkbox at the top of the selection column to select/clear all visible Jobs for bulk Dismiss / Applied / Score (a mixed checkbox indicates partial selection), with Clear selection and undo for state changes. New / Unscored / Filtered / Applied / Dismissed toggles have counts; the searchable Sources menu offers All / None / With new Jobs. Split Job drawer with a single Apply link (Lever postings open the application form, including previously stored Jobs), Fit details and Pipeline history. Dismiss and Mark applied in the desktop split view open the Job selected by the refreshed table after a successful state change; when no Jobs remain, the existing empty state appears. Cover Letter generation, Tailored CV and field Ask live in the extension, Scans page with live progress, dismissible inline error banners (remembered in this browser until the Scan or errors change; the failed badge reopens details and Retry remains available), Source search and All / Failed / Stale / Never scanned filters, Connect Upwork in a popup. Dashboard hotkeys and the shortcuts help menu have been removed; use the visible controls, including Close and Clear selection. On phones, Triage uses swipeable cards and a filter sheet; bottom Triage / Scans tabs become Dismiss / Applied in the Job view. Desktop tabs share the top bar; colours follow the system theme by default.
- **Gmail application tracking**: a separate scheduled Codex agent reads Gmail through a read-only MCP server. Certain replies move Jobs automatically. Late replies reopen automatic No reply closures; acceptance stops at Offer with a review flag. Confirmations reuse a matching existing Job and mark it Applied, creating a Manual Job only when none matches. Uncertain matches are flagged for review. Setup below uses your own free Google Cloud OAuth client; IMAP/app passwords are removed.
- **Pipeline** (top tab): Applied / Screen / Interview / Offer / Closed board, with Accepted tagged under Offer, drawer history and date/note editing. Pointer controls move Jobs and edit dates and notes. Applied Jobs without a reply auto-close as No reply at 21 days (`pipeline.no_reply_days` in `settings.yaml`). Follow-up Drafts have been removed. Flow, headline reply rates and Fit Score / Source reply rates share an application-period filter; the Hide / Show button toggles the flow. Pipeline move undo appends a manual Move recording the prior Stage, closure and next date with an “Undo” note; it never deletes history. Unmark leaves Pipeline; re-applying, including through state undo, starts a fresh Applied entry. See the [API contract](docs/spec.md#pipeline-135).
- **Upwork** OAuth sign-in with token refresh; job search and screening questions.
- **Settings** (top bar): System / Light / Dark theme and Compact / Comfortable Triage density, persisted in `appearance.json` beside the database. Connections use Upwork’s live check, Telegram worker configuration/reply state, and the latest Joule Fill trace (not an extension heartbeat). `GET /api/appearance` exposes the shared theme for the panel integration.
- **Master CV & profile** in Settings: Open renders the complete `profile/cv.yaml` as an untailored PDF. Replace validates the YAML and renderer before atomically installing it, keeping the previous file as `profile/cv.yaml.bak`. Names and title are public in the card; contact details, location, links, salary, notes and unknown fields show only whether they are set. Section counts summarise the CV. The out-of-date Fit Score banner offers Rescore for all stale retained Primary Jobs, across Sources and states, excluding unscored, Duplicate and purged Jobs. **Dismiss** hides the banner in this browser until the Master CV changes again, without rescoring Jobs or changing their Fit Scores or stale flags. The next score and Draft use the replacement.
- **Filtered rules** in Settings is read-only: effective deal-breakers, work type, pay floor, location and Upwork client floors from `profile/preferences.yaml`, including loader defaults. Edit that file; each Scan re-reads it. Counts include all Primary Jobs with stored Filtered reasons across Sources and states: recognised reason prefixes map to the five filters; other/legacy reasons have their own bucket. Counts describe the first failed filter at Scan time, not a re-evaluation against today's file. Review Filtered enables the existing Triage toggle without resetting other controls. Industry and timezone preferences are shown but not evaluated by cheap filters.
- **Answer bank** in Settings: search, add and edit the effective answers in `profile/answers.yaml`; the next Joule Fill replays edited answers. New extension saves carry a “saved from Fill” mark; existing entries have unknown origin. Additions from Settings, Fill and Telegram append under a shared lock, preserving comments and formatting in the block-style YAML list. An explicit Settings edit atomically replaces and re-serialises the file, so comments and hand formatting are lost on edit. Use counts are not recorded.
- **Fill a Job** in the dashboard: paste a board posting, correct its detected kind, title, company and CV filename, then choose a Cover Letter and/or Tailored CV PDF. Upwork postings direct you to Telegram; pasted-question answers are unavailable. Detection is local; copy or download before leaving, because inputs and outputs are not saved or queued.
- **Drafts**: the extension generates and copies Cover Letters for board Jobs, generates/attaches/downloads the Tailored CV, and offers field Ask. Telegram is the sole UI for Upwork Proposals: review, Rework and confirmed Send. The Job drawer has no Draft generation, version, copy or download controls.

- **Scheduled Upwork Scans** every `schedule.upwork_minutes`, off until switched on in the Scan sidebar; Upwork content is purged after `upwork.retention_hours`.

- **Telegram** Upwork-only manual review queue with automatic Drafts, Start, Apply, Rework and Skip; Apply asks for bid and boost Connects, then submits an Upwork Proposal only after Send confirmation. Add to queue in the Job drawer queues any Upwork Job; Start Telegram queue in the Scan sidebar begins review.

- **Browser extension** (unpacked, `extension/`, see its README): on Greenhouse, Lever and Ashby application forms, the side panel detects the Job from the page URL (with a manual picker when unmatched). Fill your name, email, phone, LinkedIn, GitHub, site and current company from `profile/cv.yaml` into empty fields. Saved answers replay from `profile/answers.yaml`; **Ask** previews an editable Profile answer without changing the form; **Fill field** writes your edited text to its field. Generation continues when you switch tabs/windows or close the panel; returning to the original Job and tab restores Fill results, Ask previews/edits, Cover Letters and CV downloads for the browser session. Form writes stay bound to the original page and document. **Save to bank** keeps the field's current answer after your edits for replay on the next Fill. With **Attach** checked, Fill also attaches the latest Tailored CV, generating one only when none exists, and waits before reporting completion. Missing Jobs, resume inputs, and attachment failures are reported in the Fill result. For every matched Job, **Download Tailored CV** is always available on the CV card, before or after Fill and with Attach unchecked. It reuses the saved CV or generates one if needed; any PDF prepared during a failed attachment remains available there. On other sites, use the **Fill with Joule** context menu to open the side panel. It never submits. It never marks a Job applied without your click. After Fill, **Fill field** overwrites only the shown answer’s field; **Mark applied** moves the Job into Pipeline and offers **Undo**. On no match, **Create Job from this page** lets you review title/company/kind/URL, then saves a Manual Job and tries to start scoring; URL matches reuse the existing Job. Not for Upwork, LinkedIn, Indeed or Glassdoor. Every Fill saves a private diagnostic JSON file under `~/.joule/traces/` on the joule server; an agent can replay a public form URL with `cd extension && npm run replay -- URL` (setup and limits in `extension/README.md`). Replay also clicks Submit with browser networking blocked to capture the page’s submit-time validation; no application reaches the employer.

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
  gmail/client.json       # Google Cloud desktop OAuth client (private)
  gmail/credentials/      # private Gmail-only offline OAuth grant
```

Scoring uses the host’s file-backed Codex login and one persistent, serialized Codex session shared by Scans and manual rescoring. The Profile and rubric are loaded once per session; logs show input and cached token counts. Sessions rotate after an hour, 100 attempts, a context limit, or a Profile/model change (spec §8). Cache hits reduce repeated context processing but are not guaranteed or necessarily free. Drafts and Fill keep separate per-call runs. Work history must live under `~/.joule` to be visible in Docker.

Remove the retired `pipeline.follow_up_days` key from existing `settings.yaml` files; `pipeline.no_reply_days` remains supported.

`settings.yaml` and `preferences.yaml` are re-read on every Scan; no restart needed. Job age cutoffs default to 3 days, with 7-day overrides for `golangjobs` and `getarustjob`; edit `source_max_age_days` in `settings.yaml` (spec §3) to change them.

## Develop

```sh
uv run pytest && uv run ruff check && uv run ruff format --check
cd web && npm install && npm run build   # dashboard → web/dist
cd extension && npm install && npm test  # browser extension; load extension/ unpacked in Chrome
uv run python -m joule                   # http://localhost:8000, reads ~/.joule
```

The focused Gmail tests mock the mail agent; no mailbox credentials are needed. Check the pinned MCP runtime without credentials with `docker build --target gmail -t joule-gmail-check .`, then `docker run --rm -v "$PWD:/check:ro" joule-gmail-check /opt/gmail/bin/python /check/tests/gmail_mcp_smoke.py`. This exercises real MCP stdio with mocked Google calls, scope enforcement and export refusal.

## Gmail setup (personal use)

Gmail API access within standard quotas has no additional API charge and works with a free personal Gmail account. Codex usage and hosting are separate. This uses the community [Workspace MCP server](https://github.com/taylorwilsdon/google_workspace_mcp), pinned in Docker, over Gmail REST; it does not use Google's Workspace-gated MCP preview.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project, select it, and enable **Gmail API** under APIs & Services → Library. No paid Workspace plan is needed.
2. Open **Google Auth Platform** → Branding/Audience (or OAuth consent screen). Configure an **External** app with your name/email and personal-use details. Under Data Access add only `https://www.googleapis.com/auth/gmail.readonly`; do not add compose, modify, full-mail or identity scopes.
3. Set the app's publishing status to **In Production**, not Testing. External Testing Gmail refresh tokens expire after seven days. In Production is separate from verification: an owner-only personal-use app can remain unverified. Expect Google's “Google hasn't verified this app” warning; continue through Advanced only for your own client. Personal-use exemptions do not authorize distributing a shared mail service. See [Google's personal-use exception](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification#personal-use) and [token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).
4. Under Clients create **Desktop app** OAuth credentials. Download the JSON to `~/.joule/gmail/client.json`. Keep it private (`chmod 700 ~/.joule/gmail; chmod 600 ~/.joule/gmail/client.json`). Add `JOULE_GMAIL_ACCOUNT=you@gmail.com` to `~/.joule/.env`, using the mailbox's canonical primary address in lowercase.
5. Build with `docker compose build joule`. Stop Joule while authorizing so the callback port is free: `docker compose stop joule`. Run the one-time helper (replace the email):

   ```sh
   docker compose run --rm --service-ports -e JOULE_GMAIL_ACCOUNT=you@gmail.com --entrypoint /opt/gmail/bin/python joule -I /app/joule/gmail_server.py authorize
   ```

   Open the printed URL in your browser and authorize the same account. The loopback callback uses port 8090, published only on 127.0.0.1. On a remote Docker host, forward it first (`ssh -L 8090:localhost:8090 your-host`), and open the URL on your local browser. The helper requests offline access, verifies the actual token has exactly gmail.readonly and that it belongs to the configured account, then saves it privately. If Google reports extra scopes, revoke the old app grant under your Google Account's third-party connections and repeat; editing the consent screen does not narrow existing grants.
6. Run `docker compose up -d joule`. Settings and Pipeline show local Gmail configuration and the last check attempt. Checks start immediately, then run every 15 minutes. A failed run shows unavailable; repeat authorization if the grant was revoked or expired. Initial search covers 14 days in ten-message pages; each run handles one page and persists its cursor. A frozen window prevents retries from growing indefinitely. Processing backlog is shown separately from failed checks. Later windows overlap the previous successful checkpoint by one day and deduplicate Gmail message IDs. Replies later than an automatic No reply closure reopen it and move forward, set a Next date, or re-close it as Rejected. Other closures and backward replies remain review flags. Acceptance mail stops at Offer and is always flagged for the operator; mail never sets Accepted. A confirmation matching one existing Job by posting URL or normalized company/title marks that Job Applied without creating a duplicate; ambiguous matches or Jobs changed during the run remain flagged.

Read-only means mail is never sent, marked read, changed or deleted. Pipeline Moves are automatic. Review flagged messages through the Pipeline Job controls, then dismiss the flag. Joule keeps sender/subject, one line and metadata only, and disables MCP message exports and attachment tools. Mail is processed by Codex; use provider data settings appropriate for private Google data. No mail run joins the scoring session. To disconnect, stop Joule, revoke the grant in Google Account connections, remove `JOULE_GMAIL_ACCOUNT` and `~/.joule/gmail/credentials`, then restart. Historical matched metadata and Pipeline history remain; old IMAP credentials and pending suggestions are retired on startup.
