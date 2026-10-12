<script setup>
import { onMounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { rub, num, pct, shortDate, ACTION_LABEL, STATUS_LABEL } from '../composables/useFormat.js'
import { hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Badge from '../components/ui/Badge.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import AreaChart from '../components/charts/AreaChart.vue'
import Icon from '../components/ui/Icon.vue'

const route = useRoute()
const id = computed(() => route.params.id)
const { data, loading, error, run } = useRequest(() => api.get(`/campaigns/${id.value}?days=14`))
const actionError = ref('')
const actionBusy = ref(false)

async function toggle() {
  const action = data.value.campaign.status === 'SUSPENDED' ? 'resume' : 'suspend'
  actionBusy.value = true
  actionError.value = ''
  try {
    await api.post(`/campaigns/${id.value}/${action}`)
    hapticNotify('success')
    await run()
  } catch (e) {
    actionError.value = e.message
    hapticNotify('error')
  } finally {
    actionBusy.value = false
  }
}

onMounted(run)
</script>

<template>
  <div class="page">
    <Skeleton v-if="loading && !data" :height="120" :lines="2" />
    <div v-if="error" class="notice notice-error">{{ error }}</div>

    <template v-if="data">
      <div>
        <div class="page-title campaign-title">{{ data.campaign.name }}</div>
        <div class="page-sub">{{ STATUS_LABEL[data.campaign.status] || data.campaign.status }} · за 14 дней</div>
      </div>

      <div class="grid-2">
        <Card><div class="kpi-label">Расход</div><div class="kpi-value">{{ rub(data.summary.cost_kop) }}</div></Card>
        <Card><div class="kpi-label">Клики</div><div class="kpi-value">{{ num(data.summary.clicks) }}</div></Card>
        <Card><div class="kpi-label">CTR</div><div class="kpi-value">{{ pct(data.summary.ctr) }}</div></Card>
        <Card><div class="kpi-label">CPA</div><div class="kpi-value">{{ data.summary.cpa_kop ? rub(data.summary.cpa_kop) : '—' }}</div></Card>
      </div>

      <Card title="Расход по дням">
        <AreaChart v-if="data.series.length > 1" :values="data.series.map((d) => d.cost_kop / 100)" :labels="data.series.map((d) => shortDate(d.date))" :height="120" />
        <div v-else class="muted small">Недостаточно данных</div>
      </Card>

      <Card title="Рекомендация скрипта">
        <div class="row">
          <Badge :tone="data.recommendation.action === 'pause' ? 'red' : data.recommendation.action === 'keep' ? 'neutral' : 'amber'">
            {{ ACTION_LABEL[data.recommendation.action] }}
          </Badge>
          <span v-if="data.recommendation.bid_change_pct" class="small num">{{ data.recommendation.bid_change_pct > 0 ? '+' : '' }}{{ data.recommendation.bid_change_pct }}%</span>
        </div>
        <p class="muted-2 small reason">{{ data.recommendation.reason }}</p>
        <div class="hint">Целевой CPA: {{ data.target_cpa_kop ? rub(data.target_cpa_kop) : 'не задан (Настройки)' }}</div>
      </Card>

      <div v-if="actionError" class="notice notice-error">{{ actionError }}</div>
      <Button block :variant="data.campaign.status === 'SUSPENDED' ? 'primary' : 'danger'" :loading="actionBusy" @click="toggle">
        <Icon :name="data.campaign.status === 'SUSPENDED' ? 'play' : 'pause'" :size="16" />
        {{ data.campaign.status === 'SUSPENDED' ? 'Запустить кампанию' : 'Приостановить кампанию' }}
      </Button>
      <div class="hint">Действие уходит в Яндекс Директ через API и требует подключённого токена.</div>
    </template>
  </div>
</template>

<style scoped>
.campaign-title { font-size: var(--text-xl); word-break: break-word; }
.reason { margin: var(--s-2) 0 0; line-height: 1.5; }
</style>
