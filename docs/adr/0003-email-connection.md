# ADR-0003: IMAP connection (superseded)

Accepted: 2026-11-12 for #139. Superseded: 2026-11-15 by #167 and [ADR-0004](0004-email-suggestions.md).

The initial connection used TLS IMAP, app passwords and private email.json. These were removed in favour of the operator's Google Cloud OAuth client and a Gmail-only, read-only MCP server. Existing email.json is deleted on startup; it is never used to authorize Gmail. Setup and the minimal connection-status API are described in ADR-0004 and README.
