import asyncio
import logging
from contextlib import asynccontextmanager, closing, suppress
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from joule import scoring_session
from joule.answers import router as answers_router
from joule.config import data_dir as default_data_dir
from joule.config import load_env, load_settings
from joule.db import connect, init_db
from joule.email_connection import EmailConnection
from joule.email_connection import router as email_router
from joule.email_suggestions import EmailSuggestions
from joule.email_suggestions import router as suggestions_router
from joule.fill import router as fill_router
from joule.jobs import router as jobs_router
from joule.manual import router as manual_router
from joule.pipeline import evaluate
from joule.pipeline import router as pipeline_router
from joule.profile import router as profile_router
from joule.scan import Scanner
from joule.scan import router as scan_router
from joule.settings import router as settings_router
from joule.telegram import Telegram
from joule.traces import router as traces_router
from joule.upwork_auth import UpworkAuth, UpworkNotConnected, router


def create_app(data_dir: Path | None = None) -> FastAPI:
    directory = data_dir if data_dir is not None else default_data_dir()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db(directory / "joule.db")
        try:
            with closing(connect(directory / "joule.db")) as db, db:
                evaluate(db, load_settings(directory))
        except Exception:
            logging.getLogger(__name__).exception(
                "Pipeline evaluation failed at startup"
            )
        async with httpx.AsyncClient(
            timeout=30, headers={"User-Agent": "joule/0.1"}
        ) as client:
            app.state.upwork_auth = UpworkAuth(directory, client)
            env = load_env(directory)
            token, chat_id = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
            telegram = None
            if token and chat_id:
                auth = app.state.upwork_auth
                telegram = Telegram(directory, client, token, chat_id, auth)
            app.state.telegram = telegram
            app.state.scanner = Scanner(
                directory,
                client,
                app.state.upwork_auth,
                telegram,
                app.state.email_suggestions,
            )
            telegram_task = asyncio.create_task(telegram.run()) if telegram else None
            email_task = asyncio.create_task(app.state.email_suggestions.run())
            schedule_task = asyncio.create_task(app.state.scanner.run_schedule())
            try:
                yield
            finally:
                if telegram_task:
                    telegram_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await telegram_task
                email_task.cancel()
                with suppress(asyncio.CancelledError):
                    await email_task
                schedule_task.cancel()
                with suppress(asyncio.CancelledError):
                    await schedule_task
                if app.state.scanner.task is not None:
                    app.state.scanner.task.cancel()
                    with suppress(asyncio.CancelledError):
                        await app.state.scanner.task
                await scoring_session.session.close()

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
    app.state.email = EmailConnection(directory)
    app.include_router(router)
    app.include_router(scan_router)
    app.include_router(jobs_router)
    app.include_router(manual_router)
    app.include_router(fill_router)
    app.include_router(traces_router)
    app.include_router(settings_router)
    app.state.email_suggestions = EmailSuggestions(directory, app.state.email)
    app.include_router(email_router)
    app.include_router(suggestions_router)
    app.include_router(answers_router)
    app.include_router(profile_router)
    app.include_router(pipeline_router)
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
