<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { Hypothesis, ScheduleRule, ScheduleRun } from '@mark/shared';
import { api } from '@/api/client';
import { subscribeChannels } from '@/api/realtime';
import { useAppStore } from '@/stores/app';
import Icon from '@/components/Icon.vue';
import Modal from '@/components/Modal.vue';
import StatusPill from '@/components/StatusPill.vue';
import EmptyState from '@/components/EmptyState.vue';
import CodeBox from '@/components/CodeBox.vue';

/**
 * Автооптимизация по cron: правила, ручной прогон, подтверждение изменений
 * и полный цикл «одной кнопкой» (аудит → фиксы → GEO → Market → гипотезы → отчёт).
 */

const store = useAppStore();
const rules = ref<(ScheduleRule & { scheduleDescription?: string; active?: boolean })[]>([]);
const runs = ref<ScheduleRun[]>([]);
const cronHelp = ref<{ expression: string; description: string }[]>([]);
const busy = ref(false);
const showCreate = ref(false);
const selectedRun = ref<ScheduleRun | null>(null);
const runLog = ref<string[]>([]);
const quickResult = ref<{ runId: string; tasks: { task: string; status: string; summary?: string }[] } | null>(null);

const form = reactive({
  name: '',
  ruleType: 'bid_down' as ScheduleRule['ruleType'],
  cron: '0 10 * * *',
  timezone: 'Europe/Moscow',
  requiresApproval: true,
  notify: ['inapp'] as ('inapp' | 'telegram' | 'email')[],
  threshold: 2000,
  adjustPercent: -15,
  maxChangesPerRun: 20,
  clientId: '',
});

onMounted(load);

async function load(): Promise<void> {
  const payload = await store.call(
    () => api.get<{ rules: typeof rules.value; runs: ScheduleRun[]; cronHelp: { expression: string; description: string }[] }>('/api/schedules'),
    'Не удалось загрузить правила',
  );
  if (!payload) return;
  rules.value = payload.rules;
  runs.value = payload.runs;
  cronHelp.value = payload.cronHelp;
}

async function installPresets(): Promise<void> {
  busy.value = true;
  const created = await store.call(() => api.post<ScheduleRule[]>('/api/schedules/presets', { clientId: store.activeClientId || null }), 'Не удалось установить правила');
  busy.value = false;
  if (created) {
    store.toast('success', `Установлено правил: ${created.length}`, 'Автооптимизация работает по расписанию: снижение ставок, паузы, минус-слова, отчёты.');
    await load();
  }
}

async function createRule(): Promise<void> {
  const payload = {
    name: form.name || 'Новое правило',
    ruleType: form.ruleType,
    cron: form.cron,
    timezone: form.timezone,
    enabled: true,
    requiresApproval: form.requiresApproval,
    notify: form.notify,
    clientId: form.clientId || store.activeClientId || null,
    maxChangesPerRun: form.maxChangesPerRun,
    searchOnly: true,
    params: {
      metric: form.ruleType === 'bid_up' ? 'clicks' : 'cpa',
      threshold: form.threshold,
      comparison: form.ruleType === 'bid_up' ? 'lt' : 'gt',
      windowDays: 7,
      adjustPercent: form.adjustPercent,
      minClicks: 30,
      maxAppliesPerRun: form.maxChangesPerRun,
      targetCpa: form.threshold,
    },
  };
  const created = await store.call(() => api.post<ScheduleRule>('/api/schedules', payload), 'Не удалось создать правило');
  if (created) {
    showCreate.value = false;
    store.toast('success', 'Правило создано', `Расписание: ${form.cron} (${form.timezone})`);
    await load();
  }
}

async function toggle(rule: ScheduleRule & { active?: boolean }): Promise<void> {
  const updated = await store.call(() => api.patch<ScheduleRule>(`/api/schedules/${rule.id}`, { enabled: !rule.enabled }), 'Не удалось изменить правило');
  if (updated) await load();
}

async function remove(rule: ScheduleRule): Promise<void> {
  if (!window.confirm(`Удалить правило «${rule.name}»?`)) return;
  await store.call(() => api.delete(`/api/schedules/${rule.id}`), 'Не удалось удалить правило');
  await load();
}

