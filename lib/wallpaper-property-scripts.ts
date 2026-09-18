import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core";
import { sceneScriptModule } from "./wallpaper-scene-script";
import { sceneGuestModule } from "./wallpaper-script-modules";
import { sceneAlignments } from "./wallpaper-scene-parent";
import { sampleSceneTimeline, timelineGuestSource } from "./wallpaper-timeline";
import { boneGuestSource, type SceneScriptInput, type ScriptBonePose } from "./wallpaper-script-bones";
import type { BrowserScene, SceneLayer, SceneMesh, SceneSoundCommand } from "./wallpaper-scene-types";

export interface ScriptLayerState {
  id: number; template?: string; origin: number[]; scale: number[]; angles: number[];
  parallaxDepth: number[]; color: number[]; alpha: number; visible: boolean; alignment: string;
  shaderValues?: Record<string, number | number[]>[];
  boneWrites?: Record<string, number[]>;
}

// This factory executes ONLY inside QuickJS. Scene code receives value-copy
// interfaces, never browser objects or host callbacks. Serialization is metered too.
const guest = String.raw`(function(input) {
  const config = JSON.parse(input), stringify = JSON.stringify;
  const fields = {origin:3, scale:3, angles:3, parallaxDepth:2, color:3};
  const finite = n => { if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n)>1e6) throw Error('Invalid scene value'); return n; };
  class Vec2 {
    constructor(...args) {
      let a = args;
      if (typeof a[0] === 'string') a = a[0].trim().split(/\s+/).map(Number);
      else if (typeof a[0] === 'object') a = [a[0].x, a[0].y, a[0].z];
      else if (a.length === 1) a = [a[0],a[0],a[0]];
      this.x=finite(a[0] ?? 0); this.y=finite(a[1] ?? 0);
    }
    copy(){ return new this.constructor(this); }
    add(v){ const b=new this.constructor(v); return this.map((n,k)=>n+b[k]); }
    subtract(v){ const b=new this.constructor(v); return this.map((n,k)=>n-b[k]); }
    multiply(v){ const b=new this.constructor(v); return this.map((n,k)=>n*b[k]); }
    divide(v){ const b=new this.constructor(v); return this.map((n,k)=>n/b[k]); }
    map(fn){ const out=this.copy(); for(const k of ['x','y',...(this instanceof Vec3?['z']:[]),...(this instanceof Vec4?['w']:[])]) out[k]=fn(this[k],k); return out; }
    lengthSqr(){ return this.x*this.x+this.y*this.y+(this.z??0)**2; }
    length(){ return Math.sqrt(this.lengthSqr()); }
    normalize(){ const n=this.length(); return n?this.divide(n):this.copy(); }
    mix(other,t){ return this.multiply(1-t).add(other.multiply(t)); }
    toString(){ return [this.x,this.y,...(this instanceof Vec3?[this.z]:[])].join(' '); }
  }
  class Vec3 extends Vec2 {
    constructor(...a) {
      super(...a);
      this.z=finite(typeof a[0]==='string' ? Number(a[0].trim().split(/\s+/)[2]??0) : typeof a[0]==='object' ? a[0].z??0 : a.length===1 ? a[0] : a[2]??0);
    }
  }
  class Vec4 extends Vec3 {
    constructor(...a){super(...a);this.w=finite(typeof a[0]==='object'?a[0].w??0:typeof a[0]==='string'?Number(a[0].trim().split(/\s+/)[3]??0):a.length===1?a[0]:a[3]??0);}
  }
  globalThis.Vec2=Vec2; globalThis.Vec3=Vec3; globalThis.Vec4=Vec4;
  const boneApi=(${boneGuestSource})(Vec3,finite);globalThis.Mat4=boneApi.Mat4;
  globalThis.input={cursorWorldPosition:new Vec3(0)};
  globalThis.console=Object.freeze({log(){},warn(){},error(){}});
  let now=config.now, current, currentSpec, overrides={}, workshop='', created=0;
  const NativeDate=Date;
  globalThis.Date=class extends NativeDate {
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  };
  const layers=[], states=new WeakMap(), scripts=[], buffers=[], pending=[], warnings=new Set(), timers=new Map(), soundCommands=[];
  const cursorEvents=['cursorDown','cursorUp','cursorClick','cursorMove','cursorEnter','cursorLeave'];
  let activeScript;
  function invoke(script,fn,args,assign=false){
    select(script.spec);
    const previous=activeScript,commandCount=soundCommands.length;activeScript=script;
    const data=states.get(current),saved=config.partial?{...data,shaderValues:JSON.parse(stringify(data.shaderValues)),boneWrites:JSON.parse(stringify(data.boneWrites??{}))}:undefined;
    try{const v=fn(...args);if(assign&&v!==undefined)write(script.spec,v);return true;}
    catch(e){
      if(!config.partial)throw e;
      Object.assign(data,saved);script.disabled=true;
      soundCommands.length=commandCount;
      for(const [key,timer] of timers)if(timer.script===script)timers.delete(key);
      warnings.add('SceneScript binding disabled after an unsupported API or invalid value: layer '+script.spec.id+', '+script.spec.property);
      return false;
    }
    finally{activeScript=previous;}
  }
  const vector=(v,n)=>{ const value=n===2?new Vec2(v):new Vec3(v); return ['x','y','z'].slice(0,n).map(k=>finite(value[k])); };
  const timelines=(${timelineGuestSource})(finite,${sampleSceneTimeline.toString()}), animations=new WeakMap();
  function wrap(initial){
    const data={...initial,shaderValues:JSON.parse(stringify(initial.shaderValues??[]))};
    for(const [k,n] of Object.entries(fields)) data[k]=vector(new (n===2?Vec2:Vec3)(...data[k]),n);
    const proxy=new Proxy(Object.create(null),{
      get(_,k){
        if(k in fields) return new (fields[k]===2?Vec2:Vec3)(...data[k]);
        if(k==='size')return new Vec2(...data.size);
        if(k==='getAnimation')return name=>animations.get(proxy).find(a=>name===undefined?currentSpec?.id===data.id&&currentSpec.pass===undefined&&a.def.property===currentSpec.property:a.def.name===name)?.api;
        const method=boneApi.api(data,k);if(method)return method;
        if(['name','alpha','visible','alignment'].includes(k)) return data[k];
        throw Error('Unsupported layer API: '+String(k));
      },
      set(_,k,v){
        if(k in fields) data[k]=vector(v,fields[k]);
        else if(k==='alpha') data[k]=Math.max(0,Math.min(1,finite(v)));
        else if(k==='visible') { if(typeof v!=='boolean') throw Error('Invalid visibility'); data[k]=v; }
        else if(k==='alignment') { if(!config.alignments.includes(v)) throw Error('Invalid alignment'); data[k]=v; }
        else throw Error('Unsupported writable layer API: '+String(k));
        return true;
      }
    });
    states.set(proxy,data); layers.push(proxy);
    animations.set(proxy,timelines.create(initial.timelines,(property,values)=>{proxy[property]=values.length===1?values[0]:new (values.length===2?Vec2:Vec3)(...values);}));
    delete data.timelines;
    if(initial.template)pending.push({id:initial.id,template:initial.template});
    return proxy;
  }
  for(const layer of config.layers) wrap(layer);
  for(const sound of config.sounds){
    const data={...sound,sound:true,playing:false};
    const command=(action,value)=>{if(soundCommands.length>=64)throw Error('Sound command limit');soundCommands.push({id:sound.id,action,value});};
    const proxy=new Proxy(Object.create(null),{
      get(_,key){
        if(key==='name'||key==='volume')return data[key];
        if(key==='isPlaying')return ()=>data.playing;
        if(['play','pause','stop'].includes(key))return ()=>{command(key);data.playing=key==='play';};
        throw Error('Unsupported sound API: '+String(key));
      },
      set(_,key,value){if(key!=='volume')throw Error('Unsupported sound property');value=Math.max(0,Math.min(1,finite(value)));command('volume',value);data.volume=value;return true;}
    });
    states.set(proxy,data);layers.push(proxy);
  }
  function find(v){ return typeof v==='number'?layers[v]:typeof v==='string'?layers.find(l=>states.get(l).name===v):states.has(v)?v:undefined; }
  globalThis.thisScene=Object.freeze({
    getLayer:find, getLayerCount:()=>layers.length, enumerateLayers:()=>layers.slice(),
    getLayerIndex:v=>layers.indexOf(find(v)),
    sortLayer(v,index){ const layer=find(v), old=layers.indexOf(layer); if(old<0||!Number.isInteger(index)||index<0||index>=layers.length)return false; layers.splice(old,1);layers.splice(index,0,layer);return true; },
    createLayer(file){
      if(typeof file!=='string'||file.includes('..')||file.includes('\\')||!file.startsWith('models/')) throw Error('Invalid layer asset');
      const scoped=workshop?'models/workshop/'+workshop+'/'+file.slice(7):file;
      const key=Object.hasOwn(config.templates,scoped)?scoped:file;
      if(!Object.hasOwn(config.templates,key)) throw Error('Layer asset was not precached: '+key);
      if(++created>256||layers.length>=512) throw Error('SceneScript layer limit');
      return wrap({...config.templates[key],id:-created,template:key});
    }
  });
  const engine={frametime:0,runtime:0,canvasSize:new Vec2(config.width,config.height),screenResolution:new Vec2(config.width,config.height),
    setTimeout(callback,delay=0){
      if(!activeScript||typeof callback!=='function'||!Number.isFinite(delay)||delay<0||delay>86400000||timers.size>=256)throw Error('Invalid scene timer');
      const key={},timer={callback,at:engine.runtime+delay/1000,script:activeScript};timers.set(key,timer);
      return ()=>timers.delete(key);
    },
    AUDIO_RESOLUTION_16:16,AUDIO_RESOLUTION_32:32,AUDIO_RESOLUTION_64:64,
    registerAudioBuffers(n){
      if(![16,32,64].includes(n)||buffers.length>=512) throw Error('Invalid audio buffer');
      const data={left:Array(n).fill(0),right:Array(n).fill(0),average:Array(n).fill(0)};buffers.push(data);return data;
    }
  };
  globalThis.engine=engine;
  globalThis.MediaPlaybackEvent=Object.freeze({PLAYBACK_STOPPED:0,PLAYBACK_PLAYING:1,PLAYBACK_PAUSED:2});
  globalThis.createScriptProperties=()=>{
    const values=Object.create(null),builder=Object.create(null);
    for(const name of ['addCheckbox','addText','addSlider','addCombo','addColor','addVec2','addVec3']) builder[name]=p=>{
      let v=Object.hasOwn(overrides,p.name)?overrides[p.name]:p.value??p.options?.[0]?.value;
      if(name==='addVec2')v=new Vec2(v);if(name==='addVec3'||name==='addColor')v=new Vec3(v);
      values[p.name]=v;return builder;
    };
    builder.finish=()=>values;return builder;
  };
  function select(spec){ current=layers.find(l=>states.get(l).id===spec.id);if(!current)throw Error('Missing script layer');currentSpec=spec;globalThis.thisLayer=current;globalThis.thisObject=current;overrides=spec.properties;workshop=spec.workshop??''; }
  function read(spec){
    if(spec.pass===undefined)return current[spec.property];
    const v=states.get(current).shaderValues[spec.pass][spec.property];
    return Array.isArray(v)?new ([null,null,Vec2,Vec3,Vec4][v.length])(...v):v;
  }
  function write(spec,v){
    if(spec.pass===undefined){current[spec.property]=v;return;}
    const target=states.get(current).shaderValues[spec.pass],old=target[spec.property];
    target[spec.property]=Array.isArray(old)?['x','y','z','w'].slice(0,old.length).map(k=>finite(v[k])):finite(v);
  }
  return {
    select(json){select(JSON.parse(json));},
    pending(){const out=stringify(pending);pending.length=0;return out;},
    attach(exports,json){
      const spec=JSON.parse(json);
      spec.workshop=exports.__workshopId??'';
      if(typeof spec.workshop!=='string'||(spec.workshop&&!/^\d+$/.test(spec.workshop)))throw Error('Invalid workshop scope');
      select(spec);
      const script={spec,update:exports.update,...Object.fromEntries(cursorEvents.map(k=>[k,exports[k]]))};
      if(typeof exports.init==='function'&&!invoke(script,exports.init,[read(spec)],true))return;
      if(typeof exports.applyUserProperties==='function'&&!invoke(script,exports.applyUserProperties,[{}]))return;
      if(typeof exports.mediaPlaybackChanged==='function'&&!invoke(script,exports.mediaPlaybackChanged,[{state:MediaPlaybackEvent.PLAYBACK_STOPPED}]))return;
      scripts.push(script);
    },
    tick(json){
      const frame=JSON.parse(json);now=frame.now;engine.frametime=frame.dt;
      globalThis.input.cursorWorldPosition=new Vec3(...(frame.input?.cursor??[0,0,0]));
      for(const sound of frame.input?.sounds??[]){const layer=layers.find(l=>states.get(l).sound&&states.get(l).id===sound.id);if(layer)Object.assign(states.get(layer),sound);}
      for(const pose of frame.input?.bones??[]){const layer=layers.find(l=>states.get(l).id===pose.id);if(layer)states.get(layer).bonePose=pose;}
      // Advance to each timer deadline before invoking it, so pause-at-2s
      // reaches exactly that frame even when the browser drops a frame.
      let cursor=frame.time-frame.dt,fired=0;
      for(;;){
        const next=[...timers].filter(([,t])=>t.at<=frame.time).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!next)break;
        if(++fired>256)throw Error('Scene timer execution limit');
        const [key,timer]=next,at=Math.max(cursor,timer.at);timers.delete(key);
        timelines.advance(at-cursor);cursor=at;engine.runtime=at;
        if(!timer.script.disabled)invoke(timer.script,timer.callback,[]);
      }
      timelines.advance(frame.time-cursor);engine.runtime=frame.time;
      for(const event of frame.input?.events??[]){
        globalThis.input.cursorWorldPosition=new Vec3(...event.cursor);
        for(const script of scripts)if(!script.disabled&&event.ids.includes(script.spec.id)&&typeof script[event.type]==='function'){
          const local=event.local?.[script.spec.id];
          invoke(script,script[event.type],[{worldPosition:globalThis.input.cursorWorldPosition.copy(),...(local?{localPosition:new Vec3(...local)}:{})}]);
        }
      }
      globalThis.input.cursorWorldPosition=new Vec3(...(frame.input?.cursor??[0,0,0]));
      for(const buffer of buffers)for(let i=0;i<buffer.average.length;i++){
        const stride=64/buffer.average.length;let l=0,r=0;
        for(let j=0;j<stride;j++){l+=frame.audio[i*stride+j]??0;r+=frame.audio[64+i*stride+j]??0;}
        buffer.left[i]=l/stride;buffer.right[i]=r/stride;buffer.average[i]=(l+r)/stride/2;
      }
      for(const script of scripts)if(!script.disabled&&typeof script.update==='function'){select(script.spec);invoke(script,script.update,[read(script.spec)],true);}
      const out=stringify({layers:layers.filter(l=>!states.get(l).sound).map(l=>{const {bones,bonePose,...state}=states.get(l);return state;}),soundCommands,audio:buffers.length>0,warnings:[...warnings]});
      soundCommands.length=0;
      for(const layer of layers)states.get(layer).boneWrites={};
      return out;
    }
  };
})`;

