# Upwork OAuth for joule

Research date: 2026-10-07. Ticket: [Rhovian/joule#16](https://github.com/Rhovian/joule/issues/16).

Use Authorization Code with PKCE for owner consent; client credentials is enterprise-only. [Upwork GraphQL reference, Authentication](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication)
Recommend a registered `https://<server>.<tailnet>.ts.net/auth/upwork/callback`: Serve provides private HTTPS; Upwork acceptance remains unverified. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), [Upwork key registration](https://www.upwork.com/developer/keys/apply)
Plan for 24-hour access tokens and a two-week refresh inactivity window, subject to the documentation conflict below. [Upwork GraphQL reference](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication), [conflicting Help Center](https://support.upwork.com/hc/en-us/articles/115015933448-API-authentication-and-security)
Keep tokens in a persistent, owner-restricted data directory outside the checkout, never git; this is a proposed design, grounded in credential confidentiality requirements. [API/MCP terms §6.4](https://www.upwork.com/legal#upwork-api-mcp-terms-of-use)

## Findings

### Grants and token lifetime

The reference lists Authorization Code, Authorization Code with PKCE, Implicit, and enterprise-only Client Credentials. It documents `refresh_token` for renewal. Device and password grants are not listed; their support is unverified. [Upwork OAuth reference](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication)

The documented access TTL is 24 hours (`expires_in: 86400`); refresh TTL is two weeks since last use. The Help Center instead says access tokens never expire, using ambiguous “Request token” terminology. Prefer the GraphQL reference provisionally; verify actual responses and ask Upwork to reconcile these sources. [GraphQL reference](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication), [Help Center](https://support.upwork.com/hc/en-us/articles/115015933448-API-authentication-and-security)

Recommendation: persist the response’s expiry, refresh shortly before expiration when needed, and atomically save any replacement refresh token. If joule is idle/offline for over two weeks, offer owner sign-in again. Refreshing is distinct from fetching Jobs. This is an implementation recommendation based on the documented inactivity window and OAuth’s replacement-token rule. [Upwork reference](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication), [RFC 6749 §§5.1,6](https://www.rfc-editor.org/rfc/rfc6749#section-6)

### Redirect URI rules: verified versus unknown

Upwork requires `redirect_uri` in authorization and exchange requests, describing it as “equal or similar” to the configured callback; “similar” is undefined. [Upwork authorization parameters](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication)

| Question | Evidence and recommendation |
| --- | --- |
| Several registered URIs per personal key? | **Unverified.** Public reference describes a callback but establishes no count or delimiter. Check the authenticated key editor or obtain support confirmation; do not assume comma-separated URLs work. [Reference](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication), [registration UI](https://www.upwork.com/developer/keys/apply) |
| `http://localhost:8000/auth/upwork/callback` accepted? | **Unverified.** No first-party exception confirming this exact HTTP loopback callback was found. Save it in the key editor and complete an authorization/exchange to verify. [Reference](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication), [registration UI](https://www.upwork.com/developer/keys/apply) |
| HTTP versus HTTPS; private `*.ts.net` callback? | **Upwork acceptance unverified.** Prefer HTTPS and test the exact Serve URL. Serve’s HTTPS certificate and private reachability are documented, but that does not prove Upwork registration policy. [Upwork registration](https://www.upwork.com/developer/keys/apply), [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) |
| Scheme, host, port, path, trailing slash? | Recommendation: register and use one identical string everywhere. OAuth requires identical `redirect_uri` values between authorization and exchange; do not depend on undocumented matching latitude. [RFC 6749 §4.1.3](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3) |

### Owner sign-in from a private server

The authorization endpoint is `https://www.upwork.com/ab/account-security/oauth2/authorize`; the server exchanges the returned code at `https://www.upwork.com/api/v3/oauth2/token`, using `authorization_code`, client credentials, code, and callback. [Upwork reference](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication)

**Architecture inference:** the callback needs to be reachable by the owner’s browser, rather than by an inbound request from Upwork’s servers. OAuth sends the browser to the callback. Therefore private Serve should work without a public address, provided Upwork accepts the registered URI and the browser’s device has tailnet access. The server separately needs outbound internet access for token exchange/API requests. [OAuth browser redirect flow, RFC 6749 §4.1](https://www.rfc-editor.org/rfc/rfc6749#section-4.1), [Tailscale private browser access](https://tailscale.com/docs/use-cases/application-testing/share-local-dev-server-with-team)

Suggested deployment procedure—not executed:

1. Publish the container’s application port to host loopback, then run `tailscale serve --bg http://127.0.0.1:8000` on the Linux host. Use the HTTPS hostname printed by Serve, adding `/auth/upwork/callback`. Enable MagicDNS and HTTPS certificates if necessary. [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve), [Serve prerequisites](https://tailscale.com/docs/use-cases/application-testing/share-local-dev-server-with-team)
2. Register that callback and configure joule with its explicit external URL. Use the same value for both OAuth requests; avoid deriving it from the proxy’s internal HTTP address. [RFC 6749 §4.1.3](https://www.rfc-editor.org/rfc/rfc6749#section-4.1.3)
3. On the owner’s tailnet-connected laptop, open joule, start connection, and approve access on Upwork. The browser returns through Serve to joule; joule saves the tokens server-side. This is the recommended composition of OAuth’s browser flow and Serve’s reverse proxy. [RFC 6749 §4.1](https://www.rfc-editor.org/rfc/rfc6749#section-4.1), [Serve examples](https://tailscale.com/docs/reference/examples/serve)
4. Bind a short-lived connection attempt to that browser, use PKCE S256, and validate one-time `state`; reject unsolicited callbacks. No in-app login does not remove OAuth CSRF/code-injection concerns. Restrict access to the owner through tailnet access rules. [RFC 9700 §§2.1,4.7](https://www.rfc-editor.org/rfc/rfc9700#section-2.1), [Serve access controls](https://tailscale.com/docs/reference/examples/serve)

For local joule, localhost refers to the machine running the browser. **Inference:** a laptop browser’s localhost callback does not directly reach a remote server. If Upwork accepts only the planned callback, a temporary SSH local forward of laptop port 8000 to the server’s loopback port can preserve that URL; this is an untested fallback, still contingent on Upwork accepting HTTP localhost. Alternatively, use Serve for local joule too and update the registered callback when changing host, if the key editor permits it. Neither callback-changing behavior nor multiple-URI support was verified. [Browser redirect flow](https://www.rfc-editor.org/rfc/rfc6749#section-4.1), [Upwork key settings](https://www.upwork.com/developer/keys/apply)

### Token storage

**No existing storage implementation was identified:** `rg --files -g '!.niles/**' -g '!docs/research/**'` returned only README, agent/domain instructions, and glossary; no Python app or Docker configuration appeared. This is a bounded working-tree inspection, not a claim about other branches. [README.md:5](/Users/j/code/joule/README.md:5) locates planning in GitHub Issues. Consequently `/data` below is proposed, not an established joule path.

Recommend a persistent mount at `/data`, backed by an owner-controlled host directory outside the repo, with `/data/auth/upwork.json` containing access token, refresh token, token type, and expiry. Restrict the directory to the app/owner (`0700`) and token file (`0600`); write replacements atomically. Keep client secrets outside source control too. Never return tokens to browser JavaScript or record tokens/codes in logs, issue comments, container images, or git. Protect backups as secrets; filesystem permissions alone do not provide encryption at rest. These are design recommendations implementing confidentiality, not vendor-mandated file names. [API/MCP terms §§6.4,10.2](https://www.upwork.com/legal#upwork-api-mcp-terms-of-use), [official SDK saved-token example](https://raw.githubusercontent.com/upwork/python-upwork-oauth2/master/example/myapp.py)

The current API/MCP terms, v2.4 effective October 5, 2026, require keeping Credentials secret, annual rotation where within the developer’s control, and encryption of Upwork Content in transit and at rest. Plan encrypted storage/backups for Upwork data; do not infer that an ignored plaintext file satisfies all terms. [Legal Center, API/MCP §§6.4,10.2](https://www.upwork.com/legal#upwork-api-mcp-terms-of-use)

## Open risks and verification needed

- **Registration is the remaining feasibility gate:** with the owner’s approved personal key, inspect the authenticated editor for callback count, supported schemes, and hostname validation. Save the exact chosen URI and complete one consent/code-exchange round trip. Public browsing of the registration page exposed no form content; no account-specific verification was attempted. [Key registration](https://www.upwork.com/developer/keys/apply)
- **TTL contradiction and refresh rotation:** obtain Upwork clarification and inspect a real token response without logging secrets; verify whether refresh changes the refresh token and whether repeated renewal has an absolute lifetime cap. No account-specific token response was obtained. [GraphQL reference](https://www.upwork.com/developer/documentation/graphql/api/docs/index.html#authentication), [Help Center](https://support.upwork.com/hc/en-us/articles/115015933448-API-authentication-and-security)
- **Tailnet access replaces application access control only if restricted appropriately:** other permitted tailnet members can reach Serve. Limit joule to the owner before exposing connection controls or private data. [Serve access-control behavior](https://tailscale.com/docs/reference/examples/serve)
- **OAuth success does not settle approved use:** credentials must remain within the authorized registration and narrowest sufficient scopes. Existing access research records separate use/retention questions; they are outside this OAuth brief. [API/MCP §§6.2–6.4](https://www.upwork.com/legal#upwork-api-mcp-terms-of-use), [prior research](/Users/j/code/joule/docs/research/upwork-access.md:1)

No source files were edited, dependencies installed, checks run, credentials used, or issue comments posted. Only this requested worker report and its status handoff were written; scratch fetches were placed under `/tmp/joule-oauth.7lK4yt/`.
