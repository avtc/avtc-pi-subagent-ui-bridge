// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { MessageMeta, TypedHandler, UiBridgeApi } from "../src/types.js";

type HandlerInput = Parameters<TypedHandler>[0];

const ROOT_SOCKET_ENV = "PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET";
const AUTH_TOKEN_ENV = "PI_SUBAGENT_UI_BRIDGE_AUTH_TOKEN";

/** Extension context: UI available */
const HAS_UI = true;

/** Extension context: no UI (headless) */
const NO_UI = false;

/**
 * Mock ExtensionAPI that captures event registrations
 * so tests can manually fire them.
 */
function createMockPi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();
  const emitted: { event: string; data: unknown }[] = [];

  return {
    on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      // Return unsubscribe function like real pi API
      return () => {
        const list = handlers.get(event) ?? [];
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
        handlers.set(event, list);
      };
    },
    events: {
      emit: (event: string, data: unknown) => {
        emitted.push({ event, data });
      },
    },
    /** Fire a registered event handler */
    async fire(event: string, ...args: unknown[]) {
      const handlerList = handlers.get(event) ?? [];
      for (const handler of handlerList) await handler(...args);
    },
    get emitted() {
      return emitted;
    },
    /** Check if a handler is registered for an event */
    hasHandler(event: string): boolean {
      return (handlers.get(event) ?? []).length > 0;
    },
    /** Simulate pi.getContext() for reload tests */
    getContext(): unknown {
      return undefined;
    },
  };
}

function createMockCtx(hasUI: boolean) {
  return {
    hasUI,
    sessionManager: {
      getSessionId: () => "ext-test-session",
      getSessionFile: () => "/tmp/test-session.jsonl",
    },
  };
}

// Clean up env vars and globalThis state before/after each test
const WIRED_KEY = "__avtcPiSubagentUiBridgeWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

beforeEach(async () => {
  delete process.env[ROOT_SOCKET_ENV];
  delete process.env[AUTH_TOKEN_ENV];
  delete process.env.PI_SUBAGENT_CHILD_AGENT;
  delete (globalThis as GlobalWithWired)[WIRED_KEY];
  const { _resetState } = await import("../src/extension.js");
  _resetState();
});

afterEach(async () => {
  delete process.env[ROOT_SOCKET_ENV];
  delete process.env[AUTH_TOKEN_ENV];
  delete process.env.PI_SUBAGENT_CHILD_AGENT;
  delete (globalThis as GlobalWithWired)[WIRED_KEY];
  const { _resetState } = await import("../src/extension.js");
  _resetState();
});

test("server mode: session_start with hasUI creates server, sets env vars, emits ready", async () => {
  const { default: extension } = await import("../src/extension.js");

  const pi = createMockPi();
  extension(pi as unknown as ExtensionAPI);

  await pi.fire("session_start", {}, createMockCtx(HAS_UI));

  // Should have set env vars
  expect(process.env[ROOT_SOCKET_ENV]).toBeDefined();
  expect(process.env[AUTH_TOKEN_ENV]).toBeDefined();

  // Should have emitted ready event
  expect(pi.emitted.length).toBe(1);
  expect(pi.emitted[0].event).toBe("pi-subagent-ui-bridge:ready");

  // API should have registerHandler but no sendAndWait
  const api = pi.emitted[0].data as UiBridgeApi;
  expect(typeof api.registerHandler).toBe("function");
  expect(api.sendAndWait).toBeUndefined();

  // Cleanup
  await pi.fire("session_shutdown");
  expect(process.env[ROOT_SOCKET_ENV]).toBeUndefined();
  expect(process.env[AUTH_TOKEN_ENV]).toBeUndefined();
});

test("server mode: session_shutdown cleans up server and env vars", async () => {
  const { default: extension } = await import("../src/extension.js");

  const pi = createMockPi();
  extension(pi as unknown as ExtensionAPI);

  await pi.fire("session_start", {}, createMockCtx(HAS_UI));
  expect(process.env[ROOT_SOCKET_ENV]).toBeDefined();

  await pi.fire("session_shutdown");
  expect(process.env[ROOT_SOCKET_ENV]).toBeUndefined();
  expect(process.env[AUTH_TOKEN_ENV]).toBeUndefined();
});

