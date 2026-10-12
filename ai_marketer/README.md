# 🤖 AI Маркетолог — Premium Telegram Mini App

**Управление рекламой в Яндекс.Директе прямо из Telegram.** Бот присылает отчёты, приложение считает гипотезы, находит слив бюджета на ботов и предлагает конкретные действия — с расчётом в рублях, а не «попробуйте увеличить ставку».

```
Telegram-бот  →  кнопка «Открыть приложение»  →  Mini App (Vue 3)
        │                                              │
        │                                     FastAPI API + X-Telegram-Init-Data
        │                                              │
   прокси Bot API  ←──────────────  Python-движок: боты, ставки, гипотезы, SEO/GEO
                                                   │
                                        PostgreSQL + Redis + OpenRouter (ИИ-текст)
```

---

## ⚡ Быстрый старт (одна кнопка)

### Windows
1. Скачайте ZIP со страницы **Releases** и распакуйте в любую папку (без кириллицы в пути).
2. Двойной клик по **`start.bat`**.
3. Первый запуск создаст `secrets.env`, откроет Блокнот — заполните 3 обязательных значения и запустите `start.bat` снова.
4. Через 3–5 минут откроется окно с адресами:
   - WebApp: `http://localhost:3000`
   - API и документация: `http://localhost:8000/docs`
   - Проверка живости: `http://localhost:8000/health`

### Linux / macOS
```bash
unzip ai-marketer-v1.0.0.zip -d ai-marketer && cd ai-marketer
chmod +x start.sh
./start.sh
```
Первый запуск создаёт `secrets.env`, открывает редактор и завершается. Заполните файл и запустите `./start.sh` снова.

> Что делает `start.bat` / `start.sh` за вас: проверяет Docker, создаёт `secrets.env` из шаблона, **сам генерирует `ENCRYPTION_KEY`**, собирает образы, поднимает PostgreSQL и Redis, применяет миграции через Alembic и запускает API, бота и WebApp. Ручные команды не нужны ни на одном шаге.

### Остальные кнопки
| Команда | Что делает |
|---|---|
| `start.bat` / `./start.sh` | запуск всего проекта |
| `start.bat --check` / `./start.sh --check` | проверка окружения без запуска |
| `stop.bat` / `./stop.sh` | остановка (данные сохраняются) |
| `stop.bat --purge` / `./stop.sh --purge` | остановка + удаление базы и Redis |
| `logs.bat` / `./logs.sh` | живые логи всех сервисов (`logs.bat bot` — только бот) |
| `update.bat` / `./update.sh` | `git pull` → пересборка → миграции → перезапуск |

---

## 🔑 Файл секретов

**Единственное место, где живут ключи, — `secrets.env` в корне проекта.** Он создаётся автоматически из `secrets.env.example` и уже добавлен в `.gitignore`: в репозиторий уходит только шаблон, без значений.

| Переменная | Обязательна | Где взять |
|---|---|---|
| `BOT_TOKEN` | да | @BotFather → `/newbot` |
| `WEBAPP_URL` | да | HTTPS-адрес приложения (на проде — ваш домен, локально — туннель) |
| `TELEGRAM_PROXY_URL` | да | прокси Bot API для работы из РФ (уже заполнен) |
| `OPENROUTER_API_KEY` | да | https://openrouter.ai/keys (есть бесплатные модели) |
| `AI_MODEL` | нет | модель для текстовых советов, по умолчанию бесплатная Llama 3.3 70B |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | да | значения для локального Docker уже готовы |
| `REDIS_HOST`, `REDIS_PORT` | да | значения для локального Docker уже готовы |
| `ENCRYPTION_KEY` | да | **генерируется автоматически** при первом запуске |
| `SBP_MERCHANT_ID`, `SBP_ACCOUNT`, `SBP_SECRET_KEY` | нет | банк/касса для приёма платежей по СБП |
| `API_PORT`, `WEBAPP_PORT` | нет | порты, по умолчанию 8000 и 3000 |

**Про `ENCRYPTION_KEY`.** Им шифруются токены Яндекс.Директа и Метрики перед записью в базу (Fernet: AES-128-CBC + HMAC-SHA256). Токены пользователей никогда не хранятся в открытом виде. Сохраните копию ключа в надёжном месте: если он потеряется, подключения придётся создавать заново.

**Про безопасность.** Ключи не попадают ни в код, ни в docker-образ, ни в логи: контейнеры получают их через `env_file`, а логгер вырезает значения с именами `token`, `secret`, `password`, `key`.

---

## 📦 Что в проекте

```
ai_marketer/
├── start.bat / start.sh      запуск одной кнопкой
├── stop.bat  / stop.sh       остановка
├── logs.bat  / logs.sh       логи
├── update.bat/ update.sh     обновление
├── secrets.env.example       шаблон секретов (значения — только локально)
├── docker-compose.yml        postgres, redis, migrate, api, bot, webapp
├── Dockerfile                образ бэкенда (Python 3.12-slim)
├── requirements.txt          зависимости с фиксированными версиями
├── core/                     ядро: конфиг, БД, модели, шифрование, логи
├── bot/                      Telegram-бот (aiogram 3) — этап 2
├── engine/                   расчёты: боты, ставки, гипотезы, SEO/GEO — этап 3
├── services/                 Яндекс.Директ, Метрика, хостинг — этап 4
├── ai/                       OpenRouter-клиент и текстовый советник — этап 5
├── payments/                 СБП: QR и баланс — этап 6
├── api/                      FastAPI: сервер, авторизация, роуты — этап 7
├── webapp/                   Vue 3 Mini App — этап 8
├── migrations/               Alembic: миграции схемы БД
├── tests/                    pytest
└── .github/workflows/        сборка релиза по тегу v*
```

