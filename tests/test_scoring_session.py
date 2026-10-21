import asyncio
import json
from functools import partial

import pytest

from joule import ai
from joule.config import Model
from joule.score import Score
from joule.scoring_session import ScoringSession


@pytest.fixture
def session(tmp_path, monkeypatch):
    executable = tmp_path / "codex"
    executable.write_text("""#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
assert sys.argv[1:4] == ['app-server', '--listen', 'stdio://']
for feature in ['shell_tool', 'unified_exec', 'browser_use', 'computer_use',
                'image_generation', 'in_app_browser', 'multi_agent']:
    assert feature in sys.argv
assert 'web_search="disabled"' in sys.argv
home = Path(os.environ['CODEX_HOME'])
assert (home / 'auth.json').is_symlink() and not (home / 'config.toml').exists()
thread = str(os.getpid())
def emit(value):
    print(json.dumps(value), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    with open(os.environ['TRANSCRIPT'], 'a') as log:
        log.write(json.dumps(message) + '\\n')
    method, params = message['method'], message.get('params', {})
    if method == 'initialize':
        emit({'id': message['id'], 'result': {}})
    if method == 'thread/start':
        assert params['sandbox'] == 'read-only' and params['approvalPolicy'] == 'never'
        assert params['ephemeral'] and 'private CV' in params['developerInstructions']
        emit({'id': message['id'], 'result': {'thread': {'id': thread}}})
    if method == 'turn/start':
        schema = params['outputSchema']
        assert schema['additionalProperties'] is False
        assert set(schema['required']) == set(schema['properties'])
        text = params['input'][0]['text']
        assert 'private CV' not in text
        if text == 'eof': sys.exit(1)
        emit({'id': message['id'], 'result': {'turn': {'id': str(message['id'])}}})
        if text == 'timeout': time.sleep(30)
        if text == 'tool':
            emit({'id': 900, 'method': 'item/tool/call', 'params': {}})
            continue
        common = {'threadId': thread, 'turnId': str(message['id'])}
        output = '{}' if text == 'bad' else json.dumps({'score': int(text) if text.isdigit() else 50, 'reason': 'fit', 'points': []})
        emit({'method': 'item/completed', 'params': {**common, 'item': {'type': 'agentMessage', 'text': output}}})
        emit({'method': 'thread/tokenUsage/updated', 'params': {**common, 'tokenUsage': {'last': {'totalTokens': 2000, 'inputTokens': 1800, 'cachedInputTokens': 1024}, 'modelContextWindow': 100000}}})
        emit({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': str(message['id']), 'status': 'failed' if text == '429' else 'completed', 'error': {'codexErrorInfo': {'httpConnectionFailed': {'httpStatusCode': 429}}}}}})
""")
    executable.chmod(0o755)
    monkeypatch.setenv("PATH", str(tmp_path))
    # The shebang needs Python, independent of the host PATH.
    import sys

    executable.write_text(
        executable.read_text().replace("/usr/bin/env python3", sys.executable)
    )
    monkeypatch.setenv("TRANSCRIPT", str(tmp_path / "transcript"))
    return ScoringSession(), tmp_path / "transcript"


@pytest.mark.parametrize(
    "rotate", [None, "jobs", "tokens", "born", "model", "context", "dead"]
)
def test_reuse_serialization_and_rotation(session, rotate, caplog):
    scorer, transcript = session
    caplog.set_level("INFO")

    async def run():
        model = Model(provider="codex")
        call = partial(scorer.structured, "private CV", model)
        try:
            results = await asyncio.gather(call("10", Score), call("90", Score))
            assert [result.score for result in results] == [10, 90]
            thread = scorer.thread
            if rotate in {"jobs", "tokens", "born"}:
                setattr(
                    scorer,
                    rotate,
                    {"jobs": 100, "tokens": 64000, "born": scorer.born - 3601}[rotate],
                )
            if rotate == "model":
                model.model = "changed"
            if rotate == "context":
                call = partial(scorer.structured, "private CV changed", model)
            if rotate == "dead":
                scorer.process.kill()
                await scorer.process.wait()
            await call("70", Score)
            assert (scorer.thread != thread) == bool(rotate)
        finally:
            await scorer.close()

    asyncio.run(run())
    messages = [json.loads(line) for line in transcript.read_text().splitlines()]
    assert sum(m["method"] == "thread/start" for m in messages) == (2 if rotate else 1)
    assert "cached=1024" in caplog.text and "private CV" not in caplog.text


@pytest.mark.parametrize("failure", ["429", "bad", "eof", "tool", "timeout"])
def test_failure_retry_and_recovery(session, monkeypatch, failure):
    scorer, transcript = session
    monkeypatch.setattr(ai, "TIMEOUT", 0.5)

    async def run():
        call = partial(scorer.structured, "private CV")
        model = Model(provider="codex")
        try:
            with pytest.raises(ai.AIError, match="Attempt 2/2") as error:
                await ai.retry_structured(model, failure, Score, generate=call)
            if failure == "429":
                assert "HTTP 429" in str(error.value)
            assert (await call(model, "60", Score)).score == 60
        finally:
            await scorer.close()

    asyncio.run(run())
    starts = sum(
        json.loads(line)["method"] == "thread/start"
        for line in transcript.read_text().splitlines()
    )
    assert starts == (1 if failure in {"429", "bad"} else 3)
