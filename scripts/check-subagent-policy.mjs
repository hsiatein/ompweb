import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { stringify } from "yaml";

// Opt-in integration check against the installed OMP, with no real credentials.
// Run from the package root: node scripts/check-subagent-policy.mjs [case,case]
const jiti = createJiti(import.meta.url);
const { RpcProcess } = jiti("../lib/omp/rpc-process.ts");
const { saveWebServerSettings } = jiti("../lib/web-settings.ts");
const root = await mkdtemp(join(tmpdir(), "omp-subagent-policy-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
await mkdir(agentDir);
await mkdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = root;
const agentsDir = join(root, ".omp", "agent", "agents");
await mkdir(agentsDir, { recursive: true });
await writeFile(join(agentsDir, "smoke.md"), "---\nname: smoke\ndescription: Local policy verification\nmodel: single-agent-test/policy-child\nblocking: true\n---\nReply with POLICY_CHILD_FINISHED.\n");
let active;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    active.requests.push(body);
    assert.equal(req.url, "/v1/chat/completions");
    assert.ok(["policy-main", "policy-child"].includes(body.model), "Unexpected model route");
    const child = body.model === "policy-child";
    assert.ok(!child || active.allowChild, "Disabled spawning reached a child model");
    const mainCalls = active.requests.filter(request => request.model === "policy-main");
    assert.ok(mainCalls.length <= 2, "Unexpected additional main request");
    const toolCall = !child && mainCalls.length === 1;
    const delta = toolCall ? {
      role: "assistant", content: null,
      tool_calls: [{ index: 0, id: "call_policy_test", type: "function",
        function: { name: active.tool, arguments: JSON.stringify(active.args) } }],
    } : { role: "assistant", content: child ? "POLICY_CHILD_FINISHED" : "POLICY_TEST_FINISHED" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (d, finish) => ({ id: "policy-test", object: "chat.completion.chunk",
      created: 1, model: body.model, choices: [{ index: 0, delta: d, finish_reason: finish }] });
    res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, toolCall ? "tool_calls" : "stop"))}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    active.error = error;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: String(error), type: "invalid_request_error" } }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const model = (id) => ({ id, name: id, reasoning: false, input: ["text"],
  contextWindow: 32768, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
await writeFile(join(agentDir, "models.yml"), stringify({ providers: {
  "single-agent-test": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    api: "openai-completions", apiKey: "local-test-only",
    models: [model("policy-main"), model("policy-child")] },
} }));
const config = join(root, "unrestricted.yml");
const cases = [
  { name: "task", tool: "task", args: { task: "Reply OK" }, denied: /Tool task not found/ },
  { name: "task-batch", tool: "task", args: { context: "Local probe", tasks:
    Array.from({ length: 68 }, (_, i) => ({ name: `probe-${i}`, task: "Reply OK" })) }, denied: /Tool task not found/ },
  { name: "eval-agent", tool: "eval", args: { language: "js", code: 'await agent("Reply OK");' }, denied: /maximum depth is 0/ },
  { name: "eval-workpool", tool: "eval", args: { language: "js", code: 'await workpool({ name: "policy-probe" });' }, denied: /maximum depth is 0/ },
  { name: "eval-python-agent", tool: "eval", args: { language: "py", code: 'agent("Reply OK")' }, denied: /maximum depth is 0/ },
  { name: "eval-python-workpool", tool: "eval", args: { language: "py", code: 'workpool(name="policy-probe")' }, denied: /maximum depth is 0/ },
  { name: "xdev-task", xdev: true, tool: "write", args: { path: "xd://task", content: JSON.stringify({ task: "Reply OK" }) }, denied: /No such tool: xd:\/\/task/ },
  { name: "xdev-eval-agent", xdev: true, tool: "write", args: { path: "xd://eval", content: JSON.stringify({ language: "js", code: 'await agent("Reply OK");' }) }, denied: /maximum depth is 0/ },
  { name: "eval-normal", tool: "eval", args: { language: "js", code: 'console.log("NORMAL_EVAL_OK");' }, expected: /NORMAL_EVAL_OK/ },
  { name: "read-normal", tool: "read", args: { path: "fixture.txt" }, expected: /NORMAL_READ_OK/ },
  { name: "write-normal", tool: "write", args: { path: "written.txt", content: "NORMAL_WRITE_OK" }, expected: /success|written|wrote/i },
  { name: "enabled-task", enabled: true, allowChild: true, tool: "task", args: { agent: "smoke", task: "Reply OK", solutionSpace: "Return the requested text." }, expected: /POLICY_CHILD_FINISHED/ },
  { name: "enabled-zero-depth", enabled: true, maxDepth: 0, tool: "eval", args: { language: "js", code: 'await agent("Reply OK");' }, denied: /maximum depth is 0/ },
];
await writeFile(join(cwd, "fixture.txt"), "NORMAL_READ_OK\n");
try {
  for (const test of cases) {
    if (process.argv[2] && !process.argv[2].split(",").includes(test.name)) continue;
    saveWebServerSettings({ subagentsEnabled: test.enabled === true });
    await writeFile(join(agentDir, "config.yml"), stringify({ task: { maxRecursionDepth: test.maxDepth ?? 1, maxConcurrency: 2 } }));
    await writeFile(config, stringify({
      task: { maxRecursionDepth: 5, maxConcurrency: 64, speculativeLaunch: !test.enabled, batch: !test.allowChild, structured: false },
      tools: { xdev: test.xdev ?? false, approval: { task: "allow" } },
      modelRoles: { default: "single-agent-test/policy-main", task: "single-agent-test/policy-child" },
      compaction: { enabled: false },
      advisor: { enabled: false },
    }));
    active = { ...test, requests: [], frames: [] };
    let done;
    let failed;
    const terminal = new Promise((resolve, reject) => { done = resolve; failed = reject; });
    // Attach immediately so an early process exit cannot become unhandled.
    terminal.catch(() => {});
    const proc = new RpcProcess({ cwd,
      env: { PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", PI_PROFILE: "" },
      extraArgs: ["--model", "single-agent-test/policy-main", "--thinking", "off",
        "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title",
        "--config", config],
      onFrame(frame) {
        active.frames.push(frame);
        if (frame.type === "agent_end" && frame.isTerminal !== false) done();
      },
      onExit(info) { failed(new Error(`OMP exited early: ${JSON.stringify(info)}`)); },
    });
    const timer = setTimeout(() => failed(new Error(`Timed out: ${test.name}`)), 60000);
    try {
      const ready = await proc.waitReady();
      await proc.negotiateProtocol(ready);
      await proc.sendCommand({ type: "prompt", message: "Run the local policy probe." });
      await terminal;
      if (active.error) throw active.error;
      const mainRequests = active.requests.filter(request => request.model === "policy-main");
      const childRequests = active.requests.filter(request => request.model === "policy-child");
      assert.equal(mainRequests.length, 2, JSON.stringify(active.frames).slice(-4000));
      assert.equal(childRequests.length, test.allowChild ? 1 : 0);
      const tools = mainRequests[0].tools?.map((tool) => tool.function.name) ?? [];
      assert.equal(tools.includes("task"), test.allowChild === true);
      const results = mainRequests[1].messages.filter((message) => message.role === "tool");
      const result = JSON.stringify(results);
      assert.ok(results.length > 0, "Missing tool result");
      if (test.denied) assert.match(result, test.denied);
      else assert.match(result, test.expected);
      console.log(JSON.stringify({ test: test.name, passed: true, requests: active.requests.length, result: result.slice(0, 1600) }));
    } catch (error) {
      console.error(JSON.stringify({ test: test.name, requests: active.requests.length, frames: active.frames.slice(-4) }));
      throw error;
    } finally {
      clearTimeout(timer);
      await proc.dispose(500);
    }
  }
} finally {
  server.closeAllConnections();
  server.close();
  // root is created by mkdtemp above, never a caller-supplied directory.
  await rm(root, { recursive: true, force: true });
}
