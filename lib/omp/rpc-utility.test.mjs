import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const routingRoot = mkdtempSync(join(tmpdir(), "omp-utility-routing-"));
process.env.PI_CODING_AGENT_DIR = routingRoot;
test.after(() => rmSync(routingRoot, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url);
const { startControlRpc } = jiti("./rpc-control.ts");

function harness(failures = []) {
  const launches = [];
  const commands = [];
  const children = [];
  const dependencies = {
    resolveOmpBin: () => "fake-omp",
    spawn(_file, args, options) {
      const index = launches.length;
      launches.push({ args, options });
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      children.push(child);
      let partial = "";
      child.stdin.on("data", chunk => {
        partial += chunk.toString();
        const lines = partial.split("\n");
        partial = lines.pop();
        for (const line of lines.filter(Boolean)) {
          const command = JSON.parse(line);
          commands.push(command);
          const data = command.type === "negotiate_protocol"
            ? { protocolVersion: 2 }
            : { providers: [{ id: "example", authenticated: false }] };
          child.stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })}\n`);
        }
      });
      child.stdin.on("end", () => child.emit("exit", 0, null));
      queueMicrotask(() => {
        if (failures[index]) {
          child.stderr.write(failures[index]);
          child.emit("exit", 1, null);
        } else {
          child.stdout.write(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2], requestPolicyVersion: 1, accountProxyVersion: 1 })}\n`);
        }
      });
      return child;
    },
  };
  return { launches, commands, children, options: { cwd: process.cwd(), extraArgs: ["--no-session", "--no-skills"], dependencies } };
}

test("configured utility profiles retain their model selection and negotiate before commands", async () => {
  const h = harness();
  const proc = await startControlRpc(h.options, 1000);
  try {
    const result = await proc.sendCommand({ type: "get_login_providers" }, 1000);
    assert.equal(result.providers.length, 1);
    assert.equal(h.launches.length, 1);
    assert.equal(h.launches[0].args.includes("--model"), false);
    assert.deepEqual(h.commands.map(c => c.type), ["negotiate_protocol", "get_login_providers"]);
  } finally { await proc.dispose(0); }
});

test("fresh profiles retry without credentials, prompts, or persistent model changes", async () => {
  const h = harness(["No models available. Use /login or set an API key environment variable."]);
  const proc = await startControlRpc(h.options, 1000);
  try {
    await proc.sendCommand({ type: "get_login_providers" }, 1000);
    assert.equal(h.launches.length, 2);
    const { args, options } = h.launches[1];
    assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4-5");
    assert.ok(args.includes("--no-session"));
    assert.equal(args.includes("--api-key"), false);
    assert.deepEqual(options.env, h.launches[0].options.env);
    assert.deepEqual(h.commands.map(c => c.type), ["negotiate_protocol", "get_login_providers"]);
  } finally { await proc.dispose(0); }
});

test("configuration failures and explicit model choices are never replaced by a bootstrap model", async () => {
  for (const [error, extraArgs] of [
    ["Invalid models.yml", []],
    ["No models available.", ["--model", "custom/my-model"]],
    ["No models available.", ["--provider=custom"]],
  ]) {
    const h = harness([error]);
    await assert.rejects(startControlRpc({ ...h.options, extraArgs: [...h.options.extraArgs, ...extraArgs] }, 1000), /omp exited/);
    assert.equal(h.launches.length, 1);
  }
});

test("bootstrap failures terminate after one retry", async () => {
  const h = harness(["No models available.", "Unknown model"]);
  await assert.rejects(startControlRpc(h.options, 1000), /Unknown model/);
  assert.equal(h.launches.length, 2);
});

test("control startup requires ephemeral sessions and honors cancellation", async () => {
  const h = harness();
  await assert.rejects(startControlRpc({ ...h.options, extraArgs: [] }, 1000), /requires --no-session/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(startControlRpc(h.options, 1000, controller.signal), /Request aborted/);
  assert.equal(h.launches.length, 0);
});
