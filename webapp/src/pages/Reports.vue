<script setup>
import { onMounted, ref } from 'vue'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { dateTime, delta } from '../composables/useFormat.js'
import { hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Tabs from '../components/ui/Tabs.vue'
import Icon from '../components/ui/Icon.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const days = ref(14)
const list = useRequest(() => api.get('/reports'))
const current = ref(null)
const busy = ref(false)
const error = ref('')

async function generate() {
  busy.value = true
  error.value = ''
  try {
    current.value = await api.post('/reports', { days: days.value })
    hapticNotify('success')
    await list.run()
  } catch (e) {
    error.value = e.message
    hapticNotify('error')
  } finally {
    busy.value = false
  }
}

async function openReport(r) {
  error.value = ''
  try {
    current.value = await api.get(`/reports/${r.id}`)
  } catch (e) {
    error.value = e.message
  }
}

onMounted(list.run)
</script>

<template>
  <div class="page">
    <div>
      <div class="page-title">Отчёты</div>
      <div class="page-sub">Сводка за период с сравнением с предыдущим</div>
    </div>

    <Card>
      <div class="stack">
        <Tabs v-model="days" :items="[{ value: 7, label: '7 дней' }, { value: 14, label: '14 дней' }, { value: 30, label: '30 дней' }]" />
        <Button variant="primary" block :loading="busy" @click="generate"><Icon name="file" :size="16" /> Сформировать</Button>
        <div v-if="error" class="notice notice-error">{{ error }}</div>
      </div>
    </Card>

    <template v-if="current">
      <div class="section-title">{{ current.title }}</div>
      <div class="grid-2">
        <Card v-for="k in current.kpis" :key="k.label">
          <div class="kpi-label">{{ k.label }}</div>
          <div class="kpi-value small-value">{{ k.value ?? '—' }}<span class="unit"> {{ k.unit }}</span></div>
          <div class="kpi-delta" :class="delta(k.delta).tone">{{ delta(k.delta).text }} к прошлому</div>
        </Card>
      </div>
      <Card v-for="s in current.sections" :key="s.title" :title="s.title">
        <ul class="bullets">
          <li v-for="(b, i) in s.bullets" :key="i">{{ b }}</li>
        </ul>
      </Card>
    </template>

    <Card title="История">
      <EmptyState v-if="list.data.value && !list.data.value.length" icon="file" title="Отчётов пока нет" />
      <div v-else class="list">
        <div v-for="r in list.data.value || []" :key="r.id" class="list-item clickable-row" @click="openReport(r)">
          <div class="grow">
            <div class="small">{{ r.title }}</div>
            <div class="xs muted">{{ dateTime(r.created_at) }}</div>
          </div>
          <Icon name="chevron" :size="16" class="muted" />
        </div>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.small-value { font-size: var(--text-xl); }
.unit { font-size: var(--text-sm); color: var(--text-3); font-weight: 500; }
.bullets { margin: 0; padding-left: 18px; color: var(--text-2); font-size: var(--text-sm); display: flex; flex-direction: column; gap: 6px; line-height: 1.5; }
.clickable-row { cursor: pointer; }
</style>
