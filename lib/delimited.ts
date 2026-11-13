/**
 * CSV / TSV parsing for the file viewer's table view (client-safe). RFC 4180 quoting:
 * fields may be wrapped in double quotes, `""` is a literal quote, and quoted fields may
 * contain the delimiter and line breaks. CRLF and LF both end a record; a UTF-8 BOM is
 * dropped. Parsing stops after `maxRows` records so a huge file cannot stall the page.
 */
export interface DelimitedTable {
  rows: string[][];
  /** Widest record, so short rows can be padded. */
  columns: number;
  /** More records follow `rows` in the file. */
  truncated: boolean;
}

export function parseDelimited(text: string, delimiter: string, maxRows: number): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let columns = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const pushRow = () => {
    row.push(field);
    field = "";
    columns = Math.max(columns, row.length);
    rows.push(row);
    row = [];
  };
  for (; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      pushRow();
      if (rows.length >= maxRows) {
        // Anything left besides a final line break means more records.
        return { rows, columns, truncated: /\S/.test(text.slice(i + 1)) };
      }
    } else field += char;
  }
  if (field !== "" || row.length > 0) pushRow();
  return { rows, columns, truncated: false };
}
