import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { sceneTargetPlan } = await createJiti(import.meta.url).import("./wallpaper-scene-targets.ts");
test("linear effects reuse two targets without framebuffer feedback", () => {
  const passes = Array.from({ length: 30 }, (_, i) => ({ inputs: { 0: i - 1 } }));
  const plan = sceneTargetPlan(passes, [1920, 1080]);
  assert.equal(plan.slots.length, 2);
  for (let i = 1; i < 30; i++) assert.notEqual(plan.assignments[i], plan.assignments[i - 1]);
});
test("branched effects keep previous input alive and honor downsample sizes", () => {
  const passes = [{ inputs: { 0: -1 } }, { inputs: { 0: 0 }, scale: 2 }, { inputs: { 0: 1 }, scale: 2 }, { inputs: { 0: 2, 1: 0 } }];
  const p = sceneTargetPlan(passes, [1920, 1080]);
  assert.notEqual(p.assignments[0], p.assignments[3]);
  assert.equal(p.slots[p.assignments[1]].width, 960);
  assert.equal(p.slots[p.assignments[1]].height, 540);
  assert.throws(() => sceneTargetPlan([{ inputs: { 0: 0 } }], [1, 1]), /dependency/);
  assert.throws(() => sceneTargetPlan([{ scale: 0 }], [1, 1]), /scale/);
});
