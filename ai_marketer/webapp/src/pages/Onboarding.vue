<template>
  <div class="onboarding">
    <!-- Шапка: прогресс и пропуск -->
    <header class="header safe-top">
      <button class="skip" type="button" @click="skip">Пропустить</button>
      <div class="dots">
        <span v-for="i in TOTAL" :key="i" class="dot" :class="{ active: i - 1 === step, passed: i - 1 < step }" />
      </div>
      <div class="header-space" />
    </header>

    <!-- Шаги -->
    <transition name="slide" mode="out-in">
      <div :key="step" class="step-content">
        <!-- 1. Приветствие с орбом -->
        <section v-if="step === 0" class="welcome">
          <GradientOrb :size="196" />
          <h1 class="hero-title">AI Маркетолог</h1>
          <p class="hero-subtitle">
            Слежу за вашей рекламой в Яндекс.Директе,<br />
            возвращаю деньги и подсказываю, что делать
          </p>
        </section>

        <!-- 2. Что умеет -->
        <section v-else-if="step === 1" class="features">
          <h2 class="step-title">Что я умею</h2>
          <div class="feature-list">
            <GlassCard v-for="feature in features" :key="feature.title" class="feature">
              <span class="feature-emoji">{{ feature.icon }}</span>
              <div>
                <h4>{{ feature.title }}</h4>
                <p>{{ feature.text }}</p>
              </div>
            </GlassCard>
          </div>
        </section>

        <!-- 3. Где взять ключ -->
        <section v-else-if="step === 2" class="instructions">
          <h2 class="step-title">Нужны два ключа</h2>
          <p class="lead">
            Каждый берётся в кабинете Яндекса за пару минут.<br />
            Вставлять их нужно только здесь — в приложении.
          </p>

          <GlassCard v-for="(service, index) in services" :key="service.id" class="instr-card">
            <div class="instr-head">
              <span class="instr-num">{{ index + 1 }}</span>
              <div>
                <h4>{{ service.name }}</h4>
                <p class="instr-sub">{{ service.purpose }}</p>
              </div>
            </div>

            <details class="instr-howto">
              <summary>Где взять ключ? →</summary>
              <ol class="instr-steps">
                <li v-for="line in service.steps" :key="line">{{ line }}</li>
              </ol>
              <a :href="service.link" target="_blank" rel="noopener" class="instr-link">
                Открыть кабинет Яндекса ↗
              </a>
            </details>
          </GlassCard>
        </section>

        <!-- 4. Безопасность -->
        <section v-else-if="step === 3" class="security">
          <div class="shield-icon">🛡️</div>
          <h2 class="step-title">Данные под защитой</h2>
          <div class="security-list">
            <GlassCard v-for="card in security" :key="card.title">
              <h4>{{ card.title }}</h4>
              <p>{{ card.text }}</p>
            </GlassCard>
          </div>
        </section>

        <!-- 5. Готово -->
        <section v-else class="ready">
          <GradientOrb :size="150" />
          <h2 class="step-title">Всё готово</h2>
          <p class="hero-subtitle">Осталось подключить Директ и Метрику — дальше я всё считаю сам</p>
        </section>
      </div>
    </transition>

    <!-- Кнопка внизу -->
    <footer class="footer safe-bottom">
      <GlassButton variant="primary" size="lg" block :loading="loading" @click="next">
        {{ step === TOTAL - 1 ? 'Подключить сервисы' : 'Далее' }}
      </GlassButton>
    </footer>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import GlassButton from '../components/GlassButton.vue'
import GlassCard from '../components/GlassCard.vue'
import GradientOrb from '../components/GradientOrb.vue'
import { useHaptics } from '../composables/useHaptics'
import { useAppStore } from '../store'

const router = useRouter()
const haptics = useHaptics()
const store = useAppStore()

const TOTAL = 5
const step = ref(0)
const loading = computed(() => Boolean(store.loading.complete))

const features = [
  { icon: '🤖', title: 'Ловлю ботов', text: 'Нахожу накрутку кликов и возвращаю деньги в рекламу' },
  { icon: '📊', title: 'Считаю экономику', text: 'Цена заявки, расход и окупаемость — на одном экране' },
  { icon: '💡', title: 'Предлагаю гипотезы', text: 'Что изменить в кампаниях, с расчётом эффекта в рублях' },
  { icon: '⚡', title: 'Управляю ставками', text: 'Подстраиваю ставки под вашу целевую цену заявки' },
]

