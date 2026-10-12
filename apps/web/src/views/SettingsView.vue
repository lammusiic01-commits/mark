<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import CodeBox from '@/components/CodeBox.vue';
import StatusPill from '@/components/StatusPill.vue';
import TelegramBotCard from '@/components/TelegramBotCard.vue';

/**
 * Настройки: окружение, флаги безопасности, диагностика сети,
 * клиенты агентства и служебная информация.
 */

const store = useAppStore();
const busy = ref(false);
const status = ref<{ counts: Record<string, number>; hub: { clients: number; channels: string[]; sseClients: number }; dataDir: string; version: string } | null>(null);
const diagnostics = ref<{ allowOutbound: boolean; demoMode: boolean; dryRunAlways: boolean; connections: { serviceId: string; label: string; status: string; error?: string | null }[]; hint: string } | null>(null);
const newClient = reactive({ name: '', contactEmail: '', monthlyBudget: null as number | null });

const flags = reactive({ autoOptimizationEnabled: true, botProtectionEnabled: true, geoEnabled: true, reportEmail: '', telegramChatId: '' });
const env = computed(() => store.settings?.env ?? null);

onMounted(async () => {
  const settings = store.settings?.settings ?? {};
  Object.assign(flags, {
    autoOptimizationEnabled: settings.autoOptimizationEnabled !== false,
    botProtectionEnabled: settings.botProtectionEnabled !== false,
    geoEnabled: settings.geoEnabled !== false,
    reportEmail: String(settings.reportEmail ?? ''),
    telegramChatId: String(settings.telegramChatId ?? ''),
  });
  await Promise.all([refreshStatus(), refreshDiagnostics()]);
});

async function refreshStatus(): Promise<void> {
  status.value = await store.call(() => api.get('/api/system/status'), 'Не удалось получить статус системы');
}

async function refreshDiagnostics(): Promise<void> {
  diagnostics.value = await store.call(() => api.get('/api/diagnostics/network'), 'Не удалось получить диагностику');
}

async function saveFlags(): Promise<void> {
  busy.value = true;
  await store.call(
    () =>
      store.saveSettings({
        autoOptimizationEnabled: flags.autoOptimizationEnabled,
        botProtectionEnabled: flags.botProtectionEnabled,
        geoEnabled: flags.geoEnabled,
        reportEmail: flags.reportEmail || null,
        telegramChatId: flags.telegramChatId || null,
      }),
    'Не удалось сохранить настройки',
  );
  busy.value = false;
}

async function addClient(): Promise<void> {
  if (!newClient.name.trim()) {
    store.toast('warning', 'Укажите название клиента');
    return;
  }
  const created = await store.call(
    () => api.post('/api/clients', { name: newClient.name, contactEmail: newClient.contactEmail || null, monthlyBudget: newClient.monthlyBudget, status: 'active' }),
    'Не удалось создать клиента',
  );
  if (!created) return;
  Object.assign(newClient, { name: '', contactEmail: '', monthlyBudget: null });
  await store.reloadClients();
  store.toast('success', 'Клиент добавлен');
}

async function removeClient(id: string, name: string): Promise<void> {
  if (!window.confirm(`Удалить клиента «${name}»? Проекты и кампании останутся, но потеряют привязку.`)) return;
  await store.call(() => api.delete(`/api/clients/${id}`), 'Не удалось удалить клиента');
  await store.reloadClients();
}

function logHint(): void {
  store.toast(
    'info',
    'Где взять логи для BotShield',
    'nginx: /var/log/nginx/access.log · Apache: /var/log/apache2/access.log · Cloudflare: Analytics → Logpush. Файл можно загрузить в раздел BotShield.',
    9000,
  );
}
</script>

