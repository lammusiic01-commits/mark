<script setup>
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from './components/layout/AppHeader.vue'
import AppNav from './components/layout/AppNav.vue'
import { setBackButton } from './composables/useTelegram.js'

const route = useRoute()
const router = useRouter()

const showChrome = computed(() => !route.meta.bare)
const title = computed(() => route.meta.title || '')
const backTo = computed(() => route.meta.back || '')

function goBack() {
  if (backTo.value) router.push(backTo.value)
  else router.back()
}

// Нативная кнопка «Назад» Telegram синхронизируется с маршрутом
watch(backTo, (to) => {
  setBackButton(!!to, goBack)
}, { immediate: true })
</script>

<template>
  <div class="app-shell">
    <AppHeader v-if="showChrome" :title="title" :can-back="!!backTo" @back="goBack" />
    <main class="app-main" :class="{ 'no-nav': !showChrome }">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in">
          <component :is="Component" :key="route.path" />
        </transition>
      </router-view>
    </main>
    <AppNav v-if="showChrome" />
  </div>
</template>
