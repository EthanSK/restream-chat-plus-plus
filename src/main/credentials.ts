import { execFileSync } from 'node:child_process';
// v0.1.69 (voice 4015) — surface Keychain read failures into the shared
// error log. Pre-v0.1.69 every Keychain call had a bare `catch {} return
// undefined` that disappeared silently if the user's Keychain was locked
// or the entry didn't exist — leading to confusing "Missing Restream
// credentials" errors with no signal as to why.
import { appendErrorLog, errorToString } from './structured-log';

// Read Restream OAuth credentials from macOS Keychain or env vars.
// Never commit these. .env.example documents the layout.
export interface RestreamCreds {
  clientId: string;
  clientSecret: string;
}

function keychain(service: string, field: '-w' | '-g'): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    if (field === '-w') {
      // Password
      const out = execFileSync(
        'security',
        ['find-internet-password', '-s', service, '-w'],
        { encoding: 'utf8' },
      );
      return out.trim() || undefined;
    } else {
      // -g prints metadata to stderr; account is in `acct` line.
      const out = execFileSync(
        'security',
        ['find-internet-password', '-s', service, '-g'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      // Apple writes the metadata to stderr though; execFileSync may merge.
      // Caller falls back to env.
      const m = out.match(/"acct"<blob>="([^"]+)"/);
      return m?.[1];
    }
  } catch (err) {
    // v0.1.69 (voice 4015): emit a structured row so we know WHICH
    // Keychain call failed. The exit code from `security` is the
    // standard signal (44 = item not found, 51 = authentication
    // failure, etc.). Without this, the upstream "Missing Restream
    // credentials" error in oauth.ts is unattributable.
    appendErrorLog({
      subsystem: 'credentials',
      phase: 'credentials.keychain-read-failed',
      errorMessage: errorToString(err),
      context: { service, field },
    });
    return undefined;
  }
}

function keychainAccount(service: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    // -g writes metadata to stderr — capture both.
    const res = execFileSync(
      '/bin/sh',
      [
        '-c',
        `security find-internet-password -s ${service} -g 2>&1`,
      ],
      { encoding: 'utf8' },
    );
    const m = res.match(/"acct"<blob>="([^"]+)"/);
    return m?.[1];
  } catch (err) {
    // v0.1.69 (voice 4015): mirror — see keychain() above.
    appendErrorLog({
      subsystem: 'credentials',
      phase: 'credentials.keychain-account-read-failed',
      errorMessage: errorToString(err),
      context: { service },
    });
    return undefined;
  }
}

export function loadRestreamCreds(): RestreamCreds | undefined {
  const envId = process.env.RESTREAM_CLIENT_ID;
  const envSecret = process.env.RESTREAM_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret };
  }

  const clientId = keychainAccount('api.restream.io');
  const clientSecret = keychain('api.restream.io', '-w');
  if (clientId && clientSecret) {
    return { clientId, clientSecret };
  }
  return undefined;
}
