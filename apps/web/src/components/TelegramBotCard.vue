<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { api } from '@/api/client';
import { useAppStore } from '@/stores/app';
import StatusPill from '@/components/StatusPill.vue';

/**
 * Карточка Telegram-бота в настройках.
 *
 * Показывает: запущен ли бот, какой у него @username, сколько чатов привязано,
 * идёт ли связь через прокси (для работы из России) и как выглядит ссылка,
 * которую можно отправить сотруднику. Здесь же настраивается публичный адрес
 * приложения — от него зависит кнопка «Открыть приложение» в чате.
 */

interface BotStatusPayload {
  status: {
    enabled: boolean;
    running: boolean;
    username?: string | null;
    botName?: string | null;
    webAppUrl?: string | null;
    tokenSource: 'env' | 'account' | 'none';
    chats: number;
    commands: { command: string; description: string }[];
    hint?: string;
  };
  publicUrl: string | null;
  proxyBase: string | null;
  chats: { id: string; chatId: string; title: string; role: string; notifications: boolean; lastSeenAt: string | null }[];
  version: string;
}

const store = useAppStore();
const data = ref<BotStatusPayload | null>(null);
const busy = ref(false);
const testBusy = ref(false);
const form = reactive({ publicUrl: '', telegramBotUsername: '', webAppUrl: '' });
const invite = ref<{ link: string | null; text: string } | null>(null);

onMounted(async () => {
  await refresh();
  const settings = store.settings?.settings as Record<string, unknown> | undefined;
  form.publicUrl = String(settings?.publicUrl ?? data.value?.publicUrl ?? '');
  form.telegramBotUsername = String(settings?.telegramBotUsername ?? data.value?.status.username ?? '');
  form.webAppUrl = String(settings?.telegramWebAppUrl ?? '');
});

async function refresh(): Promise<void> {
  data.value = await store.call(() => api.get<BotStatusPayload>('/api/telegram/status'), 'Не удалось получить статус бота');
}

async function saveAddress(): Promise<void> {
  busy.value = true;
  await store.call(
    () =>
      store.saveSettings({
        publicUrl: form.publicUrl || null,
        telegramWebAppUrl: form.webAppUrl || null,
        telegramBotUsername: form.telegramBotUsername || null,
      } as never),
    'Не удалось сохранить адрес',
  );
  busy.value = false;
  await refresh();
}

async function sendTest(): Promise<void> {
  testBusy.value = true;
  const result = await store.call(() => api.post<{ sent: boolean; message?: string; username?: string }>('/api/telegram/test', {}), 'Тест не прошёл');
  testBusy.value = false;
  if (result) {
    if (result.sent) store.toast('success', 'Тестовое сообщение отправлено', 'Проверьте Telegram — бот должен ответить.');
    else store.toast('info', 'Бот отвечает, но чатов нет', result.message);
    await refresh();
  }
}

async function restart(): Promise<void> {
  busy.value = true;
  const result = await store.call(() => api.post<{ started: boolean; reason: string | null }>('/api/telegram/restart', {}), 'Не удалось перезапустить бота');
  busy.value = false;
  if (result) {
    if (result.started) store.toast('success', 'Бот перезапущен', 'Приложение доступно из чата.');
    else store.toast('warning', 'Бот не запустился', result.reason ?? 'Проверьте токен');
    await refresh();
  }
}

async function loadInvite(): Promise<void> {
  invite.value = await store.call(() => api.get<{ link: string | null; text: string }>('/api/telegram/invite'), 'Не удалось подготовить приглашение');
}

async function copyInvite(): Promise<void> {
  if (!invite.value) return;
  try {
    await navigator.clipboard.writeText(invite.value.text);
    store.toast('success', 'Текст скопирован', 'Отправьте его сотруднику или клиенту.');
  } catch {
    store.toast('warning', 'Скопируйте вручную', invite.value.text);
  }
}

async function removeChat(id: string): Promise<void> {
  await store.call(() => api.delete(`/api/telegram/chats/${id}`), 'Не удалось отозвать доступ');
  await refresh();
}

async function toggleNotifications(id: string, enabled: boolean): Promise<void> {
  await store.call(() => api.patch(`/api/telegram/chats/${id}`, { notifications: enabled }), 'Не удалось изменить уведомления');
  await refresh();
}
</script>

