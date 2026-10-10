import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from joule.config import data_dir as default_data_dir
from joule.config import load_env
from joule.db import init_db
from joule.jobs import router as jobs_router
from joule.scan import Scanner
from joule.scan import router as scan_router
from joule.upwork_auth import UpworkAuth, UpworkNotConnected, router


def create_app(data_dir: Path | None = None) -> FastAPI:
    directory = data_dir if data_dir is not None else default_data_dir()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db(directory / "joule.db")
        async with httpx.AsyncClient(
            timeout=30, headers={"User-Agent": "joule/0.1"}
        ) as client:
            app.state.upwork_auth = UpworkAuth(directory, client)
            app.state.scanner = Scanner(directory, client, app.state.upwork_auth)
            schedule_task = asyncio.create_task(app.state.scanner.run_schedule())
            try:
                yield
            finally:
                schedule_task.cancel()
                with suppress(asyncio.CancelledError):
                    await schedule_task
                if app.state.scanner.task is not None:
                    app.state.scanner.task.cancel()
                    with suppress(asyncio.CancelledError):
                        await app.state.scanner.task

    app = FastAPI(lifespan=lifespan)
    allowed_hosts = ["localhost", "127.0.0.1"]
    hostname = urlsplit(load_env(directory).get("UPWORK_REDIRECT_URI", "")).hostname
    if hostname:
        allowed_hosts.append(hostname)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)

    @app.middleware("http")
    async def framing_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = "frame-ancestors 'none'"
        return response

    async def upwork_not_connected(request, error):
        return JSONResponse(status_code=503, content={"detail": str(error)})

    app.add_exception_handler(UpworkNotConnected, upwork_not_connected)
    app.state.data_dir = directory
    app.include_router(router)
    app.include_router(scan_router)
    app.include_router(jobs_router)
    app.mount(
        "/",
        StaticFiles(
            directory=Path(__file__).parent.parent / "web" / "dist",
            html=True,
            check_dir=False,
        ),
    )
    return app


app = create_app()
