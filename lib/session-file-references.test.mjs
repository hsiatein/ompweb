import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./session-file-references-core.ts");
}

test("detects exact external file paths referenced in session entries", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See [/home/me/.codex/config.toml:12](/home/me/.codex/config.toml:12)",
          },
        ],
      },
    },
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/.codex/config.toml", entries), true);
});

test("does not authorize sibling files by prefix match", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "See /home/me/.codex/config.toml.bak",
          },
        ],
      },
    },
  ];

  assert.equal(isFilePathReferencedByEntries("/home/me/.codex/config.toml", entries), false);
});

test("authorizes full output only from a bash execution message", async () => {
  const { isBashOutputPathReferencedByEntries } = await loadSubject();
  const outputPath = "/tmp/pi-bash-ab12.log";
  const bashEntry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "bashExecution",
      command: "printf test",
      output: "test",
      fullOutputPath: outputPath,
    },
  };
  const assistantEntry = {
    type: "message",
    id: "entry-2",
    parentId: "entry-1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `mentioned ${outputPath}` }],
    },
  };

  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [bashEntry]), true);
  assert.equal(isBashOutputPathReferencedByEntries(outputPath, [assistantEntry]), false);
  assert.equal(isBashOutputPathReferencedByEntries("/tmp/pi-bash-other.log", [bashEntry]), false);
});

test("validates session ids before resolving session paths", async () => {
  const { isValidSessionId } = await loadSubject();

  assert.equal(isValidSessionId("not-a-session-id"), false);
  assert.equal(isValidSessionId("../../sessions/foo"), false);
  assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
});

test("tool read selectors authorize the exact referenced external file", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [{
    type: "message",
    message: { role: "assistant", content: [{
      type: "toolCall", name: "read", arguments: { path: "../outside note.md:raw:35-220" },
    }] },
  }];
  assert.equal(isFilePathReferencedByEntries("/home/me/outside note.md", entries, "/home/me/project"), true);
  assert.equal(isFilePathReferencedByEntries("/home/me/outside note.md.bak", entries, "/home/me/project"), false);
  assert.equal(isFilePathReferencedByEntries("/home/me", entries, "/home/me/project"), false);
});

test("a ~/ path in a message authorizes the file it names under the home directory only", async () => {
  const { isFilePathReferencedByEntries } = await loadSubject();
  const entries = [{
    type: "message", id: "e", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "装在 `~/.local/share/ompweb/bin/omp`，备份是 omp.bak。" }] },
  }];
  assert.equal(isFilePathReferencedByEntries("/home/me/.local/share/ompweb/bin/omp", entries, undefined, "/home/me"), true);
  assert.equal(isFilePathReferencedByEntries("/home/me/.local/share/ompweb/bin/omp", entries), false);
  assert.equal(isFilePathReferencedByEntries("/home/me/.local/share/ompweb/bin/omp.bak", entries, undefined, "/home/me"), false);
  assert.equal(isFilePathReferencedByEntries("/home/other/.local/share/ompweb/bin/omp", entries, undefined, "/home/me"), false);
});