test("client mode: session_start without hasUI does not create server", async () => {
  const { default: extension } = await import("../src/extension.js");

  const pi = createMockPi();
  extension(pi as unknown as ExtensionAPI);

  // No env vars set — client mode will fail gracefully (no server to connect to)
  await pi.fire("session_start", {}, createMockCtx(NO_UI));

  // Should not emit ready event since no server is running
  expect(pi.emitted.length).toBe(0);
  // Should not set env vars
  expect(process.env[ROOT_SOCKET_ENV]).toBeUndefined();
});

test("client mode: session_start connects to existing server and emits ready", async () => {
  const { SubagentIpcServer } = await import("../src/server.js");
  const server = new SubagentIpcServer({ sessionId: "ext-client-test" });
  await server.start();

  try {
    process.env[ROOT_SOCKET_ENV] = server.socketPath ?? "";
    process.env[AUTH_TOKEN_ENV] = server.authToken;
    process.env.PI_SUBAGENT_CHILD_AGENT = "test-worker";

    const { default: extension } = await import("../src/extension.js");
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    await pi.fire("session_start", {}, createMockCtx(NO_UI));

    expect(pi.emitted.length).toBe(1);
    expect(pi.emitted[0].event).toBe("pi-subagent-ui-bridge:ready");

    const api = pi.emitted[0].data as UiBridgeApi;
    expect(api.registerHandler).toBeUndefined();
    expect(typeof api.sendAndWait).toBe("function");

    await pi.fire("session_shutdown");
  } finally {
    await server.stop();
  }
});

test("client mode: session_shutdown disconnects client", async () => {
  const { SubagentIpcServer } = await import("../src/server.js");
  const server = new SubagentIpcServer({ sessionId: "ext-client-shutdown" });
  await server.start();

  try {
    process.env[ROOT_SOCKET_ENV] = server.socketPath ?? "";
    process.env[AUTH_TOKEN_ENV] = server.authToken;

    const { default: extension } = await import("../src/extension.js");
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    await pi.fire("session_start", {}, createMockCtx(NO_UI));
    await pi.fire("session_shutdown");

    // No crash — client disconnected cleanly
  } finally {
    await server.stop();
  }
});

test("rpc child mode: hasUI=true + root socket env present → client, not server", async () => {
  // RPC subagent children have hasUI=true (rpc-mode passes a real uiContext) but must run as
  // a CLIENT (forward to the root server) — never a server (two servers would clash).
  const { SubagentIpcServer } = await import("../src/server.js");
  const server = new SubagentIpcServer({ sessionId: "ext-rpcchild-test" });
  await server.start();

  try {
    process.env[ROOT_SOCKET_ENV] = server.socketPath ?? "";
    process.env[AUTH_TOKEN_ENV] = server.authToken;
    process.env.PI_SUBAGENT_CHILD_AGENT = "rpc-worker";

    const { default: extension } = await import("../src/extension.js");
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    // hasUI=true but root socket env present → CLIENT path. Distinguish from server mode:
    // a client api exposes sendAndWait (a function); a server api has sendAndWait === undefined.
    await pi.fire("session_start", {}, createMockCtx(HAS_UI));

    expect(pi.emitted.length).toBe(1);
    expect(pi.emitted[0].event).toBe("pi-subagent-ui-bridge:ready");
    const api = pi.emitted[0].data as UiBridgeApi;
    expect(typeof api.sendAndWait).toBe("function"); // CLIENT, not server
    // The env var is UNCHANGED — no new server was spawned over the existing socket.
    expect(process.env[ROOT_SOCKET_ENV]).toBe(server.socketPath ?? "");

    await pi.fire("session_shutdown");
  } finally {
    await server.stop();
  }
});

test("client mode: sendAndWait sends undefined agentName when PI_SUBAGENT_CHILD_AGENT not set", async () => {
  const { SubagentIpcServer } = await import("../src/server.js");
  const server = new SubagentIpcServer({ sessionId: "ext-agentname-test" });
  await server.start();

  let capturedMeta: MessageMeta | null = null;
  server.registerHandler("test-type", async (input: HandlerInput) => {
    capturedMeta = input.meta;
    return { ok: true };
  });

  try {
    process.env[ROOT_SOCKET_ENV] = server.socketPath ?? "";
    process.env[AUTH_TOKEN_ENV] = server.authToken;

    const { default: extension } = await import("../src/extension.js");
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    await pi.fire("session_start", {}, createMockCtx(NO_UI));

    const api = pi.emitted[0].data as UiBridgeApi;
    await api.sendAndWait?.({ contentType: "test-type", payload: {}, text: "test" });

    expect(capturedMeta).not.toBeNull();
    const meta = capturedMeta as unknown as MessageMeta;
    expect(meta.agentName).toBeUndefined();

    await pi.fire("session_shutdown");
  } finally {
    await server.stop();
  }
});

