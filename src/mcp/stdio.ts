// Line-delimited JSON-RPC over stdio — the wire format every MCP client
// (Claude Code, the MCP Inspector, etc.) uses to talk to a stdio server.
//
// Protocol details (matches the official MCP `StdioServerTransport`):
//   - Each request is a single JSON object on its own line, terminated by `\n`.
//   - Each response is a single JSON object on its own line, terminated by `\n`.
//   - Notifications (requests with no `id`) get no response.
//   - The server exits cleanly on stdin EOF.
//
// We never write logs / diagnostics to stdout — only JSON-RPC responses.
// Any error logging goes to stderr where it doesn't interfere with the
// MCP framing (the client doesn't read stderr).

import { dispatchRpc, type JsonRpcRequest } from './protocol';
import { buildToolContext, type ToolContext } from './tools';

/**
 * Start the stdio MCP server. Reads from `process.stdin`, writes to
 * `process.stdout`. Exits the process on stdin EOF.
 *
 * The optional `ctx` override lets unit tests inject a tmp store path.
 * Production callers (the `--mcp-stdio` entrypoint) pass nothing and we
 * resolve the real store path via `app.getPath('userData')`.
 */
export function startStdioServer(ctx?: ToolContext): void {
  const toolCtx = ctx ?? buildToolContext();
  process.stdin.setEncoding('utf8');

  let buffer = '';
  // Serial in-flight queue — we await each handler in order so a long
  // mutation can't race a follow-up read of the same store file.
  // (Tool handlers themselves are short, but file I/O is async-ish from
  // electron-store's perspective.) Without the queue an `await
  // tool.handler` could be interleaved by the next-read-event loop step.
  let queue: Promise<void> = Promise.resolve();

  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIdx = buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      newlineIdx = buffer.indexOf('\n');
      if (line.length === 0) continue;
      queue = queue.then(() => handleLine(line, toolCtx));
    }
  });

  process.stdin.on('end', () => {
    // Drain the queue, then exit.
    queue.finally(() => process.exit(0));
  });
}

/**
 * Parse a single line, dispatch to the protocol layer, write the response.
 * Exposed for unit tests so they can drive one line at a time without
 * wiring up stdin/stdout streams.
 */
export async function handleLine(line: string, ctx: ToolContext): Promise<void> {
  let req: JsonRpcRequest | undefined;
  try {
    req = JSON.parse(line) as JsonRpcRequest;
  } catch (parseErr) {
    // Per JSON-RPC 2.0 §5.1 — a parse error gets an error response with
    // `id: null`.
    writeResponse({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
        data: (parseErr as Error)?.message,
      },
    });
    return;
  }
  try {
    const res = await dispatchRpc(req, ctx);
    if (res !== null) writeResponse(res);
  } catch (err) {
    // Last-line defence — dispatchRpc itself catches all known errors.
    // If we land here it's an unexpected internal failure.
    writeResponse({
      jsonrpc: '2.0',
      id: req.id ?? null,
      error: {
        code: -32603,
        message: 'Internal error',
        data: (err as Error)?.message,
      },
    });
  }
}

function writeResponse(res: unknown): void {
  try {
    process.stdout.write(JSON.stringify(res) + '\n');
  } catch (writeErr) {
    // Stdout closed — likely the parent process exited. We can't
    // recover; surface to stderr and bail.
    process.stderr.write(
      `[mcp-stdio] stdout write failed: ${(writeErr as Error)?.message}\n`,
    );
    process.exit(1);
  }
}
