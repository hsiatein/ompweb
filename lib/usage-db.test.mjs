import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
async function loadSubject() {
  return jiti.import("./usage-db.ts");
}

async function withTempDbDir(run) {
  const dir = join(tmpdir(), `omp-test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  const { closeUsageDatabase, getUsageDatabase } = await loadSubject();

  try {
    const db = getUsageDatabase(join(dir, "test-usage.db"));
    await run(dir, db);
  } finally {
    closeUsageDatabase();
    if (prevAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("usage database creates tables and indexes on initialization", async () => {
  await withTempDbDir(async (_dir, db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all()
      .map((row) => row.name);

    assert.ok(tables.includes("synced_files"));
    assert.ok(tables.includes("usage_records"));

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;")
      .all()
      .map((row) => row.name);

    assert.ok(indexes.includes("idx_usage_records_timestamp"));
    assert.ok(indexes.includes("idx_usage_records_file_path"));
    assert.ok(indexes.includes("idx_usage_records_provider"));
    assert.ok(indexes.includes("idx_usage_records_session_cwd"));
  });
});

test("syncSessionFilesToDb performs incremental synchronization", async () => {
  const { syncSessionFilesToDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    const sessionsDir = join(dir, "sessions", "my-project");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionFile1 = join(sessionsDir, "sess-1.jsonl");
    const sessionFile2 = join(sessionsDir, "sess-2.jsonl");
    const now = Date.now();

    writeFileSync(
      sessionFile1,
      [
        JSON.stringify({ type: "session", id: "sess-1", cwd: "/home/user/my-project", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            usage: { input: 10000, output: 2000, cacheRead: 5000, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      sessionFile2,
      [
        JSON.stringify({ type: "session", id: "sess-2", cwd: "/home/user/my-project", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 4000, output: 1000, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    // 1. Initial sync
    const stats1 = syncSessionFilesToDb([sessionFile1, sessionFile2], { providers: {} }, db);
    assert.equal(stats1.filesScanned, 2);
    assert.equal(stats1.filesUpdated, 2);
    assert.equal(stats1.recordsInserted, 2);

    // Verify row counts in SQLite
    const countRow1 = db.prepare("SELECT COUNT(*) as c FROM usage_records;").get();
    assert.equal(countRow1.c, 2);

    // 2. Second sync with no file changes (should be 0 updates)
    const stats2 = syncSessionFilesToDb([sessionFile1, sessionFile2], { providers: {} }, db);
    assert.equal(stats2.filesUpdated, 0);
    assert.equal(stats2.recordsInserted, 0);

    // 3. Delete one file from the list
    const stats3 = syncSessionFilesToDb([sessionFile1], { providers: {} }, db);
    assert.equal(stats3.filesDeleted, 1);

    const countRow3 = db.prepare("SELECT COUNT(*) as c FROM usage_records;").get();
    assert.equal(countRow3.c, 1);

    // 4. Truncate sessionFile1 to 0 bytes (should purge its records on next sync)
    writeFileSync(sessionFile1, "", "utf8");
    const stats4 = syncSessionFilesToDb([sessionFile1], { providers: {} }, db);
    assert.equal(stats4.filesDeleted, 1);

    const countRow4 = db.prepare("SELECT COUNT(*) as c FROM usage_records;").get();
    assert.equal(countRow4.c, 0);
  });
});

test("getUsageReportFromDb executes fast SQL aggregations", async () => {
  const { syncSessionFilesToDb, getUsageReportFromDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    const sessionsDir = join(dir, "sessions", "alpha");
    mkdirSync(sessionsDir, { recursive: true });

    const now = Date.now();
    const sessionFile = join(sessionsDir, "alpha-session.jsonl");

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "alpha-1", cwd: "/workspace/alpha", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            usage: { input: 20000, output: 4000, cacheRead: 10000, cacheWrite: 0, reasoning: 1500 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    syncSessionFilesToDb([sessionFile], { providers: {} }, db);

    const report = await getUsageReportFromDb({ range: "30d" }, db);

    assert.equal(report.timeRange, "30d");
    assert.equal(report.granularity, "daily");

    // Summary validation
    assert.ok(report.summary.totalCost > 0);
    assert.equal(report.summary.inputTokens, 20000);
    assert.equal(report.summary.outputTokens, 4000);
    assert.equal(report.summary.cacheReadTokens, 10000);
    assert.equal(report.summary.reasoningTokens, 1500);
    assert.equal(report.summary.totalTokens, 34000);
    assert.equal(report.summary.activeDays, 1);

    // Providers validation
    assert.equal(report.providers.length, 1);
    assert.equal(report.providers[0].provider, "anthropic");
    assert.equal(report.providers[0].name, "Anthropic");

    // Model breakdown validation
    assert.equal(report.modelBreakdown.length, 1);
    assert.equal(report.modelBreakdown[0].model, "claude-3-7-sonnet");

    // Project breakdown validation
    assert.equal(report.projectBreakdown.length, 1);
    assert.equal(report.projectBreakdown[0].projectName, "alpha");
  });
});

test("subagent transcripts count toward their top-level session, nested ones included", async () => {
  const { syncSessionFilesToDb, getUsageReportFromDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    const projectDir = join(dir, "sessions", "-workspace-beta");
    const sessionId = "01a1aaaa-0000-7000-8000-000000000001";
    const sessionFile = join(projectDir, `2026-11-06T00-00-00-000Z_${sessionId}.jsonl`);
    const artifacts = sessionFile.slice(0, -".jsonl".length);
    mkdirSync(join(artifacts, "Scout"), { recursive: true });
    const now = new Date().toISOString();
    const assistant = (provider, model, input, output) => JSON.stringify({
      type: "message", timestamp: now, message: { role: "assistant", provider, model, usage: { input, output, cacheRead: 0, cacheWrite: 0 } },
    });
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: sessionId, cwd: "/workspace/beta", timestamp: now }),
      assistant("anthropic", "claude-opus-5-5", 1000, 100),
      // The task tool's own result must not count the subagent a second time.
      JSON.stringify({ type: "message", timestamp: now, message: {
        role: "toolResult", toolName: "task",
        details: { results: [{ id: "Scout", usage: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0 } }] },
      } }),
    ].join("\n"));
    writeFileSync(join(artifacts, "Scout.jsonl"), [
      JSON.stringify({ type: "session", id: "01a1aaaa-0000-7000-8000-0000000000aa", cwd: "/workspace/beta", timestamp: now }),
      assistant("openai-codex", "gpt-5.5", 2000, 200),
    ].join("\n"));
    writeFileSync(join(artifacts, "Scout", "Scout.Deep.jsonl"), [
      JSON.stringify({ type: "session", id: "01a1aaaa-0000-7000-8000-0000000000bb", cwd: "/workspace/beta", timestamp: now }),
      assistant("openai-codex", "gpt-5.5", 3000, 300),
    ].join("\n"));

    const stats = syncSessionFilesToDb([sessionFile], { providers: {} }, db);
    assert.equal(stats.filesScanned, 3);
    const report = await getUsageReportFromDb({ range: "30d" }, db);
    assert.equal(report.summary.inputTokens, 6000);
    assert.equal(report.summary.outputTokens, 600);
    assert.equal(report.projectBreakdown.length, 1);
    assert.equal(report.projectBreakdown[0].sessionsCount, 1, "subagents are part of their session, not sessions of their own");
  });
});

test("model breakdown reports per-model request speeds from omp's recorded durations", async () => {
  const { syncSessionFilesToDb, getUsageReportFromDb } = await loadSubject();
  await withTempDbDir(async (dir, db) => {
    const sessionsDir = join(dir, "sessions", "speed");
    mkdirSync(sessionsDir, { recursive: true });
    const now = Date.now();
    const sessionFile = join(sessionsDir, "speed.jsonl");
    const message = (model, usage, extra) => JSON.stringify({ type: "message", message: { role: "assistant", provider: "openai-codex", model, timestamp: now, usage, ...extra } });
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "speed-1", cwd: "/workspace/speed", timestamp: new Date(now).toISOString() }),
      message("fast", { input: 10, output: 100 }, { duration: 1000, ttft: 500 }),
      message("fast", { input: 10, output: 300 }, { duration: 6000 }),
      message("fast", { input: 10, output: 50 }, {}), // no duration: counted in tokens, not in speed
      message("fast", { input: 10, output: 50 }, { duration: 40 }), // too short to measure
      message("untimed", { input: 10, output: 50 }, {}),
    ].join("\n"), "utf8");
    syncSessionFilesToDb([sessionFile], { providers: {} }, db);
    const report = await getUsageReportFromDb({ range: "30d" }, db);
    const fast = report.modelBreakdown.find((m) => m.model === "fast");
    assert.equal(fast.recordsCount, 4);
    assert.equal(fast.speedSamples, 2);
    assert.equal(fast.meanTps, 75);
    assert.ok(Math.abs(fast.tokenWeightedTps - 400 / 7) < 1e-9);
    assert.equal(fast.meanDecodeTps, 200);
    assert.equal(fast.meanTtftMs, 500);
    const untimed = report.modelBreakdown.find((m) => m.model === "untimed");
    assert.equal(untimed.speedSamples, 0);
    assert.equal(untimed.meanTps, null);
  });
});

test("an older usage database gains the speed columns and is rescanned once", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { getUsageDatabase, closeUsageDatabase } = await loadSubject();
  const dir = join(tmpdir(), `omp-test-db-old-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE synced_files (file_path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, file_size INTEGER NOT NULL, records_count INTEGER NOT NULL, synced_at INTEGER NOT NULL);
    CREATE TABLE usage_records (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, session_id TEXT NOT NULL, session_cwd TEXT NOT NULL, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, cost REAL NOT NULL, cache_savings REAL NOT NULL, cost_quality TEXT NOT NULL);
    INSERT INTO synced_files VALUES ('/x.jsonl', 1, 1, 1, 1);
    INSERT INTO usage_records (file_path, session_id, session_cwd, timestamp, provider, model, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, cache_savings, cost_quality) VALUES ('/x.jsonl', 's', '/', 1, 'p', 'm', 1, 1, 0, 0, 0, 2, 0, 0, 'unpriced');`);
  old.close();
  try {
    const db = getUsageDatabase(path);
    const columns = db.prepare("PRAGMA table_info(usage_records)").all().map((c) => c.name);
    assert.ok(columns.includes("duration_ms") && columns.includes("ttft_ms"));
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM synced_files").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM usage_records").get().c, 0);
  } finally {
    closeUsageDatabase();
    rmSync(dir, { recursive: true, force: true });
  }
});
