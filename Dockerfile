# MARK — образ для запуска на сервере.
#
# Сборка и запуск:
#   docker compose up -d --build        (см. docker-compose.yml)
#   docker build -t mark:1.0.0 .
#   docker run -d -p 8787:8787 -v mark-data:/data --name mark mark:1.0.0
#
# Данные (база, отчёты, ключ шифрования) живут в томе /data — переживают обновление образа.

# ------------------------------- Сборка -------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Сначала манифесты — слой с зависимостями кэшируется отдельно от исходников
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY README.md ./

# Собираем сервер (esbuild → apps/server/dist/server.mjs) и фронтенд (vite → apps/web/dist)
RUN npm run build

# ------------------------------ Запуск ------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MARK_HOST=0.0.0.0 \
    MARK_PORT=8787 \
    MARK_DATA_DIR=/data

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force

# Только собранные артефакты: сервер и статика интерфейса
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

# Каталог данных (в него монтируется том)
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MARK_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --serve-web: тот же процесс отдаёт и API, и интерфейс
CMD ["node", "apps/server/dist/server.mjs", "--serve-web"]
