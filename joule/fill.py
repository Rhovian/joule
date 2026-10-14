"""Read-only identity matching for the Extension; page descriptors are data."""

import re
from contextlib import closing
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field

from joule import cv
from joule.config import StrictModel
from joule.db import connect
from joule.jobs import primary

router = APIRouter(prefix="/api/fill")
Text = Annotated[str, Field(max_length=2000)]
Index = Annotated[int, Field(strict=True, ge=0)]


class Option(StrictModel):
    value: str = Field(max_length=200)
    label: str = Field(max_length=200)


class Descriptor(StrictModel):
    ref: tuple[Index, Index]
    tag: Text = "input"
    type: Text = "text"
    role: Text = ""
    name: Text = ""
    id: Text = ""
    autocomplete: Text = ""
    label: Text = ""
    required: bool = False
    options: list[Option] = Field(default_factory=list, max_length=100)
    accept: Text = ""
    maxlength: Annotated[int, Field(strict=True, ge=0)] | None = None


class MatchRequest(StrictModel):
    fields: list[Descriptor] = Field(max_length=200)


AUTOCOMPLETE = {
    "given-name": "first_name",
    "family-name": "last_name",
    "name": "full_name",
    "email": "email",
    "tel": "phone",
    "url": "url",
}
HINTS = {
    "first_name": "first_name",
    "last_name": "last_name",
    "email": "email",
    "phone": "phone",
    "name": "full_name",
    "org": "current_company",
    "urls[linkedin]": "linkedin",
    "urls[github]": "github",
    "urls[portfolio]": "url",
    # Ashby API-doc names, not verified against live DOM; see ADR-0001 §1.
    "_systemfield_name": "full_name",
    "_systemfield_email": "email",
}
LABELS = (
    (r"^(first|given) name\b", "first_name"),
    (r"^((last|family) name|surname)\b", "last_name"),
    (r"^(full name|your name)\b|^name$", "full_name"),
    (r"\be-?mail\b", "email"),
    (r"\b(phone|mobile)\b", "phone"),
    (r"\blinkedin\b", "linkedin"),
    (r"\bgithub\b", "github"),
    (r"\b(portfolio|website|personal site)\b", "url"),
    (r"\bcurrent (company|employer)\b", "current_company"),
)
SENSITIVE = re.compile(
    r"\b(eeo|demograph\w*|disab\w*|veteran\w*|pronouns?|criminal|"
    r"consent|attest\w*|privacy|race|ethnic\w*|gender|sex|sexual|"
    r"agree|agreement|certify|certification)\b"
)


def normalize(text):
    # Pydantic 2.14 validates strings, not ATS semantics:
    # https://github.com/pydantic/pydantic/blob/v2.14.0/pydantic/types.py
    return " ".join(text.lower().replace("*", "").replace("✱", "").split())


def sensitive(text):
    return bool(SENSITIVE.search(normalize(text)))


def identity(document):
    basics = document.get("basics", {})
    name = basics.get("name", "").strip()
    parts = name.split()
    values = {key: basics.get(key) for key in ("email", "phone", "url")}
    values |= {
        "full_name": name,
        "first_name": parts[0] if parts else None,
        "last_name": " ".join(parts[1:]) or None,
        "current_company": next(
            (w.get("name") for w in document.get("work", []) if not w.get("endDate")),
            None,
        ),
    }
    values |= {
        normalize(p.get("network", "")): p.get("url")
        for p in basics.get("profiles", [])
        if normalize(p.get("network", "")) in ("linkedin", "github")
    }
    return values


def classify(field, values):
    def leave(reason):
        return {"action": "leave", "reason": reason}

    if field.type == "hidden":
        return leave("hidden")
    if field.role == "combobox":
        return leave("combobox")
    # Invariant 6 also guards identity-like labels on sensitive questions.
    if sensitive(field.label):
        return leave("sensitive")
    if field.type == "file":
        text = normalize(f"{field.label} {field.id} {field.name}")
        if re.search(r"\b(resume|cv)\b", text):
            return {"action": "upload", "file": "resume"}
        if "cover" in text:
            return {"action": "upload", "file": "cover_letter"}
        return leave("unrecognized file input")
    key = next(
        (AUTOCOMPLETE[t] for t in field.autocomplete.split() if t in AUTOCOMPLETE),
        None,
    )
    if key is None:
        key = {"email": "email", "tel": "phone"}.get(field.type)
    if key is None:
        key = HINTS.get(field.id.lower()) or HINTS.get(field.name.lower())
    if key is None:
        label = normalize(field.label)
        key = next((key for pattern, key in LABELS if re.search(pattern, label)), None)
    if key is None:
        return {"action": "ask"}
    value = values.get(key)
    if not value:
        return leave("missing in cv.yaml")
    return {"action": "set", "value": value}


@router.post("/jobs/{job_id}/match")
def match(request: Request, job_id: int, body: MatchRequest):
    directory = request.app.state.data_dir
    with closing(connect(directory / "joule.db")) as db:
        job = primary(db, job_id)
        if job["source"] == "upwork":
            raise HTTPException(400, "Fill is not available for Upwork Jobs")
        draft_ids = {
            row["kind"]: row["id"]
            for row in db.execute(
                "SELECT kind, MAX(id) AS id FROM drafts WHERE job_id=? GROUP BY kind",
                (job_id,),
            )
        }
    values = identity(cv.load(directory) or {})
    return {
        "job": {key: job[key] for key in ("id", "title", "company", "source")},
        "actions": [
            {"ref": field.ref} | classify(field, values) for field in body.fields
        ],
        "resume_draft_id": draft_ids.get("tailored_cv"),
        "cover_letter_draft_id": draft_ids.get("cover_letter"),
    }