<template>
  <div class="grid cols-3">
    <div class="card tight"><div class="stat"><span class="label">Клиентов</span><span class="value">{{ status?.counts.clients ?? 0 }}</span></div></div>
    <div class="card tight"><div class="stat"><span class="label">Сайтов</span><span class="value">{{ status?.counts.sites ?? 0 }}</span></div></div>
    <div class="card tight"><div class="stat"><span class="label">Кампаний</span><span class="value">{{ status?.counts.campaigns ?? 0 }}</span></div></div>
    <div class="card tight"><div class="stat"><span class="label">Гипотез</span><span class="value">{{ status?.counts.hypotheses ?? 0 }}</span></div></div>
    <div class="card tight"><div class="stat"><span class="label">Отчётов</span><span class="value">{{ status?.counts.reports ?? 0 }}</span></div></div>
    <div class="card tight"><div class="stat"><span class="label">Правил</span><span class="value">{{ status?.counts.rules ?? 0 }}</span></div></div>
  </div>

  <div class="grid cols-2">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Флаги модулей</h3>
          <div class="sub">Влияют на фоновые процессы и подсказки в интерфейсе</div>
        </div>
      </div>

      <label class="checkbox" style="margin-bottom: 10px"><input v-model="flags.autoOptimizationEnabled" type="checkbox" /> Автооптимизация кампаний по cron</label>
      <label class="checkbox" style="margin-bottom: 10px"><input v-model="flags.botProtectionEnabled" type="checkbox" /> Защита от ботов (BotShield): ежедневные проверки и алерты</label>
      <label class="checkbox" style="margin-bottom: 10px"><input v-model="flags.geoEnabled" type="checkbox" /> GEO-модуль: региональные страницы и локальная выдача</label>

      <div class="grid cols-2">
        <div class="field">
          <label>E-mail для отчётов по умолчанию</label>
          <input v-model="flags.reportEmail" type="email" placeholder="reports@agency.ru" />
        </div>
        <div class="field">
          <label>Telegram chat id</label>
          <input v-model="flags.telegramChatId" type="text" placeholder="123456789" />
        </div>
      </div>

      <button class="btn primary" :disabled="busy" @click="saveFlags"><span v-if="busy" class="spinner" /><Icon v-else name="check" /> Сохранить</button>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>Окружение и безопасность</h3>
          <div class="sub">Переменные окружения MARK_* задаются при запуске сервера</div>
        </div>
        <button class="btn sm" @click="refreshStatus"><Icon name="refresh" /> Обновить</button>
      </div>

      <table>
        <tbody>
          <tr><td>Режим</td><td class="num"><StatusPill :status="env?.nodeEnv === 'production' ? 'pass' : 'info'" :label="env?.nodeEnv ?? 'development'" /></td></tr>
          <tr><td>Демо-режим (без внешних запросов)</td><td class="num"><StatusPill :status="env?.demoMode ? 'warn' : 'pass'" :label="env?.demoMode ? 'включён' : 'выключен'" /></td></tr>
          <tr><td>Исходящая сеть</td><td class="num"><StatusPill :status="env?.allowOutbound ? 'pass' : 'warn'" :label="env?.allowOutbound ? 'разрешена' : 'запрещена'" /></td></tr>
          <tr><td>Записи на сайты только в dry-run</td><td class="num"><StatusPill :status="env?.dryRunAlways ? 'warn' : 'pass'" :label="env?.dryRunAlways ? 'да (безопасно)' : 'нет (боевой режим)'" /></td></tr>
          <tr><td>Порт</td><td class="num mono">{{ env?.port }}</td></tr>
          <tr><td>Каталог данных</td><td class="num mono small">{{ env?.dataDir }}</td></tr>
          <tr><td>Подключения к WebSocket</td><td class="num">{{ status?.hub.clients ?? 0 }}</td></tr>
          <tr><td>Версия</td><td class="num mono">{{ status?.version ?? store.meta?.version }}</td></tr>
        </tbody>
      </table>

      <CodeBox
        label="Переменные окружения"
        :max-height="140"
        code="MARK_PORT=8787            # порт API
MARK_HOST=0.0.0.0          # интерфейс прослушивания
MARK_DEMO_MODE=0           # 1 — работать без внешних запросов
MARK_ALLOW_OUTBOUND=1      # 0 — запретить исходящие запросы
MARK_DRY_RUN=0             # 1 — никогда не писать на реальные сайты
MARK_DATA_DIR=./.data      # где хранить БД, отчёты и секреты
MARK_LOG_LEVEL=info        # debug | info | warn | error"
      />
    </div>
  </div>

  <div class="grid cols-2">
    <TelegramBotCard />

    <div class="card">
      <div class="card-head">
        <div>
          <h3>Диагностика подключений</h3>
          <div class="sub">{{ diagnostics?.hint }}</div>
        </div>
        <button class="btn sm" @click="refreshDiagnostics"><Icon name="refresh" /> Проверить</button>
      </div>

      <table v-if="diagnostics?.connections.length">
        <thead><tr><th>Сервис</th><th>Статус</th><th>Ошибка</th></tr></thead>
        <tbody>
          <tr v-for="connection in diagnostics.connections" :key="connection.serviceId">
            <td>{{ connection.label }}</td>
            <td><StatusPill :status="connection.status" /></td>
            <td class="small" style="color: #fca5a5">{{ connection.error ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="small muted">Подключений нет. Начните с раздела «Подключения».</div>

      <button class="btn sm" style="margin-top: 12px" @click="logHint"><Icon name="shield" /> Как получить логи для BotShield</button>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>Клиенты агентства</h3>
          <div class="sub">Каждому клиенту — свои проекты, кампании, гипотезы и отчёты</div>
        </div>
      </div>

      <table v-if="store.clients.length">
        <thead><tr><th>Клиент</th><th class="num">Бюджет/мес</th><th /></tr></thead>
        <tbody>
          <tr v-for="client in store.clients" :key="client.id">
            <td>
              <strong>{{ client.name }}</strong>
              <div class="small faint">{{ client.contactEmail ?? '—' }} · {{ client.contactPhone ?? '—' }}</div>
            </td>
            <td class="num">{{ client.monthlyBudget ? `${client.monthlyBudget.toLocaleString('ru-RU')} ₽` : '—' }}</td>
            <td class="num"><button class="btn ghost sm" @click="removeClient(client.id, client.name)"><Icon name="trash" /></button></td>
          </tr>
        </tbody>
      </table>

      <div class="grid cols-3" style="margin-top: 10px">
        <div class="field"><label>Новый клиент</label><input v-model="newClient.name" type="text" placeholder="Название" /></div>
        <div class="field"><label>E-mail</label><input v-model="newClient.contactEmail" type="email" /></div>
        <div class="field"><label>Бюджет/мес, ₽</label><input v-model.number="newClient.monthlyBudget" type="number" min="0" step="1000" /></div>
      </div>
      <button class="btn" @click="addClient"><Icon name="plus" /> Добавить клиента</button>
    </div>
  </div>
</template>
