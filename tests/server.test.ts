// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import net from "node:net";
import { expect, test } from "vitest";
import { createMessageReader, writeMessage } from "../src/framing.js";
import { SubagentIpcServer } from "../src/server.js";
import type { BridgeCtx, IpcMessage, MessageMeta } from "../src/types.js";

const TEST_SESSION_ID = "test-session-001";

async function createTestServer(): Promise<{
  server: SubagentIpcServer;
  socketPath: string;
}> {
  const server = new SubagentIpcServer({ sessionId: TEST_SESSION_ID });
  await server.start();
  return { server, socketPath: server.socketPath ?? "" };
}

/** Connect a raw socket client and authenticate it. Waits for auth_ack. */
async function connectAndAuth(socketPath: string, token: string): Promise<net.Socket> {
  const client = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    client.on("connect", resolve);
    client.on("error", reject);
  });
  writeMessage(client, {
    id: "auth",
    type: "event",
    contentType: "auth",
    payload: { token },
  });
  // Wait for auth_ack by reading exactly one framed message
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("auth_ack timeout")), 3000);
    let buf = Buffer.alloc(0);
    const onData = (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      if (buf.length < 4) return;
      const msgLen = buf.readUInt32BE(0);
      if (buf.length < 4 + msgLen) return;
      // Got one complete message — remove listener, keep leftover in buffer
      client.removeListener("data", onData);
      clearTimeout(timeout);
      // Parse to verify it's auth_ack
      const msgStr = buf.subarray(4, 4 + msgLen).toString("utf-8");
      const msg = JSON.parse(msgStr) as IpcMessage;
      if (msg.type !== "event" || msg.contentType !== "auth_ack") {
        reject(new Error(`Expected auth_ack, got ${msg.type}/${msg.contentType}`));
        return;
      }
      // Any leftover data needs to be re-emitted for subsequent readers
      const leftover = buf.subarray(4 + msgLen);
      if (leftover.length > 0) {
        // Use process.nextTick to ensure the test's reader is attached first
        process.nextTick(() => client.emit("data", leftover));
      }
      resolve();
    };
    client.on("data", onData);
  });
  return client;
}

function createTestReader(onMessage: (msg: unknown) => void) {
  return createMessageReader(onMessage, (error) => {
    throw error;
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timeout waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("server starts and accepts connections", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.on("connect", resolve);
      client.on("error", reject);
    });
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server dispatches request to registered handler", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    let handlerCalled = false;
    server.registerHandler("test_type", async (input) => {
      handlerCalled = true;
      expect(input.contentType).toBe("test_type");
      expect(input.payload).toEqual({ data: "hello" });
      expect(typeof input.clientId).toBe("string");
      return { result: "world" };
    });

    const client = await connectAndAuth(socketPath, server.authToken);

    const messages: IpcMessage[] = [];
    const reader = createTestReader((msg) => messages.push(msg as IpcMessage));

    client.on("data", reader);

    const request: IpcMessage = {
      id: "req-1",
      type: "request",
      contentType: "test_type",
      payload: { data: "hello" },
    };
    writeMessage(client, request);

    // Wait for response
    await waitFor(() => messages.length >= 1, 3000);

    expect(handlerCalled).toBe(true);
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe("req-1");
    expect(messages[0].type).toBe("response");
    expect(messages[0].payload).toEqual({ result: "world" });

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server sends error response when handler throws", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    server.registerHandler("fail_type", async () => {
      throw new Error("handler exploded");
    });

    const client = await connectAndAuth(socketPath, server.authToken);

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, {
      id: "req-err",
      type: "request",
      contentType: "fail_type",
      payload: {},
    });

    await waitFor(() => messages.length >= 1, 3000);

    expect(messages[0].error).toBe("Internal handler error");

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server queues concurrent requests (one at a time)", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const order: string[] = [];
    server.registerHandler("queued", async (input) => {
      order.push(input.payload as string);
      return { ok: true };
    });

    const client1 = await connectAndAuth(socketPath, server.authToken);
    const client2 = await connectAndAuth(socketPath, server.authToken);

    const msgs1: IpcMessage[] = [];
    const msgs2: IpcMessage[] = [];
    client1.on(
      "data",
      createTestReader((msg) => msgs1.push(msg as IpcMessage)),
    );
    client2.on(
      "data",
      createTestReader((msg) => msgs2.push(msg as IpcMessage)),
    );

    writeMessage(client1, { id: "q1", type: "request", contentType: "queued", payload: "first" });
    writeMessage(client2, { id: "q2", type: "request", contentType: "queued", payload: "second" });

    await waitFor(() => msgs1.length >= 1 && msgs2.length >= 1, 3000);

    expect(order).toEqual(["first", "second"]);

    client1.destroy();
    client2.destroy();
  } finally {
    await server.stop();
  }
});

