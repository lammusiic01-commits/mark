<template>
  <div class="connect-page">
    <ScreenHeader title="Подключения" back fallback-path="/" />

    <p class="lead">
      Подключите сервисы — и я начну считать. Токены сохраняются в зашифрованном виде,
      их можно удалить в любой момент.
    </p>

    <!-- Прогресс подключения -->
    <div class="progress">
      <span class="progress-bar">
        <span class="progress-fill" :style="{ width: `${percent}%` }" />
      </span>
      <span class="progress-text">{{ connectedCount }} из {{ total }} подключено</span>
    </div>

    <!-- Карточки сервисов -->
    <GlassCard v-for="card in cards" :key="card.kind" class="service-card">
      <div class="service-head">
        <span class="service-icon">{{ card.icon }}</span>
        <div class="service-titles">
          <h4>{{ card.title }}</h4>
          <p>{{ card.purpose }}</p>
        </div>
        <StatusPill :status="card.connected ? (card.is_active ? 'connected' : 'error') : 'disconnected'" />
      </div>

      <!-- Что уже известно о подключении -->
      <div v-if="card.connected && card.details" class="service-details">
        <div v-for="row in detailsOf(card)" :key="row.label" class="detail-row">
          <span>{{ row.label }}</span>
          <b>{{ row.value }}</b>
        </div>
        <div v-if="card.last_error" class="detail-error">{{ card.last_error }}</div>
      </div>

      <div class="service-actions">
        <GlassButton
          v-if="!card.connected"
          variant="primary"
          size="md"
          block
          @click="openSheet(card)"
        >
          {{ card.action }}
        </GlassButton>

        <template v-else>
          <GlassButton variant="secondary" size="md" :loading="Boolean(store.loading[`check:${card.kind}`])" @click="check(card)">
            Проверить
          </GlassButton>
          <GlassButton variant="ghost" size="md" @click="openSheet(card)">
            Заменить
          </GlassButton>
          <GlassButton variant="ghost" size="md" danger @click="askDisconnect(card)">
            Отключить
          </GlassButton>
        </template>
      </div>
    </GlassCard>

    <!-- Что дальше -->
    <GlassCard class="next-step">
      <h4>Что дальше</h4>
      <ol class="next-list">
        <li>После подключения откройте «Кампании» и нажмите «Обновить данные» — подтяну статистику из Директа.</li>
        <li>Проверьте трафик на ботов на экране «Ловля ботов».</li>
        <li>Загляните в «Настройки»: укажите нишу, бюджет и целевую цену заявки — тогда появятся рыночные ориентиры.</li>
      </ol>
    </GlassCard>

    <!-- Окно подключения -->
    <BottomSheet
      :model-value="Boolean(sheet)"
      :title="sheet ? `Подключение: ${sheet.title}` : ''"
      :subtitle="sheet?.hint"
      @update:model-value="closeSheet"
    >
      <div v-if="sheet" class="sheet-form">
        <!-- Директ -->
        <template v-if="sheet.kind === 'yandex_direct'">
          <FieldInput
            v-model="form.token"
            label="OAuth-токен Директа"
            placeholder="y0_AgAAAA..."
            hint="Инструменты → Настройки API → Получить токен"
            secret
            :error="error"
          />
          <FieldInput v-model="form.login" label="Логин аккаунта (если агентский)" placeholder="необязательно" />
        </template>

        <!-- Метрика -->
        <template v-else-if="sheet.kind === 'yandex_metrika'">
          <FieldInput
            v-model="form.token"
            label="OAuth-токен Метрики"
            placeholder="y0_AgAAAA..."
            hint="Настройка → Доступ к API → Получить токен"
            secret
            :error="error"
          />
          <FieldInput
            v-model="form.counter_id"
            label="Номер счётчика"
            placeholder="например 98765432"
            inputmode="numeric"
            hint="Оставьте пустым — возьму первый доступный счётчик"
          />
        </template>

        <!-- Сайт -->
        <template v-else>
          <FieldInput
            v-model="form.site_url"
            label="Адрес сайта"
            placeholder="example.ru"
            inputmode="url"
            :error="error"
            @enter="validateSite"
          />
          <p class="sheet-note">
            Подойдёт сайт на любой платформе: Tilda, WordPress, Vercel или свой движок.
            Проверю скорость, мобильную версию, SEO и наличие счётчика Метрики.
          </p>

          <div v-if="passport" class="passport">
            <div class="passport-title">Что нашлось на сайте</div>
            <div v-for="row in passportRows" :key="row.label" class="detail-row">
              <span>{{ row.label }}</span>
              <b>{{ row.value }}</b>
            </div>
            <p v-if="passport.hint" class="passport-hint">{{ passport.hint }}</p>
          </div>
        </template>

        <!-- Понятное объяснение, где взять ключ -->
        <details class="sheet-howto">
          <summary>Как получить ключ? →</summary>
          <ol>
            <li v-for="line in sheet.steps" :key="line">{{ line }}</li>
          </ol>
          <a :href="sheet.link" target="_blank" rel="noopener">Открыть кабинет Яндекса ↗</a>
        </details>
      </div>

      <template #footer>
        <div class="sheet-buttons">
          <GlassButton
            variant="primary"
            size="lg"
            block
            :loading="validating"
            @click="submit"
          >
            {{ validating ? 'Проверяю…' : 'Подключить' }}
          </GlassButton>
          <GlassButton v-if="sheet?.kind === 'hosting'" variant="secondary" size="md" block :loading="checkingSite" @click="validateSite">
            Проверить адрес
          </GlassButton>
        </div>
      </template>
    </BottomSheet>

    <!-- Подтверждение отключения -->
    <BottomSheet
      :model-value="Boolean(pendingDisconnect)"
      title="Отключить сервис?"
      subtitle="Токен будет удалён. История отчётов останется на месте."
      :max-height="50"
      @update:model-value="pendingDisconnect = null"
    >
      <p class="sheet-note">
        {{ pendingDisconnect?.title }} перестанет отдавать данные: расчёты по нему остановятся,
        пока вы не подключите сервис заново.
      </p>
      <template #footer>
        <div class="sheet-buttons">
          <GlassButton variant="danger" size="lg" block @click="confirmDisconnect">Отключить</GlassButton>
          <GlassButton variant="ghost" size="md" block @click="pendingDisconnect = null">Оставить</GlassButton>
        </div>
      </template>
    </BottomSheet>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import BottomSheet from '../components/BottomSheet.vue'
