import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {ScenePropertyScripts}=await createJiti(import.meta.url).import('./wallpaper-property-scripts.ts');
const layer=(id=1)=>({id,name:'bar'+id,origin:[10,20,0],scale:[1,1,1],angle:Math.PI/2,parallax:[1,1],size:[4,4],color:[1,1,1],alpha:1,texture:'bar',blending:'translucent',passes:[],colorBlendMode:0});
const scene=(source,property='visible',properties={})=>({width:100,height:100,layers:[{...layer(),scripts:[{property,source,properties}]}],scriptTemplates:{'models/workshop/123/bar.json':layer(0)}});
const matrix=x=>[1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1];
async function use(t,data){const s=await ScenePropertyScripts.create(data);t.after(()=>s.dispose());return s;}

test('partial mode isolates an invalid binding, rolls back its layer and reports an explicit warning',async t=>{
  const data=scene(`export function init(){thisLayer.origin=new Vec3(999);thisObject.getAnimation().play();}`);
  data.layers.push({...layer(2),scripts:[{property:'origin',properties:{},source:`export function update(v){return v.add(1)}`} ]});
  const s=await ScenePropertyScripts.create(data,0,[],true);t.after(()=>s.dispose());
  const f=s.update(0,0);assert.deepEqual(f.layers[0].origin,[10,20,0]);assert.deepEqual(f.layers[1].origin,[11,21,1]);assert.equal(f.warnings.length,1);assert.match(f.warnings[0],/layer 1, visible/);
  assert.equal(s.update(1,.1).warnings.length,1);
});

test('partial mode does not remove execution limits',async t=>{
  const started=performance.now();
  const loop=await ScenePropertyScripts.create(scene('export function update(){while(true){}}'),0,[],true);t.after(()=>loop.dispose());
  try { const frame=loop.update(0,0);assert.equal(frame.warnings.length,1); } catch(e) { assert.match(e.message,/SceneScript/); }
  assert.ok(performance.now()-started<1000);
});

test('partial mode isolates module-scope failures and leaves other bindings working',async t=>{
  const data=scene(`thisLayer.alpha=.1;missingScene.on('update',()=>{});`);
  data.layers.push({...layer(2),scripts:[{property:'alpha',properties:{},source:'export function update(){return .6;}'}]});
  await assert.rejects(ScenePropertyScripts.create(data),/SceneScript/);
  const s=await ScenePropertyScripts.create(data,0,[],true);t.after(()=>s.dispose());
  const f=s.update(0,0);assert.equal(f.layers[0].alpha,1);assert.equal(f.layers[1].alpha,.6);
  assert.equal(f.warnings.length,1);assert.match(f.warnings[0],/module disabled.*layer 1/);
});

test('project properties select and pause video layers using local clock time',async t=>{
  const data=scene(`let enabled=false,start=9,end=20;
    export function applyUserProperties(p){enabled=p.timevarying;start=Number(p.daytime);end=Number(p.nighttime);p.timevarying=false;}
    export function update(){const hour=new Date().getHours(),day=enabled&&hour>=start&&hour<end;
      for(const name of ['day','night']){const l=thisScene.getLayer(name);l.visible=name===(day?'day':'night');if(l.visible)l.getVideoTexture().play();else l.getVideoTexture().pause();}}`);
  data.userProperties={timevarying:true,daytime:'9',nighttime:'20'};
  data.textures=[{key:'day',mimeType:'video/mp4'},{key:'night',mimeType:'video/mp4'}];
  data.layers.push({...layer(2),name:'day',texture:'day',visible:false},{...layer(3),name:'night',texture:'night',visible:false});
  const s=await use(t,data);
  for(const [hour,expected] of [[8,'night'],[9,'day'],[19,'day'],[20,'night'],[0,'night']]){
    const f=s.update(0,0,[],new Date(2026,8,19,hour).getTime());
    assert.deepEqual(f.layers.slice(1).map(l=>[l.visible,l.videoPlaying]),['day','night'].map(n=>[n===expected,n===expected]));assert.deepEqual(f.warnings,[]);
  }
  assert.equal(data.userProperties.timevarying,true);
  await assert.rejects(ScenePropertyScripts.create(scene(`export function init(){thisLayer.getVideoTexture().play();}`)),/SceneScript/);
});