<template>
  <div class="card">
    <div class="card-head">
      <div>
        <h3>Telegram-бот и приложение</h3>
        <div class="sub">Мини-приложение открывается кнопкой в чате: сводка, аудит, ставки, защита от ботов</div>
      </div>
      <StatusPill
        :status="data?.status.running ? 'valid' : data?.status.enabled ? 'paused' : 'none'"
        :label="data?.status.running ? 'работает' : data?.status.enabled ? 'остановлен' : 'не настроен'"
      />
    </div>

    <div v-if="data" class="grid cols-2" style="margin-bottom: 12px">
      <div class="stat"><span class="label">Бот</span><span class="value" style="font-size: 16px">{{ data.status.username ? `@${data.status.username}` : '—' }}</span></div>
      <div class="stat"><span class="label">Чатов привязано</span><span class="value">{{ data.status.chats }}</span></div>
      <div class="stat"><span class="label">Источник токена</span><span class="value" style="font-size: 16px">{{ data.status.tokenSource === 'env' ? 'переменная окружения' : data.status.tokenSource === 'account' ? 'подключённый сервис' : 'нет' }}</span></div>
      <div class="stat"><span class="label">Связь с Telegram</span><span class="value" style="font-size: 16px">{{ data.proxyBase ? 'через прокси' : 'напрямую' }}</span></div>
    </div>

    <p v-if="data?.status.hint" class="hint" style="margin-bottom: 12px">{{ data.status.hint }}</p>

    <div class="grid cols-2">
      <div class="field">
        <label>Публичный адрес MARK (HTTPS)</label>
        <input v-model="form.publicUrl" type="url" placeholder="https://mark.agency.ru" />
        <div class="hint">Нужен для кнопки приложения в чате. Если сервер локальный — используйте туннель (Cloudflare Tunnel, ngrok).</div>
      </div>
      <div class="field">
        <label>Username бота</label>
        <input v-model="form.telegramBotUsername" type="text" placeholder="my_mark_bot" />
        <div class="hint">Без @. Показывается в статусе и в приглашении для сотрудников.</div>
      </div>
    </div>

    <div class="field">
      <label>Адрес приложения (не обязательно)</label>
      <input v-model="form.webAppUrl" type="url" placeholder="https://mark.agency.ru/#/tg" />
      <div class="hint">По умолчанию — публичный адрес + /#/tg. Меняйте, если приложение живёт на отдельном домене.</div>
    </div>

    <div class="row" style="gap: 8px; flex-wrap: wrap; margin: 12px 0">
      <button class="btn primary" :disabled="busy" @click="saveAddress">Сохранить адрес</button>
      <button class="btn" :disabled="busy" @click="restart">Перезапустить бота</button>
      <button class="btn" :disabled="testBusy" @click="sendTest">Тестовое сообщение</button>
      <button class="btn ghost" @click="loadInvite">Приглашение для сотрудника</button>
    </div>

    <div v-if="invite" class="log" style="margin-bottom: 12px">
      <div>{{ invite.text }}</div>
      <div class="row" style="gap: 8px; margin-top: 8px">
        <a v-if="invite.link" class="btn sm" :href="invite.link" target="_blank" rel="noopener">{{ invite.link }}</a>
        <button class="btn sm" @click="copyInvite">Скопировать текст</button>
      </div>
    </div>

    <div v-if="data?.chats.length" style="margin-top: 8px">
      <div class="sub" style="margin-bottom: 6px">Доступ к приложению</div>
      <div v-for="chat in data.chats" :key="chat.id" class="glass-row" style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px">
        <div>
          <div style="font-weight: 600">{{ chat.title }}</div>
          <div class="hint">
            {{ chat.role === 'owner' ? 'владелец' : chat.role === 'manager' ? 'менеджер' : 'наблюдатель' }} ·
            {{ chat.notifications ? 'уведомления включены' : 'без уведомлений' }}
          </div>
        </div>
        <div class="row" style="gap: 6px">
          <button class="btn sm" @click="toggleNotifications(chat.id, !chat.notifications)">{{ chat.notifications ? 'Выключить уведомления' : 'Включить уведомления' }}</button>
          <button class="btn sm danger" @click="removeChat(chat.id)">Отозвать</button>
        </div>
      </div>
    </div>

    <div v-if="data" style="margin-top: 12px">
      <div class="sub" style="margin-bottom: 6px">Команды бота</div>
      <div class="chip-list">
        <span v-for="command in data.status.commands" :key="command.command" class="chip" :title="command.description">/{{ command.command }}</span>
      </div>
    </div>

    <p class="hint" style="margin-top: 10px">
      Токен бота: создайте бота у @BotFather и задайте переменную <code>MARK_TELEGRAM_BOT_TOKEN</code> (или подключите сервис Telegram Bot в разделе
      «Подключения»). Для работы из России включите прокси: <code>MARK_TELEGRAM_API_BASE</code> — адрес вашего Cloudflare-воркера. Подробнее:
      docs/TELEGRAM.md
    </p>
  </div>
</template>
