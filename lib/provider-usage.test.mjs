import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseProviderUsageOutput } = await jiti.import("./provider-usage.ts");

/** Parses and drops the opaque account keys, which are covered by their own tests. */
function parseWithoutKeys(...args) {
  const snapshot = parseProviderUsageOutput(...args);
  return {
    ...snapshot,
    reports: snapshot.reports.map(({ accountKey, ...report }) => {
      assert.match(accountKey, /^[a-f0-9]{16}$/);
      return report;
    }),
  };
}

test("parseProviderUsageOutput selects matching model windows", () => {
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  const output = JSON.stringify({
    generatedAt: 123,
    reports: [
      {
        provider: "openai-codex",
        metadata: { email: "account@example.com", planType: "plus" },
        limits: [
          {
            scope: { modelId: "gpt-5.6-luna", windowId: "5h" },
            amount: { usedFraction: 0.09 },
            window: { resetsAt: now + (2 * 60 + 39) * 60_000 },
          },
          {
            scope: { modelId: "gpt-5.6-luna", windowId: "7d" },
            amount: { usedFraction: 0.04 },
            window: { resetsAt: now + (5 * 24 + 20) * 3_600_000 },
          },
          {
            scope: { modelId: "other-model", windowId: "5h" },
            amount: { usedFraction: 0.88 },
            window: { resetsAt: now + 60_000 },
          },
        ],
      },
      {
        provider: "ollama",
        limits: [
          {
            scope: { windowId: "5h" },
            amount: { usedFraction: 0.5 },
            window: { resetsAt: now + 60_000 },
          },
        ],
      },
    ],
  });

  assert.deepEqual(parseWithoutKeys(output, { provider: "openai-codex", modelId: "GPT-5.6-LUNA" }, now), {
    generatedAt: 123,
    reports: [{
      provider: "openai-codex",
      accountLabel: "ac*",
      plan: "plus",
      modelId: "gpt-5.6-luna",
      fiveHour: { percent: 9, resetMinutes: 159 },
      sevenDay: { percent: 4, resetHours: 140 },
    }],
  });
});

test("parseProviderUsageOutput selects the binding meter for repeated windows", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    reports: [{
      provider: "provider",
      limits: [
        { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 0.1 }, window: { resetsAt: now + 60_000 } },
        { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 0.7 }, window: { resetsAt: now + 30 * 60_000 } },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }, now).reports[0]?.fiveHour, {
    percent: 70,
    resetMinutes: 30,
  });
});
test("parseProviderUsageOutput returns every model when no model is selected", () => {
  const output = JSON.stringify({
    reports: [{
      provider: "provider",
      metadata: { accountId: "account-1" },
      limits: [
        { scope: { modelId: "model-a", windowId: "5h" }, amount: { usedFraction: 0.1 }, window: {} },
        { scope: { modelId: "model-a", windowId: "7d" }, amount: { usedFraction: 0.2 }, window: {} },
        { scope: { modelId: "model-b", windowId: "5h" }, amount: { usedFraction: 0.3 }, window: {} },
      ],
    }],
  });

  assert.deepEqual(parseWithoutKeys(output, { provider: "provider" }), {
    generatedAt: null,
    reports: [
      {
        provider: "provider",
        accountLabel: "ac*",
        modelId: "model-a",
        fiveHour: { percent: 10 },
        sevenDay: { percent: 20 },
      },
      {
        provider: "provider",
        accountLabel: "ac*",
        modelId: "model-b",
        fiveHour: { percent: 30 },
      },
    ],
  });
});

test("parseProviderUsageOutput keeps parallel quota pools on the same window apart", () => {
  const week = 7 * 24 * 60 * 60 * 1000;
  const limit = (label, windowId, durationMs, usedFraction) => ({ label, scope: { windowId }, window: { durationMs }, amount: { usedFraction } });
  const output = JSON.stringify({
    reports: [
      {
        provider: "google-antigravity",
        limits: [
          limit("Claude & GPT (shared)", "weekly", week, 0.17),
          limit("Claude & GPT (shared)", "weekly", week, 0.17),
          limit("Gemini", "5h", 5 * 3_600_000, 0.05),
          limit("Gemini", "weekly", week, 0.03),
          limit("Claude & GPT (shared)", "5h", 5 * 3_600_000, 0.01),
        ],
      },
      {
        provider: "anthropic",
        limits: [limit("Claude 5 Hour", "5h", 5 * 3_600_000, 0.2), limit("Claude 7 Day", "7d", week, 0.4)],
      },
    ],
  });

  assert.deepEqual(parseWithoutKeys(output).reports, [
    { provider: "google-antigravity", accountIndex: 1, pool: "Claude & GPT (shared)", sevenDay: { percent: 17 }, fiveHour: { percent: 1 } },
    { provider: "google-antigravity", accountIndex: 1, pool: "Gemini", fiveHour: { percent: 5 }, sevenDay: { percent: 3 } },
    { provider: "anthropic", accountIndex: 2, fiveHour: { percent: 20 }, sevenDay: { percent: 40 } },
  ]);
  assert.deepEqual(
    parseProviderUsageOutput(output, { provider: "google-antigravity", modelId: "gemini-4-argon-high" }).reports.map((report) => report.pool),
    ["Claude & GPT (shared)", "Gemini"],
  );
});

