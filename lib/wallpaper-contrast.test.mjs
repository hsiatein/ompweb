import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { chooseInk, chooseRegionInk, regionSamplePoints, contrast, composite, mediaRect, INK } = await createJiti(import.meta.url).import("./wallpaper-contrast.ts");
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
test("a whole region uses one neutral ink despite local bright or dark patches", () => {
  const dark = Array.from({ length: 30 }, () => [20, 20, 20]);
  const light = Array.from({ length: 30 }, () => [235, 235, 235]);
  assert.equal(chooseRegionInk([...dark, ...light.slice(0, 6)]), "light");
  assert.equal(chooseRegionInk([...light, ...dark.slice(0, 6)]), "dark");
  assert.equal(chooseRegionInk([...dark, [255, 255, 255]], "light"), "light");
  assert.equal(chooseRegionInk(light, "light"), "dark");
  assert.equal(chooseRegionInk(dark, "dark"), "light");
});
test("regional hysteresis preserves readable and nearly tied choices", () => {
  assert.equal(chooseRegionInk([[117, 117, 117]], "light"), "light");
  const mixed = [[0, 0, 0], [255, 255, 255]];
  assert.equal(chooseRegionInk(mixed, "light"), "light");
  assert.equal(chooseRegionInk(mixed, "dark"), "dark");
  assert.equal(chooseRegionInk([], "light"), "light");
});
test("sampling covers the box area instead of a text origin or individual glyphs", () => {
  const points = regionSamplePoints({ left: 100, top: 200, right: 700, bottom: 500 });
  assert.equal(points.length, 36);
  assert.deepEqual(points[0], { x: 150, y: 225 });
  assert.deepEqual(points.at(-1), { x: 650, y: 475 });
  assert.deepEqual(regionSamplePoints({ left: 0, top: 0, right: 0, bottom: 100 }), []);
});
