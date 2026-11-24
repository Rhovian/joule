"""Pinned Workspace MCP adapter and one-time, Gmail-only OAuth setup."""

import logging
import os
import sqlite3
import sys
from pathlib import Path
from contextlib import closing
from urllib.parse import quote

SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
TOOLS = ["search_gmail_messages", "get_gmail_message_content", "lookup_jobs"]


def credential_path(root, account):
    # Pinned 43b662a auth/credential_store.py::_get_credential_path. Keep the
    # lightweight status reader aligned; the launcher asserts upstream agrees.
    return root / "credentials" / (quote(account, safe="@._-") + ".json")


def lookup_jobs(company: str, title: str = "") -> dict:
    """Find at most 20 Jobs, including closed/non-Applied. more means ambiguous."""
    if not company.strip():
        raise ValueError("Supply a company from the application email")
    # Workspace MCP has no access to Joule's Jobs. sqlite3's read-only URI,
    # bound parameters and LIMIT supply this lookup without a second index:
    # https://docs.python.org/3.12/library/sqlite3.html#how-to-work-with-sqlite-uris
    uri = Path(os.environ["JOULE_DB"]).resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.create_function("casefold", 1, str.casefold)
        rows = db.execute(
            "SELECT j.id,substr(j.title,1,500) AS title,substr(j.company,1,500) AS company,j.state,m.stage,m.closed_reason "
            "FROM jobs j LEFT JOIN pipeline p ON p.job_id=j.id LEFT JOIN pipeline_moves m ON m.id=p.move_id "
            "WHERE j.primary_id IS NULL AND instr(casefold(coalesce(j.company,'')),?)>0 "
            "AND instr(casefold(j.title),?)>0 ORDER BY j.id LIMIT 21",
            (company.strip().casefold(), title.strip().casefold()),
        ).fetchall()
    return {"jobs": [dict(row) for row in rows[:20]], "more": len(rows) > 20}


def main():
    # Direct script execution would otherwise put /app/joule ahead of upstream's
    # auth/core/gmail/main packages. Also use Python -I at the invocation sites.
    package_dir = Path(__file__).resolve().parent
    sys.path[:] = [
        item for item in sys.path if item and Path(item).resolve() != package_dir
    ]
    os.umask(0o077)
    root = Path(os.environ.get("JOULE_GMAIL_DIR", "/data/gmail"))
    os.environ["WORKSPACE_MCP_CREDENTIALS_DIR"] = str(root / "credentials")
    # Upstream 43b662a auth/scopes.py adds OIDC by default. Single-user Gmail
    # needs no identity API: enforce the issue's exact grant, including reauth.
    from auth import scopes

    scopes.BASE_SCOPES.clear()
    scopes.SCOPES[:] = [SCOPE]
    from auth.credential_store import LocalDirectoryCredentialStore
    from google.auth.transport.requests import Request
    import requests

    store = LocalDirectoryCredentialStore()
    email = os.environ["JOULE_GMAIL_ACCOUNT"]
    if Path(store._get_credential_path(email)) != credential_path(root, email):
        raise ValueError("Unsupported Workspace MCP credential filename")
    if len(sys.argv) > 1 and sys.argv[1] == "authorize":
        from google_auth_oauthlib.flow import InstalledAppFlow

        flow = InstalledAppFlow.from_client_secrets_file(root / "client.json", [SCOPE])
        credentials = flow.run_local_server(
            host="localhost",
            bind_addr="0.0.0.0",
            port=8090,
            open_browser=False,
            access_type="offline",
            prompt="consent",
            include_granted_scopes="false",
        )
    else:
        # Never initiate interactive OAuth inside an unattended agent run.
        credentials = store.get_credential(email)
        if credentials is None or set(credentials.scopes or []) != {SCOPE}:
            raise ValueError("Authorize Gmail with only gmail.readonly")
        credentials.refresh(Request())
    response = requests.get(
        "https://oauth2.googleapis.com/tokeninfo",
        params={"access_token": credentials.token},
        timeout=30,
    )
    response.raise_for_status()
    if set(response.json().get("scope", "").split()) != {SCOPE}:
        raise ValueError("Revoke the old grant and authorize only gmail.readonly")
    from googleapiclient.discovery import build

    profile = (
        build("gmail", "v1", credentials=credentials)
        .users()
        .getProfile(userId="me")
        .execute()
    )
    if (
        profile["emailAddress"].casefold() != email.casefold()
        or not credentials.refresh_token
    ):
        raise ValueError("Wrong Gmail account or missing offline grant")
    if not store.store_credential(email, credentials):
        raise ValueError("Could not save Gmail credential")
    if len(sys.argv) > 1 and sys.argv[1] == "authorize":
        print("Gmail authorized with only gmail.readonly")
        return
    # Upstream gmail/gmail_tools.py get_gmail_message_content(full=True) exports
    # to disk even in read-only mode. Block that path, not just its UI affordance.
    import gmail.gmail_tools as gmail

    async def no_export(*args, **kwargs):
        raise ValueError("Message export is disabled")

    gmail._export_full_message = no_export
    logging.disable(logging.CRITICAL)
    from core.server import server
    from main import main as serve

    # main.py applies Gmail service/read-only filters before starting stdio;
    # add Joule's read-only lookup after those filters, for both stdio runners.
    run_stdio = server.run_stdio_async

    page = None

    async def search_page() -> str:
        """Read this run's fixed ten-message Gmail page; repeated calls reuse it."""
        nonlocal page
        # Pinned gmail/gmail_tools.py search_gmail_messages supports paging but
        # executes a new query each call. Freeze/cache one page here so the model
        # cannot widen the window, increase its size or chase more search pages.
        if page is None:
            page = await gmail.search_gmail_messages(
                query=os.environ["JOULE_GMAIL_QUERY"],
                user_google_email=email,
                page_size=10,
                page_token=os.environ.get("JOULE_GMAIL_PAGE_TOKEN") or None,
                include_headers=True,
            )
        return page

    async def with_jobs(*args, **kwargs):
        server.tool(name="search_gmail_messages")(search_page)
        server.tool(name="lookup_jobs")(lookup_jobs)
        return await run_stdio(*args, **kwargs)

    server.run_stdio_async = with_jobs

    sys.argv = [
        "workspace-mcp",
        "--tools",
        "gmail",
        "--read-only",
        "--single-user",
        "--transport",
        "stdio",
    ]
    serve()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # OAuth/provider errors may contain credentials or mail. Keep stderr private.
        print(
            "Gmail unavailable; run the documented authorization setup", file=sys.stderr
        )
        sys.exit(1)