### Что уже работает на этом этапе (Фундамент)
- ✅ запуск и остановка одной кнопкой, проверка Docker, автосоздание `secrets.env`, автогенерация ключа шифрования;
- ✅ 6 таблиц и первая миграция: `users`, `service_connections`, `campaigns`, `bot_reports`, `hypotheses`, `payments`;
- ✅ конфигурация с валидацией и понятными ошибками, шифрование Fernet, структурные логи без секретов;
- ✅ FastAPI-каркас: `/health`, `/api/version`, CORS, автоматическая раздача собранного WebApp;
- ✅ публикация ZIP в GitHub Releases по тегу `v*`.

### Что подключается на следующих этапах
Бот (`bot/`) → движок расчётов (`engine/`) → интеграции Яндекса (`services/`) → ИИ-советник (`ai/`) → платежи СБП (`payments/`) → API-роуты (`api/routes/`) → экраны Mini App (`webapp/`). Каталоги уже созданы: файлы этапов добавляются в готовую структуру без переездов.

---

## 🧪 Разработка и тесты

```bash
# применить миграции вручную (обычно делает start.bat)
docker compose --env-file secrets.env --profile migrate run --rm migrate

# новая миграция после правки core/models.py
docker compose --env-file secrets.env --profile api run --rm api \
  alembic revision --autogenerate -m "описание изменения"

# логи конкретного сервиса
./logs.sh bot        # или logs.bat bot

# тесты (внутри контейнера — там есть все зависимости)
docker compose --env-file secrets.env --profile api run --rm api pytest -q
```

Проверка кода без Docker (нужны только Python и зависимости из `requirements.txt`):
```bash
python -m py_compile core/*.py api/*.py migrations/env.py
bash -n start.sh stop.sh logs.sh update.sh
```

---

## 🚢 Релиз

```bash
git tag v1.0.0
git push origin v1.0.0
```
GitHub Actions соберёт `ai-marketer-v1.0.0.zip` (без `.git`, `node_modules`, `__pycache__`, `secrets.env` и `*.zip`) и приложит его к Release с инструкцией по установке. Пользователь скачивает ZIP, распаковывает и запускает `start.bat` — ничего больше.

---

## 🩺 Если что-то не так

| Симптом | Решение |
|---|---|
| `Docker не установлен` | поставьте Docker Desktop (Windows/macOS) или `docker.io` + `docker-compose-plugin` (Linux), перезагрузитесь |
| «Docker установлен, но не запущен» | откройте Docker Desktop, дождитесь «Engine running» и повторите запуск |
| Сборка падает на этапе 4 | нужно ≥2 ГБ свободной памяти, дайте Docker доступ к диску и интернету, затем `update.bat` |
| `Не получилось прочитать secrets.env` | откройте файл, проверьте обязательные переменные, сохраните без BOM (Блокнот в Windows 10+ пишет корректно) |
| Порт 8000 или 3000 занят | поменяйте `API_PORT`/`WEBAPP_PORT` в `secrets.env` и запустите `start.bat` снова |
| Бот молчит | проверьте `BOT_TOKEN`, `TELEGRAM_PROXY_URL` и `./logs.sh bot` |
| Telegram не открывает приложение | `WEBAPP_URL` должен быть HTTPS; для локальной проверки поднимите туннель к порту 3000 |
| Нужно всё снести | `stop.bat --purge` (удаляет базу и Redis), затем `start.bat` |

**Требования:** Docker Desktop 4.x (или Docker Engine 24+ с Compose v2), 2 ГБ оперативной памяти, 3 ГБ свободного места.

---

## 🧱 Технологии

| Слой | Что используется |
|---|---|
| Бот | Python 3.12, aiogram 3, long-polling через прокси Bot API |
| API | FastAPI, Uvicorn, аутентификация по `X-Telegram-Init-Data` (HMAC-SHA256) |
| Расчёты | чистый Python: детектор ботов, оптимизатор ставок, гипотезы, SEO/GEO — без ИИ |
| ИИ | OpenRouter (бесплатные модели) — только формулировка текста, решения принимает движок |
| Данные | PostgreSQL 16 + SQLAlchemy 2.0 (async) + Alembic, Redis 7 |
| WebApp | Vue 3 Composition API + Vite, дизайн-система Glassmorphism (SF Pro) |
| Платежи | СБП: QR + проверка статуса |
| Инфраструктура | Docker Compose, GitHub Actions → Releases |

---

## 📄 Лицензия и поддержка

Проект распространяется как есть, для внутреннего использования агентствами и фрилансерами. Вопросы и баги — в Issues репозитория. Чек-лист выкладки на боевой сервер — в `docs/` (появится на этапе 9).
