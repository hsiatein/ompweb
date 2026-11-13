import assert from "node:assert/strict";
import childProcess from "node:child_process";
import util from "node:util";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const accountRoot = mkdtempSync(join(tmpdir(), "omp-usage-account-proxies-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = accountRoot;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(accountRoot, { recursive: true, force: true });
});

function setup(t) {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const previous = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previous;
  });
  const requests = [];
  const execute = (bin, args, options) => new Promise((resolve, reject) => {
    assert.equal(bin, process.execPath);
    assert.deepEqual(args, ["usage", "--json"]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 30_000);
    requests.push({ resolve: (usedFraction) => resolve({ stdout: JSON.stringify({
      generatedAt: Date.now(), reports: [{ provider: "test", limits: [{ scope: { windowId: "5h" }, amount: { usedFraction } }] }],
    }) }), reject });
  });
  const promisify = util.promisify;
  t.mock.method(util, "promisify", (fn) => fn === childProcess.execFile ? execute : promisify(fn));
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  return { requests, getProviderUsage: jiti("./provider-usage.ts").getProviderUsage };
}

test("provider queries share in-flight work and cached data expires after one minute", async t => {
  const { requests, getProviderUsage } = setup(t);
  const a = getProviderUsage();
  const b = getProviderUsage({ provider: "test" });
  assert.equal(requests.length, 1);
  requests[0].resolve(0.1);
  assert.equal((await a).reports[0].fiveHour.percent, 10);
  assert.deepEqual(await a, await b);
  t.mock.timers.tick(59_999);
  assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 10);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(1);
  const refreshed = getProviderUsage();
  const concurrent = getProviderUsage({ provider: "missing" });
  assert.equal(requests.length, 2);
  requests[1].resolve(0.2);
  assert.equal((await refreshed).reports[0].fiveHour.percent, 20);
  assert.deepEqual((await concurrent).reports, []);
});

test("provider failures release the shared request for a later retry", async t => {
  const { requests, getProviderUsage } = setup(t);
  const failed = getProviderUsage();
  requests[0].reject(new Error("offline"));
  await assert.rejects(failed, /offline/);
  const retried = getProviderUsage();
  assert.equal(requests.length, 2);
  requests[1].resolve(0.2);
  assert.equal((await retried).reports[0].fiveHour.percent, 20);
});

function setupReset(t, spend) {
  const previous = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previous;
  });
  const calls = [];
  let usedFraction = 0.9;
  const execute = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args.join(" ") === "usage --json") {
      return { stdout: JSON.stringify({ reports: [{ provider: "openai-codex", metadata: { email: "alice@example.com", accountId: "acct-1" }, limits: [{ scope: { windowId: "5h" }, amount: { usedFraction } }], resetCredits: { availableCount: 1 } }] }) };
    }
    if (args[1] === "reset" && args[2] === "--json") {
      return { stdout: JSON.stringify({ accounts: [{ provider: "openai-codex", credentialId: 7, email: "alice@example.com", accountId: "acct-1" }] }) };
    }
    if (args[1] === "reset") {
      usedFraction = 0;
      return spend();
    }
    return { stdout: "" };
  };
  const promisify = util.promisify;
  t.mock.method(util, "promisify", (fn) => fn === childProcess.execFile ? execute : promisify(fn));
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  return { calls, ...jiti("./provider-usage.ts") };
}

test("spending a reset addresses omp's credential, redacts its message and drops cached usage", async t => {
  const { calls, getProviderUsage, spendProviderReset } = setupReset(t, async () => ({ stdout: "\u001b[32mReset applied for al* (Codex).\u001b[0m\n" }));
  const before = await getProviderUsage();
  assert.equal(before.reports[0].fiveHour.percent, 90);
  const outcome = await spendProviderReset(before.reports[0].accountKey);
  assert.deepEqual(outcome, { ok: true, message: "Reset applied for al* (Codex)." });
  assert.deepEqual(calls, [
    "usage --json",
    "usage reset --json --provider openai-codex",
    "usage reset openai-codex/7 --redact",
  ]);
  // The next read fetches again instead of serving the pre-spend snapshot.
  assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 0);
});

test("a spend omp refuses comes back as its message; an unknown account is rejected before omp runs", async t => {
  const refusal = Object.assign(new Error("exit 1"), { stderr: "al* (Codex): nothing to reset right now.\n" });
  const { calls, getProviderUsage, spendProviderReset } = setupReset(t, async () => { throw refusal; });
  const { accountKey } = (await getProviderUsage()).reports[0];
  assert.deepEqual(await spendProviderReset(accountKey), { ok: false, message: "al* (Codex): nothing to reset right now." });
  await assert.rejects(spendProviderReset("0000000000000000"), (error) => error.code === "unknown_account" && error.status === 404);
  assert.equal(calls.filter((call) => call.startsWith("usage reset openai-codex/")).length, 1);
});

test("spending an explicitly chosen reset card passes its creditId and rejects unsafe ids", async t => {
  const { calls, getProviderUsage, spendProviderReset } = setupReset(t, async () => ({ stdout: "Reset applied.\n" }));
  const { accountKey } = (await getProviderUsage()).reports[0];
  await assert.rejects(spendProviderReset(accountKey, "../bad"), (error) => error.code === "invalid_credit_id" && error.status === 400);
  const outcome = await spendProviderReset(accountKey, "launch-2610-fable");
  assert.deepEqual(outcome, { ok: true, message: "Reset applied." });
  assert.equal(calls.at(-1), "usage reset openai-codex/7/launch-2610-fable --redact");
});
