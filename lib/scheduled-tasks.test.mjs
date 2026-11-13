import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { randomUUID } from "node:crypto";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-scheduled-tasks-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url);
const subject = await jiti.import("./scheduled-tasks.ts");
const { nextRunAfter, parseScheduleRepeat } = await jiti.import("./schedule-recurrence.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const storeFile = join(agentDir, "omp-web-scheduled-tasks.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));
const MINUTE = 60_000;

test.after(() => rmSync(agentDir, { recursive: true, force: true }));
test.beforeEach(() => {
  rmSync(storeFile, { force: true });
  globalThis.__ompScheduledTasks = undefined;
  subject.setScheduledTaskRunner(null);
});
test.afterEach(() => {
  for (const timer of globalThis.__ompScheduledTasks?.timers.values() ?? []) clearTimeout(timer);
  for (const timer of globalThis.__ompScheduledTasks?.watchdogs.values() ?? []) clearTimeout(timer);
  clearInterval(globalThis.__ompScheduledTasks?.rescan ?? undefined);
  for (const listener of globalThis.__ompWebhookListeners?.listeners.values() ?? []) listener.server.close();
  globalThis.__ompWebhookListeners = undefined;
});

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();

test("daily and weekly runs land on the next matching wall-clock time", () => {
  const daily = { kind: "daily", time: "09:00" };
  assert.equal(nextRunAfter(daily, at(2026, 10, 22, 8, 59), null), at(2026, 10, 22, 9, 0));
  assert.equal(nextRunAfter(daily, at(2026, 10, 22, 9, 0), null), at(2026, 10, 23, 9, 0), "a run exactly at 09:00 schedules tomorrow");
  // 2026-10-22 is a Thursday (4); Monday (1) and Friday (5) selected.
  const weekly = { kind: "weekly", days: [1, 5], time: "18:30" };
  assert.equal(nextRunAfter(weekly, at(2026, 10, 22, 12, 0), null), at(2026, 10, 23, 18, 30));
  assert.equal(nextRunAfter(weekly, at(2026, 10, 23, 18, 30), null), at(2026, 10, 26, 18, 30));
  assert.equal(nextRunAfter({ kind: "weekly", days: [4], time: "10:00" }, at(2026, 10, 22, 10, 0), null), at(2026, 10, 29, 10, 0), "same weekday rolls a full week");
});

test("intervals keep their cadence and collapse missed runs into one", () => {
  const every = { kind: "interval", minutes: 30 };
  const due = at(2026, 10, 22, 9, 0);
  assert.equal(nextRunAfter(every, due + 5_000, due), due + 30 * MINUTE, "a late fire does not drift the cadence");
  const now = due + 5 * 60 * MINUTE;
  assert.equal(nextRunAfter(every, now, due), now + 30 * MINUTE, "hours of downtime give one catch-up, not a burst");
  assert.equal(nextRunAfter({ kind: "once", at: due }, now, null), due);
  assert.equal(nextRunAfter({ kind: "once", at: due }, now, due), null, "a one-off runs once");
});

test("repeat rules reject malformed input", () => {
  assert.equal(typeof parseScheduleRepeat({ kind: "interval", minutes: 4 }), "string");
  assert.equal(typeof parseScheduleRepeat({ kind: "interval", minutes: 7.5 }), "string");
  assert.equal(typeof parseScheduleRepeat({ kind: "daily", time: "24:00" }), "string");
  assert.equal(typeof parseScheduleRepeat({ kind: "weekly", days: [], time: "09:00" }), "string");
  assert.equal(typeof parseScheduleRepeat({ kind: "weekly", days: [7], time: "09:00" }), "string");
  assert.deepEqual(parseScheduleRepeat({ kind: "weekly", days: [5, 1, 5], time: "09:00" }), { kind: "weekly", days: [1, 5], time: "09:00" });
});

const base = { name: "Nightly check", cwd: agentDir, message: "Run the checks", repeat: { kind: "interval", minutes: 60 } };

