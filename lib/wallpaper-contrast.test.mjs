import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { chooseInk, contrast, composite, mediaRect, INK } = await createJiti(import.meta.url).import("./wallpaper-contrast.ts");
test("neutral ink chooses readable contrast over every gray level", () => {
  for (let n = 0; n < 256; n++) {
    const bg = [n, n, n], ink = chooseInk(bg);
    assert.ok(contrast(INK[ink], bg) >= 4.5);
  }
  assert.equal(chooseInk([255, 255, 255]), "dark");
  assert.equal(chooseInk([0, 0, 0]), "light");
  assert.equal(chooseInk([255, 0, 255]), "dark");
});
test("hysteresis retains a readable previous ink but switches an unreadable one", () => {
  assert.equal(chooseInk([117, 117, 117], "light"), "light");
  assert.equal(chooseInk([255, 255, 255], "light"), "dark");
  assert.equal(chooseInk([0, 0, 0], "dark"), "light");
});
test("glass alpha and media cover/contain offsets are included", () => {
  assert.deepEqual(composite([200, 200, 200], [0, 0, 0, 255]), [0, 0, 0]);
  assert.deepEqual(composite([200, 200, 200], [0, 0, 0, 0]), [200, 200, 200]);
  assert.deepEqual(mediaRect({width:200,height:100},{width:100,height:100},"cover",100,50),{x:-100,y:0,width:200,height:100});
  assert.deepEqual(mediaRect({width:200,height:100},{width:100,height:100},"contain",50,50),{x:0,y:25,width:100,height:50});
});
