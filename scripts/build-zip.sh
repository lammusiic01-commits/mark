#!/usr/bin/env bash
#
# Сборка ZIP-архива проекта MARK для передачи заказчику/сборщику.
#
# Что попадает в архив: исходники, конфиги, документация, скрипты.
# Что НЕ попадает: node_modules, .data (база, секреты, отчёты), dist/release,
#                   .git, временные файлы и уже собранные архивы.
#
# Запуск:  npm run zip            (или bash scripts/build-zip.sh)
# Результат:  dist/mark-<версия>.zip
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
STAMP="$(date +%Y%m%d)"
OUT_DIR="$ROOT/dist"
NAME="mark-${VERSION}-${STAMP}"
ARCHIVE="$OUT_DIR/${NAME}.zip"

mkdir -p "$OUT_DIR"

if ! command -v zip >/dev/null 2>&1; then
  echo "Не найден zip. Установите его (apt install zip / brew install zip) или соберите tar.gz:"
  echo "  tar --exclude=node_modules --exclude=.data --exclude=dist -czf dist/${NAME}.tar.gz ."
  exit 1
fi

echo "MARK ${VERSION}: собираю архив…"
rm -f "$ARCHIVE"

# -x: исключения (пути относительно корня)
zip -q -r "$ARCHIVE" . \
  -x "node_modules/*" \
  -x "*/*/node_modules/*" \
  -x "*/*/*/node_modules/*" \
  -x ".git/*" \
  -x ".data/*" \
  -x "dist/*" \
  -x "*/dist/*" \
  -x "*/release/*" \
  -x "*.zip" \
  -x "*.tsbuildinfo" \
  -x "*.log" \
  -x "*/coverage/*" \
  -x "*/.vite/*" \
  -x "*/tmp/*" \
  -x ".DS_Store" \
  -x "*/Thumbs.db"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
FILES="$(unzip -l "$ARCHIVE" | tail -1 | awk '{print $2}')"

cat <<EOF

Готово: ${ARCHIVE#$ROOT/}  (${SIZE}, файлов: ${FILES})

Что делать получателю:
  unzip ${NAME}.zip && cd ${NAME}
  npm install
  npm run build
  npm start                 # http://localhost:8787

Опционально (окна входа сервисов в приложении):
  npm run desktop:install && npm run desktop:start

Проверка окружения перед передачей: npm run typecheck && npm test
EOF
