"""Master CV display/replacement and rescoring through the existing queue."""

from contextlib import closing
from datetime import UTC, datetime
from threading import Lock

import yaml
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import Field

from joule import cv, score
from joule.config import StrictModel, load_settings
from joule.db import connect
from joule.files import atomic_write
from joule.scan import ScanInProgress

router = APIRouter(prefix="/api/profile")
lock = Lock()
LIMIT = 2 * 1024 * 1024


def stale_jobs(directory):
    stamp = score.fingerprint(directory, load_settings(directory))
    with closing(connect(directory / "joule.db")) as db:
        return db.execute(
            "SELECT id,source FROM jobs WHERE primary_id IS NULL AND content_purged_at IS NULL "
            "AND score IS NOT NULL AND score_fingerprint IS NOT ? ORDER BY id",
            (stamp,),
        ).fetchall()


@router.get("")
def profile(request: Request):
    directory = request.app.state.data_dir
    path = directory / "profile" / "cv.yaml"
    fields, error = [], None
    try:
        document = cv.load(directory)
        if path.is_file():
            cv.master_document(document)
            basics = document.get("basics", {})
            # Public allowlist: contact, location, links, pay, notes and unknown fields stay private.
            for key, value in basics.items():
                present = (
                    value is not None and value != "" and value != [] and value != {}
                )
                public = key in {
                    "name",
                    "firstName",
                    "lastName",
                    "label",
                } and isinstance(value, str)
                fields.append(
                    {
                        "label": str(key),
                        "value": value
                        if public
                        else "set · hidden"
                        if present
                        else "not set",
                    }
                )
            for key, value in document.items():
                if key == "basics":
                    continue
                fields.append(
                    {
                        "label": str(key),
                        "value": f"{len(value)} {'entry' if len(value) == 1 else 'entries'}"
                        if key
                        in {
                            "work",
                            "projects",
                            "skills",
                            "education",
                            "awards",
                            "certificates",
                        }
                        and isinstance(value, list)
                        else "set · hidden"
                        if value is not None and value != ""
                        else "not set",
                    }
                )
        for name in ("preferences.yaml", "portfolio.yaml", "answers.yaml"):
            if (directory / "profile" / name).is_file():
                fields.append(
                    {"label": name.removesuffix(".yaml"), "value": "set · hidden"}
                )
    except (OSError, ValueError, TypeError, yaml.YAMLError):
        error = "Cannot read the Master CV. Replace it with a valid cv.yaml."
    return {
        "exists": path.is_file(),
        "updated_at": datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat()
        if path.is_file()
        else None,
        "fields": fields,
        "error": error,
        "stale": len(stale_jobs(directory)),
        "busy": request.app.state.scanner.busy,
    }


def master_pdf(text, *, require_ids=False):
    try:
        document = yaml.safe_load(text)
        rendered = cv.master_document(document)
        if require_ids:
            cv.prepare(None, document=document)
        return cv.render(rendered)
    except yaml.YAMLError as error:
        raise HTTPException(
            422, f"Invalid YAML: {getattr(error, 'problem', 'parse error')}"
        ) from error
    except HTTPException as error:
        raise HTTPException(422, error.detail) from error
    except (
        ValueError,
        TypeError,
        KeyError,
        AttributeError,
        cv.typst.TypstError,
    ) as error:
        raise HTTPException(422, str(error).split("\n", 1)[0]) from error


@router.get("/cv.pdf")
def open_cv(request: Request):
    path = request.app.state.data_dir / "profile" / "cv.yaml"
    if not path.is_file():
        raise HTTPException(404, "Master CV not found")
    return Response(
        master_pdf(path.read_text()),
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'inline; filename="Master_CV.pdf"',
            "Cache-Control": "no-store",
        },
    )


class Replacement(StrictModel):
    content: str = Field(min_length=1, max_length=LIMIT)


@router.put("/cv")
def replace_cv(request: Request, body: Replacement):
    if len(body.content.encode("utf-8")) > LIMIT:
        raise HTTPException(413, "CV exceeds 2 MB")
    master_pdf(body.content, require_ids=True)
    path = request.app.state.data_dir / "profile" / "cv.yaml"
    with lock:
        backed_up = path.is_file()
        if backed_up:
            atomic_write(path.with_suffix(".yaml.bak"), path.read_bytes())
        atomic_write(path, body.content.encode("utf-8"))
    return profile(request) | {"backed_up": backed_up}


@router.post("/rescore", status_code=202)
async def rescore(request: Request, body: StrictModel):
    directory = request.app.state.data_dir
    rows = stale_jobs(directory)
    if not rows:
        return {"id": None, "queued": 0}
    try:
        scan_id = request.app.state.scanner.start(
            list(dict.fromkeys(row["source"] for row in rows)),
            "manual",
            load_settings(directory),
            None,
            job_ids=[row["id"] for row in rows],
        )
    except ScanInProgress:
        raise HTTPException(409, "Scan or scoring in progress") from None
    return {"id": scan_id, "queued": len(rows)}
