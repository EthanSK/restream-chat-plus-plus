# Kick chat relay

Kick sends public API chat events to a signed HTTPS webhook. This Cloudflare
Worker verifies Kick's RSA signature and forwards only verified
`chat.message.sent` events to authenticated Restream Chat++ WebSocket clients.

## Configure

1. Create the Durable Object namespace with `npm run deploy`.
2. Set a strong `CHAT_RELAY_TOKEN` with `npx wrangler secret put CHAT_RELAY_TOKEN`.
3. Set the Kick developer app webhook to
   `https://<worker>/kick/webhook` and enable `chat.message.sent`.
4. Configure the desktop app with `wss://<worker>/socket` and the same token.

Never put `CHAT_RELAY_TOKEN` in `wrangler.jsonc` or source control. Kick's
official public verification key is intentionally public and lives in
`src/signature.ts`.

## Validate

```bash
npm run typecheck
npm test
npx wrangler deploy --dry-run
```
