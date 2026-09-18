import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { wallpaperCropGeometry: geometry, moveWallpaperCrop: move } = await jiti.import("./wallpaper-crop.ts");
const { parseWallpaperPreferences } = await jiti.import("./wallpapers.ts");
const size = (width, height) => ({ width, height });
const center = { positionX: 50, positionY: 50 };

test("legacy preferences stay centered; positions are finite bounded percentages", () => {
  for (const raw of [null, "broken", '{}', '{"positionX":"30","positionY":null}', '{"positionX":1e999}']) {
    const p = parseWallpaperPreferences(raw);
    assert.equal(p.positionX, 50); assert.equal(p.positionY, 50);
  }
  const p = parseWallpaperPreferences('{"positionX":-100,"positionY":500}');
  assert.equal(p.positionX, 0); assert.equal(p.positionY, 100);
  assert.equal(parseWallpaperPreferences('{"positionX":23.4}').positionX, 23.4);
});

test("wide wallpaper on portrait viewport crops only horizontally", () => {
  const g = geometry(size(1600, 900), size(320, 200), size(400, 800), center, "cover");
  assert.deepEqual(g.image, { x: 0, y: 10, width: 320, height: 180 });
  assert.deepEqual(g.crop, { x: 115, y: 10, width: 90, height: 180 });
  assert.equal(g.travelX, 230); assert.equal(g.travelY, 0);
  assert.deepEqual(move(g, 230, 1000, center), { positionX: 100, positionY: 50 });
  assert.deepEqual(move(g, -1000, 0, center), { positionX: 0, positionY: 50 });
});

test("portrait wallpaper on wide viewport crops vertically with centered preview margins", () => {
  const g = geometry(size(800, 1600), size(320, 200), size(1600, 900), center, "cover");
  assert.equal(g.image.x, 110); assert.equal(g.image.width, 100);
  assert.equal(g.crop.height, 56.25); assert.equal(g.travelX, 0);
  assert.deepEqual(move(g, 0, 0, center), { positionX: 50, positionY: 0 });
  assert.deepEqual(move(g, 0, 1000, center), { positionX: 50, positionY: 100 });
});

test("contain and matching aspect ratios do not crop; unloaded sizes are ignored", () => {
  for (const [viewport, fit] of [[size(800, 600), "contain"], [size(1600, 900), "cover"]]) {
    const g = geometry(size(1600, 900), size(320, 200), viewport, center, fit);
    assert.deepEqual(g.crop, g.image);
    assert.deepEqual(move(g, 20, 30, center), center);
  }
  assert.equal(geometry(size(0, 900), size(320, 200), size(800, 600), center, "cover"), null);
  assert.equal(geometry(size(1600, 900), size(0, 200), size(800, 600), center, "cover"), null);
});

test("crop selection exactly matches CSS object-position cover geometry", () => {
  for (const source of [size(1920, 1080), size(800, 1600), size(1298, 767)]) {
    for (const viewport of [size(1440, 960), size(390, 844), size(2560, 1080)]) {
      for (const value of [0, 23.4, 50, 100]) {
        const g = geometry(source, size(480, 300), viewport, { positionX: value, positionY: value }, "cover");
        const cover = Math.max(viewport.width / source.width, viewport.height / source.height);
        const previewScale = g.image.width / source.width;
        assert.ok(Math.abs((g.crop.x - g.image.x) / previewScale - (source.width - viewport.width / cover) * value / 100) < 1e-8);
        assert.ok(Math.abs((g.crop.y - g.image.y) / previewScale - (source.height - viewport.height / cover) * value / 100) < 1e-8);
      }
    }
  }
});
