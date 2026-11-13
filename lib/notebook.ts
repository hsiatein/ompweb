import { isRecord } from "./type-guards";

/**
 * Jupyter notebook (nbformat 4) parsing for the file viewer (client-safe). Each output keeps
 * the richest representation the viewer can show, in the order Jupyter front ends prefer:
 * images, HTML, Markdown/LaTeX, JSON, plain text.
 */
export type NotebookOutput =
  | { kind: "stream"; name: string; text: string }
  | { kind: "image"; src: string }
  | { kind: "html"; html: string }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "error"; text: string };

export interface NotebookCell {
  kind: "markdown" | "code" | "raw";
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
}

export interface Notebook {
  language: string;
  cells: NotebookCell[];
}

export class NotebookError extends Error {}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function joined(value: unknown): string {
  if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join("");
  return typeof value === "string" ? value : "";
}

function richOutput(data: Record<string, unknown>): NotebookOutput | null {
  for (const mime of ["image/png", "image/jpeg", "image/gif"]) {
    const payload = joined(data[mime]).replace(/\s+/g, "");
    if (payload) return { kind: "image", src: `data:${mime};base64,${payload}` };
  }
  const svg = joined(data["image/svg+xml"]);
  // An <img> never runs script inside an SVG, so the markup is safe to show this way.
  if (svg) return { kind: "image", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
  const html = joined(data["text/html"]);
  if (html) return { kind: "html", html };
  const markdown = joined(data["text/markdown"]) || joined(data["text/latex"]);
  if (markdown) return { kind: "markdown", text: markdown };
  if (data["application/json"] !== undefined) return { kind: "text", text: JSON.stringify(data["application/json"], null, 2) };
  const plain = joined(data["text/plain"]);
  return plain ? { kind: "text", text: plain } : null;
}

function output(raw: unknown): NotebookOutput | null {
  if (!isRecord(raw)) return null;
  switch (raw.output_type) {
    case "stream":
      return { kind: "stream", name: typeof raw.name === "string" ? raw.name : "stdout", text: joined(raw.text).replace(ANSI, "") };
    case "execute_result":
    case "display_data":
      return isRecord(raw.data) ? richOutput(raw.data) : null;
    case "error": {
      const traceback = joined(Array.isArray(raw.traceback) ? raw.traceback.map((line) => `${line}\n`) : []).replace(ANSI, "").trimEnd();
      return { kind: "error", text: traceback || `${joined(raw.ename)}: ${joined(raw.evalue)}` };
    }
    default:
      return null;
  }
}

export function parseNotebook(text: string): Notebook {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new NotebookError("Not valid JSON");
  }
  if (!isRecord(raw) || !Array.isArray(raw.cells)) {
    throw new NotebookError(isRecord(raw) && Array.isArray(raw.worksheets) ? "nbformat 3 notebooks are not supported" : "Not a Jupyter notebook");
  }
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  const languageInfo = isRecord(metadata.language_info) ? metadata.language_info : {};
  const kernelspec = isRecord(metadata.kernelspec) ? metadata.kernelspec : {};
  const language = (typeof languageInfo.name === "string" && languageInfo.name)
    || (typeof kernelspec.language === "string" && kernelspec.language)
    || "python";
  const cells = raw.cells.filter(isRecord).map((cell): NotebookCell => {
    const kind = cell.cell_type === "markdown" || cell.cell_type === "raw" ? cell.cell_type : "code";
    return {
      kind,
      source: joined(cell.source),
      executionCount: typeof cell.execution_count === "number" ? cell.execution_count : null,
      outputs: kind === "code" && Array.isArray(cell.outputs)
        ? cell.outputs.map(output).filter((item): item is NotebookOutput => item !== null)
        : [],
    };
  });
  return { language: language.toLowerCase(), cells };
}
