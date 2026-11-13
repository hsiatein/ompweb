import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { accountProxyStatus, ensureAccountProxyFile, loadAccountProxies, saveAccountProxy } = jiti("./account-proxy.ts");
let root;
let previous;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "omp-web-account-proxy-")); previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root; });
afterEach(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
const a = "a".repeat(64), b = "b".repeat(64);

test("account proxy secrets persist privately while the UI receives a redacted address", () => {
  const status = saveAccountProxy("openai-codex", a, "http://alice:p%40ss@127.0.0.1:7890");
  assert.deepEqual(status, { configured: true, address: "http://127.0.0.1:7890/", authenticated: true });
  const file = ensureAccountProxyFile();
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).accounts[0].url, "http://alice:p%40ss@127.0.0.1:7890/");
  assert.deepEqual(accountProxyStatus(loadAccountProxies()[0]), status);
});

test("editing or clearing one account preserves another account's proxy", () => {
  saveAccountProxy("openai-codex", a, "http://127.0.0.1:7890");
  saveAccountProxy("openai-codex", b, "https://127.0.0.1:7891");
  saveAccountProxy("openai-codex", a, "http://127.0.0.1:7892");
  assert.deepEqual(loadAccountProxies().map(row => [row.key, row.url]), [[b, "https://127.0.0.1:7891/"], [a, "http://127.0.0.1:7892/"]]);
  assert.deepEqual(saveAccountProxy("openai-codex", a, ""), { configured: false });
  assert.deepEqual(loadAccountProxies(), [{ provider: "openai-codex", key: b, url: "https://127.0.0.1:7891/" }]);
});

test("unsupported or malformed proxy URLs leave saved routes unchanged", () => {
  saveAccountProxy("anthropic", a, "http://127.0.0.1:7890");
  for (const url of ["socks5://127.0.0.1:1080", "file:///tmp/key", "https://proxy.invalid/path", "http://proxy.invalid?secret=value", "http://bad%ZZ:secret@proxy.invalid"]) assert.throws(() => saveAccountProxy("anthropic", a, url), /HTTP or HTTPS/);
  assert.equal(loadAccountProxies()[0].url, "http://127.0.0.1:7890/");
});

test("malformed or removed configuration fails closed without echoing its content", () => {
  saveAccountProxy("anthropic", a, "http://private-user:private-password@127.0.0.1:7890");
  const file = ensureAccountProxyFile();
  writeFileSync(file, "{ private-password");
  assert.throws(loadAccountProxies, { message: "Account proxy settings are unavailable or invalid" });
  rmSync(file);
  assert.throws(loadAccountProxies, { message: "Account proxy settings are unavailable or invalid" });
});
