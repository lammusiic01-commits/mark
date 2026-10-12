<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { MarketAnalysis, SiteProject } from '@mark/shared';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import ChartBox from '@/components/ChartBox.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';
import type { EChartsOption } from 'echarts';

/**
 * Market Analyzer: сравнение стоимости клика в нише с бенчмарками,
 * сценарии бюджета и точки роста.
 */

const store = useAppStore();
const sites = ref<SiteProject[]>([]);
const analyses = ref<MarketAnalysis[]>([]);
const current = ref<MarketAnalysis | null>(null);
const busy = ref(false);

const form = reactive({ siteProjectId: '', niche: '', keywords: '', regionId: 213, yourCpc: null as number | null, budget: null as number | null });

onMounted(async () => {
  const [siteList, analysisList] = await Promise.all([
    store.call(() => api.get<{ items: SiteProject[] }>('/api/sites'), ''),
    store.call(() => api.get<{ items: MarketAnalysis[] }>('/api/market/analyses'), ''),
  ]);
  sites.value = siteList?.items ?? [];
  analyses.value = analysisList?.items ?? [];
  if (sites.value[0]) {
    form.siteProjectId = sites.value[0].id;
    form.keywords = sites.value[0].keywords.join(', ');
    form.regionId = sites.value[0].regions[0] ?? 213;
  }
  if (analyses.value[0]) current.value = analyses.value[0]!;
});

async function run(): Promise<void> {
  busy.value = true;
  const analysis = await store.call(
    () =>
      api.post<MarketAnalysis>('/api/market/analyze', {
        siteProjectId: form.siteProjectId || null,
        niche: form.niche || undefined,
        keywords: form.keywords ? form.keywords.split(',').map((value) => value.trim()).filter(Boolean) : undefined,
        regionId: form.regionId,
        yourCpc: form.yourCpc,
        budget: form.budget,
      }),
    'Не удалось выполнить анализ рынка',
  );
  busy.value = false;
  if (!analysis) return;
  current.value = analysis;
  analyses.value = [analysis, ...analyses.value];
  store.toast('success', `Market Analyzer: ${analysis.niche}`, `Средний CPC ниши ${analysis.nicheCpc} ₽. ${analysis.verdict}`);
}

