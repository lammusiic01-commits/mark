#!/usr/bin/env electron
/**
 * MARK Desktop — оболочка Electron.
 *
 * Задачи приложения:
 *   1) открыть сам интерфейс MARK (локальный сервер или удалённый адрес);
 *   2) открыть «окно входа» в любой сервис (Яндекс.Директ, Метрика, GSC, Tilda,
 *      WordPress, Cloudflare, Vercel и т. д.) прямо внутри приложения —
 *      пароль, СМС и капча остаются у пользователя;
 *   3) после входа забрать cookies окна и отправить их на сервер MARK
 *      (POST /api/sessions/:id/cookies) — дальше сервисом управляет MARK;
 *   4) при необходимости поднять локальный сервер MARK одной кнопкой.
 *
 * Запуск: npm run desktop:start  (нужен собранный фронтенд и сервер)
 */
'use strict';

const { app, BrowserWindow, ipcMain, shell, Menu, session: electronSession } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/* ------------------------------ Настройки ------------------------------ */

const argv = process.argv.slice(1);
const argValue = (name) => {
  const index = argv.findIndex((item) => item === name || item.startsWith(`${name}=`));
  if (index === -1) return null;
  const item = argv[index];
  if (item.includes('=')) return item.split('=').slice(1).join('=');
  return argv[index + 1] ?? null;
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

const defaults = {
  // Адрес API MARK. По умолчанию — локальный сервер, который умеет и API, и фронтенд.
  apiUrl: argValue('--api') || process.env.MARK_API_URL || 'http://127.0.0.1:8787',
  // Куда заходить при старте: интерфейс MARK.
  appUrl: argValue('--url') || process.env.MARK_APP_URL || '',
  autoStartServer: process.env.MARK_AUTOSTART === '1',
};

function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...defaults };
  }
}

function saveSettings(patch) {
  try {
    const next = { ...loadSettings(), ...patch };
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
    return next;
  } catch (error) {
    log(`Не удалось сохранить настройки: ${error.message}`);
    return loadSettings();
  }
}

let settings = loadSettings();

/* --------------------------- Вспомогательные --------------------------- */

const state = {
  controlWindow: null,
  mainWindow: null,
  loginWindow: null,
  login: null, // { sessionId, serviceId, serviceName, url, partition, cookies: number }
  serverProcess: null,
  logLines: [],
};

function log(message) {
  const line = `${new Date().toLocaleTimeString('ru-RU')}  ${message}`;
  state.logLines.push(line);
  if (state.logLines.length > 300) state.logLines.shift();
  process.stdout.write(`[mark] ${message}\n`);
  for (const window of [state.controlWindow, state.mainWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('mark:log', line);
  }
}

function appUrl() {
  return settings.appUrl || `${settings.apiUrl.replace(/\/$/, '')}/`;
}

async function apiProbe() {
  const base = settings.apiUrl.replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, version: payload?.data?.version ?? null, base };
  } catch (error) {
    return { ok: false, status: 0, error: error.message, base };
  }
}

