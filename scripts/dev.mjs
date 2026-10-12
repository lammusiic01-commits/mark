#!/usr/bin/env node
/**
 * Запуск dev-окружения MARK одной командой:
 *   - API-сервер (apps/server) с hot-reload через tsx watch;
 *   - фронтенд Vite с проксированием /api и /ws на сервер.
 *
 * Печатает оба адреса и следит за завершением процессов.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const children = [];
let shuttingDown = false;

function run(name, cmd, args, cwd, env = {}) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const prefix = `[${name}] `;
  const pipe = (stream, isErr) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (isErr) process.stderr.write(prefix + line + '\n');
        else process.stdout.write(prefix + line + '\n');
      }
    });
  };
  pipe(child.stdout, false);
  pipe(child.stderr, true);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      process.stdout.write(`${prefix}процесс завершён (code=${code ?? signal})\n`);
      shutdown(code ?? 0);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      if (isWin) child.kill();
      else process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  setTimeout(() => process.exit(code), 1200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('MARK dev: запускаю API-сервер и фронтенд...\n');

run('api', npmCmd, ['run', 'dev', '--workspace', '@mark/server'], root, {
  MARK_PORT: process.env.MARK_PORT ?? '8787',
  MARK_HOST: '0.0.0.0',
});

setTimeout(() => {
  run('web', npmCmd, ['run', 'dev', '--workspace', '@mark/web', '--', '--host', '0.0.0.0'], root, {
    MARK_API_TARGET: `http://127.0.0.1:${process.env.MARK_PORT ?? '8787'}`,
  });
}, 900);
