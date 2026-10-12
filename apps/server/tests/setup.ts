import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Общая подготовка тестов: своя временная папка данных и отключение
 * реальных исходящих запросов (демо-режим), чтобы тесты были детерминированными.
 *
 * Внимание: файл выполняется ДО импорта тестируемых модулей — поэтому
 * переменные окружения успевают попасть в config.ts.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-test-'));

process.env.MARK_DATA_DIR = dataDir;
process.env.MARK_DEMO_MODE = '1';
process.env.MARK_ALLOW_OUTBOUND = '0';
process.env.MARK_DRY_RUN = '1';
process.env.MARK_LOG_LEVEL = 'error';
process.env.TZ = process.env.TZ ?? 'Europe/Moscow';

export const TEST_DATA_DIR = dataDir;

// Диагностика: падения фоновых задач должны быть видны в выводе теста
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', error.message, '\n', error.stack);
});
