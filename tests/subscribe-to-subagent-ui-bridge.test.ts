// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// tests/subscribe-to-subagent-ui-bridge.test.ts

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RootHandler } from "../src/snippets/canonical/subscribe-to-subagent-ui-bridge.js";
import {
  _resetUiBridgeState,
  forwardToRoot,
  isSubagentBridgeAvailable,
  subscribeToUiBridge,
} from "../src/snippets/canonical/subscribe-to-subagent-ui-bridge.js";

describe("subscribe-to-subagent-ui-bridge canonical template", () => {
  beforeEach(() => {
    _resetUiBridgeState();
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  });

  afterEach(() => {
    _resetUiBridgeState();
    delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
  });

  test("subscribeToUiBridge registers handler on pi-subagent-ui-bridge:ready event", () => {
    const registerHandler = vi.fn();
    const rootHandler: RootHandler = vi.fn();

    const fakePi = {
      on: vi.fn(() => () => {}),
      events: {
        on: vi.fn((_event: string, handler: (data: unknown) => void) => {
          handler({ registerHandler, sendAndWait: vi.fn() });
          return () => {};
        }),
      },
    } as unknown as ExtensionAPI;

    subscribeToUiBridge(fakePi, "test_content", rootHandler);
    expect(registerHandler).toHaveBeenCalledWith("test_content", rootHandler);
  });

  test("graceful no-op when pi.events is undefined", () => {
    const rootHandler: RootHandler = vi.fn();
    expect(() => subscribeToUiBridge({ on: vi.fn() } as unknown as ExtensionAPI, "test", rootHandler)).not.toThrow();
  });

  test("isSubagentBridgeAvailable returns false without env var", () => {
    expect(isSubagentBridgeAvailable()).toBe(false);
  });

  test("forwardToRoot returns null when not in subagent context", async () => {
    const result = await forwardToRoot({ contentType: "test", payload: {}, text: "test" });
    expect(result).toBeNull();
  });

  test("forwardToRoot returns null when sendAndWait not captured", async () => {
    process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "/tmp/test.sock";
    try {
      const result = await forwardToRoot({ contentType: "test", payload: {}, text: "test" });
      expect(result).toBeNull();
    } finally {
      delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
    }
  });

  test("session_shutdown cleans up listeners and resets state", async () => {
    let shutdownHandler: (() => void) | undefined;
    const unsubEvents = vi.fn();

    const fakePi = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "session_shutdown") shutdownHandler = handler;
        return () => {};
      }),
      events: {
        on: vi.fn(() => unsubEvents),
      },
    } as unknown as ExtensionAPI;

    subscribeToUiBridge(fakePi, "test", vi.fn());
    expect(shutdownHandler).toBeDefined();

    shutdownHandler?.();

    // After shutdown, forwarding should be unavailable
    process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET = "/tmp/test.sock";
    try {
      const result = await forwardToRoot({ contentType: "test", payload: {}, text: "test" });
      expect(result).toBeNull();
    } finally {
      delete process.env.PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET;
    }
  });

  test("gracefully handles malformed API object on bridge ready", () => {
    const rootHandler: RootHandler = vi.fn();

    const fakePi = {
      on: vi.fn(() => () => {}),
      events: {
        on: vi.fn((_event: string, handler: (data: unknown) => void) => {
          handler({});
          return () => {};
        }),
      },
    } as unknown as ExtensionAPI;

    expect(() => subscribeToUiBridge(fakePi, "test_content", rootHandler)).not.toThrow();
  });

  test("gracefully handles non-function registerHandler on bridge ready", () => {
    const rootHandler: RootHandler = vi.fn();

    const fakePi = {
      on: vi.fn(() => () => {}),
      events: {
        on: vi.fn((_event: string, handler: (data: unknown) => void) => {
          handler({ registerHandler: "not-a-function", sendAndWait: vi.fn() });
          return () => {};
        }),
      },
    } as unknown as ExtensionAPI;

    expect(() => subscribeToUiBridge(fakePi, "test_content", rootHandler)).not.toThrow();
  });

  test("idempotent re-registration (reload path)", () => {
    const rootHandler: RootHandler = vi.fn();

    const fakePi1 = {
      on: vi.fn(() => () => {}),
      events: { on: vi.fn(() => vi.fn()) },
    } as unknown as ExtensionAPI;

    subscribeToUiBridge(fakePi1, "test_content", rootHandler);

    const fakePi2 = {
      on: vi.fn(() => () => {}),
      events: { on: vi.fn(() => vi.fn()) },
    } as unknown as ExtensionAPI;

    // Should not throw — each registration manages its own lifecycle via session_shutdown
    expect(() => subscribeToUiBridge(fakePi2, "test_content", rootHandler)).not.toThrow();
  });
});