test('cursor events receive value-copy coordinates and timers retain their owning binding',async t=>{
  const data=scene(`export function cursorEnter(e){thisLayer.origin=e.localPosition;}
    export function cursorMove(e){thisLayer.origin=e.worldPosition;}
    export function cursorLeave(){thisLayer.alpha=.5;}
    export function cursorClick(){engine.setTimeout(()=>{thisLayer.alpha=.25;},100);const cancel=engine.setTimeout(()=>{thisLayer.alpha=0;},100);cancel();}`);
  data.layers.push({...layer(2),scripts:[{property:'visible',properties:{},source:`export function update(){return true}`}]});
  const s=await use(t,data),event=type=>({type,ids:[1],cursor:[30,40,0],local:{1:[2,3,0]}});
  assert.deepEqual(s.update(0,0,[],0,{events:[event('cursorEnter')]}).layers[0].origin,[2,3,0]);
  assert.deepEqual(s.update(0,0,[],0,{events:[event('cursorMove')]}).layers[0].origin,[30,40,0]);
  assert.equal(s.update(0,0,[],0,{events:[event('cursorLeave'),event('cursorClick')]}).layers[0].alpha,.5);
  assert.equal(s.update(.09,.09).layers[0].alpha,.5);
  const frame=s.update(.11,.02);assert.equal(frame.layers[0].alpha,.25);assert.equal(frame.layers[1].alpha,1);assert.deepEqual(frame.warnings,[]);
  assert.throws(()=>s.update(0,0,[],0,{events:[{...event('cursorClick'),local:{2:[0,0,0]}}]}),/input/);
});

test('scene timer callbacks remain metered and queue size is bounded',async t=>{
  const loop=await use(t,scene(`export function init(){engine.setTimeout(()=>{while(true){}},1)}`));
  const start=performance.now();assert.throws(()=>loop.update(.1,.1),/SceneScript/);assert.ok(performance.now()-start<1000);
  await assert.rejects(ScenePropertyScripts.create(scene(`export function init(){for(let i=0;i<257;i++)engine.setTimeout(()=>{},1000)}`)),/SceneScript/);
});

test('timer callbacks see fresh cursor, sound feedback and bone poses',async t=>{
  const d=scene(`export function init(){engine.setTimeout(()=>{thisLayer.origin=input.cursorWorldPosition.add(thisLayer.getLocalBoneOrigin(0));thisLayer.visible=thisScene.getLayer('voice').isPlaying();},100);}`);
  d.layers[0].mesh={bones:[{parent:-1,matrix:matrix(0)}]};d.sounds=[{id:2,name:'voice',volume:1}];
  const s=await use(t,d);
  const f=s.update(.2,.2,[],200,{cursor:[3,4,0],bones:[{id:1,world:matrix(0),local:[matrix(7)]}],sounds:[{id:2,playing:true,volume:1}]});
  assert.deepEqual(f.layers[0].origin,[10,4,0]);assert.equal(f.layers[0].visible,true);
});

test('startup properties event initializes derived values after init; size is a copy',async t=>{
  const s=await use(t,scene(`let scale;export function init(){scale=thisLayer.size.x;}export function applyUserProperties(){scale*=2;}export function update(){const size=thisLayer.size;size.x=99;return new Vec3(scale,thisLayer.size.x,0);}`,'origin'));
  assert.deepEqual(s.update(0,0).layers[0].origin,[8,4,0]);
});

test('sound layers are named value-only interfaces with bounded commands and real playback feedback',async t=>{
  const data=scene(`export function cursorClick(){const sound=thisScene.getLayer('voice');sound.volume=.4;sound.play();}
    export function update(){return thisScene.getLayer('voice').isPlaying();}`);
  data.sounds=[{id:5,name:'voice',volume:.7}];
  const s=await use(t,data),event={type:'cursorClick',ids:[1],cursor:[0,0,0]};
  const frame=s.update(0,0,[],0,{events:[event],sounds:[{id:5,playing:false,volume:.7}]});
  assert.deepEqual(frame.soundCommands,[{id:5,action:'volume',value:.4},{id:5,action:'play'}]);
  assert.equal(frame.layers.length,1);assert.equal(frame.layers[0].visible,true);
  const after=s.update(.1,.1,[],100,{sounds:[{id:5,playing:false,volume:.4}]});
  assert.equal(after.layers[0].visible,false);assert.deepEqual(after.soundCommands,[]);
  assert.throws(()=>s.update(0,0,[],0,{sounds:[{id:999,playing:false,volume:.4}]}),/sound input/);
  const bad=structuredClone(data);bad.layers[0].scripts[0].source=`export function init(){for(let i=0;i<65;i++)thisScene.getLayer('voice').play();}`;
  await assert.rejects(ScenePropertyScripts.create(bad),/SceneScript/);
});

