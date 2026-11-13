import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { parseNotebook, NotebookError } = await createJiti(import.meta.url).import("./notebook.ts");

test("cells keep their sources and outputs pick the richest representation", () => {
  const notebook = parseNotebook(JSON.stringify({
    nbformat: 4,
    metadata: { language_info: { name: "Julia" } },
    cells: [
      { cell_type: "markdown", source: ["# Title\n", "text"] },
      { cell_type: "code", execution_count: 3, source: "x = 1", outputs: [
        { output_type: "stream", name: "stdout", text: ["\u001b[31mred\u001b[0m\n"] },
        { output_type: "execute_result", data: { "text/plain": "df", "text/html": "<table></table>" } },
        { output_type: "display_data", data: { "image/png": "iVBO\nRw==", "text/plain": "<Figure>" } },
        { output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[0;31mTraceback\u001b[0m", "ValueError: bad"] },
        { output_type: "unknown" },
      ] },
      { cell_type: "code", execution_count: null, source: [], outputs: [] },
    ],
  }));
  assert.equal(notebook.language, "julia");
  assert.equal(notebook.cells[0].source, "# Title\ntext");
  assert.deepEqual(notebook.cells[1].outputs, [
    { kind: "stream", name: "stdout", text: "red\n" },
    { kind: "html", html: "<table></table>" },
    { kind: "image", src: "data:image/png;base64,iVBORw==" },
    { kind: "error", text: "Traceback\nValueError: bad" },
  ]);
  assert.equal(notebook.cells[1].executionCount, 3);
  assert.equal(notebook.cells[2].executionCount, null);
});

test("invalid and nbformat 3 notebooks are reported, not rendered", () => {
  assert.throws(() => parseNotebook("{"), NotebookError);
  assert.throws(() => parseNotebook(JSON.stringify({ worksheets: [] })), /nbformat 3/);
});
