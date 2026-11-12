"""One-off Drafts: no Job, Draft row, queue entry or output file is stored."""

import json
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import Field, StringConstraints

from joule import ai, cv, drafts
from joule.config import StrictModel, load_settings
from joule.sources import Candidate

router = APIRouter(prefix="/api/manual")
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ProposalRequest(StrictModel):
    title: Text = Field(default="Pasted Upwork Job", max_length=500)
    company: str | None = Field(default=None, max_length=500)
    description: Text = Field(max_length=50000)
    questions: list[Annotated[Text, Field(max_length=5000)]] = Field(max_length=50)


def job(title, description, source, questions=(), company=None):
    candidate = Candidate(
        source=source,
        source_id="manual",
        link="",
        title=title,
        company=company,
        description=description,
        extra={"screening_questions": list(questions)},
    ).model_dump()
    return candidate | {"extra": json.dumps(candidate["extra"]), "score_reason": None}


@router.post("/proposal")
async def proposal(request: Request, body: ProposalRequest):
    directory = request.app.state.data_dir
    try:
        return await drafts.generate(
            job(body.title, body.description, "upwork", body.questions, body.company),
            "proposal",
            None,
            load_settings(directory),
            directory,
        )
    except ai.AIError as error:
        raise HTTPException(502, str(error)) from error


class PostingRequest(StrictModel):
    company: str | None = Field(default=None, max_length=500)
    title: Text = Field(max_length=500)
    description: Text = Field(max_length=50000)


@router.post("/cover-letter")
async def cover_letter(request: Request, body: PostingRequest):
    directory = request.app.state.data_dir
    try:
        return await drafts.generate(
            job(body.title, body.description, "manual", company=body.company),
            "cover_letter",
            None,
            load_settings(directory),
            directory,
        )
    except ai.AIError as error:
        raise HTTPException(502, str(error)) from error


@router.post("/cv")
async def tailored_cv(request: Request, body: PostingRequest):
    directory = request.app.state.data_dir
    settings = load_settings(directory)
    try:
        document = await drafts.generate(
            job(body.title, body.description, "manual", company=body.company),
            "tailored_cv",
            None,
            settings,
            directory,
        )
    except ai.AIError as error:
        raise HTTPException(502, str(error)) from error
    return Response(
        cv.render(document),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{cv.filename(settings.files.cv_prefix, body.title)}"'
        },
    )
