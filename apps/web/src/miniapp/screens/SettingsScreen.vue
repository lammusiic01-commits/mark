<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import GlassButton from '../components/GlassButton.vue';
import GlassCard from '../components/GlassCard.vue';
import LoaderBlock from '../components/LoaderBlock.vue';
import { tgApi } from '../api';
import { openExternal } from '../telegram';
import { toastErr, toastOk } from '../useToasts';
import { agencyName, isVerified, session } from '../useMiniapp';
import { timeAgo } from '../format';

/**
 * Настройки приложения: агентство, уведомления, AI, диагностика.
 *
 * Здесь же — честный статус: проверена ли подпись Telegram, какие сервисы
 * подключены, что с ботом. Никаких «всё хорошо» без данных.
 */

interface SettingsPayload {
  tenant: { id: string; agencyName: string; brandColor: string; logoDataUrl: string | null; hideMarkBranding: boolean };
  settings: Record<string, unknown>;
  role: string;
  verified: boolean;
  bot: { enabled: boolean; running: boolean; username: string | null; webAppUrl: string | null; chats: number; tokenSource: string };
  ai: { configured: boolean; model?: string; models: string[] };
  env: { demoMode: boolean; dataDir: string; version: string };
}

interface Diagnostics {
  counts: Record<string, number>;
  connections: { serviceId: string; label: string; status: string; sandbox: boolean; lastError: string | null }[];
  bot: { running: boolean; publicUrl: string | null };
  env: { demoMode: boolean; allowOutbound: boolean; dryRunAlways: boolean };
}

const data = ref<SettingsPayload | null>(null);
const diagnostics = ref<Diagnostics | null>(null);
const loading = ref(true);
const busy = ref(false);
const form = reactive({ agencyName: '', autoOptimizationEnabled: true, botProtectionEnabled: true, geoEnabled: true, reportEmail: '' });
const showDiagnostics = ref(false);

