import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { sceneLayerOrigin } = await createJiti(import.meta.url).import("./wallpaper-scene-transform.ts");
const scene = (parallax = true, amount = .5) => ({ width: 1920, height: 1080, cameraEffects: { parallax, amount, mouse: 0 } });

test("parallax reproduces the native nine-anchor grid without scaling geometry", () => {
  for (const amount of [.5, 1]) {
    for (const depth of [0, .5, 1]) {
      for (const x of [600, 960, 1320]) {
        const expected = x + (x - 960) * depth * amount;
        assert.deepEqual(sceneLayerOrigin(scene(true, amount), [x, 540, 0], [depth, depth]), [expected, 540, 0]);
      }
    }
  }
  assert.deepEqual(sceneLayerOrigin(scene(), [600, 240, 0], [1, 1]), [420, 90, 0]);
});

test("Sea Girl eye anchor gets its missing 68.57125px offset on the X axis only", () => {
  const eye = [685.715, 817.880, 0];
  const result = sceneLayerOrigin(scene(), eye, [.5, 0]);
  assert.ok(Math.abs(result[0] - 617.14375) < 1e-9);
  assert.equal(result[1], eye[1]);
  assert.deepEqual(eye, [685.715, 817.880, 0]);
  assert.deepEqual(sceneLayerOrigin(scene(), [960, 540, 0], [.5, 0]), [960, 540, 0]);
});

test("disabled parallax, zero depth and zero strength preserve authored anchors", () => {
  const origin = [100, 200, 3];
  assert.deepEqual(sceneLayerOrigin(scene(false), origin, [1, 1]), origin);
  assert.deepEqual(sceneLayerOrigin(scene(), origin, [0, 0]), origin);
  assert.deepEqual(sceneLayerOrigin(scene(true, 0), origin, [1, 1]), origin);
});
