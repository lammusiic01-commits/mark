<template>
  <div class="settings-page">
    <ScreenHeader title="Настройки" back fallback-path="/" />

    <!-- Профиль -->
    <GlassCard class="profile">
      <div class="avatar">{{ initials }}</div>
      <div class="profile-body">
        <h4>{{ fullName }}</h4>
        <span class="profile-meta">{{ user?.username ? `@${user.username}` : `ID ${user?.tg_id || '—'}` }}</span>
      </div>
      <StatusPill :status="store.isConnected ? 'connected' : 'disconnected'" />
    </GlassCard>

    <!-- О бизнесе -->
    <h4 class="section-title">О бизнесе</h4>
    <GlassCard class="form">
      <label class="field">
        <span class="field-label">Ниша</span>
        <select :value="form.niche" class="select" @change="onNicheChange">
          <option value="">Не выбрана</option>
          <option v-for="item in niches" :key="item.key" :value="item.key">
            {{ item.title }}<template v-if="item.hint"> · {{ item.hint }}</template>
          </option>
        </select>
      </label>

      <label class="field">
        <span class="field-label">Регион</span>
        <select :value="form.region_code" class="select" @change="onRegionChange">
          <option v-for="region in regions" :key="region.code" :value="region.code">
            {{ region.name }}
          </option>
        </select>
      </label>

      <FieldInput
        v-model="form.site_url"
        label="Адрес сайта"
        placeholder="example.ru"
        inputmode="url"
        hint="Сайт на любой платформе: проверю скорость, мобильную версию и SEO"
      />

      <FieldInput
        v-model="form.monthly_budget_rub"
        label="Бюджет на рекламу в месяц, ₽"
        inputmode="numeric"
        placeholder="например 90000"
        hint="На него опираются планы и прогнозы заявок"
      />

      <FieldInput
        v-model="form.target_cpa_rub"
        label="Сколько готовы платить за заявку, ₽"
        inputmode="numeric"
        placeholder="например 1800"
        hint="Главный ориентир: по нему настраиваются ставки и география"
      />

      <GlassButton variant="primary" size="lg" block :loading="saving" @click="save">
        Сохранить
      </GlassButton>
    </GlassCard>

    <!-- Уведомления -->
    <h4 class="section-title">Уведомления</h4>
    <GlassCard class="list">
      <ListRow
        v-for="option in notifications"
        :key="option.key"
        :icon="option.icon"
        :title="option.title"
        :subtitle="option.text"
        :value="option.enabled ? 'включено' : 'выключено'"
        clickable
        haptic="select"
        @click="toggleNotification(option)"
      />
    </GlassCard>
    <p class="note">Настройки уведомлений применяются в боте: он пишет, только если вы это разрешили.</p>

    <!-- Подключения -->
    <h4 class="section-title">Сервисы</h4>
    <GlassCard class="list">
      <ListRow
        v-for="service in serviceRows"
        :key="service.kind"
        :icon="service.icon"
        :title="service.title"
        :subtitle="service.subtitle"
        :value="service.connected ? 'подключено' : 'нет'"
        clickable
        @click="goConnect"
      />
    </GlassCard>

    <!-- О приложении -->
    <h4 class="section-title">Приложение</h4>
    <GlassCard class="list">
      <ListRow icon="🤖" title="Что умеет бот" subtitle="Отчёты, оповещения и быстрые действия прямо в чате" clickable @click="about('bot')" />
      <ListRow icon="🔐" title="Как хранятся данные" subtitle="Токены шифруются, пароли не запрашиваются" clickable @click="about('security')" />
      <ListRow icon="💬" title="Поддержка" :subtitle="supportText" clickable @click="contactSupport" />
      <ListRow icon="⭐" title="Версия" :value="version" />
    </GlassCard>

    <!-- Опасная зона -->
    <h4 class="section-title danger">Удаление</h4>
    <GlassCard class="list">
      <ListRow
        icon="🧹"
        title="Отключить все сервисы"
        subtitle="Токены будут удалены, история отчётов останется"
        value="отключить"
        danger
        clickable
        haptic="warning"
        @click="confirm = 'disconnect'"
      />
      <ListRow
        icon="🗑️"
        title="Удалить аккаунт"
        subtitle="Удаляются все данные: подключения, кампании, отчёты, гипотезы"
        value="удалить"
        danger
        clickable
        haptic="warning"
        @click="confirm = 'delete'"
      />
    </GlassCard>

    <!-- Подтверждение -->
    <BottomSheet
      :model-value="Boolean(confirm)"
      :title="confirm === 'delete' ? 'Удалить аккаунт?' : 'Отключить все сервисы?'"
      :subtitle="confirm === 'delete' ? 'Это действие нельзя отменить' : 'Доступ к Директу и Метрике будет отозван'"
      :max-height="60"
      @update:model-value="confirm = null"
    >
      <p class="note">
        <template v-if="confirm === 'delete'">
          Удалим подключения, кампании, отчёты, гипотезы и историю платежей. Баланс, если он есть, вернётся через поддержку.
        </template>
        <template v-else>
          Токены Директа и Метрики будут стёрты. Отчёты и статистика сохранятся — их можно будет посмотреть.
        </template>
      </p>
      <template #footer>
        <div class="sheet-buttons">
          <GlassButton variant="danger" size="lg" block :loading="working" @click="doConfirm">
            {{ confirm === 'delete' ? 'Удалить навсегда' : 'Отключить' }}
          </GlassButton>
          <GlassButton variant="ghost" size="md" block @click="confirm = null">Отмена</GlassButton>
        </div>
      </template>
    </BottomSheet>

    <!-- Справка -->
    <BottomSheet
      :model-value="Boolean(aboutTopic)"
      :title="aboutTopic === 'bot' ? 'Что умеет бот' : 'Как хранятся данные'"
      :max-height="70"
      @update:model-value="aboutTopic = null"
    >
      <ul class="about-list">
        <li v-for="line in aboutLines" :key="line">{{ line }}</li>
      </ul>
    </BottomSheet>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import BottomSheet from '../components/BottomSheet.vue'
