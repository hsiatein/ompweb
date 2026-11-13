import type { SessionEntry } from "./types";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { resolveLocalFileHref, resolveToolFilePath } from "./file-links";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string | null): sessionId is string {
  return !!sessionId && SESSION_ID_RE.test(sessionId);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isPathChar(ch: string): boolean {
  return /[A-Za-z0-9._~+%@/\\:-]/.test(ch);
}

function hasReferenceBoundaryAfter(text: string, index: number): boolean {
  if (index >= text.length) return true;
  const ch = text[index];
  if (ch === ":") return /\d/.test(text[index + 1] ?? "");
  return !isPathChar(ch);
}

function containsExactPathReference(text: string, filePath: string, home?: string): boolean {
  const target = normalizeSlashes(filePath);
  const targets = target.startsWith("/") ? [target, `file://${target}`] : [target];
  // `~/x` in a message stands for the same file (the UI links it through the home directory).
  const homePrefix = home ? `${normalizeSlashes(home).replace(/\/+$/, "")}/` : null;
  if (homePrefix && homePrefix !== "/" && target.startsWith(homePrefix)) targets.push(`~/${target.slice(homePrefix.length)}`);
  const haystacks = new Set([normalizeSlashes(text), normalizeSlashes(safeDecode(text))]);

  for (const haystack of haystacks) {
    for (const t of targets) {
      let index = haystack.indexOf(t);
      while (index !== -1) {
        const before = index === 0 ? "" : haystack[index - 1];
        const afterIndex = index + t.length;
        if ((index === 0 || !isPathChar(before)) && hasReferenceBoundaryAfter(haystack, afterIndex)) {
          return true;
        }
        index = haystack.indexOf(t, index + 1);
      }
    }
  }

  return false;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  for (const item of Object.values(value)) collectStrings(item, out);
}

export function isFilePathReferencedByEntries(filePath: string, entries: SessionEntry[], cwd?: string, home?: string): boolean {
  for (const entry of entries) {
    const strings: string[] = [];
    collectStrings(entry, strings);
    if (strings.some((text) => containsExactPathReference(text, filePath, home))) return true;
    if (cwd && strings.some((text) => containsRelativeFileReference(text, filePath, cwd))) return true;
  }
  return false;
}

function containsRelativeFileReference(text: string, filePath: string, cwd: string): boolean {
  const target = resolveToolFilePath(filePath);
  if (!target) return false;
  const equal = (resolved: string | null) => resolved !== null && (
    /^[a-zA-Z]:\//.test(target) || target.startsWith("//")
      ? resolved.toLowerCase() === target.toLowerCase()
      : resolved === target
  );
  const matches = (href: string) => equal(resolveLocalFileHref(href, cwd));
  // Tool arguments can be raw paths; Markdown destinations need an actual
  // parser so spaces, escaping and reference-style links agree with the UI.
  if (equal(resolveToolFilePath(text, cwd)) || matches(text)) return true;
  if (!text.includes("[")) return false;
  const stack: Nodes[] = [fromMarkdown(text)];
  while (stack.length) {
    const node = stack.pop()!;
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && matches(node.url)) return true;
    if ("children" in node) stack.push(...node.children);
  }
  return false;
}

export function isBashOutputPathReferencedByEntries(filePath: string, entries: SessionEntry[]): boolean {
  return entries.some((entry) => (
    entry.type === "message"
    && entry.message.role === "bashExecution"
    && entry.message.fullOutputPath === filePath
  ));
}
