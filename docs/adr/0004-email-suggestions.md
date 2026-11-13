# ADR-0004: Read-only mail and confirmed Pipeline suggestions

Accepted: 2026-11-12. Issue #140 extends ADR-0003's connection-only boundary.

Use the existing TLS IMAP session and structured AI transport. Account/folder cursors in SQLite track UIDVALIDITY, last UID and last successful check. A server task evaluates the stored interval every minute, including startup; null means after each Scan. Failed transport/classification keeps the cursor for retry; completed messages deduplicate before classification. Authentication failure reusing saved credentials marks expired; transport errors do not.

Only unique deterministic matches to current Pipeline Jobs are retained. Match sender domains against company names and stored Job/application hosts; shared ATS domains require the company name in subject/quote. Multiple matching Jobs are ambiguous and discarded. This deliberately favours missing suggestions over attaching mail to the wrong Job.

Fetch at most the first 16 KiB of each new message using BODY.PEEK, parse with stdlib email, and pass at most 4,000 body characters to one structured classifier. Bodies/attachments and unmatched messages are never persisted or logged. Retain sender name/address, subject, first non-quoted body line (140 chars), date, Message-ID, folder/UID, matched Job/current application, proposal and resolution. Missing Message-ID uses a folder/UIDVALIDITY/UID identity. The UI escapes all mail text.

Confirm alone appends a manual Move naming the sender and subject, in the same transaction resolving the suggestion. A stale application/Move returns 409 rather than overwriting later operator work. Exclude preserves the account/Message-ID/Job record and suppresses redelivery, including after UIDVALIDITY changes. Ignore keeps metadata but removes the pending suggestion. Reconnection does not delete history/exclusions; another account cannot see them. Stage suggestions only move on; date/rejection suggestions retain the current Stage. No email is sent, marked Seen, deleted or otherwise changed.
