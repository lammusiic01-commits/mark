# Скачать AI Маркетолог (Этап 1 — Фундамент)

**Файл:** [`ai-marketer-v1.0.0.zip`](ai-marketer-v1.0.0.zip) — 57 103 байта, 39 записей (весь проект: скрипты запуска одной кнопкой, ядро, миграции, Docker, workflow релиза).

**Контрольная сумма (SHA-256):** см. [`ai-marketer-v1.0.0.zip.sha256`](ai-marketer-v1.0.0.zip.sha256)

```
f1f89c668b65b7b4f97804f311634ad13c5bc6080ba24710890370a05df8ba23
```

## Как скачать

- из интерфейса GitHub: откройте `ai-marketer-v1.0.0.zip` → кнопка **Download raw file**;
- прямой ссылкой: `https://github.com/lammusiic01-commits/mark/raw/arena/841f905d-mark/download/ai-marketer-v1.0.0.zip`
- из консоли:

```bash
curl -L -o ai-marketer-v1.0.0.zip https://github.com/lammusiic01-commits/mark/raw/arena/841f905d-mark/download/ai-marketer-v1.0.0.zip
shasum -a 256 ai-marketer-v1.0.0.zip     # должно совпасть с суммой выше
```

## Что делать дальше

1. Распаковать архив в папку без кириллицы в пути.
2. **Windows:** двойной клик по `start.bat`. **Linux/macOS:** `chmod +x start.sh && ./start.sh`.
3. Первый запуск создаст `secrets.env` и откроет его — заполните `BOT_TOKEN`, `OPENROUTER_API_KEY`, `WEBAPP_URL`, сохраните и запустите снова.
4. Скрипт сам сгенерирует `ENCRYPTION_KEY`, соберёт контейнеры, поднимет PostgreSQL и Redis, применит миграции и запустит API.

Проверка окружения без запуска: `start.bat --check` / `./start.sh --check`

---

# Скачать MARK 1.0.0

**Файл:** [`mark-1.0.0.zip`](mark-1.0.0.zip) — 574 507 байт, 201 файл (исходный код целиком: сервер, Telegram-бот, Mini App, докер, документация).

**Контрольная сумма (SHA-256):** см. [`mark-1.0.0.zip.sha256`](mark-1.0.0.zip.sha256)

```
c3dd5ac96ca5d8cedcfb01fcf5759a8dfd4d383bab8c97844e63ba040e98b45a
```

## Как скачать

- из интерфейса GitHub: откройте `mark-1.0.0.zip` → кнопка **Download raw file**;
- или прямой ссылкой: `https://github.com/lammusiic01-commits/mark/raw/arena/841f905d-mark/download/mark-1.0.0.zip`
- или из консоли:

```bash
curl -L -o mark-1.0.0.zip https://github.com/lammusiic01-commits/mark/raw/arena/841f905d-mark/download/mark-1.0.0.zip
shasum -a 256 mark-1.0.0.zip     # должно совпасть с суммой выше
```

## Что делать дальше

**Быстрый старт (нужен Node.js 20.10+)**

```bash
unzip mark-1.0.0.zip && cd mark-1.0.0
npm install
npm run build
npm start                # интерфейс: http://localhost:8787
```

**На сервере (Docker)**

```bash
unzip mark-1.0.0.zip && cd mark-1.0.0
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build      # интерфейс: http://IP-сервера:8787
```

**Окна входа в сервисы (Яндекс.Директ, Метрика, GSC, Tilda, WordPress, Cloudflare …)**

```bash
npm run desktop:install && npm run desktop:start
```

Полная инструкция — `docs/RUNBOOK.md` внутри архива: подключение сервисов, автонастройка SEO/GEO
на сайте клиента, правила автооптимизации по cron, BotShield, отчёты клиентам, автозапуск службой,
резервные копии, nginx + HTTPS, разбор типичных ошибок.

## Обновить архив

Архив собирается из исходников командой:

```bash
npm run zip            # dist/mark-<версия>-<дата>.zip
```

Если положите новый архив в эту папку, обновите имя файла и контрольную сумму.
