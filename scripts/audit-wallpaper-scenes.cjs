const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.QA_BASE || 'http://127.0.0.1:13012';
const out = path.resolve(process.env.QA_OUT || '.tmp/scene-audit');
fs.mkdirSync(out, { recursive: true });
const reportPath = path.join(out, 'results.json');
const browserArguments = ['--enable-webgl', '--use-angle=d3d11', ...(process.env.QA_IGNORE_GPU_BLOCKLIST ? ['--ignore-gpu-blocklist'] : []), ...(process.env.QA_SOFTWARE_VIDEO ? ['--disable-accelerated-video-decode'] : [])];
const launch = () => chromium.launch({ headless: true, ...(process.env.QA_BROWSER_CHANNEL ? { channel: process.env.QA_BROWSER_CHANNEL } : {}), args: browserArguments });
const countBy = (items, key) => items.reduce((counts, item) => { const k = key(item); counts[k] = (counts[k] || 0) + 1; return counts; }, {});

function category(error) {
  if (/Unsupported browser scene effect/.test(error)) return 'unsupported-effect';
  if (/puppet|bone|skelet/i.test(error)) return 'puppet-or-skeleton';
  if (/script/i.test(error)) return 'script';
  if (/Unsupported scene object/.test(error)) return 'unsupported-object';
  if (/particle/i.test(error)) return 'particle';
  if (/color.?blend|blend.*mode/i.test(error)) return 'blend-mode';
  if (/audio/i.test(error)) return 'audio-reactive';
  if (/texture|TEX |mip|image payload/i.test(error)) return 'texture';
  if (/shader|GLSL|VALIDATE_STATUS/i.test(error)) return 'shader';
  if (/missing|ENOENT|not found/i.test(error)) return 'missing-resource';
  if (/perspective|camera/i.test(error)) return 'camera';
  if (/Timeout|timed out/i.test(error)) return 'timeout';
  if (/WebGL|context lost/i.test(error)) return 'webgl';
  return 'other';
}

function save(report) {
  report.updatedAt = new Date().toISOString();
  report.summary = { processed: report.results.length, total: report.sceneCount, status: countBy(report.results, r => r.status), failures: countBy(report.results.filter(r => r.status === 'failed'), r => r.category) };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function folderIndex(roots) {
  const folders = new Map();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folder = path.resolve(root, entry.name);
      const id = crypto.createHash('sha256').update(folder).digest('hex').slice(0, 32);
      folders.set(id, { folder, workshopId: entry.name });
    }
  }
  return folders;
}

