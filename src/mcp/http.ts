// Streamable-HTTP MCP transport for Restream Chat++.
//
// Hosted inside the running Electron main process (see
// `src/main/mcp-server.ts`). Listens on `127.0.0.1:<port>` with a single
// `/mcp` endpoint that handles POST JSON-RPC + a `GET /health` endpoint
// for liveness checks.
//
// Wire format — MCP "Streamable HTTP" transport (spec 2025-03-26):
//   - POST /mcp with a single JSON-RPC envelope as the request body.
//   - Response is `Content-Type: application/json` with the JSON-RPC
//     envelope as the body. (Spec allows the response to be an SSE stream
//     instead, but plain JSON is sufficient for the synchronous tools we
//     expose. Streaming can be layered on later without changing the
//     endpoint URL.)
//   - Notifications (JSON-RPC requests with no `id`) return HTTP 202 with
//     an empty body.
//
// Discovery: we write `{port,pid,startedAt}` to a well-known JSON file
// under `app.getPath('userData')` on listen-success so any MCP client can
// locate the running app even if the port had to slide off the default.
//
// Why hand-rolled and not `@modelcontextprotocol/sdk`: the SDK pulls a
// transitive tree (zod, eventsource-parser, etc.) we don't need. Our
// existing `dispatchRpc` function in `protocol.ts` already handles the
// JSON-RPC + MCP envelope correctly — all we need on top is a thin HTTP
// shell. Keeps the bundle small and the dependency surface zero.
//
// Bind address is hardcoded to `127.0.0.1` — never `0.0.0.0`. Even with
// CORS headers blank, exposing the MCP control surface to anything other
// than loopback would let any process on the LAN mutate the user's
// settings + sign them out. Loopback-only matches stats-widget MCP's
// posture.

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchRpc, ErrorCodes, type JsonRpcRequest } from './protocol';
import type { ToolContext } from './tools';

/**
 * Default listen port. Picked to be deliberately uncommon so it's unlikely
 * to collide with another local dev server. Override via the optional
 * `port` arg if needed (e.g. for unit tests).
 */
export const DEFAULT_MCP_PORT = 19852;

/**
 * Maximum number of consecutive ports to try if the default is taken.
 * Prevents the app from launching with a wildly different port when the
 * default is genuinely free — but allows graceful slide if something
 * else grabbed 19852 first.
 */
const PORT_SCAN_RANGE = 8;

/**
 * Maximum request-body size we'll buffer before returning HTTP 413. MCP
 * requests are tiny JSON envelopes — anything over 1 MiB is either a
 * malformed client or an attempted DoS.
 */
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpMcpServer {
  /** The actual listening port (may differ from the requested one if it slid). */
  port: number;
  /** Path to the port discovery file (`mcp-port.json` in userData). */
  portFilePath: string | null;
  /** Stop the server + remove the port file. Idempotent. */
  close(): Promise<void>;
  /** Underlying node http server. Exposed for tests. */
  server: http.Server;
}

export interface HttpMcpStartOptions {
  /** Build / reuse the ToolContext the dispatcher needs. */
  ctx: ToolContext;
  /** Override listen port. Default = `DEFAULT_MCP_PORT`. */
  port?: number;
  /**
   * Absolute path where we should write `{port,pid,startedAt}` JSON for
   * client discovery. Pass `null` to disable port-file writing (tests).
   */
  portFilePath?: string | null;
  /** Optional logger override. Default uses `console`. */
  log?: (msg: string) => void;
}

/**
 * Start an HTTP MCP server. Returns once the server is bound + the port
 * file has been written. Throws if no port in the scan range was free.
 */