test("server sends payload:null when handler returns undefined", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    server.registerHandler("undef_type", async () => undefined);

    const client = await connectAndAuth(socketPath, server.authToken);

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "req-undef", type: "request", contentType: "undef_type", payload: {} });

    await waitFor(() => messages.length >= 1, 3000);

    expect(messages[0].payload).toBeNull();

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server handles client disconnect gracefully", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.on("connect", resolve);
      client.on("error", reject);
    });

    client.destroy();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.listClients().length).toBe(0);
  } finally {
    await server.stop();
  }
});

test("server dispatches event to registered handler (fire-and-forget)", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    let eventReceived: { contentType: string; payload: unknown; clientId: string; meta: MessageMeta } | null = null;
    server.registerHandler("my_event", async (input) => {
      eventReceived = input;
    });

    const client = await connectAndAuth(socketPath, server.authToken);

    writeMessage(client, {
      id: "evt-1",
      type: "event",
      contentType: "my_event",
      payload: { action: "something" },
    });

    await waitFor(() => eventReceived !== null, 3000);
    expect(eventReceived).not.toBeNull();
    const ev = eventReceived as unknown as {
      contentType: string;
      payload: unknown;
      clientId: string;
      meta: MessageMeta;
    };
    expect(ev.contentType).toBe("my_event");
    expect(ev.payload).toEqual({ action: "something" });
    expect(typeof ev.clientId).toBe("string");
    expect(ev.meta).toEqual({});

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server logs event handler error instead of silently ignoring", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    let handlerCalled = false;
    server.registerHandler("bad_event", async () => {
      handlerCalled = true;
      throw new Error("event handler exploded");
    });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

    try {
      const client = await connectAndAuth(socketPath, server.authToken);
      const messages: IpcMessage[] = [];
      client.on(
        "data",
        createTestReader((msg) => messages.push(msg as IpcMessage)),
      );

      writeMessage(client, { id: "evt-err", type: "event", contentType: "bad_event", payload: {} });

      await waitFor(() => handlerCalled, 3000);

      expect(messages.length).toBe(0);
      expect(warnings.some((w) => w.includes("event handler exploded"))).toBe(true);

      const client2 = await connectAndAuth(socketPath, server.authToken);
      client2.destroy();

      client.destroy();
    } finally {
      console.warn = origWarn;
    }
  } finally {
    await server.stop();
  }
});

