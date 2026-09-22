import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { SceneTextScript } = await jiti.import("./wallpaper-scene-script.ts");
const definition = (script, properties = {}) => ({ script, properties, value: "initial" });

test('event-only text bindings remain at their saved value without fabricated media events',async t=>{
  const s=await SceneTextScript.create(definition(`export function mediaPropertiesChanged(e){thisLayer.text=e.title;}`));t.after(()=>s.dispose());
  assert.equal(s.update('initial'),'initial');assert.equal(s.update('saved'),'saved');
});

test('init returns and direct text assignments work without a mandatory per-frame return',async t=>{
  const s=await SceneTextScript.create(definition(`export function init(){return 'hello';}export function update(){thisLayer.text+='!';}`));t.after(()=>s.dispose());
  assert.equal(s.update('initial'),'hello!');assert.equal(s.update('hello!'),'hello!!');
  await assert.rejects(SceneTextScript.create(definition(`export function init(){return 42}`)),/SceneScript/);
});

test("SceneScript executes original ES module exports and retains state", async () => {
  const script = await SceneTextScript.create(definition(`
    export const scriptProperties = createScriptProperties().addText({name:'label',value:'default'}).finish();
    let count = 0; export function init() { count = 10; }
    export function update(value) { return scriptProperties.label + (++count); }
  `, { label: "clock:" }));
  try { assert.equal(script.update(""), "clock:11"); assert.equal(script.update(""), "clock:12"); }
  finally { script.dispose(); }
});

test("SceneScript Date responds to host time and property defaults", async () => {
  const script = await SceneTextScript.create(definition(`
    export const scriptProperties = createScriptProperties().addCheckbox({name:'seconds',value:true}).addCombo({name:'prefix',options:[{value:'T'}]}).finish();
    export function update() { return scriptProperties.prefix + (scriptProperties.seconds ? new Date().getUTCSeconds() : ''); }
  `));
  try { assert.equal(script.update("", Date.UTC(2026, 0, 1, 0, 0, 1)), "T1"); assert.equal(script.update("", Date.UTC(2026, 0, 1, 0, 0, 2)), "T2"); }
  finally { script.dispose(); }
});

test('exhausted frame budgets defer text scripts without advancing or interrupting guest state', async t => {
  const script = await SceneTextScript.create(definition(`let n=0;export function init(){return 'ready';}export function update(){return String(++n);}`));
  t.after(() => script.dispose());
  for (let i=0; i<2000; i++) assert.equal(script.update('saved', Date.now(), 0), 'saved');
  for (const budget of [-1, .01, .99, NaN, Infinity]) assert.equal(script.update('saved', Date.now(), budget), 'saved');
  assert.equal(script.update('saved'), '1');
  assert.equal(script.update('1'), '2');
});

test("SceneScript cannot access host globals or import host modules", async () => {
  const script = await SceneTextScript.create(definition(`export function update(){return [typeof fetch, typeof window, typeof document, typeof process, typeof require, typeof WebSocket].join(',');}`));
  try { assert.equal(script.update(""), Array(6).fill("undefined").join(",")); }
  finally { script.dispose(); }
  await assert.rejects(SceneTextScript.create(definition(`import fs from 'node:fs'; export function update(){return ''}`)), /SceneScript/);
});

test("SceneScript interrupts init and update loops, bounds allocation and rejects non-text", async () => {
  const started = performance.now();
  await assert.rejects(SceneTextScript.create(definition(`while(true){}; export function update(){return ''}`)), /SceneScript/);
  for (const body of ["while(true){}", "let a=[];for(;;)a.push('x'.repeat(10000));", "return {get x(){while(true){}}}", "return 'x'.repeat(8193)"]) {
    const script = await SceneTextScript.create(definition(`export function update(){${body}}`));
    try { assert.throws(() => script.update(""), /SceneScript/); }
    finally { script.dispose(); }
  }
  assert.ok(performance.now() - started < 2000);
});