test("validates tasks and keeps the store private", async () => {
  await assert.rejects(subject.createScheduledTask({ ...base, name: " " }), { code: "name_required" });
  await assert.rejects(subject.createScheduledTask({ ...base, cwd: "relative/dir" }), { code: "cwd_required" });
  await assert.rejects(subject.createScheduledTask({ ...base, cwd: join(agentDir, "missing") }), { code: "directory_not_found" });
  await assert.rejects(subject.createScheduledTask({ ...base, repeat: { kind: "hourly" } }), { code: "invalid_repeat" });
  await assert.rejects(subject.createScheduledTask({ ...base, provider: "anthropic" }), { code: "invalid_model" });
  await assert.rejects(subject.createScheduledTask({ ...base, repeat: { kind: "once", at: Date.now() + 400 * 24 * 60 * MINUTE } }), { code: "run_at_too_far" });
  await assert.rejects(subject.createScheduledTask({ ...base, keepRuns: 0 }), { code: "invalid_keep_runs" });
  const now = Date.now();
  const task = await subject.createScheduledTask(base, now);
  assert.equal(task.nextRunAt, now + 60 * MINUTE, "the first interval run is one interval out");
  assert.equal(task.keepRuns, subject.DEFAULT_KEEP_RUNS);
  assert.equal(statSync(storeFile).mode & 0o777, 0o600);
  assert.equal(subject.deleteScheduledTask(task.id), true);
  assert.deepEqual(subject.listScheduledTasks(), []);
});

test("a restart runs an overdue task once and schedules the next run from now", async () => {
  const started = [];
  subject.setScheduledTaskRunner(async (task) => { started.push(task.id); return `session-${started.length}`; });
  const now = Date.now();
  writeFileSync(storeFile, JSON.stringify({ tasks: [
    { ...base, id: "overdue", enabled: true, advisor: false, createdAt: now - 10 * 60 * MINUTE, nextRunAt: now - 5 * 60 * MINUTE, runs: [] },
    { ...base, id: "paused", enabled: false, advisor: false, createdAt: now, nextRunAt: now - MINUTE, runs: [] },
  ] }));
  subject.ensureScheduledTasksArmed();
  await sleep(100);
  assert.deepEqual(started, ["overdue"], "paused tasks never run");
  const overdue = subject.listScheduledTasks().find((task) => task.id === "overdue");
  assert.ok(overdue.nextRunAt > now + 59 * MINUTE && overdue.nextRunAt <= Date.now() + 60 * MINUTE);
  assert.deepEqual(overdue.runs.map((run) => [run.status, run.sessionId]), [["started", "session-1"]]);
});

test("new-session triggers are not dropped while an earlier session is starting", async () => {
  const releases = [];
  let fail = false;
  subject.setScheduledTaskRunner(async () => {
    if (fail) throw new Error("omp exited");
    const number = releases.length + 1;
    await new Promise((resolve) => { releases.push(resolve); });
    return `session-${number}`;
  });
  const task = await subject.createScheduledTask(base);
  assert.equal(subject.runScheduledTaskNow(task.id), true);
  subject.runScheduledTaskNow(task.id);
  assert.equal(releases.length, 2, "each trigger starts its own independent session");
  for (const release of releases) release();
  await flush();
  fail = true;
  subject.runScheduledTaskNow(task.id);
  await flush();
  const runs = subject.listScheduledTasks()[0].runs;
  assert.deepEqual(runs.map((run) => [run.status, run.sessionId]), [
    ["started", "session-1"], ["started", "session-2"], ["failed", undefined],
  ]);
  assert.equal(runs[2].error, "omp exited");
  assert.equal(subject.runScheduledTaskNow("missing"), false);
});

