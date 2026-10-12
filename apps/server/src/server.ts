import http from 'node:http';
import os from 'node:os';
import process from 'node:process';
import { MARK_VERSION } from '@mark/shared';
import { createApp } from './app.js';
import { config } from './config.js';
import { repos } from './db/repos.js';
import { rootLogger } from './logger.js';
import { hub } from './realtime.js';
import { ensureDemoData } from './seed.js';
import { scheduler } from './services/scheduler.js';

/**
 * Точка входа сервера MARK.
 *
 * Запуск:
 *   npm run dev                  — разработка (tsx watch + Vite)
 *   npm run build && npm start   — production (собранный фронт отдаёт этот же сервер)
 *   node apps/server/dist/server.mjs --port 9000 --data-dir ./data
 */

const log = rootLogger.child('server');

async function main(): Promise<void> {
  const started = Date.now();
  const db = await repos();
  const seeded = await ensureDemoData();

  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  hub.attach(server, '/ws');

  // Правила автооптимизации: scheduler.start() планирует все включённые правила из БД
  await scheduler.start();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const urls = [`http://${shown}:${config.port}`];
  for (const address of Object.values(os.networkInterfaces()).flat()) {
    if (address && address.family === 'IPv4' && !address.internal) urls.push(`http://${address.address}:${config.port}`);
  }

  log.info(`MARK ${MARK_VERSION} запущен за ${Date.now() - started} мс`);
  log.info(`API: ${urls[0]}/api/meta`);
  for (const url of urls.slice(1)) log.info(`В сети: ${url}`);
  log.info(`Данные: ${config.dataDir}`);
  log.info(`Демо-режим: ${config.demoMode ? 'включён' : 'выключен'} · Исходящая сеть: ${config.allowOutbound ? 'разрешена' : 'запрещена'}`);
  if (seeded.created) log.info(`Созданы демо-данные: клиентов ${seeded.clients}, сайтов ${seeded.sites}, кампаний ${seeded.campaigns}, гипотез ${seeded.hypotheses}`);
  if (db.tenant.count({}) > 0) log.debug('Хранилище готово');

  const shutdown = async (signal: string) => {
    log.info(`Получен ${signal}, останавливаюсь…`);
    scheduler.stop();
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('Необработанное отклонение промиса', reason));
  process.on('uncaughtException', (error) => log.error('Необработанное исключение', error));
}

main().catch((error) => {
  log.error('Не удалось запустить сервер', error);
  process.exit(1);
});
