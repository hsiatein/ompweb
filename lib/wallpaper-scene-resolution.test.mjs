import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { sceneOutputSize } = await createJiti(import.meta.url).import("./wallpaper-scene-resolution.ts");
const size = (width, height) => ({ width, height });
const output = (source, viewport, dpr = 1, fit = "cover", limit = 16384) => sceneOutputSize(source, viewport, dpr, fit, limit);

test("small windows do not supersample the final scene to the source resolution", () => {
  assert.deepEqual(output(size(3840, 2160), size(1920, 1080)), size(1920, 1080));
  assert.deepEqual(output(size(2500, 1641), size(1920, 1080)), size(1920, 1260));
});
test("4K and Retina retain one output pixel per physical display pixel", () => {
  assert.deepEqual(output(size(1920, 1080), size(3840, 2160)), size(3840, 2160));
  assert.deepEqual(output(size(3840, 2160), size(1920, 1080), 2), size(3840, 2160));
});
test("cover keeps cropped edges sharp and contain avoids rendering outside the image", () => {
  assert.deepEqual(output(size(1600, 900), size(400, 800), 2), size(2844, 1600));
  assert.deepEqual(output(size(1600, 900), size(400, 800), 2, "contain"), size(800, 450));
});
test("GPU texture and pixel budget limits remain enforced", () => {
  assert.deepEqual(output(size(1600, 900), size(10000, 10000), 2, "cover", 4096), size(4096, 2304));
  const result = output(size(10000, 10000), size(10000, 10000), 2);
  assert.ok(result.width * result.height <= 16_777_216);
  assert.deepEqual(output(size(1920, 1080), size(1920, 1080), Number.NaN), size(1920, 1080));
  assert.ok(output(size(1920, 1080), size(0, 0)).height >= 1);
});
