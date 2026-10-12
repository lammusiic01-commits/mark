<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { Hypothesis, HypothesisStatus } from '@mark/shared';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import Modal from '@/components/Modal.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';

/**
 * Гипотезы роста: библиотека + генерация из аудита/BotShield/GEO/Market,
 * запуск теста (создаётся эксперимент) и статистическая оценка результата.
 */

const store = useAppStore();
const items = ref<Hypothesis[]>([]);
const filter = ref<'all' | HypothesisStatus>('all');
const busy = ref(false);
const showGenerate = ref(false);
const showEvaluate = ref(false);
const evaluateTarget = ref<Hypothesis | null>(null);
const generateForm = reactive({ count: 8, niche: '', siteName: '' });
const observations = reactive([
  { variant: 'control', visitors: 1200, conversions: 36 },
  { variant: 'variant', visitors: 1180, conversions: 52 },
]);
interface ExperimentResult {
  status: 'winner' | 'loser' | 'no_difference' | 'insufficient_data';
  liftPercent: number;
  pValue: number;
  significant: boolean;
  sampleReached: boolean;
  requiredSample: number;
  recommendations: string[];
}

const evaluation = ref<ExperimentResult | null>(null);

onMounted(load);

async function load(): Promise<void> {
  const payload = await store.call(() => api.get<{ items: Hypothesis[] }>('/api/hypotheses'), 'Не удалось загрузить гипотезы');
  items.value = payload?.items ?? [];
}

const visible = computed(() => (filter.value === 'all' ? items.value : items.value.filter((item) => item.status === filter.value)));
const counts = computed(() => ({
  all: items.value.length,
  backlog: items.value.filter((item) => item.status === 'backlog').length,
  running: items.value.filter((item) => item.status === 'running').length,
  done: items.value.filter((item) => item.status === 'done').length,
  rejected: items.value.filter((item) => item.status === 'rejected').length,
}));

function tone(severity: number): string {
  return severity >= 60 ? 'pass' : severity >= 40 ? 'info' : 'neutral';
}

async function generate(): Promise<void> {
  busy.value = true;
  const created = await store.call(
    () =>
      api.post<Hypothesis[]>('/api/hypotheses/generate', {
        count: generateForm.count,
        niche: generateForm.niche || undefined,
        siteName: generateForm.siteName || undefined,
      }),
    'Не удалось сгенерировать гипотезы',
  );
  busy.value = false;
  if (!created) return;
  showGenerate.value = false;
  await load();
  store.toast('success', `Добавлено гипотез: ${created.length}`, 'Каждая — с планом теста, минимальной выборкой и критерием успеха.');
}

async function startTest(hypothesis: Hypothesis): Promise<void> {
  const updated = await store.call(() => api.post<Hypothesis>(`/api/hypotheses/${hypothesis.id}/start-test`, { trafficSource: 'Яндекс.Метрика / эксперименты' }), 'Не удалось запустить тест');
  if (!updated) return;
  await load();
  store.toast('success', 'Тест запущен', `Гипотеза «${hypothesis.title}» переведена в работу. Соберите данные и внесите результат.`);
}

async function evaluate(): Promise<void> {
  if (!evaluateTarget.value) return;
  busy.value = true;
  const result = await store.call(
    () => api.post<ExperimentResult>(`/api/hypotheses/${evaluateTarget.value!.id}/evaluate`, { observations, baselineRate: 0.03 }),
    'Не удалось оценить эксперимент',
  );
  busy.value = false;
  if (!result) return;
  evaluation.value = result;
  store.toast(result.status === 'winner' ? 'success' : 'info', `Результат: ${result.status}`, `Прирост ${result.liftPercent}%, p = ${result.pValue}. ${result.recommendations[0] ?? ''}`);
  await load();
}

async function remove(hypothesis: Hypothesis): Promise<void> {
  if (!window.confirm(`Удалить гипотезу «${hypothesis.title}»?`)) return;
  await store.call(() => api.delete(`/api/hypotheses/${hypothesis.id}`), 'Не удалось удалить гипотезу');
  await load();
}
</script>