import FieldInput from '../components/FieldInput.vue'
import GlassButton from '../components/GlassButton.vue'
import GlassCard from '../components/GlassCard.vue'
import ScreenHeader from '../components/ScreenHeader.vue'
import StatusPill from '../components/StatusPill.vue'
import { useHaptics } from '../composables/useHaptics'
import { useAppStore } from '../store'

const store = useAppStore()
const haptics = useHaptics()

const sheet = ref(null)
const pendingDisconnect = ref(null)
const validating = ref(false)
const checkingSite = ref(false)
const error = ref('')
const passport = ref(null)

const form = reactive({ token: '', login: '', counter_id: '', site_url: '' })

const CARDS = [
  {
    kind: 'yandex_direct',
    icon: '🎯',
    title: 'Яндекс.Директ',
    purpose: 'Кампании, ставки и расход',
    action: 'Подключить Директ',
    hint: 'Токен нужен, чтобы читать кампании и менять ставки',
    link: 'https://direct.yandex.ru/',
    steps: [
      'Войдите в direct.yandex.ru под аккаунтом, где настроена реклама',
      'Инструменты → Настройки API → «Получить токен»',
      'Скопируйте токен (начинается с y0_) и вставьте в поле выше',
      'Если работаете через агентский аккаунт, укажите логин клиента',
    ],
  },
  {
    kind: 'yandex_metrika',
    icon: '📊',
    title: 'Яндекс.Метрика',
    purpose: 'Визиты, цели и роботы',
    action: 'Подключить Метрику',
    hint: 'Метрика показывает, что происходит на сайте после клика',
    link: 'https://metrika.yandex.ru/',
    steps: [
      'Откройте metrika.yandex.ru → «Настройка» → «Доступ к API»',
      'Получите токен и скопируйте его',
      'Номер счётчика виден в адресе страницы: /counter/XXXXXXXX',
      'Вставьте токен (и номер, если знаете) — проверю доступ сразу',
    ],
  },
  {
    kind: 'hosting',
    icon: '🌐',
    title: 'Сайт клиента',
    purpose: 'Скорость, мобильная версия, SEO',
    action: 'Указать сайт',
    hint: 'Сайт подключается по адресу — платформа любая',
    link: 'https://yandex.ru/dev/direct/',
    steps: [
      'Введите адрес сайта — например example.ru',
      'Проверю доступность, HTTPS, мобильную версию и мета-теги',
      'Найду счётчик Метрики и карту сайта, если они есть',
      'Работает с Tilda, WordPress, Vercel и самописными сайтами',
    ],
  },
]

