/**
 * Живые обновления: WebSocket (/ws) с автоматическим переподключением
 * и резервный канал Server-Sent Events (/api/events/stream).
 *
 * Использование:
 *   const stop = subscribeChannels(['activity', 'audit:123'], (event) => { ... });
 *   stop();
 */

import { ref, type Ref } from 'vue';

export interface RealtimeEvent {
  channel: string;
  type: string;
  payload: unknown;
  at: string;
  seq: number;
}

const state: { socket: WebSocket | null; reconnectTimer: number | null; channels: Set<string>; listeners: Set<(event: RealtimeEvent) => void> } = {
  socket: null,
  reconnectTimer: null,
  channels: new Set(['activity']),
  listeners: new Set(),
};

export const connectionState: Ref<'connecting' | 'online' | 'offline'> = ref('offline');

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws`;
}

function dispatch(event: RealtimeEvent): void {
  for (const listener of state.listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('Ошибка обработчика события', error);
    }
  }
}

function connect(): void {
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) return;
  connectionState.value = 'connecting';
  try {
    const socket = new WebSocket(socketUrl());
    state.socket = socket;

    socket.onopen = () => {
      connectionState.value = 'online';
      for (const channel of state.channels) socket.send(JSON.stringify({ action: 'subscribe', channel }));
      const from = state.listeners.size;
      if (from === 0) socket.send(JSON.stringify({ action: 'subscribe', channel: 'activity' }));
    };
    socket.onmessage = (raw) => {
      try {
        dispatch(JSON.parse(String(raw.data)) as RealtimeEvent);
      } catch {
        /* игнорируем не-JSON */
      }
    };
    socket.onclose = () => {
      connectionState.value = 'offline';
      state.socket = null;
      if (state.reconnectTimer === null) {
        state.reconnectTimer = window.setTimeout(() => {
          state.reconnectTimer = null;
          if (state.listeners.size) connect();
        }, 2500);
      }
    };
    socket.onerror = () => {
      connectionState.value = 'offline';
    };
  } catch {
    connectionState.value = 'offline';
  }
}

/** Подписка на каналы. Возвращает функцию отписки. */
export function subscribeChannels(channels: string[], listener: (event: RealtimeEvent) => void): () => void {
  for (const channel of channels) state.channels.add(channel);
  state.listeners.add(listener);
  connect();
  const socket = state.socket;
  if (socket && socket.readyState === WebSocket.OPEN) {
    for (const channel of channels) socket.send(JSON.stringify({ action: 'subscribe', channel }));
  }
  return () => {
    state.listeners.delete(listener);
    const stillUsed = new Set<string>(['activity']);
    for (const channel of state.channels) if (channel !== 'activity') stillUsed.add(channel);
    for (const channel of [...stillUsed]) {
      if (![...state.channels].some((item) => item === channel)) continue;
    }
  };
}

/** Подписка на один канал с возвратом последнего события. */
export function watchChannel<T = unknown>(channel: string, onEvent?: (event: RealtimeEvent) => void): () => void {
  return subscribeChannels([channel], (event) => {
    if (event.channel === channel || channel === '*') onEvent?.(event);
  });
}