<template>
  <div class="card tight">
    <div class="row between">
      <div class="row">
        <button class="chip" :class="{ active: filter === 'all' }" @click="filter = 'all'">Все ({{ counts.all }})</button>
        <button class="chip" :class="{ active: filter === 'backlog' }" @click="filter = 'backlog'">Бэклог ({{ counts.backlog }})</button>
        <button class="chip" :class="{ active: filter === 'running' }" @click="filter = 'running'">В работе ({{ counts.running }})</button>
        <button class="chip" :class="{ active: filter === 'done' }" @click="filter = 'done'">Подтверждены ({{ counts.done }})</button>
        <button class="chip" :class="{ active: filter === 'rejected' }" @click="filter = 'rejected'">Отклонены ({{ counts.rejected }})</button>
      </div>
      <button class="btn primary sm" @click="showGenerate = true"><Icon name="wand" /> Сгенерировать из данных</button>
    </div>
  </div>

  <div v-if="visible.length" class="grid cols-3">
    <div v-for="hypothesis in visible" :key="hypothesis.id" class="hypothesis-card" :class="`status-${hypothesis.status}`">
      <div class="row between">
        <StatusPill :status="hypothesis.status" />
        <span class="pill" :class="tone(hypothesis.ice)">ICE {{ hypothesis.ice }}</span>
      </div>

      <div>
        <h3 style="margin-bottom: 4px">{{ hypothesis.title }}</h3>
        <div class="small muted">{{ hypothesis.statement }}</div>
      </div>

      <div class="row small">
        <span class="chip">{{ hypothesis.metric }}</span>
        <span class="chip">+{{ hypothesis.expectedEffectPct }}% ожидается</span>
        <span class="chip">уверенность {{ hypothesis.confidence }}/5</span>
        <span class="chip">источник: {{ hypothesis.source }}</span>
      </div>

      <div class="small faint">
        План: {{ hypothesis.testPlan.design === 'ab' ? 'A/B' : hypothesis.testPlan.design }} · выборка {{ hypothesis.testPlan.minSamplePerVariant.toLocaleString('ru-RU') }} на вариант ·
        {{ hypothesis.testPlan.durationDays }} дн.
      </div>
      <div class="small faint">Критерий: {{ hypothesis.testPlan.successCriteria }}</div>

      <div class="row" style="gap: 8px">
        <button v-if="hypothesis.status === 'backlog'" class="btn primary sm" @click="startTest(hypothesis)"><Icon name="play" /> Запустить тест</button>
        <button v-if="hypothesis.status === 'running'" class="btn sm" @click="evaluateTarget = hypothesis; showEvaluate = true; evaluation = null"><Icon name="chart" /> Внести результат</button>
        <button class="btn ghost sm" @click="remove(hypothesis)"><Icon name="trash" /></button>
      </div>
    </div>
  </div>

  <EmptyState v-else title="Гипотез нет" message="Сгенерируйте гипотезы из аудита, BotShield, GEO-анализа и Market Analyzer — MARK предложит план теста для каждой." icon="flask">
    <button class="btn primary" @click="showGenerate = true"><Icon name="wand" /> Сгенерировать</button>
  </EmptyState>

  <Modal v-if="showGenerate" title="Генерация гипотез" subtitle="Источники: последние аудиты, сканы BotShield, GEO-анализ, Market Analyzer и библиотека приёмов" @close="showGenerate = false">
    <div class="grid cols-3">
      <div class="field">
        <label>Сколько гипотез</label>
        <input v-model.number="generateForm.count" type="number" min="1" max="30" />
      </div>
      <div class="field">
        <label>Ниша</label>
        <input v-model="generateForm.niche" type="text" placeholder="ремонт квартир" />
      </div>
      <div class="field">
        <label>Название сайта</label>
        <input v-model="generateForm.siteName" type="text" placeholder="СтройМастер" />
      </div>
    </div>
    <div class="small muted">Гипотезы создаются со статусом «бэклог»: запускайте тест, когда готовы, и вносите результаты для статистической оценки.</div>
    <template #footer>
      <button class="btn ghost" @click="showGenerate = false">Отмена</button>
      <button class="btn primary" :disabled="busy" @click="generate"><span v-if="busy" class="spinner" /><Icon v-else name="wand" /> Сгенерировать</button>
    </template>
  </Modal>

  <Modal
    v-if="showEvaluate && evaluateTarget"
    title="Результаты эксперимента"
    :subtitle="evaluateTarget.title"
    @close="showEvaluate = false"
  >
    <div class="grid cols-2">
      <div class="card tight">
        <strong class="small">Контроль (A)</strong>
        <div class="field"><label>Посетители</label><input v-model.number="observations[0]!.visitors" type="number" min="0" /></div>
        <div class="field"><label>Конверсии</label><input v-model.number="observations[0]!.conversions" type="number" min="0" /></div>
      </div>
      <div class="card tight">
        <strong class="small">Вариант (B)</strong>
        <div class="field"><label>Посетители</label><input v-model.number="observations[1]!.visitors" type="number" min="0" /></div>
        <div class="field"><label>Конверсии</label><input v-model.number="observations[1]!.conversions" type="number" min="0" /></div>
      </div>
    </div>

    <div v-if="evaluation" class="card tight" style="margin-top: 12px">
      <div class="row between">
        <strong>Итог: {{ evaluation.status }}</strong>
        <span class="pill" :class="evaluation.status === 'winner' ? 'success' : evaluation.status === 'no_difference' ? 'neutral' : 'warn'">
          прирост {{ evaluation.liftPercent }}% · p = {{ evaluation.pValue }}
        </span>
      </div>
      <div class="small muted">Минимальная выборка: {{ evaluation.requiredSample.toLocaleString('ru-RU') }} на вариант.</div>
      <ul class="small muted" style="padding-left: 18px; margin: 6px 0 0">
        <li v-for="item in evaluation.recommendations" :key="item">{{ item }}</li>
      </ul>
    </div>

    <template #footer>
      <button class="btn ghost" @click="showEvaluate = false">Закрыть</button>
      <button class="btn primary" :disabled="busy" @click="evaluate"><span v-if="busy" class="spinner" /><Icon v-else name="chart" /> Оценить результат</button>
    </template>
  </Modal>
</template>
