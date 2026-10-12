# ═══════════════════════════════════════════════════════════════
#   AI Маркетолог — образ бэкенда (API + бот + движок)
#   Секреты в образ не попадают: они передаются в контейнер
#   через env_file в docker-compose.yml (файл secrets.env).
# ═══════════════════════════════════════════════════════════════

# ─── Этап 1: сборка зависимостей в отдельном окружении ─────────
FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

# Компиляторы нужны только для сборки колес (asyncpg, cryptography, Pillow)
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential libffi-dev libjpeg-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --upgrade pip setuptools wheel \
    && pip install -r /tmp/requirements.txt \
    && python -c "import aiogram, fastapi, sqlalchemy, asyncpg, cryptography, qrcode, structlog; print('зависимости установлены')"


# ─── Этап 2: рабочий образ ─────────────────────────────────────
FROM python:3.12-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app \
    PATH="/opt/venv/bin:$PATH" \
    API_PORT=8000

# curl нужен для healthcheck, tini — чтобы контейнер корректно гасил процессы
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system marketer \
    && useradd --system --gid marketer --home-dir /app --shell /usr/sbin/nologin marketer

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app

# Код проекта (секреты исключены через .dockerignore)
COPY --chown=marketer:marketer . /app

USER marketer

EXPOSE 8000

# Живость проверяем через собственный /health: он смотрит и БД, и Redis
HEALTHCHECK --interval=30s --timeout=8s --start-period=45s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${API_PORT}/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "uvicorn api.server:app --host 0.0.0.0 --port ${API_PORT} --proxy-headers --forwarded-allow-ips='*'"]
