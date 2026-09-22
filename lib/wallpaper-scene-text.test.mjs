import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {SceneTextTexture}=await jiti.import('./wallpaper-scene-text.ts');
const {SceneTextScheduler}=await jiti.import('./wallpaper-text-scheduler.ts');

function canvasEnvironment(t) {
  const original=Object.getOwnPropertyDescriptor(globalThis,'document'),canvases=[];
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement(){
    const draws=[],context={setTransform(){},clearRect(){},fillRect(){},measureText(s){return {width:s.length*8,fontBoundingBoxAscent:12,fontBoundingBoxDescent:3};},fillText(s){draws.push(s);}};
    const canvas={width:0,height:0,getContext(){return context;},draws,context};canvases.push(canvas);return canvas;
  }}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;});
  return canvases;
}
const layer=(id,script)=>({id,size:[200,60],text:{value:'saved',script,properties:{},pointSize:12,horizontal:'left',vertical:'top',padding:0}});
async function texture(t,id,script){const result=await SceneTextTexture.create(layer(id,script),'sans-serif',4096);t.after(()=>result.dispose());return result;}

test('a deferred texture keeps its update due and catches up on the next frame',async t=>{
  const canvases=canvasEnvironment(t),text=await texture(t,1,`let n=0;export function update(){return String(++n);}`);
  assert.deepEqual(canvases[0].draws,['1']);
  text.update(1,0,0);text.update(1,0,.5);
  assert.deepEqual(canvases[0].draws,['1']);
  text.update(1,0,8);
  assert.deepEqual(canvases[0].draws,['1','2']);assert.equal(text.warning,undefined);
});

test('slow canvas drawing defers other real guest scripts instead of interrupting them',async t=>{
  const canvases=canvasEnvironment(t),layers=[];
  for(let id=0;id<3;id++)layers.push(await texture(t,id,`let n=0;export function update(){return String(++n);}`));
  let clock=0;t.mock.method(performance,'now',()=>clock);
  for(const canvas of canvases)t.mock.method(canvas.context,'fillText',s=>{canvas.draws.push(s);clock+=9;});
  const scheduler=new SceneTextScheduler();
  for(let frame=1;frame<=1800;frame++)scheduler.update(layers,frame,frame*1000);
  assert.ok(layers.every(l=>!l.warning));
  assert.ok(canvases.every(c=>c.draws.at(-1)==='601'));
});

test('invalid text initialization preserves authored text and exposes a layer-specific warning',async t=>{
  const canvases=canvasEnvironment(t);
  for(const script of ['export function init(){missingApi();}', 'export ???', 'while(true){}']) {
    const text=await texture(t,42,script);
    assert.match(text.warning,/layer 42.*last valid text retained/);
    assert.deepEqual(canvases.at(-1).draws,['saved']);
  }
});

test('failed or runaway text updates retain the last valid text without stopping other layers',async t=>{
  const canvases=canvasEnvironment(t),layers=[];
  for(const body of ['missingApi();','while(true){}', 'return 42;', "return 'x'.repeat(8193);"])
    layers.push(await texture(t,layers.length,`let n=0;export function update(){if(++n>1){${body}}return 'valid';}`));
  const healthy=await texture(t,99,`export function update(){return String(Date.now());}`);
  layers.forEach(text=>assert.doesNotThrow(()=>text.update(1,1000)));
  assert.ok(layers.every(l=>l.warning));
  assert.ok(canvases.slice(0,4).every(c=>c.draws.at(-1)==='valid'));
  for(let frame=2;frame<5;frame++)for(const text of [...layers,healthy])text.update(frame,frame*1000);
  assert.equal(healthy.warning,undefined);assert.equal(canvases.at(-1).draws.at(-1),'4000');
});
