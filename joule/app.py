from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI

from joule.config import data_dir as default_data_dir
from joule.db import init_db
from joule.upwork_auth import UpworkAuth, router


def create_app(data_dir: Path | None = None) -> FastAPI:
    directory = data_dir if data_dir is not None else default_data_dir()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "drafts").mkdir(exist_ok=True)
        (directory / "profile" / "samples").mkdir(parents=True, exist_ok=True)
        init_db(directory / "joule.db")
        async with httpx.AsyncClient(timeout=30) as client:
            app.state.upwork_auth = UpworkAuth(directory, client)
            yield

    app = FastAPI(lifespan=lifespan)
    app.state.data_dir = directory
    app.include_router(router)
    return app


app = create_app()
