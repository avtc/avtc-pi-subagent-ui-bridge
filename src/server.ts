// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import net, { type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createMessageReader, writeMessage } from "./framing.js";
import { DEFAULT_PLATFORM, getSocketPath } from "./socket-path.js";
import type { BridgeCtx, IpcMessage, MessageMeta, TypedHandler } from "./types.js";
import { type DoneRef, withContext } from "./with-context.js";

interface PendingRequest {
  clientId: string;
  message: IpcMessage;
  resolve: (response: IpcMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout> | null;
  doneRef: DoneRef;
  cancelled?: boolean;
  /** Reject the in-flight handler to unblock the while loop. */
  cancelHandler?: (error: Error) => void;
}

/** Dismissed-dialog result: delivered to the done callback to signal cancellation (no value). */
const DISMISSED: unknown = null;

/** Best-effort dismiss an active dialog via its doneRef. */
function dismissDialog(doneRef: DoneRef): void {
  if (doneRef.current) {
    try {
      doneRef.current(DISMISSED);
    } catch {
      // Best-effort dismissal
    }
  }
}

/** Authentication states for a connected client. */
type ClientAuthState = "pending" | "authenticated";

interface ClientInfo {
  socket: Socket;
  authState: ClientAuthState;
}

export interface ServerOptions {
  sessionId: string;
  handlerTimeoutMs?: number; // default: 5 minutes (300_000 ms); set to 0 to disable
}

/**
 * IPC server running in the root UI session.
 * Listens on a named pipe (Windows) or Unix socket (*nix).
 * Dispatches incoming requests to registered handlers.
 * Processes one request at a time — concurrent requests are queued.
 *
 * Security: clients must authenticate by sending an auth event with
 * the correct token as their first message. Connections that send
 * any other message before auth are rejected.
 */
export class SubagentIpcServer {
  private server: Server | null = null;
  private clients = new Map<string, ClientInfo>();
  private handlers = new Map<string, TypedHandler>();
  private requestQueue: PendingRequest[] = [];
  private processing = false;
  private readonly handlerTimeoutMs: number;
  private readonly sessionId: string;
  private _socketPath: string | null = null;
  private _authToken: string;
  private ctx: BridgeCtx | null = null;

  constructor(options: ServerOptions) {
    this.sessionId = options.sessionId;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 300_000;
    this._authToken = randomUUID();
  }

  /** Socket path the server is listening on (null if not started or start failed). */
  get socketPath(): string | null {
    return this._socketPath;
  }

  /** Auth token clients must present to authenticate. */
  get authToken(): string {
    return this._authToken;
  }

  /**
   * Start listening. Resolves when the server is ready.
   * If socket creation fails, logs a warning and resolves anyway (graceful degradation).
   */
  async start(): Promise<void> {
    const socketPath = getSocketPath(DEFAULT_PLATFORM, homedir(), this.sessionId);

    try {
      // Ensure directory exists on *nix with restrictive permissions
      if (process.platform !== "win32") {
        mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
      }

      this.server = net.createServer((socket) => this.handleConnection(socket));
      this._socketPath = socketPath;

      await new Promise<void>((resolve, reject) => {
        const server = this.server;
        if (!server) {
          reject(new Error("server not created"));
          return;
        }
        server.on("error", reject);
        server.listen(socketPath, () => {
          server.removeListener("error", reject);
          // Restrict socket file permissions on *nix (umask may be permissive)
          if (process.platform !== "win32") {
            try {
              chmodSync(socketPath, 0o600);
            } catch {
              // Best-effort — auth token provides primary protection
            }
          }
          resolve();
        });
      });
    } catch (error) {
      // Graceful degradation — IPC unavailable but session continues
      console.warn(
        `[pi-subagent-ui-bridge] Failed to create IPC socket: ${error instanceof Error ? error.message : error}`,
      );
      this._socketPath = null;
    }
  }

