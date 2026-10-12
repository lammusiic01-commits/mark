<template>
  <div class="app">
    <!-- Фоновое свечение: чуть заметный градиент, чтобы чёрный не был «плоским» -->
    <div class="bg-gradient" aria-hidden="true" />

    <!-- Загрузка: пока проверяем доступ, показываем орб -->
    <div v-if="!store.ready" class="boot">
      <GradientOrb :size="150" />
      <p class="boot-text">Загружаем вашу рекламу…</p>
    </div>

    <!-- Открыто вне Telegram и нет сохранённой строки входа -->
    <div v-else-if="store.offline" class="boot">
      <GradientOrb :size="130" />
      <h1 class="boot-title">Откройте приложение из бота</h1>
      <p class="boot-text">
        Приложение работает внутри Telegram: там оно знает, кто вы, и показывает ваши кампании.
        Найдите бота в чате и нажмите кнопку «Открыть маркетолога».
      </p>
      <GlassButton v-if="isDev" variant="secondary" :loading="store.loading.dev" @click="devEnter">
        Войти как разработчик
      </GlassButton>
    </div>

    <!-- Приложение -->
    <template v-else>
      <router-view v-slot="{ Component }">
        <transition name="view" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>

      <BottomNav v-if="showNav" />
    </template>

    <ToastStack />
  </div>
</template>

<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import BottomNav from './components/BottomNav.vue'
import GradientOrb from './components/GradientOrb.vue'
import GlassButton from './components/GlassButton.vue'
import ToastStack from './components/ToastStack.vue'
import { useAppStore } from './store'
import { useTelegram } from './composables/useTelegram'

const store = useAppStore()
const route = useRoute()
const { tg, ready, expand, setTheme, applyViewport } = useTelegram()

const isDev = import.meta.env.DEV

/* Навигация скрыта на онбординге и подключении: там свои шаги и кнопки */
const showNav = computed(() => !['/onboarding', '/connect'].includes(route.path) && store.ready && !store.offline)

onMounted(async () => {
  ready()
  expand()
  setTheme()
  applyViewport()

  if (tg?.onEvent) {
    tg.onEvent('viewportChanged', applyViewport)
  }

  await store.init()
  if (!store.offline) await store.loadOnboarding()
})

async function devEnter() {
  await store.devSignIn()
}
</script>

<style scoped>
.app {
  position: relative;
  min-height: 100vh;
  background: var(--bg-primary);
}

.bg-gradient {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(circle at 18% 8%, rgba(10, 132, 255, 0.10), transparent 52%),
    radial-gradient(circle at 84% 92%, rgba(191, 90, 242, 0.08), transparent 55%);
}

.boot {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-5);
  padding: var(--space-8) var(--space-6) calc(var(--space-10) + env(safe-area-inset-bottom));
  text-align: center;
}

.boot-title {
  font-size: var(--fs-title-2);
  font-weight: var(--fw-bold);
  letter-spacing: -0.02em;
}

.boot-text {
  max-width: 320px;
  font-size: var(--fs-footnote);
  line-height: 1.5;
  color: var(--text-secondary);
}

.view-enter-active,
.view-leave-active {
  transition: opacity var(--duration-fast) var(--ease-ios), transform var(--duration-normal) var(--ease-ios);
}

.view-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.view-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
