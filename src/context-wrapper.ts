// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { Component } from "@earendil-works/pi-tui";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { BridgeTheme, MessageMeta } from "./types.js";

/** Render override for markdown content; null means no override (defer to default Markdown). */
export type MarkdownRenderFn = (text: string, width: number) => string[];

/** Sentinel: no markdown render override — constructor defers to default Markdown rendering. */
export const NO_MARKDOWN_RENDER_OVERRIDE: MarkdownRenderFn | null = null;

/** Markdown renderer horizontal padding (chars left/right of content). */
const MARKDOWN_PADDING_X = 1;
/** Markdown renderer vertical padding (empty lines above/below content). */
const MARKDOWN_PADDING_Y = 0;

/**
 * Strip ANSI escape codes to compute visible character count.
 */
export function visibleLen(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape code detection requires control chars in regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\].*?\x07/g, "").length;
}

/**
 * Pad a string to a target visible width, accounting for ANSI escape codes.
 */
export function padToVisible(s: string, targetWidth: number): string {
  const vLen = visibleLen(s);
  if (vLen >= targetWidth) return s;
  return s + " ".repeat(targetWidth - vLen);
}

/**
 * Composite component: full-height markdown context section above an inner dialog.
 * All keyboard input is forwarded to the inner component.
 */
export class ContextWrapperComponent implements Component {
  private meta: MessageMeta;
  private inner: Component;
  private theme: BridgeTheme;

  private _markdownRender: ((text: string, width: number) => string[]) | null = null;

  constructor(
    meta: MessageMeta,
    inner: Component,
    theme: BridgeTheme,
    markdownRenderOverride: MarkdownRenderFn | null,
  ) {
    this.meta = meta;
    this.inner = inner;
    this.theme = theme;

    if (markdownRenderOverride) {
      this._markdownRender = markdownRenderOverride;
    }
    // If no override and lastMessage is present, defer Markdown instantiation
    // to first render() call — avoids allocating Markdown when lastMessage is empty.
  }

  render(width: number): string[] {
    // Skip context if no lastMessage or empty/whitespace-only
    if (!this.meta.lastMessage?.trim()) {
      return this.inner.render(width);
    }

    const lines: string[] = [];
    const innerWidth = width - 4;
    const fg = this.theme.fg.bind(this.theme);

    // Lazily initialize Markdown renderer on first render
    if (!this._markdownRender) {
      const mdTheme = this.createMarkdownTheme();
      const md = new Markdown(this.meta.lastMessage, MARKDOWN_PADDING_X, MARKDOWN_PADDING_Y, mdTheme);
      this._markdownRender = (_: string, w: number) => md.render(w);
    }

    // Render markdown context
    const contextLines = this._markdownRender(this.meta.lastMessage, Math.max(20, innerWidth));

    // Header
    const agentName = this.meta.agentName ?? "subagent";
    const headerTitle = ` ${agentName} `;
    const headerFill = Math.max(0, width - headerTitle.length - 3);
    lines.push(fg("accent", `╭─${headerTitle}${"─".repeat(headerFill)}╮`));

    // Context body — all lines, no height cap
    for (const line of contextLines) {
      const padded = padToVisible(line, innerWidth);
      lines.push(`${fg("accent", "│ ")}${padded}${fg("accent", " │")}`);
    }

    // Footer
    const footerText = ` ${agentName} (${contextLines.length} lines) `;
    const footerFill = Math.max(0, width - footerText.length - 3);
    lines.push(fg("accent", `╰─${fg("dim", footerText)}${"─".repeat(footerFill)}╯`));

    // Separator
    lines.push("");

    // Inner dialog
    lines.push(...this.inner.render(width));

    return lines;
  }

  handleInput?(data: string): void {
    if (this.inner.handleInput) {
      this.inner.handleInput(data);
    }
  }

  dispose?(): void {
    const inner = this.inner as Component & { dispose?: () => void };
    if (inner.dispose) {
      inner.dispose();
    }
  }

  invalidate(): void {
    // Re-render on next render call
  }

  private createMarkdownTheme(): MarkdownTheme {
    const fg = this.theme.fg.bind(this.theme);
    return {
      heading: (t) => fg("mdHeading", t),
      link: (t) => fg("mdLink", t),
      linkUrl: (t) => fg("mdLinkUrl", t),
      code: (t) => fg("mdCode", t),
      codeBlock: (t) => fg("mdCodeBlock", t),
      codeBlockBorder: (t) => fg("mdCodeBlockBorder", t),
      quote: (t) => fg("mdQuote", t),
      quoteBorder: (t) => fg("mdQuoteBorder", t),
      hr: (t) => fg("mdHr", t),
      listBullet: (t) => fg("mdListBullet", t),
      bold: (t) => this.theme.bold(t),
      italic: (t) => this.theme.italic(t),
      strikethrough: (t) => this.theme.strikethrough(t),
      underline: (t) => this.theme.underline(t),
    };
  }
}
