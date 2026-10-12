<script setup>
import { onMounted, ref, computed } from 'vue'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { rub, VERDICT_LABEL, VERDICT_TONE } from '../composables/useFormat.js'
import { hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Badge from '../components/ui/Badge.vue'
import Gauge from '../components/charts/Gauge.vue'
import ProgressBar from '../components/ui/ProgressBar.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const { data, loading, error, run } = useRequest(() => api.get('/bot-shield?days=14'))
const busyId = ref(null)
const actionMsg = ref({ type: '', text: '' })

const cleanScore = computed(() => {
  if (!data.value) return 0
  const items = data.value.items
  if (!items.length) return 100
  const avg = items.reduce((s, i) => s + i.score, 0) / items.length
  return Math.round(100 - avg)
})

async function suspend(item) {
  busyId.value = item.campaign_id
  actionMsg.value = { type: '', text: '' }
  try {
    await api.post(`/campaigns/${item.campaign_id}/suspend`)
    actionMsg.value = { type: 'ok', text: `«${item.name}» приостановлена` }
    hapticNotify('success')
    await run()
  } catch (e) {
    actionMsg.value = { type: 'error', text: e.message }
    hapticNotify('error')
  } finally {
    busyId.value = null
  }
}

onMounted(run)
</script>

<template>
  <div class="page">
    <div>
      <div class="page-title">Bot Shield</div>
      <div class="page-sub">Поиск накрутки и ботового трафика, 14 дней</div>
    </div>

    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <Skeleton v-if="loading && !data" :height="140" :lines="2" />

    <template v-if="data">
      <Card>
        <div class="gauge-row">
          <Gauge :value="cleanScore" label="чистота трафика" :size="150" />
          <div class="grow stack">
            <div><div class="kpi-value">{{ data.risk_count }}</div><div class="muted small">кампаний с риском</div></div>
            <div><div class="num neg small">{{ rub(data.wasted_kop) }}</div><div class="muted small">расход под подозрением</div></div>
          </div>
        </div>
      </Card>

      <div v-if="actionMsg.text" class="notice" :class="actionMsg.type === 'ok' ? 'notice-ok' : 'notice-error'">{{ actionMsg.text }}</div>

      <EmptyState v-if="!data.items.length" icon="shield" title="Нечего проверять"
        text="Нужна синхронизация статистики Директа за последние дни." />

      <Card v-for="item in data.items" :key="item.campaign_id" :title="item.name">
        <div class="row-between">
          <Badge :tone="VERDICT_TONE[item.verdict].replace('badge-', '')">{{ VERDICT_LABEL[item.verdict] }}</Badge>
          <span class="num small muted">риск {{ item.score }}/100</span>
        </div>
        <div class="stack flags-block">
          <ProgressBar :value="item.score" :tone="item.verdict === 'high' ? 'red' : item.verdict === 'medium' ? 'amber' : 'green'" />
          <ul v-if="item.flags.length" class="flags">
            <li v-for="(f, i) in item.flags" :key="i">{{ f }}</li>
          </ul>
          <div v-else class="muted small">Признаков накрутки нет</div>
          <div class="row-between small">
            <span class="muted">Расход: {{ rub(item.cost_kop) }}</span>
            <span v-if="item.wasted_kop" class="neg">под подозрением {{ rub(item.wasted_kop) }}</span>
          </div>
          <Button v-if="item.verdict === 'high'" variant="danger" block :loading="busyId === item.campaign_id" @click="suspend(item)">
            Приостановить кампанию
          </Button>
        </div>
      </Card>
    </template>
  </div>
</template>

<style scoped>
.gauge-row { display: flex; align-items: center; gap: var(--s-4); }
.flags-block { margin-top: var(--s-3); }
.flags { margin: 0; padding-left: 18px; color: var(--text-2); font-size: var(--text-sm); display: flex; flex-direction: column; gap: 4px; }
</style>
