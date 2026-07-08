// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { randomUUID } from "node:crypto";

export function sanitizeSegment(value: string): string {
  if (!value) return "unknown";
  return value
    .replace(/^session-/, "")
    .replace(/[^a-zA-Z0-9]/g, "-")
    .slice(0, 12)
    .toLowerCase();
}

/**
 * Resolve the IPC socket path for the given platform.
 *
 * Windows: named pipe at \\.\pipe\pi-subagent-ui-bridge-{prefix}-{suffix}
 * *nix:    Unix socket at ~/.pi/agent/subagent-ui-bridge/{prefix}-{suffix}.sock
 */
/** Default platform for socket path */
export const DEFAULT_PLATFORM: NodeJS.Platform = process.platform;

export function getSocketPath(platform: NodeJS.Platform, homeDir: string, sessionId: string): string {
  const prefix = sanitizeSegment(sessionId);
  const suffix = randomUUID().slice(0, 8);

  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-subagent-ui-bridge-${prefix}-${suffix}`;
  }

  return `${homeDir}/.pi/agent/subagent-ui-bridge/${prefix}-${suffix}.sock`;
}