test("parseProviderUsageOutput keeps accounts without reported limits", () => {
  const output = JSON.stringify({
    reports: [{ provider: "ollama", metadata: { email: "ollama@example.com" }, limits: [] }],
  });

  assert.deepEqual(parseWithoutKeys(output), {
    generatedAt: null,
    reports: [{
      provider: "ollama",
      accountLabel: "ol*",
      noLimits: true,
    }],
  });
});

test("parseProviderUsageOutput falls back to duration and ignores malformed limits", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    generatedAt: "not-a-number",
    reports: [{
      provider: "provider",
      limits: [
        {
          scope: {},
          amount: { usedFraction: 0.12 },
          window: { durationMs: 30 * 24 * 60 * 60 * 1000, resetsAt: now + 48 * 3_600_000 },
        },
        { scope: { windowId: "5h" }, amount: { usedFraction: "bad" }, window: {} },
        { scope: { windowId: "unknown" }, amount: { usedFraction: 0.2 }, window: {} },
      ],
    }],
  });

  assert.deepEqual(parseWithoutKeys(output, { provider: "provider" }, now), {
    generatedAt: null,
    reports: [{
      provider: "provider",
      accountIndex: 1,
      monthly: { percent: 12, resetHours: 48 },
    }],
  });
});

test("parseProviderUsageOutput rejects invalid JSON", () => {
  assert.throws(() => parseProviderUsageOutput("not-json"), /invalid JSON/);
});

const account = (provider, metadata) => ({
  provider,
  ...(metadata ? { metadata } : {}),
  limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.1 } }],
});
const parseAccounts = (reports, aliases) => parseProviderUsageOutput(JSON.stringify({ reports }), {}, 0, aliases).reports;

test("account labels are redacted to the shortest unique prefix and raw identities stay server-side", () => {
  const reports = parseAccounts([
    account("anthropic", { email: "alice@example.com", accountId: "acct-1" }),
    account("anthropic", { email: "alina@example.com" }),
    account("openai-codex", { email: "alice@example.com", accountId: "acct-2" }),
    account("openai-codex", { accountId: "bob-account" }),
  ]);
  assert.deepEqual(reports.map((report) => report.accountLabel), ["alic*", "alin*", "alic*", "bo*"]);
  assert.doesNotMatch(JSON.stringify(reports), /example\.com|acct-|bob-account/);
});

test("account keys follow the credential across report order, other logins and providers", () => {
  const alice = account("anthropic", { email: "alice@example.com", accountId: "acct-1" });
  const bob = account("anthropic", { email: "bob@example.com", accountId: "acct-2" });
  const before = parseAccounts([alice, bob]);
  const after = parseAccounts([account("openai-codex", { email: "alice@example.com" }), bob, account("anthropic", { email: "alicia@example.com" }), alice]);
  assert.equal(after[3].accountKey, before[0].accountKey);
  assert.equal(after[1].accountKey, before[1].accountKey);
  assert.notEqual(before[0].accountKey, before[1].accountKey);
  // Same login on another provider is a different credential.
  assert.notEqual(after[0].accountKey, before[0].accountKey);
});

test("accounts without an identity are keyed by their position within the provider", () => {
  const hyper = (remaining) => ({ provider: "charm-hyper", limits: [{ id: "credits", amount: { remaining } }] });
  const before = parseAccounts([hyper(1), hyper(2)]);
  const after = parseAccounts([account("anthropic", { email: "a@example.com" }), hyper(1), hyper(2)]);
  assert.notEqual(before[0].accountKey, before[1].accountKey);
  assert.deepEqual(after.slice(1).map((report) => report.accountKey), before.map((report) => report.accountKey));
});