async function runNow(rule: ScheduleRule, dryRun: boolean): Promise<void> {
  busy.value = true;
  const run = await store.call(
    () => api.post<ScheduleRun>(`/api/schedules/${rule.id}/run`, { dryRun }),
    'Прогон не удался',
  );
  busy.value = false;
  if (!run) return;
  selectedRun.value = run;
  store.toast(
    run.status === 'awaiting_approval' ? 'info' : run.status === 'failed' ? 'error' : 'success',
    `Прогон: ${run.status}`,
    `${run.summary}. Проверено ${run.evaluated}, изменений ${run.changed}${dryRun ? ' (без применения)' : ''}.`,
  );
  await load();
}

async function approve(run: ScheduleRun): Promise<void> {
  const result = await store.call(() => api.post<ScheduleRun>(`/api/schedules/runs/${run.id}/approve`, {}), 'Не удалось подтвердить изменения');
  if (result) {
    store.toast('success', 'Изменения применены', result.summary);
    await load();
  }
}

async function fullCycle(): Promise<void> {
  if (!store.activeClientId) {
    store.toast('warning', 'Выберите клиента', 'Полный цикл выполняется по конкретному клиенту — переключите его в шапке.');
    return;
  }
  busy.value = true;
  quickResult.value = null;
  runLog.value = [];
  const started = await store.call(
    () => api.post<{ runId: string; channel: string }>('/api/quick-run', { clientId: store.activeClientId }),
    'Не удалось запустить полный цикл',
  );
  if (!started) {
    busy.value = false;
    return;
  }
  quickResult.value = { runId: started.runId, tasks: [] };
  const stop = subscribeChannels([started.channel], (event) => {
    const payload = event.payload as { task?: string; status?: string; summary?: string; steps?: { task: string; status: string; summary: string }[] };
    if (event.type === 'step' && payload.task) {
      const existing = quickResult.value!.tasks.find((item) => item.task === payload.task);
      if (existing) Object.assign(existing, { status: payload.status ?? existing.status, summary: payload.summary ?? existing.summary });
      else quickResult.value!.tasks.push({ task: payload.task, status: payload.status ?? 'running', summary: payload.summary });
    }
    if (event.type === 'finished' && payload.steps) {
      quickResult.value!.tasks = payload.steps.map((step) => ({ task: step.task, status: step.status, summary: step.summary }));
    }
    if (payload.task || payload.summary) runLog.value.push(`${event.type}: ${payload.task ?? ''} ${payload.summary ?? ''}`.trim());
    if (event.type === 'finished') {
      busy.value = false;
      stop();
      void load();
    }
  });
}