test('bone methods use copy semantics, hierarchical world space and bounded per-frame writes',async t=>{
  const data=scene(`export function init(){if(thisLayer.getBoneIndex('tip')!==1||thisLayer.getBoneParentIndex('tip')!==0)throw Error();}
    export function update(){
      const m=thisLayer.getBoneTransform('tip');if(m.translation().x!==118)throw Error('world');
      m.translation(new Vec3(128,0,0));thisLayer.setBoneTransform('tip',m);m.translation(new Vec3(999));
      if(thisLayer.getLocalBoneOrigin(1).x!==13)throw Error('local');
    }`);
  data.layers[0].mesh={bones:[{name:'root',parent:-1,matrix:matrix(5)},{name:'tip',parent:0,matrix:matrix(3)}]};
  const s=await use(t,data),input={bones:[{id:1,world:matrix(100),local:[matrix(15),matrix(3)]}]};
  const writes=s.update(0,0,[],0,input).layers[0].boneWrites;
  assert.equal(writes[1][12],13);assert.equal(Object.keys(writes).length,1);
  assert.equal(s.update(1,.1,[],0,input).layers[0].boneWrites[1][12],13,'fresh animation input replaces previous transient pose');
});

test('cursor events reach only the targeted layer and support chained bone translations',async t=>{
  const data=scene(`let drag=false;export function cursorDown(e){drag=true;if(e.worldPosition.x!==10)throw Error();}
    export function cursorUp(){drag=false;}
    export function update(){if(drag)thisLayer.setBoneTransform(0,thisLayer.getBoneTransform(0).translation(input.cursorWorldPosition));}`);
  data.layers[0].mesh={bones:[{name:'root',parent:-1,matrix:matrix(0)}]};
  const s=await use(t,data),input={cursor:[20,0,0],bones:[{id:1,world:matrix(5),local:[matrix(0)]}],events:[{type:'cursorDown',ids:[2],cursor:[10,0,0]}]};
  assert.deepEqual(s.update(0,0,[],0,input).layers[0].boneWrites??{},{});
  input.events[0].ids=[1];assert.equal(s.update(1,.1,[],0,input).layers[0].boneWrites[0][12],15);
  input.events=[{type:'cursorUp',ids:[1],cursor:[30,0,0]}];assert.deepEqual(s.update(2,.1,[],0,input).layers[0].boneWrites,{});
});

test('bone matrix output and event queues retain sandbox bounds',async t=>{
  for(const body of [`const m=new Mat4();m.elements[0]=Infinity;thisLayer.setLocalBoneTransform(0,m);`,`thisLayer.getBoneTransform(99)`,`thisLayer.getBoneTransform(0).constructor.constructor('return process')()`]){
    const d=scene(`export function update(){${body}}`);d.layers[0].mesh={bones:[{parent:-1,matrix:matrix(0)}]};
    const s=await use(t,d);assert.throws(()=>s.update(0,0),/SceneScript/);
  }
  const s=await use(t,scene('export function update(){}'));
  assert.throws(()=>s.update(0,0,[],0,{cursor:[NaN,0,0]}),/interaction input/);
  assert.throws(()=>s.update(0,0,[],0,{events:Array(33).fill({type:'cursorUp',ids:[],cursor:[0,0,0]})}),/interaction input/);
});