function state(layer: SceneLayer): ScriptLayerState & { name: string; size: number[]; bones?: SceneMesh["bones"]; timelines?: SceneLayer["timelines"] } {
  return { id: layer.id, name: layer.name, origin: layer.origin, scale: layer.scale,
    angles: [0, 0, layer.angle * 180 / Math.PI], parallaxDepth: layer.parallax,
    color: layer.color, alpha: layer.alpha, visible: layer.visible !== false, alignment: layer.alignment || "center",
    size: layer.size, bones: layer.mesh?.bones, timelines: layer.timelines, shaderValues: layer.passes.map(p => Object.fromEntries((p.scripts || []).map(s => [s.property, p.uniforms[s.property]]))) };
}

export class ScenePropertyScripts {
  private vm: QuickJSContext;
  private api?: QuickJSHandle;
  private deadline = 0;
  private disposed = false;
  private bindingCount = 0;
  private constructor(vm: QuickJSContext, private data: BrowserScene) {
    this.vm = vm;
    vm.runtime.setMemoryLimit(16 * 1024 * 1024);
    vm.runtime.setMaxStackSize(256 * 1024);
    vm.runtime.setInterruptHandler(() => performance.now() > this.deadline);
    vm.runtime.setModuleLoader(sceneGuestModule);
  }
  static async create(data: BrowserScene, now = Date.now(), poses: ScriptBonePose[] = [], partial = false) {
    const runner = new ScenePropertyScripts((await sceneScriptModule()).newContext(), data);
    try {
      runner.deadline = performance.now() + 500;
      const initial = JSON.stringify({ now, partial, width: data.width, height: data.height, alignments: sceneAlignments, sounds: (data.sounds || []).map(s => ({id:s.id,name:s.name || "",volume:s.volume})), layers: data.layers.map(l => ({ ...state(l), bonePose: poses.find(p => p.id === l.id) })),
        templates: Object.fromEntries(Object.entries(data.scriptTemplates || {}).map(([k, l]) => [k, state(l)])) });
      if (initial.length > 1024 * 1024) throw new Error("SceneScript initial state exceeds limit");
      const factory = runner.result(runner.vm.evalCode(guest));
      const input = runner.vm.newString(initial);
      try { runner.api = runner.result(runner.vm.callFunction(factory, runner.vm.undefined, input)); }
      finally { factory.dispose(); input.dispose(); }
      for (const layer of data.layers) runner.attachLayer(layer, layer.id);
      runner.attachCreatedLayers();
      return runner;
    } catch (error) { runner.dispose(); throw error; }
  }
  private attachLayer(layer: SceneLayer, id: number) {
    const bindings = [...(layer.scripts || []).map(script => ({ script, pass: undefined as number | undefined })),
      ...layer.passes.flatMap((p, pass) => (p.scripts || []).map(script => ({ script, pass })))];
    for (const { script, pass } of bindings) {
        if (++this.bindingCount > 512 || script.source.length > 128 * 1024) throw new Error("SceneScript source limit");
        if (pass === undefined ? !["origin", "scale", "angles", "parallaxDepth", "color", "alpha", "visible"].includes(script.property) : !Object.hasOwn(layer.passes[pass].uniforms, script.property)) throw new Error("Unsupported SceneScript property");
        const spec = JSON.stringify({ id, pass, property: script.property, properties: script.properties });
        if (spec.length > 64 * 1024) throw new Error("SceneScript properties exceed limit");
        this.call("select", spec).dispose();
        const exports = this.result(this.vm.evalCode(script.source, `binding-${this.bindingCount}.js`, { type: "module" }));
        try { this.call("attach", spec, exports).dispose(); }
        catch { throw new Error(`SceneScript initialization failed for layer ${id}, ${pass === undefined ? "property" : `pass ${pass}`} ${script.property}`); }
        finally { exports.dispose(); }
    }
  }
  private attachCreatedLayers() {
    for (;;) {
      const handle = this.call("pending", "{}");
      let pending: { id: number; template: string }[];
      try { pending = JSON.parse(this.vm.getString(handle)); } finally { handle.dispose(); }
      if (!pending.length) return;
      for (const item of pending) {
        const template = this.data.scriptTemplates?.[item.template];
        if (!template || !Number.isInteger(item.id) || item.id >= 0) throw new Error("Invalid SceneScript template");
        this.attachLayer(template, item.id);
      }
    }
  }
  private result(result: ReturnType<QuickJSContext["evalCode"]>) {
    if (result.error) { result.error.dispose(); throw new Error("SceneScript failed: unsupported API, invalid value, or execution limit"); }
    return result.value;
  }
  private call(name: string, json: string, first?: QuickJSHandle) {
    const fn = this.vm.getProp(this.api!, name), input = this.vm.newString(json);
    try { return this.result(this.vm.callFunction(fn, this.vm.undefined, ...(first ? [first, input] : [input]))); }
    finally { fn.dispose(); input.dispose(); }
  }
  update(time: number, dt: number, audio: number[] = [], now = Date.now(), input: SceneScriptInput = {}) {
    if (this.disposed) throw new Error("SceneScript is disposed");
    this.deadline = performance.now() + 8;
    if (![time, dt, now].every(Number.isFinite) || dt < 0 || dt > 1 || audio.length > 128 || audio.some(n => !Number.isFinite(n) || n < 0 || n > 1)) throw new Error("Invalid SceneScript frame input");
    const vector=(v:number[],n:number)=>Array.isArray(v)&&v.length===n&&v.every(x=>Number.isFinite(x)&&Math.abs(x)<=1e6);
    if (input.cursor && !vector(input.cursor,3) || (input.events?.length??0)>32 || input.events?.some(e=>!["cursorDown","cursorUp","cursorClick","cursorMove","cursorEnter","cursorLeave"].includes(e.type)||!vector(e.cursor,3)||e.ids.length>512||e.ids.some(id=>!Number.isInteger(id))||Object.entries(e.local??{}).some(([id,v])=>!e.ids.includes(Number(id))||!vector(v,3))) || (input.bones?.length??0)>512 || input.bones?.some(b=>!Number.isInteger(b.id)||!vector(b.world,16)||b.local.length>64||b.local.some(m=>!vector(m,16)))) throw new Error("Invalid SceneScript interaction input");
    const frameInput=JSON.stringify({time,dt,audio,now,input});
    if ((input.sounds?.length ?? 0) > 16 || input.sounds?.some(s => !this.data.sounds?.some(d => d.id === s.id) || typeof s.playing !== "boolean" || !Number.isFinite(s.volume) || s.volume < 0 || s.volume > 1)) throw new Error("Invalid SceneScript sound input");
    if(frameInput.length>1024*1024)throw new Error("SceneScript interaction input exceeds limit");
    const output = this.call("tick", frameInput);
    let json: string;
    try {
      if (this.vm.typeof(output) !== "string") throw new Error("Invalid SceneScript result");
      json = this.vm.getString(output);
      if (json.length > 1024 * 1024) throw new Error("SceneScript result exceeds limit");
    } finally { output.dispose(); }
    const frame = JSON.parse(json) as { layers: ScriptLayerState[]; audio: boolean; warnings: string[]; soundCommands: SceneSoundCommand[] };
    if (!Array.isArray(frame.soundCommands) || frame.soundCommands.length > 64 || frame.soundCommands.some(c => !this.data.sounds?.some(s => s.id === c.id) || !["play","pause","stop","volume"].includes(c.action) || c.action === "volume" && (!Number.isFinite(c.value) || c.value! < 0 || c.value! > 1))) throw new Error("Invalid SceneScript sound command");
    if(!Array.isArray(frame.warnings)||frame.warnings.length>512||frame.warnings.some(w=>typeof w!=="string"||w.length>256))throw new Error("Invalid SceneScript warnings");
    if (!Array.isArray(frame.layers) || frame.layers.length > 512) throw new Error("SceneScript layer limit");
    const ids = new Set<number>();
    for (const layer of frame.layers) {
      if (!Number.isInteger(layer.id) || ids.has(layer.id) || (layer.id < 0 ? !Object.hasOwn(this.data.scriptTemplates || {}, layer.template || "") : !this.data.layers.some(l => l.id === layer.id))) throw new Error("Invalid SceneScript layer");
      ids.add(layer.id);
      for (const [key, length] of Object.entries({ origin: 3, scale: 3, angles: 3, parallaxDepth: 2, color: 3 })) {
        const values = layer[key as keyof ScriptLayerState];
        if (!Array.isArray(values) || values.length !== length || values.some(n => typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 1e6)) throw new Error("Invalid SceneScript vector");
      }
      if (layer.angles[0] || layer.angles[1]) throw new Error("3D SceneScript rotations are not supported");
      if (!Number.isFinite(layer.alpha) || layer.alpha < 0 || layer.alpha > 1 || typeof layer.visible !== "boolean" || !sceneAlignments.includes(layer.alignment)) throw new Error("Invalid SceneScript appearance");
      const definition = layer.id < 0 ? this.data.scriptTemplates![layer.template!] : this.data.layers.find(l => l.id === layer.id)!;
      for(const [index,matrix] of Object.entries(layer.boneWrites??{})) {
        const bone=Number(index);
        if(!Number.isInteger(bone)||bone<0||bone>=(definition.mesh?.bones?.length??0)||!vector(matrix,16)||Math.abs(matrix[3])+Math.abs(matrix[7])+Math.abs(matrix[11])+Math.abs(matrix[15]-1)>1e-6)throw new Error("Invalid SceneScript bone output");
      }
      if (!Array.isArray(layer.shaderValues) || layer.shaderValues.length !== definition.passes.length) throw new Error("Invalid SceneScript shader passes");
      for (const [pass, values] of layer.shaderValues.entries()) {
        const scripts = definition.passes[pass].scripts || [];
        if (Object.keys(values).length !== scripts.length) throw new Error("Invalid SceneScript shader bindings");
        for (const script of scripts) {
          const v = values[script.property], original = definition.passes[pass].uniforms[script.property];
          if (Array.isArray(original) ? !Array.isArray(v) || v.length !== original.length || v.some(n => !Number.isFinite(n) || Math.abs(n) > 1e6) : typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e6) throw new Error("Invalid SceneScript shader value");
        }
      }
    }
    this.attachCreatedLayers();
    return frame;
  }
  dispose() { if (!this.disposed) { this.disposed = true; this.api?.dispose(); this.vm.dispose(); } }
}
