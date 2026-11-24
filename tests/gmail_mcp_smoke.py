"""Run in the pinned Gmail Docker stage; Google calls are mocked, MCP is real."""

import asyncio
import importlib.util
import os
import json
import shutil
import sqlite3
import sys
from contextlib import ExitStack, contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, Mock, patch

from auth.credential_store import LocalDirectoryCredentialStore
from google.oauth2.credentials import Credentials
import gmail.gmail_tools as gmail
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

# Exercise script-directory shadowing as well as production's Python -I flag.
launcher = Path(
    os.environ.get(
        "JOULE_LAUNCHER",
        Path(__file__).resolve().parents[1] / "joule" / "gmail_server.py",
    )
)
sys.path.insert(0, str(launcher.parent))
spec = importlib.util.spec_from_file_location("adapter", launcher)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


@contextmanager
def google():
    credential = Credentials(
        "fake",
        refresh_token="fake",
        token_uri="https://oauth2.googleapis.com/token",
        client_id="fake",
        client_secret="fake",
        scopes=[adapter.SCOPE],
    )
    search = AsyncMock()
    search.side_effect = lambda **kwargs: json.dumps(
        dict(kwargs, call=search.await_count)
    )
    response = Mock()
    response.json.return_value = {"scope": adapter.SCOPE}
    profile = Mock()
    profile.users.return_value.getProfile.return_value.execute.return_value = {
        "emailAddress": "owner@example.com"
    }
    with ExitStack() as stack:
        for target in [
            patch.dict(
                os.environ,
                {
                    "JOULE_GMAIL_ACCOUNT": "owner@example.com",
                    "JOULE_GMAIL_DIR": "/tmp/gmail",
                },
            ),
            patch.object(
                LocalDirectoryCredentialStore, "get_credential", return_value=credential
            ),
            patch.object(
                LocalDirectoryCredentialStore, "store_credential", return_value=True
            ),
            patch.object(Credentials, "refresh"),
            patch("requests.get", return_value=response),
            patch("googleapiclient.discovery.build", return_value=profile),
            patch.object(
                gmail,
                "search_gmail_messages",
                new=search,
            ),
        ]:
            stack.enter_context(target)
        yield response


async def protocol():
    with TemporaryDirectory() as directory, open(os.devnull, "w") as err:
        root = Path(directory)
        shutil.copyfile(launcher, root / "gmail_server.py")
        for name in ("auth", "core", "gmail", "main"):
            (root / f"{name}.py").write_text(
                "raise AssertionError('Joule module shadowed upstream')"
            )
        with sqlite3.connect(root / "jobs.db") as db:
            db.executescript(
                "CREATE TABLE jobs(id INTEGER PRIMARY KEY,title,company,state,primary_id);CREATE TABLE pipeline(job_id,move_id);CREATE TABLE pipeline_moves(id,stage,closed_reason);"
            )
            db.executemany(
                "INSERT INTO jobs VALUES (?,?,'Acme','new',NULL)",
                [(i, "Special" if i == 25 else "Engineer") for i in range(1, 26)],
            )
            db.executescript(
                "UPDATE jobs SET state='applied' WHERE id=1; INSERT INTO pipeline VALUES(1,1); INSERT INTO pipeline_moves VALUES(1,'applied','no_reply');"
            )
        params = StdioServerParameters(
            command=sys.executable,
            args=["-I", str(Path(__file__).resolve()), "--serve"],
            env=dict(
                os.environ,
                JOULE_LAUNCHER=str(root / "gmail_server.py"),
                JOULE_DB=str(root / "jobs.db"),
                JOULE_GMAIL_QUERY="after:123 before:456",
                JOULE_GMAIL_PAGE_TOKEN="fixed-page",
            ),
        )
        async with stdio_client(params, errlog=err) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                names = {tool.name for tool in (await session.list_tools()).tools}
                assert set(adapter.TOOLS) <= names
                assert not names.intersection(
                    {
                        "send_gmail_message",
                        "draft_gmail_message",
                        "delete_gmail_message",
                        "modify_gmail_message",
                    }
                )
                listing = await session.list_tools()
                search = next(
                    tool
                    for tool in listing.tools
                    if tool.name == "search_gmail_messages"
                )
                assert not search.input_schema.get("properties")
                result = await session.call_tool("search_gmail_messages", {})
                query = json.loads(result.content[0].text)
                assert (
                    query["query"] == "after:123 before:456"
                    and query["page_size"] == 10
                    and query["page_token"] == "fixed-page"
                )
                repeated = await session.call_tool("search_gmail_messages", {})
                assert (
                    repeated.content[0].text == result.content[0].text
                    and query["call"] == 1
                )
                result = await session.call_tool("lookup_jobs", {"company": "Acme"})
                data = result.structured_content or json.loads(result.content[0].text)
                assert data["more"] and len(data["jobs"]) == 20
                assert data["jobs"][0]["closed_reason"] == "no_reply"
                result = await session.call_tool(
                    "lookup_jobs", {"company": "Acme", "title": "Special"}
                )
                data = result.structured_content or json.loads(result.content[0].text)
                assert not data["more"] and data["jobs"][0]["id"] == 25
    print(
        "PASS: isolated stdio; fixed cached Gmail page, bounded read-only Job lookup, closed/non-Applied candidates, shadow modules ignored"
    )


def restrictions():
    import main as upstream

    with google() as response, patch.object(upstream, "main") as serve:
        adapter.main()
        serve.assert_called_once()
        assert sys.argv == [
            "workspace-mcp",
            "--tools",
            "gmail",
            "--read-only",
            "--single-user",
            "--transport",
            "stdio",
        ]
        from auth import scopes

        scopes.set_read_only(True)
        assert set(scopes.get_scopes_for_tools(["gmail"])) == {adapter.SCOPE}
        import gmail.gmail_tools as gmail

        try:
            asyncio.run(gmail._export_full_message())
        except ValueError as error:
            assert str(error) == "Message export is disabled"
        else:
            raise AssertionError("Export permitted")
        response.json.return_value = {"scope": adapter.SCOPE + " openid"}
        try:
            adapter.main()
        except ValueError as error:
            assert "Revoke" in str(error)
        else:
            raise AssertionError("Overbroad token permitted")
    print(
        "PASS: pinned server imports, Gmail-only scopes, exported-body refusal, actual-token scope rejection"
    )


if __name__ == "__main__":
    if "--serve" in sys.argv:
        with google():
            adapter.main()
    else:
        asyncio.run(protocol())
        restrictions()
