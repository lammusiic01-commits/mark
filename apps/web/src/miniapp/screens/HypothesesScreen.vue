<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import BottomSheet from '../components/BottomSheet.vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import { tgApi } from '../api';
import { statusLabel, statusVariant, shortDate } from '../format';
import { select } from '../telegram';
import { toastErr, toastOk } from '../useToasts';

/**
 * Гипотезы роста.
 *
 * Движок собирает гипотезы из данных: аудита, ботов, GEO и рынка — и считает
 * приоритет по формуле ICE (влияние × уверенность × простота). Дальше человек
 * запускает тест, а итог считает статистика (z-тест), а не «на глаз».
 */

interface Hypothesis {
  id: string;
  title: string;
  statement: string;
  status: string;
  ice: { impact: number; confidence: number; ease: number; score: number };
  metric: string;
  expectedEffectPct: number;
  source: string;
  tags: string[];
  testPlan: Record<string, unknown>;
  createdAt: string;
}

interface ExperimentResult {
  status: string;
  control: { variant: string; rate: number; visitors: number; conversions: number };
  variant: { variant: string; rate: number; visitors: number; conversions: number };
  liftPercent: number;
  pValue: number;
  significant: boolean;
  sampleReached: boolean;
  requiredSample: number;
  recommendations: string[];
}

const items = ref<Hypothesis[]>([]);
const stats = ref<{ total: number; backlog: number; running: number; done: number } | null>(null);
const loading = ref(true);
const generating = ref(false);
const filter = ref<'all' | 'backlog' | 'running' | 'done'>('all');

