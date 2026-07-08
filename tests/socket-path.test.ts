// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { expect, test } from "vitest";
import { getSocketPath, sanitizeSegment } from "../src/socket-path.js";

test("getSocketPath returns named pipe on Windows", () => {
  const path = getSocketPath("win32", "/home/user", "session-abc123");
  expect(path).toMatch(/^\\\\\.\\pipe\\pi-subagent-ui-bridge-/);
  expect(path).toMatch(/abc123/);
});

test("getSocketPath returns Unix socket on Linux", () => {
  const path = getSocketPath("linux", "/home/user", "session-abc123");
  expect(path).toMatch(/\.sock$/);
  expect(path).toMatch(/pi\/agent\/subagent-ui-bridge\//);
  expect(path).toMatch(/abc123/);
});

test("getSocketPath returns Unix socket on macOS", () => {
  const path = getSocketPath("darwin", "/Users/test", "session-xyz");
  expect(path).toMatch(/\.sock$/);
  expect(path).toMatch(/pi\/agent\/subagent-ui-bridge\//);
});

test("getSocketPath includes random suffix for uniqueness", () => {
  const path1 = getSocketPath("linux", "/home/user", "session-abc");
  const path2 = getSocketPath("linux", "/home/user", "session-abc");
  // Extract suffix after the session prefix
  expect(path1).not.toBe(path2);
});

// ── sanitizeSegment edge cases ──────────────────────────────────────────────

test("sanitizeSegment returns 'unknown' for empty string", () => {
  expect(sanitizeSegment("")).toBe("unknown");
});

test("sanitizeSegment returns 'unknown' for undefined-like falsy", () => {
  expect(sanitizeSegment("" as string)).toBe("unknown");
});

test("sanitizeSegment strips session- prefix", () => {
  expect(sanitizeSegment("session-abc123")).toBe("abc123");
});

test("sanitizeSegment replaces non-alphanumeric chars with dashes", () => {
  expect(sanitizeSegment("hello world!@#")).toBe("hello-world-");
});

test("sanitizeSegment truncates to 12 characters", () => {
  expect(sanitizeSegment("abcdefghijklmnopqrstuvwxyz").length).toBe(12);
});

test("sanitizeSegment lowercases result", () => {
  // /^session-/ is lowercase, so SESSION- doesn't match prefix strip
  expect(sanitizeSegment("SESSION-ABC")).toBe("session-abc");
});

test("sanitizeSegment handles all special characters", () => {
  const result = sanitizeSegment("!@#$%^&*()");
  expect(result.length).toBeLessThanOrEqual(12);
});

test("sanitizeSegment handles unicode", () => {
  const result = sanitizeSegment("session-über-test");
  expect(result.includes("-")).toBe(true);
});
