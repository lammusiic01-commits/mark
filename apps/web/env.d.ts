/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  readonly VITE_MARK_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/* ------------------------------------------------------------------ */
/* Мост MARK Desktop (Electron): window.mark доступен только в приложении */
/* ------------------------------------------------------------------ */

interface MarkDesktopLoginState {
  active: boolean;
  sessionId?: string | null;
  serviceId?: string | null;
  serviceName?: string;
  url?: string;
  partition?: string;
  cookies?: number;
  cookiesFound?: number;
}

interface MarkDesktopBridge {
  isDesktop: true;
  platform: string;
  electron: string;
  app: {
    info: () => Promise<{ version: string; electron: string; node: string; platform: string; api: string; app: string; settings: { apiUrl: string; appUrl: string } }>;
    open: (url?: string) => Promise<{ ok: boolean; url: string }>;
    health: () => Promise<{ ok: boolean; status: number; version?: string | null; base: string; error?: string }>;
    openExternal: (url: string) => Promise<{ ok: boolean }>;
    saveSettings: (patch: { apiUrl?: string; appUrl?: string }) => Promise<{ ok: boolean }>;
  };
  server: {
    start: () => Promise<{ ok: boolean; pid?: number; already?: boolean }>;
    status: () => Promise<{ running: boolean; pid: number | null }>;
  };
  login: {
    open: (payload: { sessionId: string; url: string; serviceId: string; serviceName?: string }) => Promise<{ ok: boolean }>;
    status: () => Promise<MarkDesktopLoginState>;
    save: () => Promise<{ ok: boolean; cookies?: number; error?: string }>;
    cancel: () => Promise<{ ok: boolean }>;
    focus: () => Promise<{ ok: boolean }>;
    onUpdate: (callback: (state: MarkDesktopLoginState) => void) => () => void;
  };
  onLog: (callback: (line: string) => void) => () => void;
}

interface Window {
  mark?: MarkDesktopBridge;
}
