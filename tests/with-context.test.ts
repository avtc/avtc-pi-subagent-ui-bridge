// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { expect, test } from "vitest";
import type { BridgeCtx, MessageMeta } from "../src/types.js";
import { withContext } from "../src/with-context.js";

const EMPTY_DONE_REF: { current?: (result: unknown) => void } = {};

test("withContext monkey-patches ctx.ui.custom and restores it after", async () => {
  const originalCustom = async () => "original";
  const ctx = {
    ui: {
      custom: originalCustom,
    },
  };

  const meta: MessageMeta = { agentName: "test", lastMessage: "hello" };

  await withContext(
    ctx as unknown as BridgeCtx,
    meta,
    async (ctx) => {
      // Inside, ctx.ui.custom should be wrapped
      expect(ctx.ui.custom).not.toBe(originalCustom);
      return "result";
    },
    EMPTY_DONE_REF,
  );

  // After, ctx.ui.custom should be restored
  expect(ctx.ui.custom).toBe(originalCustom);
});

test("withContext restores ctx.ui.custom even if handler throws", async () => {
  const originalCustom = async () => "original";
  const ctx = {
    ui: {
      custom: originalCustom,
    },
  };

  const meta: MessageMeta = { agentName: "test", lastMessage: "hello" };

  await expect(
    withContext(
      ctx as unknown as BridgeCtx,
      meta,
      async () => {
        throw new Error("handler error");
      },
      EMPTY_DONE_REF,
    ),
  ).rejects.toThrow("handler error");

  expect(ctx.ui.custom).toBe(originalCustom);
});

test("withContext skips wrapping when meta.lastMessage is empty", async () => {
  const originalCustom = async () => "original";
  const ctx = {
    ui: {
      custom: originalCustom,
    },
  };

  const meta: MessageMeta = { agentName: "test", lastMessage: "" };

  let called = false;
  await withContext(
    ctx as unknown as BridgeCtx,
    meta,
    async (ctx) => {
      called = true;
      expect(ctx.ui.custom).toBe(originalCustom);
    },
    EMPTY_DONE_REF,
  );

  expect(called).toBe(true);
  expect(ctx.ui.custom).toBe(originalCustom);
});

test("withContext wrapper creates ContextWrapperComponent with correct meta", async () => {
  let capturedWrapper: unknown = null;

  const originalCustom = async <U>(
    factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: U) => void) => unknown,
    _options?: unknown,
  ): Promise<U> => {
    const mockTui = { terminal: { rows: 24, columns: 80 } };
    const mockTheme = {
      fg: (s: string) => s,
      bold: (s: string) => s,
      italic: (s: string) => s,
      underline: (s: string) => s,
      strikethrough: (s: string) => s,
    };
    const mockDone = (_result: U) => {};
    const mockKb = {};
    capturedWrapper = factory(mockTui, mockTheme, mockKb, mockDone);
    return undefined as unknown as U;
  };

  const ctx = { ui: { custom: originalCustom } };
  const meta: MessageMeta = { agentName: "my-agent", lastMessage: "Hello world" };

  await withContext(
    ctx as unknown as BridgeCtx,
    meta,
    async (ctx) => {
      await ctx.ui.custom((_tui: unknown, _theme: unknown, _kb: unknown, _done: (r: string) => void) => {
        return { render: () => [], handleInput: () => false };
      });
    },
    EMPTY_DONE_REF,
  );

  expect(capturedWrapper).toBeDefined();
  expect((capturedWrapper as { constructor: { name: string } }).constructor.name).toBe("ContextWrapperComponent");
});

test("withContext skips wrapping when meta is null", async () => {
  const originalCustom = async () => "original";
  const ctx = {
    ui: {
      custom: originalCustom,
    },
  };

  let called = false;
  await withContext(
    ctx as unknown as BridgeCtx,
    null,
    async (ctx) => {
      called = true;
      expect(ctx.ui.custom).toBe(originalCustom);
    },
    EMPTY_DONE_REF,
  );

  expect(called).toBe(true);
  expect(ctx.ui.custom).toBe(originalCustom);
});

test("withContext captures done callback in doneRef", async () => {
  let capturedDone: ((result: string) => void) | undefined;
  const mockTheme = {
    fg: (_color: string, text: string) => text,
    bold: (s: string) => s,
    italic: (s: string) => s,
    underline: (s: string) => s,
    strikethrough: (s: string) => s,
  };
  const originalCustom = async <U>(
    factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: U) => void) => unknown,
    _options?: unknown,
  ): Promise<U> => {
    const mockDone = (_result: U) => {};
    const mockTui = { terminal: { rows: 24, columns: 80 } };
    factory(mockTui, mockTheme, {}, mockDone);
    return undefined as unknown as U;
  };

  const ctx = { ui: { custom: originalCustom } };
  const meta: MessageMeta = { agentName: "test", lastMessage: "hello" };
  const doneRef: { current?: (result: unknown) => void } = {};

  await withContext(
    ctx as unknown as BridgeCtx,
    meta,
    async (ctx) => {
      await ctx.ui.custom((_tui: unknown, _theme: unknown, _kb: unknown, done: (r: string) => void) => {
        capturedDone = done;
        return { render: () => [] };
      });

      expect(typeof doneRef.current).toBe("function");
      expect(doneRef.current).toBe(capturedDone);
    },
    doneRef,
  );

  expect(doneRef.current).toBeUndefined();
});

test("withContext does not populate doneRef when no context wrapping", async () => {
  const originalCustom = async () => "original";
  const ctx = { ui: { custom: originalCustom } };
  const meta: MessageMeta = { agentName: "test", lastMessage: "" };
  const doneRef: { current?: (result: unknown) => void } = {};

  await withContext(ctx as unknown as BridgeCtx, meta, async () => {}, doneRef);

  expect(doneRef.current).toBeUndefined();
});
