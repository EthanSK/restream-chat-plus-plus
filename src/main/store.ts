// Thin wrapper around electron-store with a typed surface we actually use.
// electron-store is ESM-only on newer versions, so dynamic-import at runtime.
//
// v0.1.15 hardening — the OAuth token (access + refresh) is now encrypted at
// rest using Electron's `safeStorage` API. On macOS that backs onto Keychain
// (an Application-bound encryption key wrapped under the app's identity), on
// Windows DPAPI, on Linux libsecret. Practical effect:
//   1. Stealing the userData JSON file alone is no longer enough to hijack
//      the session — you also need access to Keychain on the same user.
//   2. The token survives in-place updates (Squirrel.Mac never touches
//      userData) AND survives reinstalls (Keychain is scoped to bundle ID,
//      which is constant `com.ethansk.restream-chat-plus-plus`).
//
// Migration: any pre-v0.1.15 install will have the unencrypted `token` key
// in its store. On first read we transparently re-encrypt under the new
// `tokenEnc` key and delete the legacy plain key so the secret never sits
// on disk in two places. If `safeStorage.isEncryptionAvailable()` is false
// (some Linux setups without a keyring, or a corrupt Keychain), we fall back
// to the legacy plain `token` storage so the user is never hard-locked-out
// — they just don't get the extra-at-rest protection.

import type { Settings } from '../shared/types';
import type { TokenSet } from './oauth';

/**
 * @deprecated v0.1.34: the native Compose window was removed. The
 * `composeWindow` key may still exist on disk from v0.1.32-v0.1.33
 * installs — kept in the schema so reads don't break, but no code writes
 * it any more and a future cleanup can drop the property entirely.
 */
export interface ComposeWindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
  alwaysOnTop?: boolean;
}

export interface StoreSchema {
  /**
   * Legacy plain-JSON token storage. Read-only path from v0.1.15 onwards —
   * we migrate the value into `tokenEnc` on first read and then delete it.
   * Kept in the schema for the migration code path; new writes always go
   * through the encrypted path.
   */
  token?: TokenSet;
  /**
   * Base64-encoded Electron `safeStorage`-encrypted ciphertext of the
   * JSON-serialised TokenSet. The encryption key is held by the OS keyring
   * (macOS Keychain / Windows DPAPI / Linux libsecret), scoped to the app's
   * bundle identity.
   */
  tokenEnc?: string;
  settings?: Settings;
  /**
   * @deprecated v0.1.34: persisted Compose-window bounds from v0.1.32-v0.1.33.
   * The Compose window was removed in v0.1.34 — the field stays in the
   * schema so that loading old store JSON doesn't error, but no code
   * reads or writes it any more.
   */
  composeWindow?: ComposeWindowBounds;
  /**
   * Tracks which one-time settings migrations have been applied to the
   * persisted `settings` blob. Each entry is an opaque migration key (see
   * `applySettingsMigrations` in `main.ts`). Migrations are idempotent —
   * the flag exists so we don't re-inject seed values a user has
   * deliberately removed.
   *
   * v0.1.48 added the first entry, `seed-viewer-ignore-regex`, which
   * appends `^viewer$` to `filters.tts.ignoreRegex` and
   * `filters.notifications.ignoreRegex` on first launch after upgrade
   * (skipped if already present).
   */
  settingsMigrationsApplied?: string[];
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
