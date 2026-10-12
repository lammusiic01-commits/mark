<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { BidSuggestion, Campaign } from '@mark/shared';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import Modal from '@/components/Modal.vue';
import ChartBox from '@/components/ChartBox.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';
import type { EChartsOption } from 'echarts';

/**
 * Кампании: список с метриками, рекомендации по ставкам, импорт из Директа
 * и применение изменений (с защитой: без боевого токена — только предпросмотр).
 */

const store = useAppStore();
const items = ref<(Campaign & { warnings?: { code: string; message: string; severity: string }[] })[]>([]);
const totals = ref<{ cost: number; clicks: number; conversions: number; impressions: number; cpa: number; ctr: number } | null>(null);
const busy = ref(false);
const selected = ref<Campaign | null>(null);
interface BidsPayload {
  campaign: string;
  suggestions: BidSuggestion[];
  summary: { raise: number; lower: number; pause: number; keep: number; potentialSaving: number };
}

const bids = ref<BidsPayload | null>(null);
const applyResult = ref<{ applied: number; planned: number; mode: string; message: string } | null>(null);
const showImport = ref(false);
const importForm = reactive({ accountId: '', onlyActive: true });

onMounted(load);

async function load(): Promise<void> {
  const payload = await store.call(
    () => api.get<{ items: typeof items.value; totals: typeof totals.value }>(`/api/campaigns${store.activeClientId ? `?clientId=${store.activeClientId}` : ''}`),
    'Не удалось загрузить кампании',
  );
  if (!payload) return;
  items.value = payload.items;
  totals.value = payload.totals;
}

async function sync(): Promise<void> {
  busy.value = true;
  const result = await store.call(() => api.post<{ synced: number; source: string; error?: string }>('/api/campaigns/sync'), 'Синхронизация не удалась');
  busy.value = false;
  if (result) {
    store.toast(result.error ? 'warning' : 'success', `Синхронизировано кампаний: ${result.synced}`, result.error ?? `Источник: ${result.source === 'api' ? 'Яндекс.Директ API' : 'расчётная модель'}`);
    await load();
  }
}

async function importCampaigns(): Promise<void> {
  busy.value = true;
  const result = await store.call(
    () => api.post<{ imported: number; updated: number; message?: string }>('/api/campaigns/import', { accountId: importForm.accountId || null, onlyActive: importForm.onlyActive }),
    'Импорт не удался',
  );
  busy.value = false;
  if (result) {
    showImport.value = false;
    store.toast('success', `Импортировано: ${result.imported}, обновлено: ${result.updated}`, result.message ?? 'Кампании подтянуты из аккаунта.');
    await load();
  }
}

async function openBids(campaign: Campaign): Promise<void> {
  selected.value = campaign;
  bids.value = null;
  applyResult.value = null;
  bids.value = await store.call(() => api.get<BidsPayload>(`/api/campaigns/${campaign.id}/bids`), 'Не удалось получить рекомендации');
}

async function applyBids(): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  const result = await store.call(
    () => api.post<{ applied: number; planned: number; mode: string; message: string }>(`/api/campaigns/${selected.value!.id}/apply-bids`, {}),
    'Не удалось применить ставки',
  );
  busy.value = false;
  if (!result) return;
  applyResult.value = result;
  store.toast(result.applied ? 'success' : 'info', result.applied ? `Ставки применены: ${result.applied}` : 'Изменения подготовлены', result.message);
}

