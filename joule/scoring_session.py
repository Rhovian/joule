"""One serialized, ephemeral scoring thread; Drafts and Fill use ai.structured."""

import asyncio
import json
import logging
import os
import signal
from contextlib import suppress
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic

from pydantic import ValidationError

from joule import ai

logger = logging.getLogger(__name__)


class TurnFailed(ai.AIError):
    pass


class ScoringSession:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.process = None
        self.directory = None
        self.identity = None
        self.sequence = 0
        self.jobs = self.tokens = 0
        self.limit = 64000

    async def close(self):
        if self.process is not None:
            with suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGKILL)
            await self.process.wait()
            self.process = None
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None
        self.identity = None

    async def send(self, message):
        self.process.stdin.write(json.dumps(message).encode() + b"\n")
        await self.process.stdin.drain()

    async def receive(self):
        line = await self.process.stdout.readline()
        if not line:
            raise ai.AIError("Codex scoring connection closed")
        message = json.loads(line)
        # No tools are needed. Fail closed if a future version requests one.
        if "method" in message and "id" in message:
            raise ai.AIError("Codex scoring requested an unexpected tool")
        return message

    async def rpc(self, method, params):
        # Codex 0.160.1 JSONL RPC requires client IDs, initialize, then turns:
        # github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server-protocol/schema/json/ClientRequest.json
        self.sequence += 1
        await self.send({"id": self.sequence, "method": method, "params": params})
        while True:
            message = await self.receive()
            if message.get("id") == self.sequence:
                if "error" in message:
                    raise ai.AIError("Codex scoring RPC rejected " + method)
                return message["result"]

    async def start(self, context, model):
        await self.close()
        self.directory = TemporaryDirectory(prefix="joule-score-")
        path = Path(self.directory.name)
        # app-server has no exec's --ignore-user-config (0.160.1 cli/src/main.rs).
        # Isolate user config and MCP; share only the login file.
        home = Path(os.environ.get("CODEX_HOME", "~/.codex")).expanduser()
        (path / "auth.json").symlink_to(home / "auth.json")
        args = ["codex", "app-server", "--listen", "stdio://"]
        for feature in (
            "shell_tool",
            "unified_exec",
            "browser_use",
            "computer_use",
            "image_generation",
            "in_app_browser",
            "multi_agent",
        ):
            args += ["--disable", feature]
        args += ["-c", 'web_search="disabled"']
        self.process = await asyncio.create_subprocess_exec(
            *args,
            cwd=path,
            env={**os.environ, "CODEX_HOME": str(path)},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
            limit=4 * 1024 * 1024,
        )
        await self.rpc(
            "initialize", {"clientInfo": {"name": "joule", "version": "0.1"}}
        )
        await self.send({"method": "initialized"})
        result = await self.rpc(
            "thread/start",
            {
                "model": model.model,
                "cwd": str(path),
                "ephemeral": True,
                "sandbox": "read-only",
                "approvalPolicy": "never",
                "baseInstructions": "Score Jobs using the supplied Profile and rubric. Use no tools.",
                "developerInstructions": context,
            },
        )
        self.thread = result["thread"]["id"]
        self.identity = (context, model.model)
        self.born = monotonic()
        self.jobs = self.tokens = 0
        self.limit = 64000
        logger.info("Codex scoring session started thread=%s", self.thread)

    async def turn(self, context, model, prompt, schema):
        # Thread history grows across turns; Codex auto-compaction is lossy, not a
        # periodic fresh Profile. Rotate conservatively using reported context; see
        # app-server-protocol/schema/json/v2/ThreadTokenUsageUpdatedNotification.json
        # in github.com/openai/codex/tree/rust-v0.160.1/codex-rs.
        if (
            self.identity != (context, model.model)
            or self.process.returncode is not None
            or self.jobs >= 100
            or self.tokens >= self.limit
            or monotonic() - self.born >= 3600
        ):
            await self.start(context, model)
        result = await self.rpc(
            "turn/start",
            {
                "threadId": self.thread,
                "input": [{"type": "text", "text": prompt, "text_elements": []}],
                "outputSchema": ai.strict_schema(schema.model_json_schema()),
            },
        )
        turn_id = result["turn"]["id"]
        self.jobs += 1
        output = ""
        while True:
            message = await self.receive()
            params = message.get("params", {})
            if params.get("threadId") != self.thread:
                continue
            method = message.get("method")
            if method == "thread/tokenUsage/updated":
                usage = params["tokenUsage"]
                last = usage["last"]
                self.tokens = last["totalTokens"]
                self.limit = min(
                    64000, int((usage.get("modelContextWindow") or 85000) * 0.75)
                )
                logger.info(
                    "Codex scoring thread=%s input=%s cached=%s",
                    self.thread,
                    last["inputTokens"],
                    last["cachedInputTokens"],
                )
            if params.get("turnId") == turn_id and method == "item/completed":
                item = params["item"]
                if item["type"] == "agentMessage":
                    output = item["text"]
            if method == "turn/completed" and params["turn"]["id"] == turn_id:
                if params["turn"]["status"] != "completed":
                    # Typed HTTP status only; never provider error text. See pinned
                    # app-server-protocol/schema/json/v2/TurnCompletedNotification.json.
                    info = (params["turn"].get("error") or {}).get("codexErrorInfo")
                    status = None
                    if isinstance(info, dict):
                        for value in info.values():
                            if isinstance(value, dict):
                                status = value.get("httpStatusCode")
                    detail = f" (HTTP {status})" if type(status) is int else ""
                    raise TurnFailed("Codex scoring turn failed" + detail)
                return schema.model_validate_json(output)

    async def structured(self, context, model, prompt, schema):
        # app-server steers concurrent turn/start into the active turn; serialize
        # Scan and manual rescore here: Codex rust-v0.160.1,
        # codex-rs/app-server-protocol/src/protocol/v2/turn.rs TurnStartParams.
        async with self.lock:
            try:
                return await asyncio.wait_for(
                    self.turn(context, model, prompt, schema), ai.TIMEOUT
                )
            except TurnFailed:
                raise
            except ValidationError as error:
                raise ai.AIError("Codex returned missing or invalid output") from error
            except asyncio.CancelledError:
                await self.close()
                raise
            except (OSError, ValueError, KeyError, TimeoutError, ai.AIError) as error:
                await self.close()
                raise ai.AIError("Codex scoring session failed") from error


session = ScoringSession()
