// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Socket } from "node:net";
import { expect, test } from "vitest";
import { createMessageReader, writeMessage } from "../src/framing.js";
import type { IpcMessage } from "../src/types.js";

test("writeMessage + createMessageReader round-trips a message", () => {
  const messages: unknown[] = [];
  const errors: Error[] = [];

  const reader = createMessageReader(
    (msg) => messages.push(msg),
    (err) => errors.push(err),
  );

  const original: IpcMessage = {
    id: "test-123",
    type: "request",
    contentType: "ask_user_question",
    payload: { questions: ["hello?"] },
  };

  // Use a mock socket that collects written data
  const chunks: Buffer[] = [];
  const mockSocket = { write: (data: Buffer) => chunks.push(data) } as unknown as Socket;
  writeMessage(mockSocket, original);

  // Feed all chunks to the reader
  const combined = Buffer.concat(chunks);
  reader(combined);

  expect(errors).toEqual([]);
  expect(messages.length).toBe(1);
  expect(messages[0]).toEqual(original);
});

test("createMessageReader handles partial reads", () => {
  const messages: unknown[] = [];
  const reader = createMessageReader(
    (msg) => messages.push(msg),
    () => {},
  );

  const msg: IpcMessage = {
    id: "partial-test",
    type: "response",
    contentType: "test",
    payload: "hello",
  };

  const chunks: Buffer[] = [];
  const mockSocket = { write: (data: Buffer) => chunks.push(data) } as unknown as Socket;
  writeMessage(mockSocket, msg);
  const full = Buffer.concat(chunks);

  // Feed first half, then second half
  const mid = Math.floor(full.length / 2);
  reader(full.subarray(0, mid));
  reader(full.subarray(mid));

  expect(messages.length).toBe(1);
  expect(messages[0]).toEqual(msg);
});

test("createMessageReader handles multiple messages in one chunk", () => {
  const messages: unknown[] = [];
  const reader = createMessageReader(
    (msg) => messages.push(msg),
    () => {},
  );

  const msg1: IpcMessage = { id: "a", type: "request", contentType: "t1", payload: 1 };
  const msg2: IpcMessage = { id: "b", type: "request", contentType: "t2", payload: 2 };

  const chunks1: Buffer[] = [];
  const chunks2: Buffer[] = [];
  writeMessage({ write: (d: Buffer) => chunks1.push(d) } as unknown as Socket, msg1);
  writeMessage({ write: (d: Buffer) => chunks2.push(d) } as unknown as Socket, msg2);

  // Feed both messages as a single chunk
  reader(Buffer.concat([...chunks1, ...chunks2]));

  expect(messages.length).toBe(2);
  expect(messages[0]).toEqual(msg1);
  expect(messages[1]).toEqual(msg2);
});

test("createMessageReader rejects messages exceeding MAX_MESSAGE_SIZE", () => {
  const errors: Error[] = [];
  const reader = createMessageReader(
    () => {},
    (err) => errors.push(err),
  );

  // Craft a message with a huge length prefix
  const header = Buffer.alloc(4);
  header.writeUInt32BE(11 * 1024 * 1024, 0); // 11 MB — exceeds 10 MB limit
  const smallPayload = Buffer.alloc(10);
  reader(Buffer.concat([header, smallPayload]));

  expect(errors.length).toBe(1);
  expect(errors[0]?.message).toMatch(/exceeds maximum/i);
});

test("createMessageReader reports JSON parse errors", () => {
  const errors: Error[] = [];
  const reader = createMessageReader(
    () => {},
    (err) => errors.push(err),
  );

  // Valid length prefix, invalid JSON payload
  const payload = Buffer.from("{ invalid json");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  reader(Buffer.concat([header, payload]));

  expect(errors.length).toBe(1);
  expect(errors[0]?.message).toMatch(/failed to parse/i);
});