test("aliases name every pool row of their account and leave other accounts alone", () => {
  const pooled = {
    provider: "google-antigravity",
    metadata: { email: "work@example.com", projectId: "proj" },
    limits: [
      { label: "Gemini", scope: { windowId: "5h" }, amount: { usedFraction: 0.1 } },
      { label: "Claude", scope: { windowId: "5h" }, amount: { usedFraction: 0.2 } },
    ],
  };
  const other = account("google-antigravity", { email: "home@example.com" });
  const [first] = parseAccounts([pooled, other]);
  const reports = parseAccounts([pooled, other], { [first.accountKey]: "Work" });
  assert.deepEqual(reports.map((report) => [report.pool, report.accountAlias]), [["Gemini", "Work"], ["Claude", "Work"], [undefined, undefined]]);
  assert.equal(parseAccounts([pooled], { [first.accountKey]: "   " })[0].accountAlias, undefined);
});

function hyperReport(amount, overrides = {}) {
  return {
    provider: "charm-hyper",
    metadata: { endpoint: "https://hyper.charm.land/v1/credits" },
    limits: [{
      id: "charm-hyper:credits",
      scope: { provider: "charm-hyper", windowId: "balance", shared: true },
      amount: { unit: "credits", ...amount },
    }],
    ...overrides,
  };
}

function parseHyper(amount, overrides, query) {
  return parseProviderUsageOutput(JSON.stringify({ reports: [hyperReport(amount, overrides)] }), query).reports[0];
}

test("Hyper balance-only reports use an explicitly estimated 250-credit limit", () => {
  const report = parseHyper({ remaining: 226 });
  assert.equal(report.credits.remaining, 226);
  assert.equal(report.credits.limit, 250);
  assert.equal(report.credits.limitSource, "fallback");
  assert.ok(Math.abs(report.credits.percent - 9.6) < 1e-10);
  assert.equal(report.noLimits, undefined);
  assert.equal(report.plan, undefined);
  assert.equal(report.fiveHour, undefined);
  assert.equal(report.sevenDay, undefined);
  assert.equal(report.monthly, undefined);
});

test("Hyper prefers an upstream credit limit over the fallback", () => {
  assert.deepEqual(parseHyper({ remaining: 75, limit: 100 }).credits, {
    remaining: 75, limit: 100, limitSource: "reported", percent: 25,
  });
});

test("Hyper preserves zero, fractional, negative and topped-up balances", () => {
  for (const [remaining, percent] of [[0, 100], [250, 0], [750, 0], [-1, 100], [125.5, 49.8]]) {
    const credits = parseHyper({ remaining }).credits;
    assert.equal(credits.remaining, remaining);
    assert.ok(Math.abs(credits.percent - percent) < 1e-10);
  }
});

test("Hyper ignores malformed balances and rejects unusable limits", () => {
  for (const remaining of [undefined, null, "226", Infinity, NaN]) {
    const report = parseHyper({ remaining });
    assert.equal(report.credits, undefined);
    assert.equal(report.noLimits, true);
  }
  for (const limit of [undefined, null, "500", 0, -100, Infinity]) {
    assert.equal(parseHyper({ remaining: 226, limit }).credits.limitSource, "fallback");
  }
  assert.equal(parseHyper({ remaining: 226, unit: "dollars" }).credits, undefined);
});

test("Hyper does not guess subscription from a balance or an unrecognized plan", () => {
  assert.equal(parseHyper({ remaining: 500 }, { metadata: { planType: "unknown" } }).credits.limitSource, "fallback");
});

test("Hyper's account-wide balance survives model filtering without summing repeated keys", () => {
  assert.equal(parseHyper({ remaining: 226 }, undefined, { provider: "charm-hyper", modelId: "kimi-k3" }).credits.remaining, 226);
  assert.equal(parseHyper({ remaining: 226 }, undefined, { provider: "other" }), undefined);
  const output = JSON.stringify({ reports: [hyperReport({ remaining: 226 }), hyperReport({ remaining: 226 })] });
  const reports = parseProviderUsageOutput(output).reports;
  assert.equal(reports.length, 2);
  assert.ok(reports.every((report) => report.credits.remaining === 226));
});

test("Hyper fallback is not applied to other providers", () => {
  assert.equal(parseHyper({ remaining: 226 }, { provider: "another-provider" }).credits, undefined);
});

test("Hyper balance and existing time windows can coexist", () => {
  const raw = hyperReport({ remaining: 226 });
  raw.limits.push({ scope: { windowId: "7d" }, amount: { usedFraction: 0.3 } });
  const report = parseProviderUsageOutput(JSON.stringify({ reports: [raw] })).reports[0];
  assert.equal(report.credits.remaining, 226);
  assert.equal(report.sevenDay.percent, 30);
});

const { parseProviderAccounts, parseResetCredentialId } = await jiti.import("./provider-usage.ts");
const withResets = (provider, metadata, resetCredits) => ({ ...account(provider, metadata), resetCredits });
const DAY = 86_400_000;

