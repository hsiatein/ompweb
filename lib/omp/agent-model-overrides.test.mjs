import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readAgentModelOverrides, setAgentModelOverride } = await jiti.import("./agent-model-overrides.ts");
const { writeNativeSettings } = await jiti.import("./settings-config.ts");

test("per-agent overrides update one agent, survive settings snapshots, and clean up when emptied", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-agent-overrides-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, "config.yml");
  writeFileSync(file, "# mine\nmodelRoles:\n  task: a/b\n");
  setAgentModelOverride("reviewer", "openai-codex/gpt-6-astra:high");
  setAgentModelOverride("task", " openai-codex/gpt-6-astra ");
  // A Settings-page snapshot writes task limits next to, not over, the overrides.
  writeNativeSettings({ task: { maxConcurrency: 4 } });
  assert.deepEqual(readAgentModelOverrides(), { reviewer: "openai-codex/gpt-6-astra:high", task: "openai-codex/gpt-6-astra" });
  assert.deepEqual(setAgentModelOverride("reviewer", ""), { task: "openai-codex/gpt-6-astra" });
  setAgentModelOverride("task", null);
  assert.equal(readFileSync(file, "utf8"), "# mine\nmodelRoles:\n  task: a/b\ntask:\n  maxConcurrency: 4\n");
  for (const [agent, selector] of [["../reviewer", "x/y"], ["reviewer", "x\ny"], ["reviewer", "x".repeat(513)]]) {
    assert.throws(() => setAgentModelOverride(agent, selector));
  }
});
