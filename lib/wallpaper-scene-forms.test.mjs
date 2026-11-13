import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { discoverSceneForms } = await jiti.import("./wallpaper-scene-forms.ts");
const { ScenePropertyScripts } = await jiti.import("./wallpaper-property-scripts.ts");
const layer = (id, name, visible = true) => ({ id, name, visible, origin: [0, 0, 0], scale: [1, 1, 1], angle: 0, parallax: [0, 0], size: [100, 100], color: [1, 1, 1], alpha: 1, texture: "image", blending: "translucent", colorBlendMode: 0, passes: [] });
const scene = layers => ({ width: 100, height: 100, layers, particles: [], textures: [] });
const button = (id, name, target) => ({ ...layer(id, name), text: { value: name }, scripts: [{ property: "scale", properties: {}, source: `export function cursorClick(event) { if(event.button!==0)return; for (const name of ['one', 'two', 'three']) thisScene.getLayer(name).visible = name === '${target}'; }` }] });

test("single-image scenes expose no alternative; X-ray scenes expose base and revealed forms", async () => {
  assert.deepEqual(await discoverSceneForms(scene([layer(1, "plain")])), []);
  const data = scene([{ ...layer(1, "xray"), passes: [{ xray: true, scripts: [], uniforms: {} }] }]);
  const forms = await discoverSceneForms(data);
  assert.deepEqual(forms.map(f => f.xray), [0, 1]);
  assert.deepEqual(forms.map(f => f.visibility), [{}, {}]);
  assert.notEqual(forms[0].id, forms[1].id);
});

test("authored buttons discover all three forms, including the initially visible form", async t => {
  const data = scene([layer(1, "one"), layer(2, "two", false), layer(3, "three", false), layer(4, "background"), button(10, "Two", "two"), button(11, "Three", "three"), button(12, "One", "one")]);
  const forms = await discoverSceneForms(data);
  assert.deepEqual(forms.map(f => f.label), ["One", "Two", "Three"]);
  for (const [index, form] of forms.entries()) {
    assert.deepEqual([1, 2, 3].map(id => form.visibility[id]), [0, 1, 2].map(i => i === index));
    assert.equal(form.visibility[4], undefined, "unrelated background animation remains free");
    assert.equal(form.visibility[10], false);
    assert.equal(form.visibility[11], false);
    assert.equal(form.visibility[12], false);
  }
  const runner = await ScenePropertyScripts.create(data, 0); t.after(() => runner.dispose());
  assert.deepEqual(runner.update(0, 0, [], 0).layers.slice(0, 3).map(l => l.visible), [true, false, false]);
  const switched = runner.update(0, 0, [], 0, { events: [{ type: "cursorClick", ids: [10], cursor: [0, 0, 0] }] });
  assert.deepEqual(switched.layers.slice(0, 3).map(l => l.visible), [false, true, false], "discovery leaves original interaction intact");
  assert.deepEqual(data.layers.slice(0, 3).map(l => l.visible), [true, false, false]);
});

test("a cycling control yields each distinct form once and stable selection ids", async () => {
  const data = scene([layer(1, "one"), layer(2, "two", false), layer(3, "three", false), { ...layer(10, "Cycle"), text: { value: "Cycle" }, scripts: [{ property: "scale", properties: {}, source: `let index=0; export function cursorClick(){ index=(index+1)%3; for(let i=0;i<3;i++)thisScene.getLayer(['one','two','three'][i]).visible=i===index; }` }] }]);
  const first = await discoverSceneForms(data), second = await discoverSceneForms(data);
  assert.deepEqual(first.map(f => [1, 2, 3].map(id => f.visibility[id])), [[true, false, false], [false, true, false], [false, false, true]]);
  assert.deepEqual(first.map(f => f.id), second.map(f => f.id));
});

test("group switches expose forms while preserving individual child visibility", async () => {
  const data = scene([
    ...[layer(1, "one"), layer(2, "two", false), layer(3, "three", false)].map(l => ({ ...l, group: true })),
    { ...layer(21, "hidden-detail", false), parent: 1 },
    { ...layer(22, "second-image"), parent: 2 },
    button(10, "Two", "two"), button(11, "Three", "three"), button(12, "One", "one"),
  ]);
  const forms = await discoverSceneForms(data);
  assert.deepEqual(forms.map(f => [1, 2, 3].map(id => f.visibility[id])), [[true, false, false], [false, true, false], [false, false, true]]);
  for (const form of forms) {
    assert.equal(form.visibility[21], undefined);
    assert.equal(form.visibility[22], undefined);
  }
  assert.equal(data.layers.find(l => l.id === 21).visible, false);
});
