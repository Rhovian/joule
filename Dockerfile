FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy JOULE_DATA_DIR=/data PATH=/app/.venv/bin:$PATH
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY joule/ joule/
RUN uv sync --frozen --no-dev
COPY --from=web /web/dist web/dist
EXPOSE 8000
CMD ["uvicorn", "joule.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
