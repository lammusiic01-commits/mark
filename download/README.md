# Скачать MARK 1.0.0

**Файл:** [`mark-1.0.0.zip`](mark-1.0.0.zip) — 415 КБ, 148 файлов (исходный код целиком).

**Контрольная сумма (SHA-256):** см. [`mark-1.0.0.zip.sha256`](mark-1.0.0.zip.sha256)

```
ff2ce4bbd57fbe3f61a6301981dd0246050969d5331de227ca33e783bb5f39bb
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
