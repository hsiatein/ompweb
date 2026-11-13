export type AgentInstructionTarget =
  | { scope: "global" }
  | { scope: "provider"; provider: string }
  | { scope: "model"; provider: string; modelId: string };

/**
 * How a provider/model rule relates to the broader level: replace (default, stored as an absent field)
 * or append (the broader effective instructions apply too, this text after them).
 */
export type AgentInstructionCombine = "replace" | "append";

export type AgentInstructionRule = AgentInstructionTarget & { text: string; combine?: "append" };

export const MAX_AGENT_INSTRUCTION_LENGTH = 20_000;
export const MAX_AGENT_INSTRUCTION_RULES = 100;

export class AgentInstructionValidationError extends Error {}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new AgentInstructionValidationError(`Invalid ${name}`);
  }
  return value.trim();
}

export function parseAgentInstructionTarget(value: unknown): AgentInstructionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentInstructionValidationError("Expected an instruction rule");
  }
  const target = value as Record<string, unknown>;
  if (target.scope === "global") return { scope: "global" };
  if (target.scope === "provider") return { scope: "provider", provider: identifier(target.provider, "provider") };
  if (target.scope === "model") {
    return { scope: "model", provider: identifier(target.provider, "provider"), modelId: identifier(target.modelId, "model ID") };
  }
  throw new AgentInstructionValidationError("Invalid instruction scope");
}

export function parseAgentInstructionRule(value: unknown): AgentInstructionRule {
  const target = parseAgentInstructionTarget(value);
  const { text } = value as Record<string, unknown>;
  if (typeof text !== "string" || text.length > MAX_AGENT_INSTRUCTION_LENGTH || text.includes("\0")) {
    throw new AgentInstructionValidationError(`Instructions must be text of at most ${MAX_AGENT_INSTRUCTION_LENGTH} characters`);
  }
  const { combine } = value as Record<string, unknown>;
  if (combine !== undefined && combine !== "replace" && combine !== "append") {
    throw new AgentInstructionValidationError("combine must be replace or append");
  }
  // Empty text is an explicit override, not an absent rule. Appending applies only below global
  // and to non-empty text (an empty appending rule would just be inheritance).
  return { ...target, text, ...(combine === "append" && target.scope !== "global" && text ? { combine } : {}) };
}

export function sameInstructionTarget(a: AgentInstructionTarget, b: AgentInstructionTarget): boolean {
  return a.scope === b.scope
    && (a.scope === "global" || (b.scope !== "global" && a.provider === b.provider))
    && (a.scope !== "model" || (b.scope === "model" && a.modelId === b.modelId));
}

/**
 * Rules that apply for an exact provider + model identity, broadest first. The most specific saved
 * rule always applies; it pulls in the next broader level's rules only when it appends. A replacing
 * rule (including an empty one, which blocks) stops the walk. Empty list: nothing applies.
 */
export function resolveAgentInstructions(
  rules: readonly AgentInstructionRule[],
  provider?: string,
  modelId?: string,
): AgentInstructionRule[] {
  let globalRule: AgentInstructionRule | undefined;
  let providerRule: AgentInstructionRule | undefined;
  let modelRule: AgentInstructionRule | undefined;
  for (const rule of rules) {
    if (rule.scope === "global") globalRule = rule;
    else if (rule.provider === provider) {
      if (rule.scope === "model" && rule.modelId === modelId) modelRule = rule;
      if (rule.scope === "provider") providerRule = rule;
    }
  }
  const applied: AgentInstructionRule[] = [];
  for (const rule of [modelRule, providerRule, globalRule]) {
    if (!rule) continue;
    applied.unshift(rule);
    if (rule.combine !== "append") break;
  }
  return applied;
}

/** The prompt texts to append to the system prompt, broadest first. */
export function agentInstructionTexts(rules: readonly AgentInstructionRule[], provider?: string, modelId?: string): string[] {
  return resolveAgentInstructions(rules, provider, modelId).map((rule) => rule.text).filter(Boolean);
}
