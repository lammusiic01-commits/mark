<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { BotScan, BotVerdict, SiteProject } from '@mark/shared';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import ChartBox from '@/components/ChartBox.vue';
import ScoreGauge from '@/components/ScoreGauge.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';
import CodeBox from '@/components/CodeBox.vue';
import type { EChartsOption } from 'echarts';

/**
 * BotShield: анализ логов сервера.
 *
 * Можно вставить лог, загрузить файл, взять демо-образец, скачать по ссылке
 * или прочитать прямо с хостинга (подключённый FTP/SFTP).
 */

const store = useAppStore();
const scans = ref<BotScan[]>([]);
const current = ref<BotScan | null>(null);
const sites = ref<SiteProject[]>([]);
const running = ref(false);
const activeTab = ref<'sources' | 'ips' | 'bots' | 'paths' | 'recommendations'>('sources');

const form = reactive({
  source: 'upload' as 'upload' | 'url' | 'connector' | 'sandbox',
  format: 'auto' as 'nginx' | 'apache' | 'json' | 'cloudflare' | 'auto',
  logContent: '',
  logUrl: '',
  siteProjectId: '',
  accountId: '',
  logPath: '',
  costPerGb: 6,
  valuePerVisit: 22,
  verifyDns: false,
});

onMounted(async () => {
  const [scanList, siteList] = await Promise.all([
    store.call(() => api.get<{ items: BotScan[] }>('/api/bots/scans'), 'Не удалось загрузить отчёты'),
    store.call(() => api.get<{ items: SiteProject[] }>('/api/sites'), ''),
  ]);
  scans.value = scanList?.items ?? [];
  sites.value = siteList?.items ?? [];
  if (scans.value[0]) current.value = await store.call(() => api.get<BotScan>(`/api/bots/scans/${scans.value[0]!.id}`), '');
});

async function loadDemo(): Promise<void> {
  form.source = 'sandbox';
  form.logContent = '';
  const demo = await store.call(() => api.get<{ content: string }>('/api/bots/demo-log').catch(() => null), '');
  if (demo?.content) {
    form.logContent = demo.content;
    form.source = 'upload';
    store.toast('info', 'Загружен демо-образец', 'Нажмите «Проанализировать логи».');
    return;
  }
  store.toast('info', 'Демо-образец недоступен', 'Скопируйте свой access.log и вставьте его в поле ниже.');
}

function uploadFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    form.logContent = String(reader.result ?? '').slice(0, 7_500_000);
    form.source = 'upload';
    store.toast('info', `Файл «${file.name}» загружен`, `${(file.size / 1024).toFixed(0)} КБ. Нажмите «Проанализировать логи».`);
  };
  reader.readAsText(file);
}

async function run(): Promise<void> {
  running.value = true;
  const payload = {
    siteProjectId: form.siteProjectId || null,
    source: form.source,
    format: form.format,
    logContent: form.logContent || undefined,
    logUrl: form.logUrl || undefined,
    accountId: form.accountId || null,
    logPath: form.logPath || undefined,
    costPerGb: form.costPerGb,
    valuePerVisit: form.valuePerVisit,
    verifyDns: form.verifyDns,
  };
  const scan = await store.call(() => api.post<BotScan>('/api/bots/scan', payload), 'Не удалось проанализировать логи');
  running.value = false;
  if (!scan) return;
  current.value = scan;
  scans.value = [{ ...scan }, ...scans.value.filter((item) => item.id !== scan.id)];
  store.toast(
    scan.cleanlinessScore >= 80 ? 'success' : 'warning',
    `Чистота трафика ${scan.cleanlinessScore}/100`,
    `Запросов ${scan.totals.requests.toLocaleString('ru-RU')}, подозрительных ${scan.totals.suspiciousRequests.toLocaleString('ru-RU')}, потери ≈ ${scan.totals.wastedMoneyEstimate.toLocaleString('ru-RU')} ₽/мес.`,
  );
}

async function openScan(scan: BotScan): Promise<void> {
  current.value = await store.call(() => api.get<BotScan>(`/api/bots/scans/${scan.id}`), 'Не удалось загрузить отчёт');
}

