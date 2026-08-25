import { EventEmitter } from 'node:events';
import type {
  ChatMessage,
  DirectChatSendResult,
  DirectChatConnection,
  DirectChatProvider,
} from '../shared/types';
import { KickChatSource } from './kick-chat-source';
import type { Store } from './store';
import { appendJsonl } from './structured-log';
import { TwitchChatSource } from './twitch-chat-source';

interface DirectChatSource {
  getState(): DirectChatConnection;
  hasStoredAuthorization(): boolean;
  start(): Promise<void>;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): Promise<void>;
  stop(): void;
  send(text: string): Promise<DirectChatSendResult>;
  on(event: 'state', listener: (state: DirectChatConnection) => void): this;
  on(event: 'message', listener: (message: ChatMessage) => void): this;
}

interface DirectChatSourcesEvents {
  state: (connections: DirectChatConnection[]) => void;
  message: (message: ChatMessage) => void;
}

/** Owns the optional direct-provider adapters while Restream remains an independent source. */
export class DirectChatSources extends EventEmitter {
  private readonly sources: Record<DirectChatProvider, DirectChatSource>;
  private readonly pendingOwnMessages = new Map<
    DirectChatProvider,
    Array<{ text: string; dateCreated: number }>
  >();

  constructor(store: Store) {
    super();
    this.sources = {
      twitch: new TwitchChatSource(store),
      kick: new KickChatSource(store),
    };
    for (const source of Object.values(this.sources)) {
      source.on('state', () => this.emit('state', this.getConnections()));
      source.on('message', (message) => {
        if (message.self && this.consumePendingOwnMessage(message)) {
          appendJsonl('direct-chat.jsonl', {
            provider: message.platform,
            event: 'outgoing-self-echo-suppressed',
            messageId: message.id,
          });
          return;
        }
        appendJsonl('direct-chat.jsonl', {
          provider: message.platform,
          event: 'message-forwarded',
          messageId: message.id,
          self: message.self === true,
        });
        this.emit('message', message);
      });
    }
  }

  override on<E extends keyof DirectChatSourcesEvents>(
    event: E,
    listener: DirectChatSourcesEvents[E],
  ): this {
    return super.on(event, listener);
  }

  getConnections(): DirectChatConnection[] {
    return [this.sources.twitch.getState(), this.sources.kick.getState()];
  }

  async start(): Promise<void> {
    await Promise.allSettled(Object.values(this.sources).map((source) => source.start()));
    this.emit('state', this.getConnections());
  }

  async connect(provider: DirectChatProvider): Promise<DirectChatConnection[]> {
    const source = this.sources[provider];
    if (source.getState().status !== 'connecting') await source.connect();
    return this.getConnections();
  }

  async reconnect(): Promise<DirectChatConnection[]> {
    const retryableSources = Object.values(this.sources).filter(isRetryable);
    await Promise.allSettled(retryableSources.map((source) => source.reconnect()));
    this.emit('state', this.getConnections());
    return this.getConnections();
  }

  async disconnect(provider: DirectChatProvider): Promise<DirectChatConnection[]> {
    await this.sources[provider].disconnect();
    return this.getConnections();
  }

  async send(
    provider: DirectChatProvider,
    text: string,
  ): Promise<DirectChatSendResult> {
    const pending = this.pendingOwnMessages.get(provider) ?? [];
    pending.push({ text, dateCreated: Date.now() });
    this.pendingOwnMessages.set(provider, pending);
    try {
      const result = await this.sources[provider].send(text);
      if (!result.ok) this.removePendingOwnMessage(provider, text);
      return result;
    } catch (error) {
      this.removePendingOwnMessage(provider, text);
      throw error;
    }
  }

  stop(): void {
    for (const source of Object.values(this.sources)) source.stop();
  }

  private consumePendingOwnMessage(message: ChatMessage): boolean {
    if (message.platform !== 'twitch' && message.platform !== 'kick') return false;
    const pending = this.pendingOwnMessages.get(message.platform) ?? [];
    const cutoff = Date.now() - 30_000;
    const live = pending.filter((item) => item.dateCreated >= cutoff);
    const match = live.findIndex((item) => item.text === message.text);
    if (match === -1) {
      this.pendingOwnMessages.set(message.platform, live);
      return false;
    }
    live.splice(match, 1);
    this.pendingOwnMessages.set(message.platform, live);
    return true;
  }

  private removePendingOwnMessage(provider: DirectChatProvider, text: string): void {
    const pending = this.pendingOwnMessages.get(provider) ?? [];
    const match = pending.findIndex((item) => item.text === text);
    if (match !== -1) pending.splice(match, 1);
    this.pendingOwnMessages.set(provider, pending);
  }
}

/**
 * The toolbar retry exists precisely for a source that fell over, so `disconnected` must not be
 * skipped while the provider authorization is still on hand — that state is the failure this button
 * repairs. Only a source with nothing to retry with (unconfigured, or signed out) is left alone.
 */
function isRetryable(source: DirectChatSource): boolean {
  const status = source.getState().status;
  if (status === 'not-configured') return false;
  if (status === 'disconnected') return source.hasStoredAuthorization();
  return true;
}