export async function startHttpMcpServer(
  opts: HttpMcpStartOptions,
): Promise<HttpMcpServer> {
  const requestedPort = opts.port ?? DEFAULT_MCP_PORT;
  const log = opts.log ?? ((msg: string) => console.log(`[mcp-http] ${msg}`));

  const server = http.createServer((req, res) => {
    handleRequest(req, res, opts.ctx, log).catch((err) => {
      // Last-line defence — `handleRequest` already returns a JSON-RPC
      // error envelope for any caught throw. If we land here it's
      // something thrown outside the try (e.g. the response was already
      // half-written). Just close the socket.
      log(`uncaught request error: ${(err as Error)?.message}`);
      try {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      } catch {
        // socket already destroyed
      }
    });
  });

  // Refuse to keep an idle TCP connection open longer than 30s. Default
  // is 5s in node 18+ which is too aggressive for Claude Code (the
  // client uses HTTP keep-alive for back-to-back tool calls).
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 31_000;

  const actualPort = await bindWithSlide(server, requestedPort, PORT_SCAN_RANGE, log);

  let portFilePath = opts.portFilePath ?? null;
  if (portFilePath !== null) {
    try {
      fs.mkdirSync(path.dirname(portFilePath), { recursive: true });
      const body = JSON.stringify(
        {
          port: actualPort,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      fs.writeFileSync(portFilePath, body, 'utf8');
      log(`port file written: ${portFilePath}`);
    } catch (writeErr) {
      // Non-fatal — the server still works, clients just need to know
      // the port out-of-band. Surface to logs and move on.
      log(`port file write failed (non-fatal): ${(writeErr as Error)?.message}`);
      portFilePath = null;
    }
  }

  log(`listening on http://127.0.0.1:${actualPort}/mcp`);

  return {
    port: actualPort,
    portFilePath,
    server,
    close: () => closeServer(server, portFilePath, log),
  };
}

/**
 * Try `port`, `port+1`, … up to `range` slots. Returns the actual port
 * we bound. Throws if every slot is taken (caller decides what to do —
 * surface to the user, retry later, etc.).
 */
function bindWithSlide(
  server: http.Server,
  startPort: number,
  range: number,
  log: (msg: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryBind = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < range - 1) {
          attempt += 1;
          log(`port ${port} in use, trying ${port + 1}`);
          tryBind(port + 1);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address() as AddressInfo;
        resolve(addr.port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Loopback-only — never bind to 0.0.0.0. See module header.
      server.listen(port, '127.0.0.1');
    };
    tryBind(startPort);
  });
}

async function closeServer(
  server: http.Server,
  portFilePath: string | null,
  log: (msg: string) => void,
): Promise<void> {
  if (portFilePath) {
    try {
      fs.unlinkSync(portFilePath);
    } catch {
      // Best effort; the file may already be gone if another instance
      // shut down concurrently or the user deleted userData.
    }
  }
  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) log(`server.close error (non-fatal): ${err.message}`);
      resolve();
    });
  });
}

/**
 * Handle a single HTTP request. Routes:
 *   POST /mcp           — JSON-RPC dispatch
 *   GET  /health        — `{ ok: true, name, version }`
 *   GET  /mcp           — informational JSON (for curl probes)
 *   anything else       — 404
 *
 * Exported so unit tests can drive request handling without a TCP socket.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ToolContext,
  log: (msg: string) => void,
): Promise<void> {
  // Cheap CORS — we only listen on loopback so a hostile origin would
  // already need code-execution on the same machine. But Claude Code
  // sometimes preflights with OPTIONS, so handle it cleanly.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, mcp-session-id',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  const url = req.url ?? '/';

  if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        name: 'restream-chat-plus-plus',
        version: ctx.appVersion,
        pid: process.pid,
      }),
    );
    return;
  }

  if (req.method === 'GET' && (url === '/mcp' || url === '/mcp/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: 'restream-chat-plus-plus',
        version: ctx.appVersion,
        transport: 'streamable-http',
        endpoint: 'POST /mcp',
        hint: 'POST a JSON-RPC envelope here. Try { jsonrpc: "2.0", id: 1, method: "initialize" }.',
      }),
    );
    return;
  }

  if (req.method !== 'POST' || (url !== '/mcp' && url !== '/mcp/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // Body parse — cap at MAX_BODY_BYTES.
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    const msg = (err as Error)?.message ?? 'body read failed';
    log(`body read error: ${msg}`);
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCodes.InvalidRequest, message: msg },
      }),
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: ErrorCodes.ParseError,
          message: 'Parse error',
          data: (err as Error)?.message,
        },
      }),
    );
    return;
  }

  // Spec note: a JSON-RPC batch is an array. We accept it but mainstream
  // MCP clients (Claude Code, Inspector) send singletons today — keeping
  // batch support cheap here means we don't need to revisit if a client
  // ever pipelines.
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const item of parsed) {
      const r = await dispatchOne(item, ctx);
      if (r !== null) responses.push(r);
    }
    if (responses.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(responses));
    return;
  }

  const single = await dispatchOne(parsed, ctx);
  if (single === null) {
    // JSON-RPC notification — per spec, return 202 + empty body.
    res.writeHead(202);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(single));
}

async function dispatchOne(payload: unknown, ctx: ToolContext): Promise<unknown> {
  if (!payload || typeof payload !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: ErrorCodes.InvalidRequest, message: 'Request must be a JSON object' },
    };
  }
  return dispatchRpc(payload as JsonRpcRequest, ctx);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Convenience helper — resolve the port-file path inside `userDataDir`.
 * Kept here (rather than in `mcp-server.ts`) so unit tests can derive the
 * same path without touching `electron.app`.
 */
export function resolvePortFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'mcp-port.json');
}
