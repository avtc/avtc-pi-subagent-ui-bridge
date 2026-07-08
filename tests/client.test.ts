// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { expect, test } from "vitest";
import { SubagentIpcClient } from "../src/client.js";
import { SubagentIpcServer } from "../src/server.js";

const TEST_SESSION_ID = "client-test-session";

test("client connects and sendAndWait receives response", async () => {
  const server = new SubagentIpcServer({ sessionId: TEST_SESSION_ID });
  await server.start();

  server.registerHandler("echo", async (input) => {
    return { echoed: input.payload };
  });

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();

    const result = await client.sendAndWait(
      {
        contentType: "echo",
        payload: { message: "hello" },
        text: "test echo",
      },
      undefined,
    );

    expect(result.payload).toEqual({ echoed: { message: "hello" } });

    await client.disconnect();
  } finally {
    await server.stop();
  }
});

test("client sendAndWait rejects on handler error", async () => {
  const server = new SubagentIpcServer({
    sessionId: `${TEST_SESSION_ID}-err`,
  });
  await server.start();

  server.registerHandler("fail", async () => {
    throw new Error("boom");
  });

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();

    await expect(
      client.sendAndWait(
        {
          contentType: "fail",
          payload: {},
          text: "test fail",
        },
        undefined,
      ),
    ).rejects.toThrow("Internal handler error");

    await client.disconnect();
  } finally {
    await server.stop();
  }
});

test("client sendAndWait respects timeoutMs", async () => {
  const server = new SubagentIpcServer({
    sessionId: `${TEST_SESSION_ID}-timeout`,
  });
  await server.start();

  server.registerHandler("slow", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return "never";
  });

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();

    await expect(
      client.sendAndWait(
        {
          contentType: "slow",
          payload: {},
          text: "test timeout",
          timeoutMs: 200,
        },
        undefined,
      ),
    ).rejects.toThrow(/timed out/i);

    await client.disconnect();
  } finally {
    await server.stop();
  }
});

test("client disconnect rejects pending sendAndWait", async () => {
  const server = new SubagentIpcServer({
    sessionId: `${TEST_SESSION_ID}-disc`,
  });
  await server.start();

  server.registerHandler("hang", async () => {
    await new Promise(() => {}); // Never resolves
  });

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();

    const promise = client.sendAndWait(
      {
        contentType: "hang",
        payload: {},
        text: "test disconnect",
      },
      undefined,
    );

    // Disconnect while pending
    setTimeout(() => client.disconnect(), 100);

    await expect(promise).rejects.toThrow(/disconnect/i);
  } finally {
    await server.stop();
  }
});

test("client sendAndWait throws when not connected", async () => {
  const client = new SubagentIpcClient({
    socketPath: "/nonexistent",
    authToken: "fake",
  });

  await expect(
    client.sendAndWait(
      {
        contentType: "test",
        payload: {},
        text: "test",
      },
      undefined,
    ),
  ).rejects.toThrow("Not connected");
});

test("client sendAndWait throws after disconnect", async () => {
  const server = new SubagentIpcServer({ sessionId: `${TEST_SESSION_ID}-post-disc` });
  await server.start();

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();
    await client.disconnect();

    await expect(
      client.sendAndWait(
        {
          contentType: "test",
          payload: {},
          text: "test",
        },
        undefined,
      ),
    ).rejects.toThrow("Not connected");
  } finally {
    await server.stop();
  }
});

test("client sendAndWait rejects immediately with pre-aborted AbortSignal", async () => {
  const server = new SubagentIpcServer({ sessionId: `${TEST_SESSION_ID}-pre-abort` });
  await server.start();

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();

    const controller = new AbortController();
    controller.abort(); // Pre-abort before calling sendAndWait

    await expect(
      client.sendAndWait(
        {
          contentType: "test",
          payload: {},
          text: "test",
          signal: controller.signal,
        },
        undefined,
      ),
    ).rejects.toThrow();

    await client.disconnect();
  } finally {
    await server.stop();
  }
});

test("client connect rejects with wrong auth token", async () => {
  const server = new SubagentIpcServer({ sessionId: `${TEST_SESSION_ID}-bad-auth` });
  await server.start();

  try {
    const client = new SubagentIpcClient({
      socketPath: server.socketPath ?? "",
      authToken: "wrong-token-value",
    });

    await expect(client.connect()).rejects.toThrow(/authentication failed/i);
  } finally {
    await server.stop();
  }
});

