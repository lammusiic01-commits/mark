<template>
  <div class="balance-page safe-top">
    <ScreenHeader title="Баланс" back fallback-path="/" />

    <!-- Текущий баланс -->
    <GlassCard class="current-balance">
      <div class="label">На счету</div>
      <div class="amount">{{ balanceText }}</div>
      <div class="stats">
        <div class="stat">
          <span>Пополнено</span>
          <b>{{ money(summary.topped_up_total) }}</b>
        </div>
        <div class="stat">
          <span>Израсходовано</span>
          <b>{{ money(summary.spent_total) }}</b>
        </div>
      </div>
    </GlassCard>

    <!-- Сумма пополнения -->
    <h4 class="section-title">Выберите сумму</h4>
    <div class="amounts-grid">
      <button
        v-for="preset in presets"
        :key="preset"
        type="button"
        class="amount-btn"
        :class="{ active: !customAmount && amount === preset }"
        @click="selectAmount(preset)"
      >
        {{ money(preset) }}
      </button>
    </div>

    <GlassCard class="custom-amount">
      <label for="custom">Другая сумма</label>
      <input
        id="custom"
        :value="customAmount ?? ''"
        type="tel"
        inputmode="numeric"
        :placeholder="`от ${money(minAmount)} до ${money(maxAmount)}`"
        @input="onCustomInput"
        @focus="amount = 0"
      />
    </GlassCard>

    <div class="actions">
      <GlassButton
        variant="primary"
        size="lg"
        block
        :loading="creating"
        :disabled="!finalAmount || finalAmount < minAmount"
        @click="createPayment"
      >
        {{ finalAmount ? `Оплатить ${money(finalAmount)}` : 'Выберите сумму' }}
      </GlassButton>
      <p class="hint">
        {{ summary.sbp_configured ? 'Оплата по СБП — деньги придут в течение минуты' : 'СБП пока в тестовом режиме: счёт создаётся, оплату подтверждает кнопка «Я оплатил»' }}
      </p>
    </div>

    <!-- История операций -->
    <h4 class="section-title">История</h4>
    <GlassCard class="history">
      <div v-if="!history.length" class="history-empty">Операций пока нет — пополните баланс, и они появятся здесь</div>
      <div v-for="item in history" :key="item.reference" class="history-row">
        <span class="history-icon">{{ item.kind === 'charge' ? '↓' : '↑' }}</span>
        <div class="history-body">
          <span class="history-title">{{ item.title }}</span>
          <span class="history-date">{{ item.created_at }}</span>
        </div>
        <b class="history-amount" :class="{ minus: item.kind === 'charge' }">
          {{ item.kind === 'charge' ? '−' : '+' }}{{ money(item.amount) }}
        </b>
      </div>
    </GlassCard>

    <!-- Окно оплаты с QR -->
    <BottomSheet
      :model-value="Boolean(payment)"
      title="Оплата по QR-коду"
      subtitle="Откройте приложение банка и отсканируйте код"
      @update:model-value="closeSheet"
    >
      <div v-if="payment" class="qr-block">
        <div class="qr-wrap">
          <img v-if="qrSrc(payment)" :src="qrSrc(payment)" alt="QR-код для оплаты" />
          <div v-else class="qr-placeholder">Реквизиты не настроены</div>
        </div>

        <div class="pay-sum">
          <span>К оплате</span>
          <b>{{ money(payment.amount) }}</b>
        </div>

        <p class="pay-hint">{{ payment.hint }}</p>
        <p class="pay-id">Номер платежа: {{ payment.payment_id }}</p>

        <div class="pay-status" :class="statusTone">
          <span class="status-dot" />
          {{ statusText }}
        </div>
      </div>

      <template #footer>
        <div class="sheet-actions">
          <GlassButton
            v-if="payment?.sbp_url"
            variant="primary"
            size="lg"
            block
            @click="openBank"
          >
            Открыть банк
          </GlassButton>
          <GlassButton
            variant="secondary"
            size="lg"
            block
            :loading="checking"
            @click="checkNow"
          >
            Проверить оплату
          </GlassButton>
          <GlassButton
            v-if="!summary.sbp_configured"
            variant="ghost"
            size="md"
            block
            :loading="confirming"
            @click="markPaid"
          >
            Я оплатил
          </GlassButton>
        </div>
      </template>
    </BottomSheet>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import BottomSheet from '../components/BottomSheet.vue'
