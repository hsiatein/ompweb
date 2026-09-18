import * as T from "three";
import { createNoise3D } from "simplex-noise";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { CopyShader } from "three/addons/shaders/CopyShader.js";
import type { BrowserScene, SceneLayer, SceneParticles, SceneTexture, SceneValues, SceneSoundCommand } from "./wallpaper-scene-types";
import { sceneOutputSize } from "./wallpaper-scene-resolution";
import { sceneLayerOrigin } from "./wallpaper-scene-transform";
import { sceneTargetPlan } from "./wallpaper-scene-targets";
import { SceneMeshAnimator } from "./wallpaper-skinning";
import { sceneAlignmentOffset, sceneWorldTransforms } from "./wallpaper-scene-parent";
import type { ScriptLayerState } from "./wallpaper-property-scripts";
import type { SceneScriptInput } from "./wallpaper-script-bones";
import { pointInSceneMesh, sceneCursorPosition } from "./wallpaper-scene-pointer";
import { audioUniformSpectrum, type WallpaperAudio } from "./wallpaper-audio";

const vertex = `precision highp float;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
attribute float a_Opacity;
uniform mat4 g_ModelViewProjectionMatrix;
varying vec2 v_Uv;
varying float v_Opacity;
void main(){v_Uv=a_TexCoord;v_Opacity=a_Opacity;gl_Position=g_ModelViewProjectionMatrix*vec4(a_Position,1.0);}`;
const fragment = `precision highp float;
varying vec2 v_Uv;
varying float v_Opacity;
uniform sampler2D g_Texture0;
uniform vec4 u_Color;
uniform float u_BlendMode;
uniform sampler2D u_Background;
uniform vec2 u_RenderSize;
float vivid(float a,float b){return b<0.5?(b==0.0?0.0:max(1.0-(1.0-a)/(2.0*b),0.0)):(b==1.0?1.0:min(a/(2.0*(1.0-b)),1.0));}
void main(){gl_FragColor=texture2D(g_Texture0,v_Uv)*u_Color;gl_FragColor.a*=v_Opacity;
if(u_BlendMode==6.0||u_BlendMode==14.0){vec3 a=texture2D(u_Background,gl_FragCoord.xy/u_RenderSize).rgb;vec3 b=gl_FragColor.rgb;
vec3 c=u_BlendMode==6.0?max(a,b):vec3(vivid(a.r,b.r),vivid(a.g,b.g),vivid(a.b,b.b));gl_FragColor=vec4(mix(a,c,gl_FragColor.a),1.0);}
if(u_BlendMode==7.0)gl_FragColor.rgb*=gl_FragColor.a;
if(u_BlendMode==2.0)gl_FragColor.rgb=mix(vec3(1.0),gl_FragColor.rgb,gl_FragColor.a);}`;
const num = (v: unknown, d: number) => typeof v === "number" && Number.isFinite(v) ? v : d;
const vec = (v: unknown, d: number[]) => { const a = typeof v === "string" ? v.split(/\s+/).map(Number) : Array.isArray(v) ? v.map(Number) : []; return d.map((x, i) => Number.isFinite(a[i]) ? a[i] : x); };
const list = (v: unknown): SceneValues[] => Array.isArray(v) ? v : [];
function plane(width: number, height: number) {
  const geometry = new T.PlaneGeometry(width, height);
  geometry.setAttribute("a_Position", geometry.getAttribute("position"));
  const uv = geometry.getAttribute("uv").clone();
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  geometry.setAttribute("a_TexCoord", uv);
  geometry.setAttribute("a_Opacity",new T.Float32BufferAttribute(new Float32Array(uv.count).fill(1),1));
  return geometry;
}
function material(v: string, f: string, uniforms: Record<string, T.IUniform>) {
  const common = "#define texture2D texture\n#define texSample2DLod textureLod\n#define texSample2DGrad textureGrad\n";
  return new T.RawShaderMaterial({ glslVersion: T.GLSL3, vertexShader: common + "#define attribute in\n#define varying out\n" + v, fragmentShader: common + "#define varying in\nout highp vec4 sceneColor;\n#define gl_FragColor sceneColor\n" + f, uniforms, depthTest: false, depthWrite: false, side: T.DoubleSide, transparent: true, blending: T.NormalBlending });
}
function bindMatrix(mesh: T.Mesh, mat: T.RawShaderMaterial) {
  mesh.onBeforeRender = (_r, _s, camera) => {
    (mat.uniforms.g_ModelViewProjectionMatrix.value as T.Matrix4).multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld);
  };
}