const approvalRuns = computed(() => runs.value.filter((run) => run.status === 'awaiting_approval'));
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <h3>Полный цикл одной кнопкой</h3>
        <div class="sub">Аудит → автоисправления → GEO → Market → гипотезы → отчёт для клиента. Прогресс виден в реальном времени.</div>
      </div>
      <div class="row">
        <button class="btn primary" :disabled="busy" @click="fullCycle"><span v-if="busy" class="spinner" /><Icon v-else name="bolt" /> Запустить полный цикл</button>
        <button class="btn" @click="installPresets"><Icon name="plus" /> Установить готовые правила</button>
      </div>
    </div>

    <div v-if="quickResult" class="grid" style="gap: 10px">
      <div class="steps">
        <div v-for="task in quickResult.tasks" :key="task.task" class="step" :class="task.status === 'done' ? 'pass' : task.status === 'failed' ? 'fail' : 'running'">
          <span class="dot" />
          <div><strong>{{ task.task }}</strong><div class="small muted">{{ task.summary }}</div></div>
        </div>
        <div v-if="!quickResult.tasks.length" class="small muted">Задача {{ quickResult.runId }} выполняется…</div>
      </div>
      <pre v-if="runLog.length" class="log">{{ runLog.slice(-40).join('\n') }}</pre>
    </div>
  </div>

  <div v-if="approvalRuns.length" class="card">
    <div class="card-head">
      <div>
        <h3>Ждут подтверждения</h3>
        <div class="sub">Правила с обязательным подтверждением подготовили изменения — проверьте и примените</div>
      </div>
    </div>
    <table>
      <thead><tr><th>Правило</th><th>Когда</th><th class="num">Изменений</th><th>Сводка</th><th /></tr></thead>
      <tbody>
        <tr v-for="run in approvalRuns" :key="run.id">
          <td>{{ run.ruleName }}</td>
          <td class="small muted">{{ new Date(run.startedAt).toLocaleString('ru-RU') }}</td>
          <td class="num">{{ run.changed }}</td>
          <td class="small muted">{{ run.summary }}</td>
          <td class="num">
            <div class="row" style="justify-content: flex-end">
              <button class="btn ghost sm" @click="selectedRun = run"><Icon name="eye" /></button>
              <button class="btn primary sm" @click="approve(run)"><Icon name="check" /> Применить</button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <div class="card-head">
      <div>
        <h3>Правила автооптимизации</h3>
        <div class="sub">Расписания в cron, уведомления в приложении и Telegram, лимит изменений за прогон</div>
      </div>
      <button class="btn sm" @click="showCreate = true"><Icon name="plus" /> Добавить правило</button>
    </div>

    <table v-if="rules.length">
      <thead><tr><th>Правило</th><th>Тип</th><th>Расписание</th><th>Уведомления</th><th>Последний прогон</th><th>Статус</th><th /></tr></thead>
      <tbody>
        <tr v-for="rule in rules" :key="rule.id">
          <td>
            <strong>{{ rule.name }}</strong>
            <div class="small faint">{{ rule.requiresApproval ? 'Требует подтверждения' : 'Применяет автоматически' }} · лимит {{ rule.maxChangesPerRun }} изменений</div>
          </td>
          <td class="small">{{ store.meta?.ruleTypes.find((type) => type.id === rule.ruleType)?.label ?? rule.ruleType }}</td>
          <td class="small mono">{{ rule.cron }}<div class="faint">{{ rule.scheduleDescription }}</div></td>
          <td class="small">{{ rule.notify.join(', ') }}</td>
          <td class="small muted">
            {{ rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString('ru-RU') : '—' }}
            <div v-if="rule.lastResult" class="faint">{{ String(rule.lastResult).slice(0, 80) }}</div>
          </td>
          <td>
            <StatusPill :status="rule.enabled ? (rule.active ? 'active' : 'warn') : 'paused'" :label="rule.enabled ? (rule.active ? 'в планировщике' : 'не запланировано') : 'выключено'" />
          </td>
          <td class="num">
            <div class="row" style="justify-content: flex-end">
              <button class="btn ghost sm" :disabled="busy" title="Прогон без применения" @click="runNow(rule, true)"><Icon name="eye" /></button>
              <button class="btn ghost sm" :disabled="busy" title="Прогон с применением" @click="runNow(rule, false)"><Icon name="play" /></button>
              <button class="btn ghost sm" @click="toggle(rule)"><Icon :name="rule.enabled ? 'close' : 'check'" /></button>
              <button class="btn ghost sm" @click="remove(rule)"><Icon name="trash" /></button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <EmptyState v-else title="Правил пока нет" message="Нажмите «Установить готовые правила» — MARK создаст набор: снижение ставок при дорогом CPA, пауза фраз без конверсий, минус-слова, недельный отчёт." icon="clock" />

    <pre v-if="runLog.length" class="log" style="margin-top: 12px">{{ runLog.slice(-25).join('\n') }}</pre>
  </div>

  <div class="card" v-if="runs.length">
    <div class="card-head"><h3>История прогонов</h3></div>
    <table>
      <thead><tr><th>Правило</th><th>Начало</th><th>Статус</th><th class="num">Проверено</th><th class="num">Изменено</th><th>Сводка</th></tr></thead>
      <tbody>
        <tr v-for="run in runs.slice(0, 20)" :key="run.id">
          <td>{{ run.ruleName }}</td>
          <td class="small muted">{{ new Date(run.startedAt).toLocaleString('ru-RU') }}</td>
          <td><StatusPill :status="run.status" /></td>
          <td class="num">{{ run.evaluated }}</td>
          <td class="num">{{ run.changed }}</td>
          <td class="small muted">{{ run.summary }}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <Modal v-if="showCreate" title="Новое правило автооптимизации" subtitle="Правило срабатывает по cron и может требовать подтверждения перед изменениями" @close="showCreate = false">
    <div class="grid cols-2">
      <div class="field">
        <label>Название</label>
        <input v-model="form.name" type="text" placeholder="Снижение ставок при дорогом CPA" />
      </div>
      <div class="field">
        <label>Тип правила</label>
        <select v-model="form.ruleType">
          <option v-for="type in store.meta?.ruleTypes ?? []" :key="type.id" :value="type.id">{{ type.label }}</option>
        </select>
      </div>
    </div>

    <div class="grid cols-3">
      <div class="field">
        <label>Cron-выражение</label>
        <input v-model="form.cron" type="text" placeholder="0 10 * * *" />
        <div class="hint">
          <span v-for="help in cronHelp" :key="help.expression">{{ help.expression }} — {{ help.description }}; </span>
        </div>
      </div>
      <div class="field">
        <label>Часовой пояс</label>
        <input v-model="form.timezone" type="text" placeholder="Europe/Moscow" />
      </div>
      <div class="field">
        <label>Порог метрики</label>
        <input v-model.number="form.threshold" type="number" step="50" />
      </div>
    </div>

    <div class="grid cols-3">
      <div class="field">
        <label>Изменение ставки, %</label>
        <input v-model.number="form.adjustPercent" type="number" step="1" />
      </div>
      <div class="field">
        <label>Лимит изменений за прогон</label>
        <input v-model.number="form.maxChangesPerRun" type="number" min="1" max="200" />
      </div>
      <div class="field">
        <label>Клиент</label>
        <select v-model="form.clientId">
          <option value="">— все клиенты —</option>
          <option v-for="client in store.clients" :key="client.id" :value="client.id">{{ client.name }}</option>
        </select>
      </div>
    </div>

    <div class="row" style="gap: 16px">
      <label class="checkbox"><input v-model="form.requiresApproval" type="checkbox" /> Требовать подтверждение перед изменениями</label>
      <label class="checkbox"><input v-model="form.notify" type="checkbox" value="inapp" /> уведомление в приложении</label>
      <label class="checkbox"><input v-model="form.notify" type="checkbox" value="telegram" /> Telegram</label>
    </div>

    <template #footer>
      <button class="btn ghost" @click="showCreate = false">Отмена</button>
      <button class="btn primary" @click="createRule"><Icon name="plus" /> Создать правило</button>
    </template>
  </Modal>

  <Modal v-if="selectedRun" :title="selectedRun.ruleName" :subtitle="`Прогон ${selectedRun.id}`" @close="selectedRun = null">
    <div class="row">
      <div class="stat"><span class="label">Проверено</span><span class="value">{{ selectedRun.evaluated }}</span></div>
      <div class="stat"><span class="label">Изменений</span><span class="value">{{ selectedRun.changed }}</span></div>
      <StatusPill :status="selectedRun.status" />
    </div>
    <table v-if="selectedRun.changes?.length" style="margin-top: 10px">
      <thead><tr><th>Объект</th><th>Поле</th><th>Было</th><th>Стало</th><th>Причина</th><th>Статус</th></tr></thead>
      <tbody>
        <tr v-for="(change, index) in selectedRun.changes" :key="index">
          <td class="small">{{ change.target }}</td>
          <td class="small">{{ change.field }}</td>
          <td class="small mono">{{ change.from }}</td>
          <td class="small mono">{{ change.to }}</td>
          <td class="small muted">{{ change.reason }}</td>
          <td><StatusPill :status="change.error ? 'failed' : change.applied ? 'done' : 'warn'" :label="change.error ?? (change.applied ? 'применено' : 'ждёт')" /></td>
        </tr>
      </tbody>
    </table>
    <CodeBox v-if="selectedRun.summary" :code="selectedRun.summary" label="Итог прогона" :max-height="120" />
    <template #footer>
      <button class="btn ghost" @click="selectedRun = null">Закрыть</button>
      <button v-if="selectedRun.status === 'awaiting_approval'" class="btn primary" @click="approve(selectedRun); selectedRun = null"><Icon name="check" /> Применить изменения</button>
    </template>
  </Modal>
</template>
