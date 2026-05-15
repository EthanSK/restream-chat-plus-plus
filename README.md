# Restream Chat++

A native, cross-platform replacement for the official [Restream Chat](https://restream.io/) desktop app.

The official app is x86 Electron under Rosetta on Apple Silicon and crashes on every queued audio cue. This is a personal-use, from-scratch reimplementation that runs natively on macOS (arm64 + x64), Windows, and Linux.

## What it does

- Connects to Restream's chat WebSocket (`wss://chat.api.restream.io/ws?accessToken=…`) after OAuth.
- Normalises per-platform chat payloads (Twitch, YouTube, Facebook, Kick, Trovo, Rumble, TikTok, X) into a single `ChatMessage` shape.
- Streams them into a virtualised React feed with per-platform username colours and badges.
- Optional Web-Speech-API TTS with voice picker and configurable rate limit (so a raid doesn't drown you in synthesized speech).
- Optional native `Notification` API alerts with their own rate limit.
- Settings drawer (TTS, notifications, per-platform filters), persisted in `electron-store`.
- Automatic WebSocket heartbeat + exponential backoff reconnect.

## Status

Personal-use replacement. Not affiliated with Restream. Not published to any app store.

## Quick start

```bash
git clone https://github.com/EthanSK/restream-chat-plus-plus.git
cd restream-chat-plus-plus
npm install --legacy-peer-deps
```

Then set up OAuth credentials in one of two ways:

### Option A — macOS Keychain (preferred on macOS)

```bash
security add-internet-password \
  -s api.restream.io \
  -a "<your-client-id>" \
  -w "<your-client-secret>"
```

### Option B — environment variables

Copy `.env.example` to `.env.local` and fill in:

```
RESTREAM_CLIENT_ID=…
RESTREAM_CLIENT_SECRET=…
```

Then run:

```bash
npm start         # dev mode (hot reload renderer)
npm run make      # build native installers (for the current platform)
npm test          # run vitest unit tests
```

## OAuth setup at Restream

1. Go to <https://restream.io/settings/api> and create a developer app.
2. Set the **redirect URI** to: `http://localhost:8765/oauth`
3. Grant scopes: `profile.read channels.read stream.read chat.read channels.write stream.write`
4. Copy the client ID + secret into Keychain or `.env.local` as above.

## Project layout

```
src/
  main/                   Electron main process
    main.ts               App entry, BrowserWindow, IPC handlers, native menu
    oauth.ts              OAuth code flow + token refresh + electron-store persistence
    ws-client.ts          Restream WebSocket subscriber (heartbeat, exponential-backoff reconnect)
    normalize.ts          Per-platform payload normaliser → ChatMessage
    credentials.ts        Keychain / env-var credential loader
    store.ts              Typed electron-store wrapper
  renderer/               React renderer
    main.tsx              React root
    App.tsx               Top-level state, IPC subscriptions, TTS/notification dispatch
    ChatFeed.tsx          Virtualised feed via react-virtuoso
    SettingsDrawer.tsx    Settings sheet
    tts.ts                Web Speech queue + rate limiter (also exported for tests)
    styles.css            Dark-mode-first styling
  preload.ts              contextBridge surface — typed via RcppApi
  shared/types.ts         Shared types between main + renderer
  __tests__/              Vitest tests
```

## Tests

```bash
npm test
```

Covers:

- Per-platform payload normalisation (Twitch + YouTube fixtures, fall-through, missing-text rejection).
- WebSocket reconnect with mocked `ws`.
- Exponential backoff math.
- Rate-limiter window semantics.

## Build

```bash
npm run make
```

On macOS this produces a `.app` (and a `.zip`) in `out/`. On Linux it builds `.deb` + `.rpm`. On Windows it builds a Squirrel installer.

## Roadmap

- Sparkle / electron-updater for auto-update
- More platform-specific payload parsers as fixtures arrive
- Per-platform emote rendering (Twitch + YouTube)
- Send-message support (chat.write scope is already requested)
- macOS menu-bar mode

## License

MIT. Personal use. Not affiliated with Restream.