type ParticleInstance = { x: number; y: number; anchor?: Particle; credits: number[]; started: boolean; emitting: boolean; alive: number };
type Particle = { age: number; life: number; x: number; y: number; vx: number; vy: number; size: number; angle: number; spin: number; color: number[]; alpha: number; frame: number; seed: number; owner: ParticleInstance; history?: { x: number; y: number; age: number }[] };
export class ParticleSystem {
  readonly mesh: T.Mesh;
  readonly geometry: T.InstancedBufferGeometry;
  readonly mat: T.RawShaderMaterial;
  private particles: Particle[] = [];
  private instances: ParticleInstance[] = [];
  private perInstanceMax: number;
  private initializers: SceneValues[];
  private operators: SceneValues[];
  private emitters: SceneValues[];
  private max: number;
  private random: () => number;
  private noise: ReturnType<typeof createNoise3D>;
  private buffers: Record<string, T.InstancedBufferAttribute>;
  private age = 0;
  private children: ParticleSystem[];
  private trail: SceneValues;
  private rope: boolean;
  private connectedRope: boolean;
  private segments: number;
  controlPoint = new T.Vector2();
  constructor(private definition: SceneParticles, private info: SceneTexture, texture: T.Texture, createChild: (child: SceneParticles) => ParticleSystem, refraction?: { texture?: T.Texture; format: number; background: T.FramebufferTexture; capture: () => void }) {
    let seed = definition.id || 1;
    this.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    this.noise = createNoise3D(this.random);
    this.emitters = list(definition.config.emitter); this.initializers = list(definition.config.initializer); this.operators = list(definition.config.operator);
    this.trail = list(definition.config.renderer).find(r => ["spritetrail", "ropetrail", "rope"].includes(String(r.name))) || {};
    this.connectedRope = this.trail.name === "rope";
    this.rope = this.connectedRope || this.trail.name === "ropetrail";
    this.segments = this.connectedRope ? Math.min(32, Math.max(1, Math.ceil(num(this.trail.subdivision, 1)))) : this.rope ? Math.min(32, Math.max(2, Math.ceil(num(this.trail.segments, 4) * num(this.trail.subdivision, 1)))) : 1;
    this.perInstanceMax = Math.min(2000, Math.max(1, Math.ceil(num(definition.config.maxcount, 100) * num(definition.overrides.count, 1))));
    // Child instances share one instanced draw, but retain separate quotas/clocks.
    this.max = Math.min(20000, this.perInstanceMax * (definition.event?.max || 1));
    const base = plane(1, 1);
    this.geometry = new T.InstancedBufferGeometry(); this.geometry.index = base.index;
    for (const [name, attr] of Object.entries(base.attributes)) this.geometry.setAttribute(name, attr);
    this.buffers = {};
    for (const [name, size] of Object.entries({ i_Position: 2, i_Size: 2, i_Angle: 1, i_Color: 4, i_Frame: 4, i_Basis: 4, ...(this.rope ? { i_Ends: 4, i_Normals: 4, i_EndColor: 4 } : {}) })) {
      this.buffers[name] = new T.InstancedBufferAttribute(new Float32Array(this.max * this.segments * size), size).setUsage(T.DynamicDrawUsage);
      this.geometry.setAttribute(name, this.buffers[name]);
    }
    this.mat = material(`precision highp float;
attribute vec3 a_Position; attribute vec2 a_TexCoord;
attribute vec2 i_Position; attribute vec2 i_Size; attribute float i_Angle;
attribute vec4 i_Color; attribute vec4 i_Frame; attribute vec4 i_Basis;
uniform mat4 g_ModelViewProjectionMatrix;
varying vec2 v_Uv; varying vec4 v_Color;
${refraction ? "uniform float u_SystemAngle; varying vec2 v_Rotation;" : ""}
${this.rope ? "attribute vec4 i_Ends; attribute vec4 i_Normals; attribute vec4 i_EndColor;" : ""}
void main(){vec2 p=a_Position.xy*i_Size;float c=cos(i_Angle),s=sin(i_Angle);
p=vec2(p.x*c-p.y*s,p.x*s+p.y*c)+i_Position;
${this.rope ? "p=mix(i_Ends.xy,i_Ends.zw,a_TexCoord.y)+mix(i_Normals.xy,i_Normals.zw,a_TexCoord.y)*(a_TexCoord.x-0.5)*mix(i_Size.x,i_Size.y,a_TexCoord.y);" : ""}
gl_Position=g_ModelViewProjectionMatrix*vec4(p,0.0,1.0);
${refraction ? "v_Rotation=vec2(cos(i_Angle+u_SystemAngle),sin(i_Angle+u_SystemAngle));" : ""}
v_Uv=i_Frame.xy+a_TexCoord.x*i_Basis.xy+a_TexCoord.y*i_Basis.zw;v_Color=${this.rope ? "mix(i_Color,i_EndColor,a_TexCoord.y)" : "i_Color"};}`, `precision highp float;
uniform sampler2D g_Texture0; varying vec2 v_Uv; varying vec4 v_Color;
uniform float u_Overbright;
${refraction ? "uniform sampler2D u_Normal; uniform sampler2D u_Background; uniform vec2 u_RenderSize; uniform float u_RefractAmount; varying vec2 v_Rotation;" : ""}
void main(){vec4 color=texture2D(g_Texture0,v_Uv);
${info.format === 9 ? "color=vec4(1.0,1.0,1.0,color.r);" : info.format === 8 ? "color=color.rrrg;" : ""}
color*=v_Color;
${refraction ? `vec4 normal=vec4(0.0,0.0,1.0,1.0);
${refraction.texture ? `normal=texture2D(u_Normal,v_Uv);${refraction.format === 8 ? "normal.xy=normal.gr*2.0-1.0;" : `normal.xw=normal.wx;normal.xy=normal.xy*2.0-vec2(${[4, 6, 7].includes(refraction.format) ? "0.965" : "1.0"},1.0);`}` : ""}
vec2 offset=vec2(v_Rotation.x*normal.x+v_Rotation.y*normal.y,v_Rotation.y*normal.x-v_Rotation.x*normal.y)*u_RefractAmount*normal.a*v_Color.a;
color.rgb*=texture2D(u_Background,gl_FragCoord.xy/u_RenderSize+offset).rgb;` : ""}
color.rgb*=u_Overbright;gl_FragColor=color;}`, { g_ModelViewProjectionMatrix: { value: new T.Matrix4() }, g_Texture0: { value: texture }, u_Overbright: { value: definition.overbright ?? 1 }, ...(refraction ? { u_Normal: { value: refraction.texture }, u_Background: { value: refraction.background }, u_RenderSize: { value: new T.Vector2() }, u_RefractAmount: { value: definition.refraction!.amount }, u_SystemAngle: { value: 0 } } : {}) });
    if (definition.blending === "additive") this.mat.blending = T.AdditiveBlending;
    this.mesh = new T.Mesh(this.geometry, this.mat); this.mesh.frustumCulled = false;
    this.mesh.position.set(definition.origin[0], definition.origin[1], 0); this.mesh.rotation.z = definition.angle;
    this.mesh.scale.set(definition.scale[0], definition.scale[1], 1); bindMatrix(this.mesh, this.mat);
    if (refraction) {
      const before = this.mesh.onBeforeRender;
      this.mesh.onBeforeRender = (...args) => {
        refraction.capture();
        this.mat.uniforms.u_RenderSize.value.set(refraction.background.image.width, refraction.background.image.height);
        const m = this.mesh.matrixWorld.elements;
        this.mat.uniforms.u_SystemAngle.value = Math.atan2(m[1], m[0]);
        before.apply(this.mesh, args);
      };
    }
    this.children = definition.children.map(createChild);
    for (const child of this.children) this.mesh.add(child.mesh);
    if (!definition.event) this.activate();
    const warmup = definition.event ? 0 : Math.min(30, num(definition.config.starttime, 0));
    for (let i = 0; i < warmup * 30; i++) this.step(1 / 30);
  }
  private activate(anchor?: Particle, origin = { x: 0, y: 0 }) {
    const event = this.definition.event;
    if (this.instances.length >= (event?.max || 1) || this.random() >= (event?.probability ?? 1)) return;
    const instance: ParticleInstance = { x: anchor?.x ?? origin.x, y: anchor?.y ?? origin.y, anchor: event?.type === "eventfollow" ? anchor : undefined, credits: this.emitters.map(() => 0), started: false, emitting: true, alive: 0 };
    this.instances.push(instance);
    for (const child of this.children) if (child.definition.event?.type === "static") child.activate(undefined, instance);
  }
  private event(type: "eventspawn" | "eventdeath", particle: Particle, snapshot: Particle) {
    for (const child of this.children) if (child.definition.event?.type === type || (type === "eventspawn" && child.definition.event?.type === "eventfollow")) child.activate(child.definition.event?.type === "eventfollow" ? particle : snapshot);
  }
  private range(a: unknown, b: unknown, d: number) { const x = num(a, d); return x + (num(b, x) - x) * this.random(); }
  private spawn(emitter: SceneValues, owner: ParticleInstance) {
    const origin = vec(emitter.origin, [0, 0, 0]), direction = vec(emitter.directions, [1, 1, 1]);
    const angle = this.random() * Math.PI * 2, radius = this.range(emitter.distancemin, emitter.distancemax, 0);
    const speed = this.range(emitter.speedmin, emitter.speedmax, 0);
    const p: Particle = { age: 0, life: 1, x: origin[0] + Math.cos(angle) * radius * direction[0], y: origin[1] + Math.sin(angle) * radius * direction[1], vx: Math.cos(angle) * speed * direction[0], vy: Math.sin(angle) * speed * direction[1], size: 10, angle: 0, spin: 0, color: [1, 1, 1], alpha: 1, frame: Math.floor(this.random() * Math.max(1, this.info.frames.length)), seed: this.random(), owner };
    if (emitter.name === "boxrandom") { const max = vec(emitter.max ?? emitter.distancemax, [100, 100]), min = vec(emitter.min, max.map(n => -n)); p.x = origin[0] + this.range(min[0], max[0], 0); p.y = origin[1] + this.range(min[1], max[1], 0); }
    for (const init of this.initializers) {
      switch (init.name) {
        case "lifetimerandom": p.life = Math.max(.01, this.range(init.min, init.max, 1)); break;
        case "sizerandom": p.size = this.range(init.min, init.max, 10) * num(this.definition.overrides.size, 1); break;
        case "rotationrandom": p.angle = typeof init.min === "string" || typeof init.max === "string" ? this.range(vec(init.min, [0, 0, 0])[2], vec(init.max, [0, 0, 0])[2], 0) : this.range(init.min, init.max, 0); break;
        case "alpharandom": p.alpha = this.range(init.min, init.max, 1); break;
        case "angularvelocityrandom": { const min = vec(init.min, [0, 0, 0]), max = vec(init.max, [0, 0, 0]); p.spin = this.range(min[2], max[2], 0); break; }
        case "velocityrandom": { const min = vec(init.min, [0, 0]), max = vec(init.max, [0, 0]); p.vx = this.range(min[0], max[0], 0); p.vy = this.range(min[1], max[1], 0); break; }
        case "turbulentvelocityrandom": {
          const phase = this.range(init.phasemin, init.phasemax, 0), t = this.age * num(init.timescale, 1) + phase;
          const x = p.x * .1, y = p.y * .1, e = .01;
          const dx = this.noise(x, y + e, t) - this.noise(x, y - e, t);
          const dy = this.noise(x - e, y, t) - this.noise(x + e, y, t);
          const forward = vec(init.forward, [0, 1]), baseAngle = Math.atan2(forward[1], forward[0]);
          let delta = Math.atan2(dy, dx) - baseAngle;
          delta = Math.atan2(Math.sin(delta), Math.cos(delta));
          const limit = Math.max(0, num(init.scale, 1)) * Math.PI / 2;
          const direction = baseAngle + Math.max(-limit, Math.min(limit, delta)) - num(init.offset, 0);
          const speed = this.range(init.speedmin, init.speedmax ?? 250, 100) * num(this.definition.overrides.speed, 1);
          p.vx = Math.cos(direction) * speed; p.vy = Math.sin(direction) * speed; break;
        }
        case "colorrandom": { const min = vec(init.min, [255, 255, 255]), max = vec(init.max, [255, 255, 255]); p.color = min.map((x, i) => this.range(x, max[i], 255) / 255); break; }
      }
    }
    const transform = this.definition.event;
    if (transform) {
      const c = Math.cos(transform.angle), s = Math.sin(transform.angle);
      const x = p.x * transform.scale[0], y = p.y * transform.scale[1];
      const vx = p.vx * transform.scale[0], vy = p.vy * transform.scale[1];
      p.x = x * c - y * s + transform.origin[0]; p.y = x * s + y * c + transform.origin[1];
      p.vx = vx * c - vy * s; p.vy = vx * s + vy * c;
      p.angle += transform.angle;
    }
    p.x += owner.x; p.y += owner.y;
    if (this.rope && !this.connectedRope) p.history = [{ x: p.x, y: p.y, age: 0 }];
    return p;
  }
  step(dt: number) {
    this.age += dt;
    const events: { type: "eventspawn" | "eventdeath"; particle: Particle; snapshot: Particle }[] = [];
    this.particles = this.particles.filter(p => {
      const remaining = p.life - p.age; p.age += dt;
      if (p.age < p.life) return true;
      p.x += p.vx * Math.max(0, remaining); p.y += p.vy * Math.max(0, remaining);
      p.owner.alive--; events.push({ type: "eventdeath", particle: p, snapshot: { ...p } }); return false;
    });
    for (const instance of this.instances) {
      if (instance.anchor) {
        instance.x = instance.anchor.x; instance.y = instance.anchor.y;
        if (instance.anchor.age >= instance.anchor.life) instance.emitting = false;
      }
      if (!instance.emitting) continue;
      for (const [i, emitter] of this.emitters.entries()) {
        const rate = Math.max(0, num(emitter.rate, 10));
        instance.credits[i] += (dt * rate + (instance.started ? 0 : Math.max(0, num(emitter.instantaneous, 0)))) * num(this.definition.overrides.count, 1);
        const count = Math.min(this.max, Math.floor(instance.credits[i])); instance.credits[i] -= Math.floor(instance.credits[i]);
        for (let j = 0; j < count && this.particles.length < this.max && instance.alive < this.perInstanceMax; j++) {
          const p = this.spawn(emitter, instance); this.particles.push(p); instance.alive++; events.push({ type: "eventspawn", particle: p, snapshot: { ...p } });
        }
      }
      instance.started = true;
      if (this.emitters.every(emitter => num(emitter.rate, 10) <= 0)) instance.emitting = false;
    }
    this.instances = this.instances.filter(instance => instance.emitting || instance.alive);
    for (const p of this.particles) {
      let nx = 0, ny = 0;
      for (const op of this.operators) {
        if (op.name === "movement") { const g = vec(op.gravity, [0, 0]); const decay = Math.exp(-num(op.drag, 0) * dt); p.vx = (p.vx + g[0] * dt) * decay; p.vy = (p.vy + g[1] * dt) * decay; }
        if (op.name === "turbulence") {
          const scale = num(op.scale, .01), t = this.age / Math.max(.01, num(op.timescale, 1)), speed = (num(op.speedmin, 0) + num(op.speedmax, 0)) / 2;
          nx += this.noise(p.x * scale, p.y * scale, t) * speed; ny += this.noise(p.x * scale + 31, p.y * scale, t) * speed;
        }
        if (op.name === "angularmovement") p.spin += vec(op.force, [0, 0, 0])[2] * dt;
        if (op.name === "controlpointattract") {
          const cp = list(this.definition.config.controlpoint).find(c => c.id === op.controlpoint);
          const origin = vec(op.origin, [0, 0]);
          const point = cp && (num(cp.flags, 0) & 1) ? [this.controlPoint.x, this.controlPoint.y] : vec(cp?.offset, [0, 0]);
          const dx = point[0] + origin[0] - p.x, dy = point[1] + origin[1] - p.y;
          const distance = Math.hypot(dx, dy), threshold = Math.max(1, num(op.threshold, 32));
          if (distance < threshold && distance > .001) { const force = num(op.scale, 0) * (1 - distance / threshold) * dt / distance; p.vx += dx * force; p.vy += dy * force; }
        }
      }
      p.x += (p.vx + nx) * dt; p.y += (p.vy + ny) * dt; p.angle += p.spin * dt;
      if (p.history && dt > 0) {
        const length = Math.max(.01, num(this.trail.length, 1));
        if (p.age - p.history[p.history.length - 1].age >= length / this.segments) p.history.push({ x: p.x, y: p.y, age: p.age });
        while (p.history.length > this.segments + 1 || (p.history.length > 1 && p.history[1].age < p.age - length)) p.history.shift();
      }
    }
    for (const child of this.children) child.step(dt);
    // Expire old instances before admitting new events. Newborn child bursts do
    // not consume the elapsed time that preceded their creation.
    for (const event of events) this.event(event.type, event.particle, event.snapshot);
    if (events.length) for (const child of this.children) child.step(0);
  }
  upload() {
    const b = this.buffers;
    let count = 0;
    const ribbons = new Map<ParticleInstance, { x: number; y: number; size: number; rgba: number[]; frame: number }[]>();
    this.particles.forEach(p => {
      let alpha = p.alpha, size = p.size, x = p.x, y = p.y, color = p.color;
      for (const op of this.operators) {
        const wave = (phase: number) => { const low = num(op.frequencymin, 1), frequency = low + (num(op.frequencymax, low) - low) * p.seed; return .5 + .5 * Math.sin(p.age * frequency * Math.PI * 2 + p.seed * 6.28 + phase); };
        const amount = (phase: number, low: number, high: number) => num(op.scalemin, low) + (num(op.scalemax, high) - num(op.scalemin, low)) * wave(phase);
        if (op.name === "oscillatealpha") alpha *= amount(0, 0, 1);
        if (op.name === "oscillatesize") size *= amount(0, .5, 1);
        if (op.name === "oscillateposition") { const amplitude = num(op.scalemax, 10); x += (wave(0) * 2 - 1) * amplitude; y += (wave(1.57) * 2 - 1) * amplitude; }
        const progress = Math.max(0, Math.min(1, (p.age / p.life - num(op.starttime, 0)) / Math.max(.0001, num(op.endtime, 1) - num(op.starttime, 0))));
        if (op.name === "sizechange" || op.name === "alphachange") {
          const value = num(op.startvalue, 1) + (num(op.endvalue, 0) - num(op.startvalue, 1)) * progress;
          if (op.name === "sizechange") size *= value; else alpha *= value;
        }
        if (op.name === "colorchange") { const from = vec(op.startvalue, [1, 1, 1]), to = vec(op.endvalue, [1, 1, 1]); color = color.map((v, i) => v * (from[i] + (to[i] - from[i]) * progress)); }
      }
      for (const op of this.operators) if (op.name === "alphafade") { const t = p.age / p.life, start = num(op.fadeintime, .1), end = num(op.fadeouttime, .9); alpha *= Math.min(1, t / Math.max(.0001, start), (1 - t) / Math.max(.0001, 1 - end)); }
      const frame = this.info.frames[p.frame] || { x: 0, y: 0, width: 1, height: 1 };
      const axes = frame.axes || [frame.width, 0, 0, frame.height];
      const aspect = this.info.height * frame.height / (this.info.width * frame.width);
      if (this.connectedRope) {
        let points = ribbons.get(p.owner);
        if (!points) { points = []; ribbons.set(p.owner, points); }
        points.push({ x, y, size, rgba: [...color, alpha], frame: p.frame });
      } else if (this.rope && p.history) {
        const points = [...p.history, { x: p.x, y: p.y }].slice(-(this.segments + 1));
        const normal = (i: number) => { const a = points[Math.max(0, i - 1)], z = points[Math.min(points.length - 1, i + 1)], d = Math.hypot(z.x - a.x, z.y - a.y) || 1; return [-(z.y - a.y) / d, (z.x - a.x) / d]; };
        for (let j = 0; j < points.length - 1; j++) {
          const i = count++, a = points[j], z = points[j + 1], n = normal(j), m = normal(j + 1);
          b.i_Ends.setXYZW(i, a.x, a.y, z.x, z.y); b.i_Normals.setXYZW(i, n[0], n[1], m[0], m[1]);
          b.i_Size.setXY(i, size, size); b.i_Color.setXYZW(i, ...color as [number, number, number], alpha);
          b.i_EndColor.setXYZW(i, ...color as [number, number, number], alpha);
          const fraction = j / (points.length - 1);
          b.i_Frame.setXYZW(i, frame.x + axes[2] * fraction, frame.y + axes[3] * fraction, 0, 0);
          b.i_Basis.setXYZW(i, axes[0], axes[1], axes[2] / (points.length - 1), axes[3] / (points.length - 1));
        }
      } else {
        const i = count++, speed = Math.hypot(p.vx, p.vy);
        const trail = this.trail.name === "spritetrail";
        const length = trail ? Math.max(num(this.trail.minlength, 0), Math.min(num(this.trail.maxlength, 10), speed * num(this.trail.length, .05))) : 1;
        const scale = this.definition.event?.scale || [1, 1];
        b.i_Position.setXY(i, x, y); b.i_Size.setXY(i, size * scale[0], size * aspect * length * scale[1]); b.i_Angle.setX(i, trail ? Math.atan2(p.vy, p.vx) - Math.PI / 2 : p.angle);
        b.i_Color.setXYZW(i, ...color as [number, number, number], alpha); b.i_Frame.setXYZW(i, frame.x, frame.y, frame.width, frame.height);
        b.i_Basis.setXYZW(i, ...axes as [number, number, number, number]);
      }
    });
    // A rope joins living particles in birth order; ropetrail instead follows
    // each particle's history. Separate event owners must never be connected.
    for (const points of ribbons.values()) {
      if (points.length < 2) continue;
      const curve = new T.CatmullRomCurve3(points.map(p => new T.Vector3(p.x, p.y, 0)), false, "centripetal");
      const steps = (points.length - 1) * this.segments;
      const vertices = curve.getPoints(steps), normals = vertices.map((_, i) => {
        const a = vertices[Math.max(0, i - 1)], z = vertices[Math.min(steps, i + 1)];
        return new T.Vector2(-(z.y - a.y), z.x - a.x).normalize();
      });
      const frame = this.info.frames[points[0].frame] || { x: 0, y: 0, width: 1, height: 1 };
      const axes = frame.axes || [frame.width, 0, 0, frame.height];
      const sample = (step: number) => {
        const index = Math.min(points.length - 2, Math.floor(step / this.segments)), f = step / this.segments - index;
        const a = points[index], z = points[index + 1];
        return { size: a.size * (1 - f) + z.size * f, rgba: a.rgba.map((c, i) => c * (1 - f) + z.rgba[i] * f) };
      };
      for (let j = 0; j < steps; j++) {
        const i = count++, a = vertices[j], z = vertices[j + 1], n = normals[j], m = normals[j + 1], start = sample(j), end = sample(j + 1);
        b.i_Ends.setXYZW(i, a.x, a.y, z.x, z.y); b.i_Normals.setXYZW(i, n.x, n.y, m.x, m.y);
        b.i_Size.setXY(i, start.size, end.size); b.i_Color.setXYZW(i, ...start.rgba as [number, number, number, number]); b.i_EndColor.setXYZW(i, ...end.rgba as [number, number, number, number]);
        b.i_Frame.setXYZW(i, frame.x + axes[2] * j / steps, frame.y + axes[3] * j / steps, 0, 0);
        b.i_Basis.setXYZW(i, axes[0], axes[1], axes[2] / steps, axes[3] / steps);
      }
    }
    for (const attr of Object.values(b)) attr.needsUpdate = true;
    this.geometry.instanceCount = count;
    for (const child of this.children) { child.mesh.renderOrder = this.mesh.renderOrder + .01; child.upload(); }
  }
  dispose() { for (const child of this.children) child.dispose(); this.geometry.dispose(); this.mat.dispose(); }
}

