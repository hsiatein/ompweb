import tokenize from "glsl-tokenizer/string";
import { lowerSceneNumericExpressions } from "./wallpaper-glsl-numeric";

// Fragment varyings are read-only in GLSL, while WE's HLSL shaders may mutate
// their per-fragment copies, including from helper functions.
export function browserFragmentGlsl(source: string) {
  const tokens = tokenize(source);
  const significant = tokens.filter(t => !["whitespace", "line-comment", "block-comment", "preprocessor", "eof"].includes(t.type));
  const copies: string[] = [];
  for (let i = 0; i < significant.length; i++) {
    if (significant[i].data !== "varying" || significant[i + 2]?.type !== "ident" || significant[i + 3]?.data !== ";") continue;
    const declaration = significant[i + 2], name = declaration.data, type = significant[i + 1].data;
    const written = significant.some((t, j) => {
      if (t.data !== name || t === declaration) return false;
      let end = j + 1;
      if (significant[end]?.data === ".") end += 2;
      if (significant[end]?.data === "[") { while (end < significant.length && significant[end].data !== "]") end++; end++; }
      return ["=", "+=", "-=", "*=", "/=", "++", "--"].includes(significant[end]?.data);
    });
    if (!written) continue;
    let copy = `we_mutable_${name}`;
    while (significant.some(t => t.data === copy)) copy += "_";
    for (const t of tokens) if (t.type === "ident" && t.data === name && t !== declaration) t.data = copy;
    significant[i + 3].data += `\n${type} ${copy};`;
    copies.push(`${copy}=${name};`);
  }
  if (!copies.length) return source;
  return tokens.filter(t => t.type !== "eof").map(t => t.data).join("").replace(/void\s+main\s*\(\s*(?:void\s*)?\)\s*\{/, match => match + copies.join(""));
}

export function sceneAudioUniforms(source: string, combos: Record<string, number>) {
  const stack: { disabled: boolean; audioBranch: boolean }[] = [];
  const lines = source.split(/\r?\n/).filter(line => {
    if (/^\s*#if(?:def|ndef)?\b/.test(line)) stack.push({ disabled: false, audioBranch: false });
    const top = stack.at(-1);
    if (/^\s*#if\s+AUDIOPROCESSING\s*$/.test(line) && top) { top.audioBranch = true; top.disabled = !combos.AUDIOPROCESSING; }
    if (/^\s*#else\b/.test(line) && top?.audioBranch) top.disabled = !top.disabled;
    if (/^\s*#elif\b/.test(line) && top?.audioBranch) { top.disabled = false; top.audioBranch = false; }
    if (/^\s*#endif\b/.test(line)) stack.pop();
    return !stack.some(s => s.disabled);
  }).join("\n");
  return [...lines.matchAll(/uniform\s+float\s+(g_AudioSpectrum(?:16|32|64)(?:Left|Right))\s*\[(16|32|64)\]/g)];
}

// WE accepts HLSL-style scalar promotion; GLSL ES requires floating operands.
// Supported effects use floating arithmetic, with integer array indices and
// preprocessor conditions. Tokenization leaves those and metadata untouched.
export function browserEffectGlsl(source: string, combos: Record<string, number> = {}) {
  // A few exported shaders contain an orphan #endif. It closes no branch and
  // can be removed without changing which instructions belong to a condition.
  let conditionalDepth = 0;
  source = source.split(/\r?\n/).map(line => {
    if (/^\s*#if(?:def|ndef)?\b/.test(line)) conditionalDepth++;
    if (/^\s*#endif\b/.test(line)) { if (!conditionalDepth) return ""; conditionalDepth--; }
    return line;
  }).join("\n");
  // Some community shaders use a runtime value in a redundant preprocessor
  // branch. Equal branches can be folded without interpreting that value.
  source = source.replace(/^\s*#if[^\r\n]*\r?\n([^\r\n]+)\r?\n\s*#else\s*\r?\n\1\r?\n\s*#endif/gm, "$1");
  const counters = new Set([...source.matchAll(/for\s*\(\s*int\s+(\w+)\s*=/g)].map(m => m[1]));
  // Legacy ray/blur shaders use integer loop counters in floating expressions.
  // These bounded sampling loops do not perform bitwise or integer division.
  source = source.replace(/for\s*\(\s*int\s+(\w+)\s*=/g, "for (float $1 =");
  source = source.replace(/const\s+int\s+(\w+)\s*=/g, (declaration, name) => new RegExp(`\\[\\s*${name}\\s*\\]`).test(source) ? declaration : `const float ${name} =`);
  const tokens = tokenize(source);
  // Shared blur helpers may precede an unconditional sampler declaration.
  // GLSL needs that declaration before the first use (unlike WE's HLSL path).
  let branchDepth = 0;
  const samplers: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "preprocessor") {
      if (/^#\s*if(?:def|ndef)?\b/.test(t.data)) branchDepth++;
      if (/^#\s*endif\b/.test(t.data)) branchDepth--;
    }
    if (branchDepth || t.data !== "uniform") continue;
    let end = i;
    while (end < tokens.length && tokens[end].data !== ";") end++;
    const declaration = tokens.slice(i, end + 1).filter(t => t.type !== "whitespace");
    if (declaration.length !== 4 || declaration[1].data !== "sampler2D") continue;
    if (!tokens.slice(0, i).some(t => t.type === "ident" && t.data === declaration[2].data)) continue;
    samplers.push(tokens.slice(i, end + 1).map(t => t.data).join(""));
    for (let j = i; j <= end; j++) tokens[j].data = "";
  }
  const significant = tokens.filter(t => !["whitespace", "line-comment", "block-comment", "preprocessor", "eof"].includes(t.type));
  // GLSL has max(vector, scalar), but not the reversed HLSL overload. Swapping
  // literal-first min/max arguments is exact and does not need type inference.
  significant.forEach((t, i) => {
    if (!["min", "max"].includes(t.data) || significant[i + 1]?.data !== "(") return;
    let comma = i + 2;
    if (["+", "-"].includes(significant[comma]?.data)) comma++;
    if (!["float", "integer"].includes(significant[comma]?.type) || significant[comma + 1]?.data !== ",") return;
    comma++;
    let end = comma + 1, depth = 0;
    for (; end < significant.length; end++) {
      if (significant[end].data === "(") depth++;
      if (significant[end].data === ")") { if (!depth) break; depth--; }
    }
    if (end >= significant.length) return;
    // Retain token identities for the type fixes below; evaluate each operand once.
    const first = tokens.indexOf(significant[i + 2]), split = tokens.indexOf(significant[comma]), last = tokens.indexOf(significant[end]);
    const left = tokens.slice(first, split), right = tokens.slice(split + 1, last);
    tokens.splice(first, last - first, ...right, significant[comma], ...left);
  });
  const integerInitializers = new Set<object>();
  significant.forEach((t, i) => {
    if (!["int", "uint"].includes(t.data) || significant[i + 1]?.type !== "ident" || significant[i + 2]?.data !== "=") return;
    let depth = 0;
    for (let j = i + 3; j < significant.length; j++) {
      const value = significant[j].data;
      if (!depth && [";", ","].includes(value)) break;
      if (["(", "["].includes(value)) depth++;
      if ([")", "]"].includes(value)) { if (!depth) break; depth--; }
      integerInitializers.add(significant[j]);
    }
  });
  const scopes = [new Map<string, number>()];
  const parameters = new Map<object, Map<string, number>>(), parameterTokens = new Set<object>();
  const widthOf = (name: string) => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name); };
  const narrowed = new Map<object, number>();
  significant.forEach((t, i) => {
    if (t.data === "{") scopes.push(parameters.get(t) || new Map());
    if (t.data === "}" && scopes.length > 1) scopes.pop();
    if (/^(?:vec[234]|float|int|void)$/.test(t.data) && significant[i + 1]?.type === "ident" && !parameterTokens.has(t)) {
      if (significant[i + 2]?.data === "(") {
        const args = new Map<string, number>(); let j = i + 3, depth = 1;
        for (; j < significant.length && depth; j++) {
          const token = significant[j]; parameterTokens.add(token);
          if (token.data === "(") depth++; if (token.data === ")") depth--;
          if (/^(?:vec[234]|float|int)$/.test(token.data) && significant[j + 1]?.type === "ident") args.set(significant[j + 1].data, Number(token.data[3]) || 1);
        }
        if (significant[j]?.data === "{") parameters.set(significant[j], args);
      } else {
        const width = Number(t.data[3]) || 1; scopes.at(-1)!.set(significant[i + 1].data, width);
        let depth = 0;
        for (let j = i + 2; j < significant.length && significant[j].data !== ";"; j++) {
          const value = significant[j].data;
          if (value === "(") depth++; else if (value === ")") { if (!depth) break; depth--; }
          else if (value === "," && !depth && significant[j + 1]?.type === "ident") scopes.at(-1)!.set(significant[j + 1].data, width);
        }
      }
    }
    if (t.data !== "=") return;
    const width = widthOf(significant[i - 1]?.data), operand = significant[i + 1];
    if (width && operand && (widthOf(operand.data) || 0) > width && ["*", "+", "-", "/", ";"].includes(significant[i + 2]?.data)) narrowed.set(operand, width);
    if (width && width > 1 && operand && ["float", "integer"].includes(operand.type) && [",", ";"].includes(significant[i + 2]?.data)) narrowed.set(operand, -width);
  });
  let brackets = 0;
  const converted = (samplers.length ? samplers.join("\n") + "\n" : "") + tokens.map(token => {
    if (brackets && token.type === "ident" && counters.has(token.data)) return `int(${token.data})`;
    if (narrowed.has(token)) {
      const width = narrowed.get(token)!;
      if (width < 0) return `vec${-width}(${token.type === "integer" ? token.data + ".0" : token.data.replace(/[fF]$/, "")})`;
      return `${token.data}.${"xyzw".slice(0, width)}`;
    }
    if (token.type === "ident" && ["sample", "input", "output"].includes(token.data)) return `we_${token.data}`;
    if (token.type === "ident" && token.data === "lerp") return "mix";
    if (token.type === "float") return token.data.replace(/[fF]$/, "");
    if (token.type === "operator") {
      if (token.data === "[") brackets++;
      if (token.data === "]") brackets--;
    }
    return token.type === "integer" && !brackets && !integerInitializers.has(token) && /^\d+$/.test(token.data) ? `${token.data}.0` : token.type === "eof" ? "" : token.data;
  }).join("");
  return lowerSceneNumericExpressions(converted, combos);
}
