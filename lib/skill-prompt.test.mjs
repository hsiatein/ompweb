import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const skillEntry = {
  type: "custom_message",
  customType: "skill-prompt",
  content: `[IMPORTANT: User invoked the "h3-style-explore" skill]\n\n# Skill body\n${"x".repeat(6000)}`,
  display: true,
  details: { name: "h3-style-explore", args: "让人物用这张图的画风", prompt: "/skill:h3-style-explore 让人物用这张图的画风" },
  attribution: "user",
  id: "5f7c91ef",
  parentId: "08aecc21",
  timestamp: "2026-11-13T14:35:00.809Z",
};

test("a user's /skill invocation shows as their message, not a skill notice", async () => {
  const { entryToUiMessage } = await jiti.import("./session-reader.ts");
  const message = entryToUiMessage(skillEntry, {});
  assert.equal(message.role, "user");
  assert.equal(message.content, "/skill:h3-style-explore 让人物用这张图的画风");
  assert.equal(entryToUiMessage({ ...skillEntry, attribution: "agent" }, {}).role, "custom");
  assert.equal(entryToUiMessage({ ...skillEntry, customType: "advisor" }, {}).role, "custom");
});

test("the session list and the fallback title use the typed skill request", async () => {
  const { scanSessionInfo } = await jiti.import("./omp/session-files.ts");
  const { deriveSessionTitleFromFirstMessage } = await jiti.import("./session-title.ts");
  const dir = mkdtempSync(join(tmpdir(), "skill-prompt-"));
  try {
    const file = join(dir, "2026-11-13T14-30-53-371Z_01a1d551-8abb-71d5-a19c-af4a920ce465.jsonl");
    writeFileSync(file, [
      { type: "session", version: 3, id: "01a1d551-8abb-71d5-a19c-af4a920ce465", timestamp: "2026-11-13T14:30:53.371Z", cwd: "/work" },
      skillEntry,
      { type: "message", id: "a", parentId: "5f7c91ef", timestamp: "2026-11-13T14:36:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const info = scanSessionInfo(file, false);
    assert.equal(info.firstMessage, "/skill:h3-style-explore 让人物用这张图的画风");
    assert.equal(deriveSessionTitleFromFirstMessage(info.firstMessage), "让人物用这张图的画风");
    assert.equal(deriveSessionTitleFromFirstMessage("/skill:h3-video"), "h3-video");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
