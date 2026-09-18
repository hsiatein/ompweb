export function sceneTextLines(value: string, measure: (text: string) => number, maxWidth?: number, maxRows?: number, ellipsis = false) {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    if (!maxWidth) { lines.push(paragraph); continue; }
    let line = "";
    for (const word of paragraph.match(/\s+|\S+/gu) || []) {
      if (measure(line + word) <= maxWidth) { line += word; continue; }
      if (line.trimEnd()) { lines.push(line.trimEnd()); line = ""; }
      const trimmed = word.trimStart();
      for (const char of trimmed) {
        if (line && measure(line + char) > maxWidth) { lines.push(line); line = ""; }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  if (maxRows && lines.length > maxRows) {
    lines.length = maxRows;
    if (ellipsis) {
      let last = Array.from(lines[maxRows - 1]);
      while (last.length && maxWidth && measure(last.join("") + "…") > maxWidth) last = last.slice(0, -1);
      lines[maxRows - 1] = last.join("") + "…";
    }
  }
  return lines;
}
