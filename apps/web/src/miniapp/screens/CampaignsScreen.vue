<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import BottomSheet from '../components/BottomSheet.vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import Sparkline from '../components/Sparkline.vue';
import { tgApi, type MiniCampaign } from '../api';
import { money, num, percent, statusLabel, statusVariant } from '../format';
import { select } from '../telegram';
import { toastErr, toastOk } from '../useToasts';

/**
 * Кампании и ставки.
 *
 * Список показывает, что происходит в рекламе, а шторка кампании — рекомендации
 * движка по каждой фразе: поднять, опустить, остановить. Кнопка «Применить»
 * отправляет изменения в аккаунт, если подключён боевой токен, иначе показывает
 * подготовленный план (безопасный режим — как требует промт).
 */

interface BidSuggestion {
  keyword: string;
  currentBid: number;
  suggestedBid: number;
  deltaPercent: number;
  action: 'raise' | 'lower' | 'pause' | 'keep';
  reason: string;
  confidence: number;
}

const campaigns = ref<MiniCampaign[]>([]);
const totals = ref<{ clicks: number; cost: number; conversions: number; cpa: number } | null>(null);
const loading = ref(true);
const busy = ref(false);
const filter = ref<'all' | 'active' | 'paused'>('all');

const active = ref<MiniCampaign | null>(null);
const bids = ref<BidSuggestion[]>([]);
const bidSummary = ref<{ raise: number; lower: number; pause: number; keep: number; potentialSaving: number } | null>(null);
const bidsBusy = ref(false);
const applyMessage = ref<string | null>(null);
const targetCpa = ref('');

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const response = await tgApi.get<{ items: MiniCampaign[]; totals: typeof totals.value }>('/campaigns');
    campaigns.value = response.items;
    totals.value = response.totals;
  } catch (error) {
    toastErr('Не удалось загрузить кампании', error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

const filtered = computed(() => (filter.value === 'all' ? campaigns.value : campaigns.value.filter((item) => item.status === filter.value)));

async function openCampaign(campaign: MiniCampaign): Promise<void> {
  select();
  active.value = campaign;
  bids.value = [];
  bidSummary.value = null;
  applyMessage.value = null;
  bidsBusy.value = true;
  try {
    const query = targetCpa.value ? `?targetCpa=${encodeURIComponent(targetCpa.value)}` : '';
    const response = await tgApi.get<{ suggestions: BidSuggestion[]; summary: typeof bidSummary.value }>(`/campaigns/${campaign.id}/bids${query}`);
    bids.value = response.suggestions;
    bidSummary.value = response.summary;
  } catch (error) {
    toastErr('Не удалось получить рекомендации', error instanceof Error ? error.message : String(error));
  } finally {
    bidsBusy.value = false;
  }
}

async function applyBids(): Promise<void> {
  if (!active.value) return;
  busy.value = true;
  try {
    const response = await tgApi.post<{ mode: string; applied: number; planned: number; message: string }>(`/campaigns/${active.value.id}/apply-bids`, {
      targetCpa: targetCpa.value ? Number(targetCpa.value) : undefined,
    });
    applyMessage.value = response.message;
    if (response.mode === 'queued') toastOk('Изменения отправлены', `Фраз к правке: ${response.planned}`);
    else toastOk('План готов', response.message);
  } catch (error) {
    toastErr('Не удалось применить', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

const actionLabel: Record<BidSuggestion['action'], string> = {
  raise: 'поднять',
  lower: 'опустить',
  pause: 'остановить',
  keep: 'оставить',
};

const actionVariant = (action: BidSuggestion['action']): string =>
  action === 'raise' ? 'badge-live' : action === 'lower' ? 'badge-warn' : action === 'pause' ? 'badge-danger' : '';
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">Рекламные кампании</div>
        <h1 class="mini-title">Кампании</h1>
      </div>
      <GlassButton size="sm" @click="load">Обновить</GlassButton>
    </header>

    <LoaderBlock v-if="loading" :rows="3" label="Загружаем кампании" />

    <template v-else>
      <div v-if="totals" class="mini-grid-2">
        <div class="metric">
          <span class="metric-label">Клики</span>
          <span class="metric-value">{{ num(totals.clicks) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Расход</span>
          <span class="metric-value">{{ money(totals.cost, { compact: true }) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Конверсии</span>
          <span class="metric-value">{{ num(totals.conversions) }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">CPA</span>
          <span class="metric-value">{{ money(totals.cpa) }}</span>
        </div>
      </div>

      <div class="tabs" style="margin: 16px 0 12px">
        <button :class="{ active: filter === 'all' }" @click="filter = 'all'">Все</button>
        <button :class="{ active: filter === 'active' }" @click="filter = 'active'">Работают</button>
        <button :class="{ active: filter === 'paused' }" @click="filter = 'paused'">Пауза</button>
      </div>

      <div v-if="!filtered.length" class="glass glass-pad">
        <div class="empty">
          <div class="empty-icon">🎯</div>
          <div style="font-weight: 600">Кампаний нет</div>
          <div class="mini-hint">Подключите Яндекс Директ в разделе «Подключения» — кампании подтянутся сами.</div>
        </div>
      </div>

      <GlassCard v-for="campaign in filtered" :key="campaign.id" style="margin-bottom: 12px">
        <div class="mini-row-between">
          <div style="flex: 1; min-width: 0">
            <div style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ campaign.name }}</div>
            <div class="mini-row" style="gap: 6px; margin-top: 6px; flex-wrap: wrap">
              <span class="badge" :class="statusVariant(campaign.status)">{{ statusLabel(campaign.status) }}</span>
              <span class="badge">{{ campaign.strategy }}</span>
            </div>
          </div>
        </div>
        <Sparkline :points="(campaign.trend ?? []).map((point) => point.value)" :height="64" :color="campaign.status === 'active' ? '#0A84FF' : 'rgba(235,235,245,0.4)'" />
        <div class="mini-row-between" style="margin-top: 8px; font-size: 13px">
          <span class="mini-hint">{{ num(campaign.metrics.clicks) }} кликов · CTR {{ percent(campaign.metrics.ctr) }}</span>
          <span><b>{{ money(campaign.metrics.cost) }}</b> · CPA {{ money(campaign.metrics.cpa) }}</span>
        </div>
        <GlassButton size="sm" variant="primary" block style="margin-top: 12px" @click="openCampaign(campaign)">Ставки и рекомендации</GlassButton>
      </GlassCard>
    </template>
  </div>

  <BottomSheet :open="Boolean(active)" @close="active = null">
    <template v-if="active">
      <h3 class="mini-title-sm">{{ active.name }}</h3>
      <div class="mini-row" style="gap: 6px; margin: 8px 0 14px; flex-wrap: wrap">
        <span class="badge" :class="statusVariant(active.status)">{{ statusLabel(active.status) }}</span>
        <span class="badge">бюджет {{ money(active.dailyBudget) }}/день</span>
        <span class="badge">CPA {{ money(active.metrics.cpa) }}</span>
      </div>

      <label class="field">
        <span class="field-label">Целевой CPA, ₽ (не обязательно)</span>
        <div class="mini-row">
          <input v-model="targetCpa" class="input" inputmode="numeric" placeholder="например 1500" />
          <GlassButton size="sm" @click="openCampaign(active)">Пересчитать</GlassButton>
        </div>
      </label>

      <LoaderBlock v-if="bidsBusy" :rows="2" label="Считаем ставки по статистике" />

      <template v-else>
        <div v-if="bidSummary" class="mini-grid-2" style="margin: 14px 0">
          <div class="metric">
            <span class="metric-label">Поднять</span>
            <span class="metric-value" style="color: var(--green)">{{ bidSummary.raise }}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Опустить</span>
            <span class="metric-value" style="color: var(--orange)">{{ bidSummary.lower }}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Остановить</span>
            <span class="metric-value" style="color: var(--red)">{{ bidSummary.pause }}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Экономия/мес</span>
            <span class="metric-value" style="font-size: 18px">{{ money(bidSummary.potentialSaving, { compact: true }) }}</span>
          </div>
        </div>

        <div class="mini-stack" style="max-height: 40vh; overflow-y: auto">
          <div v-for="bid in bids.filter((item) => item.action !== 'keep').slice(0, 25)" :key="bid.keyword" class="glass glass-tight">
            <div class="mini-row-between">
              <span style="font-size: 13px; font-weight: 600">{{ bid.keyword }}</span>
              <span class="badge" :class="actionVariant(bid.action)">{{ actionLabel[bid.action] }}</span>
            </div>
            <div class="mini-hint" style="margin-top: 4px">
              {{ money(bid.currentBid) }} → <b>{{ money(bid.suggestedBid) }}</b> ({{ bid.deltaPercent > 0 ? '+' : '' }}{{ bid.deltaPercent }}%)
            </div>
            <div class="mini-hint" style="margin-top: 3px">{{ bid.reason }}</div>
          </div>
          <div v-if="!bids.filter((item) => item.action !== 'keep').length" class="mini-hint" style="text-align: center; padding: 12px">
            Все фразы в норме — менять ничего не нужно.
          </div>
        </div>

        <div v-if="applyMessage" class="glass glass-tight mini-hint" style="margin-top: 12px">{{ applyMessage }}</div>

        <div class="sheet-actions">
          <GlassButton @click="active = null">Закрыть</GlassButton>
          <GlassButton variant="primary" :loading="busy" @click="applyBids">Применить</GlassButton>
        </div>
      </template>
    </template>
  </BottomSheet>
</template>
