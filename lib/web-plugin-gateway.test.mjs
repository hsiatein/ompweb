import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayReplies } from "./web-plugin-gateway.ts";

function response() {
  return {
    statusCode: 0, headers: new Map(), chunks: [], ended: false, flushed: false,
    setHeader(name, value) { this.headers.set(name, value); },
    hasHeader(name) { return this.headers.has(name); },
    flushHeaders() { this.flushed = true; },
    write(chunk) { this.chunks.push(chunk); },
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk); this.ended = true; },
  };
}

test("interleaved streams flush headers and chunks before either completes", () => {
  const replies = new GatewayReplies();
  const a = response(), b = response();
  replies.pending.set("a", { response: a, fail: assert.fail });
  replies.pending.set("b", { response: b, fail: assert.fail });
  replies.accept({ id: "a", chunked: true, status: 201, headers: { "content-type": "text/event-stream" } });
  replies.accept({ id: "b", chunked: true, status: 200 });
  assert.equal(a.flushed, true);
  replies.accept({ id: "a", chunk: "data: 秋\n\n" });
  replies.accept({ id: "b", chunk: "data: second\n\n" });
  assert.deepEqual(a.chunks, ["data: 秋\n\n"]);
  assert.equal(a.ended, false);
  replies.accept({ id: "b", end: true });
  assert.equal(b.ended, true);
  assert.equal(a.ended, false);
  replies.accept({ id: "a", end: true });
  assert.equal(replies.pending.size, 0);
  assert.equal(a.statusCode, 201);
});

test("legacy JSON, SSE and binary responses preserve body and status", () => {
  const replies = new GatewayReplies();
  for (const [id, frame, expected, type] of [
    ["json", { status: 403, body: { error: "policy denied" } }, '{"error":"policy denied"}', "application/json"],
    ["sse", { status: 200, body: "data: [DONE]\n\n" }, "data: [DONE]\n\n", "text/event-stream"],
    ["binary", { status: 200, encoding: "base64", body: "AP8=" }, Buffer.from([0, 255]), "application/octet-stream"],
  ]) {
    const out = response();
    if (id !== "binary") out.setHeader("content-type", "text/event-stream");
    replies.pending.set(id, { response: out, fail: assert.fail });
    replies.accept({ id, ...frame });
    assert.deepEqual(out.chunks, [expected]);
    assert.equal(out.headers.get("content-type"), type);
    assert.equal(out.statusCode, frame.status);
    assert.equal(out.ended, true);
  }
});

test("binary chunks decode individually; errors and cancelled late frames stay isolated", () => {
  const replies = new GatewayReplies();
  const out = response();
  const failures = [];
  replies.pending.set("a", { response: out, fail: (error) => failures.push(error.message) });
  replies.accept({ id: "a", chunked: true, encoding: "base64" });
  replies.accept({ id: "a", chunk: "AA==" });
  replies.accept({ id: "a", chunk: "/w==" });
  assert.deepEqual(Buffer.concat(out.chunks), Buffer.from([0, 255]));
  replies.accept({ id: "a", error: "upstream disconnected" });
  replies.accept({ id: "a", chunk: "ignored" });
  assert.deepEqual(failures, ["upstream disconnected"]);
  assert.equal(out.chunks.length, 2);
  replies.pending.set("b", { response: response(), fail: (error) => failures.push(error.message) });
  replies.failAll(new Error("child crashed"));
  assert.equal(replies.pending.size, 0);
  assert.deepEqual(failures, ["upstream disconnected", "child crashed"]);
});
