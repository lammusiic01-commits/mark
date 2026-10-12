<script setup>
import { onMounted, ref, reactive } from 'vue'
import { api } from '../composables/useApi.js'
import { useRequest } from '../composables/useRequest.js'
import { rub, dateTime } from '../composables/useFormat.js'
import { hapticNotify } from '../composables/useHaptics.js'
import Card from '../components/ui/Card.vue'
import Button from '../components/ui/Button.vue'
import Input from '../components/ui/Input.vue'
import Badge from '../components/ui/Badge.vue'
import Icon from '../components/ui/Icon.vue'
import Skeleton from '../components/ui/Skeleton.vue'

const { data, loading, error, run } = useRequest(() => api.get('/balance'))
const amount = ref(500)
const busy = ref(false)
const msg = ref({ type: '', text: '' })
const payment = ref(null)
const pending = ref(null)
const isAdmin = ref(false)
const confirming = reactive({})

async function topup() {
  busy.value = true
  msg.value = { type: '', text: '' }
  payment.value = null
  try {
    const r = await api.post('/balance/topup', { amount_rub: Number(amount.value) })
    payment.value = r
    msg.value = r.payment
      ? { type: 'ok', text: 'Отсканируй QR в банковском приложении. После оплаты баланс пополнится, когда администратор подтвердит перевод.' }
      : { type: 'error', text: r.message }
    hapticNotify('success')
    await run()
  } catch (e) {
    msg.value = { type: 'error', text: e.message }
    hapticNotify('error')
  } finally {
    busy.value = false
  }
}

async function loadAdmin() {
  try {
    pending.value = await api.get('/balance/admin/pending')
    isAdmin.value = true
  } catch (_) {
    isAdmin.value = false
  }
}

async function confirm(tx) {
  confirming[tx.id] = true
  try {
    await api.post(`/balance/admin/confirm/${tx.id}`)
    hapticNotify('success')
    await loadAdmin()
  } catch (e) {
    msg.value = { type: 'error', text: e.message }
  } finally {
    confirming[tx.id] = false
  }
}

const STATUS = { pending: { tone: 'amber', text: 'ожидает' }, paid: { tone: 'green', text: 'зачислено' } }

onMounted(async () => {
  await run()
  await loadAdmin()
})
</script>

<template>
  <div class="page">
    <div>
      <div class="page-title">Баланс</div>
      <div class="page-sub">Списания: AI-советы, если используется ключ сервиса</div>
    </div>

    <Skeleton v-if="loading && !data" :height="90" />
    <div v-if="error" class="notice notice-error">{{ error }}</div>

    <Card v-if="data">
      <div class="kpi-label">Доступно</div>
      <div class="kpi-value">{{ rub(data.balance_kop, 2) }}</div>
      <div class="hint">AI-совет стоит {{ rub(data.ai_charge_kop) }}. Минимальное пополнение {{ data.min_topup_rub }} ₽.</div>
    </Card>

    <Card title="Пополнить">
      <div class="stack">
        <Input v-model="amount" type="number" inputmode="numeric" label="Сумма, ₽" />
        <Button variant="primary" block :loading="busy" :disabled="!amount || amount < (data?.min_topup_rub || 1)" @click="topup">
          <Icon name="qr" :size="16" /> Создать платёж
        </Button>
        <div v-if="msg.text" class="notice" :class="msg.type === 'ok' ? 'notice-ok' : 'notice-error'">{{ msg.text }}</div>
        <div v-if="payment?.payment" class="qr-block">
          <img :src="payment.payment.qr" alt="QR-код для оплаты" class="qr" width="220" height="220" />
          <div class="hint">Назначение: <span class="mono">{{ payment.transaction.comment }}</span></div>
        </div>
      </div>
    </Card>

    <Card v-if="isAdmin && pending" title="Ожидают подтверждения">
      <div v-if="!pending.length" class="muted small">Нет ожидающих платежей</div>
      <div v-for="tx in pending" :key="tx.id" class="list-item">
        <div class="grow">
          <div class="small">{{ rub(tx.amount_kop) }} · {{ tx.comment }}</div>
          <div class="xs muted">пользователь #{{ tx.user_id }} · {{ dateTime(tx.created_at) }}</div>
        </div>
        <Button size="sm" variant="primary" :loading="confirming[tx.id]" @click="confirm(tx)">Зачислить</Button>
      </div>
    </Card>

    <Card title="История операций">
      <div v-if="!data?.transactions?.length" class="muted small">Операций пока нет</div>
      <div v-for="t in data?.transactions || []" :key="t.id" class="list-item">
        <div class="grow">
          <div class="small">{{ t.kind === 'topup' ? 'Пополнение' : 'AI-совет' }} · {{ t.comment }}</div>
          <div class="xs muted">{{ dateTime(t.created_at) }}</div>
        </div>
        <div class="num small" :class="t.amount_kop >= 0 ? 'pos' : 'neg'">{{ t.amount_kop >= 0 ? '+' : '' }}{{ rub(t.amount_kop) }}</div>
        <Badge :tone="STATUS[t.status]?.tone || 'neutral'">{{ STATUS[t.status]?.text || t.status }}</Badge>
      </div>
    </Card>
  </div>
</template>

<style scoped>
.qr-block { display: flex; flex-direction: column; align-items: center; gap: var(--s-2); padding-top: var(--s-2); }
.qr { background: #fff; border-radius: var(--r-md); padding: 8px; }
.mono { font-family: var(--font-mono); }
</style>