test("saved resets report the count, dated credits and whether one can be spent now", () => {
  const now = Date.parse("2026-10-22T00:00:00Z");
  const [codex, claude, cooling, gemini] = parseProviderUsageOutput(JSON.stringify({
    reports: [
      withResets("openai-codex", { email: "a@example.com" }, {
        availableCount: 2,
        credits: [
          { status: "available", grantedAt: "2026-09-29T18:47:11Z", expiresAt: "2026-10-29T18:47:11Z" },
          { status: "redeemed", expiresAt: "2026-11-01T00:00:00Z" },
          { status: "available", expiresAt: "not a date" },
        ],
      }),
      withResets("anthropic", { email: "b@example.com" }, { availableCount: 0, redeemableCount: 0, eligible: false, reason: "not_at_wall", credits: [] }),
      withResets("anthropic", { email: "c@example.com" }, { availableCount: 1, redeemableCount: 1, cooldownUntil: new Date(now + DAY).toISOString(), credits: [] }),
      withResets("google-antigravity", { email: "d@example.com" }, { availableCount: 3 }),
    ],
  }), {}, now).reports;

  assert.deepEqual(codex.resets, {
    available: 2,
    spendable: true,
    credits: [
      { status: "available", grantedAt: Date.parse("2026-09-29T18:47:11Z"), expiresAt: Date.parse("2026-10-29T18:47:11Z") },
      { status: "redeemed", expiresAt: Date.parse("2026-11-01T00:00:00Z") },
      { status: "available" },
    ],
  });
  // Claude's resets wait for the limit: listed as not spendable, with omp's reason.
  assert.deepEqual(claude.resets, { available: 0, spendable: false, reason: "not_at_wall", credits: [] });
  assert.deepEqual(cooling.resets, { available: 1, spendable: false, reason: "cooldown", cooldownUntil: now + DAY, credits: [] });
  // Only providers omp can spend resets for carry them.
  assert.equal(gemini.resets, undefined);
});

test("a reset is spent on the credential omp lists for the same account key", () => {
  const [alice, bob] = parseAccounts([
    account("openai-codex", { email: "alice@example.com", accountId: "acct-1" }),
    account("openai-codex", { email: "bob@example.com", accountId: "acct-2" }),
  ]);
  const listing = JSON.stringify({
    accounts: [
      { provider: "anthropic", credentialId: 1, email: "bob@example.com", accountId: "acct-2" },
      { provider: "openai-codex", credentialId: 5, email: "bob@example.com", accountId: "acct-2", error: "Failed to load saved resets" },
      { provider: "openai-codex", credentialId: 2, email: "alice@example.com", accountId: "acct-1" },
    ],
  });
  assert.equal(parseResetCredentialId(listing, "openai-codex", alice.accountKey), 2);
  // A listing error (saved resets not loaded) still identifies the credential.
  assert.equal(parseResetCredentialId(listing, "openai-codex", bob.accountKey), 5);
  assert.equal(parseResetCredentialId(listing, "anthropic", alice.accountKey), undefined);
  assert.throws(() => parseResetCredentialId("nope", "openai-codex", alice.accountKey), /invalid JSON/);
});

test("accountsWithoutUsage remain visible with stable keys and without duplicating reported accounts", () => {
  const [aliceExpected, alinaExpected] = parseAccounts([
    account("anthropic", { email: "alice@example.com", accountId: "acct-1", orgId: "org-1" }),
    account("anthropic", { email: "alina@example.com", accountId: "acct-2", orgId: "org-2" }),
  ]);
  const output = JSON.stringify({
    generatedAt: 500,
    reports: [account("anthropic", { email: "alice@example.com", accountId: "acct-1", orgId: "org-1" })],
    accountsWithoutUsage: [
      { provider: "anthropic", type: "oauth", email: "alice@example.com", accountId: "acct-1", orgId: "org-1" },
      { provider: "anthropic", type: "oauth", email: "alina@example.com", accountId: "acct-2", orgId: "org-2" },
    ],
  });
  const filtered = parseProviderUsageOutput(output, { provider: "anthropic", modelId: "claude-opus-5-5" }, 500, { [alinaExpected.accountKey]: "Backup" });
  assert.deepEqual(filtered.reports, [
    { provider: "anthropic", accountKey: aliceExpected.accountKey, accountLabel: "alic*", fiveHour: { percent: 10 } },
    { provider: "anthropic", accountKey: alinaExpected.accountKey, accountLabel: "alin*", accountAlias: "Backup", noLimits: true, noUsageData: true },
  ]);
  assert.deepEqual(parseProviderAccounts(output).map((item) => item.accountKey), [aliceExpected.accountKey, alinaExpected.accountKey]);
});
