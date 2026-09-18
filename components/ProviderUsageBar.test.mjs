import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { CreditBalanceDetails, ProviderUsageBar } = await jiti.import("./ProviderUsageBar.tsx");
const { formatProviderUsageReport } = await jiti.import("./AppShell-provider-usage.ts");
const { default: en } = await import("../lib/i18n/locales/en.json", { with: { type: "json" } });
const t = (key, vars = {}) => en[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
const credits = { remaining: 226, limit: 250, limitSource: "fallback", percent: 9.6 };

test("the usage panel owns its glass surface rather than hiding glass under an opaque child", () => {
  const html = renderToStaticMarkup(React.createElement(ProviderUsageBar));
  assert.match(html, /<section class="provider-usage-panel wallpaper-surface"/);
  assert.match(html, /max-height:32vh/);
});

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
