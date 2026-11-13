import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { parseDelimited } = await createJiti(import.meta.url).import("./delimited.ts");

test("quoted fields keep delimiters, escaped quotes and line breaks; CRLF and BOM are handled", () => {
  const table = parseDelimited('\ufeffname,note\r\n"Smith, J","said ""hi""\nthen left"\r\nx,\r\n', ",", 10);
  assert.deepEqual(table.rows, [["name", "note"], ["Smith, J", 'said "hi"\nthen left'], ["x", ""]]);
  assert.equal(table.columns, 2);
  assert.equal(table.truncated, false);
});

test("tabs split TSV, ragged rows report the widest record, and the row cap marks truncation", () => {
  const table = parseDelimited("a\tb\tc\n1\t2\n3\t4\t5\n6\n", "\t", 3);
  assert.deepEqual(table.rows, [["a", "b", "c"], ["1", "2"], ["3", "4", "5"]]);
  assert.equal(table.columns, 3);
  assert.equal(table.truncated, true);
  assert.equal(parseDelimited("a\nb\n", ",", 2).truncated, false, "a final line break is not another record");
});
