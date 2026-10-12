# AI Маркетолог 4.0 — Telegram Mini App для Windows

Mini App для владельцев контекстной рекламы в Яндекс Директ. Открывается прямо внутри
Telegram на телефоне: кнопка в боте → приложение на весь экран.

Ключевые функции: дашборд KPI, кампании с рекомендациями по ставкам и паузе через API,
Bot Shield (накрутка и боты), A/B-тесты с z-тестом, SEO-аудит, мониторинг конкурентов,
ROI-калькулятор, воронка, отчёты, баланс с оплатой по QR (ST00012), AI-советник.

**Скрипт считает всё, AI только комментирует.** Без ключа OpenRouter приложение работает полностью.

---

## Как это работает

```
start.bat
  ├─ проверяет Python 3.11+, создаёт venv, ставит зависимости
  ├─ скачивает cloudflared.exe (один раз)
  ├─ запускает Cloudflare Tunnel: localhost:PORT → https://xxx.trycloudflare.com → tunnel.url
  ├─ миграции Alembic
  └─ python -m app.main  (один процесс)
       ├─ FastAPI на 127.0.0.1:PORT  — /api/* и SPA Mini App из webapp/dist
       ├─ aiogram-бот (asyncio-задача) — все запросы к Telegram через Worker-прокси
       ├─ монитор доступности сайтов (asyncio-задача) — уведомления в Telegram
       └─ SQLite data.db
```

Два компонента Cloudflare:
1. **Worker** (`TELEGRAM_PROXY_URL`) — прокси до `api.telegram.org`. Без него бот в РФ не работает.
2. **Tunnel** (`cloudflared`) — HTTPS-адрес для Mini App. Telegram не открывает `http://`.

Авторизация: каждый запрос из Mini App несёт `X-Telegram-Init-Data`. Сервер проверяет подпись
HMAC-SHA256 по ключу бота и срок давности (24 часа). Подделка даёт 401.

Секреты пользователя (токены Директа и OpenRouter) хранятся в БД **зашифрованными** (Fernet).

---

## Установка (пользователь, Windows)

1. Скачай ZIP из раздела **Releases** и распакуй.
2. Двойной клик на **start.bat**. При первом запуске откроется `secrets.env`.
3. Заполни:
   - `BOT_TOKEN` — токен от @BotFather
   - `ADMIN_TG_IDS` — свой Telegram ID (узнать у @userinfobot), для подтверждения пополнений
   - `OPENROUTER_API_KEY` — необязательно, для AI-комментариев
   - `SBP_MERCHANT_ID`, `SBP_ACCOUNT`, `SBP_BIC` — реквизиты для пополнения баланса (необязательно)
4. Запусти **start.bat** снова и **не закрывай окно**.
5. В Telegram открой бота → `/start` → «Открыть приложение».

Остановка: **stop.bat**. Сброс данных: **reset.bat**. Логи: **logs.bat**.

### Подключение Яндекс Директа
- Токен: oauth.yandex.ru, права `direct:api` (и `metrika:read` для Метрики).
- В приложении: **Подключения** → вставить токен → «Проверить токен».
- Для конверсий в Директе нужна **цель Метрики**: укажи её ID в подключениях. Без неё
  Директ не отдаёт конверсии, и CPA и рекомендации по ставкам не считаются.
- Затем «Синхронизировать за 14 дней».

---

## Разработка

Требования: Python 3.11+, Node.js 20+.

```bash
# backend
python -m venv venv && venv\Scripts\activate
pip install -r requirements-dev.txt
python -m pytest -q tests
python -m app.main            # API на :8000

# frontend (отдельно, с прокси на /api)
cd webapp
npm install
npm run dev                   # http://localhost:5173
npm run build                 # пересобрать webapp/dist (его нужно коммитить)
```

Режим `DEV_MODE=1` пропускает проверку initData для открытия в обычном браузере.
**В продакшене — `DEV_MODE=0`.**

### Структура

```
app/
  main.py            точка входа: API + бот + монитор
  config.py          настройки (secrets.env, tunnel.url)
  database.py        SQLite async
  models.py          ORM
  security.py        Fernet для секретов
  api/
    auth.py          проверка initData (HMAC-SHA256)
    deps.py          текущий пользователь, админ
    routes/          dashboard, campaigns, bot_shield, hypotheses, seo, competitors,
                     roi, funnel, reports, balance, settings, services
  engine/            расчёты БЕЗ AI: bot_detector, bid_optimizer, hypothesis_engine,
                     seo_analyzer, competitor_tracker, roi_calculator, funnel_analyzer,
                     budget_allocator, report_generator, campaign_manager, analysis
  ai/                OpenRouter-клиент и советник (скрипт + комментарий модели)
  services/          yandex_direct, yandex_metrika, site_monitor, url_guard (защита от SSRF)
  payments/sbp.py    QR в формате ST00012
  bot/               handlers (/start → кнопка Mini App), proxy_session, notifications
webapp/
  src/               Vue 3 + Vite, Lucide-иконки (без эмодзи), SVG-графики
  dist/              собранный фронтенд (коммитится, нужен для start.bat)
migrations/          Alembic
tests/               36 тестов: auth, движки, интеграции, сквозной API-сценарий, бот
```

### Примечания по безопасности
- Пользователь видит и меняет только свои данные (проверено тестом изоляции).
- Введённые адреса сайтов проверяются на SSRF: внутренние и loopback-адреса запрещены.
- Внешний доступ даёт только Cloudflare Tunnel; сам сервер слушает `127.0.0.1`.
- Ключи в ответах API не показываются, только маска `••••1234`.

---

## Ограничения (честно)

- **Quick Tunnel** (`*.trycloudflare.com`) получает новый адрес при каждом запуске и не даёт
  гарантий доступности. Бот всегда отдаёт актуальный адрес, но доступность из российских
  мобильных сетей стоит проверить отдельно. Для стабильного адреса нужен именованный туннель
  со своим доменом.
- **Оплата**: QR-платёж подтверждает администратор в разделе «Баланс». Автоматического
  эквайринга нет.
- **Конверсии Директа** требуют ID цели Метрики (см. выше).
- **Визиты сайта** берутся из Метрики и требуют токена с правом `metrika:read`.
- AI-советник: при общем ключе сервиса каждый совет списывается с баланса (`AI_CHARGE_KOP`).

## Релиз

Тег `vX.Y.Z` запускает `.github/workflows/release.yml`: собирает фронтенд, упаковывает ZIP
и публикует его в GitHub Release. CI (`ci.yml`) гоняет тесты и сборку на каждый push.