async function testScene(browser, scene) {
  const result = { ...scene, startedAt: new Date().toISOString(), status: 'failed', errors: [], consoleErrors: [], consoleWarnings: [], requestsFailed: [], assetErrors: [], manifest: null };
  const started = Date.now();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const responseTasks = [];
  try {
    await ctx.route('**/api/sessions', r => r.fulfill({ json: { sessions: [], runningSessionIds: [], runningSessions: [] } }));
    await ctx.route('**/api/provider-usage*', r => r.fulfill({ json: { generatedAt: Date.now(), reports: [] } }));
    await ctx.addInitScript(id => {
      if (window === top) localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id, kind: 'scene', paused: true, glass: 'clear', brightness: 100, fit: 'cover', positionX: 50, positionY: 50 }));
    }, scene.id);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => result.errors.push(e.message));
    page.on('console', m => {
      const value = { text: m.text().slice(0, 6000), location: m.location() };
      if (m.type() === 'error') result.consoleErrors.push(value);
      if (m.type() === 'warning' && result.consoleWarnings.length < 20) result.consoleWarnings.push(value);
    });
    page.on('requestfailed', r => { if (r.url().includes('/wallpapers/')) result.requestsFailed.push({ url: r.url(), error: r.failure() }); });
    page.on('response', r => {
      if (!r.url().includes(`/wallpapers/${scene.id}/`)) return;
      if (r.url().endsWith('/scene')) responseTasks.push((async () => {
        result.sceneHttpStatus = r.status();
        const data = await r.json();
        if (!r.ok()) { result.serverError = data.error; return; }
        result.manifest = { width: data.width, height: data.height, layers: data.layers.length, particles: data.particles.length, textures: data.textures.length, passes: data.layers.reduce((n, layer) => n + layer.passes.length, 0), bloom: data.bloom, cameraEffects: data.cameraEffects };
        result.compatibilityWarnings = data.warnings || [];
      })().catch(e => result.errors.push(`Manifest inspection: ${e.message}`)));
      else if (!r.ok()) result.assetErrors.push({ url: r.url(), status: r.status() });
    });
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.documentElement.dataset.wallpaper === 'on' || document.querySelector('.wallpaper-error'), {}, { timeout: 60000 });
    result.loadMs = Date.now() - started;
    result.banner = (await page.locator('.wallpaper-error').allTextContents()).join('\n');
    if (!result.banner) {
      await page.evaluate(() => {
        const prefs = JSON.parse(localStorage.getItem('omp-web:wallpaper'));
        prefs.paused = false;
        localStorage.setItem('omp-web:wallpaper', JSON.stringify(prefs));
        window.dispatchEvent(new Event('omp-web:wallpaper-preferences'));
      });
      await page.waitForTimeout(1800);
      result.canvas = await page.locator('.wallpaper-scene').evaluate(canvas => {
        const small = document.createElement('canvas');
        small.width = 96; small.height = 54;
        const ctx = small.getContext('2d');
        ctx.drawImage(canvas, 0, 0, 96, 54);
        const pixels = ctx.getImageData(0, 0, 96, 54).data;
        let sum = 0, square = 0, nonzero = 0, alpha = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const v = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
          sum += v; square += v * v; if (v > 2) nonzero++; alpha += pixels[i + 3];
        }
        const n = pixels.length / 4, mean = sum / n;
        const gl = canvas.getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        return { width: canvas.width, height: canvas.height, time: canvas.dataset.sceneTime, mean, stdev: Math.sqrt(Math.max(0, square / n - mean * mean)), nonzeroFraction: nonzero / n, alphaMean: alpha / n, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, thumbnail: small.toDataURL() };
      });
      if (process.env.QA_THUMBNAILS === '1') fs.writeFileSync(path.join(out, `${scene.id}.png`), Buffer.from(result.canvas.thumbnail.split(',')[1], 'base64'));
      delete result.canvas.thumbnail;
      await page.waitForTimeout(700);
      result.lastSceneTime = await page.locator('.wallpaper-scene').getAttribute('data-scene-time');
      const runtimeWarnings = JSON.parse(await page.locator('.wallpaper-scene').getAttribute('data-compatibility-warnings') || '[]');
      result.compatibilityWarnings = [...new Set([...(result.compatibilityWarnings || []), ...runtimeWarnings])];
      result.banner = (await page.locator('.wallpaper-error').allTextContents()).join('\n');
    }
    await Promise.allSettled(responseTasks);
    const shaderError = result.consoleErrors.find(e => /Shader Error|VALIDATE_STATUS|GL_INVALID|WebGL.*CONTEXT_LOST|Error creating WebGL/i.test(e.text));
    result.error = result.serverError || result.banner || result.errors[0] || (result.assetErrors.length ? 'Scene assets failed to load' : '') || shaderError?.text;
    if (!result.error && result.canvas) {
      result.status = result.canvas.stdev < 1 || result.canvas.nonzeroFraction < 0.005 ? 'visual-warning' : 'passed';
      if (result.status === 'visual-warning') result.warning = 'Nearly uniform or blank sampled canvas; needs visual inspection.';
      if (result.compatibilityWarnings?.length) { result.status = 'partial'; result.warning = result.compatibilityWarnings.join('; '); }
    }
  } catch (e) {
    result.error = result.serverError || e.message;
  } finally {
    await ctx.close().catch(() => {});
    await Promise.allSettled(responseTasks);
    result.durationMs = Date.now() - started;
    if (result.status === 'failed') result.category = category(result.error || 'Unknown failure');
  }
  return result;
}

(async () => {
  const catalog = await (await fetch(`${base}/api/wallpapers?refresh=1`)).json();
  const selected = process.env.QA_IDS?.split(',');
  const scenes = catalog.wallpapers.filter(w => w.kind === 'scene' && (!selected || selected.includes(w.id)));
  const folders = folderIndex(catalog.roots);
  const report = process.env.QA_RESUME && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : { startedAt: new Date().toISOString(), base, scope: 'Sequential scene API + isolated headless Chromium WebGL, 1920x1080 DPR1, 2.5 seconds runtime per successfully loaded scene. Not a full visual-fidelity or long-duration test.', catalogCounts: countBy(catalog.wallpapers, w => w.kind), catalogWarnings: catalog.warnings, sceneCount: scenes.length, results: [] };
  if (report.base !== base || report.sceneCount !== scenes.length) throw new Error('Resume target differs from the saved audit. Use a new QA_OUT directory.');
  const completed = new Set(report.results.map(r => r.id));
  report.browserArguments = browserArguments;
  report.browserChannel = process.env.QA_BROWSER_CHANNEL || 'bundled-chromium';
  let browser = await launch();
  try {
    for (const scene of scenes) {
      if (completed.has(scene.id)) continue;
      if (!browser.isConnected()) browser = await launch();
      const result = await testScene(browser, { ...scene, ...folders.get(scene.id) });
      report.results.push(result);
      save(report);
      console.log(JSON.stringify({ index: report.results.length, total: scenes.length, title: scene.title, status: result.status, category: result.category, error: result.error?.slice(0, 220), ms: result.durationMs }));
      if (result.category === 'timeout' || result.category === 'webgl') { await browser.close(); browser = await launch(); }
    }
  } finally { await browser.close(); save(report); }
  report.finishedAt = new Date().toISOString();
  save(report);
  console.log('SUMMARY', JSON.stringify(report.summary));
})().catch(e => { console.error(e); process.exitCode = 1; });
