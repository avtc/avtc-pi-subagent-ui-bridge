// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Component } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
  ContextWrapperComponent,
  NO_MARKDOWN_RENDER_OVERRIDE,
  padToVisible,
  visibleLen,
} from "../src/context-wrapper.js";
import type { BridgeTheme } from "../src/types.js";

// Mock theme that just wraps text in brackets to identify styling
function createMockTheme() {
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `[bold:${text}]`,
    italic: (text: string) => `[italic:${text}]`,
    underline: (text: string) => `[underline:${text}]`,
    strikethrough: (text: string) => `[strike:${text}]`,
  };
}

test("ContextWrapperComponent renders header, context, footer, separator, and inner dialog", () => {
  const theme = createMockTheme();
  const meta = { agentName: "worker", lastMessage: "Hello world" };

  const innerLines = ["Inner dialog line 1", "Inner dialog line 2"];
  const innerComponent = {
    render: (_width: number) => innerLines,
    handleInput: (_data: string) => {},
  };

  // Test with a mock markdown renderer
  const wrapper = new ContextWrapperComponent(
    meta,
    innerComponent as unknown as Component,
    theme as unknown as BridgeTheme,
    // Override markdown render for testability
    (text: string, _w: number) => [`[MD: ${text}]`],
  );

  const lines = wrapper.render(80);
  expect(lines.length).toBeGreaterThanOrEqual(4);

  // Header should contain agent name
  expect(lines[0]).toMatch(/worker/);

  // Footer should contain agent name and line count
  const footerIdx = lines.findIndex((l) => l.includes("1 lines"));
  expect(footerIdx).toBeGreaterThan(0);

  // Separator (blank line) before inner dialog
  const blankIdx = lines.indexOf("");
  expect(blankIdx).toBeGreaterThan(0);

  // Inner dialog lines should be present
  expect(lines.some((l) => l.includes("Inner dialog line 1"))).toBe(true);
  expect(lines.some((l) => l.includes("Inner dialog line 2"))).toBe(true);
});

test("ContextWrapperComponent forwards handleInput to inner component", () => {
  const theme = createMockTheme();
  const meta = { agentName: "worker", lastMessage: "test" };

  let receivedInput: string | null = null;
  const innerComponent = {
    render: () => [],
    handleInput: (data: string) => {
      receivedInput = data;
    },
  };

  const wrapper = new ContextWrapperComponent(
    meta,
    innerComponent as unknown as Component,
    theme as unknown as BridgeTheme,
    () => [],
  );

  wrapper.handleInput?.("\x1b[A"); // Up arrow
  expect(receivedInput).toBe("\x1b[A");
});

test("ContextWrapperComponent calls inner dispose on dispose", () => {
  const theme = createMockTheme();
  const meta = { agentName: "worker", lastMessage: "test" };

  let disposed = false;
  const innerComponent = {
    render: () => [],
    dispose: () => {
      disposed = true;
    },
  };

  const wrapper = new ContextWrapperComponent(
    meta,
    innerComponent as unknown as Component,
    theme as unknown as BridgeTheme,
    () => [],
  );

  wrapper.dispose?.();
  expect(disposed).toBe(true);
});

test("ContextWrapperComponent skips context when lastMessage is empty", () => {
  const theme = createMockTheme();
  const meta = { agentName: "worker", lastMessage: "" };

  const innerLines = ["Just the dialog"];
  const innerComponent = {
    render: () => innerLines,
  };

  const wrapper = new ContextWrapperComponent(
    meta,
    innerComponent as unknown as Component,
    theme as unknown as BridgeTheme,
    () => [],
  );

  const lines = wrapper.render(80);

  // Should only have the inner dialog line (no header/footer/separator)
  expect(lines.length).toBe(1);
  expect(lines[0]?.includes("Just the dialog")).toBe(true);
});

// --- visibleLen / padToVisible tests ---

test("visibleLen returns length for plain strings", () => {
  expect(visibleLen("hello")).toBe(5);
  expect(visibleLen("")).toBe(0);
  expect(visibleLen("a b c")).toBe(5);
});