export class BrowserSceneRenderer {
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera: T.OrthographicCamera;
  private textures = new Map<string, T.Texture>();
  private videos: HTMLVideoElement[] = [];
  private audio?: WallpaperAudio;
  private spectrum = Array<number>(128).fill(0);
  private audioRequired = false;
  private scriptStates = new Map<number, ScriptLayerState>();
  private scriptUniforms = new Map<number, Record<string, T.IUniform>[]>();
  private fonts: FontFace[] = [];
  private textLayers: import("./wallpaper-scene-text").SceneTextTexture[] = [];
  private skins: { id: number; animation: SceneMeshAnimator; positions: T.BufferAttribute; opacities: T.BufferAttribute }[] = [];
  private propertyScripts?: import("./wallpaper-property-scripts").ScenePropertyScripts;
  private scriptWarnings: string[] = [];
  private pendingSoundCommands: SceneSoundCommand[] = [];
  private scriptLayers = new Map<number, { layer: SceneLayer; mesh: T.Mesh; origin: number[]; depth: number[] }>();
  private dynamicPixels = 0;
  private materials: T.RawShaderMaterial[] = [];
  private geometries: T.BufferGeometry[] = [];
  private passes: { scene: T.Scene; camera: T.Camera; target: T.WebGLRenderTarget; mat: T.RawShaderMaterial; deferred?: boolean }[] = [];
  private background?: T.FramebufferTexture;
  private reflectionBuffer?: { target: T.WebGLRenderTarget; scene: T.Scene; camera: T.Camera };
  private particles: ParticleSystem[] = [];
  private disposed = false;
  private ready = false;
  private time = 0;
  private last = 0;
  private frame = 0;
  private paused = true;
  private dirty = true;
  private resizeDirty = true;
  private dpr = 0;
  private fit = "";
  private observer: ResizeObserver;
  private styleObserver: MutationObserver;
  private shaderError: string | undefined;
  private composer?: EffectComposer;
  private bloom?: UnrealBloomPass;
  private output?: ShaderPass;
  private transforms: { mesh: T.Mesh; origin: number[]; depth: number[] }[] = [];
  private pointer = new T.Vector2();
  private cursorClient = { x: 0, y: 0 };
  private cursorEvents: NonNullable<SceneScriptInput["events"]> = [];
  private dragLayers: number[] = [];
  private hoverLayers: number[] = [];
  private cursorMoved = false;
  private cursorBlocked = false;
  private lastPointer = new T.Vector2();
  private effectLayers: { mesh: T.Mesh; size: number[]; materials: T.RawShaderMaterial[] }[] = [];
  private smoothPointer = new T.Vector2();
  private animations: { mat: T.RawShaderMaterial; frames: SceneTexture["frames"] }[] = [];
  private noise = createNoise3D(() => .42);
  private constructor(private canvas: HTMLCanvasElement, private data: BrowserScene, private onError: (e: string) => void) {
    // The crop preview reads this canvas even while playback is paused.
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, depth: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
    this.renderer.autoClear = true;
    this.renderer.debug.onShaderError = (gl, _p, vs, fs) => { this.shaderError = `${gl.getShaderInfoLog(vs) || ""}\n${gl.getShaderInfoLog(fs) || ""}`; };
    this.camera = new T.OrthographicCamera(0, data.width, data.height, 0, -10, 10);
    this.scene.background = new T.Color(data.clearColor[0], data.clearColor[1], data.clearColor[2]);
    if (data.bloom) {
      this.composer = new EffectComposer(this.renderer, new T.WebGLRenderTarget(1, 1, { type: T.UnsignedByteType, depthBuffer: false }));
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      // Normalize the five-mip gain. WE extracts threshold excess, whereas the
      // stock Three pass retains whole bright pixels and washes out SDR art.
      this.bloom = new UnrealBloomPass(new T.Vector2(1, 1), data.bloom.strength / 9, .4, data.bloom.threshold);
      this.bloom.materialHighPassFilter.fragmentShader = `uniform sampler2D tDiffuse;
uniform float luminosityThreshold; varying vec2 vUv;
void main(){vec3 c=texture2D(tDiffuse,vUv).rgb;
float excess=clamp(max(c.r,max(c.g,c.b))-luminosityThreshold,0.0,1.0);
float gray=dot(c,vec3(0.2989,0.5870,0.1140));
gl_FragColor=vec4(max(vec3(0.0),2.0*c-gray)*excess,1.0);}`;
      this.composer.addPass(this.bloom);
      // Raw scene shaders already contain display-space colors. A plain copy
      // avoids the bloom pass's MeshBasicMaterial applying a second gamma curve.
      this.output = new ShaderPass(CopyShader); this.composer.addPass(this.output);
    }
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    this.styleObserver = new MutationObserver(() => { if (this.fit !== canvas.style.objectFit) this.resize(); });
    this.styleObserver.observe(canvas, { attributes: true, attributeFilter: ["style"] });
    canvas.addEventListener("webglcontextlost", this.contextLost);
    document.addEventListener("visibilitychange", this.visibility);
    window.addEventListener("pointermove", this.pointerMove, { passive: true });
    window.addEventListener("pointerdown", this.pointerDown, { passive: true });
    window.addEventListener("pointerup", this.pointerUp, { passive: true });
    window.addEventListener("pointercancel", this.pointerUp, { passive: true });
    window.addEventListener("blur", this.pointerRelease);
    window.addEventListener("resize", this.resize);
  }
  private resize = () => { this.resizeDirty = true; this.dirty = true; this.schedule(); };
  private pointerMove = (e: PointerEvent) => {
    this.pointer.set(e.clientX / window.innerWidth - .5, .5 - e.clientY / window.innerHeight);
    this.cursorClient = { x: e.clientX, y: e.clientY }; this.cursorMoved = true;
    this.cursorBlocked = e.target instanceof Element && !!e.target.closest('button,a,input,textarea,select,[contenteditable="true"],[role="dialog"]');
  };
  private cursorWorld() { return sceneCursorPosition(this.data, this.canvas.getBoundingClientRect(), this.cursorClient, this.canvas.style.objectFit, this.canvas.style.objectPosition); }
  private cursorHit() {
    if (this.cursorBlocked) return [];
    const rect = this.canvas.getBoundingClientRect();
    if (this.cursorClient.x < rect.left || this.cursorClient.x > rect.right || this.cursorClient.y < rect.top || this.cursorClient.y > rect.bottom) return [];
    const cursor = this.cursorWorld(), world = new T.Vector3(...cursor), hits: number[] = [];
    for (const { layer, mesh } of [...this.scriptLayers.values()].sort((a, b) => b.mesh.renderOrder - a.mesh.renderOrder)) {
      const scripts = [...(layer.scripts || []), ...layer.passes.flatMap(p => p.scripts || [])];
      const interactive = scripts.some(s => /export\s+function\s+cursor(?:Down|Up|Click|Move|Enter|Leave)\b/.test(s.source));
      if (layer.group || layer.solid === false || !mesh.visible || !interactive && !layer.disablePropagation) continue;
      mesh.updateMatrixWorld();
      if (Math.abs(mesh.matrixWorld.determinant()) < 1e-12) continue;
      const local = world.clone().applyMatrix4(mesh.matrixWorld.clone().invert()), geometry = mesh.geometry;
      if (!pointInSceneMesh(local.x, local.y, geometry.getAttribute("a_Position").array, geometry.index!.array)) continue;
      if (interactive) hits.push(layer.id);
      if (layer.disablePropagation) break;
    }
    return hits;
  }
  private queueCursor(type: NonNullable<SceneScriptInput["events"]>[number]["type"], ids: number[]) {
    if (!ids.length) return;
    const cursor = this.cursorWorld(), local: Record<string, number[]> = {};
    for (const id of ids) {
      const target = this.scriptLayers.get(id); if (!target) continue;
      target.mesh.updateMatrixWorld();
      if (Math.abs(target.mesh.matrixWorld.determinant()) < 1e-12) continue;
      const point = new T.Vector3(...cursor).applyMatrix4(target.mesh.matrixWorld.clone().invert());
      local[id] = [point.x + target.layer.size[0] / 2, point.y + target.layer.size[1] / 2, point.z];
    }
    if (this.cursorEvents.length >= 32) this.cursorEvents.shift();
    this.cursorEvents.push({ type, ids: [...ids], cursor, local });
  }
  private flushCursorMove() {
    if (!this.cursorMoved || this.paused || !this.propertyScripts) return;
    this.cursorMoved = false;
    const hit = this.cursorHit();
    this.queueCursor("cursorLeave", this.hoverLayers.filter(id => !hit.includes(id)));
    this.queueCursor("cursorEnter", hit.filter(id => !this.hoverLayers.includes(id)));
    this.queueCursor("cursorMove", hit); this.hoverLayers = hit;
  }
  private pointerDown = (e: PointerEvent) => {
    if (!this.propertyScripts || this.paused || e.button !== 0 || !e.isPrimary || this.dragLayers.length) return;
    this.pointerMove(e); this.flushCursorMove(); this.dragLayers = this.cursorHit();
    this.queueCursor("cursorDown", this.dragLayers);
  };
  private pointerUp = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0 && e.type !== "pointercancel") return;
    this.pointerMove(e); this.flushCursorMove();
    const pressed = this.dragLayers, hit = this.cursorHit();
    this.queueCursor("cursorUp", [...new Set([...pressed, ...hit])]); this.dragLayers = [];
    if (e.type !== "pointercancel") this.queueCursor("cursorClick", pressed.filter(id => hit.includes(id)));
  };
  private pointerRelease = () => {
    this.queueCursor("cursorUp", this.dragLayers); this.dragLayers = [];
    this.queueCursor("cursorLeave", this.hoverLayers); this.hoverLayers = []; this.cursorMoved = false;
  };
  private contextLost = (e: Event) => { e.preventDefault(); this.paused = true; this.onError("WebGL context lost. Reselect the wallpaper to reload."); };
  private visibility = () => { this.last = 0; this.setPaused(this.paused); };
  static async create(canvas: HTMLCanvasElement, data: BrowserScene, signal: AbortSignal, onError: (e: string) => void) {
    const result = new BrowserSceneRenderer(canvas, data, onError);
    try {
      for (const info of data.textures) {
        if (info.mimeType === "video/mp4") {
          const video = document.createElement("video");
          result.videos.push(video);
          video.muted = true; video.loop = true; video.playsInline = true; video.preload = "auto";
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { video.removeEventListener("loadeddata", loaded); video.removeEventListener("error", failed); signal.removeEventListener("abort", aborted); };
            const loaded = () => { cleanup(); resolve(); };
            const failed = () => { cleanup(); reject(new Error("Cannot decode embedded scene video")); };
            const aborted = () => { cleanup(); reject(new DOMException("Aborted", "AbortError")); };
            video.addEventListener("loadeddata", loaded); video.addEventListener("error", failed); signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) { aborted(); return; }
            video.src = info.url;
          });
          video.width = video.videoWidth; video.height = video.videoHeight;
          const texture = new T.VideoTexture(video); texture.flipY = false; texture.colorSpace = T.NoColorSpace;
          result.textures.set(info.key, texture);
          continue;
        }
        const response = await fetch(info.url, { signal });
        if (!response.ok) throw new Error("Cannot load scene texture");
        const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        if (signal.aborted) { bitmap.close(); throw new DOMException("Aborted", "AbortError"); }
        const texture = new T.Texture(bitmap); texture.flipY = false; texture.colorSpace = T.NoColorSpace;
        texture.minFilter = T.LinearMipmapLinearFilter; texture.magFilter = T.LinearFilter;
        texture.anisotropy = Math.min(8, result.renderer.capabilities.getMaxAnisotropy()); texture.needsUpdate = true;
        result.textures.set(info.key, texture);
      }
      if (data.layers.some(layer => layer.texture === "@transparent")) {
        const texture = new T.DataTexture(new Uint8Array(4), 1, 1);
        texture.needsUpdate = true;
        result.textures.set("@transparent", texture);
      }
      for (const info of data.fonts || []) {
        const response = await fetch(info.url, { signal });
        if (!response.ok) throw new Error("Cannot load scene font");
        const face = new FontFace(`we-${info.key}`, await response.arrayBuffer());
        await face.load();
        signal.throwIfAborted();
        document.fonts.add(face); result.fonts.push(face);
      }
      for (const [i, layer] of data.layers.entries()) {
        if (layer.text) {
          const { SceneTextTexture } = await import("./wallpaper-scene-text");
          const family = layer.text.font.startsWith("@system:") ? layer.text.font.slice(8) : `"we-${layer.text.font}"`;
          const text = await SceneTextTexture.create(layer, family, result.renderer.capabilities.maxTextureSize);
          result.textLayers.push(text); result.textures.set(layer.texture, text.texture);
          signal.throwIfAborted();
        }
        result.addLayer(layer, i);
      }
      const createParticle = (definition: SceneParticles): ParticleSystem => {
        const refraction = definition.refraction;
        if (refraction) result.background ??= new T.FramebufferTexture(1, 1);
        return new ParticleSystem(definition, data.textures.find(t => t.key === definition.texture)!, result.textures.get(definition.texture)!, createParticle, refraction ? { texture: refraction.texture ? result.textures.get(refraction.texture) : undefined, format: data.textures.find(t => t.key === refraction.texture)?.format ?? 0, background: result.background!, capture: () => result.renderer.copyFramebufferToTexture(result.background!) } : undefined);
      };
      for (const [i, definition] of data.particles.entries()) {
        const p = createParticle(definition);
        p.mesh.renderOrder = data.layers.length + i; result.particles.push(p); result.scene.add(p.mesh);
        result.transforms.push({ mesh: p.mesh, origin: sceneLayerOrigin(data, definition.origin, definition.parallax), depth: definition.parallax });
      }
      if (data.layers.some(l => l.timelines?.length || l.scripts?.length || l.passes.some(p => p.scripts?.length))) {
        const { ScenePropertyScripts } = await import("./wallpaper-property-scripts");
        for (const skin of result.skins) skin.animation.update(0);
        result.updateLayerTransforms(0);
        result.propertyScripts = await ScenePropertyScripts.create(data, Date.now(), result.scriptBonePoses(), true);
        signal.throwIfAborted();
      }
      result.ready = true; result.resizeDirty = true;
      result.draw(0);
      if (result.shaderError) throw new Error(`Scene shader compilation failed: ${result.shaderError.slice(0, 400)}`);
      return result;
    } catch (e) { result.dispose(); throw e; }
  }
  private addLayer(layer: SceneLayer, order: number) {
    const capture = layer.texture === "@scene";
    if (capture || layer.reflection || [6, 14].includes(layer.colorBlendMode)) this.background ??= new T.FramebufferTexture(1, 1);
    if (layer.reflection && !this.reflectionBuffer) {
      const target = new T.WebGLRenderTarget(1, 1, { depthBuffer: false, generateMipmaps: true, minFilter: T.LinearMipmapLinearFilter });
      const geometry = plane(2, 2); this.geometries.push(geometry);
      const mat = material(vertex, "precision highp float; varying vec2 v_Uv; uniform sampler2D g_Texture0; void main(){gl_FragColor=texture2D(g_Texture0,vec2(v_Uv.x,1.0-v_Uv.y));}", { g_ModelViewProjectionMatrix: { value: new T.Matrix4() }, g_Texture0: { value: this.background } });
      mat.blending = T.NoBlending; this.materials.push(mat);
      const mesh = new T.Mesh(geometry, mat); bindMatrix(mesh, mat);
      const scene = new T.Scene(); scene.add(mesh);
      this.reflectionBuffer = { target, scene, camera: new T.OrthographicCamera(-1, 1, 1, -1, -1, 1) };
    }
    let texture: T.Texture = capture ? this.background! : this.textures.get(layer.texture)!;
    const firstPass = this.passes.length;
    const [width, height] = layer.size;
    const geometry = plane(width, height); this.geometries.push(geometry);
    const info = this.data.textures.find(t => t.key === layer.texture) || { frames: [] };
    if (capture) {
      const captureVertex = vertex.replace("void main()", "uniform mat4 u_CaptureProjection; varying vec3 v_Capture;\nvoid main()").replace("v_Uv=a_TexCoord;", "v_Uv=a_TexCoord;v_Capture=(u_CaptureProjection*vec4(a_Position,1.0)).xyw;");
      const mat = material(captureVertex, "precision highp float; varying vec3 v_Capture; uniform sampler2D g_Texture0; void main(){gl_FragColor=texture2D(g_Texture0,v_Capture.xy/v_Capture.z*0.5+0.5);}", { g_ModelViewProjectionMatrix: { value: new T.Matrix4() }, u_CaptureProjection: { value: new T.Matrix4() }, g_Texture0: { value: texture }, g_Time: { value: 0 } });
      mat.blending = T.NoBlending;
      const mesh = new T.Mesh(geometry, mat); mesh.frustumCulled = false; bindMatrix(mesh, mat);
      const scene = new T.Scene(); scene.add(mesh);
      const camera = new T.OrthographicCamera(-width / 2, width / 2, -height / 2, height / 2, -10, 10);
      const target = new T.WebGLRenderTarget(Math.ceil(width), Math.ceil(height), { depthBuffer: false });
      this.passes.push({ scene, camera, target, mat }); this.materials.push(mat); texture = target.texture;
    }
    if (info.frames.length) {
      const mat = material(vertex, `precision highp float; varying vec2 v_Uv; uniform sampler2D g_Texture0; uniform vec4 u_Frame; uniform vec4 u_FrameAxes; void main(){gl_FragColor=texture2D(g_Texture0,u_Frame.xy+v_Uv.x*u_FrameAxes.xy+v_Uv.y*u_FrameAxes.zw);}`, { g_ModelViewProjectionMatrix: { value: new T.Matrix4() }, g_Texture0: { value: texture }, u_Frame: { value: new T.Vector4() }, u_FrameAxes: { value: new T.Vector4() }, g_Time: { value: 0 } });
      mat.blending = T.NoBlending;
      const mesh = new T.Mesh(geometry, mat); mesh.frustumCulled = false; bindMatrix(mesh, mat);
      const scene = new T.Scene(); scene.add(mesh);
      const camera = new T.OrthographicCamera(-width / 2, width / 2, -height / 2, height / 2, -10, 10);
      const target = new T.WebGLRenderTarget(Math.ceil(width), Math.ceil(height), { depthBuffer: false });
      this.passes.push({ scene, camera, target, mat }); this.materials.push(mat); this.animations.push({ mat, frames: info.frames }); texture = target.texture;
    }
    const sourceTexture = texture;
    const scriptUniforms: Record<string, T.IUniform>[] = [];
    this.scriptUniforms.set(layer.id, scriptUniforms);
    const plan = sceneTargetPlan(layer.passes, layer.size);
    const targets = plan.slots.map(s => new T.WebGLRenderTarget(s.width, s.height, { depthBuffer: false, minFilter: T.LinearFilter, magFilter: T.LinearFilter }));
    const outputs: T.Texture[] = [];
    for (const [passIndex, pass] of layer.passes.entries()) {
      const uniforms: Record<string, T.IUniform> = {
        g_Time: { value: 0 }, g_Frametime: { value: 0 }, g_Daytime: { value: 0 },
        g_ModelViewProjectionMatrix: { value: new T.Matrix4() },
        g_EffectTextureProjectionMatrix: { value: new T.Matrix4() },
        g_EffectTextureProjectionMatrixInverse: { value: new T.Matrix4() },
        g_PointerPosition: { value: new T.Vector2(.5, .5) },
        g_PointerPositionLast: { value: new T.Vector2(.5, .5) },
        g_TexelSize: { value: new T.Vector2() }, g_TexelSizeHalf: { value: new T.Vector2() },
        g_Screen: { value: new T.Vector3() },
      };
      for (const [name, value] of Object.entries(pass.uniforms)) uniforms[name] = { value };
      scriptUniforms.push(Object.fromEntries((pass.scripts || []).map(s => [s.property, uniforms[s.property]])));
      for (let i = 0; i < Math.max(4, pass.textures.length); i++) {
        const source = (pass.inputs ?? { 0: passIndex - 1 })[i];
        const tex = source === -1 ? sourceTexture : source !== undefined ? outputs[source] : this.textures.get(pass.textures[i] || "") || texture;
        if (pass.repeats.includes(i)) { tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.needsUpdate = true; }
        uniforms[`g_Texture${i}`] = { value: tex };
        const image = tex.image as { width: number; height: number };
        const size = [image.width, image.height];
        uniforms[`g_Texture${i}Resolution`] = { value: new T.Vector4(size[0], size[1], size[0], size[1]) };
      }
      const mat = material(pass.vertex, pass.fragment, uniforms); mat.blending = T.NoBlending; mat.transparent = false;
      const mesh = new T.Mesh(geometry, mat); mesh.frustumCulled = false; bindMatrix(mesh, mat);
      const scene = new T.Scene(); scene.add(mesh);
      // Render targets retain the source's top-left UV convention across every effect pass.
      const camera = new T.OrthographicCamera(-width / 2, width / 2, -height / 2, height / 2, -10, 10);
      const target = targets[plan.assignments[passIndex]];
      this.passes.push({ scene, camera, target, mat }); this.materials.push(mat); texture = target.texture;
      outputs.push(texture);
    }
    const reflectiveFragment = layer.reflection ? fragment.replace("void main()", `uniform sampler2D u_Normal; uniform sampler2D u_Reflection; uniform vec4 u_Reflectivity; uniform vec2 u_Tangent; uniform float u_MipLevels;\nvoid main()`).replace("if(u_BlendMode==6.0", `
vec2 n=texture2D(u_Normal,v_Uv).xy*2.0-1.0;
vec3 normal=normalize(vec3(n,sqrt(clamp(1.0-dot(n,n),0.0,1.0))));
float fresnel=max(0.001,normal.z);
vec2 direction=length(n)>0.00001?normalize(n):vec2(0.0);
direction*=vec2(0.15,0.15*u_RenderSize.x/u_RenderSize.y);
vec2 offset=(u_Tangent*direction.x+vec2(-u_Tangent.y,u_Tangent.x)*direction.y)*fresnel;
vec3 reflected=textureLod(u_Reflection,gl_FragCoord.xy/u_RenderSize+offset,u_Reflectivity.x*u_MipLevels).rgb;
reflected=pow(max(vec3(0.001),reflected*(1.0-fresnel)*u_Reflectivity.z),vec3(2.0-u_Reflectivity.y));
gl_FragColor.rgb+=clamp(reflected,0.0,1.0);
if(u_BlendMode==6.0`) : fragment;
    const mat = material(vertex, reflectiveFragment, { g_ModelViewProjectionMatrix: { value: new T.Matrix4() }, g_Texture0: { value: texture }, u_Color: { value: new T.Vector4(layer.color[0], layer.color[1], layer.color[2], layer.alpha) }, u_BlendMode: { value: layer.colorBlendMode }, u_Background: { value: this.background }, u_RenderSize: { value: new T.Vector2() }, ...(layer.reflection ? { u_Normal: { value: this.textures.get(layer.reflection.normal) }, u_Reflection: { value: this.reflectionBuffer!.target.texture }, u_Reflectivity: { value: new T.Vector4(layer.reflection.roughness, layer.reflection.metallic, layer.reflection.reflectivity, 0) }, u_Tangent: { value: new T.Vector2(Math.cos(layer.angle), Math.sin(layer.angle)) }, u_MipLevels: { value: 0 } } : {}) });
    for (const [i, clip] of (layer.mesh?.clips || []).entries()) {
      const declaration = `varying vec2 v_ClipUv${i}; varying float v_Clipped${i};\n`;
      mat.vertexShader = mat.vertexShader.replace('void main()', `${declaration}attribute float a_Clipped${i}; uniform mat4 u_ClipMatrix${i}; uniform vec2 u_ClipSize${i};\nvoid main()`)
        .replace('v_Uv=a_TexCoord;', `v_Uv=a_TexCoord;v_Clipped${i}=a_Clipped${i};v_ClipUv${i}=(u_ClipMatrix${i}*vec4(a_Position,1.0)).xy/u_ClipSize${i}*vec2(1.0,-1.0)+0.5;`);
      mat.fragmentShader = mat.fragmentShader.replace('void main()', `${declaration}uniform sampler2D u_ClipTexture${i};\nvoid main()`)
        .replace('gl_FragColor.a*=v_Opacity;', `gl_FragColor.a*=v_Opacity;if(v_Clipped${i}>0.5){vec2 p=v_ClipUv${i};gl_FragColor.a*=texture2D(u_ClipTexture${i},p).r*step(0.0,p.x)*step(0.0,p.y)*step(p.x,1.0)*step(p.y,1.0);}`);
      mat.uniforms[`u_ClipMatrix${i}`] = { value: new T.Matrix4() };
      mat.uniforms[`u_ClipSize${i}`] = { value: new T.Vector2(...layer.size) };
      mat.uniforms[`u_ClipTexture${i}`] = { value: this.textures.get(clip.texture) };
    }
    if ([6, 14].includes(layer.colorBlendMode)) mat.blending = T.NoBlending;
    if (layer.blending === "additive" || layer.colorBlendMode === 9) mat.blending = T.AdditiveBlending;
    if (layer.colorBlendMode === 7 || layer.colorBlendMode === 2) {
      mat.blending = T.CustomBlending;
      mat.blendSrc = layer.colorBlendMode === 7 ? T.OneFactor : T.ZeroFactor;
      mat.blendDst = layer.colorBlendMode === 7 ? T.OneMinusSrcColorFactor : T.SrcColorFactor;
      mat.blendSrcAlpha = T.OneFactor; mat.blendDstAlpha = T.OneMinusSrcAlphaFactor;
    }
    let finalGeometry: T.BufferGeometry = geometry;
    if (layer.mesh) {
      finalGeometry = new T.BufferGeometry();
      let positions: T.BufferAttribute = new T.Float32BufferAttribute(layer.mesh.positions, 3);
      let opacities: T.BufferAttribute = new T.Float32BufferAttribute(new Float32Array(layer.mesh.positions.length/3).fill(1),1);
      if (layer.mesh.bones) {
        const animation = new SceneMeshAnimator(layer.mesh);
        positions = new T.BufferAttribute(animation.positions, 3).setUsage(T.DynamicDrawUsage);
        opacities = new T.BufferAttribute(animation.opacities, 1).setUsage(T.DynamicDrawUsage);
        this.skins.push({ id: layer.id, animation, positions, opacities });
      }
      finalGeometry.setAttribute("a_Position", positions);
      finalGeometry.setAttribute("a_Opacity", opacities);
      finalGeometry.setAttribute("a_TexCoord", new T.Float32BufferAttribute(layer.mesh.uvs, 2));
      finalGeometry.setIndex(layer.mesh.indices); this.geometries.push(finalGeometry);
      for (const [i,clip] of (layer.mesh.clips || []).entries()) {
        const flags = new Float32Array(layer.mesh.positions.length / 3);
        for (const vertex of clip.vertices) flags[vertex] = 1;
        finalGeometry.setAttribute(`a_Clipped${i}`, new T.BufferAttribute(flags,1));
      }
    }
    const mesh = new T.Mesh(finalGeometry, mat); mesh.position.set(layer.origin[0], layer.origin[1], 0); mesh.rotation.z = layer.angle; mesh.scale.set(layer.scale[0], layer.scale[1], 1); mesh.renderOrder = order; mesh.frustumCulled = false;
    if (layer.group) finalGeometry.setDrawRange(0,0);
    bindMatrix(mesh, mat); this.materials.push(mat); this.scene.add(mesh);
    this.effectLayers.push({ mesh, size: layer.size, materials: this.passes.slice(firstPass).map(p => p.mat).filter(m => m.uniforms.g_EffectTextureProjectionMatrix) });
    if (capture || layer.reflection || [6, 14].includes(layer.colorBlendMode)) {
      const before = mesh.onBeforeRender, passes = capture ? this.passes.slice(firstPass) : [];
      for (const pass of passes) pass.deferred = true;
      mesh.onBeforeRender = (...args) => {
        this.renderer.copyFramebufferToTexture(this.background!);
        const target = this.renderer.getRenderTarget();
        if (layer.reflection) {
          const buffer = this.reflectionBuffer!;
          this.renderer.setRenderTarget(buffer.target); this.renderer.render(buffer.scene, buffer.camera);
          mat.uniforms.u_MipLevels.value = Math.floor(Math.log2(Math.max(buffer.target.width, buffer.target.height)));
        }
        for (const pass of passes) {
          const projection = pass.mat.uniforms.u_CaptureProjection;
          if (projection) (projection.value as T.Matrix4).multiplyMatrices(args[2].projectionMatrix, args[2].matrixWorldInverse).multiply(mesh.matrixWorld);
          pass.mat.uniforms.g_Time.value = this.time; this.renderer.setRenderTarget(pass.target); this.renderer.render(pass.scene, pass.camera);
        }
        this.renderer.setRenderTarget(target);
        mat.uniforms.u_RenderSize.value.set(this.background!.image.width, this.background!.image.height);
        before.apply(mesh, args);
      };
    }
    const transform = { layer, mesh, origin: sceneLayerOrigin(this.data, layer.origin, layer.parallax), depth: layer.parallax };
    const [alignX, alignY] = sceneAlignmentOffset(layer.alignment, layer.size), c = Math.cos(layer.angle), s = Math.sin(layer.angle);
    transform.origin[0] += c * alignX * layer.scale[0] - s * alignY * layer.scale[1];
    transform.origin[1] += s * alignX * layer.scale[0] + c * alignY * layer.scale[1];
    mesh.visible = layer.visible !== false;
    this.transforms.push(transform);
    this.scriptLayers.set(layer.id, transform);
  }
  private scriptBonePoses() {
    return this.skins.map(s => {
      const mesh = this.scriptLayers.get(s.id)!.mesh; mesh.updateMatrixWorld();
      return { id: s.id, world: mesh.matrixWorld.toArray(), local: s.animation.localTransforms() };
    });
  }
  private updatePropertyScripts(dt: number) {
    if (!this.propertyScripts) return;
    this.flushCursorMove();
    const bones = this.scriptBonePoses();
    const frame = this.propertyScripts.update(this.time, dt, this.spectrum, Date.now(), { bones, sounds: this.audio?.soundStates(), cursor: this.cursorWorld(), events: this.cursorEvents.splice(0) });
    this.scriptWarnings=frame.warnings;
    if (this.audio) for (const command of frame.soundCommands) this.audio.command(command);
    else {
      if (this.pendingSoundCommands.length + frame.soundCommands.length > 64) throw new Error("Pending scene sounds exceed limit");
      this.pendingSoundCommands.push(...frame.soundCommands);
    }
    for (const [order, state] of frame.layers.entries()) {
      this.scriptStates.set(state.id, state);
      let target = this.scriptLayers.get(state.id);
      if (!target) {
        const template = this.data.scriptTemplates?.[state.template!];
        if (!template) throw new Error("SceneScript template is unavailable");
        const plan = sceneTargetPlan(template.passes, template.size);
        this.dynamicPixels += plan.pixels + template.size[0] * template.size[1];
        if (this.dynamicPixels > 16 * 1024 * 1024 || this.passes.length + template.passes.length > 768) throw new Error("SceneScript render allocation exceeds limit");
        this.addLayer({ ...template, id: state.id }, order);
        target = this.scriptLayers.get(state.id)!;
      }
      const { layer, mesh } = target;
      if (Object.keys(state.boneWrites || {}).length) {
        const skin = this.skins.find(s => s.id === state.id);
        if (!skin) throw new Error("Missing scripted skeleton");
        skin.animation.applyLocalTransforms(state.boneWrites!); skin.positions.needsUpdate = true;
      }
      mesh.visible = state.visible;
      mesh.renderOrder = order;
      mesh.rotation.z = state.angles[2] * Math.PI / 180;
      mesh.scale.set(state.scale[0], state.scale[1], 1);
      const mat = mesh.material as T.RawShaderMaterial;
      for (const [pass, values] of (state.shaderValues || []).entries()) for (const [name, value] of Object.entries(values)) {
        const uniform = this.scriptUniforms.get(state.id)?.[pass]?.[name];
        if (!uniform) throw new Error("SceneScript shader target is unavailable");
        uniform.value = value;
      }
      mat.uniforms.u_Color.value.set(...state.color, state.alpha);
      mat.uniforms.u_Tangent?.value.set(Math.cos(mesh.rotation.z), Math.sin(mesh.rotation.z));
      let [x, y] = sceneAlignmentOffset(state.alignment, layer.size);
      x *= state.scale[0]; y *= state.scale[1];
      const c = Math.cos(mesh.rotation.z), s = Math.sin(mesh.rotation.z);
      const origin = sceneLayerOrigin(this.data, state.origin, state.parallaxDepth);
      origin[0] += x * c - y * s; origin[1] += x * s + y * c;
      target.origin.splice(0, 3, ...origin); target.depth = state.parallaxDepth;
    }
    this.particles.forEach((p, i) => { p.mesh.renderOrder = frame.layers.length + i; });
    this.canvas.dataset.scriptLayerCount = String(frame.layers.length);
    this.audioRequired ||= frame.audio;
  }
  setAudio(audio: WallpaperAudio) { this.audio = audio; for (const command of this.pendingSoundCommands.splice(0)) audio.command(command); }
  setPaused(paused: boolean) {
    if (paused) this.pointerRelease();
    this.paused = paused; this.last = 0;
    for (const video of this.videos) { if (paused || document.hidden) video.pause(); else void video.play().catch(e => this.onError(`Scene video playback failed: ${e.message}`)); }
    this.schedule();
  }
  private schedule() { if (this.ready && !this.frame && !this.disposed && !document.hidden && (!this.paused || this.dirty)) this.frame = requestAnimationFrame(this.tick); }
  private tick = (time: number) => {
    this.frame = 0;
    if (this.disposed || document.hidden) return;
    try { const dt = this.paused || !this.last ? 0 : Math.min(.05, (time - this.last) / 1000); this.last = time; this.draw(dt); this.schedule(); }
    catch (e) { this.paused = true; this.onError((e as Error).message); }
  };
  private draw(dt: number) {
    this.time += dt;
    this.spectrum = this.audio?.spectrum() || this.spectrum;
    for (const skin of this.skins) if (skin.animation.update(this.time)) { skin.positions.needsUpdate = true; skin.opacities.needsUpdate = true; }
    if (this.propertyScripts && this.skins.length) this.updateLayerTransforms(dt);
    this.updatePropertyScripts(dt);
    for (const skin of this.skins) {
      const { layer, mesh } = this.scriptLayers.get(skin.id)!;
      for (let i=0; i<(layer.mesh?.clips?.length || 0); i++) (mesh.material as T.RawShaderMaterial).uniforms[`u_ClipMatrix${i}`].value.copy(skin.animation.clippingMatrix(i));
    }
    for (const pass of this.passes) for (const [name, uniform] of Object.entries(pass.mat.uniforms)) {
      if (!name.startsWith("g_AudioSpectrum")) continue;
      const value = audioUniformSpectrum(name, this.spectrum);
      if (value) { uniform.value = value; this.audioRequired = true; }
    }
    const audioWarning = "Audio-reactive effects need wallpaper audio or an explicitly shared system-audio source";
    const warnings = (this.data.warnings || []).filter(w => w !== audioWarning);
    warnings.push(...this.scriptWarnings);
    if (this.audioRequired && !this.audio?.hasSource) warnings.push(audioWarning);
    if (this.audio?.state.error) warnings.push(this.audio.state.error);
    this.canvas.dataset.audioPlayback = this.audio?.state.error ? "error" : this.audio?.state.blocked ? "blocked" : this.audio?.hasSource ? "ready" : "none";
    const warningJson = JSON.stringify(warnings);
    if (this.canvas.dataset.compatibilityWarnings !== warningJson) this.canvas.dataset.compatibilityWarnings = warningJson;
    const textDeadline = performance.now() + 8;
    for (const text of this.textLayers) text.update(this.time, Date.now(), Math.max(0, textDeadline - performance.now()));
    const dpr = window.devicePixelRatio || 1, fit = this.canvas.style.objectFit;
    if (this.resizeDirty || this.dpr !== dpr || this.fit !== fit) {
      const { width: w, height: h } = sceneOutputSize(this.data, this.canvas.getBoundingClientRect(), dpr, fit, this.renderer.capabilities.maxTextureSize);
      if (this.canvas.width !== w || this.canvas.height !== h) { this.renderer.setSize(w, h, false); this.composer?.setSize(w, h); }
      this.reflectionBuffer?.target.setSize(w, h);
      if (this.background && (this.background.image.width !== w || this.background.image.height !== h)) {
        this.background.dispose(); this.background.image.width = w; this.background.image.height = h; this.background.needsUpdate = true;
      }
      this.resizeDirty = false; this.dpr = dpr; this.fit = fit;
      this.canvas.dataset.renderResolution = `${w}x${h}`;
    }
    this.updateLayerTransforms(this.propertyScripts && this.skins.length ? 0 : dt);
    this.camera.updateMatrixWorld();
    const now = new Date();
    const daytime = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
    for (const layer of this.effectLayers) {
      layer.mesh.updateMatrixWorld();
      for (const mat of layer.materials) {
        const u = mat.uniforms;
        const projection = u.g_EffectTextureProjectionMatrix.value as T.Matrix4;
        projection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(layer.mesh.matrixWorld).scale(new T.Vector3(layer.size[0] / 2, layer.size[1] / 2, 1));
        u.g_EffectTextureProjectionMatrixInverse.value.copy(projection).invert();
        u.g_PointerPosition.value.set(this.pointer.x + .5, .5 - this.pointer.y);
        u.g_PointerPositionLast.value.set(this.lastPointer.x + .5, .5 - this.lastPointer.y);
        u.g_Frametime.value = dt; u.g_Daytime.value = daytime;
        u.g_TexelSize.value.set(1 / this.canvas.width, 1 / this.canvas.height);
        u.g_TexelSizeHalf.value.set(.5 / this.canvas.width, .5 / this.canvas.height);
        u.g_Screen.value.set(this.canvas.width, this.canvas.height, this.canvas.width / this.canvas.height);
      }
    }
    this.lastPointer.copy(this.pointer);
    for (const animation of this.animations) {
      const total = animation.frames.reduce((n, f) => n + f.duration, 0); let time = this.time % total;
      const frame = animation.frames.find(f => { time -= f.duration; return time < 0; }) || animation.frames[0];
      animation.mat.uniforms.u_Frame.value.set(frame.x, frame.y, frame.width, frame.height);
      animation.mat.uniforms.u_FrameAxes.value.fromArray(frame.axes || [frame.width, 0, 0, frame.height]);
    }
    this.renderer.setClearColor(0, 0);
    for (const pass of this.passes) { if (pass.deferred) continue; pass.mat.uniforms.g_Time.value = this.time; this.renderer.setRenderTarget(pass.target); this.renderer.render(pass.scene, pass.camera); }
    for (const p of this.particles) { p.controlPoint.set((this.pointer.x + .5) * this.data.width - p.mesh.position.x, (this.pointer.y + .5) * this.data.height - p.mesh.position.y); p.step(dt); p.upload(); }
    this.renderer.setRenderTarget(null);
    if (this.composer) this.composer.render(dt); else this.renderer.render(this.scene, this.camera);
    this.dirty = false;
    this.canvas.dataset.sceneTime = this.time.toFixed(3);
  }
  private updateLayerTransforms(dt: number) {
    const effects = this.data.cameraEffects;
    this.smoothPointer.lerp(this.pointer, 1 - Math.exp(-dt / Math.max(.01, effects.delay)));
    const shakeX = effects.shake ? this.noise(this.time * effects.speed, 0, effects.roughness) * effects.amplitude * 10 : 0;
    const shakeY = effects.shake ? this.noise(0, this.time * effects.speed, effects.roughness + 11) * effects.amplitude * 10 : 0;
    for (const { mesh, origin, depth } of this.transforms) {
      const factor = effects.parallax ? effects.amount * effects.mouse * .05 : 0;
      mesh.position.set(origin[0] + shakeX + this.smoothPointer.x * this.data.width * factor * depth[0], origin[1] + shakeY + this.smoothPointer.y * this.data.height * factor * depth[1], 0);
    }
    if (this.data.layers.some(l => l.parent !== undefined)) {
      const locals = [...this.scriptLayers.values()].map(({ layer }) => {
        const state = this.scriptStates.get(layer.id);
        return state ? { ...layer, origin: state.origin, angle: state.angles[2] * Math.PI / 180, scale: state.scale, visible: state.visible, parallax: state.parallaxDepth, alignment: state.alignment } : layer;
      });
      const worlds = sceneWorldTransforms(locals, (id, name) => {
        const skin = this.skins.find(s => s.id === id);
        if (!skin) throw new Error("Missing attachment skeleton");
        return skin.animation.attachment(name);
      });
      for (const layer of locals) {
        const mesh = this.scriptLayers.get(layer.id)!.mesh, world = worlds.get(layer.id)!;
        const [a, b, c, d, x, y] = world.matrix, depth = world.parallax;
        const origin = sceneLayerOrigin(this.data, [x, y, 0], depth);
        const [dx, dy] = sceneAlignmentOffset(layer.alignment, layer.size);
        const factor = effects.parallax ? effects.amount * effects.mouse * .05 : 0;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.set(a, c, 0, origin[0] + a * dx + c * dy + shakeX + this.smoothPointer.x * this.data.width * factor * depth[0], b, d, 0, origin[1] + b * dx + d * dy + shakeY + this.smoothPointer.y * this.data.height * factor * depth[1], 0, 0, 1, 0, 0, 0, 0, 1);
        mesh.matrixWorldNeedsUpdate = true; mesh.visible = world.visible;
        const tangent = (mesh.material as T.RawShaderMaterial).uniforms.u_Tangent;
        if (tangent) tangent.value.set(a, b).normalize();
      }
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; cancelAnimationFrame(this.frame); this.observer.disconnect(); this.styleObserver.disconnect();
    this.canvas.removeEventListener("webglcontextlost", this.contextLost); document.removeEventListener("visibilitychange", this.visibility);
    window.removeEventListener("pointermove", this.pointerMove);
    window.removeEventListener("pointerdown", this.pointerDown);
    window.removeEventListener("pointerup", this.pointerUp);
    window.removeEventListener("pointercancel", this.pointerUp);
    window.removeEventListener("blur", this.pointerRelease);
    window.removeEventListener("resize", this.resize);
    this.bloom?.dispose(); this.output?.dispose(); this.composer?.dispose();
    this.background?.dispose();
    this.reflectionBuffer?.target.dispose();
    for (const p of this.particles) p.dispose(); for (const target of new Set(this.passes.map(p => p.target))) target.dispose();
    for (const m of this.materials) m.dispose(); for (const g of this.geometries) g.dispose();
    for (const video of this.videos) { video.pause(); video.removeAttribute("src"); video.load(); }
    for (const text of this.textLayers) text.dispose();
    this.propertyScripts?.dispose();
    for (const skin of this.skins) skin.animation.dispose();
    for (const font of this.fonts) document.fonts.delete(font);
    for (const t of this.textures.values()) { const image = t.image as { close?: () => void } | undefined; image?.close?.(); t.dispose(); }
    this.renderer.dispose(); this.renderer.forceContextLoss();
  }
}