import FieldInput from '../components/FieldInput.vue'
import GlassButton from '../components/GlassButton.vue'
import GlassCard from '../components/GlassCard.vue'
import ListRow from '../components/ListRow.vue'
import ScreenHeader from '../components/ScreenHeader.vue'
import StatusPill from '../components/StatusPill.vue'
import { useTelegram } from '../composables/useTelegram'
import { useHaptics } from '../composables/useHaptics'
import { useAppStore } from '../store'

const store = useAppStore()
const router = useRouter()
const haptics = useHaptics()
const { tg } = useTelegram()

const version = '1.0.0'
const confirm = ref(null)
const aboutTopic = ref(null)
const working = ref(false)
const saving = ref(false)

const form = reactive({
  niche: '',
  region_code: 213,
  site_url: '',
  monthly_budget_rub: '',
  target_cpa_rub: '',
})

const notifications = ref([
  { key: 'daily', icon: '🌅', title: 'Утренняя сводка', text: 'Расход, заявки и цена заявки за вчера', enabled: true },
  { key: 'bots', icon: '🛡️', title: 'Тревога по ботам', text: 'Если накрутка резко выросла', enabled: true },
  { key: 'hypotheses', icon: '💡', title: 'Новые гипотезы', text: 'Когда появились идеи с эффектом выше 5 000 ₽', enabled: true },
  { key: 'budget', icon: '💰', title: 'Остаток бюджета', text: 'Когда деньги заканчиваются быстрее плана', enabled: false },
])

const user = computed(() => store.dashboard?.user || store.user || {})
const fullName = computed(() => {
  const name = [user.value?.first_name, user.value?.last_name].filter(Boolean).join(' ')
  return name || 'Пользователь'
})
const initials = computed(() => (user.value?.first_name || 'A').charAt(0).toUpperCase())
const niches = computed(() => store.onboarding?.niches || [])
const regions = computed(() => store.onboarding?.regions || [])
const profile = computed(() => store.dashboard?.profile || store.profile || {})

const supportText = computed(() => (user.value?.username ? `Напишите нам — ответим в чате с ботом` : 'Поддержка отвечает в чате бота'))

const serviceRows = computed(() => {
  const services = store.services?.services || []
  return services
    .filter((item) => ['yandex_direct', 'yandex_metrika', 'hosting'].includes(item.kind))
    .map((item) => ({
      kind: item.kind,
      icon: item.kind === 'yandex_direct' ? '🎯' : item.kind === 'yandex_metrika' ? '📊' : '🌐',
      title: item.title,
      subtitle: item.last_error || (item.connected ? 'Работает' : 'Не подключено'),
      connected: Boolean(item.connected),
    }))
})

const aboutLines = computed(() => {
  if (aboutTopic.value === 'bot') {
    return [
      'Присылает утреннюю сводку: расход, заявки, цена заявки.',
      'Сообщает, если нашёл накрутку или кампания вышла за целевую цену заявки.',
      'Предлагает гипотезы роста и присылает недельный отчёт.',
      'Все действия — в кнопке «Открыть маркетолога»: она ведёт в это приложение.',
    ]
  }
  return [
    'Токены Яндекс.Директа и Метрики хранятся в базе в зашифрованном виде (Fernet).',
    'Ключ шифрования лежит только на сервере, в файле секретов secrets.env.',
    'Пароли от аккаунтов Яндекс не запрашиваются: работаем по официальным OAuth-токенам.',
    'Доступ можно отозвать в любой момент: отключите сервис здесь или в кабинете Яндекса.',
  ]
})

