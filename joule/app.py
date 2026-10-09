from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from joule.config import data_dir as default_data_dir
from joule.db import init_db


def create_app(data_dir: Path | None = None) -> FastAPI:
    directory = data_dir if data_dir is not None else default_data_dir()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "drafts").mkdir(exist_ok=True)
        (directory / "profile" / "samples").mkdir(parents=True, exist_ok=True)
        init_db(directory / "joule.db")
        yield

    app = FastAPI(lifespan=lifespan)
    app.state.data_dir = directory
    return app


app = create_app()