test('property script uses degree angles, Vec constructors, value-copy getters/setters, and undefined returns',async t=>{
  const s=await use(t,scene(`
    export function update(){
      if(thisLayer.angles.z!==90)throw Error('wrong units');
      const v=new Vec3(2);thisLayer.scale=v;v.x=99;
      const p=thisLayer.origin;p.x=999;
      thisLayer.color=new Vec3(1,0.5);return undefined;
    }`));
  const [a]=s.update(0,0).layers;
  assert.deepEqual(a.scale,[2,2,2]);assert.deepEqual(a.color,[1,.5,0]);
  assert.deepEqual(a.origin,[10,20,0]);assert.equal(a.visible,true);
});

test('script state, init return, per-frame current value and saved controls work',async t=>{
  const s=await use(t,scene(`
    const p=createScriptProperties().addSlider({name:'speed',value:1}).finish();
    export function init(v){return v.add(2);}
    export function update(v){v.x+=engine.frametime*p.speed;return v;}
  `,'origin',{speed:10}));
  assert.deepEqual(s.update(.1,.1).layers[0].origin,[13,22,2]);
  assert.deepEqual(s.update(.2,.1).layers[0].origin,[14,22,2]);
});

test('createLayer resolves workshop scope, preserves template defaults and supports sorting',async t=>{
  const s=await use(t,scene(`
    export const __workshopId='123';let bars=[];
    export function init(){
      const index=thisScene.getLayerIndex(thisLayer);
      for(let i=0;i<3;i++){const b=thisScene.createLayer('models/bar.json');thisScene.sortLayer(b,index);bars.push(b);}
    }
    export function update(){const p=new Vec3(0);for(const b of bars){p.x+=10;b.origin=p;b.parallaxDepth=new Vec2(0);}}
  `));
  const result=s.update(0,0);
  assert.deepEqual(result.layers.map(l=>l.id),[-3,-2,-1,1]);
  assert.deepEqual(result.layers.map(l=>l.origin[0]),[30,20,10,10]);
  assert.equal(result.layers[0].template,'models/workshop/123/bar.json');
});

test('stereo audio buffers update in place, downsample and default to silence',async t=>{
  const s=await use(t,scene(`const b=engine.registerAudioBuffers(16);
    export function update(){return new Vec3(b.left[0],b.right[0],b.average[0]);}`,'scale'));
  assert.deepEqual(s.update(0,0).layers[0].scale,[0,0,0]);
  const audio=[...Array(64).fill(.2),...Array(64).fill(.6)];
  const result=s.update(1,.1,audio);assert.equal(result.audio,true);
  assert.deepEqual(result.layers[0].scale,[.2,.6,.4]);
});

test('separate module bindings retain independent layer and script-property context',async t=>{
  const data=scene(`const p=createScriptProperties().addSlider({name:'x',value:3}).finish();export function update(){thisLayer.origin=new Vec3(p.x);}`);
  data.layers.push({...layer(2),scripts:[{property:'visible',properties:{x:8},source:data.layers[0].scripts[0].source}]});
  const s=await use(t,data);assert.deepEqual(s.update(0,0).layers.map(l=>l.origin[0]),[3,8]);
});

test('property scripts cannot access browser, filesystem, network, or unregistered resources',async t=>{
  const s=await use(t,scene(`export function update(){return [typeof window,typeof process,typeof fetch,typeof require,typeof document].every(x=>x==='undefined');}`));
  assert.equal(s.update(0,0).layers[0].visible,true);
  for(const source of [
    `import fs from 'node:fs';`,
    `export function init(){thisScene.createLayer('../secret');}`,
    `export function init(){thisScene.createLayer('models/unknown.json');}`,
    `export function init(){thisLayer.runCommand('anything');}`,
  ])await assert.rejects(ScenePropertyScripts.create(scene(source)),/SceneScript/);
});

test('init loops, allocation, infinite cloning and invalid output are bounded',async()=>{
  for(const body of ['while(true){}',`for(;;)thisScene.createLayer('models/bar.json');`,`let a=[];for(;;)a.push('x'.repeat(10000));`]){
    await assert.rejects(ScenePropertyScripts.create(scene(`export const __workshopId='123';export function init(){${body}}`)),/SceneScript/);
  }
  for(const body of ['while(true){}','return new Vec3(Infinity)','return {get x(){while(true){}},y:0,z:0}',`return new Vec3(1,2,3)`]){
    const s=await ScenePropertyScripts.create(scene(`export function update(){${body}}`,'angles'));
    try{assert.throws(()=>s.update(0,0),/SceneScript/);}finally{s.dispose();}
  }
});

