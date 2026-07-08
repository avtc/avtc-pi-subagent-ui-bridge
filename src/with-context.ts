// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Component } from "@earendil-works/pi-tui";
import { ContextWrapperComponent, NO_MARKDOWN_RENDER_OVERRIDE } from "./context-wrapper.js";
import type { BridgeCtx, BridgeTheme, MessageMeta } from "./types.js";

/**
 * Ref object that captures the `done` callback from ctx.ui.custom().
 * Used by the server to dismiss hung dialogs on handler timeout.
 */
export interface DoneRef<U = unknown> {
  current?: (result: U) => void;
}

/**
 * Wrap ctx.ui.custom() so the handler's dialog gets a context section above it.
 *
 * - Temporarily monkey-patches ctx.ui.custom to inject ContextWrapperComponent
 * - Restores the original after the handler completes (even on error)
 * - Skips wrapping entirely if meta is null or lastMessage is empty
 * - Optionally captures the `done` callback via doneRef for external dismissal
 *
 * Precondition: only one withContext wrapper active at a time
 * (guaranteed by server's single-request-at-a-time queue).
 *
 * Consumer extensions don't call this — the IPC server applies it before invoking handlers.
 */
export async function withContext<T>(
  ctx: BridgeCtx,
  meta: MessageMeta | null,
  fn: (ctx: BridgeCtx) => Promise<T>,
  doneRef: DoneRef,
): Promise<T> {
  // No context → pass through without wrapping
  if (!meta?.lastMessage?.trim()) {
    return fn(ctx);
  }

  const originalCustom = ctx.ui.custom;

  ctx.ui.custom = <U>(
    factory: (tui: unknown, theme: BridgeTheme, kb: unknown, done: (result: U) => void) => unknown,
    options?: unknown,
  ): Promise<U> => {
    return originalCustom<U>((tui: unknown, theme: unknown, kb: unknown, done: (result: U) => void) => {
      // Capture done callback for external dismissal (e.g., handler timeout)
      if (doneRef) {
        doneRef.current = done as (result: unknown) => void;
      }
      const innerComponent = factory(tui, theme as BridgeTheme, kb, done);
      return new ContextWrapperComponent(
        meta,
        innerComponent as Component,
        theme as BridgeTheme,
        NO_MARKDOWN_RENDER_OVERRIDE,
      );
    }, options);
  };

  try {
    return await fn(ctx);
  } finally {
    ctx.ui.custom = originalCustom;
    if (doneRef) {
      doneRef.current = undefined;
    }
  }
}