test("webhooks and timers use the existing follow-up queue while a target session is busy", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const sessionId = randomUUID();
  const projectDir = join(agentDir, "sessions", "-queue-target");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: agentDir,
  })}\n`);
  let emit;
  const commands = [];
  let acknowledgeFirst;
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame(listener) { emit = listener; return () => {}; },
    sendCommand: (command) => {
      commands.push(command);
      if (commands.length === 1) return new Promise((resolve) => { acknowledgeFirst = resolve; });
      return Promise.resolve({});
    },
    dispose: async () => {},
  }, agentDir, null, false, sessionId);
  wrapper.start();
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(sessionId, wrapper);
  t.after(async () => {
    acknowledgeFirst?.({});
    await wrapper.destroyAndWait();
    globalThis.__ompSessions.delete(sessionId);
  });
  const hook = await subject.createScheduledTask({
    ...base, targetSessionId: sessionId, repeat: { kind: "webhook" }, webhookIncludeBody: true,
  });
  // The first prompt is still awaiting its ack when the second trigger arrives.
  subject.triggerScheduledTaskWebhook(hook.webhookToken, "first");
  subject.triggerScheduledTaskWebhook(hook.webhookToken, "second");
  emit({ type: "agent_start" });
  const timed = await subject.createScheduledTask({
    ...base, targetSessionId: sessionId, message: "timer", repeat: { kind: "once", at: Date.now() + 100 },
  });
  t.mock.timers.tick(100);
  await flush();
  assert.deepEqual(commands.map((command) => command.type), ["prompt", "follow_up", "follow_up"]);
  assert.match(commands[0].message, /<webhook-body>\nfirst\n<\/webhook-body>$/);
  assert.match(commands[1].message, /<webhook-body>\nsecond\n<\/webhook-body>$/);
  assert.equal(commands[2].message, "timer");
  acknowledgeFirst({});
  await flush();
  assert.deepEqual(subject.listScheduledTasks().find((task) => task.id === hook.id).runs.map((run) => run.status), ["started", "started"]);
  assert.equal(subject.listScheduledTasks().find((task) => task.id === timed.id).nextRunAt, null);
  emit({ type: "agent_end", isTerminal: true });
  subject.triggerScheduledTaskWebhook(hook.webhookToken, "idle again");
  await flush();
  assert.equal(commands.at(-1).type, "prompt", "idle sessions start immediately instead of waiting in a queue");
});

test("a one-off task runs once and then has nothing scheduled", async () => {
  const started = [];
  subject.setScheduledTaskRunner(async (task) => { started.push(task.id); return "once-session"; });
  const task = await subject.createScheduledTask({ ...base, repeat: { kind: "once", at: Date.now() + 30 } });
  await sleep(150);
  assert.deepEqual(started, [task.id]);
  assert.equal(subject.listScheduledTasks()[0].nextRunAt, null);
});

test("a session task targets the existing session and never archives it", async () => {
  const sessionId = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const projectDir = join(agentDir, "sessions", "-tmp-project");
  mkdirSync(projectDir, { recursive: true });
  const sessionFile = join(projectDir, `2026-10-22T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/tmp/project" })}\n`);
  const delivered = [];
  subject.setScheduledTaskRunner(async (task) => { delivered.push(task.targetSessionId); return task.targetSessionId; });
  await assert.rejects(subject.createScheduledTask({ ...base, targetSessionId: "0199ffff-0000-7000-8000-000000000000" }), { code: "session_not_found" });
  const task = await subject.createScheduledTask({ name: "Ping", targetSessionId: sessionId, message: "status?", repeat: { kind: "interval", minutes: 30 }, keepRuns: 1 });
  assert.equal(task.cwd, "/tmp/project", "the workspace comes from the session");
  subject.runScheduledTaskNow(task.id);
  await sleep(30);
  subject.runScheduledTaskNow(task.id);
  await sleep(60);
  assert.deepEqual(delivered, [sessionId, sessionId]);
  assert.ok(existsSync(sessionFile), "keepRuns never archives the target session");
  assert.deepEqual(subject.listScheduledTasks()[0].runs.map((run) => run.archived ?? false), [false, false]);
});

test("a webhook task runs only through its token, appends the body as data, and rotates its URL", async () => {
  const prompts = [];
  subject.setScheduledTaskRunner(async (_task, _at, prompt) => { prompts.push(prompt); return `hook-${prompts.length}`; });
  const task = await subject.createScheduledTask({ ...base, repeat: { kind: "webhook" }, webhookIncludeBody: true });
  assert.equal(task.nextRunAt, null, "a webhook task has no schedule");
  assert.match(task.webhookToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(subject.triggerScheduledTaskWebhook("x".repeat(43), null), "not_found");
  assert.equal(subject.triggerScheduledTaskWebhook("short", null), "not_found");

  assert.equal(subject.triggerScheduledTaskWebhook(task.webhookToken, '{"ref":"main"}'), "accepted");
  await sleep(30);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].startsWith(base.message));
  assert.match(prompts[0], /<webhook-body>\n\{"ref":"main"\}\n<\/webhook-body>$/);
  assert.equal(subject.listScheduledTasks()[0].runs[0].trigger, "webhook");

  const edited = await subject.updateScheduledTask(task.id, { ...base, message: "Edited", repeat: { kind: "webhook" } });
  assert.equal(edited.webhookToken, task.webhookToken, "editing keeps the URL");
  subject.triggerScheduledTaskWebhook(task.webhookToken, "ignored body");
  await sleep(30);
  assert.equal(prompts[1], "Edited", "the body is dropped unless the task opts in");

  const rotated = subject.regenerateScheduledTaskWebhook(task.id);
  assert.notEqual(rotated.webhookToken, task.webhookToken);
  assert.equal(subject.triggerScheduledTaskWebhook(task.webhookToken, null), "not_found", "the old URL stops working");
  subject.setScheduledTaskEnabled(task.id, false);
  assert.equal(subject.triggerScheduledTaskWebhook(rotated.webhookToken, null), "disabled");

  const scheduled = await subject.updateScheduledTask(task.id, base);
  assert.equal(scheduled.webhookToken, undefined, "leaving webhook mode revokes the URL");
  assert.equal(subject.triggerScheduledTaskWebhook(rotated.webhookToken, null), "not_found");
});

