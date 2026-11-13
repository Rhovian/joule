import json
import re
from pathlib import Path
from typing import Annotated, Literal

import typst
import yaml
from fastapi import HTTPException
from pydantic import Field, create_model

from joule.config import StrictModel


def load(data_dir):
    path = data_dir / "profile" / "cv.yaml"
    return yaml.safe_load(path.read_text()) if path.is_file() else None


def prepare(data_dir, *, document=None):
    cv = load(data_dir) if document is None else document
    if not isinstance(cv, dict) or not any(
        entry.get("id") for key in ("work", "projects") for entry in cv.get(key, [])
    ):
        raise HTTPException(400, "Master CV not found")
    fields = {}
    for key, name, value, limit in (
        ("work", "bullets", list[Annotated[str, Field(max_length=500)]], 10),
        ("projects", "text", str, 1200),
    ):
        ids = tuple(entry["id"] for entry in cv.get(key, []) if entry.get("id"))
        entry = create_model(
            key,
            __base__=StrictModel,
            id=(Literal[ids] if ids else str, ...),
            **{name: (value, Field(max_length=limit))},
        )
        fields[key] = (list[entry], Field(max_length=None if ids else 0))
    schema = create_model(
        "TailoredCV",
        __base__=StrictModel,
        headline=(str, Field(max_length=200)),
        summary=(str, Field(max_length=1500)),
        **fields,
    )
    return cv, schema


def resolve(cv, result):
    document = {
        key: cv.get(key, [])
        for key in ("skills", "education", "awards", "certificates")
    }
    document |= {
        "basics": cv.get("basics", {}) | {"label": result.headline},
        "summary": result.summary,
    }
    for key, fields in (
        ("work", ("name", "position", "startDate", "endDate", "summary")),
        ("projects", ("type", "name", "entity", "roles", "url", "relevance")),
    ):
        sources = {entry["id"]: entry for entry in cv.get(key, []) if entry.get("id")}
        selected = {}
        for item in getattr(result, key):
            if item.id in selected:
                continue
            source = sources[item.id]
            entry = {field: source[field] for field in fields if field in source}
            entry |= (
                # Entries without highlights are Earlier Experience, shown as written.
                {"bullets": item.bullets if "highlights" in source else []}
                if key == "work"
                else {"text": item.text}
            )
            selected[item.id] = entry
        document[key] = list(selected.values())
    # Newest first, whatever order the model picked; no endDate means current.
    document["work"].sort(
        key=lambda w: (str(w.get("endDate", "9999")), str(w.get("startDate", ""))),
        reverse=True,
    )
    return document


def master_document(document):
    if not isinstance(document, dict):
        raise TypeError("Master CV must be a YAML mapping.")
    basics = document.get("basics", {})
    if not isinstance(basics, dict):
        raise TypeError("basics must be a mapping.")
    arrays = ("work", "projects", "skills", "education", "awards", "certificates")
    for key in arrays:
        if not isinstance(document.get(key, []), list) or any(
            not isinstance(e, dict) for e in document.get(key, [])
        ):
            raise ValueError(f"{key} must be a list of mappings.")

    def highlights(entry):
        values = entry.get("highlights", entry.get("bullets", []))
        if not isinstance(values, list) or any(
            not isinstance(v, str)
            and not (isinstance(v, dict) and isinstance(v.get("text"), str))
            for v in values
        ):
            raise ValueError(
                "highlights must contain text strings or mappings with text."
            )
        return [v if isinstance(v, str) else v["text"] for v in values]

    result = {key: document.get(key, []) for key in arrays}
    result |= {"basics": basics, "summary": document.get("summary", "")}
    result["work"] = [e | {"bullets": highlights(e)} for e in result["work"]]
    result["projects"] = [
        e
        | {
            "text": "\n".join(
                filter(
                    None,
                    [
                        e.get("text", e.get("description", e.get("summary", ""))),
                        *highlights(e),
                    ],
                )
            )
        }
        for e in result["projects"]
    ]
    return result


def render(document, name="cv.typ"):
    template = Path(__file__).with_name(name)
    return typst.compile(
        str(template),
        root=str(template.parent),
        ignore_system_fonts=True,
        sys_inputs={"document": json.dumps(document, default=str)},
    )


def render_letter(text, data_dir):
    cv = load(data_dir)
    return render(
        {
            "basics": cv.get("basics", {}) if isinstance(cv, dict) else {},
            "text": text,
        },
        "letter.typ",
    )


def filename(prefix, company):
    parts = (
        re.sub(r"[^A-Za-z0-9]+", "_", part or "").strip("_")
        for part in (prefix, company)
    )
    return "_".join(part for part in parts if part) + ".pdf"