import GlassButton from '../components/GlassButton.vue'
import GlassCard from '../components/GlassCard.vue'
import ScreenHeader from '../components/ScreenHeader.vue'
import { qrSrc } from '../composables/useApi'
import { money } from '../composables/useFormat'
import { useHaptics } from '../composables/useHaptics'
import { useAppStore } from '../store'

const store = useAppStore()
const haptics = useHaptics()

const amount = ref(0)
const customAmount = ref(null)
const checking = ref(false)
const confirming = ref(false)
const statusText = ref('Ждём оплату')
let poller = null
let attempts = 0

const summary = computed(() => store.balance || {})
const balanceText = computed(() => summary.value.balance_text || '0 ₽')
const history = computed(() => summary.value.history || [])
const presets = computed(() => summary.value.presets || [1000, 3000, 5000, 10000])
const minAmount = computed(() => Number(summary.value.min_amount || 300))
const maxAmount = computed(() => Number(summary.value.max_amount || 100000))
const payment = computed(() => store.payment)
const creating = computed(() => Boolean(store.loading.topup))
const finalAmount = computed(() => Number(customAmount.value || amount.value || 0))

const statusTone = computed(() => (payment.value?.status === 'paid' ? 'ok' : payment.value?.status === 'failed' ? 'bad' : 'wait'))

const showQr = computed(() => Boolean(payment.value?.qr_png_base64))

function selectAmount(value) {
  haptics.select()
  amount.value = value
  customAmount.value = null
}

function onCustomInput(event) {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 6)
  customAmount.value = digits ? Number(digits) : null
}

async function createPayment() {
  haptics.medium()
  statusText.value = 'Ждём оплату'
  attempts = 0
  const data = await store.topUp(finalAmount.value)
  if (data) {
    startPolling(data.payment_id)
    if (!data.qr_png_base64) haptics.warning()
  } else {
    haptics.error()
  }
}

/** Опрашиваем статус, пока банк подтверждает оплату */
function startPolling(paymentId) {
  clearInterval(poller)
  poller = setInterval(async () => {
    attempts += 1
    if (attempts > 100) {
      clearInterval(poller)
      statusText.value = 'Счёт истёк — создайте новый'
      return
    }
    try {
      const data = await store.paymentStatus(paymentId)
      if (data.status === 'paid') {
        clearInterval(poller)
        statusText.value = 'Оплата получена'
        haptics.success()
        await Promise.all([store.loadBalance(), store.loadDashboard()])
        if (store.payment) store.payment.status = 'paid'
      } else if (data.status === 'failed') {
        clearInterval(poller)
        statusText.value = 'Счёт истёк — создайте новый'
      }
    } catch {
      /* сеть мигнула — просто ждём следующего опроса */
    }
  }, 4000)
}

async function checkNow() {
  if (!payment.value) return
  haptics.light()
  checking.value = true
  try {
    const data = await store.paymentStatus(payment.value.payment_id)
    if (data.status === 'paid') {
      statusText.value = 'Оплата получена'
      haptics.success()
      await Promise.all([store.loadBalance(), store.loadDashboard()])
      store.payment.status = 'paid'
    } else {
      statusText.value = data.message || 'Платёж ещё не пришёл'
      haptics.warning()
    }
  } catch (error) {
    statusText.value = error.message
    haptics.error()
  } finally {
    checking.value = false
  }
}

async function markPaid() {
  if (!payment.value) return
  confirming.value = true
  const data = await store.confirmPayment(payment.value.payment_id)
  confirming.value = false
  if (data) {
    statusText.value = 'Оплата зачтена'
    haptics.success()
    clearInterval(poller)
  } else {
    haptics.error()
  }
}

