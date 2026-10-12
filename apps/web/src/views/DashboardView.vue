<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { api } from '@/api/client';
import StatCard from '@/components/StatCard.vue';
import ChartBox from '@/components/ChartBox.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';
import Icon from '@/components/Icon.vue';
import type { EChartsOption } from 'echarts';

const store = useAppStore();
const router = useRouter();

onMounted(() => {
  void store.loadDashboard();
});

const summary = computed(() => store.dashboard);

const seoSeries = computed<EChartsOption>(() => ({
  legend: { show: false },
  xAxis: { type: 'category', data: (summary.value?.seoScoreSeries ?? []).map((point) => point.date.slice(5)), axisLine: { lineStyle: { color: '#22304f' } } },
  yAxis: { type: 'value', max: 100, splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
  series: [{ name: 'SEO-балл', type: 'line', smooth: true, areaStyle: { opacity: 0.18 }, data: (summary.value?.seoScoreSeries ?? []).map((point) => point.value) }],
}));

const botSeries = computed<EChartsOption>(() => {
  const series = summary.value?.botTrafficSeries ?? [];
  return {
    xAxis: { type: 'category', data: series.map((item) => item.date.slice(5)), axisLine: { lineStyle: { color: '#22304f' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
    series: [
      { name: 'Люди', type: 'bar', stack: 'traffic', data: series.map((item) => item.human), itemStyle: { color: '#22c55e' } },
      { name: 'Поисковые боты', type: 'bar', stack: 'traffic', data: series.map((item) => item.bots), itemStyle: { color: '#38bdf8' } },
      { name: 'AI-краулеры', type: 'bar', stack: 'traffic', data: series.map((item) => item.ai), itemStyle: { color: '#a855f7' } },
      { name: 'Подозрительные', type: 'bar', stack: 'traffic', data: series.map((item) => item.suspicious), itemStyle: { color: '#ef4444' } },
    ],
  };
});

const budgetGauge = computed<EChartsOption>(() => {
  const used = summary.value?.budget.used ?? 0;
  const planned = summary.value?.budget.planned ?? 0;
  const share = planned > 0 ? Math.round((used / planned) * 100) : 0;
  return {
    legend: { show: false },
    grid: { top: 10, bottom: 10, left: 10, right: 10 },
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: 100,
        progress: { show: true, width: 14, itemStyle: { color: share > 100 ? '#ef4444' : '#2563eb' } },
        axisLine: { lineStyle: { width: 14, color: [[1, 'rgba(255,255,255,0.08)']] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        detail: { valueAnimation: true, formatter: '{value}%', color: '#e8eefc', fontSize: 22, offsetCenter: [0, 0] },
        data: [{ value: share, name: '' }],
        title: { show: false },
      },
    ],
  };
});

async function quickRun(): Promise<void> {
  if (!store.activeClientId) {
    store.toast('warning', 'Выберите клиента', 'Полный цикл запускается по конкретному клиенту.');
    return;
  }
  const result = await store.call(
    () => api.post<{ runId: string; channel: string }>('/api/quick-run', { clientId: store.activeClientId }),
    'Не удалось запустить полный цикл',
  );
  if (result) {
    store.toast('info', 'Полный цикл запущен', `Задача ${result.runId}: аудит → автофиксы → GEO → Market → гипотезы → отчёт. Прогресс — в разделе «Автооптимизация».`);
    await store.loadDashboard();
  }
}
</script>

<template>
  <div class="grid cols-4">
    <StatCard v-for="kpi in summary?.kpis ?? []" :key="kpi.label" :label="kpi.label" :value="kpi.value" />
  </div>

  <div class="grid cols-2">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Динамика SEO-балла</h3>
          <div class="sub">Каждый аудит добавляет точку — видно, как правки влияют на качество сайта</div>
        </div>
        <button class="btn sm" @click="router.push('/sites')"><Icon name="globe" /> К сайтам</button>
      </div>
      <ChartBox v-if="summary?.seoScoreSeries?.length" :option="seoSeries" :height="220" />
      <EmptyState v-else title="Аудитов ещё не было" message="Добавьте сайт и запустите аудит — график заполнится автоматически." icon="globe" />
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>Состав трафика</h3>
          <div class="sub">Люди, поисковые боты, AI-краулеры и подозрительные — по данным последнего скана логов</div>
        </div>
        <button class="btn sm" @click="router.push('/bots')"><Icon name="shield" /> BotShield</button>
      </div>
      <ChartBox v-if="summary?.botTrafficSeries?.length" :option="botSeries" :height="220" />
      <EmptyState v-else title="Логи ещё не анализировались" message="Загрузите access.log в BotShield — покажем состав трафика и потери." icon="shield" />
    </div>
  </div>

  <div class="grid cols-3">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Бюджет месяца</h3>
          <div class="sub">Расход против планового бюджета клиентов</div>
        </div>
      </div>
      <ChartBox :option="budgetGauge" :height="190" />
      <div class="small muted">
        Израсходовано {{ (summary?.budget.used ?? 0).toLocaleString('ru-RU') }} ₽ из {{ (summary?.budget.planned ?? 0).toLocaleString('ru-RU') }} ₽
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>Гипотезы</h3>
          <div class="sub">Портфель тестов и средний ожидаемый эффект</div>
        </div>
        <button class="btn sm" @click="router.push('/hypotheses')"><Icon name="flask" /> Открыть</button>
      </div>
      <div class="grid cols-2">
        <div class="stat"><span class="label">Всего</span><span class="value">{{ summary?.hypotheses.total ?? 0 }}</span></div>
        <div class="stat"><span class="label">В работе</span><span class="value">{{ summary?.hypotheses.running ?? 0 }}</span></div>
        <div class="stat"><span class="label">Завершено</span><span class="value">{{ summary?.hypotheses.done ?? 0 }}</span></div>
        <div class="stat"><span class="label">Средний эффект</span><span class="value">{{ summary?.hypotheses.avgLift ?? 0 }}%</span></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>Подключения</h3>
          <div class="sub">Статусы аккаунтов внешних сервисов</div>
        </div>
        <button class="btn sm" @click="router.push('/connect')"><Icon name="plug" /> Подключить</button>
      </div>
      <div class="grid cols-2">
        <div class="stat"><span class="label">Всего</span><span class="value">{{ summary?.accounts.total ?? 0 }}</span></div>
        <div class="stat"><span class="label">Работают</span><span class="value">{{ summary?.accounts.valid ?? 0 }}</span></div>
        <div class="stat"><span class="label">Истекают</span><span class="value">{{ summary?.accounts.expiring ?? 0 }}</span></div>
        <div class="stat"><span class="label">Сломаны</span><span class="value">{{ summary?.accounts.broken ?? 0 }}</span></div>
      </div>
    </div>
  </div>

  <div class="grid cols-2">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Что требует внимания</h3>
          <div class="sub">Проблемы, найденные по всем модулям</div>
        </div>
        <button class="btn primary sm" @click="quickRun"><Icon name="bolt" /> Полный цикл одной кнопкой</button>
      </div>
      <div v-if="summary?.alerts?.length" class="steps">
        <div v-for="alert in summary.alerts" :key="alert.title" class="step" :class="alert.severity === 'critical' ? 'fail' : alert.severity === 'high' ? 'warn' : 'running'">
          <span class="dot" />
          <div>
            <strong>{{ alert.title }}</strong>
            <div class="small muted">{{ alert.detail }}</div>
          </div>
        </div>
      </div>
      <EmptyState v-else title="Всё под контролем" message="Критичных замечаний нет. Можно запустить полный цикл, чтобы обновить данные." icon="check" />
    </div>

    <div class="card">
      <div class="card-head">
        <div>
          <h3>Последние события</h3>
          <div class="sub">Журнал модулей: аудиты, сканы, гипотезы, отчёты</div>
        </div>
      </div>
      <div class="timeline">
        <div v-for="event in store.dashboardRecent?.events ?? []" :key="event.id" class="item">
          <span class="time">{{ new Date(event.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</span>
          <span>{{ event.message }}</span>
        </div>
        <div v-if="!store.dashboardRecent?.events?.length" class="small muted">Событий пока нет.</div>
      </div>
      <div class="row" style="margin-top: 12px">
        <StatusPill v-if="summary?.geo" :status="'applied'" :label="`GEO: ${summary.geo.regions} регионов, спрос ${summary.geo.demand.toLocaleString('ru-RU')}`" />
        <StatusPill v-if="summary?.market" :status="'info'" :label="`Market: ${summary.market.niche} · ${summary.market.nicheCpc} ₽`" />
      </div>
    </div>
  </div>
</template>
