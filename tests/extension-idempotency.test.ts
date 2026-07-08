// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";

const WIRED_KEY = "__avtcPiSubagentUiBridgeWired";
type GlobalWithWired = typeof globalThis & { [WIRED_KEY]?: boolean };

/**
 * Mock ExtensionAPI that captures event registrations
 * so tests can manually fire them. Mirrors the mock shape used in extension.test.ts;
 * this extension uses client/server/socket paths plus pi.on and pi.events.emit.
 */
function createMockPi() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void | Promise<void>>>();
  const emitted: { event: string; data: unknown }[] = [];

  return {
    on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
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
    async fire(event: string, ...args: unknown[]) {
      const handlerList = handlers.get(event) ?? [];
      for (const handler of handlerList) await handler(...args);
    },
    get emitted() {
      return emitted;
    },
    hasHandler(event: string): boolean {
      return (handlers.get(event) ?? []).length > 0;
    },
  };
}

beforeEach(async () => {
  delete (globalThis as GlobalWithWired)[WIRED_KEY];
  const { _resetState } = await import("../src/extension.js");
  _resetState();
});

afterEach(async () => {
  delete (globalThis as GlobalWithWired)[WIRED_KEY];
  const { _resetState } = await import("../src/extension.js");
  _resetState();
});

test("idempotency: first call wires without throwing", async () => {
  const { default: extension } = await import("../src/extension.js");

  const pi = createMockPi();
  // First call must not throw — should register session_start/session_shutdown handlers.
  expect(() => extension(pi as unknown as ExtensionAPI)).not.toThrow();

  expect(pi.hasHandler("session_start")).toBe(true);
  expect(pi.hasHandler("session_shutdown")).toBe(true);
});

test("idempotency: second call no-ops without throwing", async () => {
  const { default: extension } = await import("../src/extension.js");

  const pi1 = createMockPi();
  extension(pi1 as unknown as ExtensionAPI);
  expect(pi1.hasHandler("session_start")).toBe(true);

  // Second call — a different pi instance (simulating a second bundled copy).
  // Must not throw and must NOT register any handlers on pi2 (it no-ops).
  const pi2 = createMockPi();
  expect(() => extension(pi2 as unknown as ExtensionAPI)).not.toThrow();
  expect(pi2.hasHandler("session_start")).toBe(false);
  expect(pi2.hasHandler("session_shutdown")).toBe(false);
});

test("idempotency: first call sets the globalThis wired flag", async () => {
  const { default: extension } = await import("../src/extension.js");

  expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBeUndefined();

  const pi = createMockPi();
  extension(pi as unknown as ExtensionAPI);

  expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);
});

test("idempotency: reload-safe — flag resets on session_shutdown so extension re-wires", async () => {
  const { default: extension } = await import("../src/extension.js");

  // First load — wires the extension.
  const pi1 = createMockPi();
  extension(pi1 as unknown as ExtensionAPI);
  expect(pi1.hasHandler("session_start")).toBe(true);
  expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);

  // Second load without a shutdown — no-ops (guard still set).
  const pi2 = createMockPi();
  extension(pi2 as unknown as ExtensionAPI);
  expect(pi2.hasHandler("session_start")).toBe(false);
  expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);

  // Shutdown fires before pi re-loads the module on /reload — it must reset the flag.
  await pi1.fire("session_shutdown");
  expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(false);

  // Third load (post-reload) — must re-wire because the flag cycled back to false.
  const pi3 = createMockPi();
  extension(pi3 as unknown as ExtensionAPI);
  expect(pi3.hasHandler("session_start")).toBe(true);
  expect(pi3.hasHandler("session_shutdown")).toBe(true);
  expect((globalThis as GlobalWithWired)[WIRED_KEY]).toBe(true);
});
