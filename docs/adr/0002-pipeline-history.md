# ADR-0002: Pipeline current state and retained Move history

Accepted: 2026-11-12. Issue #135; stage names, Closed reasons and manual/auto provenance follow the lead's operator-delegated ruling.

`jobs.state = applied` remains the membership flag used by Triage and Telegram. Pipeline adds `pipeline_moves` snapshots and a `pipeline` row pointing at the first and current Move. Stage, Closed reason, next date, provenance and note live in the Move snapshot, with a UTC creation date; there is no duplicated mutable stage column or replay mechanism.

Job-state updates and Pipeline entry/removal share a transaction. Telegram's provisional applied flag reserves an in-flight Upwork Send; it creates a manual Applied Move only on successful submission, before notifying Telegram. Failed Send restores the flag and does not manufacture a Pipeline entry. This preserves ADR-0001's manual-applied invariant; no new auto-apply or auto-close behaviour is introduced.

Stage/date/note changes append a snapshot and advance the current pointer under a SQLite write transaction. Repeating an unchanged Stage/Closed reason/date without a note is a no-op. Selecting a Stage clears the Closed reason unless one is explicitly supplied. Closing retains the last Stage and applied flag. Updating or clearing the next date preserves Stage and Closed reason; dates are UTC and clearing one clears its label.

Unmarking applied deletes only the current Pipeline pointer row. History remains in `pipeline_moves` but is absent from the API when the Job is outside Pipeline. Re-applying starts a new Applied Move and first-history pointer; earlier history remains retained and hidden. No purge or history-edit API is introduced.

Startup follows the existing transactional `init_db` migration pattern. Already-applied Primary Jobs without a Pipeline entry get one auto Applied Move, using migration time: the previous schema has no application timestamp. Existing entries, including closed ones, are not reset. Unmarked Jobs and Duplicates are not backfilled. Repeated startup adds nothing.

The API accepts manual or auto provenance for future system callers. This slice implements no Pipeline screen, mail integration, automatic movement or follow-up notifications.
