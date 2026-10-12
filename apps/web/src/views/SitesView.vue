<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { AuditRun, SiteProject, ValidationCheck } from '@mark/shared';
import { api } from '@/api/client';
import { subscribeChannels } from '@/api/realtime';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import Modal from '@/components/Modal.vue';
import ScoreGauge from '@/components/ScoreGauge.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';
import CodeBox from '@/components/CodeBox.vue';

/**
 * Сайты: определение платформы, SEO-аудит с живым прогрессом,
 * автоисправления через коннекторы (GitHub/FTP/WordPress/Tilda/Cloudflare…)
 * и запуск переобхода в поисковиках.
 */

const store = useAppStore();
const sites = ref<SiteProject[]>([]);
const selected = ref<SiteProject | null>(null);
const detail = ref<{ audits: AuditRun[]; patches: { id: string; files: { path: string }[]; instructions: string[] }[] } | null>(null);
const audit = ref<AuditRun | null>(null);
const progress = ref<ValidationCheck[]>([]);
const running = ref(false);
const showAdd = ref(false);
const showAutofix = ref(false);
const newSite = reactive({ name: '', url: '', clientId: '', regions: '213', keywords: '' });
const detection = ref<{ platformName: string; confidence: number; evidence: string[]; recommendedConnectors: string[] } | null>(null);
const selectedFindings = ref<string[]>([]);
const autofixForm = reactive({ connectorId: '', accountId: '', mode: 'preview' as 'preview' | 'apply' });
const autofixResult = ref<{ exported?: { dir: string; files: string[] } | null; applied?: { steps: { step: string; ok: boolean; detail: string }[] } } | null>(null);

onMounted(load);

async function load(): Promise<void> {
  const payload = await store.call(() => api.get<{ items: SiteProject[] }>('/api/sites'), 'Не удалось загрузить сайты');
  sites.value = payload?.items ?? [];
  if (!selected.value && sites.value[0]) await open(sites.value[0]);
}

async function open(site: SiteProject): Promise<void> {
  selected.value = site;
  audit.value = null;
  progress.value = [];
  autofixResult.value = null;
  const payload = await store.call(() => api.get<{ audits: AuditRun[]; patches: { id: string; files: { path: string }[]; instructions: string[] }[] }>(`/api/sites/${site.id}`), 'Не удалось получить данные сайта');
  detail.value = payload;
  if (payload?.audits?.length) {
    audit.value = await store.call(() => api.get<AuditRun>(`/api/audits/${payload.audits[0]!.id}`), 'Не удалось загрузить аудит');
    selectedFindings.value = (audit.value?.findings ?? []).filter((finding) => finding.autoFixable).map((finding) => finding.code);
  }
}

async function detect(): Promise<void> {
  if (!newSite.url) {
    store.toast('warning', 'Укажите адрес сайта');
    return;
  }
  const found = await store.call(() => api.post<{ platformName: string; confidence: number; evidence: string[]; recommendedConnectors: string[] }>('/api/sites/detect', { url: newSite.url }), 'Не удалось определить платформу');
  if (found) {
    detection.value = found;
    if (!newSite.name) newSite.name = new URL(newSite.url.startsWith('http') ? newSite.url : `https://${newSite.url}`).hostname;
    store.toast('info', `Платформа: ${found.platformName}`, `Уверенность ${found.confidence}%. Рекомендуемые коннекторы: ${found.recommendedConnectors.join(', ') || '—'}`);
  }
}

async function createSite(): Promise<void> {
  const payload = {
    name: newSite.name.trim() || newSite.url,
    url: newSite.url.trim(),
    clientId: newSite.clientId || store.activeClientId || null,
    regions: newSite.regions.split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value)),
    keywords: newSite.keywords.split(',').map((value) => value.trim()).filter(Boolean),
    goals: [],
  };
  const created = await store.call(() => api.post<{ site: SiteProject }>('/api/sites', payload), 'Не удалось добавить сайт');
  if (!created) return;
  showAdd.value = false;
  detection.value = null;
  Object.assign(newSite, { name: '', url: '', clientId: '', regions: '213', keywords: '' });
  await load();
  await open(created.site);
  store.toast('success', 'Сайт добавлен', 'Запустите аудит — MARK найдёт проблемы и подготовит исправления.');
}

