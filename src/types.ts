// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/** Metadata automatically attached by the IPC client to every request. */
export interface MessageMeta {
  agentName?: string;
  lastMessage?: string;
  sessionFile?: string;
}

/**
 * Minimal structural theme shape used by the UI-bridge (avoids a cross-package
 * import of pi-tui's full Theme, which can cause dual-package type mismatches
 * when each repo resolves its own SDK copy).
 */
export interface BridgeTheme {
  fg: (scope: string, text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
}

/**
 * Minimal structural ctx shape used by the UI-bridge (avoids a cross-package
 * import of ExtensionContext).
 */
export interface BridgeCtx {
  mode: string;
  ui: {
    custom: <U>(
      factory: (tui: unknown, theme: unknown, kb: unknown, done: (result: U) => void) => unknown,
      options?: unknown,
    ) => Promise<U>;
  };
}

/**
 * Minimal session-context shape the bridge setup needs (avoids a cross-package
 * import of ExtensionContext). The real ctx also exposes ui.custom, so it satisfies
 * both BridgeCtx and BridgeSessionCtx.
 */
export interface BridgeSessionCtx extends BridgeCtx {
  hasUI?: boolean;
  sessionManager: {
    getSessionId(): string;
    getSessionFile?(): string | undefined;
  };
}

/** Wire message envelope. */
export interface IpcMessage {
  id: string;
  type: "request" | "response" | "event";
  contentType: string;
  payload: unknown;
  meta?: MessageMeta;
  error?: string;
  /** Client timeout override. Serialized as "Infinity" string when Number.POSITIVE_INFINITY (JSON has no Infinity). */
  timeoutMs?: number | "Infinity";
}

/** Maximum allowed message size (10 MB). */
export const MAX_MESSAGE_SIZE = 10 * 1024 * 1024;

/** Handler function registered by consumer extensions. */
export type TypedHandler = (input: {
  ctx: BridgeCtx;
  clientId: string;
  contentType: string;
  payload: unknown;
  meta: MessageMeta;
}) => Promise<unknown | undefined>;

/** Options for the client's sendAndWait() method. */
export interface SendAndWaitOptions {
  contentType: string;
  payload: Record<string, unknown>;
  /** Human-readable summary for logging/debugging. */
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** API shape emitted via pi-subagent-ui-bridge:ready event. */
export interface UiBridgeApi {
  registerHandler: ((contentType: string, handler: TypedHandler) => void) | undefined;
  sendAndWait: ((options: SendAndWaitOptions) => Promise<{ payload: unknown }>) | undefined;
}
