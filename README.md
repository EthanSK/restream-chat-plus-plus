# Restream Chat++

A native, cross-platform replacement for the official [Restream Chat](https://restream.io/) desktop app.

**Website / download:** <https://ethansk.github.io/restream-chat-plus-plus/>
**Releases:** <https://github.com/EthanSK/restream-chat-plus-plus/releases>

## What

A free, open-source desktop client that connects to Restream's chat WebSocket and renders multi-platform chat (Twitch, YouTube, Facebook, Kick, Trovo, Rumble, TikTok, X) in a single virtualised feed. TTS, notifications, per-platform filters, automatic reconnect — all native.

The app ships as a signed, notarized macOS bundle (arm64 + x64), a Squirrel installer for Windows x64, and `.deb` / `.rpm` packages for Linux x64. Auto-update is wired through Electron's public update service backed by GitHub Releases.

## Why

The official Restream Chat desktop app is x86 Electron running under Rosetta on Apple Silicon, and it crashes on every queued audio cue. It's been broken for years. This is a from-scratch reimplementation that runs natively on every modern Mac, plus Windows and Linux as a bonus.

## Install

The easiest path is the [website](https://ethansk.github.io/restream-chat-plus-plus/) — it always points at the latest release.

Direct links for the impatient:

- **macOS (Apple Silicon):** [latest mac-arm64 zip](https://github.com/EthanSK/restream-chat-plus-plus/releases/latest)
- **macOS (Intel):** [latest mac-x64 zip](https://github.com/EthanSK/restream-chat-plus-plus/releases/latest)
- **Windows:** [latest Setup.exe](https://github.com/EthanSK/restream-chat-plus-plus/releases/latest)
- **Linux:** [latest .deb / .rpm](https://github.com/EthanSK/restream-chat-plus-plus/releases/latest)

After install, sign in with your Restream account (OAuth in a popup window). The app auto-checks for updates once an hour; you can also trigger a check manually via **Restream Chat++ → Check for Updates…** (macOS) or **Help → Check for Updates…** (Windows/Linux).

## OAuth setup at Restream

Self-hosted? You'll need a Restream developer app:

1. Go to <https://developers.restream.io> and create an app.
2. Set the **redirect URI** to: `http://localhost:8765/oauth`
3. Grant scopes: `profile.read channels.read stream.read chat.read channels.write stream.write`
4. Copy the client ID + secret into Keychain or `.env.local` (see `.env.example`).

## Develop

```bash
git clone https://github.com/EthanSK/restream-chat-plus-plus.git
cd restream-chat-plus-plus
npm install --legacy-peer-deps
npm start          # dev mode — hot-reload renderer
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run make       # build for current host (skips signing without secrets)
```

For a signed CI build matching the released artefacts, push to `main` (build-only) or push a `v*` tag (build + publish to Releases + bump landing-page `version.json`). The release workflow lives at `.github/workflows/release.yml`.

### Project layout

```
src/
  main/                   Electron main process
    main.ts               App entry, BrowserWindow, IPC handlers, native menu
    updater.ts            update-electron-app wrapper + "Check for Updates" menu
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
    tts.ts                Web Speech queue + rate limiter
    styles.css            Dark-mode-first styling
  preload.ts              contextBridge surface — typed via RcppApi
  shared/types.ts         Shared types between main + renderer
  __tests__/              Vitest tests (11 tests covering normalisation, WS reconnect, backoff, rate-limit)
build/
  entitlements.mac.plist  Hardened-runtime entitlements for notarization
.github/workflows/
  ci.yml                  Lint + typecheck + tests on PR + push
  release.yml             Per-arch build + sign + notarize + GitHub Release + pages update
```

### Code signing + notarization

CI builds are signed with an Apple Developer ID certificate and notarized via `notarytool`. The signing path is gated on the following GitHub Secrets being set:

- `APPLE_CERT_P12_BASE64` — base64-encoded Developer ID `.p12`
- `APPLE_CERT_PASSWORD` — password used when exporting the `.p12`
- `APPLE_ID` — Apple ID email
- `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password from appleid.apple.com
- `APPLE_TEAM_ID` — 10-character Apple Developer Team ID
- `APPLE_IDENTITY` — full identity string, e.g. `"Developer ID Application: Ethan Sarif-Kattan (TEAMID)"`

Without these, builds still succeed but are unsigned (auto-update won't work on macOS, Gatekeeper will warn on first launch). Local dev builds always skip signing.

## Status

Personal-use replacement. Not affiliated with Restream. Not published to any app store. The Restream side of things (their official app's Apple-Silicon crash) is tracked at [bug-report.md](./bug-report.md) if it exists in this repo; the upstream issue page is also a good reference: <https://developers.restream.io>.

## License

MIT.