onMounted(load);

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await tgApi.get<SettingsPayload>('/settings');
    form.agencyName = data.value.tenant.agencyName;
    form.autoOptimizationEnabled = data.value.settings.autoOptimizationEnabled !== false;
    form.botProtectionEnabled = data.value.settings.botProtectionEnabled !== false;
    form.geoEnabled = data.value.settings.geoEnabled !== false;
    form.reportEmail = String(data.value.settings.reportEmail ?? '');
  } catch (error) {
    toastErr('Не удалось загрузить настройки', error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  busy.value = true;
  try {
    await tgApi.patch('/settings', {
      agencyName: form.agencyName,
      autoOptimizationEnabled: form.autoOptimizationEnabled,
      botProtectionEnabled: form.botProtectionEnabled,
      geoEnabled: form.geoEnabled,
      reportEmail: form.reportEmail,
    });
    toastOk('Настройки сохранены');
    if (session.value) session.value.tenant.agencyName = form.agencyName;
  } catch (error) {
    toastErr('Не удалось сохранить', error instanceof Error ? error.message : String(error));
  } finally {
    busy.value = false;
  }
}

async function loadDiagnostics(): Promise<void> {
  showDiagnostics.value = !showDiagnostics.value;
  if (!showDiagnostics.value || diagnostics.value) return;
  try {
    diagnostics.value = await tgApi.get<Diagnostics>('/diagnostics');
  } catch (error) {
    toastErr('Диагностика недоступна', error instanceof Error ? error.message : String(error));
  }
}
</script>

<template>
  <div class="mini-screen">
    <header class="mini-header">
      <div>
        <div class="mini-greeting">{{ agencyName }}</div>
        <h1 class="mini-title">Настройки</h1>
      </div>
      <GlassButton size="sm" variant="primary" :loading="busy" @click="save">Сохранить</GlassButton>
    </header>

    <LoaderBlock v-if="loading" :rows="4" label="Загружаем настройки" />

    <template v-else-if="data">
      <div class="mini-section-title" style="margin-top: 0">Агентство</div>
      <GlassCard class="mini-stack">
        <label class="field">
          <span class="field-label">Название (в отчётах и приложении)</span>
          <input v-model="form.agencyName" class="input" placeholder="Моё агентство" />
        </label>
        <label class="field">
          <span class="field-label">Почта для отчётов</span>
          <input v-model="form.reportEmail" class="input" type="email" placeholder="client@example.ru" />
        </label>
      </GlassCard>

      <div class="mini-section-title">Автоматизация</div>
      <GlassCard>
        <div class="glass-row" style="padding: 12px 0; border: none">
          <div>
            <div style="font-weight: 600">Автооптимизация ставок</div>
            <div class="mini-hint">Правила пересчитывают ставки по расписанию</div>
          </div>
          <button class="switch" :class="{ on: form.autoOptimizationEnabled }" @click="form.autoOptimizationEnabled = !form.autoOptimizationEnabled" />
        </div>
        <div class="glass-row" style="padding: 12px 0; border: none">
          <div>
            <div style="font-weight: 600">Защита от ботов</div>
            <div class="mini-hint">Проверка логов и отключение источников</div>
          </div>
          <button class="switch" :class="{ on: form.botProtectionEnabled }" @click="form.botProtectionEnabled = !form.botProtectionEnabled" />
        </div>
        <div class="glass-row" style="padding: 12px 0; border: none">
          <div>
            <div style="font-weight: 600">GEO-страницы</div>
            <div class="mini-hint">Создание региональных страниц и разметки</div>
          </div>
          <button class="switch" :class="{ on: form.geoEnabled }" @click="form.geoEnabled = !form.geoEnabled" />
        </div>
      </GlassCard>

      <div class="mini-section-title">Telegram-бот</div>
      <GlassCard>
        <div class="glass-row" style="padding: 0 0 12px; border: none">
          <div>
            <div style="font-weight: 600">Статус бота</div>
            <div class="mini-hint">
              {{ data.bot.enabled && data.bot.running ? `работает${data.bot.username ? ` · @${data.bot.username}` : ''}` : data.bot.enabled ? 'остановлен' : 'не настроен' }}
              <template v-if="data.bot.chats"> · чатов: {{ data.bot.chats }}</template>
            </div>
          </div>
          <span class="badge" :class="data.bot.running ? 'badge-live' : 'badge-warn'">{{ data.bot.running ? 'онлайн' : 'выкл' }}</span>
        </div>
        <div class="mini-hint" style="line-height: 1.6">
          Токен бота задаётся в разделе «Подключения» (сервис Telegram Bot) или переменной MARK_TELEGRAM_BOT_TOKEN. Для работы из России укажите прокси
          MARK_TELEGRAM_API_BASE, чтобы запросы к Telegram шли через ваш Cloudflare-воркер.
        </div>
        <GlassButton size="sm" block style="margin-top: 10px" @click="openExternal('#/connect')">Настроить в «Подключениях»</GlassButton>
      </GlassCard>

      <div class="mini-section-title">AI-советник</div>
      <GlassCard>
        <div class="mini-row-between">
          <div>
            <div style="font-weight: 600">{{ data.ai.configured ? 'Подключён' : 'Не подключён' }}</div>
            <div class="mini-hint">{{ data.ai.configured ? data.ai.model : 'Советы формирует движок из ваших цифр' }}</div>
          </div>
          <span class="badge" :class="data.ai.configured ? 'badge-live' : ''">{{ data.ai.configured ? 'AI' : 'движок' }}</span>
        </div>
        <div class="mini-hint" style="margin-top: 8px">
          Бесплатные модели: {{ data.ai.models.map((model) => model.split('/').pop()).join(', ') }}.
        </div>
        <GlassButton size="sm" block style="margin-top: 10px" @click="openExternal('#/connect')">Подключить OpenRouter</GlassButton>
      </GlassCard>

      <div class="mini-section-title">Безопасность и данные</div>
      <GlassCard>
        <div class="glass-row" style="padding: 0 0 10px; border: none">
          <div>
            <div style="font-weight: 600">Подпись Telegram</div>
            <div class="mini-hint">{{ isVerified ? 'initData проверен — вход из Telegram подтверждён' : 'проверка недоступна: приложение открыто вне Telegram' }}</div>
          </div>
          <span class="badge" :class="isVerified ? 'badge-live' : 'badge-warn'">{{ isVerified ? 'ок' : 'без подписи' }}</span>
        </div>
        <div class="glass-row" style="padding: 0 0 10px; border: none">
          <div>
            <div style="font-weight: 600">Роль в агентстве</div>
            <div class="mini-hint">{{ data.role === 'owner' ? 'владелец — полный доступ' : data.role === 'manager' ? 'менеджер — без смены тарифа' : 'наблюдатель — только просмотр' }}</div>
          </div>
          <span class="badge">{{ data.role }}</span>
        </div>
        <div class="mini-hint">Ключи сервисов шифруются AES-256 на вашем сервере. База лежит в {{ data.env.dataDir }} — делайте резервные копии каталога целиком, вместе с файлом vault.key.</div>
      </GlassCard>

      <div class="mini-section-title">Сервис</div>
      <GlassCard>
        <GlassButton size="sm" block @click="loadDiagnostics">{{ showDiagnostics ? 'Скрыть диагностику' : 'Показать диагностику' }}</GlassButton>
        <template v-if="showDiagnostics && diagnostics">
          <div class="mini-grid-2" style="margin-top: 12px">
            <div class="metric"><span class="metric-label">Сайтов</span><span class="metric-value">{{ diagnostics.counts.sites ?? 0 }}</span></div>
            <div class="metric"><span class="metric-label">Кампаний</span><span class="metric-value">{{ diagnostics.counts.campaigns ?? 0 }}</span></div>
            <div class="metric"><span class="metric-label">Гипотез</span><span class="metric-value">{{ diagnostics.counts.hypotheses ?? 0 }}</span></div>
            <div class="metric"><span class="metric-label">Проверок логов</span><span class="metric-value">{{ diagnostics.counts.scans ?? 0 }}</span></div>
          </div>
          <div class="mini-stack" style="margin-top: 12px">
            <div v-for="connection in diagnostics.connections" :key="connection.serviceId" class="mini-row-between">
              <span class="mini-hint">{{ connection.serviceId }}{{ connection.sandbox ? ' · тест' : '' }}</span>
              <span class="badge" :class="connection.status === 'valid' ? 'badge-live' : 'badge-warn'">{{ connection.status }}</span>
            </div>
            <div v-if="!diagnostics.connections.length" class="mini-hint">Сервисы ещё не подключены.</div>
          </div>
          <div class="mini-hint" style="margin-top: 12px">
            Публичный адрес: {{ diagnostics.bot.publicUrl ?? 'не задан (MARK_PUBLIC_URL)' }}<br />
            Демо-режим: {{ diagnostics.env.demoMode ? 'включён' : 'выключен' }} · исходящая сеть: {{ diagnostics.env.allowOutbound ? 'разрешена' : 'запрещена' }} ·
            сухой прогон: {{ diagnostics.env.dryRunAlways ? 'включён' : 'выключен' }}
          </div>
        </template>
      </GlassCard>

      <div class="mini-section-title">О приложении</div>
      <GlassCard>
        <div class="mini-row-between">
          <span class="mini-muted">Версия</span>
          <b>{{ data.env.version }}</b>
        </div>
        <div class="mini-row-between" style="margin-top: 6px">
          <span class="mini-muted">Открыто из Telegram</span>
          <b>{{ isVerified ? 'да' : 'нет' }}</b>
        </div>
        <GlassButton size="sm" block style="margin-top: 12px" @click="openExternal('/#/')">Открыть полную версию для компьютера</GlassButton>
        <div class="mini-hint" style="margin-top: 10px">Полная версия — те же данные, больше таблиц и графиков, удобно с ноутбука.</div>
      </GlassCard>
    </template>
  </div>
</template>
