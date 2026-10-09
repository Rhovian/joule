import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from joule.config import data_dir as default_data_dir
from joule.db import init_db
from joule.scan import Scanner
from joule.scan import router as scan_router
from joule.upwork_auth import UpworkAuth, UpworkNotConnected, router


def create_app(data_dir: Path | None = None) -> FastAPI:
    directory = data_dir if data_dir is not None else default_data_dir()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "drafts").mkdir(exist_ok=True)
        (directory / "profile" / "samples").mkdir(parents=True, exist_ok=True)
        init_db(directory / "joule.db")
        async with httpx.AsyncClient(
            timeout=30, headers={"User-Agent": "joule/0.1"}
        ) as client:
            app.state.upwork_auth = UpworkAuth(directory, client)
            app.state.scanner = Scanner(directory, client, app.state.upwork_auth)
            try:
                yield
            finally:
                if app.state.scanner.task is not None:
                    app.state.scanner.task.cancel()
                    with suppress(asyncio.CancelledError):
                        await app.state.scanner.task

    app = FastAPI(lifespan=lifespan)

    async def upwork_not_connected(request, error):
        return JSONResponse(status_code=503, content={"detail": str(error)})

    app.add_exception_handler(UpworkNotConnected, upwork_not_connected)
    app.state.data_dir = directory
    app.include_router(router)
    app.include_router(scan_router)
    return app


app = create_app()
