// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import { createMessageReader, writeMessage } from "./framing.js";
import type { IpcMessage, MessageMeta, SendAndWaitOptions } from "./types.js";

/** Sentinel: no message meta provided */
export const NO_MESSAGE_META: MessageMeta | undefined = undefined;

interface PendingRequest {
  resolve: (response: { payload: unknown }) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  abortHandler?: () => void;
}

export interface ClientOptions {
  socketPath: string;
  authToken: string;
}

/**
 * IPC client connecting to the parent's SubagentIpcServer.
 * Provides sendAndWait() for child processes to send requests and await responses.
 */
export class SubagentIpcClient {
  private socket: Socket | null = null;
  private sendAndWaitQueue: Promise<void> = Promise.resolve();
  /** Queue rejectors — rejected on disconnect so queued callers don't hang forever. */
  private queueRejects: Array<(error: Error) => void> = [];
  private pending = new Map<string, PendingRequest>();
  private socketPath: string;
  private authToken: string;
  private disconnected = false;
  /** Tracks whether the server has accepted our auth. If the socket closes
   *  before auth is confirmed, we report an auth-specific error. */
  private authConfirmed = false;
  /** Resolves when auth_ack is received from the server. */
  private authResolve: (() => void) | null = null;
  /** Rejects if the socket closes before auth_ack. */
  private authReject: ((error: Error) => void) | null = null;

  constructor(options: ClientOptions) {
    this.socketPath = options.socketPath;
    this.authToken = options.authToken;
  }

  /**
   * Connect to the server socket.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      this.socket = socket;

      const reader = createMessageReader(
        (msg) => this.handleMessage(msg as IpcMessage),
        (error) => {
          this.failPending(new Error(`Protocol error: ${error.message}`));
          // Protocol error is fatal — disconnect to prevent zombie state
          this.disconnect();
        },
      );

      socket.on("data", reader);
      socket.on("error", (err) => {
        if (!this.disconnected) {
          reject(err);
        }
      });
      socket.on("close", () => {
        const msg = this.authConfirmed
          ? "Disconnected from server"
          : "Authentication failed — server closed connection. " +
            "Check PI_SUBAGENT_UI_BRIDGE_ROOT_SOCKET and PI_SUBAGENT_UI_BRIDGE_AUTH_TOKEN env vars.";
        const error = new Error(msg);
        // If auth hasn't been confirmed yet, reject the connect() promise
        if (!this.authConfirmed && this.authReject) {
          this.authReject(error);
          this.authResolve = null;
          this.authReject = null;
        }
        this.failPending(error);
      });
      socket.on("connect", () => {
        socket.removeListener("error", reject);
        // Send auth message as first message
        writeMessage(socket, {
          id: randomUUID(),
          type: "event",
          contentType: "auth",
          payload: { token: this.authToken },
        });
        // Wait for server's auth_ack event before resolving connect()
        new Promise<void>((res, rej) => {
          this.authResolve = res;
          this.authReject = rej;
        })
          .then(() => {
            resolve();
          })
          .catch((err) => {
            reject(err);
          });
      });
    });
  }

  /**
   * Disconnect from the server. Rejects all pending requests.
   */
  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.authConfirmed = false;
    if (this.authReject) {
      this.authReject(new Error("Client disconnected"));
      this.authResolve = null;
      this.authReject = null;
    }
    this.failPending(new Error("Client disconnected"));
    // Reject all queued callers so they don't hang forever
    for (const reject of this.queueRejects) {
      reject(new Error("Client disconnected"));
    }
    this.queueRejects = [];
    // Reset queue so new connections can accept requests
    this.sendAndWaitQueue = Promise.resolve();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Send a request and wait for the response.
   * Uses a promise-chain queue to serialize concurrent calls
   * so only one request is in-flight at a time — prevents overlapping TUI dialogs.
   */
  async sendAndWait(options: SendAndWaitOptions, meta: MessageMeta | undefined): Promise<{ payload: unknown }> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Not connected");
    }

    // Queue behind any in-progress sendAndWait call.
    // Concurrent callers wait for their turn, then execute sequentially.
    let queueResolve: (() => void) | undefined;
    let queueReject: ((error: Error) => void) | undefined;
    const queuePromise = new Promise<void>((res, rej) => {
      queueResolve = res;
      queueReject = rej;
    });
    const rejectFn = queueReject as (error: Error) => void;
    const previousQueue = this.sendAndWaitQueue;
    this.sendAndWaitQueue = queuePromise;
    this.queueRejects.push(rejectFn);

    try {
      await previousQueue;
    } finally {
      // Remove our rejector — if we got here, previousQueue resolved normally
      const idx = this.queueRejects.indexOf(rejectFn);
      if (idx >= 0) this.queueRejects.splice(idx, 1);
    }

    if (this.disconnected) {
      throw new Error("Client disconnected");
    }

    try {
      return this.sendAndWaitInner(options, meta);
    } finally {
      queueResolve?.();
    }
  }

  private sendAndWaitInner(options: SendAndWaitOptions, meta: MessageMeta | undefined): Promise<{ payload: unknown }> {
    const id = randomUUID();
    // Serialize Infinity as "Infinity" string — JSON has no Infinity representation
    const wireTimeout =
      options.timeoutMs !== undefined && !Number.isFinite(options.timeoutMs) ? "Infinity" : options.timeoutMs;
    const message: IpcMessage = {
      id,
      type: "request",
      contentType: options.contentType,
      payload: options.payload,
      meta,
      timeoutMs: wireTimeout,
    };

    return new Promise((resolve, reject) => {
      // Timeout — skip setTimeout when timeoutMs is Infinity (setTimeout clamps to 32-bit max)
      const timeoutMs = options.timeoutMs ?? 300_000; // 5 min default
      const timeout = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`sendAndWait timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      // Abort signal
      let abortHandler: (() => void) | undefined;
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timeout ?? undefined);
          reject(new AbortError("Aborted"));
          return;
        }
        abortHandler = () => {
          clearTimeout(timeout ?? undefined);
          this.pending.delete(id);
          // Send cancel event
          if (this.socket && !this.socket.destroyed) {
            writeMessage(this.socket, {
              id: randomUUID(),
              type: "event",
              contentType: "cancel",
              payload: { cancelledId: id },
            });
          }
          reject(new AbortError("Aborted"));
        };
        options.signal.addEventListener("abort", abortHandler);
      }

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timeout ?? undefined);
          if (abortHandler && options.signal) {
            options.signal.removeEventListener("abort", abortHandler);
          }
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout ?? undefined);
          if (abortHandler && options.signal) {
            options.signal.removeEventListener("abort", abortHandler);
          }
          reject(error);
        },
        timeout,
        abortHandler,
      });

      if (!this.socket) {
        reject(new Error("Client has no active socket"));
        return;
      }
      writeMessage(this.socket, message);
    });
  }

  private handleMessage(message: IpcMessage): void {
    // Handle auth acknowledgement from server
    if (message.type === "event" && message.contentType === "auth_ack") {
      this.authConfirmed = true;
      if (this.authResolve) {
        this.authResolve();
        this.authResolve = null;
        this.authReject = null;
      }
      return;
    }

    if (message.type !== "response") {
      // Log unexpected message types for debugging (e.g. stale event from server)
      if (message.type !== "event") {
        console.warn(
          `[pi-subagent-ui-bridge] Unexpected message type from server: ${message.type} (${message.contentType})`,
        );
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;

    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve({ payload: message.payload });
    }
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout ?? undefined);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Minimal AbortError for when AbortSignal triggers.
 */
export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}
