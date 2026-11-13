import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CreditBalanceDetails, ResetCredits } = await jiti.import("./ProviderUsageBar.tsx");
const { classifyResetCreditScope, formatProviderUsageReport } = await jiti.import("./AppShell-provider-usage.ts");
const { default: en } = await import("../lib/i18n/locales/en.json", { with: { type: "json" } });
const t = (key, vars = {}) => en[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
const credits = { remaining: 226, limit: 250, limitSource: "fallback", percent: 9.6 };


test("credit details distinguish actual balance from assumed allowance", () => {
  const html = renderToStaticMarkup(React.createElement(CreditBalanceDetails, { credits, t }));
  assert.match(html, /Remaining: 226 credits/);
  assert.match(html, /Assumed limit: 250 credits/);
  assert.match(html, /Estimated usage: 9.6%/);
  assert.match(html, /Plan and reset time unknown/);
  assert.doesNotMatch(html, /5H|resets in|Infinity|NaN/);
});

test("reported limits do not carry an estimated label", () => {
  const html = renderToStaticMarkup(React.createElement(CreditBalanceDetails, {
    credits: { remaining: 75, limit: 100, limitSource: "reported", percent: 25 }, t,
  }));
  assert.match(html, /Limit: 100 credits/);
  assert.doesNotMatch(html, /Assumed|Estimated|unknown/);
});

test("credit text formatters preserve balance and approximation marker", () => {
  assert.equal(formatProviderUsageReport({ provider: "charm-hyper", credits }, "unavailable"), "226/250 credits remaining (estimated limit)");
});

test("reset credits distinguish 5H, Fable and full 5H+7D cards while surfacing queued grants", () => {
  assert.equal(classifyResetCreditScope({ clears: ["anthropic:5h"] }), "5h");
  assert.equal(classifyResetCreditScope({
    title: "New model launch: one Fable reset for Pro and Team Standard",
    clears: ["anthropic:5h", "anthropic:reset:seven_day_overage_included"],
  }), "5h_fable");
  assert.equal(classifyResetCreditScope({
    title: "One full limit reset (November 2026)",
    clears: ["anthropic:5h", "anthropic:7d", "anthropic:reset:seven_day_overage_included"],
  }), "full");

  const now = Date.parse("2026-11-12T04:30:00Z");
  const html = renderToStaticMarkup(React.createElement(ResetCredits, {
    resets: {
      available: 2,
      spendable: true,
      credits: [
        {
          status: "available",
          usable: true,
          remainingCount: 1,
          title: "New model launch: one Fable reset for Pro and Team Standard",
          clears: ["anthropic:5h", "anthropic:reset:seven_day_overage_included"],
          expiresAt: Date.parse("2026-11-17T07:59:00Z"),
        },
        {
          status: "unavailable",
          usable: false,
          remainingCount: 1,
          title: "One full limit reset (November 2026)",
          clears: ["anthropic:5h", "anthropic:7d", "anthropic:reset:seven_day_overage_included"],
          expiresAt: Date.parse("2026-12-10T22:00:00Z"),
        },
        {
          status: "redeemed",
          usable: false,
          remainingCount: 0,
          title: "Already used grant",
          clears: ["anthropic:5h"],
          expiresAt: Date.parse("2026-11-20T00:00:00Z"),
        },
      ],
    },
    accountKey: "803d1fbb1e94f30a",
    account: "anthropic · Wa*",
    now,
    locale: "en-US",
    onSpent: () => {},
    t,
  }));
  assert.match(html, /2 saved rate-limit resets/);
  assert.match(html, /5H \+ Fable/);
  assert.match(html, /Full \(5H\+7D\)/);
  assert.match(html, /queued/);
  assert.doesNotMatch(html, /Already used grant/);
});

test("multiple usable reset cards expose Choose reset and per-card Use controls", () => {
  const now = Date.parse("2026-11-12T04:30:00Z");
  const html = renderToStaticMarkup(React.createElement(ResetCredits, {
    resets: {
      available: 2,
      spendable: true,
      nextCreditId: "full-reset-2611",
      credits: [
        {
          id: "full-reset-2611",
          status: "available",
          usable: true,
          remainingCount: 1,
          title: "One full limit reset (November 2026)",
          clears: ["anthropic:5h", "anthropic:7d", "anthropic:reset:seven_day_overage_included"],
          expiresAt: Date.parse("2026-12-10T22:00:00Z"),
        },
        {
          id: "launch-2610-fable",
          status: "available",
          usable: true,
          remainingCount: 1,
          title: "New model launch: one Fable reset for Max",
          clears: ["anthropic:5h", "anthropic:reset:seven_day_overage_included"],
          expiresAt: Date.parse("2027-03-09T07:59:00Z"),
        },
      ],
    },
    accountKey: "c804793e32d54d01",
    account: "anthropic · mu*",
    now,
    locale: "en-US",
    onSpent: () => {},
    t,
  }));
  assert.match(html, /Choose reset…/);
  assert.equal([...html.matchAll(/>Use<\/button>/g)].length, 2);
  assert.doesNotMatch(html, /queued/);
});
