// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Socket } from "node:net";
import { MAX_MESSAGE_SIZE } from "./types.js";

/** Byte offset where the 4-byte length header is written (start of the buffer). */
const HEADER_BYTE_OFFSET = 0;

/**
 * Write a length-prefixed message to a socket.
 * Format: 4-byte big-endian length + UTF-8 JSON payload.
 * Length-prefixed wire format for efficient binary framing.
 */
export function writeMessage(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, HEADER_BYTE_OFFSET);
  socket.write(Buffer.concat([header, payload]));
}

/**
 * Create a message reader that handles partial reads.
 * Calls onMessage for each complete message received.
 * Protocol or handler errors are reported to onError.
 */
export function createMessageReader(onMessage: (msg: unknown) => void, onError: (error: Error) => void) {
  let buffer = Buffer.alloc(0);

  return (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);

      if (length > MAX_MESSAGE_SIZE) {
        onError(new Error(`Message size ${length} bytes exceeds maximum ${MAX_MESSAGE_SIZE} bytes`));
        return;
      }

      if (buffer.length < 4 + length) {
        break;
      }

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      let msg: unknown;
      try {
        msg = JSON.parse(payload.toString("utf-8"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to parse message: ${message}`));
        return;
      }

      try {
        onMessage(msg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(new Error(`Failed to handle message: ${message}`));
        return;
      }
    }
  };
}
