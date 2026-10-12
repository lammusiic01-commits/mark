<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import BottomSheet from './BottomSheet.vue';
import GlassButton from './GlassButton.vue';
import { tgApi, type MiniService } from '../api';
import { instructionFor } from '../instructions';
import { openExternal, success as hapticSuccess } from '../telegram';
import { toastErr, toastOk } from '../useToasts';
import { statusLabel, statusVariant, timeAgo } from '../format';

/**
 * Шторка подключения сервиса.
 *
 * Показывает: зачем сервис нужен, как получить ключ (пошагово, с прямой
 * ссылкой), выбор способа авторизации, поля и результат живой проверки.
 * Если сервис поддерживает только вход в окне — открываем окно входа и
 * ждём подтверждения, как в промте: «вход в сервис внутри приложения».
 */

const props = withDefaults(defineProps<{ open: boolean; service: MiniService | null; sandbox?: boolean }>(), { sandbox: true });
const emit = defineEmits<{ (event: 'close'): void; (event: 'connected'): void }>();

const modeId = ref<string>('api_token');
const fields = reactive<Record<string, string>>({});
const busy = ref(false);
const checks = ref<{ key: string; title: string; status: string; message?: string }[]>([]);
const resultMessage = ref<string | null>(null);
const resultStatus = ref<'idle' | 'pass' | 'warn' | 'fail'>('idle');
const showSteps = ref(false);
const loginOpened = ref(false);
const sandboxMode = ref(true);

const instruction = computed(() => instructionFor(props.service?.id ?? '', props.service?.name ?? 'сервис'));
const mode = computed(() => props.service?.authModes.find((item) => item.id === modeId.value) ?? props.service?.authModes[0] ?? null);
const account = computed(() => props.service?.account ?? null);
const needsLoginWindow = computed(() => mode.value?.needsInAppLogin ?? false);

/** Форма пересобирается при каждом открытии: не переносим ключи между сервисами. */
watch(
  () => [props.open, props.service?.id] as const,
  () => {
    if (!props.open || !props.service) return;
    const preferred = props.service.authModes.find((item) => item.id === 'api_token' && item.fields.length) ?? props.service.authModes[0];
    modeId.value = preferred?.id ?? 'api_token';
    for (const key of Object.keys(fields)) delete fields[key];
    for (const field of preferred?.fields ?? []) fields[field.key] = '';
    checks.value = [];
    resultStatus.value = 'idle';
    resultMessage.value = null;
    showSteps.value = !account.value;
    loginOpened.value = false;
    sandboxMode.value = props.sandbox;
  },
  { immediate: true },
);

watch(modeId, () => {
  for (const key of Object.keys(fields)) delete fields[key];
  for (const field of mode.value?.fields ?? []) fields[field.key] = '';
  checks.value = [];
  resultStatus.value = 'idle';
});

function openInstructions(): void {
  if (instruction.value.url) openExternal(instruction.value.url);
}

/** Вход в окне приложения: открываем страницу сервиса и объясняем, что дальше. */
function openLoginWindow(): void {
  loginOpened.value = true;
  if (instruction.value.url) openExternal(instruction.value.url);
  toastOk('Окно входа открыто', 'Войдите в сервис и подтвердите доступ. Затем вернитесь в приложение и нажмите «Проверить подключение».');
}