const cards = computed(() => {
  const state = store.services?.services || []
  return CARDS.map((card) => {
    const found = state.find((item) => item.kind === card.kind)
    return {
      ...card,
      connected: Boolean(found?.connected),
      is_active: found?.is_active !== false,
      details: found?.details || {},
      last_error: found?.last_error || '',
    }
  })
})

const connectedCount = computed(() => store.services?.connected_count || 0)
const total = computed(() => store.services?.total || 3)
const percent = computed(() => Math.round((connectedCount.value / total.value) * 100))

function detailsOf(card) {
  const details = card.details || {}
  if (card.kind === 'yandex_direct') {
    return [
      { label: 'Кампаний доступно', value: details.campaigns ?? '—' },
      { label: 'Токен', value: details.token_masked || '—' },
      ...(details.login ? [{ label: 'Логин', value: details.login }] : []),
    ]
  }
  if (card.kind === 'yandex_metrika') {
    return [
      { label: 'Счётчик', value: details.counter_name || details.counter_id || '—' },
      { label: 'Номер', value: details.counter_id ?? '—' },
      { label: 'Целей найдено', value: details.goals ?? '—' },
    ]
  }
  return [
    { label: 'Адрес', value: details.site_url || '—' },
    { label: 'Платформа', value: details.platform_title || details.platform || '—' },
    { label: 'Хостинг', value: details.hosting || '—' },
    { label: 'HTTPS', value: details.https ? 'да' : 'нет' },
  ]
}

const passportRows = computed(() => {
  const data = passport.value
  if (!data) return []
  return [
    { label: 'Код ответа', value: data.status_code ?? '—' },
    { label: 'Скорость', value: data.response_ms ? `${data.response_ms} мс` : '—' },
    { label: 'Платформа', value: data.platform_title || data.platform || '—' },
    { label: 'Хостинг', value: data.hosting || '—' },
    { label: 'HTTPS', value: data.https ? 'настроен' : 'нет' },
    { label: 'Счётчик Метрики', value: data.has_metrika ? 'найден' : 'не найден' },
    { label: 'Карта сайта', value: data.has_sitemap ? 'есть' : 'нет' },
  ]
})

function openSheet(card) {
  haptics.medium()
  sheet.value = card
  error.value = ''
  passport.value = null
  form.token = ''
  form.login = ''
  form.counter_id = ''
  form.site_url = card.details?.site_url || ''
}

function closeSheet() {
  sheet.value = null
  error.value = ''
  passport.value = null
}

async function validateSite() {
  if (!form.site_url.trim()) {
    error.value = 'Введите адрес сайта'
    haptics.error()
    return
  }
  checkingSite.value = true
  haptics.light()
  const data = await store.sitePassport(form.site_url.trim())
  checkingSite.value = false
  if (data) {
    passport.value = data
    haptics.success()
  } else {
    error.value = store.lastError
    haptics.error()
  }
}

