import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "./omp/paths";
import {
  AgentInstructionValidationError, MAX_AGENT_INSTRUCTION_RULES,
  parseAgentInstructionRule, sameInstructionTarget,
  type AgentInstructionCombine, type AgentInstructionRule, type AgentInstructionTarget,
} from "./agent-instructions";

export function agentInstructionsPath(): string {
  return join(getAgentDir(), "omp-web-agent-instructions.json");
}

/** No process-local cache: running OMP children read the latest atomic save at prompt preparation. */
export function loadAgentInstructions(file = agentInstructionsPath()): AgentInstructionRule[] {
  let content: string;
  try { content = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const data: unknown = JSON.parse(content);
    if (!Array.isArray(data) || data.length > MAX_AGENT_INSTRUCTION_RULES) throw new Error("Invalid rule list");
    const rules = data.map(parseAgentInstructionRule);
    for (let i = 0; i < rules.length; i++) {
      for (let j = 0; j < i; j++) {
        if (sameInstructionTarget(rules[j], rules[i])) throw new Error("Duplicate instruction scope");
      }
    }
    return rules;
  } catch (error) {
    // Do not mistake corrupt on-disk data for a bad HTTP request, or overwrite it with defaults.
    throw new Error("Could not read saved agent instructions", { cause: error });
  }
}

/** Update one scope, retaining other editors' scopes. null deletes; empty text overrides. */
export function saveAgentInstruction(
  target: AgentInstructionTarget,
  text: string | null,
  combine: AgentInstructionCombine = "replace",
): AgentInstructionRule[] {
  const file = agentInstructionsPath();
  const rules = loadAgentInstructions(file);
  const index = rules.findIndex((rule) => sameInstructionTarget(rule, target));
  if (text === null) {
    if (index < 0) return rules;
    rules.splice(index, 1);
  } else {
    const rule = parseAgentInstructionRule({ ...target, text, combine });
    if (index >= 0) rules[index] = rule;
    else {
      if (rules.length >= MAX_AGENT_INSTRUCTION_RULES) throw new AgentInstructionValidationError("Too many instruction rules");
      rules.push(rule);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(rules, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  return rules;
}