async function runAudit(): Promise<void> {
  if (!selected.value) return;
  running.value = true;
  progress.value = [];
  const started = await store.call(
    () => api.post<{ auditRunId: string; channel: string }>(`/api/sites/${selected.value!.id}/audit`, { maxPages: 25, includeSubdomains: false, runPsi: true }),
    'Не удалось запустить аудит',
  );
  if (!started) {
    running.value = false;
    return;
  }
  const stop = subscribeChannels([started.channel], (event) => {
    if (event.type === 'progress' || event.type === 'check' || event.type === 'stage') {
      const payload = event.payload as { message?: string; stage?: string; title?: string };
      progress.value.push({ key: `${Date.now()}${Math.random()}`, title: payload.title ?? payload.stage ?? event.type, status: 'running', message: payload.message });
      if (progress.value.length > 60) progress.value.splice(0, progress.value.length - 60);
    }
    if (event.type === 'done') {
      void finishAudit(String((event.payload as { auditId?: string }).auditId ?? started.auditRunId));
      stop();
    }
    if (event.type === 'failed') {
      running.value = false;
      store.toast('error', 'Аудит не удался', String((event.payload as { error?: string }).error ?? ''));
      stop();
    }
  });
}

async function finishAudit(auditId: string): Promise<void> {
  audit.value = await store.call(() => api.get<AuditRun>(`/api/audits/${auditId}`), 'Не удалось загрузить результат аудита');
  running.value = false;
  if (audit.value) {
    selectedFindings.value = (audit.value.findings ?? []).filter((finding) => finding.autoFixable).map((finding) => finding.code);
    store.toast(
      audit.value.score >= 80 ? 'success' : 'warning',
      `Аудит завершён: ${audit.value.score}/100 (${audit.value.grade})`,
      `Проблем: ${audit.value.findings.length}, из них исправляются автоматически: ${audit.value.findings.filter((finding) => finding.autoFixable).length}`,
    );
  }
}

async function runAutofix(): Promise<void> {
  if (!selected.value || !audit.value) return;
  if (!selectedFindings.value.length) {
    store.toast('warning', 'Выберите проблемы для исправления');
    return;
  }
  const response = await store.call(
    () =>
      api.post<{ exported?: { dir: string; files: string[] } | null; applied?: { steps: { step: string; ok: boolean; detail: string }[] }; hint?: string }>(
        `/api/sites/${selected.value!.id}/autofix`,
        {
          siteProjectId: selected.value!.id,
          auditRunId: audit.value!.id,
          findingCodes: selectedFindings.value,
          connectorId: autofixForm.connectorId || selected.value!.connectorId,
          accountId: autofixForm.accountId || null,
          mode: autofixForm.mode,
          dryRunAlways: false,
        },
      ),
    'Не удалось подготовить исправления',
  );
  if (!response) return;
  autofixResult.value = { exported: response.exported ?? null, applied: response.applied };
  if (response.applied) {
    const ok = response.applied.steps.filter((step) => step.ok).length;
    store.toast(ok ? 'success' : 'warning', `Применено шагов: ${ok} из ${response.applied.steps.length}`, 'Детали — в блоке ниже.');
  } else {
    store.toast('success', 'Правки подготовлены', `Файлы выгружены в ${response.exported?.dir ?? '.data/reports'}. Нажмите «Применить», чтобы внести их на сайт.`);
  }
  await open(selected.value);
}

async function indexing(kind: 'indexnow' | 'recrawl'): Promise<void> {
  if (!selected.value) return;
  const response = await store.call(
    () => api.post<{ steps: { step: string; ok: boolean; detail: string }[] }>(`/api/indexing/${kind}`, { siteProjectId: selected.value!.id, urls: [selected.value!.url] }),
    'Не удалось отправить на индексацию',
  );
  if (response) store.toast(response.steps.some((step) => step.ok) ? 'success' : 'warning', 'Индексация', response.steps.map((step) => step.detail).join('; '));
}

const autoFixable = computed(() => (audit.value?.findings ?? []).filter((finding) => finding.autoFixable));

function toggleFinding(code: string): void {
  selectedFindings.value = selectedFindings.value.includes(code)
    ? selectedFindings.value.filter((item) => item !== code)
    : [...selectedFindings.value, code];
}
</script>

