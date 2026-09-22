import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { readWallpaperPackage, resourceName } from "./wallpaper-binary";
import { decodeWallpaperTexture } from "./wallpaper-texture";
import { browserEffectGlsl, browserFragmentGlsl, sceneAudioUniforms } from "./wallpaper-glsl";
import { sceneTargetPlan } from "./wallpaper-scene-targets";
import { decodeSceneMesh } from "./wallpaper-mesh";
import { sceneWorldTransforms } from "./wallpaper-scene-parent";
import { parseSceneTimeline } from "./wallpaper-timeline";
import { readScenePropertyOverrides, resolveSceneProject, safeWallpaperFile } from "./wallpaper-store";
import type { BrowserScene, SceneLayer, ScenePass, SceneParticles, ScenePropertyScript, SceneValues } from "./wallpaper-scene-types";

type Compiled = { manifest: BrowserScene; assets: Map<string, Buffer> };
type CacheEntry = { time: number; pending: boolean; promise: Promise<Compiled> };
const state = globalThis as typeof globalThis & { __ompBrowserScenes?: Map<string, CacheEntry> };
const cache = state.__ompBrowserScenes ??= new Map();
const obj = (v: unknown): SceneValues => v && typeof v === "object" && !Array.isArray(v) ? v as SceneValues : {};
const array = (v: unknown): SceneValues[] => Array.isArray(v) ? v.map(obj) : [];
export function sceneVector(v: unknown, fallback: number[]) {
  const a = typeof v === "string" ? v.trim().split(/\s+/).map(Number) : Array.isArray(v) ? v.map(Number) : [];
  return fallback.map((n, i) => Number.isFinite(a[i]) ? a[i] : n);
}
function num(v: unknown, fallback: number) { return typeof v === "number" && Number.isFinite(v) ? v : fallback; }
async function boundedRead(file: string, max: number) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > max) throw new Error("Scene resource exceeds size limit");
  return fs.readFile(file);
}
function builtinRoots(project: string) {
  const roots = process.env.OMP_WEB_WALLPAPER_ASSETS?.split(path.delimiter).filter(Boolean) ?? [];
  for (let cursor = path.dirname(project); path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
    if (path.basename(cursor).toLowerCase() === "steamapps") { roots.push(path.join(cursor, "common/wallpaper_engine/assets")); break; }
  }
  if (process.env.OMP_WEB_WALLPAPER_ENGINE) roots.push(path.join(path.dirname(process.env.OMP_WEB_WALLPAPER_ENGINE), "assets"));
  if (process.platform === "win32") roots.push(path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam/steamapps/common/wallpaper_engine/assets"));
  return [...new Set(roots)];
}
export async function compileBrowserScene(id: string): Promise<Compiled> {
  const { project, file, entryFile, metadata } = await resolveSceneProject(id);
  const propertyDefinitions = obj(obj(metadata.general).properties);
  const overrides = Object.fromEntries(Object.entries(await readScenePropertyOverrides(id)).filter(([key, value]) =>
    Object.hasOwn(propertyDefinitions, key) && typeof value === typeof obj(propertyDefinitions[key]).value));
  const bytes = await boundedRead(file, 512 * 1024 * 1024);
  const resources = file.endsWith(".pkg") ? readWallpaperPackage(bytes) : new Map<string, Buffer>([[entryFile, bytes]]);
  const roots = [path.dirname(project), ...builtinRoots(project)];
  async function read(name: string, limit = name.endsWith(".tex") ? 512 * 1024 * 1024 : 128 * 1024 * 1024) {
    resourceName(name);
    const packed = resources.get(name);
    if (packed) { if (packed.length > limit) throw new Error("Scene resource too large"); return packed; }
    for (const root of roots) {
      try { return await boundedRead(await safeWallpaperFile(root, name), limit); }
      catch (e) { if (!/ENOENT|not a directory/i.test(String(e))) throw e; }
    }
    throw new Error(`Missing scene resource: ${name}. Copy the required Wallpaper Engine assets to this host and set OMP_WEB_WALLPAPER_ASSETS.`);
  }
  async function json(name: string) {
    const b = await read(name); if (b.length > 4 * 1024 * 1024) throw new Error("Scene JSON too large");
    return obj(JSON.parse(b.toString("utf8"), (_key, value) => {
      // Exported user controls wrap their authored value; scripts/animations
      // must retain their wrappers so they cannot silently become static.
      const property = obj(value);
      if (typeof property.user === "string" && Object.hasOwn(property, "value") && Object.hasOwn(overrides, property.user) && typeof overrides[property.user] === typeof property.value) {
        property.value = overrides[property.user];
      }
      return Object.hasOwn(property, "value") && Object.hasOwn(property, "user") && Object.keys(property).every(k => k === "user" || k === "value") ? property.value : value;
    }));
  }
  const scene = await json(entryFile), general = obj(scene.general), projection = obj(general.orthogonalprojection);
  const width = num(projection.width, 0), height = num(projection.height, 0);
  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw new Error("Only orthographic 2D scenes are supported by the browser renderer");
  const manifest: BrowserScene = { version: 1, width, height, clearColor: sceneVector(general.clearcolor, [0, 0, 0]), layers: [], particles: [], textures: [], cameraEffects: { parallax: general.cameraparallax === true, amount: num(general.cameraparallaxamount, 1), delay: num(general.cameraparallaxdelay, .5), mouse: num(general.cameraparallaxmouseinfluence, 1), shake: general.camerashake === true, amplitude: num(general.camerashakeamplitude, .5), speed: num(general.camerashakespeed, 3), roughness: num(general.camerashakeroughness, 1) }, bloom: general.bloom ? { strength: Math.max(0, Math.min(5, num(general.bloomstrength, .2))), threshold: Math.max(0, Math.min(1, num(general.bloomthreshold, .8))) } : undefined };
  const assets = new Map<string, Buffer>(), textures = new Map<string, string>();
  manifest.userProperties = Object.fromEntries(Object.entries(obj(obj(metadata.general).properties)).flatMap(([key, property]) => {
    const value = obj(property).value;
    return typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 8192 ? [[key, value]] : [];
  }));
  Object.assign(manifest.userProperties, overrides);
  let assetBytes = 0, videoBytes = 0, totalPixels = 0, passCount = 0, passPixels = 0;
  let audioBytes = 0;
  async function soundAsset(name: string) {
    if (!/\.(mp3|flac|ogg|wav|m4a|aac)$/i.test(name)) throw new Error("Unsupported scene audio format");
    const bytes = await read(name, 256 * 1024 * 1024), head = bytes.toString("ascii", 0, 4);
    const mimeType = head.startsWith("ID3") || (bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) ? (/\.aac$/i.test(name) ? "audio/aac" : "audio/mpeg")
      : head === "fLaC" ? "audio/flac" : head === "OggS" ? "audio/ogg"
      : head === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE" ? "audio/wav"
      : bytes.toString("ascii", 4, 8) === "ftyp" ? "audio/mp4" : undefined;
    if (!mimeType) throw new Error("Invalid scene audio signature");
    const key = createHash("sha256").update(bytes).digest("hex");
    if (!assets.has(key)) {
      audioBytes += bytes.length;
      if (audioBytes > 256 * 1024 * 1024) throw new Error("Scene audio budget exceeded");
      assets.set(key, bytes);
    }
    return { key, url: `/api/wallpapers/${id}/scene-assets/${key}`, mimeType };
  }
  async function texture(name: string) {
    if (name === "_rt_FullFrameBuffer") return "@scene";
    if (textures.has(name)) return textures.get(name)!;
    if (textures.size >= 128) throw new Error("Too many scene textures");
    const data = await decodeWallpaperTexture(await read(`materials/${name}.tex`)).catch(e => { throw new Error(`${e.message} (texture: ${name})`); });
    assetBytes += data.png.length; totalPixels += data.width * data.height;
    videoBytes += data.video?.length || 0;
    if (videoBytes > 512 * 1024 * 1024) throw new Error("Scene video asset budget exceeded");
    if (assetBytes > 192 * 1024 * 1024 || totalPixels > 64 * 1024 * 1024) throw new Error("Scene texture budget exceeded");
    const payload = data.video || data.png;
    const key = createHash("sha256").update(payload).digest("hex");
    textures.set(name, key); assets.set(key, payload);
    manifest.textures.push({ key, url: `/api/wallpapers/${id}/scene-assets/${key}`, mimeType: data.video ? "video/mp4" : "image/png", width: data.width, height: data.height, format: data.format, frames: data.frames });
    return key;
  }
  async function font(name: string) {
    const system = new Map([["systemfont_sansserif", "sans-serif"], ["systemfont_serif", "serif"], ["systemfont_monospace", "monospace"], ["systemfont_arial", "Arial, sans-serif"]]).get(name);
    if (system) return `@system:${system}`;
    if (!/^fonts\/.+\.(ttf|otf|woff2?)$/i.test(name)) throw new Error("Invalid scene font path");
    // Full CJK fonts can exceed 16 MiB; retain per-file and scene-wide bounds.
    const bytes = await read(name, 32 * 1024 * 1024);
    if (bytes.length < 12) throw new Error("Invalid scene font signature");
    const signature = bytes.toString("ascii", 0, 4);
    const mimeType = bytes.readUInt32BE(0) === 0x10000 ? "font/ttf" : ({ OTTO: "font/otf", wOFF: "font/woff", wOF2: "font/woff2" } as Record<string, string>)[signature];
    if (!mimeType) throw new Error("Invalid scene font signature");
    const key = createHash("sha256").update(bytes).digest("hex");
    manifest.fonts ??= [];
    if (!manifest.fonts.some(f => f.key === key)) {
      assetBytes += bytes.length;
      if (manifest.fonts.length >= 16 || assetBytes > 192 * 1024 * 1024) throw new Error("Scene font budget exceeded");
      assets.set(key, bytes); manifest.fonts.push({ key, mimeType, url: `/api/wallpapers/${id}/scene-assets/${key}` });
    }
    return key;
  }
  async function shader(name: string, visited = new Set<string>()): Promise<string> {
    if (visited.has(name) || visited.size > 12) throw new Error("Invalid shader include graph");
    const next = new Set(visited).add(name);
    let source = (await read(name)).toString("utf8");
    if (source.length > 128 * 1024) throw new Error("Scene shader too large");
    for (const m of source.matchAll(/^\s*#include\s+"([^"]+)"\s*$/gm)) {
      source = source.replace(m[0], await shader(`shaders/${m[1]}`, next));
      if (source.length > 512 * 1024) throw new Error("Expanded scene shader exceeds size limit");
    }
    return source;
  }
  const prelude = `precision highp float;\nprecision highp int;\n#define GLSL 1\n#define HLSL 0\n#define mul(a,b) ((b)*(a))\n#define CAST2 vec2\n#define CAST3 vec3\n#define CAST4 vec4\n#define CAST3X3 mat3\n#define CAST4X4 mat4\n#define saturate(x) clamp(x,0.0,1.0)\n#define frac fract\n#define atan2 atan\n#define texSample2D texture2D\n#define ddx dFdx\n#define ddy dFdy\n`;
  async function effectPass(material: SceneValues, override: SceneValues): Promise<ScenePass> {
    const name = String(material.shader || "");
    if (!/^(effects|workshop)\/[\w/]+$/.test(name)) throw new Error(`Invalid browser scene effect: ${name}`);
    let vertex = await shader(`shaders/${name}.vert`);
    if (/gl_Position\s*=\s*vec4\(a_Position,\s*1\.0\)/.test(vertex)) {
      if (!/uniform\s+mat4\s+g_ModelViewProjectionMatrix/.test(vertex)) vertex = "uniform mat4 g_ModelViewProjectionMatrix;\n" + vertex;
      vertex = vertex.replace(/gl_Position\s*=\s*vec4\(a_Position,\s*1\.0\)/g, "gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix)");
    }
    let fragment = await shader(`shaders/${name}.frag`);
    // Legacy exports occasionally omit a fragment input declaration even though
    // its type and producer are present in the paired vertex shader.
    for (const match of vertex.matchAll(/\bvarying\s+(\w+)\s+(\w+)\s*;/g)) {
      if (new RegExp(`\\b${match[2]}\\b`).test(fragment) && !new RegExp(`\\bvarying\\s+\\w+\\s+${match[2]}\\b`).test(fragment)) fragment = `varying ${match[1]} ${match[2]};\n` + fragment;
    }
    const source = vertex + "\n" + fragment;
    const constants = { ...obj(material.constantshadervalues), ...obj(override.constantshadervalues) };
    const combos: Record<string, number> = {};
    for (const match of source.matchAll(/\/\/\s*\[COMBO(?:_OFF)?\]\s*(\{[^\r\n]+\})/g)) {
      const meta = JSON.parse(match[1]); if (/^[A-Z0-9_]+$/.test(meta.combo)) combos[meta.combo] = num(meta.default, 0);
    }
    Object.assign(combos, obj(material.combos), obj(override.combos));
    if (name.includes("gaussian")) combos.VERTICAL ??= 0;
    const uniforms: ScenePass["uniforms"] = {}, scripts = new Map<string, ScenePropertyScript>(), refs: unknown[] = Array.isArray(material.textures) ? [...material.textures] : [];
    const audio = sceneAudioUniforms(source, combos);
    if (audio.length) {
      for (const match of audio) uniforms[match[1]] = Array(Number(match[2])).fill(0);
    }
    if (Array.isArray(override.textures)) override.textures.forEach((v, i) => { if (v !== null) refs[i] = v; });
    for (const match of source.matchAll(/uniform\s+(\w+)\s+(\w+)\s*;\s*\/\/\s*(\{[^\r\n]+\})/g)) {
      const meta = JSON.parse(match[3]), type = match[1], uniform = match[2];
      if (type === "sampler2D") {
        const index = Number(uniform.replace("g_Texture", ""));
        if (Number.isInteger(index) && index > 0 && index < 8) { if (meta.combo) combos[meta.combo] ??= refs[index] ? 1 : 0; refs[index] ??= meta.default; }
      } else {
        const rawValue = constants[meta.material] ?? meta.default;
        if (obj(rawValue).script) {
          const binding = obj(rawValue);
          if (!["float", "int", "vec2", "vec3", "vec4"].includes(type) || typeof binding.script !== "string" || binding.script.length > 128 * 1024) throw new Error(`Unsupported shader script type: ${name}.${meta.material}`);
          scripts.set(uniform, { property: uniform, source: binding.script, properties: Object.fromEntries(Object.entries(obj(binding.scriptproperties)).map(([k, v]) => [k, obj(v).value ?? v])) });
        }
        const value = obj(rawValue).value ?? rawValue;
        uniforms[uniform] = type.startsWith("vec") ? sceneVector(value, Array(Number(type.slice(3))).fill(0)) : num(value, 0);
      }
    }
    // Infer sampler combos before supplying GLSL defaults for absent flags.
    const declared = new Set(["GLSL", "HLSL", ...[...source.matchAll(/^\s*#define\s+(\w+)/gm)].map(m => m[1])]);
    for (const line of source.matchAll(/^\s*#(?:if|elif)\s+([^\r\n]+)/gm)) for (const key of line[1].match(/\b[A-Z][A-Z0-9_]*\b/g) || []) if (!declared.has(key)) combos[key] ??= 0;
    const mapped: (string | null)[] = [null];
    for (let i = 1; i < refs.length; i++) mapped[i] = typeof refs[i] === "string" && !String(refs[i]).startsWith("_rt_") ? await texture(refs[i] as string) : null;
    const defines = Object.entries(combos).map(([key, value]) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !Number.isInteger(value)) throw new Error(`Invalid shader combo: ${key}=${JSON.stringify(value)}`); return `#define ${key} ${value}\n`; }).join("");
    return { vertex: prelude + defines + browserEffectGlsl(vertex, combos), fragment: prelude + defines + browserFragmentGlsl(browserEffectGlsl(fragment, combos)), uniforms, scripts: scripts.size ? [...scripts.values()] : undefined, textures: mapped, repeats: name === "effects/waterripple" ? [2] : ["effects/pulse", "effects/clouds", "effects/lightshafts"].includes(name) ? [1] : [] };
  }
  async function particle(file: string, common: Pick<SceneParticles, "id" | "origin" | "scale" | "angle" | "parallax">, overrides: SceneValues, depth = 0): Promise<SceneParticles> {
    if (depth > 3) throw new Error("Particle child system nesting exceeds limit");
    const config = await json(file), base = array((await json(String(config.material))).passes)[0];
    if (!base || !["genericparticle", "genericropeparticle"].includes(String(base.shader))) throw new Error("Unsupported particle material");
    const known = new Set(["sphererandom", "boxrandom", "lifetimerandom", "sizerandom", "velocityrandom", "turbulentvelocityrandom", "colorrandom", "rotationrandom", "angularvelocityrandom", "alpharandom", "movement", "alphafade", "alphachange", "colorchange", "angularmovement", "turbulence", "sprite", "spritetrail", "ropetrail", "rope", "oscillateposition", "oscillatealpha", "oscillatesize", "controlpointattract", "sizechange"]);
    for (const group of ["emitter", "initializer", "operator", "renderer"]) for (const item of array(config[group])) if (!known.has(String(item.name))) throw new Error(`Unsupported particle operation: ${item.name}`);
    const children: SceneParticles[] = [];
    for (const child of array(config.children)) {
      if (![undefined, "static", "eventfollow", "eventspawn", "eventdeath"].includes(child.type as string | undefined) || children.length >= 8) throw new Error(`Unsupported particle child event: ${child.type}`);
      if (num(child.flags, 0)) throw new Error("Particle child control-point inheritance is not supported yet");
      const data = await particle(String(child.name), { ...common, id: num(child.id, 1), origin: [0, 0, 0], scale: [1, 1, 1], angle: 0, parallax: [0, 0] }, {}, depth + 1);
      data.event = { type: (child.type || "static") as NonNullable<SceneParticles["event"]>["type"], max: Math.max(1, Math.min(2000, num(child.maxcount, num(config.maxcount, 100)))), probability: Math.max(0, Math.min(1, num(child.probability, 1))), origin: sceneVector(child.origin, [0, 0, 0]), scale: sceneVector(child.scale, [1, 1, 1]), angle: sceneVector(child.angles, [0, 0, 0])[2] };
      children.push(data);
    }
    const normal = (base.textures as unknown[])?.[1];
    const refraction = obj(base.combos).REFRACT ? { texture: typeof normal === "string" ? await texture(normal) : undefined, amount: num(obj(base.constantshadervalues).ui_editor_properties_refract_amount, .05) } : undefined;
    return { ...common, texture: await texture(String((base.textures as string[])[0])), blending: String(base.blending), config, overrides, children, refraction, overbright: num(obj(base.constantshadervalues).ui_editor_properties_overbright, 1) };
  }
  async function layerEffects(effects: unknown, size: number[], initial: ScenePass[] = []) {
    const passes: ScenePass[] = [...initial];
    for (const effect of array(effects)) {
      if (effect.visible === false) continue;
      const definition = await json(String(effect.file)), overrides = array(effect.passes);
      const previous = passes.length - 1, buffers = new Map<string, number>(), fbos = array(definition.fbos);
      for (const fbo of fbos) if (!["rgba8888", "rgba_backbuffer", undefined].includes(fbo.format as string | undefined)) throw new Error(`Unsupported framebuffer format: ${fbo.format}`);
      for (const [i, pass] of array(definition.passes).entries()) for (const p of array((await json(String(pass.material))).passes)) {
        if (++passCount > 512) throw new Error("Too many scene effect passes");
        const compiled = await effectPass(p, overrides[i] || {});
        compiled.inputs = { 0: passes.length - 1 };
        for (const binding of array(pass.bind)) {
          const index = num(binding.index, -1), source = binding.name === "previous" ? previous : buffers.get(String(binding.name));
          if (!Number.isInteger(index) || index < 0 || index > 7 || source === undefined) throw new Error(`Invalid framebuffer binding: ${binding.name}`);
          compiled.inputs[index] = source;
        }
        if (pass.target) {
          const fbo = fbos.find(f => f.name === pass.target);
          if (!fbo) throw new Error(`Missing scene framebuffer: ${pass.target}`);
          compiled.scale = num(fbo.scale, 1); buffers.set(String(pass.target), passes.length);
        }
        passes.push(compiled);
      }
    }
    passPixels += sceneTargetPlan(passes, size).pixels;
    if (passPixels > 128 * 1024 * 1024) throw new Error("Scene framebuffer allocation exceeds 512 MiB");
    return passes;
  }
  const objects = array(scene.objects);
  const controlsVideos = objects.some(o => Object.values(o).some(v => typeof obj(v).script === "string" && /\bgetVideoTexture\s*\(/.test(obj(v).script as string)));
  const parentIds = new Set(objects.map(o => o.parent).filter(p => typeof p === "number"));
  if (objects.length > 256) throw new Error("Too many scene objects");
  for (const raw of objects) {
    const scripts: ScenePropertyScript[] = [];
    const timelines: NonNullable<SceneLayer["timelines"]> = [];
    const o = { ...raw };
    for (const [property, value] of Object.entries(raw)) {
      const binding = obj(value);
      if (binding.animation) {
        try { timelines.push(parseSceneTimeline(property, binding.animation, binding.value)); }
        catch {
          manifest.warnings ??= [];
          manifest.warnings.push(`Unsupported timeline binding is using its saved value: ${String(o.name || o.id)}.${property}`);
        }
        o[property] = binding.value;
      }
      if (typeof binding.script === "string" && /export\s+function\s+media\w+Changed\b/.test(binding.script)) {
        manifest.warnings ??= [];
        const warning = "System media metadata/events are unavailable; media widgets use the stopped state";
        if (!manifest.warnings.includes(warning)) manifest.warnings.push(warning);
      }
      if (property === "text" || !binding.script) continue;
      if (!["origin", "scale", "angles", "parallaxDepth", "color", "alpha", "visible"].includes(property) || typeof binding.script !== "string" || binding.script.length > 128 * 1024) throw new Error(`Unsupported scene property script: ${property}`);
      scripts.push({ property, source: binding.script, properties: Object.fromEntries(Object.entries(obj(binding.scriptproperties)).map(([k, v]) => [k, obj(v).value ?? v])) });
      o[property] = binding.value;
    }
    if ((o.visible === false || obj(o.visible).value === false) && !scripts.length && !timelines.length && !(typeof o.id === "number" && parentIds.has(o.id)) && !(controlsVideos && o.image)) continue;
    if (o.sound) {
      const files = Array.isArray(o.sound) ? o.sound : [o.sound];
      if (!files.length || files.length > 32 || (manifest.sounds?.length || 0) >= 16 || files.some(f => typeof f !== "string")) throw new Error("Invalid scene sound playlist");
      const mode = o.playbackmode || "loop";
      if (mode !== "loop" && mode !== "single" && mode !== "random") throw new Error(`Unsupported sound playback mode: ${mode}`);
      const minTime = Math.max(0, Math.min(3600, num(o.mintime, 1)));
      manifest.sounds ??= [];
      manifest.sounds.push({ id: num(o.id, 0), name: String(o.name || ""), files: await Promise.all(files.map(f => soundAsset(f as string))), volume: Math.max(0, Math.min(1, num(o.volume, 1))), mode, startSilent: o.startsilent === true, minTime, maxTime: Math.max(minTime, Math.min(3600, num(o.maxtime, 5))) });
      continue;
    }
    if (o.model || o.perspective || o.parentattachment) throw new Error(`Unsupported scene object: ${String(o.name || o.id)}`);
    if (o.parent !== undefined && !Number.isInteger(o.parent)) throw new Error("Invalid scene parent id");
    if (o.attachment !== undefined && (typeof o.attachment !== "string" || !o.attachment || o.attachment.length > 512 || o.parent === undefined)) throw new Error("Invalid scene attachment name");
    if (o.particle && o.parent !== undefined) throw new Error("Parented particle systems are not supported yet");
    if (scripts.length && o.particle) throw new Error("Particle property scripts are not supported yet");
    const common = { id: num(o.id, 0), origin: sceneVector(o.origin, [0, 0, 0]), scale: sceneVector(o.scale, [1, 1, 1]), angle: sceneVector(o.angles, [0, 0, 0])[2], parallax: sceneVector(o.parallaxDepth, [1, 1]), scripts: scripts.length ? scripts : undefined, visible: o.visible !== false, alignment: String(o.alignment || "center"), parent: o.parent as number | undefined, attachment: o.attachment as string | undefined, parallaxInherited: o.parent !== undefined && o.parallaxDepth === undefined };
    Object.assign(common, { timelines: timelines.length ? timelines : undefined, disablePropagation: o.disablepropagation === true });
    if (o.camera !== undefined) {
      if (o.camera !== "default" || o.parent !== undefined || sceneVector(o.angles, [0, 0, 0]).some(n => n !== 0) || manifest.layers.some(l => l.camera)) throw new Error("Unsupported scene camera");
      if (o.path && array((await json(String(o.path))).paths).length) throw new Error("Animated camera paths are not supported yet");
      manifest.layers.push({ ...common, group: true, solid: false, name: String(o.name || ""), size: [1, 1], color: [1, 1, 1], alpha: 1, texture: "@transparent", blending: "translucent", colorBlendMode: 0, passes: [], camera: { zoom: Math.max(.01, Math.min(100, num(o.zoom, 1))) } });
    } else if (o.text !== undefined) {
      if (manifest.layers.filter(l => l.text).length >= 16) throw new Error("Too many scene text layers");
      if (o.blockalign) throw new Error("Justified text layout is not supported yet");
      const source = obj(o.text), value = typeof o.text === "string" ? o.text : String(source.value ?? "");
      const script = typeof source.script === "string" ? source.script : undefined;
      if (value.length > 8192 || (script?.length || 0) > 128 * 1024) throw new Error("Scene text exceeds limit");
      const size = sceneVector(o.size, [512, 128]);
      if (size.some(n => n <= 0 || n > 8192)) throw new Error("Scene text dimensions exceed limit");
      const horizontal = String(o.horizontalalign || "left"), vertical = String(o.verticalalign || "top");
      if (!["left", "center", "right"].includes(horizontal) || !["top", "center", "bottom"].includes(vertical)) throw new Error("Unsupported scene text alignment");
      const properties = Object.fromEntries(Object.entries(obj(source.scriptproperties)).map(([k, v]) => [k, obj(v).value ?? v]));
      manifest.layers.push({ ...common, name: String(o.name || ""), size, color: sceneVector(o.color, [1, 1, 1]), alpha: num(o.alpha, 1), texture: `@text:${common.id}`, blending: "translucent", colorBlendMode: 0, passes: await layerEffects(o.effects, size), text: {
        value, script, properties, font: await font(String(o.font)), pointSize: Math.max(1, Math.min(1024, num(o.pointsize, 32))), padding: Math.max(0, num(o.padding, 0)),
        horizontal: horizontal as "left" | "center" | "right", vertical: vertical as "top" | "center" | "bottom", background: o.opaquebackground ? sceneVector(o.backgroundcolor, [0, 0, 0]) : undefined,
        maxWidth: o.limitwidth ? Math.max(1, Math.min(16384, num(o.maxwidth, size[0]))) : undefined,
        maxRows: o.limitrows ? Math.max(1, Math.min(256, Math.floor(num(o.maxrows, 1)))) : undefined, ellipsis: o.limituseellipsis === true,
      } });
    } else if (typeof o.image === "string" || o.shape === "quad") {
      const procedural = o.shape === "quad";
      const model = procedural ? {} : await json(String(o.image));
      if (model.mesh) throw new Error("Unsupported scene model mesh");
      const mesh = typeof model.puppet === "string" ? decodeSceneMesh(await read(model.puppet)) : undefined;
      for (const clip of mesh?.clips || []) clip.texture = await texture(clip.texture);
      if (mesh?.bones?.some(b => b.physics)) {
        manifest.warnings ??= [];
        manifest.warnings.push(`Bone spring physics is unavailable; animation and scripted transforms remain active: ${String(o.name || o.id)}`);
      }
      Object.assign(common, { solid: o.solid !== false });
      const animations = array(o.animationlayers).filter(a => a.visible !== false);
      if (animations.length) {
        if (!mesh?.bones || animations.length > 16) throw new Error("Invalid puppet animation layers");
        mesh.playbacks = animations.map(animation => {
          if (Object.values(animation).some(v => obj(v).script)) throw new Error("Puppet animation control scripts are not supported yet");
          if (!mesh.animations?.some(a => a.id === animation.animation)) throw new Error("Missing scene animation clip");
          return { id: num(animation.animation, 0), rate: num(animation.rate, 1), blend: Math.max(0, Math.min(1, num(animation.blend, 1))), additive: animation.additive === true };
        });
      }
      const materials = procedural ? [{ shader: "flat", blending: "translucent" }] : array((await json(String(model.material))).passes);
      const customBase = materials.length === 1 && /^workshop\/[\w/]+$/.test(String(materials[0].shader));
      if (materials.length !== 1 || !customBase && !["genericimage", "genericimage2", "genericimage3", "genericimage4", "passthrough", "composelayer", "flat"].includes(String(materials[0].shader))) throw new Error(`Unsupported base scene material: ${materials[0]?.shader}`);
      for (const feature of ["LIGHTING", "PBRMASKS", "SKINNING", "MORPHING", "CLIPPINGTARGET", "CLIPPINGCOMPOSE"]) if (obj(materials[0].combos)[feature]) throw new Error(`Unsupported scene material feature: ${feature}`);
      const base = materials[0], refs = base.shader === "flat" ? ["util/white"] : base.textures as string[];
      if (!Array.isArray(refs) || typeof refs[0] !== "string") throw new Error("Scene image has no texture");
      const key = procedural ? "@transparent" : await texture(refs[0]);
      const info = manifest.textures.find(t => t.key === key) || { width, height };
      const size = sceneVector(o.size, [info.width, info.height]);
      if (size.some(n => n <= 0 || n > 16384)) throw new Error("Scene layer exceeds safe dimensions");
      const basePasses = customBase ? [await effectPass(base, {})] : [];
      if (customBase && ++passCount > 512) throw new Error("Too many scene effect passes");
      const passes = await layerEffects(o.effects, size, basePasses);
      const composition = base.shader === "composelayer";
      if (composition) {
        if (o.copybackground || passes.length) throw new Error("Composition background copying and post-effects are not supported yet");
        if (manifest.layers.filter(l => l.composition).length >= 8) throw new Error("Too many composition layers");
        passPixels += width * height;
      }
      if (procedural && !passes.length) throw new Error("Procedural scene layer has no drawing effect");
      if (key === "@scene" || ("frames" in info && info.frames.length)) passPixels += Math.ceil(size[0]) * Math.ceil(size[1]);
      if (passPixels > 128 * 1024 * 1024) throw new Error("Scene framebuffer allocation exceeds 512 MiB");
      const colorBlendMode = num(o.colorBlendMode, 0);
      if (![0, 2, 6, 7, 9, 14, 21, 31].includes(colorBlendMode)) throw new Error(`Unsupported scene image blend mode: ${colorBlendMode}`);
      let reflection;
      if (obj(base.combos).REFLECTION) {
        if (base.shader !== "genericimage2") throw new Error(`Unsupported reflective material: ${base.shader}`);
        const constants = obj(base.constantshadervalues);
        if (refs[1]) reflection = { normal: await texture(refs[1]), roughness: Math.max(0, Math.min(1, num(constants.roughness, .5))), metallic: Math.max(0, Math.min(1, num(constants.metallic, .5))), reflectivity: Math.max(0, Math.min(1, num(constants.reflectivity, 1))) };
      }
      manifest.layers.push({ ...common, name: String(o.name || ""), size, color: sceneVector(o.color, [1, 1, 1]), alpha: num(o.alpha, 1), texture: composition ? "@transparent" : key, blending: String(base.blending || "translucent"), colorBlendMode, passes, reflection, mesh, composition: composition || undefined });
      // Only already-authorized image resources are available to createLayer.
      // A model template does not inherit the placed layer's tint or effects.
      if (typeof o.image === "string" && !mesh && !reflection && key !== "@scene") {
        const template: SceneLayer = { id: 0, name: o.image, origin: [0, 0, 0], scale: [1, 1, 1], angle: 0, parallax: [1, 1], size: sceneVector(model.size, [info.width, info.height]), color: [1, 1, 1], alpha: 1, texture: key, blending: String(base.blending || "translucent"), passes: basePasses, colorBlendMode: 0 };
        manifest.scriptTemplates ??= {};
        manifest.scriptTemplates[o.image] = template;
      }
    } else if (typeof o.particle === "string") {
      manifest.particles.push(await particle(o.particle, common, obj(o.instanceoverride)));
    } else if (parentIds.has(common.id) && Object.keys(o).every(k => ["id","name","origin","angles","scale","parent","attachment","visible","parallaxDepth"].includes(k))) {
      manifest.layers.push({ ...common, name: String(o.name || ""), group: true, solid: false, size: [1,1], color: [1,1,1], alpha: 1, texture: "@transparent", blending: "translucent", colorBlendMode: 0, passes: [] });
    } else throw new Error(`Unsupported scene object: ${String(o.name || o.id)}`);
  }
  if (!manifest.layers.length) throw new Error("Scene has no supported image layers");
  for (const layer of manifest.layers) if (layer.attachment && !manifest.layers.find(l => l.id === layer.parent)?.mesh?.attachments?.some(a => a.name === layer.attachment)) throw new Error(`Missing parent attachment: ${layer.attachment}`);
  sceneWorldTransforms(manifest.layers);
  if (!manifest.layers.some(l => l.scripts?.length)) delete manifest.scriptTemplates;
  return { manifest, assets };
}

export async function browserScene(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid scene identifier");
  const key = `${process.env.PI_CODING_AGENT_DIR || ""}|${process.env.OMP_WEB_WALLPAPER_ASSETS || ""}|${id}`;
  let entry = cache.get(key);
  if (entry && !entry.pending && Date.now() - entry.time > 300_000) { cache.delete(key); entry = undefined; }
  if (!entry) {
    if (cache.size >= 2) {
      const evict = [...cache].find(([, value]) => !value.pending);
      if (!evict) throw new Error("Two scenes are loading. Please retry after they finish.");
      cache.delete(evict[0]);
    }
    entry = { time: Date.now(), pending: true, promise: compileBrowserScene(id) }; cache.set(key, entry);
    const current = entry;
    void current.promise.then(() => { current.pending = false; current.time = Date.now(); }, () => { if (cache.get(key) === current) cache.delete(key); });
  }
  return entry.promise;
}
