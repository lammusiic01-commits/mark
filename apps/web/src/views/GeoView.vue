<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { GeoAnalysis, GeoPlan, SiteProject } from '@mark/shared';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import ChartBox from '@/components/ChartBox.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';
import CodeBox from '@/components/CodeBox.vue';
import type { EChartsOption } from 'echarts';

/**
 * GEO-анализатор: спрос по регионам (Яндекс.Вордстат), приоритеты,
 * план региональных страниц и задания на внедрение.
 */

const store = useAppStore();
const sites = ref<SiteProject[]>([]);
const analyses = ref<GeoAnalysis[]>([]);
const current = ref<GeoAnalysis | null>(null);
const plan = ref<GeoPlan | null>(null);
const busy = ref(false);

const form = reactive({ siteProjectId: '', keywords: '', regionIds: [] as number[], useLive: false, structure: 'subfolders' as 'subfolders' | 'subdomains' | 'single' });

onMounted(async () => {
  const [siteList, analysisList] = await Promise.all([
    store.call(() => api.get<{ items: SiteProject[] }>('/api/sites'), ''),
    store.call(() => api.get<{ items: GeoAnalysis[] }>('/api/geo/analyses'), ''),
  ]);
  sites.value = siteList?.items ?? [];
  analyses.value = analysisList?.items ?? [];
  if (sites.value[0]) {
    form.siteProjectId = sites.value[0].id;
    form.keywords = sites.value[0].keywords.join(', ');
    form.regionIds = [...sites.value[0].regions];
  }
  if (analyses.value[0]) current.value = analyses.value[0]!;
});

function toggleRegion(id: number): void {
  form.regionIds = form.regionIds.includes(id) ? form.regionIds.filter((item) => item !== id) : [...form.regionIds, id];
}

async function analyze(): Promise<void> {
  busy.value = true;
  const site = sites.value.find((item) => item.id === form.siteProjectId);
  const analysis = await store.call(
    () =>
      api.post<GeoAnalysis>('/api/geo/analyze', {
        siteProjectId: form.siteProjectId || null,
        keywords: form.keywords.split(',').map((value) => value.trim()).filter(Boolean),
        regionIds: form.regionIds.length ? form.regionIds : [213],
        useLive: form.useLive,
      }),
    'Не удалось выполнить GEO-анализ',
  );
  busy.value = false;
  if (!analysis) return;
  current.value = analysis;
  plan.value = null;
  analyses.value = [analysis, ...analyses.value];
  store.toast(
    'success',
    'GEO-анализ готов',
    `${analysis.demandByRegion.length} регионов, суммарный спрос ${analysis.totalDemand.toLocaleString('ru-RU')} показов/мес${analysis.source === 'sandbox' ? ' (модель по бенчмаркам — укажите токен Wordstat для реальных цифр)' : ''}.`,
  );
  if (site) {
    form.keywords = site.keywords.join(', ');
  }
}

async function buildPlan(): Promise<void> {
  if (!form.siteProjectId) {
    store.toast('warning', 'Выберите сайт для плана');
    return;
  }
  busy.value = true;
  const created = await store.call(
    () =>
      api.post<GeoPlan>('/api/geo/plan', {
        siteProjectId: form.siteProjectId,
        structure: form.structure,
        regionIds: form.regionIds.length ? form.regionIds : [213],
        keywords: form.keywords.split(',').map((value) => value.trim()).filter(Boolean),
      }),
    'Не удалось собрать GEO-план',
  );
  busy.value = false;
  if (!created) return;
  plan.value = created;
  store.toast('success', 'План региональных страниц готов', `Страниц: ${created.pages.length}, задач: ${created.tasks.length}.`);
}

