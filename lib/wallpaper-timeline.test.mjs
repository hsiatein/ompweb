import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {parseSceneTimeline,sampleSceneTimeline}=await jiti.import('./wallpaper-timeline.ts');
const {ScenePropertyScripts}=await jiti.import('./wallpaper-property-scripts.ts');
const key=(frame,value)=>({frame,value});
const raw=(mode='single',startpaused=true)=>({c0:[key(0,0),key(60,1),key(120,0)],options:{fps:30,length:120,mode,startpaused,name:'fade'}});
const layer=(id=1)=>({id,name:'layer'+id,origin:[10,20,0],scale:[1,1,1],angle:0,parallax:[1,1],size:[100,100],color:[1,1,1],alpha:1,visible:true,texture:'bar',blending:'translucent',passes:[],colorBlendMode:0});
const binding=(source,property='alpha')=>({property,source,properties:{}});
async function use(t,data){const vm=await ScenePropertyScripts.create(data,0);t.after(()=>vm.dispose());return vm;}
test('timeline parser keeps paused modes, degrees, relative bases, and rejects malformed curves',()=>{
  const source={c0:[key(0,0),key(10,Math.PI)],c1:[key(0,0)],c2:[key(0,0)],relative:true,options:{fps:10,length:10,mode:'mirror',name:'rotate'}};
  const def=parseSceneTimeline('angles',source,'0 0 1');
  assert.equal(def.channels[0][1].value,180);assert.equal(def.base[2],180/Math.PI);assert.equal(def.relative,true);
  for(const data of [{...raw(),events:[]},{...raw(),options:{fps:0}},{...raw(),c0:[key(2,1),key(1,0)]},{...raw(),c0:[key(0,Infinity)]},{...raw(),c0:Array(2049).fill(key(0,0))}])assert.throws(()=>parseSceneTimeline('alpha',data,1),/timeline/i);
  assert.throws(()=>parseSceneTimeline('visible',raw(),true),/timeline/i);
});
test('timeline sampling respects half-segment Bezier handles, target-key steps, and wrapped tails',()=>{
  const curve=parseSceneTimeline('alpha',{...raw(),c0:[{...key(0,0),front:{enabled:true,x:1,y:0}},{...key(60,1),back:{enabled:true,x:-1,y:0}}]},1);
  assert.ok(Math.abs(sampleSceneTimeline(curve.channels[0],30,120,false)-.5)<1e-7);
  assert.ok(sampleSceneTimeline(curve.channels[0],15,120,false)<.2);
  const steps=[{...key(0,0),step:false},{...key(10,1),step:true}];
  assert.equal(sampleSceneTimeline(steps,9.9,20,false),0);assert.equal(sampleSceneTimeline(steps,10,20,false),1);
  assert.equal(sampleSceneTimeline([key(0,0),key(10,1)],15,20,true),.5);
  assert.equal(sampleSceneTimeline([key(0,0),key(10,1)],15,20,false),1);
});
test('click plays named timelines together, timer pauses exactly at halfway, second click returns and third restarts',async t=>{
  const a={...layer(),timelines:[parseSceneTimeline('alpha',raw(),1)]};
  const reverse=raw();reverse.c0=reverse.c0.map(k=>({...k,value:1-k.value}));
  const b={...layer(2),timelines:[parseSceneTimeline('alpha',reverse,1)]};
  const control={...layer(3),scripts:[binding(`export function cursorClick(){for(const name of ['layer1','layer2']){const a=thisScene.getLayer(name).getAnimation('fade');a.play();engine.setTimeout(()=>a.pause(),2000);}}`,'visible')]};
  const vm=await use(t,{width:100,height:100,layers:[a,b,control]});let time=0;
  const click=()=>vm.update(time,0,[],time*1000,{events:[{type:'cursorClick',ids:[3],cursor:[0,0,0]}]});
  const tick=dt=>vm.update(time+=dt,dt);
  assert.deepEqual(vm.update(0,0).layers.slice(0,2).map(l=>l.alpha),[0,1]);
  click();tick(.9);tick(.9);let f=tick(.7);
  assert.deepEqual(f.layers.slice(0,2).map(l=>l.alpha),[1,0]);assert.deepEqual(f.warnings,[]);
  assert.equal(tick(1).layers[0].alpha,1);
  click();tick(1);f=tick(1);assert.deepEqual(f.layers.slice(0,2).map(l=>l.alpha),[0,1]);
  click();tick(1);assert.equal(tick(1).layers[0].alpha,1);
});
test('thisObject has property-scoped animations, relative values do not drift, methods validate and preserve pause',async t=>{
  const rawPosition={c0:[key(0,0),key(10,10)],c1:[key(0,0)],c2:[key(0,0)],relative:true,options:{fps:10,length:10,mode:'single',startpaused:true,name:'move'}};
  const a={...layer(),timelines:[parseSceneTimeline('origin',rawPosition,'10 20 0')],scripts:[binding(`let animation;export function init(){animation=thisObject.getAnimation();if(animation.duration!==1||animation.fps!==10||animation.frameCount!==10||animation.name!=='move')throw Error();animation.setFrame(5);animation.rate=2;animation.play();}export function cursorClick(){animation.stop();}`,'origin')]};
  const vm=await use(t,{width:100,height:100,layers:[a]});
  assert.deepEqual(vm.update(0,0).layers[0].origin,[15,20,0]);
  assert.deepEqual(vm.update(.25,.25).layers[0].origin,[20,20,0]);
  assert.deepEqual(vm.update(1,.75).layers[0].origin,[20,20,0]);
  assert.deepEqual(vm.update(1,0,[],0,{events:[{type:'cursorClick',ids:[1],cursor:[0,0,0]}]}).layers[0].origin,[10,20,0]);
  const bad=structuredClone(a);bad.scripts=[binding(`export function init(){thisObject.getAnimation().setFrame(Infinity);}`,'origin')];
  await assert.rejects(ScenePropertyScripts.create({width:100,height:100,layers:[bad]}),/SceneScript/);
});
test('autoplay works without scripts, mirrored and reverse loop playback stay bounded',async t=>{
  const definition=raw('mirror',false);definition.options.length=60;definition.c0.pop();
  const a={...layer(),timelines:[parseSceneTimeline('alpha',definition,1)]};
  const vm=await use(t,{width:100,height:100,layers:[a]});
  assert.equal(vm.update(1,1).layers[0].alpha,.5);assert.equal(vm.update(2,1).layers[0].alpha,1);assert.equal(vm.update(3,1).layers[0].alpha,.5);assert.equal(vm.update(4,1).layers[0].alpha,0);
  const b=structuredClone(a);b.timelines[0].mode='loop';b.scripts=[binding(`export function init(){thisObject.getAnimation().rate=-1;}`)];
  const reverse=await use(t,{width:100,height:100,layers:[b]});assert.equal(reverse.update(.5,.5).layers[0].alpha,.75);
});
