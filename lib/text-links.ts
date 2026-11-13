/**
 * Finds web addresses and local file paths in plain text so they can be
 * shown as links (chat prose, inline code, tool output). Client-safe and pure.
 *
 * Detection is deliberately conservative — a false link is worse than a
 * missing one:
 * - URLs: `http(s)://` (and `file:///`, treated as a path), ASCII URL characters only (so a URL
 *   glued to Chinese text ends where the text starts), trailing punctuation
 *   and unbalanced closing brackets dropped.
 * - Paths in prose: `~/…`, `./…`, `../…`, `C:\…` / `C:/…`, absolute `/a/b`
 *   (two segments or more, so `/reset`-style commands and `1/2` stay text),
 *   and relative `dir/file.ext` (a slash and a file extension). ASCII path
 *   characters only; an optional `:line[:col]` suffix is kept in the link.
 * - Inline code: the whole span must be one path or URL; any characters
 *   other than whitespace are allowed there (`~/项目/绘图`).
 */

export type TextLinkKind = "url" | "path";

export interface TextLinkMatch {
  start: number;
  end: number;
  value: string;
  kind: TextLinkKind;
}

const URL_CHARS = String.raw`[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]`;
const SEG = String.raw`[A-Za-z0-9_.@+~%=-]`;
const LINE = String.raw`(?::\d+(?::\d+)?)?`;
const PATH_FORMS = [
  String.raw`~(?:\/${SEG}+)+\/?`,
  String.raw`\.{1,2}(?:\/${SEG}+)+\/?`,
  String.raw`[A-Za-z]:[\\/](?:${SEG}+[\\/])*${SEG}+`,
  String.raw`(?:\/${SEG}+){2,}\/?`,
  String.raw`${SEG}+(?:\/${SEG}+)+`,
].join("|");

/** One combined, global pattern; candidates are then checked by {@link classifyTextLink}. */
export const TEXT_LINK_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?:https?|file):\/\/${URL_CHARS}+` +
    String.raw`|(?<![A-Za-z0-9_./:~@%\\=+-])(?:${PATH_FORMS})${LINE}`,
  "g",
);

const RELATIVE_FILE_RE = /\/[^/]*[A-Za-z][^/]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;

function trimUrl(value: string): string {
  let end = value.length;
  for (;;) {
    const ch = value[end - 1];
    if (!ch) break;
    if (".,;:!?'\"*".includes(ch)) { end--; continue; }
    const open = ch === ")" ? "(" : ch === "]" ? "[" : null;
    if (open) {
      const body = value.slice(0, end);
      if (body.split(open).length - 1 < body.split(ch).length - 1) { end--; continue; }
    }
    break;
  }
  return value.slice(0, end);
}

/**
 * Validates one {@link TEXT_LINK_RE} candidate: the part that is a link (with
 * trailing punctuation removed) or null when the candidate is not a link.
 */
export function classifyTextLink(candidate: string): { value: string; kind: TextLinkKind } | null {
  if (/^(?:https?|file):\/\//.test(candidate)) {
    const value = trimUrl(candidate);
    if (value.startsWith("file:")) return value.startsWith("file:///") ? { value, kind: "path" } : null;
    return /^https?:\/\/[^/?#]/.test(value) ? { value, kind: "url" } : null;
  }
  const value = candidate.replace(/\.+$/, "");
  const bare = value.replace(/:\d+(?::\d+)?$/, "");
  if (!bare || bare === "~" || /\/(?:\.\.?)$/.test(bare)) return null;
  if (/^(?:~|\.{1,2})\//.test(bare) || /^[A-Za-z]:[\\/]/.test(bare)) return { value, kind: "path" };
  if (bare.startsWith("/")) return /^\/(?:api|_next)\//.test(bare) ? null : { value, kind: "path" };
  const first = bare.split("/")[0];
  // `example.com/index.html` is a site, not a file.
  if (/^[^.].*\.[A-Za-z]{2,}$/.test(first)) return null;
  return RELATIVE_FILE_RE.test(bare) && /[A-Za-z]/.test(first) ? { value, kind: "path" } : null;
}

/** Every link in `text`, in order and non-overlapping. */
export function findTextLinks(text: string): TextLinkMatch[] {
  const out: TextLinkMatch[] = [];
  for (const match of text.matchAll(TEXT_LINK_RE)) {
    const link = classifyTextLink(match[0]);
    if (link) out.push({ start: match.index, end: match.index + link.value.length, ...link });
  }
  return out;
}

/** The link a whole inline-code span stands for, or null. */
export function matchWholeTextLink(text: string): { value: string; kind: TextLinkKind } | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  if (/^https?:\/\/\S+$/.test(value)) return { value, kind: "url" };
  if (/^file:\/\/\/\S+$/.test(value)) return { value, kind: "path" };
  if (/^(?:~|\.{1,2})\/./.test(value) || /^[A-Za-z]:[\\/]./.test(value)) return { value, kind: "path" };
  if (value.startsWith("/")) {
    // `/compact`-style commands are one segment; routes are not files.
    return /^\/[^/]+\/./.test(value) && !/^\/(?:api|_next)\//.test(value) ? { value, kind: "path" } : null;
  }
  return value.includes("/") && RELATIVE_FILE_RE.test(value.replace(/:\d+(?::\d+)?$/, "")) && !/^[a-z][a-z0-9+.-]*:/i.test(value)
    ? { value, kind: "path" }
    : null;
}

/** `~` / `~/…` against the server's home directory; other paths unchanged. Null while home is unknown. */
export function expandHomePath(filePath: string, home: string | null): string | null {
  if (filePath !== "~" && !filePath.startsWith("~/")) return filePath;
  if (!home) return null;
  return home.replace(/\/+$/, "") + filePath.slice(1);
}
