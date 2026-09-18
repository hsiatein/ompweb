import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { wallpaperFileStream } = await jiti.import("./wallpaper-file-stream.ts");

test("wallpaper file stream respects range, bounded reads, and closes once", async () => {
  const data = Buffer.alloc(160000, 12);
  let closes = 0, reads = 0;
  const handle = {
    async read(buffer, offset, length, position) {
      assert.ok(length <= 65536); reads++;
      const bytesRead = Math.min(length, data.length - position);
      buffer.set(data.subarray(position, position + bytesRead), offset);
      return { bytesRead };
    },
    async close() { closes++; },
  };
  const result = await new Response(wallpaperFileStream(handle, 4, 150000)).arrayBuffer();
  assert.equal(result.byteLength, 149997);
  assert.ok(reads >= 3); assert.equal(closes, 1);
});

test("cancelling during a wallpaper read does not enqueue into a closed controller", async () => {
  let complete, closes = 0;
  const handle = {
    read: () => new Promise(resolve => { complete = resolve; }),
    async close() { closes++; },
  };
  const reader = wallpaperFileStream(handle, 0, 2000).getReader();
  const reading = reader.read();
  await new Promise(resolve => setImmediate(resolve));
  await reader.cancel();
  complete({ bytesRead: 1000 });
  assert.deepEqual(await reading, { value: undefined, done: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
});

test("wallpaper read failure closes the handle and rejects the consumer", async () => {
  let closes = 0;
  const handle = { async read() { throw new Error("disk failure"); }, async close() { closes++; } };
  await assert.rejects(new Response(wallpaperFileStream(handle, 0, 100)).arrayBuffer(), /disk failure/);
  assert.equal(closes, 1);
});
