import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { parse } from "parse5";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./wallpaper-store.ts");
const web = await jiti.import("./wallpaper-web.ts");
const { parseWallpaperPreferences } = await jiti.import("./wallpapers.ts");
const { NextRequest } = await import("next/server.js");
const { proxy } = await jiti.import("../proxy.ts");
const webAssets = await jiti.import("../app/api/wallpapers/[id]/web-assets/[token]/[...file]/route.ts");

test("opaque frames cannot access application APIs; asset capabilities are independently checked", async () => {
  const url = 'http://localhost:30177/api/wallpapers/' + 'a'.repeat(32);
  for (const suffix of ['/web', '/scene']) assert.equal(proxy(new NextRequest(url + suffix, { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(proxy(new NextRequest('http://localhost:30177/api/sessions', { headers: { origin: 'null' } })).status, 403);
  const response = await webAssets.GET(new Request(url + '/web-assets/' + 'b'.repeat(64) + '/index.html'), { params: Promise.resolve({ id: 'a'.repeat(32), token: 'b'.repeat(64), file: ['index.html'] }) });
  assert.equal(response.status, 403);
});

test("web documents inject isolated property support before wallpaper scripts", () => {
  const html = web.webWallpaperHtml('<!doctype html><head><base href="https://example.com/"><link href="https://fonts.example.com/a"><script src="main.js"></script></head><body><img src="a.png"></body>', { general: { properties: { color: { value: "old" } } }, preset: { color: "</script><script>bad()</script>" } });
  assert.ok(!html.includes('<base'));
  assert.ok(!html.includes('https://fonts.example.com'));
  assert.match(html, /crossorigin="anonymous"/);
  assert.ok(!html.includes('</script><script>bad()'));
  const doc = parse(html), head = doc.childNodes.find(n => n.tagName === 'html').childNodes.find(n => n.tagName === 'head');
  assert.equal(head.childNodes.filter(n => n.tagName === 'script').length, 2);
  assert.match(head.childNodes[0].childNodes[0].value, /wallpaperPropertyListener/);
  const headers = web.webWallpaperHeaders('http://localhost:3000', 'a'.repeat(32), 'b'.repeat(64));
  assert.match(headers.get('content-security-policy'), /sandbox allow-scripts;/);
  assert.ok(!headers.get('content-security-policy').includes('allow-same-origin'));
  assert.match(headers.get('content-security-policy'), /connect-src http:\/\/localhost:3000\/api\/wallpapers\/a+\/web-assets\/b+\//);
  assert.equal(parseWallpaperPreferences('{"kind":"web"}').kind, 'web');
});

test("RainEffect export repair restores missing hidden navigation without changing other templates", () => {
  const source = '<div class="slide" id="slide-1"></div><nav class="slideshow__nav"></nav>';
  assert.match(web.webWallpaperHtml(source, { description: 'https://github.com/codrops/RainEffect' }), /href="#slide-1"/);
  assert.ok(!web.webWallpaperHtml(source, {}).includes('href="#slide-1"'));
});

test("catalog accepts case variants and resolves local presets without arbitrary filesystem dependencies", async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'omp-web-wallpaper-'));
  const oldRoots = process.env.OMP_WEB_WALLPAPER_DIRS, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.OMP_WEB_WALLPAPER_DIRS = root; process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent'); store.invalidateWallpapers();
  t.after(async () => {
    if (oldRoots === undefined) delete process.env.OMP_WEB_WALLPAPER_DIRS; else process.env.OMP_WEB_WALLPAPER_DIRS = oldRoots;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    store.invalidateWallpapers();
    const real = await fs.realpath(root); assert.ok(real.startsWith(await fs.realpath(tmpdir())) && path.basename(real).startsWith('omp-web-wallpaper-'));
    await fs.rm(real, { recursive: true, force: true });
  });
  async function project(name, metadata, files = {}) {
    const dir = path.join(root, name); await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ title: name, ...metadata }));
    for (const [name, value] of Object.entries(files)) await fs.writeFile(path.join(dir, name), value);
  }
  await project('1', { type: 'Web', file: 'index.html', general: { properties: { speed: { value: 1 } } } }, { 'index.html': '<html>test</html>' });
  await project('2', { dependency: '1', preset: { speed: 3 } });
  await project('3', { dependency: '999' });
  await project('4', { dependency: '../1' });
  await project('5', { dependency: '6' });
  await project('6', { dependency: '5' });
  await project('7', { type: 'Scene', file: 'scene.json' }, { 'scene.pkg': 'fixture' });
  await project('8', { type: 'Video', file: 'video.mp4' }, { 'video.mp4': 'fixture' });
  const catalog = await store.listWallpapers(true), find = name => catalog.wallpapers.find(w => w.title === name);
  assert.equal(find('1').kind, 'web'); assert.equal(find('2').kind, 'web');
  assert.equal(find('7').kind, 'scene'); assert.equal(find('8').kind, 'video');
  for (const name of ['3', '4', '5', '6']) { assert.equal(find(name).kind, 'unsupported'); assert.ok(find(name).reason); }
  const resolved = await store.resolveWebProject(find('2').id);
  assert.equal(resolved.folder, path.join(root, '1')); assert.equal(resolved.metadata.preset.speed, 3);
  const manifest = await web.webWallpaperManifest(find('2').id);
  const token = manifest.url.split('/')[5];
  assert.equal(web.validWebWallpaperToken(find('2').id, token), true);
  assert.equal(web.validWebWallpaperToken(find('1').id, token), false);
  assert.equal(web.validWebWallpaperToken(find('2').id, 'bad'), false);
  assert.equal(web.validWebWallpaperToken('../escape', token), false);
  await assert.rejects(store.safeWallpaperFile(resolved.folder, '../2/project.json'));
});
