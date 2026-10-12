<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { ReportRecord } from '@mark/shared';
import { api, downloadFile } from '@/api/client';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import Modal from '@/components/Modal.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';

/**
 * Отчёты: история, просмотр HTML, экспорт в CSV/PDF и доставка клиенту
 * (в приложении, по e-mail через SMTP, в Telegram).
 */

const store = useAppStore();
const items = ref<ReportRecord[]>([]);
const total = ref(0);
const selected = ref<ReportRecord | null>(null);
const previewHtml = ref('');
const busy = ref(false);
const showCreate = ref(false);
const showDeliver = ref(false);
const deliverTarget = ref<ReportRecord | null>(null);

const form = reactive({
  type: 'summary' as ReportRecord['type'],
  periodFrom: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
  periodTo: new Date().toISOString().slice(0, 10),
  includeCharts: true,
  brand: true,
  delivery: ['download'] as ('download' | 'email' | 'telegram')[],
});

const deliverForm = reactive({ channels: ['download'] as ('download' | 'email' | 'telegram')[], recipients: '' });

onMounted(load);

async function load(): Promise<void> {
  const payload = await store.call(
    () => api.get<{ items: ReportRecord[]; total: number }>(`/api/reports?limit=50${store.activeClientId ? `&clientId=${store.activeClientId}` : ''}`),
    'Не удалось загрузить отчёты',
  );
  if (!payload) return;
  items.value = payload.items;
  total.value = payload.total;
  if (!selected.value && items.value[0]) await open(items.value[0]);
}

async function create(): Promise<void> {
  busy.value = true;
  const report = await store.call(
    () =>
      api.post<ReportRecord & { delivery?: { channel: string; status: string; error?: string }[] }>('/api/reports', {
        type: form.type,
        clientId: store.activeClientId || null,
        periodFrom: form.periodFrom,
        periodTo: form.periodTo,
        includeCharts: form.includeCharts,
        brand: form.brand,
        delivery: form.delivery,
      }),
    'Не удалось собрать отчёт',
  );
  busy.value = false;
  if (!report) return;
  showCreate.value = false;
  await load();
  await open(report);
  const failed = (report.delivery ?? []).filter((item) => item.status === 'failed');
  store.toast(failed.length ? 'warning' : 'success', 'Отчёт готов', failed.length ? `Доставка с ошибками: ${failed.map((item) => `${item.channel}: ${item.error}`).join('; ')}` : 'Открыт в предпросмотре.');
}

async function open(report: ReportRecord): Promise<void> {
  selected.value = report;
  previewHtml.value = '';
  const html = await fetch(api.fileUrl(`/api/reports/${report.id}/html`)).then((response) => (response.ok ? response.text() : ''));
  previewHtml.value = html || '<p style="padding:16px">HTML-версия готовится…</p>';
}

async function remove(report: ReportRecord): Promise<void> {
  if (!window.confirm(`Удалить отчёт «${report.title}»?`)) return;
  await store.call(() => api.delete(`/api/reports/${report.id}`), 'Не удалось удалить отчёт');
  if (selected.value?.id === report.id) selected.value = null;
  await load();
}

