import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { sceneWorldTransforms, sceneAlignmentOffset } = await jiti.import('./wallpaper-scene-parent.ts');
const { sceneTextLines } = await jiti.import('./wallpaper-text-layout.ts');
const layer = (id, patch = {}) => ({ id, origin: [0, 0, 0], scale: [1, 1, 1], angle: 0, parallax: [1, 1], ...patch });

test('all nine image anchors use local-space offsets before rotation and scale',()=>{
  for(const [alignment,expected] of Object.entries({center:[0,0],topleft:[10,-20],topright:[-10,-20],bottomleft:[10,20],bottomright:[-10,20],left:[10,0],right:[-10,0],top:[0,-20],bottom:[0,20]}))assert.deepEqual(sceneAlignmentOffset(alignment,[20,40]),expected);
  assert.throws(()=>sceneAlignmentOffset('unknown',[20,40]),/alignment/);
});
test('parent matrices preserve translation, negative scale, shear and inherited depth', () => {
  const data = [layer(1, { origin: [100, 50, 0], scale: [2, 3, 1], parallax: [0, .5] }), layer(2, { parent: 1, origin: [10, 20, 0], angle: Math.PI / 4, scale: [-1, 1, 1], parallaxInherited: true })];
  const child = sceneWorldTransforms(data).get(2);
  assert.equal(child.matrix[4], 120); assert.equal(child.matrix[5], 110);
  assert.ok(Math.abs(child.matrix[0] + Math.SQRT2) < 1e-10);
  assert.ok(Math.abs(child.matrix[1] + 3 * Math.SQRT1_2) < 1e-10);
  assert.deepEqual(child.parallax, [0, .5]);
  data[0].visible = false; assert.equal(sceneWorldTransforms(data).get(2).visible, false);
});
test('parent graph rejects cycles, missing parents and duplicate ids', () => {
  assert.throws(() => sceneWorldTransforms([layer(1, { parent: 2 }), layer(2, { parent: 1 })]), /Cyclic/);
  assert.throws(() => sceneWorldTransforms([layer(1, { parent: 9 })]), /Missing/);
  assert.throws(() => sceneWorldTransforms([layer(1), layer(1)]), /Duplicate/);
});

test('named bone attachments compose before child local transform and parent scale',()=>{
  const parent=layer(1,{origin:[100,50,0],scale:[2,3,1]}),child=layer(2,{parent:1,attachment:'hand',origin:[5,7,0]});
  const matrix=[0,1,0,0,-1,0,0,0,0,0,1,0,20,30,0,1];
  const w=sceneWorldTransforms([parent,child],(id,name)=>{assert.equal(id,1);assert.equal(name,'hand');return matrix;}).get(2);
  assert.deepEqual(w.matrix,[0,3,-2,0,126,155]);
  assert.throws(()=>sceneWorldTransforms([parent,child],()=>[NaN]),/attachment/);
});
test('constrained text wraps long words and limits rows with optional ellipsis', () => {
  const measure = s => Array.from(s).length;
  assert.deepEqual(sceneTextLines('one two three', measure, 7), ['one two', 'three']);
  assert.deepEqual(sceneTextLines('abcdefghi', measure, 3), ['abc', 'def', 'ghi']);
  assert.deepEqual(sceneTextLines('abcdefghi', measure, 3, 2, true), ['abc', 'de…']);
  assert.deepEqual(sceneTextLines('a\nb', measure, undefined, 1), ['a']);
});
