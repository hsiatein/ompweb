import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const manager = await jiti.import("./terminal-manager.ts");

test("shells do not inherit omp-web's own secrets or server settings, but omp in them keeps per-account proxies", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-terminal-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const env = manager.terminalEnv({ PATH: "/bin", HOME: "/home/u", OMP_WEB_PASSWORD: "secret", OMP_WEB_OMP_BIN: "/x", PORT: "30177", NODE_ENV: "production", __NEXT_PRIVATE_X: "1", NEXT_RUNTIME: "nodejs", TERM: "dumb" });
  assert.deepEqual(Object.keys(env).sort(), ["COLORTERM", "HOME", "OMP_ACCOUNT_PROXY_FILE", "PATH", "TERM", "TERM_PROGRAM"]);
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.OMP_ACCOUNT_PROXY_FILE, join(dir, "omp-web-account-proxies.json"));
});

test("sizes are clamped to sane terminal bounds", () => {
  assert.deepEqual(manager.clampSize(0, 99999), { cols: manager.MIN_COLS, rows: manager.MAX_ROWS });
  assert.deepEqual(manager.clampSize("80", Number.NaN), { cols: 80, rows: 24 });
  assert.deepEqual(manager.clampSize(120.7, 40.2), { cols: 120, rows: 40 });
});

test("a shell runs in the requested directory, replays its output to a late viewer, and exits", { skip: !(await manager.terminalsAvailable()) && "node-pty not built" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-terminal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const terminal = await manager.createTerminal({ cwd: dir, cols: 100, rows: 30 });
  t.after(() => { try { manager.closeTerminal(terminal.id); } catch { /* closed by the test */ } });
  assert.equal(terminal.cwd, dir);

  const exited = new Promise((resolve) => {
    const live = manager.attachTerminal(terminal.id, (event) => { if (event.type === "exit") { live.detach(); resolve(event.exitCode); } });
  });
  manager.writeTerminal(terminal.id, "printf 'cwd=%s\\n' \"$PWD\"; exit 3\r");
  assert.equal(await exited, 3);

  const late = manager.attachTerminal(terminal.id, () => {});
  late.detach();
  assert.match(late.replay, new RegExp(`cwd=${dir}`));
  assert.equal(late.exitCode, 3);
  assert.equal(manager.listTerminals().find((item) => item.id === terminal.id)?.exitCode, 3);
  assert.throws(() => manager.writeTerminal(terminal.id, "x"), { code: "terminal_exited" });

  manager.closeTerminal(terminal.id);
  assert.equal(manager.listTerminals().some((item) => item.id === terminal.id), false);
  assert.throws(() => manager.attachTerminal(terminal.id, () => {}), { code: "terminal_not_found" });
});
