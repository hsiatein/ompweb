"use client";

import { memo, useMemo, useState } from "react";
import { useTheme } from "@/hooks/useTheme";
import { parseDelimited } from "@/lib/delimited";
import { useI18n } from "@/lib/i18n";
import { NotebookError, parseNotebook, type NotebookCell, type NotebookOutput } from "@/lib/notebook";
import { SyntaxHighlighter, vs, vscDarkPlus } from "@/lib/syntax-highlight";
import { MarkdownBody } from "./MarkdownBody";

/**
 * Rendered previews for structured text files in the file viewer: CSV/TSV as a table and
 * Jupyter notebooks as cells. Source view and editing stay in FileViewer.
 */

const MAX_TABLE_ROWS = 5000;

export const DelimitedPreview = memo(function DelimitedPreview({ content, delimiter }: { content: string; delimiter: string }) {
  const { t } = useI18n();
  const table = useMemo(() => parseDelimited(content, delimiter, MAX_TABLE_ROWS + 1), [content, delimiter]);
  const [header, ...body] = table.rows;
  const shown = body.slice(0, MAX_TABLE_ROWS);
  const more = table.truncated || body.length > MAX_TABLE_ROWS;
  if (!header) return <div className="file-preview-empty">{t("fileViewer.emptyTable")}</div>;
  const pad = (row: string[]) => (row.length < table.columns ? [...row, ...Array(table.columns - row.length).fill("")] : row);
  return (
    <div className="file-table-preview">
      <table>
        <thead>
          <tr><th className="file-table-index">#</th>{pad(header).map((cell, index) => <th key={index} title={cell}>{cell}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r}>
              <td className="file-table-index">{r + 1}</td>
              {pad(row).map((cell, c) => <td key={c} title={cell.length > 80 ? cell : undefined}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {more && <div className="file-preview-note">{t("fileViewer.tableTruncated", { rows: MAX_TABLE_ROWS })}</div>}
    </div>
  );
});

function NotebookOutputView({ output }: { output: NotebookOutput }) {
  const [height, setHeight] = useState(48);
  switch (output.kind) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element -- data URI from the notebook, not an optimisable asset
      return <img className="notebook-output-image" src={output.src} alt="" />;
    case "html":
      // No scripts run (sandbox without allow-scripts); same-origin only lets us size it to its content.
      return (
        <iframe
          className="notebook-output-html"
          sandbox="allow-same-origin"
          srcDoc={`<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px system-ui,sans-serif}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:2px 6px}</style>${output.html}`}
          style={{ height }}
          onLoad={(event) => {
            const doc = event.currentTarget.contentDocument;
            // body, not documentElement: the latter is never shorter than the iframe itself.
            if (doc?.body) setHeight(Math.min(doc.body.scrollHeight + 4, 600));
          }}
          title="output"
        />
      );
    case "markdown":
      return <MarkdownBody className="notebook-output-markdown" suppressImages>{output.text}</MarkdownBody>;
    case "error":
      return <pre className="notebook-output-text" data-error="true">{output.text}</pre>;
    case "stream":
      return <pre className="notebook-output-text" data-stderr={output.name === "stderr" || undefined}>{output.text}</pre>;
    default:
      return <pre className="notebook-output-text">{output.text}</pre>;
  }
}

function NotebookCellView({ cell, language, isDark }: { cell: NotebookCell; language: string; isDark: boolean }) {
  if (cell.kind === "markdown") {
    return <div className="notebook-cell" data-kind="markdown"><MarkdownBody className="markdown-file-preview">{cell.source}</MarkdownBody></div>;
  }
  if (cell.kind === "raw") {
    return <div className="notebook-cell" data-kind="raw"><pre className="notebook-output-text">{cell.source}</pre></div>;
  }
  return (
    <div className="notebook-cell" data-kind="code">
      <div className="notebook-prompt">[{cell.executionCount ?? " "}]</div>
      <div className="notebook-cell-body">
        <SyntaxHighlighter
          language={language}
          style={isDark ? vscDarkPlus : vs}
          customStyle={{ margin: 0, padding: "8px 10px", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", fontSize: 12.5 }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        >
          {cell.source}
        </SyntaxHighlighter>
        {cell.outputs.length > 0 && (
          <div className="notebook-outputs">
            {cell.outputs.map((output, index) => <NotebookOutputView key={index} output={output} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export const NotebookPreview = memo(function NotebookPreview({ content }: { content: string }) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const parsed = useMemo(() => {
    try {
      return { notebook: parseNotebook(content) };
    } catch (error) {
      return { error: error instanceof NotebookError ? error.message : String(error) };
    }
  }, [content]);
  if (!parsed.notebook) return <div className="file-preview-empty">{t("fileViewer.notebookInvalid", { reason: parsed.error ?? "" })}</div>;
  const { notebook } = parsed;
  return (
    <div className="notebook-preview">
      {notebook.cells.map((cell, index) => <NotebookCellView key={index} cell={cell} language={notebook.language} isDark={isDark} />)}
    </div>
  );
});