  /**
   * Stop the server, close all client connections, clean up socket file.
   */
  async stop(): Promise<void> {
    // Close all clients
    for (const [, info] of this.clients) {
      info.socket.destroy();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      const server = this.server;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.server = null;
    }

    // Clean up socket file on *nix
    if (this._socketPath && process.platform !== "win32") {
      try {
        unlinkSync(this._socketPath);
      } catch {
        // File may already be gone
      }
    }
    this._socketPath = null;

    // Reject pending requests
    for (const pending of this.requestQueue) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("Server shutting down"));
    }
    this.requestQueue = [];
  }

  /**
   * Set the ExtensionContext — used to pass ctx to handlers via withContext wrapper.
   */
  setCtx(ctx: BridgeCtx): void {
    this.ctx = ctx;
  }

  /**
   * Register a handler for a contentType. Last-wins if registered twice.
   */
  registerHandler(contentType: string, handler: TypedHandler): void {
    this.handlers.set(contentType, handler);
  }

  /**
   * List connected client IDs (useful for testing).
   */
  listClients(): string[] {
    return [...this.clients.keys()];
  }

  private handleConnection(socket: Socket): void {
    const clientId = randomUUID();
    this.clients.set(clientId, { socket, authState: "pending" });

    const reader = createMessageReader(
      (msg) => this.handleMessage(clientId, msg as IpcMessage),
      (error) => {
        console.warn(`[pi-subagent-ui-bridge] Protocol error from client ${clientId}: ${error.message}`);
        this.removeClient(clientId);
      },
    );

    socket.on("data", reader);
    socket.on("close", () => {
      this.clients.delete(clientId);
    });
    socket.on("error", () => {
      this.clients.delete(clientId);
    });
  }

  private removeClient(clientId: string): void {
    const info = this.clients.get(clientId);
    if (info) {
      info.socket.destroy();
      this.clients.delete(clientId);
    }
  }

  private async handleMessage(clientId: string, message: IpcMessage): Promise<void> {
    const info = this.clients.get(clientId);
    if (!info) return;

    // Unauthenticated client — expect auth message first
    if (info.authState === "pending") {
      if (
        message.type === "event" &&
        message.contentType === "auth" &&
        typeof (message.payload as Record<string, unknown> | null)?.token === "string"
      ) {
        const tokenBuf = Buffer.from((message.payload as Record<string, unknown>).token as string, "utf-8");
        const expectedBuf = Buffer.from(this._authToken, "utf-8");
        if (tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf)) {
          info.authState = "authenticated";
          // Send explicit auth acknowledgement so client knows auth succeeded
          writeMessage(info.socket, {
            id: randomUUID(),
            type: "event",
            contentType: "auth_ack",
            payload: null,
          });
          return;
        }
      }
      // Wrong token, wrong message type, or no auth — reject
      this.removeClient(clientId);
      return;
    }

    // Authenticated client — process normally

    // Basic message validation
    if (typeof message.contentType !== "string" || message.contentType.length > 256) {
      this.removeClient(clientId);
      return;
    }
    if (typeof message.id !== "string") {
      this.removeClient(clientId);
      return;
    }

    if (message.type === "event") {
      // Cancel events are handled specially — remove queued or in-flight requests
      if (message.contentType === "cancel") {
        this.handleCancel(clientId, message);
        return;
      }

      // Fire-and-forget — dispatch but don't wait
      const handler = this.handlers.get(message.contentType);
      if (handler) {
        try {
          await handler({
            ctx: (this.ctx ?? ({} as BridgeCtx)) as BridgeCtx,
            clientId,
            contentType: message.contentType,
            payload: message.payload,
            meta: {} as MessageMeta,
          });
        } catch (err) {
          console.warn(
            `[pi-subagent-ui-bridge] Event handler error for ${message.contentType}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      return;
    }

    if (message.type === "request") {
      await this.enqueueRequest(clientId, message);
    }
  }

  /**
   * Handle a cancel event from a client.
   * Removes the target request from the queue or dismisses an in-flight request.
   */
  private handleCancel(clientId: string, message: IpcMessage): void {
    const cancelledId = (message.payload as Record<string, unknown> | null)?.cancelledId;
    if (typeof cancelledId !== "string") return;

    // Check if it's the currently processing request (first in queue)
    const current = this.requestQueue[0];
    if (current && current.message.id === cancelledId && current.clientId === clientId) {
      // Mark as cancelled — the while loop in processQueue will discard the result
      current.cancelled = true;
      // Dismiss active dialog if one was opened
      dismissDialog(current.doneRef);
      // Clear timeout
      if (current.timeout) clearTimeout(current.timeout);
      // Send cancelled response immediately
      this.sendError(clientId, current.message, "cancelled");
      // Unblock the while loop so it can process the next request
      if (current.cancelHandler) {
        current.cancelHandler(new Error("cancelled"));
      }
      return;
    }

    // Check if it's a queued request (not yet being processed)
    const idx = this.requestQueue.findIndex((p) => p.message.id === cancelledId && p.clientId === clientId);
    if (idx !== -1) {
      const [pending] = this.requestQueue.splice(idx, 1);
      if (pending.timeout) clearTimeout(pending.timeout);
      this.sendError(clientId, pending.message, "cancelled");
    }
  }

  private enqueueRequest(clientId: string, message: IpcMessage): Promise<void> {
    return new Promise((resolve) => {
      // Resolve effective timeout: client timeoutMs overrides server default.
      // "Infinity" string survives JSON serialization where Number.POSITIVE_INFINITY becomes null.
      const clientTimeout = message.timeoutMs;
      let effectiveTimeoutMs: number | null;
      if (clientTimeout === "Infinity") {
        effectiveTimeoutMs = null; // Client explicitly wants no timeout
      } else if (typeof clientTimeout === "number" && Number.isFinite(clientTimeout) && clientTimeout > 0) {
        // Clamp to 32-bit max (setTimeout limitation)
        effectiveTimeoutMs = Math.min(clientTimeout, 0x7fffffff);
      } else {
        // Client didn't specify — use server default
        effectiveTimeoutMs = this.handlerTimeoutMs > 0 ? this.handlerTimeoutMs : null;
      }

      const timeout = effectiveTimeoutMs
        ? setTimeout(() => {
            // Handler timeout — dismiss active dialog if one was opened
            dismissDialog(pending.doneRef);
            // Mark as cancelled so the while loop discards the result
            pending.cancelled = true;
            this.sendError(clientId, message, "handler timed out");
            // Unblock the while loop so it can process the next request
            if (pending.cancelHandler) {
              pending.cancelHandler(new Error("handler timed out"));
            }
          }, effectiveTimeoutMs)
        : null;

      const doneRef: DoneRef = {};
      const pending: PendingRequest = {
        clientId,
        message,
        resolve: (response) => {
          this.sendToClient(clientId, response);
          resolve();
        },
        reject: () => resolve(), // Don't crash on reject
        timeout,
        doneRef,
      };
      this.requestQueue.push(pending);

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.requestQueue.length === 0) return;
    this.processing = true;

    while (this.requestQueue.length > 0) {
      const pending = this.requestQueue[0];
      if (!pending) break;
      const handler = this.handlers.get(pending.message.contentType);

      if (!handler) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.requestQueue.shift();
        this.sendError(
          pending.clientId,
          pending.message,
          `No handler registered for contentType "${sanitizeContentType(pending.message.contentType)}"`,
        );
        continue;
      }

      try {
        // Wrap handler invocation with withContext if ctx is available.
        // Race against a cancellation promise so cancel/timeout can unblock the while loop.
        const cancelPromise = new Promise<never>((_, reject) => {
          pending.cancelHandler = (error: Error) => reject(error);
        });

        const handlerFn = async () => {
          return handler({
            ctx: (this.ctx ?? ({} as BridgeCtx)) as BridgeCtx,
            clientId: pending.clientId,
            contentType: pending.message.contentType,
            payload: pending.message.payload,
            meta: pending.message.meta ?? ({} as MessageMeta),
          });
        };

        const wrappedFn = this.ctx
          ? withContext(this.ctx, pending.message.meta ?? null, handlerFn, pending.doneRef)
          : handlerFn();

        let result: unknown;
        try {
          result = await Promise.race([wrappedFn, cancelPromise]);
        } catch (error) {
          // If this is a cancellation (cancelHandler was invoked), skip to next
          if (pending.cancelled) {
            if (pending.timeout) clearTimeout(pending.timeout);
            this.requestQueue.shift();
            // Response already sent by handleCancel or timeout callback
            continue;
          }
          // Otherwise it's a real handler error — re-throw to outer catch
          throw error;
        }

        if (pending.timeout) clearTimeout(pending.timeout);
        this.requestQueue.shift();
        this.sendSuccess(pending.clientId, pending.message, result ?? null);
      } catch (error) {
        if (pending.timeout) clearTimeout(pending.timeout);
        this.requestQueue.shift();
        // Log full error server-side, send generic message to client
        console.error(
          `[pi-subagent-ui-bridge] Handler error for ${pending.message.contentType}: ${error instanceof Error ? error.message : error}`,
        );
        this.sendError(pending.clientId, pending.message, "Internal handler error");
      }
    }

    this.processing = false;
  }

  private sendSuccess(clientId: string, request: IpcMessage, payload: unknown): void {
    const response: IpcMessage = {
      id: request.id,
      type: "response",
      contentType: request.contentType,
      payload: payload ?? null,
    };
    this.sendToClient(clientId, response);
  }

  private sendError(clientId: string, request: IpcMessage, error: string): void {
    const response: IpcMessage = {
      id: request.id,
      type: "response",
      contentType: request.contentType,
      payload: null,
      error,
    };
    this.sendToClient(clientId, response);
  }

  private sendToClient(clientId: string, message: IpcMessage): void {
    const info = this.clients.get(clientId);
    if (info && !info.socket.destroyed) {
      writeMessage(info.socket, message);
    }
  }
}

/**
 * Sanitize a contentType for use in error messages.
 * Strips control characters and truncates to 64 chars.
 */
function sanitizeContentType(contentType: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this regex INTENTIONALLY matches ASCII control characters (0x00-0x1F + 0x7F) to strip them from untrusted content-type strings before logging — that is its purpose.
  const cleaned = contentType.replace(/[\x00-\x1f\x7f]/g, "?");
  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
}