async function exportPdf(report: ReportRecord): Promise<void> {
  busy.value = true;
  const response = await fetch(api.fileUrl(`/api/reports/${report.id}/pdf`));
  busy.value = false;

  if (!response.ok) {
    store.toast('warning', 'PDF не сформирован', 'Открыл печатную версию — сохраните её как PDF средствами браузера.');
    window.open(api.fileUrl(`/api/reports/${report.id}/html?print=1`), '_blank');
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${report.title}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  store.toast('success', 'PDF сохранён');
}

async function deliver(): Promise<void> {
  if (!deliverTarget.value) return;
  busy.value = true;
  const results = await store.call(
    () =>
      api.post<{ channel: string; status: string; error?: string }[]>(`/api/reports/${deliverTarget.value!.id}/deliver`, {
        channels: deliverForm.channels,
        recipients: deliverForm.recipients.split(',').map((value) => value.trim()).filter(Boolean),
      }),
    'Не удалось отправить отчёт',
  );
  busy.value = false;
  if (!results) return;
  showDeliver.value = false;
  const failed = results.filter((item) => item.status === 'failed');
  store.toast(failed.length ? 'warning' : 'success', failed.length ? 'Часть каналов не сработала' : 'Отчёт отправлен', failed.map((item) => `${item.channel}: ${item.error}`).join('; ') || results.map((item) => item.channel).join(', '));
  await load();
}

const kpis = computed(() => selected.value?.kpis ?? []);
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <h3>Отчёты клиентам</h3>
        <div class="sub">Белая метка: логотип и цвета агентства из раздела «Белая метка». Всего отчётов: {{ total }}</div>
      </div>
      <div class="row">
        <button class="btn sm" @click="load"><Icon name="refresh" /> Обновить</button>
        <button class="btn primary sm" @click="showCreate = true"><Icon name="plus" /> Собрать отчёт</button>
      </div>
    </div>

    <table v-if="items.length">
      <thead><tr><th>Отчёт</th><th>Тип</th><th>Период</th><th>Статус</th><th class="num">Размер</th><th>Создан</th><th /></tr></thead>
      <tbody>
        <tr v-for="report in items" :key="report.id">
          <td><strong>{{ report.title }}</strong><div class="small faint">{{ report.id }}</div></td>
          <td class="small">{{ report.type }}</td>
          <td class="small muted">{{ report.periodFrom }} — {{ report.periodTo }}</td>
          <td><StatusPill :status="report.status" /></td>
          <td class="num small">{{ report.fileSizeBytes ? `${(report.fileSizeBytes / 1024).toFixed(0)} КБ` : '—' }}</td>
          <td class="small muted">{{ new Date(report.createdAt).toLocaleString('ru-RU') }}</td>
          <td class="num">
            <div class="row" style="justify-content: flex-end">
              <button class="btn ghost sm" title="Открыть" @click="open(report)"><Icon name="eye" /></button>
              <button class="btn ghost sm" title="CSV" @click="downloadFile(`/api/reports/${report.id}/csv`, `${report.title}.csv`)"><Icon name="download" /></button>
              <button class="btn ghost sm" title="PDF" @click="exportPdf(report)"><Icon name="file" /></button>
              <button class="btn ghost sm" title="Отправить" @click="deliverTarget = report; deliverForm.recipients = ''; showDeliver = true"><Icon name="external" /></button>
              <button class="btn ghost sm" title="Удалить" @click="remove(report)"><Icon name="trash" /></button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <EmptyState v-else title="Отчётов пока нет" message="Соберите первый отчёт: SEO, GEO, BotShield, гипотезы или общий свод. Его можно сразу отправить клиенту." icon="file">
      <button class="btn primary" @click="showCreate = true"><Icon name="plus" /> Собрать отчёт</button>
    </EmptyState>
  </div>

  <div v-if="selected" class="card">
    <div class="card-head">
      <div>
        <h3>{{ selected.title }}</h3>
        <div class="sub">Период {{ selected.periodFrom }} — {{ selected.periodTo }} · {{ selected.branding?.agencyName ?? 'MARK' }}</div>
      </div>
      <div class="row">
        <button class="btn sm" @click="downloadFile(`/api/reports/${selected.id}/html`, `${selected.title}.html`)"><Icon name="download" /> HTML</button>
        <button class="btn sm" @click="downloadFile(`/api/reports/${selected.id}/csv`, `${selected.title}.csv`)"><Icon name="download" /> CSV</button>
        <button class="btn sm" @click="exportPdf(selected)"><Icon name="file" /> PDF</button>
        <button class="btn sm" @click="deliverTarget = selected; showDeliver = true"><Icon name="external" /> Отправить</button>
      </div>
    </div>

    <div class="grid cols-4" style="margin-bottom: 12px">
      <div v-for="kpi in kpis" :key="kpi.label" class="stat">
        <span class="label">{{ kpi.label }}</span>
        <span class="value" style="font-size: 18px">{{ kpi.value }}</span>
        <span v-if="kpi.delta !== undefined && kpi.delta !== null" class="delta" :style="{ color: kpi.delta >= 0 ? '#86efac' : '#fca5a5' }">{{ kpi.delta >= 0 ? '+' : '' }}{{ kpi.delta }}%</span>
      </div>
    </div>

    <iframe :srcdoc="previewHtml" style="width: 100%; height: 620px; border: 1px solid var(--border); border-radius: var(--radius); background: white" title="Предпросмотр отчёта" />
  </div>

  <Modal v-if="showCreate" title="Собрать отчёт" subtitle="Данные берутся из модулей MARK: аудиты, GEO, BotShield, кампании, гипотезы" @close="showCreate = false">
    <div class="grid cols-2">
      <div class="field">
        <label>Тип отчёта</label>
        <select v-model="form.type">
          <option value="summary">Общий свод для клиента</option>
          <option value="seo">SEO-аудит</option>
          <option value="geo">GEO продвижение</option>
          <option value="bot">BotShield (чистота трафика)</option>
          <option value="market">Рынок и ставки</option>
          <option value="campaigns">Рекламные кампании</option>
          <option value="hypotheses">Гипотезы и тесты</option>
        </select>
      </div>
      <div class="field">
        <label>Клиент</label>
        <select :value="store.activeClientId" disabled>
          <option :value="store.activeClientId">{{ store.activeClient?.name ?? 'Все клиенты' }}</option>
        </select>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="field"><label>Период с</label><input v-model="form.periodFrom" type="date" /></div>
      <div class="field"><label>Период по</label><input v-model="form.periodTo" type="date" /></div>
    </div>

    <div class="row" style="gap: 16px; margin-bottom: 8px">
      <label class="checkbox"><input v-model="form.includeCharts" type="checkbox" /> включать графики</label>
      <label class="checkbox"><input v-model="form.brand" type="checkbox" /> оформление агентства (белая метка)</label>
    </div>

    <div class="field">
      <label>Доставка сразу после сборки</label>
      <div class="row" style="gap: 16px">
        <label class="checkbox"><input v-model="form.delivery" type="checkbox" value="download" /> в приложении</label>
        <label class="checkbox"><input v-model="form.delivery" type="checkbox" value="email" /> e-mail (SMTP)</label>
        <label class="checkbox"><input v-model="form.delivery" type="checkbox" value="telegram" /> Telegram</label>
      </div>
    </div>

    <template #footer>
      <button class="btn ghost" @click="showCreate = false">Отмена</button>
      <button class="btn primary" :disabled="busy" @click="create"><span v-if="busy" class="spinner" /><Icon v-else name="file" /> Собрать отчёт</button>
    </template>
  </Modal>

  <Modal v-if="showDeliver" size="sm" :title="`Отправить: ${deliverTarget?.title ?? ''}`" @close="showDeliver = false">
    <div class="field">
      <label>Каналы</label>
      <div class="row" style="gap: 16px">
        <label class="checkbox"><input v-model="deliverForm.channels" type="checkbox" value="download" /> в приложении</label>
        <label class="checkbox"><input v-model="deliverForm.channels" type="checkbox" value="email" /> e-mail</label>
        <label class="checkbox"><input v-model="deliverForm.channels" type="checkbox" value="telegram" /> Telegram</label>
      </div>
    </div>
    <div class="field">
      <label>Получатели (через запятую)</label>
      <input v-model="deliverForm.recipients" type="text" placeholder="client@example.ru, boss@example.ru" />
      <div class="hint">Для e-mail нужен подключённый SMTP-сервер, для Telegram — бот в разделе «Подключения».</div>
    </div>
    <template #footer>
      <button class="btn ghost" @click="showDeliver = false">Отмена</button>
      <button class="btn primary" :disabled="busy" @click="deliver"><Icon name="external" /> Отправить</button>
    </template>
  </Modal>
</template>
