import asyncio
import json
import logging
import os
import re
import signal
from contextlib import suppress
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import BaseModel, ValidationError

from joule.config import Model

TIMEOUT = 300
logger = logging.getLogger(__name__)


class AIError(Exception):
    def __init__(self, message, *, causes=None):
        super().__init__(message)
        self.causes = tuple(sorted(set(causes or [message])))


async def codex_stderr(process, prompt):
    # communicate() buffers all output: docs.python.org/3.12/library/asyncio-subprocess.html
    with suppress(BrokenPipeError, ConnectionResetError):
        process.stdin.write(prompt.encode())
        process.stdin.close()
    tail = b""
    while chunk := await process.stderr.read(4096):
        tail = (tail + chunk)[-8192:]
    await process.wait()
    # Codex 0.160.1 prints prompts and ERROR: lines to stderr, with no safe filter:
    # github.com/openai/codex/blob/rust-v0.160.1/codex-rs/exec/src/event_processor_with_human_output.rs
    prompt_lines = [
        " ".join(line.split()) for line in prompt.splitlines() if line.strip()
    ]
    errors = []
    for line in tail.decode(errors="replace").splitlines():
        line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line)
        line = " ".join(line.split())
        if not re.match(r"(?i)^error:\s*", line) or line in " ".join(prompt.split()):
            continue
        for private in sorted(prompt_lines, key=len, reverse=True):
            line = line.replace(private, "[prompt redacted]")
        # Discard credential-bearing suffixes, including quoted/multiword values.
        line = re.sub(
            r"(?i)\b(authorization|bearer|[\w-]*(?:token|secret|password|api[_-]?key))\b.*"
            r"|\bsk-[\w-]+|\beyJ[\w.-]+|https?://\S+",
            "[redacted]",
            line,
        )
        errors.append(line)
    return " | ".join(dict.fromkeys(errors))


def strict_schema(value):
    if isinstance(value, dict):
        value = {k: strict_schema(v) for k, v in value.items()}
        if "properties" in value:
            value["additionalProperties"] = False
            value["required"] = list(value["properties"])
    elif isinstance(value, list):
        value = [strict_schema(v) for v in value]
    return value


async def structured[T: BaseModel](model: Model, prompt: str, schema: type[T]) -> T:
    with TemporaryDirectory(prefix="joule-ai-") as directory:
        path = Path(directory)
        (path / "schema.json").write_text(
            json.dumps(strict_schema(schema.model_json_schema()))
        )
        args = [
            "codex",
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--ignore-user-config",
            "-s",
            "read-only",
        ]
        # Scoring needs no tools; Job text is untrusted, so the shell goes too.
        for feature in (
            "shell_tool",
            "unified_exec",
            "browser_use",
            "computer_use",
            "image_generation",
            "in_app_browser",
        ):
            args += ["--disable", feature]
        args += [
            "--output-schema",
            str(path / "schema.json"),
            "-o",
            str(path / "out.txt"),
        ]
        if model.model:
            args += ["-m", model.model]
        try:
            process = await asyncio.create_subprocess_exec(
                *args,
                "-",
                cwd=directory,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
        except OSError as error:
            raise AIError("Could not start Codex") from error
        try:
            diagnostic = await asyncio.wait_for(codex_stderr(process, prompt), TIMEOUT)
        except (TimeoutError, asyncio.CancelledError) as error:
            # Codex runs a native child under its node wrapper; kill the whole group.
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise AIError("Codex timed out") from None
        if process.returncode:
            logger.warning(
                "Codex exited with status %s: %s",
                process.returncode,
                diagnostic or "no error line retained",
            )
            detail = (
                f": {diagnostic[:237]}{'...' if len(diagnostic) > 237 else ''}"
                if diagnostic
                else ""
            )
            raise AIError(f"Codex exited with status {process.returncode}{detail}")
        try:
            return schema.model_validate_json((path / "out.txt").read_text())
        except (OSError, UnicodeError, ValidationError) as error:
            raise AIError("Codex returned missing or invalid output") from error


async def retry_structured(model, prompt, schema, *, generate=None):
    failures, causes = [], []
    for attempt in range(2):
        try:
            return await (generate or structured)(model, prompt, schema)
        except AIError as error:
            logger.warning("Codex attempt %s/2 failed: %s", attempt + 1, error)
            failures.append(f"Attempt {attempt + 1}/2: {error}")
            causes.extend(error.causes)
    raise AIError("; ".join(failures), causes=causes)
