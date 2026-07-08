// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SubagentIpcClient } from "./client.js";
import { SubagentIpcServer } from "./server.js";
import type { BridgeSessionCtx, MessageMeta, SendAndWaitOptions, TypedHandler, UiBridgeApi } from "./types.js";

// Idempotent wiring guard. subagent-ui-bridge can be bundled into the avtc-pi umbrella
// AND installed standalone — whichever copy loads first wires, the rest no-op.
const WIRED_KEY = "__avtcPiSubagentUiBridgeWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

const UI_BRIDGE_ROOT_SOCKET_ENV = "PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET";
const UI_BRIDGE_AUTH_TOKEN_ENV = "PI_SUBAGENT_UI_BRIDGE_AUTH_TOKEN";

/**
 * Extract the last assistant text from a message_end event.
 * Handles string content and array content (filters to text blocks, takes last).
 * Returns empty string if no suitable text found.
 */
type ContentBlock = { type: string; text?: string; [key: string]: unknown };

export function extractLastAssistantText(event: {
  message?: { role?: string; content?: string | ContentBlock[] };
}): string {
  if (event.message?.role !== "assistant") return "";

  const content = event.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlocks = content.filter((b): b is ContentBlock & { type: "text" } => b.type === "text");
    const last = textBlocks[textBlocks.length - 1];
    if (last) {
      return last.text ?? "";
    }
  }
  return "";
}

/**
 * Set up the IPC server for the root session (hasUI).
 * Creates the listening socket, sets env vars for child discovery,
 * and emits the ready event for consumer extensions.
 */
async function setupServer(pi: ExtensionAPI, ctx: BridgeSessionCtx): Promise<SubagentIpcServer | null> {
  const server = new SubagentIpcServer({
    sessionId: ctx.sessionManager.getSessionId(),
  });
  await server.start();

  if (!server.socketPath) return null;

  // Set env vars so child processes know where to connect and can authenticate
  process.env[UI_BRIDGE_ROOT_SOCKET_ENV] = server.socketPath;
  process.env[UI_BRIDGE_AUTH_TOKEN_ENV] = server.authToken;

  // Pass ctx to server so it can wrap handlers with withContext()
  server.setCtx(ctx);

  // Emit ready event for consumer extensions
  const api: UiBridgeApi = {
    registerHandler: (contentType: string, handler: TypedHandler) => {
      server.registerHandler(contentType, handler);
    },
    sendAndWait: undefined,
  };
  // Cache API for synchronous access on reload
  _state.cachedApi = api;
  pi.events.emit("pi-subagent-ui-bridge:ready", api);

  return server;
}

/**
 * Set up the IPC client for a child session (no hasUI).
 * Connects to the root session's socket, registers message_end listener
 * for context capture, and emits the ready event for consumer extensions.
 */
