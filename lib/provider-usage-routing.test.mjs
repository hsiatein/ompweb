import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import childProcess from "node:child_process";
import util from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

test("usage reflects current provider and account denials while preserving the cached full inventory", async t => {
  const root = mkdtempSync(join(tmpdir(), "omp-usage-routing-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    rmSync(root, { recursive: true, force: true });
  });
  let queries = 0;
  const execute = async () => {
    queries += 1;
    return { stdout: JSON.stringify({ reports: [
      { provider: "openai-codex", metadata: { email: "a@example.test", accountId: "a" }, limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.9 } }] },
      { provider: "openai-codex", metadata: { email: "b@example.test", accountId: "b" }, limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.2 } }] },
      { provider: "anthropic", metadata: { email: "c@example.test", accountId: "c" }, limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.4 } }] },
    ] }) };
  };
  const promisify = util.promisify;
  t.mock.method(util, "promisify", fn => fn === childProcess.execFile ? execute : promisify(fn));
  const jiti = createJiti(import.meta.url, { tryNative: false, tsconfigPaths: true });
  const usage = jiti("./provider-usage.ts");
  await usage.getProviderUsage();
  const { GET } = await jiti.import("../app/api/provider-usage/route.ts");
  const routing = await jiti.import("./account-routing.ts");
  const readUsage = async () => {
    const response = await GET(new Request("http://localhost/api/provider-usage"));
    assert.equal(response.status, 200);
    return (await response.json()).reports;
  };
  const before = await readUsage();
  assert.deepEqual(before.map(r => [r.provider, r.disabled]), [["openai-codex", false], ["openai-codex", false], ["anthropic", false]]);
  await routing.refreshRoutingAccounts();
  const account = before.find(r => r.fiveHour.percent === 90).accountKey;
  routing.setAccountDisabled(account, true);
  assert.deepEqual((await readUsage()).map(r => r.disabled), [true, false, false]);
  routing.setProviderDisabled("openai-codex", true);
  assert.deepEqual((await readUsage()).map(r => r.disabled), [true, true, false]);
  routing.setProviderDisabled("openai-codex", false);
  assert.deepEqual((await readUsage()).map(r => r.disabled), [true, false, false]);
  routing.setAccountDisabled(account, false);
  assert.deepEqual((await readUsage()).map(r => r.disabled), [false, false, false]);
  assert.equal(queries, 1, "permission changes must apply even while the quota report stays cached");
});
