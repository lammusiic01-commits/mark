<script setup lang="ts">
import GlassCard from '../components/GlassCard.vue';
import { openExternal } from '../telegram';
import { agencyName, go, userName, isVerified, type MiniScreen } from '../useMiniapp';

/**
 * «Ещё» — второй уровень приложения: всё, что не поместилось в четыре вкладки.
 * Список повторяет структуру промта, но собран в один экран, чтобы таббар
 * оставался коротким и удобным для большого пальца.
 */

const ITEMS: { id: MiniScreen; icon: string; title: string; text: string }[] = [
  { id: 'connect', icon: '🔌', title: 'Подключения', text: 'Ключи сервисов, окно входа, проверка доступа' },
  { id: 'campaigns', icon: '🎯', title: 'Кампании и ставки', text: 'Рекомендации движка по каждой фразе' },
  { id: 'hypotheses', icon: '🧪', title: 'Гипотезы роста', text: 'ICE-приоритет, запуск тестов, статистика' },
  { id: 'reports', icon: '📄', title: 'Отчёты клиентам', text: 'Сборка, HTML и PDF под белой меткой' },
  { id: 'settings', icon: '⚙️', title: 'Настройки', text: 'Агентство, автоматизация, AI, диагностика' },
];
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">{{ agencyName }}</div>
        <h1 class="mini-title">Ещё</h1>
      </div>
      <span class="badge" :class="isVerified ? 'badge-live' : 'badge-warn'">{{ isVerified ? 'Telegram' : 'браузер' }}</span>
    </header>

    <GlassCard style="margin-bottom: 14px">
      <div class="mini-row">
        <div class="list-icon">👋</div>
        <div>
          <div style="font-weight: 600">{{ userName }}</div>
          <div class="mini-hint">Это приложение работает и в браузере — удобно, когда рядом ноутбук</div>
        </div>
      </div>
    </GlassCard>

    <GlassCard v-for="item in ITEMS" :key="item.id" tight style="margin-bottom: 8px">
      <button style="all: unset; display: block; width: 100%; cursor: pointer" @click="go(item.id)">
        <div class="mini-row">
          <div class="list-icon">{{ item.icon }}</div>
          <div style="flex: 1">
            <div class="list-item-title">{{ item.title }}</div>
            <div class="mini-hint">{{ item.text }}</div>
          </div>
          <span class="mini-hint">›</span>
        </div>
      </button>
    </GlassCard>

    <div class="mini-section-title">Помощь</div>
    <GlassCard>
      <div style="font-weight: 600">Инструкция по запуску</div>
      <div class="mini-hint" style="margin-top: 4px">
        Полная инструкция (docs/RUNBOOK.md) описывает установку на сервер, Docker, автозапуск, подключение сервисов и бэкапы.
      </div>
      <button class="btn-glass" style="margin-top: 10px; width: 100%" @click="openExternal('/docs')">Открыть полную версию</button>
    </GlassCard>

    <div class="mini-hint" style="text-align: center; margin-top: 16px">
      AI Маркетолог · MARK · сделано для агентств из России
    </div>
  </div>
</template>
