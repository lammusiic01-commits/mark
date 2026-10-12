import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { rootLogger } from './logger.js';

/**
 * Шина событий реального времени.
 *
 * Транспорты:
 *  - WebSocket  (/ws)               — основной канал (Electron, браузер);
 *  - Server-Sent Events (/api/events/stream) — резервный, работает через любые прокси.
 *
 * Каналы используются для живых обновлений: проверка токена (test.*),
 * окно входа (login.*), автооптимизация (run.*), отчёты (report.*), активность (activity).
 */

export interface RealtimeEvent {
  channel: string;
  type: string;
  payload: unknown;
  at: string;
  seq: number;
}

const MAX_BUFFER = 200;

export class EventHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private subscriptions = new Map<WebSocket, Set<string>>();
  private buffers = new Map<string, RealtimeEvent[]>();
  private sseClients = new Set<(event: RealtimeEvent) => void>();
  private seq = 0;
  private log = rootLogger.child('realtime');

  attach(server: HttpServer, path = '/ws'): void {
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname !== path) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(request, socket, head, (ws) => {
        this.register(ws, url);
      });
    });
    this.wss.on('connection', (ws) => {
      this.log.debug('WebSocket подключён');
      ws.on('close', () => {
        const subs = this.subscriptions.get(ws);
        this.subscriptions.delete(ws);
        this.clients.delete(ws);
        subs?.clear();
      });
    });
    this.log.info(`WebSocket слушает ${path}`);
  }

  private register(ws: WebSocket, url: URL) {
    this.clients.add(ws);
    const initial = url.searchParams.getAll('channel');
    const subs = new Set<string>(initial.length ? initial : ['activity']);
    this.subscriptions.set(ws, subs);
    ws.send(JSON.stringify({ channel: 'system', type: 'connected', payload: { channels: [...subs] }, at: new Date().toISOString(), seq: 0 }));
    for (const channel of subs) {
      for (const event of this.buffers.get(channel)?.slice(-20) ?? []) {
        ws.send(JSON.stringify(event));
      }
    }
    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(String(raw)) as { action?: string; channel?: string };
        if (message.action === 'subscribe' && message.channel) {
          subs.add(message.channel);
          ws.send(JSON.stringify({ channel: 'system', type: 'subscribed', payload: { channel: message.channel }, at: new Date().toISOString(), seq: 0 }));
        } else if (message.action === 'unsubscribe' && message.channel) {
          subs.delete(message.channel);
        } else if (message.action === 'ping') {
          ws.send(JSON.stringify({ channel: 'system', type: 'pong', payload: null, at: new Date().toISOString(), seq: 0 }));
        }
      } catch {
        /* игнорируем некорректные сообщения */
      }
    });
  }

  /** Отправить событие во все каналы подписчикам + в SSE + в кольцевой буфер. */
  publish(channel: string, type: string, payload: unknown): RealtimeEvent {
    const event: RealtimeEvent = {
      channel,
      type,
      payload,
      at: new Date().toISOString(),
      seq: (this.seq += 1),
    };
    const buffer = this.buffers.get(channel) ?? [];
    buffer.push(event);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    this.buffers.set(channel, buffer);

    const serialized = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const subs = this.subscriptions.get(client);
      if (subs && (subs.has(channel) || subs.has('*'))) {
        try {
          client.send(serialized);
        } catch {
          /* наблюдатель отвалился — не критично */
        }
      }
    }
    for (const send of this.sseClients) {
      try {
        send(event);
      } catch {
        /* ignore */
      }
    }
    return event;
  }

  /** Подписка для SSE-эндпоинта. Возвращает функцию отписки. */
  subscribeSse(listener: (event: RealtimeEvent) => void): () => void {
    this.sseClients.add(listener);
    return () => this.sseClients.delete(listener);
  }

  buffer(channel: string, limit = 50): RealtimeEvent[] {
    return (this.buffers.get(channel) ?? []).slice(-limit);
  }

  stats() {
    return {
      clients: this.clients.size,
      channels: [...this.buffers.keys()],
      sseClients: this.sseClients.size,
    };
  }

  close(): void {
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    this.subscriptions.clear();
    this.sseClients.clear();
    this.wss?.close();
    this.wss = null;
  }
}

export const hub = new EventHub();

/** Хелперы с понятными именами каналов. */
export const channels = {
  activity: 'activity',
  validation: (id: string) => `test:${id}`,
  login: (id: string) => `login:${id}`,
  run: (id: string) => `run:${id}`,
  report: (id: string) => `report:${id}`,
  audit: (id: string) => `audit:${id}`,
  scan: (id: string) => `scan:${id}`,
};
