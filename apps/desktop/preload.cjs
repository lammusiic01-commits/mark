/**
 * preload.cjs — мост между окнами Electron и интерфейсом MARK.
 *
 * В окнах приложения доступен объект window.mark. Веб-интерфейс использует его,
 * чтобы открывать «окна входа» сервисов внутри приложения:
 *
 *   await window.mark.login.open({ sessionId, url, serviceId, serviceName });
 *   await window.mark.login.save();   // забрать cookies и отправить на сервер
 *
 * Если приложение открыто в обычном браузере, window.mark отсутствует —
 * интерфейс предлагает резервные способы (Playwright или ручной импорт cookies).
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mark', {
  isDesktop: true,
  platform: process.platform,
  electron: process.versions.electron,

  app: {
    info: () => ipcRenderer.invoke('mark:app:info'),
    open: (url) => ipcRenderer.invoke('mark:app:open', url),
    health: () => ipcRenderer.invoke('mark:health'),
    openExternal: (url) => ipcRenderer.invoke('mark:open-external', url),
    saveSettings: (patch) => ipcRenderer.invoke('mark:settings:save', patch),
  },

  server: {
    start: () => ipcRenderer.invoke('mark:server:start'),
    status: () => ipcRenderer.invoke('mark:server:status'),
  },

  login: {
    open: (payload) => ipcRenderer.invoke('mark:login:open', payload),
    status: () => ipcRenderer.invoke('mark:login:status'),
    save: () => ipcRenderer.invoke('mark:login:save'),
    cancel: () => ipcRenderer.invoke('mark:login:cancel'),
    focus: () => ipcRenderer.invoke('mark:login:focus'),
    onUpdate: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('mark:login:update', listener);
      return () => ipcRenderer.removeListener('mark:login:update', listener);
    },
  },

  onLog: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('mark:log', listener);
    return () => ipcRenderer.removeListener('mark:log', listener);
  },
});
