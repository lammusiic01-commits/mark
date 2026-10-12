# ═══════════════════════════════════════════════════════════════
#   AI Маркетолог — сборка и раздача Mini App
#   Этап 1: собираем Vue-приложение (Vite)
#   Этап 2: отдаём готовые файлы через nginx и проксируем /api на сервер
# ═══════════════════════════════════════════════════════════════

FROM node:22-alpine AS build
WORKDIR /app

# Сначала манифесты — так слой с зависимостями кэшируется между сборками
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build


FROM nginx:1.27-alpine
LABEL org.opencontainers.image.title="AI Маркетолог — приложение"

# Конфиг nginx: статика + проксирование API внутри docker-сети
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Собранное приложение
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