async function setupClient(
  pi: ExtensionAPI,
  ctx: BridgeSessionCtx,
): Promise<{ client: SubagentIpcClient; messageEndHandler: (...args: unknown[]) => void } | null> {
  const socketPath = process.env[UI_BRIDGE_ROOT_SOCKET_ENV];
  const authToken = process.env[UI_BRIDGE_AUTH_TOKEN_ENV];
  if (!socketPath || !authToken) return null;

  const capturedSessionFile = ctx.sessionManager?.getSessionFile?.();
  let lastMessage = "";

  const client = new SubagentIpcClient({ socketPath, authToken });

  try {
    await client.connect();

    // Start capturing lastMessage from message_end events
    const messageEndHandler = (event: unknown) => {
      const text = extractLastAssistantText(
        event as { message?: { role?: string; content?: string | Array<{ type: string; text?: string }> } },
      );
      if (text) lastMessage = text;
    };
    pi.on("message_end", messageEndHandler);

    // Emit ready event for consumer extensions
    const api: UiBridgeApi = {
      registerHandler: undefined,
      sendAndWait: async (options: SendAndWaitOptions): Promise<{ payload: unknown }> => {
        // Build meta from captured state
        const meta: Partial<MessageMeta> = {};
        meta.agentName = process.env.PI_SUBAGENT_CHILD_AGENT;
        if (lastMessage) meta.lastMessage = lastMessage;
        if (capturedSessionFile) meta.sessionFile = capturedSessionFile;

        return client.sendAndWait(options, meta as MessageMeta);
      },
    };

    // Cache API for synchronous access on reload
    _state.cachedApi = api;
    pi.events.emit("pi-subagent-ui-bridge:ready", api);
    return { client, messageEndHandler };
  } catch (error) {
    console.warn(
      `[pi-subagent-ui-bridge] Failed to connect to server: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}

/** globalThis survives module re-import during /reload. */
const _gt = globalThis as {
  __piSubagentUiBridgeState?: {
    server: SubagentIpcServer | null;
    client: SubagentIpcClient | null;
    messageEndHandler: ((...args: unknown[]) => void) | null;
    unsubs: Array<() => void>;
    /** Cached ready API for synchronous access on reload (before async setup completes). */
    cachedApi: UiBridgeApi | null;
  };
};
_gt.__piSubagentUiBridgeState = _gt.__piSubagentUiBridgeState ?? {
  server: null,
  client: null,
  messageEndHandler: null,
  unsubs: [],
  cachedApi: null,
};
const _state = _gt.__piSubagentUiBridgeState;

/** Reset module state — called on test cleanup. */
export function _resetState(): void {
  for (const unsub of _state.unsubs) unsub();
  _state.unsubs.length = 0;
  if (_state.server) {
    _state.server.stop().catch(() => {});
    _state.server = null;
  }
  if (_state.client) {
    _state.client.disconnect().catch(() => {});
    _state.client = null;
  }
  _state.messageEndHandler = null;
  _state.cachedApi = null;
}

/** Register an event handler on pi, returning an unsubscribe function.
 *  Guards against pi.on() returning non-function (e.g. undefined on some versions). */
function safeOn(pi: ExtensionAPI, event: string, handler: (...args: unknown[]) => void | Promise<void>): () => void {
  // pi.on is overloaded with literal event names; cast to a string-keyed form for this generic wrapper.
  const unsub = (pi.on as (event: string, handler: (...args: unknown[]) => void | Promise<void>) => unknown)(
    event,
    handler,
  );
  return typeof unsub === "function" ? (unsub as () => void) : () => {};
}

export default function subagentUiBridgeExtension(pi: ExtensionAPI) {
  const g = globalThis as GlobalWithWired;
  if (g[WIRED_KEY]) return;
  g[WIRED_KEY] = true;

  // Clean up previous listeners on reload
  for (const unsub of _state.unsubs) unsub();
  _state.unsubs.length = 0;

  _state.unsubs.push(
    safeOn(pi, "session_start", async (_event, rawCtx) => {
      const ctx = rawCtx as BridgeSessionCtx;
      // Root session (hasUI and not itself a bridged child) runs the server; everything else
      // runs the client — including RPC subagent children, which have hasUI=true but inherit
      // the root socket env (PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET), so they must forward, not serve.
      if (ctx.hasUI && !process.env[UI_BRIDGE_ROOT_SOCKET_ENV]) {
        _state.server = await setupServer(pi, ctx);
      } else {
        const result = await setupClient(pi, ctx);
        if (result) {
          _state.client = result.client;
          _state.messageEndHandler = result.messageEndHandler;
        }
      }
    }),
  );

  _state.unsubs.push(
    safeOn(pi, "session_shutdown", async () => {
      if (_state.server) {
        delete process.env[UI_BRIDGE_ROOT_SOCKET_ENV];
        delete process.env[UI_BRIDGE_AUTH_TOKEN_ENV];
        await _state.server.stop();
        _state.server = null;
      }
      if (_state.client) {
        await _state.client.disconnect();
        _state.client = null;
      }
      // message_end handler has no SDK unregister (ExtensionAPI has no off(); handlers
      // are torn down with the session) — just clear our cached reference.
      _state.messageEndHandler = null;
      _state.cachedApi = null;
    }),
  );

  // Reload-safety: session_shutdown fires before pi re-evaluates this module on /reload.
  // Reset the wiring guard so the fresh invocation re-wires instead of no-oping (which
  // would leave the extension dead after reload). pi accumulates multiple session_shutdown
  // handlers, so this runs in addition to the cleanup handler above.
  _state.unsubs.push(
    safeOn(pi, "session_shutdown", () => {
      g[WIRED_KEY] = false;
    }),
  );
}
