import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const { useProviderUsage } = await createJiti(import.meta.url, { tryNative: false, tsconfigPaths: true }).import("./AppShell-provider-usage.ts");
const { ACCOUNT_ROUTING_CHANGED_EVENT, notifyAccountRoutingChanged } = await createJiti(import.meta.url, { tryNative: false }).import("../lib/account-choices.ts");
afterEach(() => {
  cleanup();
  delete document.visibilityState;
  delete navigator.onLine;
});

const snapshot = (percent) => ({ generatedAt: percent, reports: [{ provider: "test", fiveHour: { percent } }] });

function setup(t, { query = "", refreshMs, hidden = false, online = true, ignoreAbort = false } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  t.mock.method(window, "setTimeout", (fn, delay) => setTimeout(fn, delay));
  t.mock.method(window, "clearTimeout", (id) => clearTimeout(id));
  Object.defineProperty(document, "visibilityState", { configurable: true, writable: true, value: hidden ? "hidden" : "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, writable: true, value: online });
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, options) => new Promise((resolve, reject) => {
    requests.push({ url, ...options, resolve: (data) => resolve({ ok: true, json: async () => data }), reject,
      failHttp: () => resolve({ ok: false, status: 502 }) });
    if (!ignoreAbort) options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const view = renderHook(props => useProviderUsage(props.query, props.refreshMs), { initialProps: { query, refreshMs } });
  const tick = async (ms) => { await act(async () => { t.mock.timers.tick(ms); }); };
  const resolve = async (index, percent) => { await act(async () => { requests[index].resolve(snapshot(percent)); }); };
  const event = async (name) => { await act(async () => { (name === "visibilitychange" ? document : window).dispatchEvent(new Event(name)); }); };
  return { view, requests, tick, resolve, event };
}

// The data fields; `refresh` is a function and asserted through behavior.
const state = (s) => { const { snapshot: data, loading, error } = s.view.result.current; return { snapshot: data, loading, error }; };

test("usage loads immediately and refreshes every minute without blanking the panel", async t => {
  const s = setup(t);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].url, "/api/provider-usage");
  assert.equal(s.requests[0].cache, "no-store");
  await s.resolve(0, 10);
  assert.deepEqual(state(s), { snapshot: snapshot(10), loading: false, error: false });
  await s.tick(59_999);
  assert.equal(s.requests.length, 1);
  await s.tick(1);
  assert.equal(s.requests.length, 2);
  assert.deepEqual(s.view.result.current.snapshot, snapshot(10));
  await s.resolve(1, 20);
  assert.deepEqual(s.view.result.current.snapshot, snapshot(20));
  await s.tick(60_000);
  assert.equal(s.requests.length, 3);
});

test("slow requests never overlap and the next interval starts at completion", async t => {
  const s = setup(t, { refreshMs: 1_000 });
  await s.tick(10_000);
  await s.event("focus");
  await s.event("online");
  assert.equal(s.requests.length, 1);
  await s.resolve(0, 10);
  await s.tick(999);
  assert.equal(s.requests.length, 1);
  await s.tick(1);
  assert.equal(s.requests.length, 2);
});

test("background pages defer initial loading and catch up once on return", async t => {
  const s = setup(t, { hidden: true });
  await s.tick(180_000);
  assert.equal(s.requests.length, 0);
  document.visibilityState = "visible";
  await s.event("visibilitychange");
  await s.event("focus");
  assert.equal(s.requests.length, 1);
  await s.resolve(0, 10);
  document.visibilityState = "hidden";
  await s.event("visibilitychange");
  await s.tick(180_000);
  assert.equal(s.requests.length, 1);
  document.visibilityState = "visible";
  await s.event("visibilitychange");
  await s.event("focus");
  assert.equal(s.requests.length, 2);
  await s.resolve(1, 20);
  await s.tick(60_000);
  assert.equal(s.requests.length, 3);
});

test("quick tab switches keep the existing refresh deadline", async t => {
  const s = setup(t);
  await s.resolve(0, 10);
  await s.tick(10_000);
  document.visibilityState = "hidden";
  await s.event("visibilitychange");
  await s.tick(20_000);
  document.visibilityState = "visible";
  await s.event("visibilitychange");
  await s.event("focus");
  assert.equal(s.requests.length, 1);
  await s.tick(30_000);
  assert.equal(s.requests.length, 2);
});

test("offline pages pause and resume fetching on reconnection", async t => {
  const s = setup(t, { online: false });
  await s.tick(60_000);
  assert.equal(s.requests.length, 0);
  navigator.onLine = true;
  await s.event("online");
  await s.resolve(0, 10);
  navigator.onLine = false;
  await s.event("offline");
  await s.tick(120_000);
  assert.equal(s.requests.length, 1);
  navigator.onLine = true;
  await s.event("online");
  assert.equal(s.requests.length, 2);
});

test("failed refreshes preserve data, mark an error and recover automatically", async t => {
  const s = setup(t);
  await s.resolve(0, 10);
  await s.tick(60_000);
  await act(async () => { s.requests[1].failHttp(); });
  assert.deepEqual(state(s), { snapshot: snapshot(10), loading: false, error: true });
  await s.event("focus");
  assert.equal(s.requests.length, 2, "focus does not create an error retry storm");
  await s.tick(60_000);
  await s.resolve(2, 20);
  assert.deepEqual(state(s), { snapshot: snapshot(20), loading: false, error: false });
});

test("request timeouts release the loading state and retry", async t => {
  const s = setup(t);
  await s.tick(35_000);
  assert.equal(s.requests[0].signal.aborted, true);
  assert.deepEqual(state(s), { snapshot: null, loading: false, error: true });
  await s.tick(60_000);
  await s.resolve(1, 20);
  assert.equal(s.view.result.current.error, false);
});

test("query changes ignore old responses and disabling cancels requests and timers", async t => {
  const s = setup(t, { query: "provider=old", ignoreAbort: true });
  s.view.rerender({ query: "provider=new" });
  assert.equal(s.requests[0].signal.aborted, true);
  assert.equal(s.requests[1].url, "/api/provider-usage?provider=new");
  await s.resolve(1, 20);
  await s.resolve(0, 10);
  assert.deepEqual(s.view.result.current.snapshot, snapshot(20));
  s.view.rerender({ query: null });
  assert.deepEqual(state(s), { snapshot: null, loading: false, error: false });
  await s.tick(180_000);
  await s.event("online");
  assert.equal(s.requests.length, 2);
});

test("unmount cancels an in-flight request and removes automatic refresh listeners", async t => {
  const s = setup(t);
  await act(async () => { s.view.unmount(); });
  assert.equal(s.requests[0].signal.aborted, true);
  await s.tick(180_000);
  await s.event("focus");
  await s.event("visibilitychange");
  await s.event("online");
  assert.equal(s.requests.length, 1);
});

test("an explicit zero refresh interval remains a one-shot request", async t => {
  const s = setup(t, { refreshMs: 0 });
  await s.resolve(0, 10);
  await s.tick(180_000);
  await s.event("focus");
  assert.equal(s.requests.length, 1);
});

test("refresh loads at once when idle and once more after a request already running", async t => {
  const s = setup(t);
  await s.resolve(0, 10);
  await act(async () => { s.view.result.current.refresh(); });
  assert.equal(s.requests.length, 2);
  // Asked for during that request: no overlap, one follow-up when it ends.
  await act(async () => { s.view.result.current.refresh(); s.view.result.current.refresh(); });
  assert.equal(s.requests.length, 2);
  await s.resolve(1, 20);
  assert.equal(s.requests.length, 3);
  await s.resolve(2, 30);
  assert.deepEqual(state(s).snapshot, snapshot(30));
  // Back on the regular interval afterwards.
  await s.tick(59_999);
  assert.equal(s.requests.length, 3);
  await s.tick(1);
  assert.equal(s.requests.length, 4);
});

test("routing changes in another tab invalidate a hidden panel before its refresh deadline", async t => {
  const s = setup(t);
  await s.resolve(0, 10);
  document.visibilityState = "hidden";
  await act(async () => {
    window.dispatchEvent(new window.StorageEvent("storage", { key: ACCOUNT_ROUTING_CHANGED_EVENT, newValue: "changed" }));
  });
  assert.equal(s.requests.length, 1);
  document.visibilityState = "visible";
  await s.event("visibilitychange");
  assert.equal(s.requests.length, 2);
  // A second save during this request requires a fresh answer after it settles.
  await act(async () => { notifyAccountRoutingChanged(); });
  await s.resolve(1, 20);
  assert.equal(s.requests.length, 3);
  await s.resolve(2, 30);
  assert.equal(s.view.result.current.snapshot.reports[0].fiveHour.percent, 30);
});
