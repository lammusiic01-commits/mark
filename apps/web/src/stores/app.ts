import { defineStore } from 'pinia';
import { api, MarkApiError } from '@/api/client';
import type {
  Client,
  DashboardSummary,
  ServiceDef,
  WhiteLabel,
  PlatformDef,
  SiteConnectorDef,
  GeoRegion,
  BotRecommendationRule,
} from '@mark/shared';

export interface DashboardRecent {
  reports: { id: string; title: string; status: string; at: string }[];
  events: { id: string; level: string; message: string; createdAt: string }[];
  sites: { id: string; name: string; url: string; platform: string; seoScore?: number | null }[];
}

export interface Toast {
  id: string;
  title: string;
  message?: string;
  variant: 'success' | 'error' | 'info' | 'warning';
  timeout?: number;
}

interface MetaPayload {
  version: string;
  demoMode: boolean;
  allowOutbound: boolean;
  services: ServiceDef[];
  platforms: PlatformDef[];
  siteConnectors: SiteConnectorDef[];
  regions: GeoRegion[];
  regionGroups: { id: string; name: string; regionIds: number[] }[];
  niches: { id: string; name: string; cpcMoscow: number; ctr: number; conversion: number; competition: string; keywords: string[] }[];
  botRecommendations: Pick<BotRecommendationRule, 'id' | 'title' | 'severity' | 'artifact'>[];
  ruleTypes: { id: string; label: string }[];
  metrics: { id: string; label: string }[];
  cronPresets: { expression: string; label: string }[];
  plugins: { id: string; title: string; status: string }[];
}

interface SettingsPayload {
  settings: Record<string, unknown> & { appName?: string; autoOptimizationEnabled?: boolean; botProtectionEnabled?: boolean; geoEnabled?: boolean; reportEmail?: string; telegramChatId?: string };
  env: { demoMode: boolean; allowOutbound: boolean; dryRunAlways: boolean; dataDir: string; port: number; nodeEnv: string };
}

export const useAppStore = defineStore('app', {
  state: () => ({
    ready: false,
    meta: null as MetaPayload | null,
    settings: null as SettingsPayload | null,
    branding: null as WhiteLabel | null,
    clients: [] as Client[],
    activeClientId: (localStorage.getItem('mark.clientId') ?? '') as string,
    dashboard: null as DashboardSummary | null,
    dashboardRecent: null as DashboardRecent | null,
    toasts: [] as Toast[],
    busy: false,
  }),

  getters: {
    services: (state) => state.meta?.services ?? [],
    regions: (state) => state.meta?.regions ?? [],
    niches: (state) => state.meta?.niches ?? [],
    activeClient: (state) => state.clients.find((client) => client.id === state.activeClientId) ?? null,
    serviceById: (state) => (id: string) => state.meta?.services.find((service) => service.id === id) ?? null,
  },

  actions: {
    async bootstrap() {
      if (this.ready) return;
      this.busy = true;
      try {
        const [meta, settings, branding, clients] = await Promise.all([
          api.get<MetaPayload>('/api/meta'),
          api.get<SettingsPayload>('/api/settings'),
          api.get<WhiteLabel>('/api/branding').catch(() => null),
          api.get<Client[]>('/api/clients').catch(() => []),
        ]);
        this.meta = meta;
        this.settings = settings;
        this.branding = branding;
        this.clients = clients;
        if (this.branding?.id) localStorage.setItem('mark.tenantId', this.branding.id);
        if (!this.activeClientId && clients[0]) this.setActiveClient(clients[0].id);
        this.applyBranding();
        this.ready = true;
      } catch (error) {
        this.notifyError(error, 'Не удалось загрузить справочники');
      } finally {
        this.busy = false;
      }
    },

    applyBranding() {
      const root = document.documentElement;
      if (this.branding?.brandColor) root.style.setProperty('--brand', this.branding.brandColor);
      if (this.branding?.accentColor) root.style.setProperty('--accent', this.branding.accentColor);
      document.title = `${this.branding?.hideMarkBranding ? this.branding.agencyName : 'MARK'} — SEO/GEO и защита от ботов`;
    },

    setActiveClient(clientId: string) {
      this.activeClientId = clientId;
      if (clientId) localStorage.setItem('mark.clientId', clientId);
      else localStorage.removeItem('mark.clientId');
    },

    async loadDashboard() {
      try {
        const payload = await api.get<{ summary: DashboardSummary; recent: DashboardRecent }>(
          `/api/dashboard${this.activeClientId ? `?clientId=${this.activeClientId}` : ''}`,
        );
        this.dashboard = payload.summary;
        this.dashboardRecent = payload.recent;
      } catch (error) {
        this.notifyError(error, 'Не удалось загрузить дашборд');
      }
    },

    async reloadClients() {
      this.clients = await api.get<Client[]>('/api/clients');
      if (!this.clients.some((client) => client.id === this.activeClientId) && this.clients[0]) this.setActiveClient(this.clients[0].id);
    },

    async saveBranding(payload: Partial<WhiteLabel>) {
      this.branding = await api.put<WhiteLabel>('/api/branding', payload);
      this.applyBranding();
      this.toast('success', 'Оформление сохранено', 'Название, цвета и подписи в отчётах обновлены.');
    },

    async saveSettings(payload: Record<string, unknown>) {
      const saved = await api.patch<Record<string, unknown>>('/api/settings', payload);
      if (this.settings) this.settings.settings = { ...this.settings.settings, ...saved };
      this.toast('success', 'Настройки сохранены');
      return saved;
    },

    /* ------------------------------ Уведомления ------------------------------ */

    toast(variant: Toast['variant'], title: string, message?: string, timeout = 6000) {
      const id = `t${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
      this.toasts.push({ id, title, message, variant, timeout });
      if (timeout > 0) window.setTimeout(() => this.dismiss(id), timeout);
    },

    dismiss(id: string) {
      this.toasts = this.toasts.filter((toast) => toast.id !== id);
    },

    notifyError(error: unknown, title = 'Ошибка') {
      if (error instanceof MarkApiError) {
        this.toast('error', title, error.message);
      } else if (error instanceof Error) {
        this.toast('error', title, error.message);
      } else {
        this.toast('error', title, String(error));
      }
    },

    /** Обёртка запроса: ошибка уходит тостом, UI получает null. */
    async call<T>(fn: () => Promise<T>, title = 'Ошибка запроса'): Promise<T | null> {
      try {
        return await fn();
      } catch (error) {
        this.notifyError(error, title);
        return null;
      }
    },
  },
});