test("server silently drops event with no registered handler", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = await connectAndAuth(socketPath, server.authToken);
    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "evt-no-handler", type: "event", contentType: "unknown_event", payload: {} });

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(messages.length).toBe(0);

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server sends error response when handler times out", async () => {
  const server = new SubagentIpcServer({
    sessionId: "timeout-test",
    handlerTimeoutMs: 200,
  });
  await server.start();
  try {
    server.registerHandler("slow_type", async () => {
      await new Promise(() => {});
    });

    const client = await connectAndAuth(server.socketPath ?? "", server.authToken);

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "req-timeout", type: "request", contentType: "slow_type", payload: {} });

    await waitFor(() => messages.length >= 1, 3000);

    expect(messages[0].id).toBe("req-timeout");
    expect(messages[0].type).toBe("response");
    expect(messages[0].error).toBe("handler timed out");
    expect(messages[0].payload).toBeNull();

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server processes queued request after handler timeout", async () => {
  const server = new SubagentIpcServer({
    sessionId: "timeout-queue-test",
    handlerTimeoutMs: 150,
  });
  await server.start();
  try {
    const order: string[] = [];
    server.registerHandler("ordered", async (input) => {
      const delay = input.payload as { delay: number; label: string };
      if (delay.delay > 0) {
        await new Promise(() => {});
      }
      order.push(delay.label);
      return { ok: true };
    });

    const client = await connectAndAuth(server.socketPath ?? "", server.authToken);

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, {
      id: "req-hang",
      type: "request",
      contentType: "ordered",
      payload: { delay: 9999, label: "first" },
    });
    writeMessage(client, {
      id: "req-ok",
      type: "request",
      contentType: "ordered",
      payload: { delay: 0, label: "second" },
    });

    await waitFor(() => messages.length >= 2, 5000);

    expect(messages[0].error).toBe("handler timed out");
    expect(messages[1].payload).toEqual({ ok: true });
    expect(order).toEqual(["second"]);

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server rejects client with wrong auth token", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.on("connect", resolve);
      client.on("error", reject);
    });

    writeMessage(client, { id: "auth-1", type: "event", contentType: "auth", payload: { token: "wrong-token" } });

    await new Promise<void>((resolve) => {
      client.on("close", () => resolve());
    });

    expect(server.listClients().length).toBe(0);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server accepts client with correct auth token", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const token = server.authToken ?? "";
    expect(token).toBeDefined();

    const client = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.on("connect", resolve);
      client.on("error", reject);
    });

    writeMessage(client, { id: "auth-1", type: "event", contentType: "auth", payload: { token } });

    let handlerCalled = false;
    server.registerHandler("post_auth", async (_input) => {
      handlerCalled = true;
      return { ok: true };
    });

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "req-1", type: "request", contentType: "post_auth", payload: {} });

    await waitFor(() => messages.length >= 1, 3000);
    expect(handlerCalled).toBe(true);

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server rejects client that sends request before auth", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = net.connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      client.on("connect", resolve);
      client.on("error", reject);
    });

    writeMessage(client, {
      id: "req-noauth",
      type: "request",
      contentType: "test_type",
      payload: {},
    } as unknown as Parameters<typeof writeMessage>[1]);

    await new Promise<void>((resolve) => {
      client.on("close", () => resolve());
    });

    expect(server.listClients().length).toBe(0);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server sends error response for unregistered contentType", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = await connectAndAuth(socketPath, server.authToken);

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, {
      id: "req-no-handler",
      type: "request",
      contentType: "unregistered_type",
      payload: { data: "test" },
    });

    await waitFor(() => messages.length >= 1, 3000);

    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe("req-no-handler");
    expect(messages[0].type).toBe("response");
    expect(messages[0].payload).toBeNull();
    expect(messages[0].error).toMatch(/No handler registered for contentType "unregistered_type"/);

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server sanitizes contentType in error response for malicious input", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = await connectAndAuth(socketPath, server.authToken);

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "req-malicious", type: "request", contentType: "test\x00type\x01name", payload: {} });

    await waitFor(() => messages.length >= 1, 3000);

    expect(messages[0].error).toMatch(/test\?type\?name/);

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server handles cancel event for queued request", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    let resolveHandler: (() => void) | null = null;
    server.registerHandler("test_type", async () => {
      await new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });
      return { done: true };
    });

    const client = await connectAndAuth(socketPath, server.authToken);
    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "req-1", type: "request", contentType: "test_type", payload: {} });
    writeMessage(client, { id: "req-2", type: "request", contentType: "test_type", payload: {} });

    await waitFor(() => resolveHandler !== null, 3000);

    writeMessage(client, { id: "cancel-1", type: "event", contentType: "cancel", payload: { cancelledId: "req-2" } });

    await waitFor(() => messages.length >= 1, 3000);

    const cancelResponse = messages.find((m) => m.id === "req-2");
    expect(cancelResponse).not.toBeNull();
    if (!cancelResponse) throw new Error("cancelResponse not found");
    expect(cancelResponse.error).toBe("cancelled");

    expect(resolveHandler).not.toBeNull();
    const resolver = resolveHandler as unknown as () => void;
    resolver();

    await waitFor(() => messages.some((m) => m.id === "req-1"), 3000);
    const firstResponse = messages.find((m) => m.id === "req-1");
    expect(firstResponse).not.toBeNull();
    if (!firstResponse) throw new Error("firstResponse not found");
    expect(firstResponse.payload).toEqual({ done: true });

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server handles cancel event for in-flight request", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    let resolveHandler: (() => void) | null = null;
    server.registerHandler("test_type", async () => {
      await new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });
      return { done: true };
    });

    const client = await connectAndAuth(socketPath, server.authToken);
    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "req-1", type: "request", contentType: "test_type", payload: {} });

    await waitFor(() => resolveHandler !== null, 3000);

    writeMessage(client, { id: "cancel-1", type: "event", contentType: "cancel", payload: { cancelledId: "req-1" } });

    await waitFor(() => messages.some((m) => m.id === "req-1"), 3000);

    const response = messages.find((m) => m.id === "req-1");
    expect(response).not.toBeNull();
    if (!response) throw new Error("response not found");
    expect(response.error).toBe("cancelled");

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server ignores cancel event for unknown request ID", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = await connectAndAuth(socketPath, server.authToken);
    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, {
      id: "cancel-1",
      type: "event",
      contentType: "cancel",
      payload: { cancelledId: "nonexistent" },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(messages.length).toBe(0);

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server uses last-registered handler when re-registered", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    let firstCalled = false;
    let secondCalled = false;

    server.registerHandler("re_reg_type", async () => {
      firstCalled = true;
      return { version: 1 };
    });

    server.registerHandler("re_reg_type", async () => {
      secondCalled = true;
      return { version: 2 };
    });

    const client = await connectAndAuth(socketPath, server.authToken);
    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "req-re-reg", type: "request", contentType: "re_reg_type", payload: {} });

    await waitFor(() => messages.length >= 1, 3000);

    expect(firstCalled).toBe(false);
    expect(secondCalled).toBe(true);
    expect(messages[0].payload).toEqual({ version: 2 });

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server wraps handler with withContext when ctx is set", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    let factoryReceived: ((...args: unknown[]) => unknown) | null = null;
    let customOptions: unknown = null;

    const mockCtx = {
      mode: "test",
      ui: {
        custom: async (_factory: (...args: unknown[]) => unknown, options?: unknown) => {
          factoryReceived = _factory;
          customOptions = options;
          return { answer: "test-answer" };
        },
      },
    } as BridgeCtx;
    server.setCtx(mockCtx);

    let handlerCtx: unknown = null;
    server.registerHandler("with_ctx_test", async (input) => {
      handlerCtx = input.ctx;
      const result = await input.ctx.ui.custom(
        (_tui: unknown, _theme: unknown, _kb: unknown, _done: (r: unknown) => void) => {
          return { render: () => [] };
        },
        { someOption: true },
      );
      return result;
    });

    const client = await connectAndAuth(socketPath, server.authToken);
    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, {
      id: "req-with-ctx",
      type: "request",
      contentType: "with_ctx_test",
      payload: {},
      meta: { agentName: "test-agent", lastMessage: "Some context text", sessionFile: "/tmp/test.jsonl" },
    });

    await waitFor(() => messages.length >= 1, 3000);

    expect(handlerCtx).toBe(mockCtx);
    expect(factoryReceived).toBeDefined();
    expect(customOptions).toEqual({ someOption: true });
    expect(messages[0].payload).toEqual({ answer: "test-answer" });

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server skips withContext wrapping when meta has no lastMessage", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    let customFactory: ((...args: unknown[]) => unknown) | null = null;

    const mockCtx = {
      mode: "test",
      ui: {
        custom: async (factory: (...args: unknown[]) => unknown, _options?: unknown) => {
          customFactory = factory;
          return { result: "direct" };
        },
      },
    } as BridgeCtx;
    server.setCtx(mockCtx);

    server.registerHandler("no_ctx_test", async (input) => {
      return input.ctx.ui.custom(() => ({ render: () => [] }), {});
    });

    const client = await connectAndAuth(socketPath, server.authToken);
    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    writeMessage(client, { id: "req-no-ctx", type: "request", contentType: "no_ctx_test", payload: {} });

    await waitFor(() => messages.length >= 1, 3000);

    expect(customFactory).toBeDefined();
    expect(messages[0].payload).toEqual({ result: "direct" });

    client.destroy();
  } finally {
    await server.stop();
  }
});

