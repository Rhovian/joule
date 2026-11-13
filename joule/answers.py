"""The shared answer bank: Settings edits, Fill saves and Telegram additions."""

from threading import Lock

import yaml
from fastapi import APIRouter, HTTPException, Request
from pydantic import Field

from joule.config import StrictModel
from joule.files import atomic_write

router = APIRouter(prefix="/api/answers")
# PyYAML serializes YAML; it does not coordinate read/modify/write across app threads.
# https://github.com/yaml/pyyaml/blob/6.0.3/lib/yaml/__init__.py#L215-L254
lock = Lock()
LIMIT = 200 * 1024


def normalize(text):
    return " ".join(text.lower().replace("*", "").replace("✱", "").split())


class AnswerInput(StrictModel):
    question: str = Field(min_length=1, max_length=500)
    answer: str = Field(min_length=1, max_length=5000)


def read(directory):
    path = directory / "profile" / "answers.yaml"
    try:
        entries = yaml.safe_load(path.read_text())
    except FileNotFoundError:
        return []
    except (OSError, UnicodeError, yaml.YAMLError) as error:
        raise HTTPException(
            409, "Cannot read answers.yaml; repair the file before saving."
        ) from error
    if entries is None:
        return []
    if not isinstance(entries, list) or any(
        not isinstance(e, dict)
        or not isinstance(e.get("question"), str)
        or not isinstance(e.get("answer"), str)
        for e in entries
    ):
        raise HTTPException(
            409, "answers.yaml must contain a list of question/answer pairs."
        )
    return entries


def update(directory, change):
    path = directory / "profile" / "answers.yaml"
    with lock:
        if path.exists() and path.stat().st_size > LIMIT:
            raise HTTPException(413, "Answer bank exceeds 200 KB")
        entries = read(directory)
        change(entries)
        text = yaml.safe_dump(entries, allow_unicode=True, sort_keys=False, width=1e9)
        if len(text.encode("utf-8")) > LIMIT:
            raise HTTPException(413, "Answer bank exceeds 200 KB")
        # #132 ruling: only explicit Settings edits re-serialize the owner's formatting.
        atomic_write(path, text)


def append(directory, entries, *, from_fill=False):
    if not entries:
        return
    path = directory / "profile" / "answers.yaml"
    added = [
        {**entry, **({"saved_from_fill": True} if from_fill else {})}
        for entry in entries
    ]
    text = yaml.safe_dump(added, allow_unicode=True, sort_keys=False, width=1e9)
    with lock:
        size = path.stat().st_size if path.exists() else 0
        if size > LIMIT:
            raise HTTPException(413, "Answer bank exceeds 200 KB")
        before = read(directory)
        original = path.read_text() if path.exists() else ""
        addition = ("\n" if original and not original.endswith("\n") else "") + text
        if size + len(addition.encode("utf-8")) > LIMIT:
            raise HTTPException(413, "Answer bank exceeds 200 KB")
        # PyYAML does not extend a flow sequence or a closed document by appending a block.
        # Validate before writing, rather than corrupting or reformatting hand-maintained YAML.
        try:
            valid = yaml.safe_load(original + addition) == before + added
        except yaml.YAMLError:
            valid = False
        if not valid:
            raise HTTPException(
                409,
                "Cannot append to this YAML layout. Use a block list in answers.yaml; an empty bank may be a blank file.",
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(mode=0o600, exist_ok=True)
        with path.open("a", encoding="utf-8") as bank:
            bank.write(addition)


@router.get("")
def list_answers(request: Request):
    entries = read(request.app.state.data_dir)
    latest = {normalize(e["question"]): i for i, e in enumerate(entries)}
    return [
        {
            "id": i,
            "question": e["question"],
            "answer": e["answer"],
            "saved_from_fill": e.get("saved_from_fill") is True,
        }
        for i, e in enumerate(entries)
        if latest[normalize(e["question"])] == i
    ]


@router.post("")
def add_answer(request: Request, body: AnswerInput):
    append(request.app.state.data_dir, [body.model_dump()])
    return list_answers(request)


@router.put("/{index}")
def edit_answer(request: Request, index: int, body: AnswerInput):
    def edit(entries):
        if not 0 <= index < len(entries):
            raise HTTPException(404, "Answer not found")
        question = normalize(entries[index]["question"])
        if normalize(body.question) != question:
            raise HTTPException(409, "Answer bank changed; refresh before editing.")
        # A Fill may have appended this question since the editor opened: edit its effective answer.
        entry = next(
            e for e in reversed(entries) if normalize(e["question"]) == question
        )
        entry["answer"] = body.answer

    update(request.app.state.data_dir, edit)
    return list_answers(request)