test("client connect rejects when socket does not exist", async () => {
  const client = new SubagentIpcClient({
    socketPath: "/tmp/nonexistent-pi-subagent-ipc-socket-12345",
    authToken: "any-token",
  });

  await expect(client.connect()).rejects.toThrow();
});

test("client sendAndWait respects AbortSignal", async () => {
  const server = new SubagentIpcServer({
    sessionId: `${TEST_SESSION_ID}-abort`,
  });
  await server.start();

  server.registerHandler("hang", async () => {
    await new Promise(() => {}); // Never resolves
  });

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();

    const controller = new AbortController();
    const promise = client.sendAndWait(
      {
        contentType: "hang",
        payload: {},
        text: "test abort",
        signal: controller.signal,
      },
      undefined,
    );

    setTimeout(() => controller.abort(), 100);

    await expect(promise).rejects.toThrow();

    await client.disconnect();
  } finally {
    await server.stop();
  }
});

test("client times out when server stops sending data", async () => {
  const server = new SubagentIpcServer({ sessionId: `${TEST_SESSION_ID}-idle` });
  await server.start();

  // Register a handler that never responds — simulates server going silent
  server.registerHandler("hang", async () => {
    await new Promise(() => {}); // Never resolves
  });

  try {
    const client = new SubagentIpcClient({
      socketPath: server.socketPath ?? "",
      authToken: server.authToken,
    });
    await client.connect();

    // sendAndWait will timeout due to per-request timeout — the server accepted
    // the request but never sends any data back, so the request timer fires
    await expect(
      client.sendAndWait(
        {
          contentType: "hang",
          payload: {},
          text: "test idle",
          timeoutMs: 200, // Short timeout for testing
        },
        undefined,
      ),
    ).rejects.toThrow(/timed out/);
  } finally {
    await server.stop();
  }
});

test("concurrent sendAndWait calls from same client each get correct response", async () => {
  const server = new SubagentIpcServer({ sessionId: `${TEST_SESSION_ID}-concurrent` });
  await server.start();

  // Handler that echoes payload with a small delay to ensure concurrency
  server.registerHandler("echo", async (input) => {
    await new Promise((r) => setTimeout(r, 50));
    return { echoed: input.payload };
  });

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();

    // Fire 3 concurrent sendAndWait calls
    const results = await Promise.all([
      client.sendAndWait({ contentType: "echo", payload: { n: 1 }, text: "first" }, undefined),
      client.sendAndWait({ contentType: "echo", payload: { n: 2 }, text: "second" }, undefined),
      client.sendAndWait({ contentType: "echo", payload: { n: 3 }, text: "third" }, undefined),
    ]);

    // Each response must match its request
    expect(results[0].payload).toEqual({ echoed: { n: 1 } });
    expect(results[1].payload).toEqual({ echoed: { n: 2 } });
    expect(results[2].payload).toEqual({ echoed: { n: 3 } });

    await client.disconnect();
  } finally {
    await server.stop();
  }
});

test("client sendAndWait with Infinity timeout completes without server-side handler timeout", async () => {
  // Server has a short handlerTimeoutMs, but client passes Infinity to disable it.
  // The Infinity must survive JSON serialization as "Infinity" string.
  const server = new SubagentIpcServer({
    sessionId: `${TEST_SESSION_ID}-infinity`,
    handlerTimeoutMs: 200, // Would normally fire in 200ms
  });
  await server.start();

  server.registerHandler("slow_echo", async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 500)); // Longer than handlerTimeoutMs
    return { echoed: input.payload };
  });

  try {
    const client = new SubagentIpcClient({ socketPath: server.socketPath ?? "", authToken: server.authToken });
    await client.connect();

    const result = await client.sendAndWait(
      {
        contentType: "slow_echo",
        payload: { message: "infinity test" },
        text: "test infinity timeout",
        timeoutMs: Infinity,
      },
      undefined,
    );

    expect(result.payload).toEqual({ echoed: { message: "infinity test" } });

    await client.disconnect();
  } finally {
    await server.stop();
  }
});
