import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "omp-plugin-host-test-"));
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startWebPluginHost, stopWebPluginHost } = await jiti.import("./web-plugin-host.ts");
const { getWebModels } = await jiti.import("./web-models.ts");
const catalog = {
  models: { "test:one": "One" }, modelList: [{ provider: "test", id: "one", name: "One" }],
  defaultModel: { provider: "test", modelId: "one" }, thinkingLevels: { "test:one": ["off", "low"] },
};
globalThis.__piModelsCacheState = { entries: new Map([["global", { data: catalog, expiresAt: Date.now() + 60000 }]]), inFlight: new Map(), generation: 0 };
const calls = [];
globalThis.__ompWebPluginHost = {
  sockets: new Map(),
  gateway: { async request(path, method, body, res) { calls.push({ path, method, body }); res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); } },
};
let socket;
test.before(async () => { socket = await startWebPluginHost("catalog-test", () => {}); });
test.after(() => { stopWebPluginHost("catalog-test"); rmSync(root, { recursive: true, force: true }); });
function request(path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path, headers, method: body ? "POST" : "GET" }, res => {
      let text = "";
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
test("host and composer share catalog/default while host exposes ordered selectable efforts", async () => {
  const web = await getWebModels();
  const result = await request("/omp/models");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.modelList, web.modelList);
  assert.deepEqual(result.data.defaultModel, web.defaultModel);
  assert.deepEqual(result.data.thinkingLevels["test:one"], ["auto", "off", "low"]);
});
test("automatic routing uses shared gateway and invalid pins fail before model dispatch", async () => {
  assert.equal((await request("/v1/chat/completions", {}, { model: "test/one" })).status, 200);
  assert.equal(calls.length, 1);
  for (const value of ["!", Buffer.from(JSON.stringify({ pins: { test: "invalid-key" } })).toString("base64url")]) {
    assert.equal((await request("/v1/chat/completions", { "x-omp-account-routing": value }, { model: "test/one" })).status, 400);
  }
  assert.equal(calls.length, 1);
});