async function submit() {
  const card = sheet.value
  if (!card) return

  error.value = ''
  if (card.kind === 'hosting') {
    if (!form.site_url.trim()) {
      error.value = 'Введите адрес сайта'
      haptics.error()
      return
    }
  } else if (!form.token.trim()) {
    error.value = 'Вставьте токен — без него сервис не подключится'
    haptics.error()
    return
  }

  validating.value = true
  haptics.medium()

  const payload = card.kind === 'hosting'
    ? { site_url: form.site_url.trim() }
    : {
        token: form.token.trim(),
        login: form.login.trim(),
        counter_id: form.counter_id ? Number(form.counter_id.replace(/\D/g, '')) : null,
      }

  const data = await store.connectService(card.kind, payload)
  validating.value = false

  if (data) {
    haptics.success()
    closeSheet()
  } else {
    error.value = store.lastError
    haptics.error()
  }
}

async function check(card) {
  haptics.light()
  await store.checkService(card.kind)
}

function askDisconnect(card) {
  haptics.warning()
  pendingDisconnect.value = card
}

async function confirmDisconnect() {
  const card = pendingDisconnect.value
  pendingDisconnect.value = null
  if (card) await store.disconnectService(card.kind)
}

onMounted(() => {
  store.loadServices()
})
</script>

<style scoped>
.connect-page {
  min-height: 100vh;
  padding-bottom: calc(96px + env(safe-area-inset-bottom));
  position: relative;
  z-index: 1;
}

.lead {
  padding: var(--space-4) var(--space-5) var(--space-4);
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-secondary);
}

.progress {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-5) var(--space-5);
}

.progress-bar {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--surface-overlay);
  overflow: hidden;
}

.progress-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--gradient-brand);
  transition: width var(--duration-slow) var(--ease-ios);
}

.progress-text {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  white-space: nowrap;
}

.service-card {
  margin: 0 var(--space-5) var(--space-3);
}

.service-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.service-icon {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  background: var(--surface-overlay);
}

.service-titles {
  flex: 1;
  min-width: 0;
}

.service-titles h4 {
  font-size: var(--fs-headline);
  margin-bottom: 2px;
}

.service-titles p {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
}

.service-details {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.detail-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--fs-caption);
}

.detail-row span {
  color: var(--text-secondary);
}

.detail-row b {
  font-weight: var(--fw-semibold);
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-error {
  margin-top: 4px;
  font-size: var(--fs-caption);
  color: var(--accent-red);
  line-height: 1.4;
}

.service-actions {
  margin-top: var(--space-4);
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.next-step {
  margin: var(--space-2) var(--space-5) var(--space-6);
}

.next-step h4 {
  font-size: var(--fs-headline);
  margin-bottom: var(--space-3);
}

.next-list {
  margin-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--fs-footnote);
  line-height: 1.45;
  color: var(--text-secondary);
}

/* Окно подключения */
.sheet-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.sheet-note {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  line-height: 1.45;
}

.sheet-howto {
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.sheet-howto summary {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--accent-blue);
  cursor: pointer;
  list-style: none;
}

.sheet-howto summary::-webkit-details-marker {
  display: none;
}

.sheet-howto ol {
  margin: var(--space-3) 0;
  padding-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.45;
}

.sheet-howto a {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--accent-blue);
  text-decoration: none;
}

.passport {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: rgba(48, 209, 88, 0.08);
  border: 1px solid rgba(48, 209, 88, 0.2);
}

.passport-title {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-semibold);
  color: var(--accent-green);
  margin-bottom: 3px;
}

.passport-hint {
  margin-top: var(--space-2);
  font-size: var(--fs-caption);
  color: var(--text-secondary);
  line-height: 1.45;
}

.sheet-buttons {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
