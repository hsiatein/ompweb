import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "omp-web-account-routing-"));
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url);
const routing = await jiti.import("./account-routing.ts");
const files = await jiti.import("./request-policy-files.ts");
const { parseProviderAccounts } = await jiti.import("./provider-usage.ts");
const a = { provider: "openai-codex", accountKey: "a".repeat(16), identity: { accountId: "acc-a", email: "a@example.test" } };
const b = { provider: "openai-codex", accountKey: "b".repeat(16), identity: { accountId: "acc-b", email: "b@example.test" } };
const solo = { provider: "anthropic", accountKey: "c".repeat(16), identity: { email: "c@example.test" } };
const session = "01a1352d-3518-7482-a959-2d82a9094dac";
const policy = file => JSON.parse(readFileSync(file, "utf8"));

test.beforeEach(() => {
  delete globalThis.__ompWebHardRouting;
  files.writePolicyJson(files.routingStatePath(), { disabled: [], disabledProviders: [], sessions: {}, providers: {}, accounts: [a, b, solo] });
});
test.after(() => rmSync(root, { recursive: true, force: true }));

test("global exclusions override existing selections and reject new conflicting selections", async () => {
  routing.setSessionAccountPin(session, a.provider, a.accountKey);
  const child = await routing.accountRoutingSpawnArgs(session);
  routing.setAccountDisabled(a.accountKey, true);
  assert.deepEqual(policy(files.globalRequestPolicyPath()).disabledAccounts, [{ provider: a.provider, account: a.identity }]);
  assert.deepEqual(policy(child.file).accounts[a.provider], a.identity, "the explicit choice remains visible while the global deny takes priority");
  assert.throws(() => routing.setSessionAccountPin(session, solo.provider, a.accountKey), /identity/);
  assert.throws(() => routing.setSessionAccountPin("other", a.provider, a.accountKey), /disabled/);
  routing.setProviderDisabled(a.provider, true);
  assert.throws(() => routing.setSessionProviderPin(session, a.provider), /disabled/);
  await assert.rejects(routing.accountRoutingSpawnArgs("new", undefined, a.provider), /disabled/);
  routing.setSessionAccountPin(session, a.provider, null);
  assert.deepEqual(policy(child.file).accounts, {});
  routing.releaseAccountRoutingPolicy(child.file);
});

test("pending selections bind to the real session and live changes release both restrictions", async () => {
  const child = await routing.accountRoutingSpawnArgs("pending", { [a.provider]: a.accountKey }, a.provider);
  routing.bindAccountRoutingPolicy(child.file, session);
  routing.setSessionAccountPin(session, a.provider, b.accountKey);
  assert.deepEqual(policy(child.file).accounts, { [b.provider]: b.identity });
  routing.setSessionProviderPin(session, null);
  routing.setSessionAccountPin(session, a.provider, null);
  assert.deepEqual(policy(child.file), { version: 1, accounts: {} });
  routing.releaseAccountRoutingPolicy(child.file);
  assert.throws(() => readFileSync(child.file), { code: "ENOENT" });
});

test("single-account denial survives reload, and clearing another pin remains possible", () => {
  routing.setSessionAccountPin(session, solo.provider, solo.accountKey);
  routing.setSessionAccountPin(session, a.provider, a.accountKey);
  routing.setAccountDisabled(solo.accountKey, true);
  routing.setSessionAccountPin(session, a.provider, null);
  delete globalThis.__ompWebHardRouting;
  assert.deepEqual(routing.loadAccountRouting().disabled, [solo.accountKey]);
  assert.deepEqual(Object.entries(routing.loadAccountRouting().sessions[session]), [[solo.provider, solo.accountKey]]);
  assert.deepEqual(policy(files.globalRequestPolicyPath()).disabledAccounts, [{ provider: solo.provider, account: solo.identity }]);
});

test("unknown identities and corrupt persisted state remain explicit errors", () => {
  assert.throws(() => routing.setAccountDisabled("f".repeat(16), true), /identity/);
  assert.throws(() => routing.setSessionAccountPin(session, a.provider, "f".repeat(16)), /identity/);
  const oldState = { ...routing.loadAccountRouting(), disabled: ["f".repeat(16)], accounts: [] };
  assert.match(files.globalRequestPolicy(oldState).error, /identity resolution/);
  files.writePolicyJson(files.routingStatePath(), { disabled: "corrupt", sessions: {} });
  delete globalThis.__ompWebHardRouting;
  assert.throws(() => routing.loadAccountRouting(), /Invalid/);
});

test("ambiguous usage identities stay unavailable for strict account selection", () => {
  const reports = ["one", "one", "two"].map(orgId => ({ provider: "anthropic", metadata: { email: "same@example.test", orgId }, limits: [] }));
  assert.deepEqual(parseProviderAccounts(JSON.stringify({ reports })), []);
  reports.push({ provider: "openai-codex", metadata: { accountId: "distinct", email: "other@example.test" }, limits: [] });
  assert.deepEqual(parseProviderAccounts(JSON.stringify({ reports })).map(account => account.identity.accountId), ["distinct"]);
});

test("plugin request policies isolate concurrent account pins and preserve live global denials", async () => {
  const one = await routing.accountRoutingSpawnArgs("plugin-one", { [a.provider]: a.accountKey }, a.provider);
  const two = await routing.accountRoutingSpawnArgs("plugin-two", { [b.provider]: b.accountKey });
  try {
    assert.notEqual(one.file, two.file);
    assert.deepEqual(policy(one.file).accounts, { [a.provider]: a.identity });
    assert.deepEqual(policy(two.file).accounts, { [b.provider]: b.identity });
    assert.deepEqual(policy(one.file).allowedProviders, [a.provider]);
    assert.equal(policy(two.file).allowedProviders, undefined);
    routing.setAccountDisabled(a.accountKey, true);
    assert.deepEqual(policy(files.globalRequestPolicyPath()).disabledAccounts, [{ provider: a.provider, account: a.identity }]);
    assert.deepEqual(policy(two.file).accounts, { [b.provider]: b.identity });
    assert.deepEqual(routing.loadAccountRouting().sessions, {});
  } finally {
    routing.releaseAccountRoutingPolicy(one.file);
    routing.releaseAccountRoutingPolicy(two.file);
  }
});
