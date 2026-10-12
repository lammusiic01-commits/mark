#!/usr/bin/env node
/**
 * Сборка сервера MARK: esbuild собирает TypeScript в один ESM-файл
 * apps/server/dist/server.mjs.
 *
 * Почему ESM: код использует import.meta.url (пути к .data, к sql-wasm.wasm),
 * а нативные и «тяжёлые» пакеты (express, ws, sql.js, playwright-core, ssh2-sftp-client)
 * остаются внешними — они уже стоят в node_modules и не требуют сборки.
 *
 * Запуск: npm run build -w @mark/server
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const outDir = path.join(pkgRoot, 'dist');
const outfile = path.join(outDir, 'server.mjs');

const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

// Внешними оставляем всё, кроме собственного workspace-пакета @mark/shared
// (его исходники на TypeScript — их нужно встроить в бандл).
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
].filter((name) => name !== '@mark/shared');

fs.mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(pkgRoot, 'src', 'server.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  external,
  metafile: true,
  logLevel: 'info',
  banner: {
    js: ['#!/usr/bin/env node', '/* MARK — собранный сервер (esbuild). Исходники: apps/server/src */'].join('\n'),
  },
});

fs.chmodSync(outfile, 0o755);

const bytes = fs.statSync(outfile).size;
const inputs = Object.keys(result.metafile.inputs).length;
process.stdout.write(`\nСервер собран: ${path.relative(process.cwd(), outfile)} (${(bytes / 1024).toFixed(0)} КБ, модулей: ${inputs})\n`);
process.stdout.write('Запуск: npm start   (или node apps/server/dist/server.mjs --serve-web)\n');