function shaderLayer(id,source,value=1){
  return {...layer(id),passes:[{uniforms:{u_Value:value},scripts:[{property:'u_Value',source,properties:{}}]}]};
}

test('shader scalar init, persistent values, math imports and real audio drive fade',async t=>{
  const data={width:100,height:100,layers:[shaderLayer(1,`
    import * as WEMath from 'WEMath';const audio=engine.registerAudioBuffers(16);
    export function init(){return 0;}
    export function update(v){console.log(v);return WEMath.mix(v,audio.average[0],engine.frametime);}
  `)]};
  const s=await use(t,data);
  assert.equal(s.update(0,0).layers[0].shaderValues[0].u_Value,0);
  assert.equal(s.update(.5,.5,Array(128).fill(1)).layers[0].shaderValues[0].u_Value,.5);
  assert.equal(s.update(1,.5,Array(128).fill(1)).layers[0].shaderValues[0].u_Value,.75);
});

test('shader color modules produce RGB and keep vector components and per-pass state',async t=>{
  const l=shaderLayer(1,`import * as WEColor from 'WEColor';export function update(v){return WEColor.hsv2rgb(new Vec3(engine.runtime,1,1));}`,[0,0,0]);
  l.passes.push({uniforms:{u_Value:[1,2,3,4]},scripts:[{property:'u_Value',properties:{},source:`export function update(v){return v.add(new Vec4(1));}`}]});
  const s=await use(t,{width:100,height:100,layers:[l]});
  assert.deepEqual(s.update(0,0).layers[0].shaderValues,[{u_Value:[1,0,0]},{u_Value:[2,3,4,5]}]);
  const rgb=s.update(1/3,.1).layers[0].shaderValues[0].u_Value;
  assert.ok(Math.abs(rgb[0])<1e-12&&Math.abs(rgb[1]-1)<1e-12&&Math.abs(rgb[2])<1e-12);
});

test('64 created bars receive independent material scripts, including runtime-created layers',async t=>{
  const data=scene(`export const __workshopId='123';let created=false;
    export function init(){for(let i=0;i<63;i++)thisScene.createLayer('models/bar.json');}
    export function update(){if(!created){created=true;thisScene.createLayer('models/bar.json');}}
  `);
  data.scriptTemplates['models/workshop/123/bar.json']=shaderLayer(0,`
    const audio=engine.registerAudioBuffers(16);let i=0;
    export function init(){return 10;}
    export function update(){return ++i+audio.average[0];}
  `);
  const s=await use(t,data),first=s.update(0,0);
  assert.equal(first.layers.length,65);
  assert.equal(first.layers.find(l=>l.id===-1).shaderValues[0].u_Value,1);
  const second=s.update(.1,.1,Array(128).fill(.5));
  assert.equal(second.layers.find(l=>l.id===-1).shaderValues[0].u_Value,2.5);
  assert.equal(second.layers.find(l=>l.id===-64).shaderValues[0].u_Value,1.5);
});

test('shader bindings reject nonfinite values, wrong vector size and imports outside the allowlist',async()=>{
  for(const value of ['Infinity','[1,2,3]','new Vec2(1,2)']){
    const s=await ScenePropertyScripts.create({width:100,height:100,layers:[shaderLayer(1,`export function update(){return ${value};}`,[0,0,0])]});
    try{assert.throws(()=>s.update(0,0),/SceneScript/);}finally{s.dispose();}
  }
  for(const name of ['node:fs','https://example.com/a.js','../WEMath','constructor']){
    await assert.rejects(ScenePropertyScripts.create({width:100,height:100,layers:[shaderLayer(1,`import x from '${name}';`)]}),/SceneScript/);
  }
});

test('corner alignments are supported with and without a shader-only script',async t=>{
  for(const alignment of ['topleft','topright','bottomleft','bottomright']){
    const s=await use(t,{width:100,height:100,layers:[{...shaderLayer(1,'export function update(v){return v;}'),alignment}]});
    assert.equal(s.update(0,0).layers[0].alignment,alignment);
  }
});
