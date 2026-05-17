// Minimal JSON-RPC 2.0 + MCP protocol handler. Hand-rolled (no SDK dep)
// so the binary footprint stays tiny and there's nothing to npm-install
// inside the .app bundle.
//
// MCP spec we target: 2024-11-05 (the version the stats-widget MCP
// server speaks). We implement the three handshake methods every MCP
// client expects:
//
//   - `initialize`     → return protocol version + server info + capabilities
//   - `tools/list`     → return TOOLS with their JSON-Schema input shapes
//   - `tools/call`     → dispatch by name, return content envelope
//
// We also accept `notifications/initialized` as a no-op (clients fire it
// after `initialize` to acknowledge handshake completion).
//
// Anything else → JSON-RPC `-32601 Method not found` error.

import { TOOLS, TOOLS_BY_NAME, type ToolContext } from './tools';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'restream-chat-plus-plus';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * Standard JSON-RPC + MCP error codes we emit. Codes <-32000 are reserved
 * for the protocol; >-32000 are application-level.
 */
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * Build a `tools/list` response. The MCP shape is:
 *   { tools: [{ name, description, inputSchema }, ...] }
 *
 * We slice `TOOLS` to that surface (the `handler` field stays internal).
 */
export function buildToolsList(): { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> } {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
  };
}

/**
 * Build the `initialize` response. We advertise `tools` capability only
 * (no resources/prompts/sampling — Restream Chat++ doesn't need them).
 */
export function buildInitializeResult(appVersion: string): Record<string, unknown> {
  return {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: {
      name: MCP_SERVER_NAME,
      version: appVersion,
    },
    capabilities: {
      tools: {
        // Per MCP spec — set to `true` if the tool list can change
        // dynamically and the server emits `notifications/tools/list_changed`.
        // We have a static tool registry, so false.
        listChanged: false,
      },
    },
  };
}

/**
 * Dispatch a single JSON-RPC request to the appropriate handler. Returns
 * a JsonRpcResponse OR null for notification methods (no `id` set, no
 * response expected per JSON-RPC 2.0 §4.1).
 *
 * Pure-function shape — no side effects beyond what the tool handlers
 * themselves do (file writes). Caller is responsible for serialising the
 * response to stdout. Exported as a top-level function so unit tests can
 * drive it directly without mocking stdin/stdout.
 */
export async function dispatchRpc(
  req: JsonRpcRequest,
  ctx: ToolContext,
): Promise<JsonRpcResponse | null> {
  // Reject malformed JSON-RPC envelopes BEFORE looking at the method.
  if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id: req.id ?? null,
      error: {
        code: ErrorCodes.InvalidRequest,
        message: 'Malformed JSON-RPC request',
      },
    };
  }

  // Notifications have no `id` and never get a response.
  const isNotification = req.id === undefined;

  try {
    switch (req.method) {
      case 'initialize':
        return ok(req.id ?? null, buildInitializeResult(ctx.appVersion));

      case 'notifications/initialized':
        // Clients fire this after `initialize` to acknowledge handshake.
        // No-op + no response (it's a notification, no id).
        return null;

      case 'tools/list':
        return ok(req.id ?? null, buildToolsList());

      case 'tools/call': {
        const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === 'string' ? params.name : '';
        const args =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {};
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) {
          return err(
            req.id ?? null,
            ErrorCodes.MethodNotFound,
            `Unknown tool: "${name}"`,
          );
        }
        try {
          const result = await tool.handler(args, ctx);
          // MCP `tools/call` result shape:
          //   { content: [{ type: 'text', text: '<json>' }], isError?: boolean }
          // We serialise the handler payload to JSON for the text content
          // so agents can re-parse it. This mirrors stats-widget's MCP.
          return ok(req.id ?? null, {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          });
        } catch (handlerErr) {
          const message =
            (handlerErr as Error)?.message ?? String(handlerErr ?? 'tool failed');
          // Tool-level errors come back as a `tools/call` result with
          // `isError: true` — MCP convention so the agent can show the
          // error text inline rather than crashing the session.
          return ok(req.id ?? null, {
            content: [{ type: 'text', text: message }],
            isError: true,
          });
        }
      }

      default:
        // Notifications we don't recognise are silently dropped (no
        // response per spec). Requests we don't recognise get a proper
        // -32601 Method not found.
        if (isNotification) return null;
        return err(
          req.id ?? null,
          ErrorCodes.MethodNotFound,
          `Method not implemented: ${req.method}`,
        );
    }
  } catch (rpcErr) {
    if (isNotification) return null;
    return err(
      req.id ?? null,
      ErrorCodes.InternalError,
      (rpcErr as Error)?.message ?? 'Internal error',
    );
  }
}

function ok(
  id: number | string | null,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
