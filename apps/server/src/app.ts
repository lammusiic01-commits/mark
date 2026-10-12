import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import { config } from './config.js';
import { rootLogger } from './logger.js';
import { errorHandler, notFound, requestLogger } from './http/helpers.js';
import { apiRouter } from './routes/index.js';
import { connectRouter } from './routes/connect.js';
import { siteRouter } from './routes/site.js';
import { opsRouter } from './routes/ops.js';

/**
 * Сборка HTTP-приложения Express.
 *
 * Порядок важен: API → статика фронтенда → SPA-fallback → обработчики ошибок.
 * Лимит тела поднят до 48 МБ: через API передаются логи BotShield и HTML для отчётов.
 */

const log = rootLogger.child('app');

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '48mb' }));
  app.use(express.urlencoded({ extended: true, limit: '8mb' }));
  app.use(requestLogger);

  // CORS: инструмент работает локально, но к нему обращаются превью-домены и Electron
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-mark-tenant');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/api', apiRouter);
  app.use('/api', connectRouter);
  app.use('/api', siteRouter);
  app.use('/api', opsRouter);

  // Статика собранного фронтенда (npm run build && npm start -- --serve-web)
  if (fs.existsSync(config.webDir)) {
    app.use(express.static(config.webDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|ws).*/, (_req, res) => {
      res.sendFile(path.join(config.webDir, 'index.html'));
    });
    log.info(`Фронтенд подключён: ${config.webDir}`);
  } else {
    app.get('/', (_req, res) => {
      res.json({
        ok: true,
        data: {
          message: 'MARK API работает. Фронтенд не собран — выполните npm run build или запустите npm run dev',
          api: '/api/meta',
          web: 'npm run dev → http://localhost:5173',
        },
      });
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