const active = ref<Hypothesis | null>(null);
const result = ref<ExperimentResult | null>(null);
const resultBusy = ref(false);
const form = reactive({
  aVisitors: '',
  aConversions: '',
  bVisitors: '',
  bConversions: '',
});

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const response = await tgApi.get<{ items: Hypothesis[]; stats: typeof stats.value }>('/hypotheses');
    items.value = response.items;
    stats.value = response.stats;
  } catch (error) {
    toastErr('Не удалось загрузить гипотезы', error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function generate(): Promise<void> {
  generating.value = true;
  try {
    const response = await tgApi.post<{ drafts: number }>('/hypotheses/generate', { count: 6 });
    toastOk('Гипотезы собраны', `Новых: ${response.drafts} — из аудита, трафика и рынка`);
    await load();
  } catch (error) {
    toastErr('Не удалось собрать гипотезы', error instanceof Error ? error.message : String(error));
  } finally {
    generating.value = false;
  }
}

async function start(hypothesis: Hypothesis): Promise<void> {
  try {
    await tgApi.post(`/hypotheses/${hypothesis.id}/start`, {});
    toastOk('Тест запущен', hypothesis.title);
    await load();
  } catch (error) {
    toastErr('Не удалось запустить', error instanceof Error ? error.message : String(error));
  }
}

function openResult(hypothesis: Hypothesis): void {
  select();
  active.value = hypothesis;
  result.value = null;
  form.aVisitors = '';
  form.aConversions = '';
  form.bVisitors = '';
  form.bConversions = '';
}

async function evaluate(): Promise<void> {
  if (!active.value) return;
  const aVisitors = Number(form.aVisitors);
  const aConversions = Number(form.aConversions);
  const bVisitors = Number(form.bVisitors);
  const bConversions = Number(form.bConversions);
  if (!aVisitors || !bVisitors) {
    toastErr('Заполните данные', 'Укажите посетителей и конверсии по обоим вариантам');
    return;
  }
  resultBusy.value = true;
  try {
    const response = await tgApi.post<ExperimentResult>(`/hypotheses/${active.value.id}/result`, {
      observations: [
        { variant: 'control', visitors: aVisitors, conversions: aConversions },
        { variant: 'variant', visitors: bVisitors, conversions: bConversions },
      ],
    });
    result.value = response;
    await load();
  } catch (error) {
    toastErr('Не удалось посчитать результат', error instanceof Error ? error.message : String(error));
  } finally {
    resultBusy.value = false;
  }
}

const filtered = computed(() => (filter.value === 'all' ? items.value : items.value.filter((item) => item.status === filter.value)));

const resultBadge = computed(() => {
  if (!result.value) return '';
  if (result.value.status === 'winner') return 'badge-live';
  if (result.value.status === 'no_difference') return 'badge-warn';
  return 'badge-accent';
});

const resultTitle = computed(() => {
  if (!result.value) return '';
  if (result.value.status === 'winner') return 'Вариант побеждает';
  if (result.value.status === 'no_difference') return 'Разницы нет';
  if (result.value.status === 'insufficient_data') return 'Мало данных';
  return 'Тест продолжается';
});

const iceColor = (score: number): string => (score >= 70 ? 'var(--green)' : score >= 45 ? 'var(--orange)' : 'var(--text-secondary)');
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">Что тестируем дальше</div>
        <h1 class="mini-title">Гипотезы</h1>
      </div>
      <GlassButton size="sm" variant="primary" :loading="generating" @click="generate">Собрать</GlassButton>
    </header>

    <LoaderBlock v-if="loading" :rows="3" label="Загружаем гипотезы" />

    <template v-else>
      <div v-if="stats" class="mini-grid-2">
        <div class="metric">
          <span class="metric-label">В очереди</span>
          <span class="metric-value">{{ stats.backlog }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Идут тесты</span>
          <span class="metric-value" style="color: var(--accent)">{{ stats.running }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Подтверждено</span>
          <span class="metric-value" style="color: var(--green)">{{ stats.done }}</span>
        </div>
        <div class="metric">
          <span class="metric-label">Всего</span>
          <span class="metric-value">{{ stats.total }}</span>
        </div>
      </div>

      <div class="tabs" style="margin: 16px 0 12px">
        <button :class="{ active: filter === 'all' }" @click="filter = 'all'">Все</button>
        <button :class="{ active: filter === 'backlog' }" @click="filter = 'backlog'">Очередь</button>
        <button :class="{ active: filter === 'running' }" @click="filter = 'running'">В работе</button>
        <button :class="{ active: filter === 'done' }" @click="filter = 'done'">Итоги</button>
      </div>

      <div v-if="!filtered.length" class="glass glass-pad">
        <div class="empty">
          <div class="empty-icon">🧪</div>
          <div style="font-weight: 600">Гипотез пока нет</div>
          <div class="mini-hint">Нажмите «Собрать» — движок предложит идеи на основе аудита сайта, трафика и рынка.</div>
        </div>
      </div>

      <GlassCard v-for="hypothesis in filtered" :key="hypothesis.id" style="margin-bottom: 12px">
        <div class="mini-row-between">
          <div style="flex: 1">
            <div style="font-weight: 600">{{ hypothesis.title }}</div>
            <div class="mini-hint" style="margin-top: 4px">{{ hypothesis.statement }}</div>
          </div>
          <div style="text-align: center; min-width: 54px">
            <div style="font-size: 22px; font-weight: 700" :style="{ color: iceColor(hypothesis.ice.score) }">{{ Math.round(hypothesis.ice.score) }}</div>
            <div class="mini-hint">ICE</div>
          </div>
        </div>
        <div class="mini-row" style="gap: 6px; margin-top: 10px; flex-wrap: wrap">
          <span class="badge" :class="statusVariant(hypothesis.status)">{{ statusLabel(hypothesis.status) }}</span>
          <span class="badge">{{ hypothesis.metric }}</span>
          <span class="badge badge-accent">+{{ hypothesis.expectedEffectPct }}%</span>
          <span class="badge">{{ shortDate(hypothesis.createdAt) }}</span>
        </div>
        <div class="mini-row" style="gap: 8px; margin-top: 12px">
          <GlassButton v-if="hypothesis.status !== 'running' && hypothesis.status !== 'done'" size="sm" variant="primary" @click="start(hypothesis)">Запустить</GlassButton>
          <GlassButton size="sm" @click="openResult(hypothesis)">Итоги теста</GlassButton>
        </div>
      </GlassCard>
    </template>
  </div>

  <BottomSheet :open="Boolean(active)" @close="active = null">
    <template v-if="active">
      <h3 class="mini-title-sm">{{ active.title }}</h3>
      <p class="mini-hint" style="margin: 8px 0 14px">{{ active.statement }}</p>

      <div class="glass glass-tight" style="margin-bottom: 14px">
        <div class="mini-row-between"><span class="mini-muted">Метрика успеха</span><b>{{ active.metric }}</b></div>
        <div class="mini-row-between"><span class="mini-muted">Ожидаемый эффект</span><b>+{{ active.expectedEffectPct }}%</b></div>
        <div class="mini-row-between"><span class="mini-muted">Минимальная выборка</span><b>≈ {{ active.testPlan?.requiredSample ?? '—' }}</b></div>
      </div>

      <div class="mini-section-title" style="margin-top: 0">Данные теста</div>
      <div class="glass glass-pad mini-stack">
        <div class="mini-hint">Вариант A (как было)</div>
        <div class="mini-grid-2">
          <label class="field">
            <span class="field-label">Посетителей</span>
            <input v-model="form.aVisitors" class="input" inputmode="numeric" placeholder="1200" />
          </label>
          <label class="field">
            <span class="field-label">Конверсий</span>
            <input v-model="form.aConversions" class="input" inputmode="numeric" placeholder="36" />
          </label>
        </div>
        <div class="mini-hint" style="margin-top: 8px">Вариант B (что тестируем)</div>
        <div class="mini-grid-2">
          <label class="field">
            <span class="field-label">Посетителей</span>
            <input v-model="form.bVisitors" class="input" inputmode="numeric" placeholder="1250" />
          </label>
          <label class="field">
            <span class="field-label">Конверсий</span>
            <input v-model="form.bConversions" class="input" inputmode="numeric" placeholder="52" />
          </label>
        </div>
        <GlassButton variant="primary" block :loading="resultBusy" @click="evaluate">Посчитать результат</GlassButton>
      </div>

      <template v-if="result">
        <div class="glass glass-pad" style="margin-top: 14px">
          <div class="mini-row-between">
            <b>{{ resultTitle }}</b>
            <span class="badge" :class="resultBadge">{{ result.significant ? 'значимо' : 'не значимо' }}</span>
          </div>
          <div class="mini-grid-2" style="margin-top: 12px">
            <div class="metric">
              <span class="metric-label">Конверсия A</span>
              <span class="metric-value" style="font-size: 18px">{{ (result.control.rate * 100).toFixed(2) }}%</span>
            </div>
            <div class="metric">
              <span class="metric-label">Конверсия B</span>
              <span class="metric-value" style="font-size: 18px">{{ (result.variant.rate * 100).toFixed(2) }}%</span>
            </div>
          </div>
          <div class="mini-hint" style="margin-top: 10px">
            Прирост {{ result.liftPercent }}% · p-value {{ result.pValue }} · выборка {{ result.sampleReached ? 'достаточная' : 'мала' }}
          </div>
          <ul class="mini-hint" style="padding-left: 18px; margin: 10px 0 0; line-height: 1.6">
            <li v-for="tip in result.recommendations" :key="tip">{{ tip }}</li>
          </ul>
        </div>
      </template>

      <div class="sheet-actions">
        <GlassButton block @click="active = null">Закрыть</GlassButton>
      </div>
    </template>
  </BottomSheet>
</template>
