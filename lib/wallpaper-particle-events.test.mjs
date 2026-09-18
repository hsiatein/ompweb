import assert from "node:assert/strict";
import test from "node:test";
import * as T from "three";
import { createJiti } from "jiti";
const { ParticleSystem } = await createJiti(import.meta.url).import("./wallpaper-scene-renderer.ts");
const info = { key: "fixture", width: 1, height: 1, format: 0, frames: [] };
const event = (type, extras = {}) => ({ type, max: 4, probability: 1, origin: [0, 0, 0], scale: [1, 1, 1], angle: 0, ...extras });
function definition(extras = {}) {
  return { id: 1, origin: [0, 0, 0], scale: [1, 1, 1], angle: 0, parallax: [0, 0], texture: "fixture", blending: "translucent", overrides: {}, children: [], config: { maxcount: 4, emitter: [{ name: "sphererandom", instantaneous: 1, rate: 0 }], initializer: [{ name: "lifetimerandom", min: .5, max: .5 }], operator: [] }, ...extras };
}
function system(t, data) {
  const texture = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const create = d => new ParticleSystem(d, info, texture, create);
  const result = create(data);
  t.after(() => { result.dispose(); texture.dispose(); });
  return result;
}
test("instantaneous emission happens once, including a zero-duration first frame", t => {
  const p = system(t, definition());
  p.step(0); p.upload(); assert.equal(p.geometry.instanceCount, 1);
  p.step(.25); p.upload(); assert.equal(p.geometry.instanceCount, 1);
  p.step(.3); p.upload(); assert.equal(p.geometry.instanceCount, 0);
  p.step(1); p.upload(); assert.equal(p.geometry.instanceCount, 0);
});
test("spawn events keep child-system quotas separate from particle quotas", t => {
  const root = definition(); root.config.emitter[0].instantaneous = 4;
  const child = definition({ id: 2, event: event("eventspawn", { max: 2 }) });
  child.config.maxcount = 3; child.config.emitter[0].instantaneous = 3;
  root.children = [child];
  const p = system(t, root); p.step(0); p.upload();
  assert.equal(p.mesh.children[0].geometry.instanceCount, 6);
  assert.equal(p.mesh.children.length, 1, "child instances share a single draw");
});
test("death event is triggered once at the parent's terminal position", t => {
  const root = definition(); root.config.initializer.push({ name: "velocityrandom", min: "10 0 0", max: "10 0 0" });
  root.children = [definition({ id: 2, event: event("eventdeath") })];
  const p = system(t, root); p.step(0); p.upload();
  assert.equal(p.mesh.children[0].geometry.instanceCount, 0);
  p.step(.5); p.upload();
  const geometry = p.mesh.children[0].geometry;
  assert.equal(geometry.instanceCount, 1); assert.equal(geometry.getAttribute("i_Position").getX(0), 5);
  p.step(.6); p.upload(); assert.equal(geometry.instanceCount, 0);
});
test("follow systems stop emitting after their parent dies and let the trail expire", t => {
  const root = definition();
  const child = definition({ id: 2, event: event("eventfollow") });
  child.config.emitter = [{ name: "sphererandom", rate: 10, instantaneous: 0 }];
  root.children = [child];
  const p = system(t, root); p.step(0); p.step(.2); p.upload();
  assert.equal(p.mesh.children[0].geometry.instanceCount, 2);
  p.step(.8); p.upload(); assert.equal(p.mesh.children[0].geometry.instanceCount, 0);
  p.step(1); p.upload(); assert.equal(p.mesh.children[0].geometry.instanceCount, 0);
});
test("event probability, offset, rotation and scale apply when creating children", t => {
  const root = definition();
  const child = definition({ id: 2, event: event("eventspawn", { origin: [7, 8, 0], scale: [2, 2, 1], angle: Math.PI / 2 }) });
  child.config.emitter[0].origin = "1 0 0";
  root.children = [child, definition({ id: 3, event: event("eventspawn", { probability: 0 }) })];
  const p = system(t, root); p.step(0); p.upload();
  const geometry = p.mesh.children[0].geometry;
  assert.equal(geometry.instanceCount, 1);
  assert.equal(geometry.getAttribute("i_Position").getX(0), 7);
  assert.equal(geometry.getAttribute("i_Position").getY(0), 10);
  assert.equal(geometry.getAttribute("i_Size").getX(0), 20);
  assert.equal(p.mesh.children[1].geometry.instanceCount, 0);
});
test("expired child quota is available to a new event in the same frame", t => {
  const root = definition(); root.config.emitter[0].rate = 2;
  const child = definition({ id: 2, event: event("eventspawn", { max: 1 }) });
  child.config.initializer[0].min = child.config.initializer[0].max = .1;
  root.children = [child];
  const p = system(t, root); p.step(0); p.step(.5); p.upload();
  assert.equal(p.mesh.children[0].geometry.instanceCount, 1);
});

test("rope connects living particles, interpolates widths and preserves birth order",t=>{
  const d=definition();d.config.maxcount=10;d.config.emitter=[{name:'sphererandom',rate:2}];
  d.config.initializer=[{name:'lifetimerandom',min:10,max:10},{name:'velocityrandom',min:'10 0',max:'10 0'},{name:'sizerandom',min:10,max:10}];
  d.config.renderer=[{name:'rope',subdivision:3}];d.config.operator=[{name:'sizechange',startvalue:1,endvalue:0}];
  const p=system(t,d);p.step(.5);p.upload();assert.equal(p.geometry.instanceCount,0,'one particle cannot form a rope');
  p.step(.5);p.step(.5);p.upload();assert.equal(p.geometry.instanceCount,6);
  const ends=p.geometry.getAttribute('i_Ends'),sizes=p.geometry.getAttribute('i_Size');
  assert.equal(ends.getX(0),15);assert.equal(ends.getZ(5),5);
  for(let i=0;i<5;i++)assert.equal(ends.getZ(i),ends.getX(i+1),'no gaps between segments');
  assert.ok(sizes.getX(0)<sizes.getY(5),'age-dependent width varies along the ribbon');
});

test("rope does not join separate child event instances",t=>{
  const root=definition();root.config.emitter[0].instantaneous=2;
  const child=definition({id:2,event:event('eventspawn')});child.config.emitter[0].instantaneous=3;
  child.config.renderer=[{name:'rope',subdivision:2}];root.children=[child];
  const p=system(t,root);p.step(0);p.upload();assert.equal(p.mesh.children[0].geometry.instanceCount,8);
});

test("ropetrail still uses an individual particle's history",t=>{
  const d=definition();d.config.renderer=[{name:'ropetrail',segments:4,length:1}];
  d.config.initializer=[{name:'lifetimerandom',min:5,max:5},{name:'velocityrandom',min:'10 0',max:'10 0'}];
  const p=system(t,d);p.step(0);p.step(.3);p.upload();assert.ok(p.geometry.instanceCount>=2);
  const a=p.geometry.getAttribute('i_Color'),b=p.geometry.getAttribute('i_EndColor');assert.deepEqual(a.array,b.array);
});