const trafficOption = computed<EChartsOption>(() => {
  const series = current.value?.series ?? [];
  return {
    xAxis: { type: 'category', data: series.map((item) => item.date.slice(5)), axisLine: { lineStyle: { color: '#22304f' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
    series: [
      { name: 'Люди', type: 'bar', stack: 't', data: series.map((item) => item.human), itemStyle: { color: '#22c55e' } },
      { name: 'Поисковые боты', type: 'bar', stack: 't', data: series.map((item) => item.bots), itemStyle: { color: '#38bdf8' } },
      { name: 'AI-краулеры', type: 'bar', stack: 't', data: series.map((item) => item.ai), itemStyle: { color: '#a855f7' } },
      { name: 'Подозрительные', type: 'bar', stack: 't', data: series.map((item) => item.suspicious), itemStyle: { color: '#ef4444' } },
    ],
  };
});

const countryOption = computed<EChartsOption>(() => {
  const countries = current.value?.countries ?? [];
  return {
    legend: { show: false },
    grid: { left: 8, right: 12, top: 16, bottom: 6, containLabel: true },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(34,48,79,0.6)' } } },
    yAxis: { type: 'category', data: countries.map((item) => item.country) },
    series: [
      {
        name: 'Доля ботов',
        type: 'bar',
        data: countries.map((item) => ({ value: item.botShare, itemStyle: { color: item.botShare > 60 ? '#ef4444' : item.botShare > 30 ? '#f59e0b' : '#22c55e' } })),
      },
    ],
  };
});
</script>

<template>
  <div class="grid cols-3">
    <div v-for="card in [
      { label: 'Чистота трафика', value: current ? `${current.cleanlinessScore}/100` : '—', tone: current && current.cleanlinessScore < 60 ? 'danger' : 'default' },
      { label: 'Запросов проанализировано', value: (current?.totals.requests ?? 0).toLocaleString('ru-RU'), tone: 'default' },
      { label: 'Уникальных IP', value: (current?.totals.uniqueIps ?? 0).toLocaleString('ru-RU'), tone: 'default' },
      { label: 'Подозрительных запросов', value: (current?.totals.suspiciousRequests ?? 0).toLocaleString('ru-RU'), tone: current && current.totals.suspiciousRequests > 100 ? 'warning' : 'default' },
      { label: 'Сожжено трафика', value: `${((current?.totals.wastedBytes ?? 0) / 1024 ** 2).toFixed(1)} МБ`, tone: 'default' },
      { label: 'Оценка потерь', value: `${(current?.totals.wastedMoneyEstimate ?? 0).toLocaleString('ru-RU')} ₽/мес`, tone: 'danger' },
    ]" :key="card.label" class="card tight">
      <div class="stat">
        <span class="label">{{ card.label }}</span>
        <span class="value">{{ card.value }}</span>
      </div>
    </div>
  </div>

  <div class="split">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Источник логов</h3>
          <div class="sub">Nginx/Apache, Cloudflare Logpush, JSON или прямой доступ к файлу</div>
        </div>
      </div>

      <div class="field">
        <label>Откуда взять логи</label>
        <select v-model="form.source">
          <option value="upload">Вставить или загрузить файл access.log</option>
          <option value="url">Скачать по ссылке</option>
          <option value="connector">Прочитать с хостинга через подключение</option>
          <option value="sandbox">Демонстрационный образец</option>
        </select>
      </div>

      <div v-if="form.source === 'upload'" class="field">
        <label>Содержимое лога</label>
        <textarea v-model="form.logContent" rows="8" placeholder='127.0.0.1 - - [10/Oct/2026:03:12:11 +0300] "GET / HTTP/1.1" 200 45231 "-" "Mozilla/5.0 …"' />
        <div class="row">
          <label class="btn sm"><Icon name="upload" /> Выбрать файл<input type="file" accept=".log,.txt,text/plain" style="display: none" @change="uploadFile" /></label>
          <button class="btn ghost sm" @click="loadDemo"><Icon name="wand" /> Демо-образец</button>
        </div>
      </div>

      <div v-else-if="form.source === 'url'" class="field">
        <label>Ссылка на файл логов</label>
        <input v-model="form.logUrl" type="text" placeholder="https:// example.ru/logs/access.log" />
      </div>

      <div v-else-if="form.source === 'connector'" class="field">
        <label>Путь к логу на хостинге</label>
        <input v-model="form.logPath" type="text" placeholder="/logs/access.log или /var/log/nginx/access.log" />
        <div class="hint">Используется подключение из раздела «Подключения» (FTP/SFTP). Если доступа нет — скачайте лог и загрузите файлом.</div>
      </div>

      <div v-else class="card tight">
        <div class="small muted">Демонстрационный лог с ботами, AI-краулерами и атакой. Нажмите «Проанализировать логи».</div>
      </div>

      <div class="grid cols-2" style="margin-top: 8px">
        <div class="field">
          <label>Формат</label>
          <select v-model="form.format">
            <option value="auto">Определить автоматически</option>
            <option value="nginx">Nginx</option>
            <option value="apache">Apache</option>
            <option value="cloudflare">Cloudflare</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <div class="field">
          <label>Проект</label>
          <select v-model="form.siteProjectId">
            <option value="">— не привязывать —</option>
            <option v-for="site in sites" :key="site.id" :value="site.id">{{ site.name }}</option>
          </select>
        </div>
      </div>

      <div class="grid cols-2">
        <div class="field">
          <label>Стоимость трафика, ₽/ГБ</label>
          <input v-model.number="form.costPerGb" type="number" min="0" step="0.5" />
        </div>
        <div class="field">
          <label>Ценность визита, ₽</label>
          <input v-model.number="form.valuePerVisit" type="number" min="0" step="1" />
        </div>
      </div>

      <label class="checkbox" style="margin-bottom: 10px">
        <input v-model="form.verifyDns" type="checkbox" /> Проверять rDNS (точнее находит подделки под Googlebot, но медленнее)
      </label>

      <button class="btn primary block" :disabled="running" @click="run">
        <span v-if="running" class="spinner" /><Icon v-else name="shield" /> {{ running ? 'Анализирую…' : 'Проанализировать логи' }}
      </button>

      <div v-if="scans.length" style="margin-top: 14px">
        <div class="small muted" style="margin-bottom: 6px">Прошлые отчёты</div>
        <div class="row">
          <button v-for="scan in scans.slice(0, 6)" :key="scan.id" class="btn ghost sm" @click="openScan(scan)">
            {{ new Date(scan.finishedAt ?? scan.startedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }} · {{ scan.cleanlinessScore }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="current" class="grid" style="gap: 16px">
      <div class="card">
        <div class="card-head">
          <div>
            <h3>Итог анализа</h3>
            <div class="sub">
              {{ current.totals.lines.toLocaleString('ru-RU') }} строк · разобрано {{ current.totals.parsed.toLocaleString('ru-RU') }} ·
              человеческих запросов {{ current.totals.humanRequests.toLocaleString('ru-RU') }} · ботов {{ current.totals.botRequests.toLocaleString('ru-RU') }}
            </div>
          </div>
          <StatusPill :status="current.cleanlinessScore >= 80 ? 'pass' : current.cleanlinessScore >= 50 ? 'warn' : 'fail'" />
        </div>

        <div class="row" style="gap: 20px">
          <ScoreGauge :value="current.cleanlinessScore" label="Чистота трафика" />
          <div class="grid" style="flex: 1; gap: 10px">
            <ChartBox :option="trafficOption" :height="180" />
          </div>
        </div>

        <div v-if="current.errors?.length" class="small" style="color: #fcd34d; margin-top: 8px">
          {{ current.errors.slice(0, 3).join('; ') }}
        </div>
      </div>

      <div class="grid cols-2">
        <div class="card">
          <div class="card-head"><h3>Доля ботов по странам</h3></div>
          <ChartBox v-if="current.countries.length" :option="countryOption" :height="200" />
          <div v-else class="small muted">Данных по странам нет.</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Автономные системы</h3></div>
          <table v-if="current.asnList.length">
            <thead><tr><th>ASN</th><th>Организация</th><th class="num">Запросы</th><th class="num">Боты</th></tr></thead>
            <tbody>
              <tr v-for="asn in current.asnList.slice(0, 8)" :key="asn.asn">
                <td class="mono small">{{ asn.asn }}</td>
                <td class="small">{{ asn.org }}</td>
                <td class="num">{{ asn.requests.toLocaleString('ru-RU') }}</td>
                <td class="num">{{ asn.botShare }}%</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="small muted">Нет данных.</div>
        </div>
      </div>

      <div class="card">
        <div class="tabs">
          <button :class="{ active: activeTab === 'sources' }" @click="activeTab = 'sources'">Классификация</button>
          <button :class="{ active: activeTab === 'ips' }" @click="activeTab = 'ips'">IP-адреса</button>
          <button :class="{ active: activeTab === 'bots' }" @click="activeTab = 'bots'">Боты</button>
          <button :class="{ active: activeTab === 'paths' }" @click="activeTab = 'paths'">Страницы</button>
          <button :class="{ active: activeTab === 'recommendations' }" @click="activeTab = 'recommendations'">Рекомендации ({{ current.recommendations.length }})</button>
        </div>

        <div v-if="activeTab === 'sources'" class="grid cols-3">
          <div class="card tight"><div class="stat"><span class="label">Поисковые боты</span><span class="value">{{ current.totals.goodBotRequests.toLocaleString('ru-RU') }}</span></div></div>
          <div class="card tight"><div class="stat"><span class="label">AI-краулеры</span><span class="value">{{ current.totals.aiCrawlerRequests.toLocaleString('ru-RU') }}</span></div></div>
          <div class="card tight"><div class="stat"><span class="label">Подозрительные</span><span class="value">{{ current.totals.suspiciousRequests.toLocaleString('ru-RU') }}</span></div></div>
        </div>

        <table v-else-if="activeTab === 'ips'">
          <thead><tr><th>IP</th><th>Классификация</th><th>ASN / организация</th><th class="num">Запросы</th><th>Причины</th></tr></thead>
          <tbody>
            <tr v-for="verdict in current.topIps.slice(0, 25)" :key="verdict.id">
              <td class="mono small">{{ verdict.ip }}</td>
              <td><StatusPill :status="verdict.classification" /></td>
              <td class="small">{{ verdict.asn ?? '—' }} {{ verdict.org ?? '' }}</td>
              <td class="num">{{ verdict.requests.toLocaleString('ru-RU') }}</td>
              <td class="small muted">{{ (verdict.reasons ?? []).slice(0, 2).join('; ') }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else-if="activeTab === 'bots'">
          <thead><tr><th>Бот</th><th>Классификация</th><th class="num">Запросы</th></tr></thead>
          <tbody>
            <tr v-for="bot in current.topBots" :key="bot.name">
              <td>{{ bot.name }}<div class="small faint mono">{{ bot.userAgent?.slice(0, 70) }}</div></td>
              <td><StatusPill :status="bot.classification" /></td>
              <td class="num">{{ bot.requests.toLocaleString('ru-RU') }}</td>
            </tr>
          </tbody>
        </table>

        <table v-else-if="activeTab === 'paths'">
          <thead><tr><th>Страница</th><th class="num">Запросы</th><th class="num">Доля ботов</th></tr></thead>
          <tbody>
            <tr v-for="path in current.topPaths" :key="path.path">
              <td class="mono small">{{ path.path }}</td>
              <td class="num">{{ path.requests.toLocaleString('ru-RU') }}</td>
              <td class="num">{{ path.botShare }}%</td>
            </tr>
          </tbody>
        </table>

        <div v-else class="grid" style="gap: 12px">
          <div v-for="(recommendation, index) in current.recommendations" :key="index" class="card tight">
            <div class="row between">
              <div>
                <strong>{{ recommendation.title }}</strong>
                <div class="small muted">{{ recommendation.detail }}</div>
              </div>
              <StatusPill :status="recommendation.severity === 'critical' ? 'fail' : recommendation.severity === 'high' ? 'attack' : 'warn'" :label="recommendation.severity" />
            </div>
            <CodeBox v-if="recommendation.action" :code="recommendation.action" label="Что применить" :max-height="150" />
          </div>
          <EmptyState v-if="!current.recommendations.length" title="Рекомендаций нет" message="Трафик выглядит чистым." icon="check" />
        </div>
      </div>
    </div>

    <EmptyState v-else title="Отчётов BotShield пока нет" message="Вставьте access.log или загрузите файл слева — MARK классифицирует трафик и покажет, сколько бюджета уходит впустую." icon="shield" />
  </div>
</template>