const services = [
  {
    id: 'direct',
    name: 'Яндекс.Директ',
    purpose: 'Управление кампаниями и ставками',
    link: 'https://direct.yandex.ru/',
    steps: [
      'Откройте direct.yandex.ru под аккаунтом, где настроена реклама',
      'Инструменты → Настройки API → «Получить токен»',
      'Разрешите доступ и скопируйте токен (начинается с y0_)',
      'Вставьте его в приложении на экране подключения',
    ],
  },
  {
    id: 'metrika',
    name: 'Яндекс.Метрика',
    purpose: 'Визиты, цели и поиск роботов',
    link: 'https://metrika.yandex.ru/',
    steps: [
      'Откройте metrika.yandex.ru → «Настройка» → «Доступ к API»',
      'Нажмите «Получить токен» и скопируйте его',
      'Там же посмотрите номер счётчика (в адресе страницы)',
      'Вставьте токен и номер счётчика в приложении',
    ],
  },
  {
    id: 'hosting',
    name: 'Сайт клиента',
    purpose: 'Проверка скорости, мобильной версии и SEO',
    link: 'https://yandex.ru/dev/direct/',
    steps: [
      'Ничего получать не нужно — просто укажите адрес сайта',
      'Подойдёт Tilda, WordPress, свой сайт или лендинг на любой платформе',
      'Пришлите адрес — соберу паспорт сайта: платформа, HTTPS, счётчик, карта сайта',
      'Если сайта нет, продолжайте без него: реклама и метрика работают отдельно',
    ],
  },
]

const security = [
  { title: '🔐 Токены зашифрованы', text: 'Хранятся в зашифрованном виде (Fernet, ключ только на сервере) и не покидают его' },
  { title: '👤 Пароли не нужны', text: 'Работаем по официальным токенам Яндекс API — доступ можно отозвать в любой момент' },
  { title: '↩️ Контроль у вас', text: 'Каждое изменение видно и отменяется одной кнопкой' },
]

async function next() {
  haptics.medium()
  if (step.value < TOTAL - 1) {
    step.value += 1
    return
  }
  // Завершаем знакомство: повторно онбординг не показывается
  await store.completeOnboarding()
  haptics.success()
  router.push('/connect')
}

async function skip() {
  haptics.light()
  await store.completeOnboarding()
  router.push('/connect')
}

onMounted(() => {
  store.loadOnboarding()
})
</script>

<style scoped>
.onboarding {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  padding-bottom: calc(96px + env(safe-area-inset-bottom));
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: calc(10px + env(safe-area-inset-top)) var(--space-5) var(--space-3);
}

.skip {
  min-width: 92px;
  text-align: left;
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
}

.header-space {
  min-width: 92px;
}

.dots {
  display: flex;
  gap: 6px;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--border-strong);
  transition: all var(--duration-normal) var(--ease-ios);
}

.dot.passed {
  background: var(--text-tertiary);
}

.dot.active {
  width: 22px;
  border-radius: var(--radius-pill);
  background: var(--accent-blue);
}

.step-content {
  flex: 1;
  padding: var(--space-4) var(--space-5) var(--space-6);
}

.step-title {
  font-size: var(--fs-title-1);
  margin-bottom: var(--space-4);
  letter-spacing: -0.02em;
}

/* Шаг 1 */
.welcome {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-6);
}

.hero-title {
  font-size: var(--fs-large);
  font-weight: var(--fw-bold);
  letter-spacing: -0.03em;
}

.hero-subtitle {
  max-width: 320px;
  font-size: var(--fs-body);
  line-height: 1.5;
  color: var(--text-secondary);
}

/* Шаг 2 */
.feature-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.feature {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.feature-emoji {
  font-size: 30px;
  line-height: 1;
}

.feature h4 {
  font-size: var(--fs-headline);
  margin-bottom: 3px;
}

.feature p {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.4;
}

/* Шаг 3 */
.lead {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: var(--space-5);
}

.instr-card {
  margin-bottom: var(--space-3);
}

.instr-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.instr-num {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 132, 255, 0.16);
  color: var(--accent-blue);
  font-weight: var(--fw-semibold);
  font-size: var(--fs-footnote);
}

.instr-head h4 {
  font-size: var(--fs-headline);
  margin-bottom: 2px;
}

.instr-sub {
  font-size: var(--fs-caption);
  color: var(--text-secondary);
}

.instr-howto {
  margin-top: var(--space-4);
  border-top: 1px solid var(--border-subtle);
  padding-top: var(--space-3);
}

.instr-howto summary {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--accent-blue);
  cursor: pointer;
  list-style: none;
}

.instr-howto summary::-webkit-details-marker {
  display: none;
}

.instr-steps {
  margin: var(--space-3) 0 var(--space-3) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.45;
}

.instr-link {
  font-size: var(--fs-footnote);
  font-weight: var(--fw-medium);
  color: var(--accent-blue);
  text-decoration: none;
}

/* Шаг 4 */
.shield-icon {
  font-size: 60px;
  text-align: center;
  margin-bottom: var(--space-4);
}

.security {
  text-align: center;
}

.security-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  text-align: left;
}

.security-list h4 {
  font-size: var(--fs-headline);
  margin-bottom: 4px;
}

.security-list p {
  font-size: var(--fs-footnote);
  color: var(--text-secondary);
  line-height: 1.45;
}

/* Шаг 5 */
.ready {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-6);
}

.footer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding: var(--space-4) var(--space-5) calc(var(--space-5) + env(safe-area-inset-bottom));
  background: linear-gradient(to top, rgba(0, 0, 0, 0.92) 55%, transparent);
}

.slide-enter-active,
.slide-leave-active {
  transition: opacity var(--duration-normal) var(--ease-ios), transform var(--duration-normal) var(--ease-ios);
}

.slide-enter-from {
  opacity: 0;
  transform: translateX(24px);
}

.slide-leave-to {
  opacity: 0;
  transform: translateX(-24px);
}
</style>