// A real omp-web learns of new session files through invalidateSessionListCache
// (fired on agent_end etc.); the fixture writes them directly.
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");

function writeSession(sessionId) {
  const projectDir = join(agentDir, "sessions", "-tmp-agent");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `2026-10-22T00-00-00-000Z_${sessionId}.jsonl`),
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/tmp/agent" })}\n`,
  );
  invalidateSessionListCache();
}

test("a webhook limited to chosen interfaces answers only on its dedicated listener", async () => {
  const { networkInterfaces } = await import("node:os");
  const { createServer } = await import("node:net");
  const loopback = Object.entries(networkInterfaces()).find(([, entries]) => entries?.some((entry) => entry.address === "127.0.0.1"))?.[0];
  assert.ok(loopback, "the test host has a loopback interface");
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
  });
  const prompts = [];
  subject.setScheduledTaskRunner(async (_task, _at, prompt) => { prompts.push(prompt); return `listen-${prompts.length}`; });
  const task = await subject.createScheduledTask({
    ...base, repeat: { kind: "webhook" }, webhookIncludeBody: true, webhookListen: { interfaces: [loopback], port },
  });
  const endpoint = task.webhookEndpoints.find((entry) => entry.address === "127.0.0.1");
  assert.equal(endpoint.url, `http://127.0.0.1:${port}/hooks/${task.webhookToken}`);
  await sleep(50);

  assert.equal(subject.triggerScheduledTaskWebhook(task.webhookToken, null), "not_found", "omp-web's own route refuses it");
  assert.equal((await fetch(`http://127.0.0.1:${port}/hooks/${"x".repeat(43)}`, { method: "POST" })).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`, { method: "POST" })).status, 404, "only /hooks/<token> is served");
  const response = await fetch(endpoint.url, { method: "POST", body: '{"via":"listener"}' });
  assert.equal(response.status, 202);
  await sleep(30);
  assert.match(prompts[0], /<webhook-body>\n\{"via":"listener"\}\n<\/webhook-body>$/);
  assert.equal(
    subject.triggerScheduledTaskWebhook(task.webhookToken, null, { iface: loopback, address: "127.0.0.1", port: port + 1 }),
    "not_found",
    "another port is not where the task listens",
  );

  const moved = await subject.updateScheduledTask(task.id, { ...base, repeat: { kind: "webhook" } });
  assert.equal(moved.webhookToken, task.webhookToken, "switching back keeps the token");
  assert.equal(moved.webhookEndpoints, undefined);
  await sleep(50);
  await assert.rejects(fetch(endpoint.url, { method: "POST" }), "the dedicated listener is closed");
  assert.equal(subject.triggerScheduledTaskWebhook(task.webhookToken, null), "accepted", "omp-web's own route works again");

  await assert.rejects(
    subject.updateScheduledTask(task.id, { ...base, repeat: { kind: "webhook" }, webhookListen: { interfaces: [], port } }),
    (error) => error.code === "invalid_webhook_listen",
  );
});

test("an agent wake-up webhook targets its own session, fires once and is then gone", async () => {
  const mine = "0199aaaa-0000-7000-8000-000000000001";
  const other = "0199aaaa-0000-7000-8000-000000000002";
  writeSession(mine);
  writeSession(other);
  const delivered = [];
  subject.setScheduledTaskRunner(async (task, _at, prompt) => { delivered.push([task.targetSessionId, prompt]); return task.targetSessionId; });

  const task = await subject.createAgentTask(mine, { name: "train", message: "Training finished; read job.log", repeat: { kind: "webhook" } });
  assert.equal(task.targetSessionId, mine);
  assert.equal(task.createdByAgent, true);
  assert.ok(task.expiresAt > Date.now() + 6 * 24 * 60 * MINUTE, "unused URLs expire after the default 7 days");
  assert.equal(subject.listAgentTasks(other).length, 0, "another session does not see it");
  assert.equal(subject.cancelAgentTask(other, task.id), false, "nor can it cancel it");

  assert.equal(subject.triggerScheduledTaskWebhook(task.webhookToken, "exit=0"), "accepted");
  assert.equal(subject.triggerScheduledTaskWebhook(task.webhookToken, "exit=0"), "not_found", "a retrying caller cannot wake it twice");
  await sleep(30);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0][0], mine);
  assert.match(delivered[0][1], /^Training finished; read job\.log[\s\S]*<webhook-body>\nexit=0\n<\/webhook-body>$/, "the body always rides along");
  assert.deepEqual(subject.listScheduledTasks(), [], "a delivered one-shot is removed");
});

test("an agent wake-up webhook can listen on chosen interfaces and is then only reachable there", async () => {
  const { networkInterfaces } = await import("node:os");
  const { createServer } = await import("node:net");
  const loopback = Object.entries(networkInterfaces()).find(([, entries]) => entries?.some((entry) => entry.address === "127.0.0.1"))?.[0];
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); });
  });
  const mine = "0199aaaa-0000-7000-8000-000000000003";
  writeSession(mine);
  const delivered = [];
  subject.setScheduledTaskRunner(async (task, _at, prompt) => { delivered.push(prompt); return task.targetSessionId; });

  await assert.rejects(
    subject.createAgentTask(mine, { name: "x", message: "y", repeat: { kind: "once", at: Date.now() + MINUTE }, webhookListen: { interfaces: [loopback], port } }),
    (error) => error.code === "invalid_webhook_listen",
    "only a webhook can choose where it listens",
  );
  const task = await subject.createAgentTask(mine, { name: "job", message: "Job done", repeat: { kind: "webhook" }, webhookListen: { interfaces: [loopback], port } });
  const url = task.webhookEndpoints.find((entry) => entry.address === "127.0.0.1").url;
  await sleep(50);
  assert.equal(subject.triggerScheduledTaskWebhook(task.webhookToken, "exit=0"), "not_found", "not on omp-web's own route");
  assert.equal((await fetch(url, { method: "POST", body: "exit=0" })).status, 202);
  await sleep(30);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /<webhook-body>\nexit=0\n<\/webhook-body>$/);
  assert.deepEqual(subject.listAgentTasks(mine), [], "a delivered one-shot is removed");
  await sleep(50);
  await assert.rejects(fetch(url, { method: "POST", body: "exit=0" }), "its listener closes, so a retry cannot wake the session again");
});

test("agent tasks are capped per session, cancellable by their session, and expire unused", async () => {
  const sessionId = "0199aaaa-0000-7000-8000-000000000003";
  writeSession(sessionId);
  subject.setScheduledTaskRunner(async (task) => task.targetSessionId);
  const ids = [];
  for (let i = 0; i < subject.MAX_AGENT_TASKS_PER_SESSION; i++) {
    ids.push((await subject.createAgentTask(sessionId, { name: `t${i}`, message: "check", repeat: { kind: "interval", minutes: 60 } })).id);
  }
  await assert.rejects(subject.createAgentTask(sessionId, { name: "extra", message: "check", repeat: { kind: "interval", minutes: 60 } }), { code: "too_many_tasks" });
  assert.equal(subject.cancelAgentTask(sessionId, ids[0]), true);
  assert.equal(subject.listAgentTasks(sessionId).length, subject.MAX_AGENT_TASKS_PER_SESSION - 1);
  for (const id of ids.slice(1)) subject.cancelAgentTask(sessionId, id);

  await assert.rejects(subject.createAgentTask(sessionId, { name: "w", message: "m", repeat: { kind: "webhook" }, expiresInHours: 0 }), { code: "invalid_expiry" });
  const short = await subject.createAgentTask(sessionId, { name: "w", message: "m", repeat: { kind: "webhook" }, expiresInHours: 0.00002 });
  await sleep(150);
  assert.equal(subject.listAgentTasks(sessionId).some((task) => task.id === short.id), false, "an unused URL is deleted at expiry");
  assert.equal(subject.triggerScheduledTaskWebhook(short.webhookToken, null), "not_found");
});
