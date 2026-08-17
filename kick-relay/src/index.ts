import { DurableObject } from 'cloudflare:workers';
import { verifyKickSignature } from './signature';

interface Env {
  CHAT_RELAY: DurableObjectNamespace<KickChatRelay>;
  CHAT_RELAY_TOKEN: string;
}

interface RelayEnvelope {
  kind: 'kick.chat.message';
  event: unknown;
  receivedAt: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname !== '/kick/webhook' && url.pathname !== '/socket') {
      return new Response('Not found', { status: 404 });
    }
    const relay = env.CHAT_RELAY.getByName('reeethan-kick-chat');
    if (url.pathname === '/socket') {
      if (request.headers.get('authorization') !== `Bearer ${env.CHAT_RELAY_TOKEN}`) {
        return new Response('Unauthorized', { status: 401 });
      }
      return relay.fetch(request);
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const rawBody = await request.text();
    const messageId = request.headers.get('kick-event-message-id');
    const timestamp = request.headers.get('kick-event-message-timestamp');
    const signature = request.headers.get('kick-event-signature');
    const eventType = request.headers.get('kick-event-type');
    if (!messageId || !timestamp || !signature) return new Response('Missing signature', { status: 401 });
    if (!(await verifyKickSignature(messageId, timestamp, rawBody, signature))) {
      return new Response('Invalid signature', { status: 401 });
    }
    if (eventType !== 'chat.message.sent') return new Response(null, { status: 204 });
    let event: unknown;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }
    const envelope: RelayEnvelope = { kind: 'kick.chat.message', event, receivedAt: Date.now() };
    await relay.fetch(new Request('https://relay.internal/broadcast', {
      method: 'POST',
      body: JSON.stringify(envelope),
    }));
    return new Response(null, { status: 204 });
  },
};

export class KickChatRelay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const envelope = (await request.json()) as RelayEnvelope;
      const recent = (await this.ctx.storage.get<RelayEnvelope[]>('recent')) ?? [];
      recent.push(envelope);
      await this.ctx.storage.put('recent', recent.slice(-100));
      const serialized = JSON.stringify(envelope);
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(serialized);
        } catch {
          socket.close(1011, 'Broadcast failed');
        }
      }
      return new Response(null, { status: 204 });
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const recent = (await this.ctx.storage.get<RelayEnvelope[]>('recent')) ?? [];
    for (const envelope of recent.filter((entry) => Date.now() - entry.receivedAt <= 60_000)) {
      server.send(JSON.stringify(envelope));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
    if (message === 'ping') socket.send('pong');
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }
}
