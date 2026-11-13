import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-status-board-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url);
const board = await jiti.import("./status-board.ts");
const layout = await jiti.import("./status-board-layout.ts");

let S = "";
let counter = 0;
const T0 = 1_800_000_000_000;

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
test.beforeEach(() => {
  for (const timer of [globalThis.__ompStatusBoard?.saveTimer, globalThis.__ompStatusBoard?.notifyTimer]) clearTimeout(timer ?? undefined);
  globalThis.__ompStatusBoard = undefined;
  S = `0199bbbb-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
});
test.afterEach(() => {
  for (const timer of [globalThis.__ompStatusBoard?.saveTimer, globalThis.__ompStatusBoard?.notifyTimer]) clearTimeout(timer ?? undefined);
});

const item = (id) => board.listStatusItems(S).find((entry) => entry.id === id);

test("kinds are inferred, updates merge, and a progress item reaching max is done", () => {
  board.updateStatusItems(S, [
    { id: "train", title: "Training", value: 10, max: 100, unit: "steps" },
    { id: "loss", title: "Loss", value: 2.5 },
    { id: "note", title: "Phase", detail: "warmup" },
  ], undefined, T0);
  assert.deepEqual(["train", "loss", "note"].map((id) => [item(id).kind, item(id).state]), [["progress", "running"], ["value", "running"], ["text", "info"]]);
  board.updateStatusItems(S, { id: "train", value: 50 }, undefined, T0 + 5_000);
  assert.equal(item("train").title, "Training", "omitted fields keep their values");
  assert.equal(item("train").unit, "steps");
  board.updateStatusItems(S, { id: "train", value: 100 }, undefined, T0 + 10_000);
  assert.equal(item("train").state, "done");
  board.updateStatusItems(S, { id: "note", remove: true }, undefined, T0 + 10_000);
  assert.equal(item("note"), undefined);
});

test("a bad item rejects the whole request and the item cap holds", () => {
  board.updateStatusItems(S, { id: "a", value: 1 }, undefined, T0);
  assert.throws(() => board.updateStatusItems(S, [{ id: "a", value: 2 }, { id: "bad id!" }], undefined, T0), board.StatusInputError);
  assert.equal(item("a").value, 1, "nothing applied");
  assert.throws(() => board.updateStatusItems(S, { id: "b", value: Number.NaN }, undefined, T0), board.StatusInputError);
  const many = Array.from({ length: board.MAX_ITEMS_PER_SESSION }, (_, index) => ({ id: `x${index}`, value: index }));
  assert.throws(() => board.updateStatusItems(S, many, undefined, T0), /at most/);
});

test("the push token reaches only its own session and survives a restart", () => {
  const token = board.statusTokenFor(S);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(board.updateStatusItemsByToken(token, JSON.stringify({ items: [{ id: "job", title: "Job", state: "running" }] }), T0), 1);
  assert.equal(board.updateStatusItemsByToken("x".repeat(43), "{\"id\": \"job\"}", T0), null);
  assert.equal(board.updateStatusItemsByToken("short", "id: job", T0), null);
  // Flush the debounced save, then load the board as a fresh process would.
  clearTimeout(globalThis.__ompStatusBoard.saveTimer);
  globalThis.__ompStatusBoard.saveTimer = null;
  board.updateStatusItems(S, { id: "job", detail: "saved" }, undefined, T0);
  return new Promise((resolve) => setTimeout(() => {
    globalThis.__ompStatusBoard = undefined;
    assert.equal(board.statusTokenFor(S), token);
    assert.equal(board.updateStatusItemsByToken(token, "id: job\nstate: done", T0), 1);
    resolve();
  }, 1_200));
});

test("finished items leave after a day; the board orders and measures progress", () => {
  board.updateStatusItems(S, [
    { id: "old", title: "Old", state: "done" },
    { id: "run", title: "Run", value: 0, max: 1000 },
    { id: "bad", title: "Bad", state: "failed" },
  ], undefined, T0);
  board.updateStatusItems(S, { id: "run", value: 100 }, undefined, T0 + 60_000);
  board.updateStatusItems(S, { id: "run", value: 200 }, undefined, T0 + 120_000);
  const now = T0 + 120_000;
  const items = layout.orderItems(board.getStatusBoardSnapshot(now).sessions.find((entry) => entry.sessionId === S).items);
  assert.deepEqual(items.map((entry) => entry.id), ["bad", "run", "old"], "failed first, done last");
  const progress = layout.progressInfo(items[1], now);
  assert.equal(progress.percent, 20);
  assert.ok(Math.abs(progress.etaMs - 480_000) < 1, "800 left at 100 per minute is 8 minutes");
  assert.equal(layout.isStale(items[1], now + layout.STALE_AFTER_MS + 1), true);
  board.updateStatusItems(S, { id: "run", value: 50 }, undefined, now + 3_000);
  assert.equal(layout.progressInfo(board.listStatusItems(S).find((entry) => entry.id === "run"), now + 3_000).etaMs, undefined, "a restarted counter has no rate yet");
  const later = board.getStatusBoardSnapshot(T0 + 25 * 3_600_000);
  assert.deepEqual(later.sessions.find((entry) => entry.sessionId === S).items.map((entry) => entry.id), ["run"], "done/failed gone after 24 h");
});

test("the open chat comes first, then sessions with live items", () => {
  const session = (sessionId, state, updatedAt) => ({ sessionId, updatedAt, items: [{ id: "i", title: "i", kind: "text", state, createdAt: 0, updatedAt, history: [] }] });
  const ordered = layout.orderSessions([session("a", "done", 3), session("b", "running", 1), session("c", "running", 2), session("me", "done", 0)], "me");
  assert.deepEqual(ordered.map((entry) => entry.sessionId), ["me", "c", "b", "a"]);
});

test("blocks: YAML shorthands normalize, omitted keeps, null clears, bad blocks reject the whole request", () => {
  const token = board.statusTokenFor(S);
  board.updateStatusItemsByToken(token, [
    "id: eval",
    "title: Eval",
    "blocks:",
    "  - '**best** so far'",
    "  - type: kv",
    "    entries: {acc: 0.91, split: dev}",
    "  - type: table",
    "    rows: [{model: a, acc: 0.9}, {model: b, f1: 0.5}]",
    "  - type: chart",
    "    series: {loss: [3, 2, 1.5]}",
  ].join("\n"), T0);
  assert.deepEqual(item("eval").blocks, [
    { type: "markdown", text: "**best** so far" },
    { type: "kv", entries: [{ label: "acc", value: 0.91 }, { label: "split", value: "dev" }] },
    { type: "table", columns: ["model", "acc", "f1"], rows: [["a", 0.9, null], ["b", null, 0.5]] },
    { type: "chart", chart: "line", series: [{ name: "loss", points: [[0, 3], [1, 2], [2, 1.5]] }] },
  ]);
  board.updateStatusItems(S, { id: "eval", detail: "running" }, undefined, T0 + 1_000);
  assert.equal(item("eval").blocks.length, 4, "omitted blocks are kept");
  assert.throws(() => board.updateStatusItems(S, [{ id: "eval", blocks: [] }, { id: "x", blocks: [{ type: "table", columns: ["a"], rows: [[1, 2]] }] }], undefined, T0), board.StatusInputError);
  assert.equal(item("eval").blocks.length, 4, "a rejected request changes nothing");
  assert.throws(() => board.updateStatusItems(S, { id: "eval", blocks: [{ type: "video" }] }, undefined, T0), /type must be one of/);
  board.updateStatusItems(S, { id: "eval", blocks: null }, undefined, T0 + 2_000);
  assert.equal(item("eval").blocks, undefined);
  assert.throws(() => board.parseStatusDocument("a: [unclosed"), board.StatusInputError);
});