function openBank() {
  haptics.medium()
  const url = payment.value?.sbp_url
  if (url) window.open(url, '_blank', 'noopener')
}

function closeSheet() {
  clearInterval(poller)
  store.clearPayment()
}

onMounted(async () => {
  await store.loadBalance()
  amount.value = presets.value[1] || presets.value[0] || 1000
})

onUnmounted(() => clearInterval(poller))
</script>

<style scoped>
.balance-page {
  min-height: 100vh;
  padding-bottom: calc(96px + env(safe-area-inset-bottom));
  position: relative;
  z-index: 1;
}

.current-balance {
  margin: var(--space-5) var(--space-5) var(--space-5);
  background: linear-gradient(135deg, rgba(10, 132, 255, 0.16), rgba(48, 209, 88, 0.10));
  border: 1px solid rgba(10, 132, 255, 0.24);
}

.label {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: var(--fw-medium);
}

.amount {
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: var(--fw-bold);
  letter-spacing: -0.03em;
  margin: var(--space-2) 0 var(--space-4);
  line-height: 1;
}

.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.stat span {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.stat b {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
}

.section-title {
  margin: 0 var(--space-5) var(--space-3);
  font-size: var(--fs-title-3);
}

.amounts-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-3);
  padding: 0 var(--space-5) var(--space-4);
}

.amount-btn {
  padding: 16px 12px;
  border-radius: var(--radius-md);
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: var(--fs-headline);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.02em;
  transition: all var(--duration-fast) var(--ease-ios);
}

.amount-btn:active {
  transform: scale(0.96);
}

.amount-btn.active {
  background: rgba(10, 132, 255, 0.16);
  border-color: rgba(10, 132, 255, 0.55);
  color: #fff;
}

.custom-amount {
  margin: 0 var(--space-5) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.custom-amount label {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
}

.custom-amount input {
  padding: 12px 0;
  background: none;
  border: none;
  outline: none;
  color: var(--text-primary);
  font-family: var(--font-display);
  font-size: var(--fs-title-3);
  font-weight: var(--fw-semibold);
  letter-spacing: -0.02em;
}

.custom-amount input::placeholder {
  color: var(--text-tertiary);
  font-size: var(--fs-body);
  font-weight: var(--fw-regular);
}

.actions {
  padding: 0 var(--space-5) var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.hint {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  text-align: center;
  line-height: 1.45;
}

/* История */
.history {
  margin: 0 var(--space-5) var(--space-6);
  padding: var(--space-2) var(--space-4);
}

.history-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);
}

.history-row:last-child {
  border-bottom: none;
}

.history-icon {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface-overlay);
  color: var(--text-secondary);
  font-size: var(--fs-footnote);
}

.history-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.history-title {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
}

.history-date {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.history-amount {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-green);
}

.history-amount.minus {
  color: var(--text-secondary);
}

.history-empty {
  padding: var(--space-4) 0;
  font-size: var(--fs-footnote);
  color: var(--text-tertiary);
  text-align: center;
}

/* QR */
.qr-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.qr-wrap {
  align-self: center;
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background: #fff;
  box-shadow: var(--shadow-md);
}

.qr-wrap img {
  display: block;
  width: 224px;
  height: 224px;
  image-rendering: pixelated;
}

.qr-placeholder {
  width: 224px;
  height: 224px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #333;
  font-size: var(--fs-footnote);
  text-align: center;
  padding: var(--space-4);
}

.pay-sum {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-body);
}

.pay-sum b {
  font-family: var(--font-display);
  font-size: var(--fs-title-3);
  letter-spacing: -0.02em;
}

.pay-hint {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  line-height: 1.45;
}

.pay-id {
  font-family: var(--font-mono);
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  word-break: break-all;
}

.pay-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
}

.pay-status.wait { color: var(--accent-orange); }
.pay-status.ok { color: var(--accent-green); }
.pay-status.bad { color: var(--accent-red); }

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1.6s ease-in-out infinite;
}

.pay-status.ok .status-dot,
.pay-status.bad .status-dot {
  animation: none;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.sheet-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
