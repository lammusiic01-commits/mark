<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import BottomSheet from '../components/BottomSheet.vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import { tgApi, type MiniBalance, type MiniPayment } from '../api';
import { money, shortDate, statusLabel, statusVariant, timeAgo } from '../format';
import { openExternal, haptic } from '../telegram';
import { toastErr, toastOk } from '../useToasts';

/**
 * Баланс и оплата через СБП.
 *
 * Схема: сумма → платёжная ссылка СБП и QR → пользователь платит в банковском
 * приложении → приложение опрашивает статус и зачисляет баланс. Если у
 * провайдера нет онлайн-подтверждения, платёж зачисляется вручную владельцем —
 * кнопка «Подтвердить» остаётся в интерфейсе.
 */

const data = ref<MiniBalance | null>(null);
const loading = ref(true);
const busy = ref(false);

const amount = ref<number>(5000);
const customAmount = ref('');
const PRESETS = [1000, 3000, 5000, 10000, 30000];

const payment = ref<MiniPayment | null>(null);
const paymentOpen = ref(false);
const paymentStatus = ref<string>('pending');
const planOpen = ref(false);
let pollTimer: number | null = null;

onMounted(load);

onBeforeUnmount(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await tgApi.get<MiniBalance>('/balance');
  } catch (error) {
    toastErr('Не удалось загрузить баланс', error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

const sum = computed(() => {
  const custom = Number(customAmount.value);
  return Number.isFinite(custom) && custom > 0 ? custom : amount.value;
});

async function createPayment(): Promise<void> {
  if (sum.value < 500) {
    toastErr('Минимальная сумма — 500 ₽');
    return;
  }
  busy.value = true;
  try {
    const created = await tgApi.post<MiniPayment>('/payments/create', { amount: Math.round(sum.value), comment: 'Пополнение баланса' });
    payment.value = created;
    paymentStatus.value = created.status;
    paymentOpen.value = true;
    startPolling(created.id);
    haptic('success');
  } catch (error) {
    toastErr('Не удалось создать платёж', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

/** Опрос статуса: банк подтверждает платёж асинхронно. */
function startPolling(paymentId: string): void {
  if (pollTimer) window.clearInterval(pollTimer);
  let attempts = 0;
  pollTimer = window.setInterval(async () => {
    attempts += 1;
    try {
      const response = await tgApi.get<{ status: string; balance: number }>(`/payments/${paymentId}/status`);
      paymentStatus.value = response.status;
      if (response.status === 'paid') {
        haptic('success');
        toastOk('Платёж получен', `Баланс пополнен. Сейчас: ${money(response.balance)}`);
        if (pollTimer) window.clearInterval(pollTimer);
        paymentOpen.value = false;
        await load();
      }
    } catch {
      /* сеть мигнула — попробуем на следующем тике */
    }
    if (attempts > 40 && pollTimer) window.clearInterval(pollTimer);
  }, 3000);
}

/** Ручное подтверждение: используется, когда банк подтверждает оплату вне сервиса. */
async function confirmManually(): Promise<void> {
  if (!payment.value) return;
  busy.value = true;
  try {
    const response = await tgApi.post<{ balance: number }>('/payments/confirm', { paymentId: payment.value.id });
    toastOk('Платёж зачислен', `Баланс: ${money(response.balance)}`);
    paymentOpen.value = false;
    await load();
  } catch (error) {
    toastErr('Не удалось подтвердить', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function activate(planId: string): Promise<void> {
  busy.value = true;
  try {
    const response = await tgApi.post<{ balance: number; planUntil?: string }>('/plans/activate', { planId, months: 1 });
    toastOk('Тариф активирован', `Списано с баланса. Остаток: ${money(response.balance)}`);
    planOpen.value = false;
    await load();
  } catch (error) {
    toastErr('Не удалось активировать тариф', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

const txIcon = (type: string): string => (type === 'charge' ? '📉' : type === 'topup' ? '📈' : type === 'refund' ? '↩️' : '⏳');
const canConfirm = computed(() => payment.value?.status === 'pending' || paymentStatus.value === 'pending');
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">Деньги агентства</div>
        <h1 class="mini-title">Баланс</h1>
      </div>
      <GlassButton size="sm" @click="load">Обновить</GlassButton>
    </header>

    <LoaderBlock v-if="loading && !data" :rows="3" label="Загружаем баланс" />

    <template v-else-if="data">
      <GlassCard tight>
        <div class="mini-greeting">Доступно</div>
        <div style="font-size: 34px; font-weight: 700; letter-spacing: -1px">{{ money(data.balance) }}</div>
        <div class="mini-hint">
          {{ data.plan ? `тариф «${data.plan}» до ${shortDate(data.planUntil)}` : 'тариф не выбран' }}<template v-if="data.hold"> · в резерве {{ money(data.hold) }}</template>
        </div>
        <div class="mini-row" style="margin-top: 12px; gap: 8px">
          <span class="badge">Пополнено за 30 дней: {{ money(data.spend.toppedUp30d, { compact: true }) }}</span>
          <span class="badge">Списано: {{ money(data.spend.charged30d, { compact: true }) }}</span>
        </div>
      </GlassCard>

      <div class="mini-section-title">Пополнить</div>
      <GlassCard class="mini-stack">
        <div class="mini-scroll-x">
          <button
            v-for="preset in PRESETS"
            :key="preset"
            class="btn-glass"
            :class="{ 'btn-primary': amount === preset && !customAmount }"
            @click="amount = preset; customAmount = ''"
          >
            {{ preset.toLocaleString('ru-RU') }} ₽
          </button>
        </div>
        <label class="field">
          <span class="field-label">Своя сумма, ₽</span>
          <input v-model="customAmount" class="input" inputmode="numeric" placeholder="от 500 до 500 000" />
        </label>
        <GlassButton variant="primary" block :loading="busy" @click="createPayment">Оплатить через СБП · {{ money(sum) }}</GlassButton>
        <div class="mini-hint">
          Оплата по QR-коду или кнопкой в банковском приложении. Деньги зачисляются автоматически; если банк подтверждает оплату вне сервиса — нажмите «Подтвердить платёж».
        </div>
      </GlassCard>

      <div class="mini-section-title">Тарифы</div>
      <GlassCard v-for="plan in data.plans" :key="plan.id" style="margin-bottom: 10px">
        <div class="mini-row-between">
          <div>
            <div style="font-weight: 600">{{ plan.name }} <span v-if="plan.popular" class="badge badge-accent">популярный</span></div>
            <div class="mini-hint">{{ plan.description }}</div>
          </div>
          <div style="text-align: right">
            <div style="font-size: 18px; font-weight: 700">{{ money(plan.price) }}</div>
            <div class="mini-hint">в {{ plan.period }}</div>
          </div>
        </div>
        <ul class="mini-hint" style="padding-left: 18px; margin: 10px 0 0; line-height: 1.6">
          <li v-for="feature in plan.features" :key="feature">{{ feature }}</li>
        </ul>
      </GlassCard>
      <GlassButton block @click="planOpen = true">Подключить тариф с баланса</GlassButton>

      <div class="mini-section-title">История</div>
      <GlassCard v-if="!data.transactions.length">
        <div class="mini-hint">Операций пока не было.</div>
      </GlassCard>
      <GlassCard v-else>
        <div v-for="transaction in data.transactions.slice(0, 12)" :key="transaction.id" style="padding: 8px 0; border-bottom: 1px solid var(--border)">
          <div class="mini-row-between">
            <div>
              <div style="font-size: 14px">{{ txIcon(transaction.type) }} {{ transaction.description }}</div>
              <div class="mini-hint">{{ timeAgo(transaction.createdAt) }} · остаток {{ money(transaction.balanceAfter) }}</div>
            </div>
            <b :style="{ color: transaction.amount < 0 ? 'var(--red)' : 'var(--green)' }">{{ transaction.amount > 0 ? '+' : '' }}{{ money(transaction.amount) }}</b>
          </div>
        </div>
      </GlassCard>
    </template>
  </div>

  <!-- Оплата по СБП -->
  <BottomSheet :open="paymentOpen" @close="paymentOpen = false">
    <template v-if="payment">
      <h3 class="mini-title-sm">Оплата через СБП</h3>
      <p class="mini-hint" style="margin: 6px 0 14px">
        Отсканируйте QR в банковском приложении или откройте его на этом телефоне — сумма {{ money(payment.amount) }}.
      </p>

      <div class="glass glass-pad" style="display: grid; place-items: center">
        <img
          v-if="payment.qrPngBase64"
          :src="`data:image/png;base64,${payment.qrPngBase64}`"
          alt="QR-код для оплаты через СБП"
          style="width: 220px; height: 220px; border-radius: 18px; background: #fff; padding: 10px"
        />
        <div class="mini-hint" style="margin-top: 10px; text-align: center">
          Платёж № {{ payment.id }}<br />
          {{ paymentStatus === 'paid' ? 'оплачено' : paymentStatus === 'pending' ? 'ожидаем подтверждение банка…' : statusLabel(paymentStatus) }}
        </div>
        <div v-if="paymentStatus === 'pending'" class="spinner" style="margin-top: 10px" />
      </div>

      <div class="sheet-actions">
        <GlassButton @click="openExternal(payment.sbpUrl)">Открыть банк</GlassButton>
        <GlassButton v-if="canConfirm" variant="primary" :loading="busy" @click="confirmManually">Подтвердить</GlassButton>
        <GlassButton v-else variant="glass" @click="paymentOpen = false">Готово</GlassButton>
      </div>
      <div class="mini-hint" style="margin-top: 10px; text-align: center">
        Ссылка СБП: <span class="code" style="display: inline-block; padding: 2px 6px">{{ payment.sbpUrl.slice(0, 44) }}…</span>
      </div>
    </template>
  </BottomSheet>

  <!-- Выбор тарифа -->
  <BottomSheet :open="planOpen" @close="planOpen = false">
    <h3 class="mini-title-sm">Тариф</h3>
    <p class="mini-hint" style="margin: 6px 0 14px">Стоимость списывается с баланса. Пополните баланс, если средств не хватает.</p>
    <div class="mini-stack">
      <GlassCard v-for="plan in data?.plans ?? []" :key="plan.id" tight>
        <div class="mini-row-between">
          <div>
            <div style="font-weight: 600">{{ plan.name }}</div>
            <div class="mini-hint">{{ money(plan.price) }} в {{ plan.period }}</div>
          </div>
          <GlassButton size="sm" variant="primary" :loading="busy" @click="activate(plan.id)">Выбрать</GlassButton>
        </div>
      </GlassCard>
    </div>
  </BottomSheet>
</template>