const cpcOption = computed<EChartsOption>(() => {
  const benchmarks = (current.value?.benchmarks ?? []).slice(0, 12);
  return {
    legend: { show: true },
    xAxis: { type: 'category', data: benchmarks.map((item) => item.keyword.slice(0, 16)), axisLabel: { interval: 0, rotate: 30 }, axisLine: { lineStyle: { color: '#22304f' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
    series: [
      { name: 'CPC по запросу, ₽', type: 'bar', data: benchmarks.map((item) => item.cpc) },
      {
        name: 'Ваш CPC',
        type: 'line',
        smooth: true,
        symbolSize: 6,
        data: benchmarks.map(() => current.value?.yourCpc ?? 0),
        itemStyle: { color: '#f59e0b' },
      },
    ],
  };
});

const budgetOption = computed<EChartsOption>(() => {
  const plan = current.value?.budgetPlan ?? [];
  return {
    legend: { show: false },
    xAxis: { type: 'category', data: plan.map((item) => ({ economy: 'Экономный', balanced: 'Сбалансированный', aggressive: 'Агрессивный' }[item.scenario] ?? item.scenario)), axisLine: { lineStyle: { color: '#22304f' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
    series: [
      { name: 'Клики/мес', type: 'bar', data: plan.map((item) => item.clicks), itemStyle: { color: '#2563eb' } },
      { name: 'Конверсии', type: 'bar', data: plan.map((item) => item.conversions), itemStyle: { color: '#22c55e' } },
    ],
  };
});
</script>

<template>
  <div class="grid cols-2">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Сравнение с рынком</h3>
          <div class="sub">MARK считает средний CPC в нише по бенчмаркам и вашему факту из кампаний</div>
        </div>
      </div>

      <div class="field">
        <label>Сайт</label>
        <select v-model="form.siteProjectId">
          <option value="">— не выбран —</option>
          <option v-for="site in sites" :key="site.id" :value="site.id">{{ site.name }}</option>
        </select>
      </div>

      <div class="field">
        <label>Ниша (если нужно переопределить)</label>
        <input v-model="form.niche" type="text" placeholder="Например: стоматология" />
      </div>

      <div class="field">
        <label>Ключевые запросы</label>
        <input v-model="form.keywords" type="text" placeholder="имплантация зубов, стоматология рядом" />
      </div>

      <div class="grid cols-2">
        <div class="field">
          <label>Регион</label>
          <select v-model.number="form.regionId">
            <option v-for="region in store.regions.slice(0, 24)" :key="region.id" :value="region.id">{{ region.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>Ваш средний CPC, ₽</label>
          <input v-model.number="form.yourCpc" type="number" min="0" step="0.5" placeholder="автоматически" />
          <div class="hint">Если оставить пустым, MARK возьмёт факт из подключённых кампаний.</div>
        </div>
      </div>

      <div class="field">
        <label>Бюджет, ₽/мес</label>
        <input v-model.number="form.budget" type="number" min="0" step="1000" placeholder="например, 150000" />
      </div>

      <button class="btn primary block" :disabled="busy" @click="run"><span v-if="busy" class="spinner" /><Icon v-else name="chart" /> Проанализировать рынок</button>
    </div>

    <div v-if="current" class="grid" style="gap: 16px">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>{{ current.niche }} · {{ current.regionName }}</h3>
            <div class="sub">{{ current.verdict }}</div>
          </div>
          <StatusPill
            :status="(current.gapPercent ?? 0) > 15 ? 'fail' : (current.gapPercent ?? 0) < -15 ? 'pass' : 'warn'"
            :label="`отклонение ${current.gapPercent ?? '—'}%`"
          />
        </div>

        <div class="grid cols-3">
          <div class="stat"><span class="label">CPC ниши</span><span class="value">{{ current.nicheCpc }} ₽</span></div>
          <div class="stat"><span class="label">Ваш CPC</span><span class="value">{{ current.yourCpc ?? '—' }}{{ current.yourCpc ? ' ₽' : '' }}</span></div>
          <div class="stat"><span class="label">Источник</span><span class="value" style="font-size: 14px">{{ current.source === 'wordstat_api' ? 'Wordstat API' : 'Бенчмарки' }}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>CPC по запросам против вашего</h3></div>
        <ChartBox :option="cpcOption" :height="240" />
      </div>

      <div class="card">
        <div class="card-head"><h3>Сценарии бюджета</h3></div>
        <ChartBox :option="budgetOption" :height="200" />
        <table style="margin-top: 10px">
          <thead><tr><th>Сценарий</th><th class="num">Бюджет/день</th><th class="num">Клики</th><th class="num">Конверсии</th><th class="num">CPA</th></tr></thead>
          <tbody>
            <tr v-for="plan in current.budgetPlan" :key="plan.scenario">
              <td>{{ { economy: 'Экономный', balanced: 'Сбалансированный', aggressive: 'Агрессивный' }[plan.scenario] }}</td>
              <td class="num">{{ plan.dailyBudget.toLocaleString('ru-RU') }} ₽</td>
              <td class="num">{{ plan.clicks.toLocaleString('ru-RU') }}</td>
              <td class="num">{{ plan.conversions.toLocaleString('ru-RU') }}</td>
              <td class="num">{{ plan.cpa.toLocaleString('ru-RU') }} ₽</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-head"><h3>Выводы и точки роста</h3></div>
        <ul class="small muted" style="padding-left: 18px; margin: 0">
          <li v-for="insight in current.insights" :key="insight">{{ insight }}</li>
        </ul>
        <div v-if="current.competitors?.length" style="margin-top: 12px">
          <div class="small" style="margin-bottom: 4px">Конкуренты и их присутствие в рекламе</div>
          <table>
            <thead><tr><th>Компания</th><th>Домен</th><th class="num">Доля рекламы</th><th>Заметка</th></tr></thead>
            <tbody>
              <tr v-for="competitor in current.competitors" :key="competitor.domain">
                <td>{{ competitor.name }}</td>
                <td class="mono small">{{ competitor.domain }}</td>
                <td class="num">{{ competitor.adShare ?? '—' }}%</td>
                <td class="small muted">{{ competitor.note }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <EmptyState v-else title="Анализ рынка не выполнялся" message="Укажите нишу и запросы — MARK сравнит ваш CPC с рынком и покажет, где вы теряете бюджет." icon="chart" />
  </div>
</template>