<template>
  <div class="split">
    <div class="card">
      <div class="card-head">
        <div>
          <h3>Проекты сайтов</h3>
          <div class="sub">Любая платформа: Tilda, WordPress, Bitrix, статика на Vercel/Netlify, свой хостинг по FTP/SFTP</div>
        </div>
        <button class="btn primary sm" @click="showAdd = true"><Icon name="plus" /> Добавить</button>
      </div>

      <div v-if="sites.length" class="grid" style="gap: 8px">
        <button
          v-for="site in sites"
          :key="site.id"
          class="btn ghost block"
          style="justify-content: flex-start; text-align: left"
          :style="selected?.id === site.id ? 'border-color: rgba(37,99,235,0.6)' : ''"
          @click="open(site)"
        >
          <div style="flex: 1">
            <div><strong>{{ site.name }}</strong></div>
            <div class="small muted">{{ site.url }}</div>
            <div class="row small" style="margin-top: 4px; gap: 6px">
              <StatusPill :status="site.platform" :label="site.platform" />
              <span class="faint">SEO {{ site.seoScore ?? '—' }}</span>
              <span class="faint">{{ site.keywords.length }} ключей</span>
            </div>
          </div>
        </button>
      </div>
      <EmptyState v-else title="Сайтов пока нет" message="Добавьте адрес — MARK определит платформу и предложит коннектор." icon="globe" />
    </div>

    <div v-if="selected" class="grid" style="gap: 16px">
      <div class="card">
        <div class="card-head">
          <div>
            <h2>{{ selected.name }}</h2>
            <div class="sub"><a :href="selected.url" target="_blank" rel="noreferrer">{{ selected.url }}</a> · коннектор {{ selected.connectorId }}</div>
          </div>
          <div class="row">
            <button class="btn sm" @click="indexing('indexnow')"><Icon name="bolt" /> IndexNow</button>
            <button class="btn sm" @click="indexing('recrawl')"><Icon name="refresh" /> Переобход</button>
            <button class="btn primary sm" :disabled="running" @click="runAudit">
              <span v-if="running" class="spinner" /><Icon v-else name="play" /> {{ running ? 'Аудит идёт…' : 'Запустить аудит' }}
            </button>
          </div>
        </div>

        <div class="row" style="gap: 20px">
          <ScoreGauge :value="audit?.score ?? selected.seoScore ?? 0" label="SEO-балл" />
          <div class="grid" style="flex: 1; gap: 8px">
            <div class="row" style="gap: 18px">
              <div class="stat"><span class="label">Критичных</span><span class="value">{{ audit?.summary?.critical ?? 0 }}</span></div>
              <div class="stat"><span class="label">Важных</span><span class="value">{{ audit?.summary?.high ?? 0 }}</span></div>
              <div class="stat"><span class="label">Всего проблем</span><span class="value">{{ audit?.findings?.length ?? 0 }}</span></div>
              <div class="stat"><span class="label">Автоисправление</span><span class="value">{{ autoFixable.length }}</span></div>
            </div>
            <div v-if="audit" class="small muted">
              Аудит от {{ new Date(audit.finishedAt ?? audit.startedAt).toLocaleString('ru-RU') }}, страниц проверено {{ audit.pagesCrawled }} из {{ audit.pagesDiscovered }}
            </div>
          </div>
        </div>

        <details v-if="progress.length" style="margin-top: 12px">
          <summary class="small muted">Ход аудита ({{ progress.length }} шагов)</summary>
          <pre class="log" style="margin-top: 8px">{{ progress.map((item) => `• ${item.title}${item.message ? `: ${item.message}` : ''}`).join('\n') }}</pre>
        </details>
      </div>

      <div class="card" v-if="audit?.findings?.length">
        <div class="card-head">
          <div>
            <h3>Найденные проблемы</h3>
            <div class="sub">Отметьте те, что нужно исправить — MARK соберёт файлы и применит их через коннектор</div>
          </div>
          <div class="row">
            <button class="btn sm" @click="selectedFindings = autoFixable.map((finding) => finding.code)">Выбрать устранимые</button>
            <button class="btn primary sm" @click="showAutofix = true"><Icon name="wand" /> Исправить ({{ selectedFindings.length }})</button>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width: 34px" />
              <th>Проблема</th>
              <th>Категория</th>
              <th>Важность</th>
              <th>Автофикс</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="finding in audit.findings" :key="finding.id ?? finding.code">
              <td><input type="checkbox" :checked="selectedFindings.includes(finding.code)" :disabled="!finding.autoFixable" @change="toggleFinding(finding.code)" /></td>
              <td>
                <strong>{{ finding.title }}</strong>
                <div class="small muted">{{ finding.evidence?.slice(0, 220) }}</div>
                <div v-if="finding.recommendation" class="small faint">→ {{ finding.recommendation }}</div>
              </td>
              <td class="small">{{ finding.category }}</td>
              <td><StatusPill :status="finding.severity === 'critical' ? 'fail' : finding.severity === 'high' ? 'attack' : finding.severity === 'medium' ? 'bot' : 'info'" :label="finding.severity" /></td>
              <td>{{ finding.autoFixable ? 'да' : 'вручную' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card" v-else-if="!running">
        <EmptyState title="Аудит не запускался" message="Нажмите «Запустить аудит»: MARK обойдёт сайт, проверит robots.txt, мета-теги, скорость, микроразметку, мобильную версию и подготовит исправления." icon="globe" />
      </div>

      <div class="card" v-if="detail?.patches?.length">
        <div class="card-head">
          <div>
            <h3>Наборы правок</h3>
            <div class="sub">Готовые файлы и инструкции для применения</div>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Набор</th><th>Файлов</th><th>Инструкции</th></tr>
          </thead>
          <tbody>
            <tr v-for="patch in detail.patches" :key="patch.id">
              <td class="mono small">{{ patch.id }}</td>
              <td>{{ patch.files.length }}</td>
              <td class="small muted">{{ patch.instructions.length ? patch.instructions[0] : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <Modal v-if="showAdd" title="Добавить сайт" subtitle="MARK определит платформу и подберёт способ подключения" @close="showAdd = false; detection = null">
    <div class="field">
      <label>Адрес сайта *</label>
      <div class="row">
        <input v-model="newSite.url" type="text" placeholder="https://tilda-сайт.ru или example.com" style="flex: 1" />
        <button class="btn" @click="detect"><Icon name="eye" /> Определить платформу</button>
      </div>
      <div v-if="detection" class="hint">
        {{ detection.platformName }} (уверенность {{ detection.confidence }}%). Рекомендуем: {{ detection.recommendedConnectors.join(', ') || 'FTP/ручные правки' }}.
        <div v-for="evidence in detection.evidence.slice(0, 3)" :key="evidence">• {{ evidence }}</div>
      </div>
    </div>

    <div class="field">
      <label>Название проекта</label>
      <input v-model="newSite.name" type="text" placeholder="Например: Стоматология на Ленина" />
    </div>

    <div class="grid cols-2">
      <div class="field">
        <label>Клиент</label>
        <select v-model="newSite.clientId">
          <option value="">— не выбран —</option>
          <option v-for="client in store.clients" :key="client.id" :value="client.id">{{ client.name }}</option>
        </select>
      </div>
      <div class="field">
        <label>Регионы (коды Яндекса через запятую)</label>
        <input v-model="newSite.regions" type="text" placeholder="213, 2, 54" />
      </div>
    </div>

    <div class="field">
      <label>Ключевые запросы (через запятую)</label>
      <input v-model="newSite.keywords" type="text" placeholder="ремонт квартир, отделка новостройки" />
    </div>

    <template #footer>
      <button class="btn ghost" @click="showAdd = false">Отмена</button>
      <button class="btn primary" @click="createSite"><Icon name="plus" /> Добавить сайт</button>
    </template>
  </Modal>

  <Modal v-if="showAutofix" title="Автоисправление" subtitle="MARK соберёт файлы (robots.txt, sitemap.xml, llms.txt, JSON-LD, мета-теги, редиректы) и применит их через коннектор" @close="showAutofix = false">
    <div class="grid cols-2">
      <div class="field">
        <label>Коннектор применения</label>
        <select v-model="autofixForm.connectorId">
          <option value="">— по умолчанию для сайта ({{ selected?.connectorId }}) —</option>
          <option v-for="connector in store.meta?.siteConnectors ?? []" :key="connector.id" :value="connector.id">{{ connector.name }}</option>
        </select>
      </div>
      <div class="field">
        <label>Подключение (аккаунт)</label>
        <select v-model="autofixForm.accountId">
          <option value="">— не использовать —</option>
        </select>
      </div>
    </div>

    <div class="field">
      <label>Режим</label>
      <div class="row">
        <label class="checkbox"><input v-model="autofixForm.mode" type="radio" value="preview" /> Сначала посмотреть файлы</label>
        <label class="checkbox"><input v-model="autofixForm.mode" type="radio" value="apply" /> Применить сразу</label>
      </div>
    </div>

    <div class="small muted">
      Выбрано проблем: <strong>{{ selectedFindings.length }}</strong>. Для Tilda и WordPress часть правок вносится в редактор через сохранённую сессию; если сессии нет — MARK выгрузит готовые файлы и инструкцию.
    </div>

    <div v-if="autofixResult" style="margin-top: 14px">
      <div v-if="autofixResult.applied" class="steps" style="margin-bottom: 10px">
        <div v-for="step in autofixResult.applied.steps" :key="step.step" class="step" :class="step.ok ? 'pass' : 'fail'">
          <span class="dot" />
          <div><strong>{{ step.step }}</strong><div class="small muted">{{ step.detail }}</div></div>
        </div>
      </div>
      <CodeBox v-if="autofixResult.exported" :code="autofixResult.exported.files.join('\n')" :label="`Файлы в ${autofixResult.exported.dir}`" :max-height="200" />
    </div>

    <template #footer>
      <button class="btn ghost" @click="showAutofix = false">Закрыть</button>
      <button class="btn primary" @click="runAutofix"><Icon name="wand" /> {{ autofixForm.mode === 'apply' ? 'Применить' : 'Подготовить файлы' }}</button>
    </template>
  </Modal>
</template>
