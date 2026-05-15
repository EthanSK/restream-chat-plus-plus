// Thin wrapper around electron-store with a typed surface we actually use.
// electron-store is ESM-only on newer versions, so dynamic-import at runtime.
import type { Settings } from '../shared/types';
import type { TokenSet } from './oauth';

export interface StoreSchema {
  token?: TokenSet;
  settings?: Settings;
}

export interface Store {
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K];
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void;
  delete<K extends keyof StoreSchema>(key: K): void;
}

export async function createStore(): Promise<Store> {
  // Dynamic import because electron-store v9+ is ESM-only.
  const mod = await import('electron-store');
  const ES = (mod as any).default ?? mod;
  const instance: any = new ES({
    name: 'restream-chat-plus-plus',
  });
  return {
    get: (k: any) => instance.get(k),
    set: (k: any, v: any) => instance.set(k, v),
    delete: (k: any) => instance.delete(k),
  };
}
