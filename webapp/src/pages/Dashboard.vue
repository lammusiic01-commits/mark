<script setup>
import { onMounted, ref, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { rub, num, pct, shortDate, delta, ACTION_LABEL, STATUS_LABEL } from '../composables/useFormat.js'
import { telegramUser } from '../composables/useTelegram.js'
import { haptic, hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Icon from '../components/ui/Icon.vue'
import Badge from '../components/ui/Badge.vue'
import Skeleton from '../components/ui/Skeleton.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import AreaChart from '../components/charts/AreaChart.vue'

const { data, loading, error, run } = useRequest(() => api.get('/dashboard?days=14'))
const advice = ref(null)
const adviceBusy = ref(false)
const adviceError = ref('')
const user = telegramUser()

const clicksSeries = computed(() => (data.value?.series || []).map((d) => d.clicks))
const seriesLabels = computed(() => (data.value?.series || []).map((d) => shortDate(d.date)))

async function getAdvice() {
  adviceBusy.value = true
  adviceError.value = ''
  haptic('light')
  try {
    advice.value = await api.post('/dashboard/advice', { days: 14 })
    hapticNotify('success')
  } catch (e) {
    adviceError.value = e.message
    hapticNotify('error')
  } finally {
    adviceBusy.value = false
  }
}

onMounted(run)
</script>

<template>
  <div class="page">
    <div class="row-between">
      <div>
        <div class="page-title">Главная</div>
        <div class="page-sub">
          {{ user?.first_name ? `${user.first_name}, ` : '' }}последние 14 дней
          <span v-if="data?.last_sync_at"> · обновлено {{ new Date(data.last_sync_at + 'Z').toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }}</span>
        </div>
      </div>
      <Button size="sm" :loading="loading" @click="run"><Icon name="refresh" :size="14" /></Button>
    </div>

    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <Skeleton v-if="loading && !data" :height="110" :lines="3" />

    <template v-if="data">
      <EmptyState v-if="!data.connected" icon="plug" title="Яндекс Директ не подключён" text="Добавь токен, и здесь появится статистика кампаний.">
        <RouterLink to="/connect"><Button variant="primary" size="sm">Подключить</Button></RouterLink>
      </EmptyState>

      <div class="grid-2">
        <Card>
          <div class="kpi-label">Расход</div>
          <div class="kpi-value">{{ rub(data.summary.cost_kop) }}</div>
        </Card>
        <Card>
          <div class="kpi-label">Клики</div>
          <div class="kpi-value">{{ num(data.summary.clicks) }}</div>
        </Card>
        <Card>
          <div class="kpi-label">CTR</div>
          <div class="kpi-value">{{ pct(data.summary.ctr) }}</div>
        </Card>
        <Card>
          <div class="kpi-label">CPA</div>
          <div class="kpi-value">{{ data.summary.cpa_kop ? rub(data.summary.cpa_kop) : '—' }}</div>
          <div class="kpi-delta muted">конверсий: {{ num(data.summary.conversions) }}</div>
        </Card>
      </div>

      <Card title="Клики по дням">
        <AreaChart v-if="clicksSeries.length > 1" :values="clicksSeries" :labels="seriesLabels" :height="120" />
        <div v-else class="muted small">Пока мало данных. Синхронизируй кампании в подключениях.</div>
      </Card>

      <Card title="Защита от накрутки">
        <div class="row-between">
          <div>
            <div class="kpi-value">{{ data.risk.risk_count }}</div>
            <div class="muted small">кампаний с риском</div>
          </div>
          <div class="right">
            <div class="num small neg">{{ rub(data.risk.wasted_kop) }}</div>
            <div class="muted small">под подозрением</div>
          </div>
        </div>
        <RouterLink to="/bot-shield" class="link-row small">Открыть Bot Shield <Icon name="chevron" :size="14" /></RouterLink>
      </Card>

      <Card v-if="data.recommendations.length" title="Рекомендации">
        <div class="list">
          <div v-for="r in data.recommendations" :key="r.campaign_id" class="list-item">
            <div class="grow">
              <div class="ellipsis">{{ r.name }}</div>
              <div class="muted xs">{{ r.reason }}</div>
            </div>
            <Badge :tone="r.action === 'pause' ? 'red' : r.action === 'increase_bid' ? 'green' : 'amber'">
              {{ ACTION_LABEL[r.action] }}
            </Badge>
          </div>
        </div>
      </Card>

      <Card title="Воронка">
        <div class="small muted-2">{{ data.funnel.advice }}</div>
        <RouterLink to="/funnel" class="link-row small">Подробнее <Icon name="chevron" :size="14" /></RouterLink>
      </Card>

      <Card v-if="data.top_campaigns.length" title="Топ кампаний по расходу">
        <div class="list">
          <RouterLink v-for="c in data.top_campaigns" :key="c.campaign_id" :to="`/campaigns/${c.campaign_id}`" class="list-item link-plain">
            <div class="grow">
              <div class="ellipsis">{{ c.name }}</div>
              <div class="muted xs">{{ STATUS_LABEL[c.status] || c.status }} · CTR {{ pct(c.summary.ctr) }}</div>
            </div>
            <div class="num small">{{ rub(c.summary.cost_kop) }}</div>
          </RouterLink>
        </div>
      </Card>

      <Card title="AI-советник">
        <div class="stack">
          <div class="small muted-2">Скрипт всегда считает рекомендации. AI добавляет комментарий, если подключён.</div>
          <Button variant="primary" block :loading="adviceBusy" @click="getAdvice">
            <Icon name="sparkles" :size="16" /> Получить разбор
          </Button>
          <div v-if="adviceError" class="notice notice-error">{{ adviceError }}</div>
          <template v-if="advice">
            <ul class="tips">
              <li v-for="(t, i) in advice.script" :key="i">{{ t }}</li>
            </ul>
            <div v-if="advice.ai" class="notice ai-block">{{ advice.ai }}</div>
            <div v-else-if="advice.ai_error" class="hint">{{ advice.ai_error }}</div>
            <div v-if="advice.charged_kop" class="hint">Списано {{ rub(advice.charged_kop) }}, баланс {{ rub(advice.balance_kop) }}</div>
          </template>
        </div>
      </Card>

      <Card v-if="!data.top_campaigns.length && data.connected" title="Кампании">
        <EmptyState icon="megaphone" title="Нет данных за период" text="Запусти синхронизацию или проверь, что в Директе есть показы." />
      </Card>
    </template>
  </div>
</template>

<style scoped>
.right { text-align: right; }
.link-row { display: inline-flex; align-items: center; gap: 4px; margin-top: var(--s-3); color: var(--accent-hover); font-weight: 600; }
.link-plain { color: inherit; }
.tips { margin: 0; padding-left: 18px; color: var(--text-2); font-size: var(--text-sm); display: flex; flex-direction: column; gap: 6px; }
.ai-block { color: var(--text-1); line-height: 1.5; white-space: pre-wrap; }
</style>
