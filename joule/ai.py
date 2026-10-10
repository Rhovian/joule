import asyncio
import json
import os
import signal
from contextlib import suppress
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import BaseModel, ValidationError

from joule.config import Model

TIMEOUT = 300


class AIError(Exception):
    pass


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
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as error:
            raise AIError("Could not start Codex") from error
        try:
            await asyncio.wait_for(process.communicate(prompt.encode()), TIMEOUT)
        except (TimeoutError, asyncio.CancelledError) as error:
            # Codex runs a native child under its node wrapper; kill the whole group.
            with suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
            if isinstance(error, asyncio.CancelledError):
                raise
            raise AIError("Codex timed out") from None
        if process.returncode:
            raise AIError(f"Codex exited with status {process.returncode}")
        try:
            return schema.model_validate_json((path / "out.txt").read_text())
        except (OSError, UnicodeError, ValidationError) as error:
            raise AIError("Codex returned missing or invalid output") from error


async def retry_structured(model, prompt, schema):
    for attempt in range(2):
        try:
            return await structured(model, prompt, schema)
        except AIError:
            if attempt:
                raise