async function validate(): Promise<void> {
  if (!props.service) return;
  const missing = (mode.value?.fields ?? []).filter((field) => field.required && !fields[field.key]?.trim());
  if (missing.length) {
    toastErr('Заполните поля', missing.map((field) => field.label).join(', '));
    return;
  }

  busy.value = true;
  checks.value = [];
  resultStatus.value = 'idle';
  try {
    const response = await tgApi.post<{
      result: { status: 'pass' | 'warn' | 'fail'; accountInfo?: Record<string, unknown>; capabilities?: unknown[] };
      checks: { key: string; title: string; status: string; message?: string }[];
    }>('/services/validate', {
      serviceId: props.service.id,
      authMode: modeId.value,
      fields,
      sandbox: sandboxMode.value,
    });
    checks.value = response.checks;
    resultStatus.value = response.result.status;
    if (response.result.status === 'fail') {
      resultMessage.value = 'Проверка не пройдена — посмотрите подсказку в шагах ниже.';
      toastErr('Не получилось подключить', 'Проверьте ключ и повторите.');
    } else {
      const info = response.result.accountInfo ?? {};
      const label = String(info.accountName ?? info.name ?? info.login ?? info.counterName ?? '');
      resultMessage.value = label ? `Подключено: ${label}` : 'Сервис подключён и отвечает.';
      hapticSuccess();
      toastOk('Сервис подключён', label || props.service.name);
      emit('connected');
    }
  } catch (error) {
    resultStatus.value = 'fail';
    resultMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function disconnect(): Promise<void> {
  if (!props.service) return;
  busy.value = true;
  try {
    await tgApi.delete(`/services/${props.service.id}`);
    toastOk('Отключено', props.service.name);
    emit('connected');
  } catch (error) {
    toastErr('Не удалось отключить', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

const checkIcon = (status: string): string => (status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : status === 'fail' ? '❌' : status === 'skip' ? '➖' : '⏳');
</script>

<template>
  <BottomSheet :open="open" @close="emit('close')">
    <template v-if="service">
      <div class="mini-row" style="gap: 12px; align-items: flex-start">
        <div class="list-icon" :style="service.color ? { background: `${service.color}22`, color: service.color } : {}">🔌</div>
        <div style="flex: 1">
          <h3 class="mini-title-sm">{{ service.name }}</h3>
          <div class="mini-hint">{{ service.vendor }} · {{ service.category }}</div>
        </div>
        <span v-if="account" class="badge" :class="statusVariant(account.status)">{{ statusLabel(account.status) }}</span>
      </div>

      <p class="mini-muted" style="margin: 12px 0">{{ instruction.effect }}</p>

      <div class="mini-row-between glass glass-tight" style="margin-bottom: 14px">
        <div>
          <div style="font-weight: 600">Как получить доступ</div>
          <div class="mini-hint">Пошаговая инструкция с подсказками</div>
        </div>
        <GlassButton size="sm" @click="showSteps = !showSteps">{{ showSteps ? 'Скрыть' : 'Открыть' }}</GlassButton>
      </div>

      <ol v-if="showSteps" class="mini-stack" style="padding-left: 18px; margin: 0 0 14px; font-size: 13px; color: var(--text-secondary)">
        <li v-for="(step, index) in instruction.steps" :key="index">{{ step }}</li>
      </ol>

      <div v-if="showSteps && instruction.tips?.length" class="mini-stack" style="margin-bottom: 14px">
        <div v-for="tip in instruction.tips" :key="tip" class="glass glass-tight mini-hint">💡 {{ tip }}</div>
      </div>

      <div v-if="(service.authModes.length ?? 0) > 1" class="field" style="margin-bottom: 14px">
        <span class="field-label">Способ подключения</span>
        <div class="tabs">
          <button v-for="item in service.authModes" :key="item.id" :class="{ active: item.id === modeId }" @click="modeId = item.id">
            {{ item.label }}
          </button>
        </div>
      </div>

      <div v-if="needsLoginWindow" class="mini-stack" style="margin-bottom: 14px">
        <GlassButton variant="primary" block @click="openLoginWindow">
          {{ loginOpened ? 'Открыть окно входа ещё раз' : 'Открыть окно входа' }}
        </GlassButton>
        <div class="mini-hint">
          Логин и пароль вводятся только на стороне сервиса — MARK не видит их. После входа вернитесь в приложение и проверьте подключение.
        </div>
      </div>

      <div v-if="mode?.fields.length" class="mini-stack">
        <label v-for="field in mode.fields" :key="field.key" class="field">
          <span class="field-label">{{ field.label }}<span v-if="field.required"> *</span></span>
          <input
            v-model="fields[field.key]"
            class="input"
            :type="field.type === 'password' ? 'password' : 'text'"
            :placeholder="field.placeholder ?? ''"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <span v-if="field.help" class="mini-hint">{{ field.help }}</span>
        </label>
        <div v-if="instruction.sample" class="mini-hint">Пример: {{ instruction.sample }}</div>
      </div>

      <label v-if="service.supportsSandbox" class="glass-row" style="margin-top: 14px">
        <div>
          <div style="font-weight: 600">Тестовый режим</div>
          <div class="mini-hint">Проверяем подключение, но не меняем ничего в аккаунте</div>
        </div>
        <button class="switch" :class="{ on: sandboxMode }" @click="sandboxMode = !sandboxMode" />
      </label>

      <div v-if="checks.length" class="mini-stack" style="margin-top: 14px">
        <div v-for="check in checks" :key="check.key" class="glass glass-tight">
          <div class="mini-row-between">
            <span style="font-size: 13px">{{ checkIcon(check.status) }} {{ check.title }}</span>
          </div>
          <div v-if="check.message" class="mini-hint" style="margin-top: 4px">{{ check.message }}</div>
        </div>
      </div>

      <div v-if="resultMessage" class="mini-stack" style="margin-top: 14px">
        <div class="glass glass-tight" :class="resultStatus === 'fail' ? 'badge-danger' : 'badge-live'">{{ resultMessage }}</div>
      </div>

      <div v-if="account" class="glass glass-tight" style="margin-top: 14px">
        <div class="mini-row-between">
          <span class="mini-muted">Подключено</span>
          <span class="badge" :class="statusVariant(account.status)">{{ statusLabel(account.status) }}</span>
        </div>
        <div class="mini-hint" style="margin-top: 6px">
          {{ account.label }}<template v-if="account.secretPreview"> · ключ {{ account.secretPreview }}</template><br />
          проверено {{ timeAgo(account.lastCheckedAt) }}
        </div>
        <div v-if="account.lastError" class="mini-hint" style="color: var(--red); margin-top: 6px">{{ account.lastError }}</div>
      </div>

      <div class="sheet-actions">
        <GlassButton v-if="account" variant="danger" :loading="busy" @click="disconnect">Отключить</GlassButton>
        <GlassButton v-else variant="primary" :loading="busy" @click="validate">
          {{ needsLoginWindow && !mode?.fields.length ? 'Проверить вход' : 'Подключить' }}
        </GlassButton>
      </div>
    </template>
  </BottomSheet>
</template>
