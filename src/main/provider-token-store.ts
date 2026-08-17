import { safeStorage } from 'electron';
import type { Store } from './store';

export interface TwitchTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string[];
}

export interface KickTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

type ProviderTokenKey = 'twitchTokenEnc' | 'kickTokenEnc';

/** Direct-provider tokens never fall back to plaintext because reconnecting is safer than leaking them. */
export class ProviderTokenStore<T extends TwitchTokenSet | KickTokenSet> {
  constructor(
    private readonly store: Store,
    private readonly key: ProviderTokenKey,
  ) {}

  read(): T | undefined {
    const encrypted = this.store.get(this.key);
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      const json = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      return JSON.parse(json) as T;
    } catch {
      return undefined;
    }
  }

  write(token: T): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure token storage is unavailable.');
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(token));
    this.store.set(this.key, encrypted.toString('base64'));
  }

  clear(): void {
    this.store.delete(this.key);
  }
}