test("client mode: message_end events update lastMessage in sendAndWait meta", async () => {
  const { SubagentIpcServer } = await import("../src/server.js");
  const server = new SubagentIpcServer({ sessionId: "ext-meta-flow-test" });
  await server.start();

  let capturedMeta: MessageMeta | null = null;
  server.registerHandler("test-meta", async (input: HandlerInput) => {
    capturedMeta = input.meta;
    return { ok: true };
  });

  try {
    process.env[ROOT_SOCKET_ENV] = server.socketPath ?? "";
    process.env[AUTH_TOKEN_ENV] = server.authToken;
    process.env.PI_SUBAGENT_CHILD_AGENT = "meta-test-agent";

    const { default: extension } = await import("../src/extension.js");
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    await pi.fire("session_start", {}, createMockCtx(NO_UI));

    await pi.fire("message_end", {
      message: { role: "assistant", content: "First message" },
    });

    await pi.fire("message_end", {
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "1", name: "read", input: {} },
          { type: "text", text: "Second message" },
        ],
      },
    });

    const api = pi.emitted[0].data as UiBridgeApi;
    await api.sendAndWait?.({ contentType: "test-meta", payload: { test: true }, text: "meta flow test" });

    expect(capturedMeta).not.toBeNull();
    const meta2 = capturedMeta as unknown as MessageMeta;
    expect(meta2.agentName).toBe("meta-test-agent");
    expect(meta2.lastMessage).toBe("Second message");
    expect(meta2.sessionFile).toBe("/tmp/test-session.jsonl");

    await pi.fire("session_shutdown");
  } finally {
    await server.stop();
  }
});

test("client mode: sendAndWait meta.lastMessage is empty when no message_end fired", async () => {
  const { SubagentIpcServer } = await import("../src/server.js");
  const server = new SubagentIpcServer({ sessionId: "ext-no-msg-test" });
  await server.start();

  let capturedMeta: MessageMeta | null = null;
  server.registerHandler("test-no-msg", async (input: HandlerInput) => {
    capturedMeta = input.meta;
    return { ok: true };
  });

  try {
    process.env[ROOT_SOCKET_ENV] = server.socketPath ?? "";
    process.env[AUTH_TOKEN_ENV] = server.authToken;
    process.env.PI_SUBAGENT_CHILD_AGENT = "no-msg-agent";

    const { default: extension } = await import("../src/extension.js");
    const pi = createMockPi();
    extension(pi as unknown as ExtensionAPI);

    await pi.fire("session_start", {}, createMockCtx(NO_UI));

    const api = pi.emitted[0].data as UiBridgeApi;
    await api.sendAndWait?.({ contentType: "test-no-msg", payload: {}, text: "no msg test" });

    expect(capturedMeta).not.toBeNull();
    const meta3 = capturedMeta as unknown as MessageMeta;
    expect(meta3.agentName).toBe("no-msg-agent");
    expect(meta3.lastMessage).toBeUndefined();

    await pi.fire("session_shutdown");
  } finally {
    await server.stop();
  }
});

// ── Reload tests ────────────────────────────────────────────────────────────

test("server mode: reload re-sets up server and emits ready again", async () => {
  const { default: extension } = await import("../src/extension.js");

  // First load — normal session_start
  const pi1 = createMockPi();
  extension(pi1 as unknown as ExtensionAPI);
  await pi1.fire("session_start", {}, createMockCtx(HAS_UI));

  expect(pi1.emitted.length).toBe(1);
  expect(process.env[ROOT_SOCKET_ENV]).toBeDefined();

  // Realistic reload flow: session_shutdown fires before pi re-evaluates the module.
  // It tears down the server AND resets the wiring guard so the next call re-wires.
  await pi1.fire("session_shutdown");
  expect(process.env[ROOT_SOCKET_ENV]).toBeUndefined();

  // Simulate reload — module re-evaluated, entry called with a fresh pi instance.
  const pi2 = createMockPi();
  extension(pi2 as unknown as ExtensionAPI);

  expect(pi2.emitted.length).toBe(0);

  await pi2.fire("session_start", { reason: "reload" }, createMockCtx(HAS_UI));

  expect(pi2.emitted.length).toBeGreaterThanOrEqual(1);
  expect(pi2.emitted[0].event).toBe("pi-subagent-ui-bridge:ready");

  expect(pi1.hasHandler("session_start")).toBe(false);
  expect(process.env[ROOT_SOCKET_ENV]).toBeDefined();

  await pi2.fire("session_shutdown");
  expect(process.env[ROOT_SOCKET_ENV]).toBeUndefined();
});

