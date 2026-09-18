import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parsePetManifest, petFrame, petLookFrame, resolvePetState, parsePetPreferences } = await jiti.import("./pets.ts");
const manifest = { id: "test", displayName: "Test", spritesheetPath: "spritesheet.webp" };

test("legacy manifests default to v1; unsafe asset references and unknown versions are rejected", () => {
  assert.equal(parsePetManifest(manifest).spriteVersionNumber, 1);
  for (const spritesheetPath of ["../secret.png", "C:\\private.png", "https://host/a.png", "a.svg", "a/../x.png"]) {
    assert.throws(() => parsePetManifest({ ...manifest, spritesheetPath }));
  }
  assert.throws(() => parsePetManifest({ ...manifest, spriteVersionNumber: 3 }));
  assert.equal(parsePetManifest({ ...manifest, spriteVersionNumber: 2, extra: "ignored" }).extra, undefined);
});

test("unequal frame durations wrap only across the used cells", () => {
  assert.deepEqual(petFrame("idle", 279), { row: 0, column: 0 });
  assert.deepEqual(petFrame("idle", 280), { row: 0, column: 1 });
  assert.deepEqual(petFrame("idle", 1099), { row: 0, column: 5 });
  assert.deepEqual(petFrame("idle", 1100), { row: 0, column: 0 });
  assert.deepEqual(petFrame("waving", 699), { row: 3, column: 3 });
  assert.deepEqual(petFrame("waving", 700), { row: 3, column: 0 });
});

test("v2 gaze uses clockwise directions, crosses rows at down, and has a neutral deadzone", () => {
  assert.equal(petLookFrame(10, 10), null);
  assert.deepEqual(petLookFrame(0, -100), { row: 9, column: 0 });
  assert.deepEqual(petLookFrame(100, 0), { row: 9, column: 4 });
  assert.deepEqual(petLookFrame(0, 100), { row: 10, column: 0 });
  assert.deepEqual(petLookFrame(-100, 0), { row: 10, column: 4 });
});

test("pending approval wins over running, and a fresh run wins over an old error", () => {
  assert.equal(resolvePetState({ waiting: true, running: true, failed: true, completed: false }), "waiting");
  assert.equal(resolvePetState({ waiting: false, running: true, failed: true, completed: true }), "running");
  assert.equal(resolvePetState({ waiting: false, running: false, failed: true, completed: true }), "failed");
  assert.equal(resolvePetState({ waiting: false, running: false, failed: false, completed: true }), "review");
});

test("corrupt or out-of-range saved positions cannot strand the pet off-screen", () => {
  const p = parsePetPreferences('{"enabled":true,"size":900,"x":-2,"y":3}');
  assert.equal(p.size, 240);
  assert.equal(p.x, 0);
  assert.equal(p.y, 1);
  assert.equal(parsePetPreferences("null").enabled, false);
  assert.equal(parsePetPreferences("{").enabled, false);
});