test("visibleLen strips CSI sequences (ESC[...letter)", () => {
  // Red text: \x1b[31mhello\x1b[0m
  expect(visibleLen("\x1b[31mhello\x1b[0m")).toBe(5);
  // Bold: \x1b[1mhi\x1b[0m
  expect(visibleLen("\x1b[1mhi\x1b[0m")).toBe(2);
  // Multiple codes
  expect(visibleLen("\x1b[1;32mok\x1b[0m")).toBe(2);
  // 256-color: \x1b[38;5;196mX\x1b[0m
  expect(visibleLen("\x1b[38;5;196mX\x1b[0m")).toBe(1);
});

test("visibleLen strips OSC sequences (ESC]...BEL)", () => {
  // Window title: \x1b]0;title\x07
  expect(visibleLen("\x1b]0;my title\x07")).toBe(0);
  // Mixed: text with OSC
  expect(visibleLen("prefix\x1b]0;ignore\x07suffix")).toBe(12);
});

test("visibleLen handles mixed ANSI and plain text", () => {
  const colored = "\x1b[32m●\x1b[0m passed \x1b[31m●\x1b[0m failed";
  expect(visibleLen(colored)).toBe(17); // ● passed ● failed
});

test("padToVisible pads plain string to target width", () => {
  expect(padToVisible("hi", 5)).toBe("hi   ");
  expect(padToVisible("", 3)).toBe("   ");
  expect(padToVisible("abc", 3)).toBe("abc");
});

test("padToVisible pads string with ANSI codes correctly", () => {
  const red = "\x1b[31mhi\x1b[0m"; // visible length = 2
  const result = padToVisible(red, 5);
  expect(visibleLen(result)).toBe(5);
  expect(result.endsWith("   ")).toBe(true);
  expect(result.includes("\x1b[31m")).toBe(true);
});

test("padToVisible returns string unchanged when already at target width", () => {
  expect(padToVisible("hello", 5)).toBe("hello");
  expect(padToVisible("\x1b[1mabc\x1b[0m", 3)).toBe("\x1b[1mabc\x1b[0m");
});

test("padToVisible returns string unchanged when exceeding target width", () => {
  expect(padToVisible("hello world", 5)).toBe("hello world");
  const long = "\x1b[32mabcdefghij\x1b[0m";
  expect(padToVisible(long, 5)).toBe(long);
});

test("ContextWrapperComponent renders with narrow terminal width", () => {
  const theme = createMockTheme();
  const meta = { agentName: "w", lastMessage: "short" };

  const innerLines = ["inner"];
  const innerComponent = {
    render: () => innerLines,
  };

  const wrapper = new ContextWrapperComponent(
    meta,
    innerComponent as unknown as Component,
    theme as unknown as BridgeTheme,
    (text: string, _w: number) => [text],
  );

  // Very narrow width — innerWidth = 10 - 4 = 6, minimum 20 enforced
  const lines = wrapper.render(10);

  // Should still produce valid output without crashing
  expect(lines.length).toBeGreaterThanOrEqual(3);

  // Header should contain agent name
  expect(lines[0]).toMatch(/w/);

  // All lines should be finite strings
  for (const line of lines) {
    expect(typeof line === "string").toBe(true);
  }
});

test("ContextWrapperComponent defers Markdown instantiation when lastMessage is empty (no override)", () => {
  const theme = createMockTheme();
  const meta = { agentName: "worker", lastMessage: "" };

  const innerLines = ["Dialog content"];
  const innerComponent = {
    render: () => innerLines,
  };

  // No markdownRenderOverride — constructor should NOT instantiate Markdown
  const wrapper = new ContextWrapperComponent(
    meta,
    innerComponent as unknown as Component,
    theme as unknown as BridgeTheme,
    NO_MARKDOWN_RENDER_OVERRIDE,
  );

  const lines = wrapper.render(80);

  // Should only have inner dialog lines (no context section)
  expect(lines.length).toBe(1);
  expect(lines[0]).toBe("Dialog content");
});
