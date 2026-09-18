import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import sharp from "sharp";
import { createHash } from "node:crypto";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { readWallpaperPackage, resourceName } = await jiti.import("./wallpaper-binary.ts");
const { decodeWallpaperTexture } = await jiti.import("./wallpaper-texture.ts");
const { compileBrowserScene } = await jiti.import("./wallpaper-browser-scene.ts");
const store = await jiti.import("./wallpaper-store.ts");
const { browserEffectGlsl, sceneAudioUniforms } = await jiti.import("./wallpaper-glsl.ts");
test('inactive native audio branches do not produce false missing-audio warnings',()=>{
  const declaration='uniform float g_AudioSpectrum16Left[16];';
  assert.equal(sceneAudioUniforms('#if AUDIOPROCESSING\n#if MASK\n'+declaration+'\n#endif\n#endif',{AUDIOPROCESSING:0}).length,0);
  assert.equal(sceneAudioUniforms(declaration,{}).length,1);
  assert.equal(sceneAudioUniforms('#if AUDIOPROCESSING\n#else\n'+declaration+'\n#endif',{AUDIOPROCESSING:0}).length,1);
});
test("GLSL compatibility promotes scalar math without changing array indices, macros or metadata", () => {
  assert.equal(browserEffectGlsl('#if MODE == 1\nuniform vec3 a[16]; // {"default":1}\nvoid main(){a[0]=vec3(1,2,3)*2-1;}\n#endif'), '#if MODE == 1\nuniform vec3 a[16]; // {"default":1}\nvoid main(){a[0]=vec3(1.0,2.0,3.0)*2.0-1.0;}\n#endif');
  assert.equal(browserEffectGlsl('float a = 0.5f;'), 'float a = 0.5;');
  assert.equal(browserEffectGlsl('max(0.0, albedo.rgb)'), 'max( albedo.rgb,0.0)');
  assert.equal(browserEffectGlsl('min(-1, max(0, a.rgb))'), 'min( max( a.rgb,0.0),-1.0)');
  assert.equal(browserEffectGlsl('const int N=16; vec4 a[N];'), 'const int N=16; vec4 a[N];');
});
test("GLSL3 compatibility renames reserved locals and keeps sampling counters consistent", () => {
  const converted = browserEffectGlsl('const int sampleCount=30; for(int i=0;i<sampleCount;++i){vec4 sample=vec4(i/29.0);}');
  assert.match(converted, /const float sampleCount\s*=30.0/);
  assert.match(converted, /for \(float i =0.0/);
  assert.match(converted, /vec4 we_sample=/);
  assert.equal(browserEffectGlsl('vec4 a;vec2 s;vec2 b=a*(s*0.01);'), 'vec4 a;vec2 s;vec2 b=a.xy*(s*0.01);');
  assert.equal(browserEffectGlsl('vec4 a;vec2 b=a.zw;'), 'vec4 a;vec2 b=a.zw;');
  assert.match(browserEffectGlsl('for(int i=0;i<8;++i){float v=a[i+1];}'), /a\[int\(i\)\+1\]/);
  assert.equal(browserEffectGlsl('vec2 a=0.0,b=0.0;'), 'vec2 a=vec2(0.0),b=vec2(0.0);');
  assert.equal(browserEffectGlsl('#if g_Texture0Resolution.x > 1\n#define FOO 2\n#else\n#define FOO 2\n#endif'), '#define FOO 2');
  assert.equal(browserEffectGlsl('#if A\n#if B\nx();\n#endif\n#endif\n#endif'), '#if A\n#if B\nx();\n#endif\n#endif\n');
});
test('samplers used by included helpers are declared before use without lifting conditional declarations',()=>{
  const shader='vec4 blur(vec2 uv){return texture2D(g_Texture0,uv);}\nuniform sampler2D g_Texture0;\nvoid main(){}';
  const out=browserEffectGlsl(shader);assert.ok(out.startsWith('uniform sampler2D g_Texture0;\n'));
  assert.equal((out.match(/uniform sampler2D/g)||[]).length,1);
  const conditional='#if A\n'+shader+'\n#endif';assert.equal(browserEffectGlsl(conditional),conditional);
});

test('shader numeric lowering preserves integer indices and promotes mixed HLSL arithmetic', () => {
  const source = '#define RESOLUTION 64\nuniform float spectrum[RESOLUTION];\nvoid main(){float frequency=0.25*RESOLUTION;uint a=frequency%RESOLUTION;uint b=(a+1)%RESOLUTION;float y=lerp(spectrum[a],spectrum[b],0.5);}';
  const out = browserEffectGlsl(source);
  assert.match(out, /spectrum\[RESOLUTION\]/);
  assert.match(out, /frequency=0.25 \* float\(RESOLUTION\)/);
  assert.match(out, /uint a=uint\(we_scene_remainder\(frequency, float\(RESOLUTION\)\)\)/);
  assert.match(out, /uint b=\(a \+ uint\(1\)\) % uint\(RESOLUTION\)/);
  assert.match(out, /float y=mix\(spectrum\[a\],spectrum\[b\],0.5\)/);
  assert.match(out, /return x - y \* trunc\(x \/ y\)/);
  assert.equal(browserEffectGlsl('uint a=9%4;'), 'uint a=uint(9%4);');
  assert.equal(browserEffectGlsl('float a=0.5*COUNT;', {COUNT:64}), 'float a=0.5 * float(COUNT);');
  assert.equal(browserEffectGlsl('void f(float COUNT){float a=0.5*COUNT;}', {COUNT:64}), 'void f(float COUNT){float a=0.5*COUNT;}');
  assert.match(browserEffectGlsl('float x; float a=(x+1)*2%3;'), /we_scene_remainder\(\(x\+1.0\)\*2.0, 3.0\)/);
  assert.equal(browserEffectGlsl('int a=choose(1,2);'), 'int a=choose(1,2);');
});
test('shader scalar promotion respects local shadowing and function parameter scopes',()=>{
  const source='vec3 blend; void f(vec3 amount){amount=1;} void main(){float blend=1;{vec2 blend=1;}blend=2;}';
  const out=browserEffectGlsl(source);
  assert.match(out,/amount=vec3\(1.0\)/);assert.match(out,/float blend=1.0;/);
  assert.match(out,/vec2 blend=vec2\(1.0\);\}blend=2.0;/);
});
const uint = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = s => Buffer.concat([uint(Buffer.byteLength(s)), Buffer.from(s)]);
function pkg(entries) {
  let offset = 0;
  const table = Object.entries(entries).map(([name, data]) => { const e = Buffer.concat([str(name), uint(offset), uint(data.length)]); offset += data.length; return e; });
  return Buffer.concat([str("PKGV0006"), uint(table.length), ...table, ...Object.values(entries)]);
}
function tex(w, h, pixels) {
  return Buffer.concat([Buffer.from("TEXV0005\0TEXI0001\0"), ...[0, 0, w, h, w, h, 0].map(uint), Buffer.from("TEXB0002\0"), ...[1, 1, w, h, 0, pixels.length, pixels.length].map(uint), pixels]);
}
const float = n => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
test("TEX atlas keeps rotated bases and bounded fractional edge coordinates", async () => {
  const raw = Buffer.alloc(4 * 4 * 4, 128);
  const atlas = values => Buffer.concat([tex(4, 4, raw), Buffer.from("TEXS0002\0"), uint(1), uint(0), float(.1), ...values.map(float)]);
  const rotated = await decodeWallpaperTexture(atlas([4, 0, 0, 4, -4, 0]));
  assert.deepEqual(rotated.frames[0].axes, [0, 1, -1, 0]);
  assert.equal(rotated.frames[0].width, 1);
  assert.equal((await decodeWallpaperTexture(atlas([0, 0, 4.5, 0, 0, 4]))).width, 4);
  assert.equal((await decodeWallpaperTexture(atlas([0, 4, 1, 0, 0, 4]))).frames[0].y, 1);
  await assert.rejects(decodeWallpaperTexture(atlas([0, 0, 0, 0, 0, 4])), /atlas frame/);
  await assert.rejects(decodeWallpaperTexture(atlas([0, Infinity, 1, 0, 0, 4])), /atlas frame/);
});
test("embedded MP4 TEX payload is preserved without an RGBA decode or transcode", async () => {
  const mp4 = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  const decoded = await decodeWallpaperTexture(tex(1920, 1080, mp4));
  assert.deepEqual(decoded.video, mp4);
  assert.equal(decoded.width, 1920);
  assert.equal(decoded.png.length, 0);
});
test("package parser preserves UTF-8 resources and rejects traversal, duplicates and truncation", () => {
  const b = pkg({ "scene.json": Buffer.from("{}"), "materials/云.tex": Buffer.from([1, 2, 3]) });
  assert.deepEqual([...readWallpaperPackage(b).get("materials/云.tex")], [1, 2, 3]);
  for (const p of ["../secret", "/etc/passwd", "a/../../b", "a\\b", "C:/secret", "a//b", "a\0b"]) assert.throws(() => resourceName(p));
  assert.throws(() => readWallpaperPackage(b.subarray(0, b.length - 1)));
  assert.throws(() => readWallpaperPackage(pkg({ "../scene.json": Buffer.from("{}") })));
});
test("PKGV versions 1 through 23 retain directory bounds validation", () => {
  for (let version = 1; version <= 23; version++) {
    const b = pkg({ "scene.json": Buffer.from("{}") });
    b.write(`PKGV${String(version).padStart(4, "0")}`, 4, "ascii");
    assert.equal(readWallpaperPackage(b).get("scene.json").toString(), "{}");
    assert.throws(() => readWallpaperPackage(b.subarray(0, b.length - 1)), /directory/);
  }
  const b = pkg({ "scene.json": Buffer.from("{}") });
  b.write("PKGV0024", 4, "ascii");
  assert.throws(() => readWallpaperPackage(b), /version/);
});
test("TEX highest mip converts losslessly without resizing", async () => {
  const raw = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 20, 30, 40, 100]);
  const decoded = await decodeWallpaperTexture(tex(2, 2, raw));
  assert.equal(decoded.width, 2); assert.equal(decoded.height, 2);
  assert.deepEqual(await sharp(decoded.png).raw().toBuffer(), raw);
  await assert.rejects(decodeWallpaperTexture(tex(100000, 100000, raw)), /dimensions/);
  await assert.rejects(decodeWallpaperTexture(tex(2, 2, raw.subarray(0, 3))), /length/);
});

