<script setup>
import { onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { rub, num, pct, ACTION_LABEL, STATUS_LABEL } from '../composables/useFormat.js'
import Card from '../components/ui/Card.vue'
import Badge from '../components/ui/Badge.vue'
import Icon from '../components/ui/Icon.vue'
import Tabs from '../components/ui/Tabs.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import EmptyState from '../components/ui/EmptyState.vue'

const days = ref(14)
const { data, loading, error, run } = useRequest(() => api.get(`/campaigns?days=${days.value}`))
watch(days, run)
onMounted(run)

const actionTone = { pause: 'red', decrease_bid: 'amber', increase_bid: 'green', keep: 'neutral' }
</script>

<template>
  <div class="page">
    <div class="row-between">
      <div>
        <div class="page-title">Кампании</div>
        <div class="page-sub">Яндекс Директ, {{ days }} дней</div>
      </div>
      <Tabs v-model="days" :items="[{ value: 7, label: '7д' }, { value: 14, label: '14д' }, { value: 30, label: '30д' }]" />
    </div>

    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <Skeleton v-if="loading && !data" :height="86" :lines="4" />

    <EmptyState v-if="data && !data.items.length" icon="megaphone" title="Кампаний пока нет"
      text="Подключи Директ и запусти синхронизацию в подключениях.">
      <RouterLink to="/connect"><button class="btn btn-primary btn-sm">Подключить</button></RouterLink>
    </EmptyState>

    <Card v-for="c in data?.items || []" :key="c.campaign_id" clickable @click="$router.push(`/campaigns/${c.campaign_id}`)">
      <div class="row-between">
        <div class="grow">
          <div class="ellipsis campaign-name">{{ c.name }}</div>
          <div class="muted xs">{{ STATUS_LABEL[c.status] || c.status }}</div>
        </div>
        <Icon name="chevron" :size="16" class="muted" />
      </div>
      <div class="metrics">
        <div><div class="xs muted">Расход</div><div class="num small">{{ rub(c.summary.cost_kop) }}</div></div>
        <div><div class="xs muted">Клики</div><div class="num small">{{ num(c.summary.clicks) }}</div></div>
        <div><div class="xs muted">CTR</div><div class="num small">{{ pct(c.summary.ctr) }}</div></div>
        <div><div class="xs muted">CPA</div><div class="num small">{{ c.summary.cpa_kop ? rub(c.summary.cpa_kop) : '—' }}</div></div>
      </div>
      <div v-if="c.recommendation" class="rec">
        <Badge :tone="actionTone[c.recommendation.action]">{{ ACTION_LABEL[c.recommendation.action] }}</Badge>
        <span class="xs muted rec-text">{{ c.recommendation.reason }}</span>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.campaign-name { font-weight: 600; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s-2); margin-top: var(--s-3); }
.rec { display: flex; align-items: center; gap: var(--s-2); margin-top: var(--s-3); flex-wrap: wrap; }
.rec-text { flex: 1; min-width: 160px; }
</style>