// ── Message validation edge cases ────────────────────────────────────────────

test("server disconnects client sending message with missing id", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = await connectAndAuth(socketPath, server.authToken);
    const disconnected = new Promise<boolean>((resolve) => {
      client.on("close", () => resolve(true));
    });

    writeMessage(client, { type: "request", contentType: "test", payload: {} } as unknown as Parameters<
      typeof writeMessage
    >[1]);

    const closed = await Promise.race([
      disconnected,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    expect(closed).toBe(true);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server disconnects client sending message with missing contentType", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = await connectAndAuth(socketPath, server.authToken);
    const disconnected = new Promise<boolean>((resolve) => {
      client.on("close", () => resolve(true));
    });

    writeMessage(client, { id: "test-1", type: "request", payload: {} } as unknown as Parameters<
      typeof writeMessage
    >[1]);

    const closed = await Promise.race([
      disconnected,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    expect(closed).toBe(true);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server disconnects client sending message with overly long contentType", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = await connectAndAuth(socketPath, server.authToken);
    const disconnected = new Promise<boolean>((resolve) => {
      client.on("close", () => resolve(true));
    });

    writeMessage(client, { id: "test-1", type: "request", contentType: "x".repeat(257), payload: {} });

    const closed = await Promise.race([
      disconnected,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    expect(closed).toBe(true);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server silently ignores message with unknown type", async () => {
  const { server, socketPath } = await createTestServer();
  try {
    const client = await connectAndAuth(socketPath, server.authToken);

    let gotResponse = false;
    client.on(
      "data",
      createTestReader(() => {
        gotResponse = true;
      }),
    );

    writeMessage(client, { id: "test-1", type: "unknown_type" as "unknown_type", contentType: "test", payload: {} });

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(gotResponse).toBe(false);
    expect(client.destroyed).toBe(false);
    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server respects timeoutMs: 'Infinity' from client (disables handler timeout)", async () => {
  // Server has a short handlerTimeoutMs, but client sends "Infinity" to override it
  const server = new SubagentIpcServer({
    sessionId: "infinity-override-test",
    handlerTimeoutMs: 200, // Would normally fire in 200ms
  });
  await server.start();
  try {
    let handlerCompleted = false;
    server.registerHandler("slow_echo", async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 500)); // Longer than handlerTimeoutMs
      handlerCompleted = true;
      return { ok: true, payload: input.payload };
    });

    const client = await connectAndAuth(server.socketPath ?? "", server.authToken);

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    // Client sends timeoutMs: "Infinity" — server should NOT fire handler timeout
    writeMessage(client, {
      id: "req-infinity",
      type: "request",
      contentType: "slow_echo",
      payload: { test: true },
      timeoutMs: "Infinity",
    });

    await waitFor(() => messages.length >= 1, 3000);

    expect(handlerCompleted).toBe(true);
    expect(messages[0].id).toBe("req-infinity");
    expect(messages[0].type).toBe("response");
    expect(messages[0].error).toBeUndefined();
    expect(messages[0].payload).toEqual({ ok: true, payload: { test: true } });

    client.destroy();
  } finally {
    await server.stop();
  }
});

test("server respects numeric timeoutMs from client (overrides handlerTimeoutMs)", async () => {
  // Server has a long handlerTimeoutMs, but client sends a short timeoutMs to override
  const server = new SubagentIpcServer({
    sessionId: "numeric-override-test",
    handlerTimeoutMs: 10_000, // Would normally wait 10s
  });
  await server.start();
  try {
    server.registerHandler("slow_hang", async () => {
      await new Promise(() => {}); // Never resolves
    });

    const client = await connectAndAuth(server.socketPath ?? "", server.authToken);

    const messages: IpcMessage[] = [];
    client.on(
      "data",
      createTestReader((msg) => messages.push(msg as IpcMessage)),
    );

    // Client sends timeoutMs: 200 — server should timeout after 200ms, not 10s
    writeMessage(client, {
      id: "req-short",
      type: "request",
      contentType: "slow_hang",
      payload: {},
      timeoutMs: 200,
    });

    await waitFor(() => messages.length >= 1, 3000);

    expect(messages[0].id).toBe("req-short");
    expect(messages[0].type).toBe("response");
    expect(messages[0].error).toBe("handler timed out");

    client.destroy();
  } finally {
    await server.stop();
  }
});