test("encoded TEX images must match their declared dimensions", async () => {
  const pixels = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
  const encoded = w => Buffer.concat([Buffer.from("TEXV0005\0TEXI0001\0"), ...[0, 0, w, 2, w, 2, 0].map(uint), Buffer.from("TEXB0003\0"), ...[1, 13, 1, w, 2, 0, pixels.length, pixels.length].map(uint), pixels]);
  const result = await decodeWallpaperTexture(encoded(2));
  assert.equal((await sharp(result.png).metadata()).width, 2);
  await assert.rejects(decodeWallpaperTexture(encoded(1)), /dimensions do not match/);
  const padded = Buffer.concat([Buffer.from("TEXV0005\0TEXI0001\0"), ...[0, 0, 8192, 8192, 2, 2, 0].map(uint), Buffer.from("TEXB0003\0"), ...[1, 13, 1, 8192, 8192, 0, pixels.length, pixels.length].map(uint), pixels]);
  const paddedResult = await decodeWallpaperTexture(padded);
  assert.equal(paddedResult.width, 2); assert.equal(paddedResult.height, 2);
});
test("scene manifests contain content-addressed PNG assets, never streams, and reject unsupported live behavior", async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "omp-browser-scene-"));
  const old = process.env.OMP_WEB_WALLPAPER_DIRS, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.OMP_WEB_WALLPAPER_DIRS = root; process.env.PI_CODING_AGENT_DIR = path.join(root, "agent"); store.invalidateWallpapers();
  t.after(async () => {
    if (old === undefined) delete process.env.OMP_WEB_WALLPAPER_DIRS; else process.env.OMP_WEB_WALLPAPER_DIRS = old;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    store.invalidateWallpapers();
    const real = await fs.realpath(root); assert.ok(real.startsWith(await fs.realpath(tmpdir())) && path.basename(real).startsWith("omp-browser-scene-"));
    await fs.rm(real, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(root, "project.json"), JSON.stringify({ type: "scene", file: "scene.json" }));
  const scene = { general: { bloom: true, bloomstrength: .15, bloomthreshold: .91, camerashake: true, cameraparallax: true, orthogonalprojection: { width: 2048, height: 1024 } }, objects: [{ id: 1, image: "models/a.json", origin: "1024 512 0", size: "2048 1024", colorBlendMode: 7 }, { id: 2, sound: "sounds/example.mp3" }] };
  const data = { "scene.json": Buffer.from(JSON.stringify(scene)), "models/a.json": Buffer.from('{"material":"materials/a.json"}'), "materials/a.json": Buffer.from('{"passes":[{"shader":"genericimage2","textures":["a"]}]}'), "materials/a.tex": tex(1, 1, Buffer.from([123, 45, 67, 255])) };
  data['sounds/example.mp3'] = Buffer.from('ID3\x04\0\0\0\0\0\0');
  await fs.writeFile(path.join(root, "scene.pkg"), pkg(data));
  const id = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 32);
  const { manifest, assets } = await compileBrowserScene(id);
  assert.equal(manifest.width, 2048); assert.equal(manifest.layers.length, 1); assert.equal(assets.size, 2);
  assert.equal(manifest.sounds[0].files[0].mimeType, 'audio/mpeg');
  assert.equal(manifest.sounds[0].mode, 'loop');
  assert.equal(manifest.sounds[0].volume, 1);
  // Long soundtracks have an independent 256 MiB budget, not the JSON/model cap.
  const smallAudio = data['sounds/example.mp3'];
  data['sounds/example.mp3'] = Buffer.alloc(129 * 1024 * 1024);
  smallAudio.copy(data['sounds/example.mp3']);
  await fs.writeFile(path.join(root, 'scene.pkg'), pkg(data));
  const longAudio = await compileBrowserScene(id);
  assert.equal(longAudio.assets.get(longAudio.manifest.sounds[0].files[0].key).length, 129 * 1024 * 1024);
  data['sounds/example.mp3'] = smallAudio;
  assert.match(manifest.textures[0].url, /scene-assets\/[a-f0-9]{64}$/);
  assert.equal(manifest.textures[0].width, 1);
  assert.deepEqual(manifest.bloom, { strength: .15, threshold: .91 });
  assert.equal(manifest.cameraEffects.parallax, true);
  assert.equal(manifest.cameraEffects.shake, true);
  scene.general.cameraparallax={user:'parallax',value:true};
  scene.objects[0].origin={user:'position',value:'1024 512 0'};
  data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  const bound=(await compileBrowserScene(id)).manifest;
  assert.equal(bound.cameraEffects.parallax,true);assert.deepEqual(bound.layers[0].origin,[1024,512,0]);
  assert.equal(manifest.layers[0].colorBlendMode, 7);
  assert.ok(!JSON.stringify(manifest).includes(root));
  scene.objects[0].alpha={value:1,animation:{c0:[{frame:0,value:0},{frame:60,value:1}],options:{fps:30,length:60,mode:'single',startpaused:true,name:'fade'}}};
  scene.objects[0].disablepropagation=true;
  data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  const animated=(await compileBrowserScene(id)).manifest;
  assert.equal(animated.layers[0].timelines[0].name,'fade');assert.equal(animated.layers[0].timelines[0].startPaused,true);
  assert.equal(animated.layers[0].disablePropagation,true);assert.ok(!animated.warnings?.some(w=>w.includes('Timeline')||w.includes('timeline')));
  scene.objects[0].alpha.animation.options.events=[{}];
  data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  assert.match((await compileBrowserScene(id)).manifest.warnings[0],/Unsupported timeline/);
  delete scene.objects[0].alpha;delete scene.objects[0].disablepropagation;
  scene.objects[0].effects = [{ file: "effects/qa/effect.json" }];
  Object.assign(data, {
    "effects/qa/effect.json": Buffer.from(JSON.stringify({ fbos: [{ name: "half", scale: 2 }], passes: [{ material: "materials/qa.json", target: "half" }, { material: "materials/qa.json", bind: [{ index: 0, name: "half" }, { index: 1, name: "previous" }] }, { material: "materials/qa.json" }] })),
    "materials/qa.json": Buffer.from(JSON.stringify({ passes: [{ shader: "effects/qa", textures: [null, "a"] }] })),
    "shaders/effects/qa.vert": Buffer.from("varying vec2 v_Bounds; void main(){v_Bounds=vec2(0,1);}"),
    "shaders/effects/qa.frag": Buffer.from('uniform sampler2D g_Texture1; // {"combo":"MASK"}\n#if MASK\nvoid main(){gl_FragColor=vec4(v_Bounds,0,1);}\n#endif'),
  });
  data["scene.json"] = Buffer.from(JSON.stringify(scene)); await fs.writeFile(path.join(root, "scene.pkg"), pkg(data));
  const effects = (await compileBrowserScene(id)).manifest.layers[0].passes;
  assert.match(effects[0].fragment, /#define MASK 1\n/);
  assert.match(effects[0].fragment, /varying vec2 v_Bounds;/);
  assert.deepEqual(effects[0].inputs, { 0: -1 }); assert.equal(effects[0].scale, 2);
  assert.deepEqual(effects[1].inputs, { 0: 0, 1: -1 });
  assert.deepEqual(effects[2].inputs, { 0: 1 });
  data['shaders/effects/qa.frag']=Buffer.from('uniform float g_Opacity; // {"material":"opacity","default":1}\nvoid main(){gl_FragColor=vec4(g_Opacity);}');
  scene.objects[0].effects[0].passes=[{constantshadervalues:{opacity:{value:.4,script:'export function update(v){return v}'}}}];
  data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  const binding=(await compileBrowserScene(id)).manifest;
  assert.equal(binding.layers[0].passes[0].uniforms.g_Opacity,.4);
  assert.deepEqual(binding.layers[0].passes[0].scripts,[{property:'g_Opacity',source:'export function update(v){return v}',properties:{}}]);
  assert.ok(!binding.warnings?.some(w=>w.includes('using its saved value')));
  delete scene.objects[0].effects[0].passes;
  const image = scene.objects[0].image;
  delete scene.objects[0].image; delete scene.objects[0].size;
  scene.objects[0].shape = "quad";
  data["scene.json"] = Buffer.from(JSON.stringify(scene)); await fs.writeFile(path.join(root, "scene.pkg"), pkg(data));
  const shape = (await compileBrowserScene(id)).manifest.layers[0];
  assert.equal(shape.texture, "@transparent");
  assert.deepEqual(shape.size, [2048, 1024]);
  assert.equal(shape.passes.length, 3);
  delete scene.objects[0].shape; scene.objects[0].image = image;
  scene.objects.push({ id: 5, particle: "particles/root.json" });
  const rootParticle = { maxcount: 7, material: "materials/particle.json", emitter: [{ name: "sphererandom", rate: 1 }], children: [{ id: 6, name: "particles/child.json", type: "eventdeath", maxcount: 2, origin: "3 4 0", scale: "2 1 1" }] };
  Object.assign(data, {
    "particles/root.json": Buffer.from(JSON.stringify(rootParticle)),
    "particles/child.json": Buffer.from(JSON.stringify({ maxcount: 3, material: "materials/particle.json", emitter: [{ name: "sphererandom", instantaneous: 3, rate: 0 }] })),
    "materials/particle.json": Buffer.from(JSON.stringify({ passes: [{ shader: "genericparticle", textures: ["a", "a"], combos: { REFRACT: 1 }, constantshadervalues: { ui_editor_properties_refract_amount: .2 } }] })),
  });
  data["scene.json"] = Buffer.from(JSON.stringify(scene)); await fs.writeFile(path.join(root, "scene.pkg"), pkg(data));
  const particles = (await compileBrowserScene(id)).manifest.particles;
  assert.equal(particles[0].children[0].config.maxcount, 3);
  assert.equal(particles[0].children[0].event.max, 2);
  assert.equal(particles[0].children[0].event.type, "eventdeath");
  assert.deepEqual(particles[0].children[0].event.origin, [3, 4, 0]);
  assert.equal(particles[0].refraction.amount, .2);
  data["materials/particle.json"] = Buffer.from(JSON.stringify({ passes: [{ shader: "genericparticle", textures: ["a"], combos: { REFRACT: 1 } }] }));
  await fs.writeFile(path.join(root, "scene.pkg"), pkg(data));
  assert.equal((await compileBrowserScene(id)).manifest.particles[0].refraction.texture, undefined);
  rootParticle.children[0].flags = 1;
  data["particles/root.json"] = Buffer.from(JSON.stringify(rootParticle)); await fs.writeFile(path.join(root, "scene.pkg"), pkg(data));
  await assert.rejects(compileBrowserScene(id), /control-point inheritance/);
  scene.objects.pop();
  delete scene.objects[0].effects;
  scene.objects.push({id:10,name:'Clock',text:{value:'12:34',script:'export function update(v){return v}',scriptproperties:{seconds:{user:'seconds',value:false}}},font:'fonts/test.ttf',size:'400 150',horizontalalign:'center',verticalalign:'center'});
  data['fonts/test.ttf']=Buffer.concat([uint(256),Buffer.alloc(12)]);
  data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  const withText=await compileBrowserScene(id);
  assert.equal(withText.manifest.layers[1].text.value,'12:34');
  assert.equal(withText.manifest.layers[1].text.properties.seconds,false);
  assert.equal(withText.manifest.fonts[0].mimeType,'font/ttf');
  assert.deepEqual(withText.assets.get(withText.manifest.fonts[0].key),data['fonts/test.ttf']);
  scene.objects.at(-1).font='../../secret.ttf';data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  await assert.rejects(compileBrowserScene(id),/font path/);
  scene.objects.at(-1).font='systemfont_sansserif';data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  assert.equal((await compileBrowserScene(id)).manifest.layers[1].text.font,'@system:sans-serif');
  scene.objects.at(-1).font='systemfont_arial';data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  assert.equal((await compileBrowserScene(id)).manifest.layers[1].text.font,'@system:Arial, sans-serif');
  scene.objects.pop();
  const propertySource='export function update(v){return v}';
  scene.objects[0].scale={value:'2 3 1',script:propertySource,scriptproperties:{gain:{user:'gain',value:4}}};
  scene.objects[0].visible={value:false,script:'export function update(){return true}'};
  data['materials/a.json']=Buffer.from(JSON.stringify({passes:[{shader:'workshop/123/tint',textures:['a']}]}));
  data['shaders/workshop/123/tint.vert']=Buffer.from('void main(){gl_Position=vec4(a_Position,1.0);}');
  data['shaders/workshop/123/tint.frag']=Buffer.from('void main(){gl_FragColor=vec4(1.0);}');
  data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  const scripted=(await compileBrowserScene(id)).manifest;
  assert.deepEqual(scripted.layers[0].scale,[2,3,1]);assert.equal(scripted.layers[0].visible,false);
  assert.equal(scripted.layers[0].scripts.find(s=>s.property==='scale').properties.gain,4);
  assert.match(scripted.layers[0].passes[0].fragment,/gl_FragColor/);
  assert.deepEqual(scripted.scriptTemplates[scene.objects[0].image].scale,[1,1,1]);
  assert.equal(scripted.scriptTemplates[scene.objects[0].image].scripts,undefined);
  delete scene.objects[0].scale;delete scene.objects[0].visible;
  data['materials/a.json']=Buffer.from(JSON.stringify({passes:[{shader:'genericimage2',textures:['a','a'],combos:{REFLECTION:1},constantshadervalues:{roughness:.25,metallic:.75,reflectivity:.5}}]}));
  data['scene.json']=Buffer.from(JSON.stringify(scene));await fs.writeFile(path.join(root,'scene.pkg'),pkg(data));
  const reflected=(await compileBrowserScene(id)).manifest.layers[0].reflection;
  assert.equal(reflected.roughness,.25);assert.equal(reflected.metallic,.75);assert.equal(reflected.reflectivity,.5);
  scene.objects[0].model = "models/3d.mdl";
  data["scene.json"] = Buffer.from(JSON.stringify(scene)); await fs.writeFile(path.join(root, "scene.pkg"), pkg(data));
  await assert.rejects(compileBrowserScene(id), /Unsupported scene object/);
  delete scene.objects[0].model;
  scene.objects[0].size = "100000 100000";
  data["scene.json"] = Buffer.from(JSON.stringify(scene)); await fs.writeFile(path.join(root, "scene.pkg"), pkg(data));
  await assert.rejects(compileBrowserScene(id), /safe dimensions/);
});
