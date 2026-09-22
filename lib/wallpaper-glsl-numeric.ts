import tokenize from "glsl-tokenizer/string";

type Expression = { text: string; type?: string; changed: boolean; start: number; end: number };
const numeric = /^(?:float|int|uint|vec[234])$/;
const integral = (type?: string) => type === "int" || type === "uint";
const floating = (type?: string) => type === "float" || /^vec[234]$/.test(type || "");

// Lower only expressions whose operand types are known. Unknown syntax and
// conditional declarations remain untouched for the shader compiler to diagnose.
export function lowerSceneNumericExpressions(source: string, combos: Record<string, number>) {
  let offset = 0;
  const tokens = tokenize(source).map(t => {
    const start = offset; offset += t.type === "eof" ? 0 : t.data.length;
    return { ...t, start, end: offset };
  }).filter(t => !["whitespace", "line-comment", "block-comment", "preprocessor", "eof"].includes(t.type));
  const macros = new Map<string, string>(Object.keys(combos).map(k => [k, "int"]));
  for (const m of source.matchAll(/^\s*#define\s+(\w+)\s+(-?\d+)[uU]?\s*$/gm)) macros.set(m[1], "int");
  const scopes = [macros, new Map<string, string>()];
  const lookup = (name: string) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); };
  const functionTypes = new Map<string, string>(), parameters = new Map<number, Map<string, string>>();
  const edits: { start: number; end: number; text: string }[] = [];
  const conditions = new Map<number, number>();
  for (let i = 0; i < tokens.length; i++) {
    if (!["for", "if", "while"].includes(tokens[i].data) || tokens[i + 1]?.data !== "(") continue;
    let depth = 1, end = i + 2;
    const separators: number[] = [];
    for (; end < tokens.length; end++) {
      if (tokens[end].data === "(") depth++;
      if (tokens[end].data === ")" && --depth === 0) break;
      if (tokens[end].data === ";" && depth === 1) separators.push(end);
    }
    if (end >= tokens.length) continue;
    if (tokens[i].data === "for") {
      if (separators.length === 2) conditions.set(separators[0] + 1, separators[1]);
    } else conditions.set(i + 2, end);
  }
  let remainder = false;
  const precedence: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "<": 4, ">": 4, "<=": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };

  function expression(first: number, last: number): Expression | undefined {
    let cursor = first, depth = 0;
    const raw = (start: number, end: number) => source.slice(start, end);
    function parse(minimum = 0): Expression | undefined {
      if (++depth > 64) return undefined;
      const token = tokens[cursor++]; if (!token || cursor > last) return undefined;
      let value: Expression = { text: token.data, type: undefined, changed: false, start: token.start, end: token.end };
      if (["+", "-", "!"].includes(token.data)) {
        const right = parse(7); if (!right) return undefined;
        value = { ...value, text: token.data + right.text, type: token.data === "!" ? "bool" : right.type, changed: right.changed, end: right.end };
      } else if (token.data === "(") {
        const inner = parse(); if (!inner || tokens[cursor]?.data !== ")") return undefined;
        value = { ...value, text: `(${inner.text})`, type: inner.type, changed: inner.changed, end: tokens[cursor++].end };
      } else if (token.type === "integer") value.type = /u$/i.test(token.data) ? "uint" : "int";
      else if (token.type === "float") value.type = "float";
      else if (/^[a-zA-Z_]\w*$/.test(token.data)) {
        if (tokens[cursor]?.data === "(") {
          cursor++; const args: Expression[] = [];
          while (cursor < last && tokens[cursor].data !== ")") {
            const arg = parse(); if (!arg) return undefined; args.push(arg);
            if (tokens[cursor]?.data !== ",") break; cursor++;
          }
          if (tokens[cursor]?.data !== ")") return undefined;
          value.end = tokens[cursor++].end;
          value.type = numeric.test(token.data) ? token.data : functionTypes.get(token.data);
          if (/^(?:floor|ceil|round|trunc|abs|sin|cos|sqrt|fract|frac|saturate|normalize|min|max|mix|lerp|clamp)$/.test(token.data)) value.type = args[0]?.type;
          if (token.data === "step") value.type = args[1]?.type;
          if (token.data === "smoothstep") value.type = args[2]?.type;
          if (/^(?:length|distance|dot)$/.test(token.data)) value.type = "float";
          value.changed = args.some(a => a.changed);
          value.text = `${token.data}(${args.map(a => a.text).join(", ")})`;
        } else value.type = lookup(token.data);
      } else return undefined;
      while (cursor < last && [".", "["].includes(tokens[cursor].data)) {
        if (tokens[cursor++].data === ".") {
          const field = tokens[cursor++]; if (!field || !/^[xyzwrgba]{1,4}$/.test(field.data)) return undefined;
          value.text += "." + field.data; value.end = field.end;
          value.type = field.data.length === 1 ? "float" : `vec${field.data.length}`;
        } else {
          const index = parse(); if (!index || tokens[cursor]?.data !== "]") return undefined;
          value.end = tokens[cursor++].end; value.changed ||= index.changed;
          value.text += `[${index.text}]`;
        }
      }
      if (!value.changed) value.text = raw(value.start, value.end);
      while (cursor < last) {
        const operator = tokens[cursor].data, rank = precedence[operator];
        if (rank === undefined || rank < minimum) break;
        cursor++; const right = parse(rank + 1); if (!right) return undefined;
        let leftText = value.text, rightText = right.text, type = value.type, changed = value.changed || right.changed;
        if (floating(value.type) && integral(right.type)) { rightText = `float(${rightText})`; changed = true; }
        else if (integral(value.type) && floating(right.type)) { leftText = `float(${leftText})`; type = right.type; changed = true; }
        else if (value.type === "uint" && right.type === "int") { rightText = `uint(${rightText})`; changed = true; }
        else if (value.type === "int" && right.type === "uint") { leftText = `uint(${leftText})`; type = "uint"; changed = true; }
        if (!value.type || !right.type) type = undefined;
        if (rank < 5) type = "bool";
        let text = `${leftText} ${operator} ${rightText}`;
        if (operator === "%" && type === "float") {
          text = `we_scene_remainder(${leftText}, ${rightText})`; remainder = changed = true;
        }
        value = { text: changed ? text : raw(value.start, right.end), type, changed, start: value.start, end: right.end };
      }
      depth--; return value;
    }
    const result = parse(); return cursor === last ? result : undefined;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const conditionEnd = conditions.get(i);
    if (conditionEnd !== undefined && conditionEnd > i) {
      const value = expression(i, conditionEnd);
      if (value?.changed && !source.slice(value.start, value.end).includes("#")) edits.push({ start: value.start, end: value.end, text: value.text });
      i = conditionEnd - 1;
      continue;
    }
    if (token.data === "{") { scopes.push(parameters.get(i) || new Map()); continue; }
    if (token.data === "}") { if (scopes.length > 2) scopes.pop(); continue; }
    if (!(numeric.test(token.data) || token.data === "void") || tokens[i + 1]?.type !== "ident") continue;
    const type = token.data, name = tokens[i + 1].data;
    if (tokens[i + 2]?.data === "(") {
      functionTypes.set(name, type); const args = new Map<string, string>();
      let end = i + 3;
      while (end < tokens.length && tokens[end].data !== ")") {
        if (numeric.test(tokens[end].data) && tokens[end + 1]?.type === "ident") args.set(tokens[end + 1].data, tokens[end].data);
        end++;
      }
      if (tokens[end + 1]?.data === "{") parameters.set(end + 1, args);
      i = end; continue;
    }
    scopes.at(-1)!.set(name, type);
    if (tokens[i + 2]?.data !== "=") continue;
    let end = i + 3, nesting = 0;
    for (; end < tokens.length; end++) {
      const word = tokens[end].data;
      if (!nesting && [";", ","].includes(word)) break;
      if (["(", "["].includes(word)) nesting++;
      if ([")", "]"].includes(word)) { if (!nesting) break; nesting--; }
    }
    const start = tokens[i + 3]?.start, finish = tokens[end - 1]?.end;
    if (start === undefined || finish === undefined || source.slice(start, finish).includes("#")) continue;
    const value = expression(i + 3, end); if (!value) continue;
    if (integral(type) && value.type && value.type !== type && numeric.test(value.type)) { value.text = `${type}(${value.text})`; value.changed = true; }
    if (type === "float" && integral(value.type)) { value.text = `float(${value.text})`; value.changed = true; }
    if (value.changed) edits.push({ start, end: finish, text: value.text });
    i = end - 1;
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return (remainder ? "float we_scene_remainder(float x, float y) { return x - y * trunc(x / y); }\n" : "") + source;
}