const demandOption = computed<EChartsOption>(() => {
  const regions = (current.value?.demandByRegion ?? []).slice(0, 12);
  return {
    legend: { show: false },
    xAxis: { type: 'category', data: regions.map((region) => region.regionName.slice(0, 14)), axisLabel: { interval: 0, rotate: 30 }, axisLine: { lineStyle: { color: '#22304f' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
    series: [
      {
        name: 'Показов/мес',
        type: 'bar',
        data: regions.map((region) => ({
          value: region.demand,
          itemStyle: { color: region.priority === 'high' ? '#2563eb' : region.priority === 'medium' ? '#0ea5e9' : '#475569' },
        })),
      },
    ],
  };
});

const cpcOption = computed<EChartsOption>(() => {
  const regions = (current.value?.demandByRegion ?? []).slice(0, 12);
  return {
    legend: { show: false },
    xAxis: { type: 'category', data: regions.map((region) => region.regionName.slice(0, 14)), axisLabel: { interval: 0, rotate: 30 }, axisLine: { lineStyle: { color: '#22304f' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
    series: [{ name: 'CPC, ₽', type: 'line', smooth: true, data: regions.map((region) => region.cpc ?? 0) }],
  };
});
</script>

<template>
  <div class="grid cols-2">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Анализ спроса по регионам</h3>
          <div class="sub">Данные Яндекс.Вордстат (или детерминированная модель бенчмарков, если токена нет)</div>
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
        <label>Ключевые запросы (через запятую)</label>
        <input v-model="form.keywords" type="text" placeholder="ремонт квартир, отделка новостройки" />
      </div>

      <div class="field">
        <label>Регионы</label>
        <div class="chip-list">
          <button
            v-for="region in store.regions.slice(0, 24)"
            :key="region.id"
            class="chip"
            :class="{ active: form.regionIds.includes(region.id) }"
            @click="toggleRegion(region.id)"
          >
            {{ region.name }}
          </button>
        </div>
      </div>

      <label class="checkbox" style="margin-bottom: 10px">
        <input v-model="form.useLive" type="checkbox" /> Запросить реальные данные у API (нужен токен Яндекс.Директа в «Подключениях»)
      </label>

      <div class="row">
        <button class="btn primary" :disabled="busy" @click="analyze"><span v-if="busy" class="spinner" /><Icon v-else name="map" /> Анализировать</button>
        <button class="btn" :disabled="busy || !current" @click="buildPlan"><Icon name="wand" /> Собрать план страниц</button>
      </div>

      <div class="field" style="margin-top: 14px">
        <label>Структура региональных страниц</label>
        <select v-model="form.structure">
          <option value="subfolders">Подкаталоги: /moscow/, /spb/</option>
          <option value="subdomains">Поддомены: moscow.site.ru</option>
          <option value="single">Одна страница «где мы работаем»</option>
        </select>
      </div>
    </div>

    <div v-if="current" class="grid" style="gap: 16px">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Спрос и приоритеты</h3>
            <div class="sub">
              Источник: {{ current.source === 'wordstat_api' ? 'Wordstat API' : 'модель бенчмарков (sandbox)' }} · всего {{ current.totalDemand.toLocaleString('ru-RU') }} показов/мес
            </div>
          </div>
          <StatusPill :status="current.source === 'wordstat_api' ? 'pass' : 'warn'" :label="current.source === 'wordstat_api' ? 'Реальные данные' : 'Модель'" />
        </div>
        <ChartBox :option="demandOption" :height="230" />
        <ChartBox :option="cpcOption" :height="170" />
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3>Регионы</h3>
            <div class="sub">Приоритет high — спрос от 8% всего объёма, medium — от 2%</div>
          </div>
        </div>
        <table>
          <thead><tr><th>Регион</th><th class="num">Спрос/мес</th><th class="num">Доля</th><th class="num">CPC</th><th>Приоритет</th></tr></thead>
          <tbody>
            <tr v-for="region in current.demandByRegion" :key="region.regionId">
              <td>{{ region.regionName }}</td>
              <td class="num">{{ region.demand.toLocaleString('ru-RU') }}</td>
              <td class="num">{{ region.share }}%</td>
              <td class="num">{{ region.cpc ?? '—' }} ₽</td>
              <td><StatusPill :status="region.priority === 'high' ? 'pass' : region.priority === 'medium' ? 'info' : 'neutral'" :label="region.priority" /></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-head"><h3>Рекомендации по гео-выдаче</h3></div>
        <ul class="small muted" style="padding-left: 18px; margin: 0">
          <li v-for="item in current.recommendations" :key="item">{{ item }}</li>
        </ul>
      </div>
    </div>

    <EmptyState v-else title="GEO-анализ не выполнялся" message="Укажите сайт и запросы, выберите регионы — MARK покажет спрос, стоимость клика и точки роста." icon="map" />
  </div>

  <div v-if="plan" class="card">
    <div class="card-head">
      <div>
        <h3>План региональных страниц: {{ plan.pages.length }} страниц, {{ plan.tasks.length }} задач</h3>
        <div class="sub">Структура: {{ plan.structure }}{{ plan.hreflang?.length ? ` · hreflang: ${plan.hreflang.map((item) => item.lang).join(', ')}` : '' }}</div>
      </div>
    </div>

    <table>
      <thead><tr><th>URL</th><th>Title</th><th>Регион</th><th>Ключей</th></tr></thead>
      <tbody>
        <tr v-for="page in plan.pages" :key="page.url">
          <td class="mono small">{{ page.url }}</td>
          <td class="small">{{ page.title }}</td>
          <td class="small">{{ page.regionName }}</td>
          <td class="small muted">{{ (page.keywords ?? []).slice(0, 3).join(', ') }}</td>
        </tr>
      </tbody>
    </table>

    <div class="grid cols-2" style="margin-top: 14px">
      <div>
        <h4>Задачи на внедрение</h4>
        <div class="steps">
          <div v-for="task in plan.tasks" :key="task.title" class="step pass">
            <span class="dot" />
            <div>
              <strong>{{ task.title }}</strong>
              <div class="small muted">владелец: {{ task.owner }} · трудоёмкость {{ task.effort }} ч</div>
            </div>
          </div>
        </div>
      </div>
      <div v-if="plan.schemaOrg?.length">
        <CodeBox :code="JSON.stringify(plan.schemaOrg, null, 2)" label="Microdata JSON-LD (готово к вставке)" :max-height="260" />
      </div>
    </div>
  </div>
</template>