async function saveCookiesToServer(payload) {
  const base = settings.apiUrl.replace(/\/$/, '');
  const response = await fetch(`${base}/api/sessions/${encodeURIComponent(payload.sessionId)}/cookies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cookieHeader: payload.cookieHeader,
      cookies: payload.cookies,
      userAgent: payload.userAgent,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `Сервер вернул ${response.status}`);
  }
  return body.data ?? body;
}

/** Оставляем cookies того домена, куда заходили (плюс его поддомены). */
function pickCookies(cookies, url) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  const base = host.replace(/^www\./, '');
  const root = base.split('.').slice(-2).join('.');
  if (!root) return cookies;
  const matched = cookies.filter((cookie) => String(cookie.domain ?? '').replace(/^\./, '').endsWith(root));
  return matched.length ? matched : cookies;
}

/* ---------------------------- Окно входа ---------------------------- */

async function readLoginCookies() {
  if (!state.login) return [];
  const partition = electronSession.fromPartition(state.login.partition);
  const all = await partition.cookies.get({});
  return pickCookies(all, state.login.url);
}

function broadcastLogin() {
  const payload = state.login
    ? { active: true, ...state.login, cookiesFound: state.login.cookies }
    : { active: false };
  for (const window of [state.controlWindow, state.mainWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('mark:login:update', payload);
  }
}

async function openLoginWindow(payload) {
  const { sessionId, url, serviceId, serviceName } = payload ?? {};
  if (!url) throw new Error('Не передан адрес страницы входа');

  if (state.loginWindow && !state.loginWindow.isDestroyed()) state.loginWindow.destroy();

  const partition = `persist:mark-login-${serviceId || 'service'}`;
  state.login = { sessionId: sessionId ?? null, serviceId: serviceId ?? null, serviceName: serviceName ?? 'сервис', url, partition, cookies: 0 };

  const window = new BrowserWindow({
    width: 1180,
    height: 860,
    title: `Вход: ${serviceName ?? 'сервис'}`,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  state.loginWindow = window;
  window.setMenuBarVisibility(false);
  await window.loadURL(url);

  // Свой браузерный user-agent не подменяем: сервисы доверяют обычному Chrome.
  log(`Окно входа открыто: ${url}`);

  const collect = async () => {
    if (!state.login) return;
    const cookies = await readLoginCookies();
    if (state.login.cookies !== cookies.length) {
      state.login.cookies = cookies.length;
      broadcastLogin();
    }
  };

  window.webContents.on('did-finish-load', () => {
    void collect();
  });
  window.webContents.on('did-navigate', () => {
    void collect();
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    // OAuth-окна сервисов тоже держим внутри приложения
    if (/^https?:/.test(target)) void window.loadURL(target);
    return { action: 'deny' };
  });
  window.on('closed', () => {
    if (state.loginWindow === window) state.loginWindow = null;
    void collect().finally(broadcastLogin);
  });

  const timer = setInterval(() => void collect().catch(() => undefined), 1500);
  window.on('closed', () => clearInterval(timer));
  broadcastLogin();
  return { ok: true, partition };
}

async function saveLoginSession() {
  if (!state.login || !state.login.sessionId) throw new Error('Сначала откройте окно входа из MARK');
  const cookies = await readLoginCookies();
  if (!cookies.length) throw new Error('Cookies не найдены — войдите в аккаунт в открывшемся окне');
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const userAgent = state.loginWindow && !state.loginWindow.isDestroyed() ? state.loginWindow.webContents.getUserAgent() : undefined;
  const result = await saveCookiesToServer({
    sessionId: state.login.sessionId,
    cookieHeader,
    cookies: cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, expirationDate: cookie.expirationDate })),
    userAgent,
  });
  log(`Сессия сохранена: ${cookies.length} cookies → ${state.login.serviceName}`);
  return { ok: true, cookies: cookies.length, result };
}

/* --------------------------- Локальный сервер --------------------------- */

function repoRoot() {
  const candidates = [
    path.resolve(__dirname, '..', '..'), // из apps/desktop
    path.resolve(process.resourcesPath ?? '', 'repo'),
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'apps', 'server'))) ?? candidates[0];
}

function startLocalServer() {
  if (state.serverProcess && !state.serverProcess.killed) return { ok: true, already: true, pid: state.serverProcess.pid };
  const root = repoRoot();
  const entry = fs.existsSync(path.join(root, 'apps', 'server', 'dist', 'server.mjs'))
    ? path.join(root, 'apps', 'server', 'dist', 'server.mjs')
    : path.join(root, 'apps', 'server', 'src', 'server.ts');
  const needsTsx = entry.endsWith('.ts');
  const port = Number(new URL(settings.apiUrl).port || 8787);
  const command = needsTsx ? process.execPath : process.execPath;
  const args = needsTsx
    ? [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), entry, '--serve-web', '--port', String(port)]
    : [entry, '--serve-web', '--port', String(port)];

  // В Electron process.execPath — это сам Electron: для запуска Node-скрипта нужен ELECTRON_RUN_AS_NODE.
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MARK_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.serverProcess = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => chunk.split('\n').filter(Boolean).forEach((line) => log(`[server] ${line}`)));
  child.stderr.on('data', (chunk) => chunk.split('\n').filter(Boolean).forEach((line) => log(`[server] ${line}`)));
  child.on('exit', (code) => {
    log(`Локальный сервер остановлен (код ${code})`);
    state.serverProcess = null;
    for (const window of [state.controlWindow, state.mainWindow]) {
      if (window && !window.isDestroyed()) window.webContents.send('mark:server:update', { running: false, code });
    }
  });
  log(`Локальный сервер запускается: ${entry} (порт ${port})`);
  return { ok: true, pid: child.pid };
}

/* ------------------------------ Окна ------------------------------ */

function openControlWindow() {
  if (state.controlWindow && !state.controlWindow.isDestroyed()) {
    state.controlWindow.focus();
    return state.controlWindow;
  }
  const window = new BrowserWindow({
    width: 760,
    height: 780,
    title: 'MARK Desktop',
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.loadFile(path.join(__dirname, 'login.html'));
  window.on('closed', () => {
    state.controlWindow = null;
  });
  state.controlWindow = window;
  return window;
}

function openMainWindow(target) {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    void state.mainWindow.loadURL(target ?? appUrl());
    state.mainWindow.focus();
    return state.mainWindow;
  }
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    title: 'MARK',
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.loadURL(target ?? appUrl());
  window.on('closed', () => {
    state.mainWindow = null;
  });
  state.mainWindow = window;
  return window;
}

/* ------------------------------- Меню ------------------------------- */

function buildMenu() {
  const template = [
    {
      label: 'MARK',
      submenu: [
        { label: 'Открыть интерфейс', accelerator: 'CmdOrCtrl+1', click: () => openMainWindow() },
        { label: 'Панель подключений', accelerator: 'CmdOrCtrl+2', click: () => openControlWindow() },
        { type: 'separator' },
        { label: 'Запустить локальный сервер', click: () => startLocalServer() },
        { label: 'Проверить связь с API', click: () => void apiProbe().then((result) => log(`API ${result.base}: ${result.ok ? 'доступен' : `недоступен (${result.error ?? result.status})`}`)) },
        { type: 'separator' },
        { role: 'quit', label: 'Выход' },
      ],
    },
    {
      label: 'Вид',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------- IPC ------------------------------- */

ipcMain.handle('mark:app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  settings,
  api: settings.apiUrl,
  app: appUrl(),
}));

ipcMain.handle('mark:health', async () => apiProbe());

ipcMain.handle('mark:app:open', (_event, target) => {
  openMainWindow(target);
  return { ok: true, url: target ?? appUrl() };
});

ipcMain.handle('mark:server:start', () => startLocalServer());
ipcMain.handle('mark:server:status', () => ({ running: Boolean(state.serverProcess && !state.serverProcess.killed), pid: state.serverProcess?.pid ?? null }));

ipcMain.handle('mark:settings:save', (_event, patch) => {
  settings = saveSettings(patch ?? {});
  broadcastLogin();
  return { ok: true, settings };
});

ipcMain.handle('mark:login:open', async (_event, payload) => openLoginWindow(payload));
ipcMain.handle('mark:login:status', async () => {
  if (!state.login) return { active: false };
  const cookies = await readLoginCookies();
  state.login.cookies = cookies.length;
  return { active: true, ...state.login };
});
ipcMain.handle('mark:login:save', async () => {
  try {
    const result = await saveLoginSession();
    if (state.loginWindow && !state.loginWindow.isDestroyed()) state.loginWindow.close();
    broadcastLogin();
    return result;
  } catch (error) {
    log(`Не удалось сохранить сессию: ${error.message}`);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('mark:login:cancel', async () => {
  const sessionId = state.login?.sessionId;
  if (state.loginWindow && !state.loginWindow.isDestroyed()) state.loginWindow.close();
  if (sessionId) {
    await fetch(`${settings.apiUrl.replace(/\/$/, '')}/api/sessions/${encodeURIComponent(sessionId)}/close`, { method: 'POST' }).catch(() => undefined);
  }
  state.login = null;
  broadcastLogin();
  return { ok: true };
});
ipcMain.handle('mark:login:focus', () => {
  if (state.loginWindow && !state.loginWindow.isDestroyed()) state.loginWindow.focus();
  return { ok: true };
});
ipcMain.handle('mark:open-external', async (_event, url) => {
  if (typeof url === 'string' && /^https?:/.test(url)) await shell.openExternal(url);
  return { ok: true };
});

/* ------------------------------ Старт ------------------------------ */

app.whenReady().then(() => {
  buildMenu();
  openControlWindow();
  log(`MARK Desktop запущен. API: ${settings.apiUrl}`);

  void apiProbe().then((result) => {
    if (result.ok) {
      log('API доступен — можно работать.');
      return;
    }
    log('API не отвечает.');
    if (settings.autoStartServer) startLocalServer();
  });

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) openControlWindow();
  });
});

app.on('window-all-closed', () => {
  if (state.serverProcess && !state.serverProcess.killed) {
    try {
      state.serverProcess.kill();
    } catch {
      /* ignore */
    }
  }
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (error) => log(`Ошибка приложения: ${error.message}`));