const spendOption = computed<EChartsOption>(() => {
  const top = [...items.value].sort((a, b) => (b.metrics30d?.cost ?? 0) - (a.metrics30d?.cost ?? 0)).slice(0, 10);
  return {
    legend: { show: false },
    xAxis: { type: 'category', data: top.map((item) => item.name.slice(0, 18)), axisLabel: { interval: 0, rotate: 25 }, axisLine: { lineStyle: { color: '#22304f' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
    series: [{ name: 'Расход 30 дн., ₽', type: 'bar', data: top.map((item) => Math.round(item.metrics30d?.cost ?? 0)) }],
  };
});
</script>

<template>
  <div class="grid cols-4">
    <div class="card tight"><div class="stat"><span class="label">Расход 30 дней</span><span class="value">{{ Math.round(totals?.cost ?? 0).toLocaleString('ru-RU') }} ₽</span></div></div>
    <div class="card tight"><div class="stat"><span class="label">Клики</span><span class="value">{{ Math.round(totals?.clicks ?? 0).toLocaleString('ru-RU') }}</span></div></div>
    <div class="card tight"><div class="stat"><span class="label">Конверсии</span><span class="value">{{ Math.round(totals?.conversions ?? 0).toLocaleString('ru-RU') }}</span></div></div>
    <div class="card tight"><div class="stat"><span class="label">CPA</span><span class="value">{{ Math.round(totals?.cpa ?? 0).toLocaleString('ru-RU') }} ₽</span></div></div>
  </div>

  <div class="card">
    <div class="card-head">
      <div>
        <h3>Кампании</h3>
        <div class="sub">Яндекс.Директ, Google Ads, VK и SEO-проекты — в одном списке. Рекомендации по ставкам учитывают CPA, CTR и бюджет.</div>
      </div>
      <div class="row">
        <button class="btn sm" :disabled="busy" @click="sync"><Icon name="refresh" /> Синхронизировать</button>
        <button class="btn sm" @click="showImport = true"><Icon name="download" /> Импорт из Директа</button>
      </div>
    </div>

    <ChartBox v-if="items.length" :option="spendOption" :height="220" />

    <table v-if="items.length" style="margin-top: 12px">
      <thead>
        <tr>
          <th>Кампания</th>
          <th>Статус</th>
          <th class="num">Бюджет/день</th>
          <th class="num">Расход 30д</th>
          <th class="num">Клики</th>
          <th class="num">CTR</th>
          <th class="num">Конверсии</th>
          <th class="num">CPA</th>
          <th>Предупреждения</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="campaign in items" :key="campaign.id">
          <td>
            <strong>{{ campaign.name }}</strong>
            <div class="small faint">{{ campaign.channel }} · {{ campaign.strategy }}</div>
          </td>
          <td><StatusPill :status="campaign.status" /></td>
          <td class="num">{{ campaign.dailyBudget.toLocaleString('ru-RU') }} ₽</td>
          <td class="num">{{ Math.round(campaign.metrics30d?.cost ?? 0).toLocaleString('ru-RU') }} ₽</td>
          <td class="num">{{ (campaign.metrics30d?.clicks ?? 0).toLocaleString('ru-RU') }}</td>
          <td class="num">{{ (campaign.metrics30d?.ctr ?? 0).toFixed(1) }}%</td>
          <td class="num">{{ (campaign.metrics30d?.conversions ?? 0).toLocaleString('ru-RU') }}</td>
          <td class="num">{{ Math.round(campaign.metrics30d?.cpa ?? 0).toLocaleString('ru-RU') }} ₽</td>
          <td class="small">
            <span v-for="warning in campaign.warnings ?? []" :key="warning.code" class="pill" :class="warning.severity === 'critical' || warning.severity === 'high' ? 'danger' : 'warn'" style="margin-right: 4px">
              {{ warning.message }}
            </span>
          </td>
          <td class="num">
            <button class="btn sm" @click="openBids(campaign)"><Icon name="wand" /> Ставки</button>
          </td>
        </tr>
      </tbody>
    </table>

    <EmptyState v-else title="Кампаний нет" message="Импортируйте кампании из подключённого Яндекс.Директа или создайте черновик вручную." icon="target" />
  </div>

  <Modal v-if="selected" :title="`Ставки: ${selected.name}`" subtitle="MARK сравнивает факт с целевым CPA и предлагает изменения. Без боевого OAuth-токена изменения не отправляются — только предпросмотр." @close="selected = null">
    <div v-if="bids" class="grid" style="gap: 12px">
      <div class="row">
        <div class="stat"><span class="label">Рекомендаций</span><span class="value">{{ bids.suggestions.length }}</span></div>
        <div class="stat"><span class="label">Потенциальная экономия</span><span class="value">{{ Math.round(bids.summary.potentialSaving).toLocaleString('ru-RU') }} ₽</span></div>
        <div class="stat"><span class="label">Снизить / поднять</span><span class="value" style="font-size: 18px">{{ bids.summary.lower }} / {{ bids.summary.raise }}</span></div>
      </div>

      <table v-if="bids.suggestions.length">
        <thead><tr><th>Фраза</th><th class="num">Текущая</th><th class="num">Рекомендуемая</th><th class="num">Δ</th><th>Действие</th><th>Причина</th></tr></thead>
        <tbody>
          <tr v-for="suggestion in bids.suggestions.slice(0, 25)" :key="suggestion.keyword">
            <td>{{ suggestion.keyword }}</td>
            <td class="num">{{ suggestion.currentBid.toFixed(2) }} ₽</td>
            <td class="num">{{ suggestion.suggestedBid.toFixed(2) }} ₽</td>
            <td class="num" :style="{ color: suggestion.deltaPercent > 0 ? '#86efac' : '#fca5a5' }">{{ suggestion.deltaPercent > 0 ? '+' : '' }}{{ suggestion.deltaPercent }}%</td>
            <td><StatusPill :status="suggestion.action === 'raise' ? 'pass' : suggestion.action === 'lower' ? 'warn' : 'neutral'" :label="suggestion.action" /></td>
            <td class="small muted">{{ suggestion.reason }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="small muted">Пока нечего менять: ставки соответствуют целям.</div>

      <div v-if="applyResult" class="card tight">
        <div class="row between">
          <strong>{{ applyResult.mode === 'live' ? 'Ставки отправлены' : 'Только предпросмотр' }}</strong>
          <span class="pill" :class="applyResult.applied ? 'success' : 'warn'">{{ applyResult.applied }} / {{ applyResult.planned }}</span>
        </div>
        <div class="small muted">{{ applyResult.message }}</div>
      </div>
    </div>
    <div v-else class="small muted">Считаю рекомендации…</div>

    <template #footer>
      <button class="btn ghost" @click="selected = null">Закрыть</button>
      <button class="btn primary" :disabled="busy" @click="applyBids"><Icon name="bolt" /> Применить ставки</button>
    </template>
  </Modal>

  <Modal v-if="showImport" size="sm" title="Импорт кампаний" subtitle="Кампании подтянутся из подключённого аккаунта Яндекс.Директа" @close="showImport = false">
    <div class="field">
      <label>Подключение</label>
      <select v-model="importForm.accountId">
        <option value="">— выбрать автоматически —</option>
      </select>
      <div class="hint">Убедитесь, что в разделе «Подключения» есть действующий токен Яндекс.Директа.</div>
    </div>
    <label class="checkbox"><input v-model="importForm.onlyActive" type="checkbox" /> Импортировать только активные кампании</label>
    <template #footer>
      <button class="btn ghost" @click="showImport = false">Отмена</button>
      <button class="btn primary" :disabled="busy" @click="importCampaigns"><span v-if="busy" class="spinner" /><Icon v-else name="download" /> Импортировать</button>
    </template>
  </Modal>
</template>
