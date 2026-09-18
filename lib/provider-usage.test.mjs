import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseProviderUsageOutput } = await jiti.import("./provider-usage.ts");
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

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "openai-codex", modelId: "GPT-5.6-LUNA" }, now), {
    generatedAt: 123,
    reports: [{
      provider: "openai-codex",
      accountLabel: "account@example.com",
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

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }), {
    generatedAt: null,
    reports: [
      {
        provider: "provider",
        accountLabel: "account-1",
        modelId: "model-a",
        fiveHour: { percent: 10 },
        sevenDay: { percent: 20 },
      },
      {
        provider: "provider",
        accountLabel: "account-1",
        modelId: "model-b",
        fiveHour: { percent: 30 },
      },
    ],
  });
});

test("parseProviderUsageOutput keeps accounts without reported limits", () => {
  const output = JSON.stringify({
    reports: [{ provider: "ollama", metadata: { email: "ollama@example.com" }, limits: [] }],
  });

  assert.deepEqual(parseProviderUsageOutput(output), {
    generatedAt: null,
    reports: [{
      provider: "ollama",
      accountLabel: "ollama@example.com",
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

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }, now), {
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
