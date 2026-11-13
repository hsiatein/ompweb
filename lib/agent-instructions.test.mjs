import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveAgentInstructions, agentInstructionTexts, parseAgentInstructionRule, AgentInstructionValidationError,
  MAX_AGENT_INSTRUCTION_LENGTH } = await jiti.import("./agent-instructions.ts");
const { saveAgentInstruction, loadAgentInstructions, agentInstructionsPath } = await jiti.import("./agent-instructions-store.ts");
const globalRule = { scope: "global", text: "Global style" };
const providerRule = { scope: "provider", provider: "provider-a", text: "Provider style" };
const modelRule = { scope: "model", provider: "provider-a", modelId: "org/model", text: "Model style" };

test("the most specific exact scope wins independently of ordering and other providers' model IDs", () => {
  const rules = [modelRule, globalRule, providerRule];
  assert.deepEqual(resolveAgentInstructions(rules, "provider-a", "org/model"), [modelRule]);
  assert.deepEqual(resolveAgentInstructions(rules, "provider-a", "other"), [providerRule]);
  assert.deepEqual(resolveAgentInstructions(rules, "provider-b", "org/model"), [globalRule]);
  assert.deepEqual(resolveAgentInstructions(rules, "PROVIDER-A", "org/model"), [globalRule]);
  assert.deepEqual(resolveAgentInstructions([], "provider-a", "org/model"), []);
});

test("an explicit empty rule suppresses broader instructions; missing rules inherit", () => {
  const emptyModel = { ...modelRule, text: "" };
  const emptyProvider = { ...providerRule, text: "" };
  assert.deepEqual(agentInstructionTexts([globalRule, providerRule, emptyModel], "provider-a", "org/model"), []);
  assert.deepEqual(agentInstructionTexts([globalRule, emptyProvider], "provider-a", "org/model"), []);
  assert.deepEqual(agentInstructionTexts([globalRule, providerRule], "provider-a", "org/model"), [providerRule.text]);
  assert.equal(parseAgentInstructionRule({ ...modelRule, text: "  Keep formatting\n" }).text, "  Keep formatting\n");
});

test("appending rules stack onto the broader effective chain until a replacing or blocking level", () => {
  const appendModel = { ...modelRule, combine: "append" };
  const appendProvider = { ...providerRule, combine: "append" };
  assert.deepEqual(agentInstructionTexts([globalRule, providerRule, appendModel], "provider-a", "org/model"), ["Provider style", "Model style"]);
  assert.deepEqual(agentInstructionTexts([globalRule, appendProvider, appendModel], "provider-a", "org/model"), ["Global style", "Provider style", "Model style"]);
  assert.deepEqual(agentInstructionTexts([globalRule, appendModel], "provider-a", "org/model"), ["Global style", "Model style"], "a missing provider level is skipped");
  assert.deepEqual(agentInstructionTexts([globalRule, { ...providerRule, text: "" }, appendModel], "provider-a", "org/model"), ["Model style"], "a blocking level stops the walk");
  assert.deepEqual(agentInstructionTexts([globalRule, appendProvider, modelRule], "provider-a", "org/model"), ["Model style"], "a replacing model rule ignores its parents' mode");
  assert.equal(parseAgentInstructionRule({ ...globalRule, combine: "append" }).combine, undefined, "global has nothing to append to");
  assert.equal(parseAgentInstructionRule({ ...providerRule, text: "", combine: "append" }).combine, undefined, "empty text stays a block");
  assert.equal("combine" in parseAgentInstructionRule({ ...providerRule, combine: "replace" }), false);
  assert.throws(() => parseAgentInstructionRule({ ...providerRule, combine: "merge" }), AgentInstructionValidationError);
});

test("rule validation rejects incomplete scopes and invalid prompt text before persistence", () => {
  for (const value of [null, [], { scope: "unknown", text: "x" }, { ...modelRule, provider: "" },
    { ...modelRule, modelId: "\n" }, { ...providerRule, provider: "a\u0000b" },
    { ...globalRule, text: null }, { ...globalRule, text: "a\0b" },
    { ...globalRule, text: "a".repeat(MAX_AGENT_INSTRUCTION_LENGTH + 1) }]) {
    assert.throws(() => parseAgentInstructionRule(value), AgentInstructionValidationError);
  }
  assert.deepEqual(parseAgentInstructionRule({ ...modelRule, provider: " provider-a ", modelId: " org/model " }), modelRule);
});

test("per-scope saves retain other scopes, deletions restore inheritance, and corruption is never overwritten", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-instruction-rules-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  saveAgentInstruction(globalRule, globalRule.text);
  saveAgentInstruction(providerRule, providerRule.text);
  saveAgentInstruction(modelRule, "");
  assert.deepEqual(loadAgentInstructions(), [globalRule, providerRule, { ...modelRule, text: "" }]);
  saveAgentInstruction(providerRule, "Updated provider");
  assert.deepEqual(agentInstructionTexts(loadAgentInstructions(), "provider-a", "org/model"), []);
  saveAgentInstruction(modelRule, "Model extra", "append");
  assert.deepEqual(agentInstructionTexts(loadAgentInstructions(), "provider-a", "org/model"), ["Updated provider", "Model extra"]);
  saveAgentInstruction(modelRule, null);
  assert.deepEqual(loadAgentInstructions(), [globalRule, { ...providerRule, text: "Updated provider" }]);
  assert.deepEqual(agentInstructionTexts(loadAgentInstructions(), "provider-a", "org/model"), ["Updated provider"]);
  if (process.platform !== "win32") assert.equal(statSync(agentInstructionsPath()).mode & 0o777, 0o600);
  const corrupt = "{broken-json";
  writeFileSync(agentInstructionsPath(), corrupt);
  assert.throws(() => saveAgentInstruction(globalRule, "Replacement"), /Could not read saved agent instructions/);
  assert.equal(readFileSync(agentInstructionsPath(), "utf8"), corrupt);
  writeFileSync(agentInstructionsPath(), JSON.stringify([globalRule, { ...globalRule, text: "Duplicate" }]));
  assert.throws(() => loadAgentInstructions(), /Could not read saved agent instructions/);
});