test("client mode: reload re-sets up client and emits ready again", async () => {
  const { SubagentIpcServer } = await import("../src/server.js");
  const server = new SubagentIpcServer({ sessionId: "ext-reload-client-test" });
  await server.start();

  try {
    process.env[ROOT_SOCKET_ENV] = server.socketPath ?? "";
    process.env[AUTH_TOKEN_ENV] = server.authToken;
    process.env.PI_SUBAGENT_CHILD_AGENT = "reload-test-agent";

    const { default: extension } = await import("../src/extension.js");

    const pi1 = createMockPi();
    extension(pi1 as unknown as ExtensionAPI);
    await pi1.fire("session_start", {}, createMockCtx(NO_UI));

    expect(pi1.emitted.length).toBe(1);
    expect(pi1.hasHandler("message_end")).toBe(true);

    // Realistic reload flow: session_shutdown fires before pi re-evaluates the module.
    // It disconnects the client AND resets the wiring guard so the next call re-wires.
    await pi1.fire("session_shutdown");

    const pi2 = createMockPi();
    extension(pi2 as unknown as ExtensionAPI);

    expect(pi2.emitted.length).toBe(0);

    await pi2.fire("session_start", { reason: "reload" }, createMockCtx(NO_UI));

    expect(pi2.emitted.length).toBeGreaterThanOrEqual(1);
    expect(typeof (pi2.emitted[0].data as UiBridgeApi).sendAndWait).toBe("function");

    expect(pi2.hasHandler("message_end")).toBe(true);
    expect(pi1.hasHandler("session_start")).toBe(false);
    expect(pi1.hasHandler("session_shutdown")).toBe(false);

    await pi2.fire("session_shutdown");
  } finally {
    await server.stop();
  }
});

// ── extractLastAssistantText tests ─────────────────────────────────────────

test("extractLastAssistantText returns string content from assistant message", async () => {
  const { extractLastAssistantText } = await import("../src/extension.js");
  const result = extractLastAssistantText({
    message: { role: "assistant", content: "Hello world" },
  });
  expect(result).toBe("Hello world");
});

test("extractLastAssistantText extracts last text block from array content", async () => {
  const { extractLastAssistantText } = await import("../src/extension.js");
  const result = extractLastAssistantText({
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "1", name: "read", input: {} },
        { type: "text", text: "First" },
        { type: "tool_result", tool_use_id: "1", content: "output" },
        { type: "text", text: "Last message" },
      ],
    },
  });
  expect(result).toBe("Last message");
});

test("extractLastAssistantText returns empty string for non-assistant role", async () => {
  const { extractLastAssistantText } = await import("../src/extension.js");
  const result = extractLastAssistantText({
    message: { role: "user", content: "Hello" },
  });
  expect(result).toBe("");
});

test("extractLastAssistantText returns empty string when no text blocks in array", async () => {
  const { extractLastAssistantText } = await import("../src/extension.js");
  const result = extractLastAssistantText({
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "1", name: "read", input: {} },
        { type: "tool_result", tool_use_id: "1", content: "output" },
      ],
    },
  });
  expect(result).toBe("");
});

test("extractLastAssistantText returns empty string for missing message", async () => {
  const { extractLastAssistantText } = await import("../src/extension.js");
  const result = extractLastAssistantText({});
  expect(result).toBe("");
});

test("extractLastAssistantText returns first text block when only one exists", async () => {
  const { extractLastAssistantText } = await import("../src/extension.js");
  const result = extractLastAssistantText({
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id: "1", name: "bash", input: {} },
        { type: "text", text: "Only text" },
      ],
    },
  });
  expect(result).toBe("Only text");
});