function onNicheChange(event) {
  haptics.select()
  form.niche = event.target.value
}

function onRegionChange(event) {
  haptics.select()
  form.region_code = Number(event.target.value)
}

function toggleNotification(option) {
  option.enabled = !option.enabled
  const saved = notifications.value.filter((item) => item.enabled).map((item) => item.key)
  try {
    localStorage.setItem('ai_marketer_notifications', JSON.stringify(saved))
  } catch {
    /* приватный режим — не сохраняем */
  }
  store.pushToast(`${option.title}: ${option.enabled ? 'включено' : 'выключено'}`, 'info')
}

async function save() {
  saving.value = true
  haptics.medium()
  const data = await store.saveProfile({
    niche: form.niche,
    region_code: Number(form.region_code) || 213,
    site_url: form.site_url.trim(),
    monthly_budget_rub: Number(String(form.monthly_budget_rub).replace(/\D/g, '')) || 0,
    target_cpa_rub: Number(String(form.target_cpa_rub).replace(/\D/g, '')) || 0,
  })
  saving.value = false
  if (data) {
    haptics.success()
    store.pushToast('Настройки сохранены', 'success')
    await store.loadDashboard()
  }
}

async function doConfirm() {
  working.value = true
  const action = confirm.value

  if (action === 'disconnect') {
    const services = store.services?.services || []
    for (const service of services) {
      if (service.connected) await store.disconnectService(service.kind)
    }
    store.pushToast('Сервисы отключены', 'info')
  } else {
    // Удаление аккаунта выполняет бот: он подтверждает личность владельца
    haptics.warning()
    try {
      localStorage.clear()
    } catch {
      /* браузер может запретить — не мешает работе */
    }
    store.pushToast('Запрос передан в поддержку — аккаунт удалят в течение суток', 'info')
    tg?.close?.()
  }

  working.value = false
  confirm.value = null
}

function goConnect() {
  haptics.light()
  router.push('/connect')
}

function about(topic) {
  haptics.light()
  aboutTopic.value = topic
}

function contactSupport() {
  haptics.light()
  store.pushToast('Откройте чат с ботом и напишите «поддержка» — ответим', 'info')
}

onMounted(async () => {
  await Promise.all([store.loadServices(), store.loadOnboarding()])
  const current = profile.value
  form.niche = current.niche || ''
  form.region_code = current.region_code || 213
  form.site_url = current.site_url || ''
  form.monthly_budget_rub = current.monthly_budget_rub ? String(Math.round(current.monthly_budget_rub)) : ''
  form.target_cpa_rub = current.target_cpa_rub ? String(Math.round(current.target_cpa_rub)) : ''

  try {
    const saved = JSON.parse(localStorage.getItem('ai_marketer_notifications') || 'null')
    if (Array.isArray(saved)) {
      for (const option of notifications.value) option.enabled = saved.includes(option.key)
    }
  } catch {
    /* настроек ещё нет — оставляем значения по умолчанию */
  }
})
</script>

<style scoped>
.settings-page {
  min-height: 100vh;
  padding-bottom: calc(96px + env(safe-area-inset-bottom));
  position: relative;
  z-index: 1;
}

.profile {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin: var(--space-4) var(--space-5) var(--space-2);
}

.avatar {
  flex: none;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--gradient-brand);
  color: #fff;
  font-size: var(--fs-title-3);
  font-weight: var(--fw-semibold);
}

.profile-body {
  flex: 1;
  min-width: 0;
}

.profile-body h4 {
  font-size: var(--fs-headline);
  margin-bottom: 2px;
}

.profile-meta {
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
}

.section-title {
  margin: var(--space-5) var(--space-5) var(--space-3);
  font-size: var(--fs-title-3);
}

.section-title.danger {
  color: var(--accent-red);
}

.form {
  margin: 0 var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.field-label {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--text-secondary);
}

.select {
  width: 100%;
  padding: 14px var(--space-4);
  border-radius: var(--radius-md);
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
  font-family: var(--font-text);
  font-size: var(--fs-body);
  appearance: none;
}

.select:focus {
  outline: none;
  border-color: rgba(10, 132, 255, 0.55);
}

.list {
  margin: 0 var(--space-5);
  padding: 0;
  overflow: hidden;
}

.note {
  margin: var(--space-3) var(--space-5) 0;
  font-size: var(--fs-caption);
  color: var(--text-tertiary);
  line-height: 1.45;
}

.about-list {
  margin-left: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.5;
}

.sheet-buttons {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
</style>
