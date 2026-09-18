const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13012';
const out = process.env.QA_OUT || '.tmp/scene-audio-qa';
const id = process.env.QA_ID;
if (!id) throw new Error('Set QA_ID to a local scene with an MP3 soundtrack.');
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const manifest = await (await fetch(`${base}/api/wallpapers/${id}/scene`)).json();
  assert.equal(manifest.sounds[0].files[0].mimeType, 'audio/mpeg');
  const response = await fetch(base + manifest.sounds[0].files[0].url, { headers: { Range: 'bytes=0-31' } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await response.arrayBuffer()).byteLength, 32);
  const browser = await chromium.launch({ headless: true, args: ['--enable-webgl', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--autoplay-policy=user-gesture-required'] });
  const results = [];
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport }), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/sessions', r => r.fulfill({ json: { sessions: [], runningSessionIds: [], runningSessions: [] } }));
      await page.addInitScript(id => {
        localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id, kind: 'scene', volume: 37 }));
        window.qaAudio = []; window.qaContexts = []; window.qaGains = []; window.qaAnalysers = [];
        const Audio = window.Audio, Context = window.AudioContext;
        window.Audio = function(...args) { const el = new Audio(...args); window.qaAudio.push(el); return el; };
        window.AudioContext = class extends Context {
          constructor(...args) { super(...args); window.qaContexts.push(this); }
          createGain() { const gain = super.createGain(); window.qaGains.push(gain); return gain; }
          createAnalyser() { const a = super.createAnalyser(); window.qaAnalysers.push(a); return a; }
        };
      }, id);
      await page.goto(base);
      await page.waitForFunction(() => document.documentElement.dataset.wallpaper === 'on');
      await page.keyboard.press('Shift');
      await page.waitForFunction(() => window.qaAudio.length > 0 && window.qaAudio.every(a => a.currentTime > .3 && !a.error) && window.qaContexts[0]?.state === 'running');
      await page.waitForFunction(() => window.qaAnalysers.some(a => { const data = new Uint8Array(a.frequencyBinCount); a.getByteFrequencyData(data); return data.some(v => v > 0); }));
      const gain = await page.evaluate(() => window.qaGains[1].gain.value);
      assert.ok(Math.abs(gain - .37) < 1e-5);
      const volume = page.locator('.wallpaper-volume').first();
      if (!await volume.isVisible()) await page.locator('.shell-topbar-overflow > summary').click();
      await volume.fill('18');
      await page.waitForFunction(() => Math.abs(window.qaGains[1].gain.value - .18) < 1e-5);
      await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('omp-web:wallpaper')); localStorage.setItem('omp-web:wallpaper', JSON.stringify({ ...p, muted: true, paused: true })); window.dispatchEvent(new Event('omp-web:wallpaper-preferences')); });
      await page.waitForFunction(() => window.qaAudio.every(a => a.paused) && window.qaContexts[0].state === 'suspended' && window.qaGains[1].gain.value === 0);
      const pausedTime = await page.evaluate(() => window.qaAudio[0].currentTime);
      await page.waitForTimeout(250);
      assert.ok(Math.abs(await page.evaluate(() => window.qaAudio[0].currentTime) - pausedTime) < .03);
      await page.screenshot({ path: `${out}/controls-${viewport.width}.png` });
      const bounds = await volume.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      await page.evaluate(() => { localStorage.setItem('omp-web:wallpaper', '{}'); window.dispatchEvent(new Event('omp-web:wallpaper-preferences')); });
      await page.waitForFunction(() => window.qaContexts.every(c => c.state === 'closed') && window.qaAudio.every(a => a.paused && !a.hasAttribute('src')));
      assert.deepEqual(errors, []);
      results.push({ viewport, originalAudio: true, range: true, spectrum: true, volume: true, mute: true, pause: true, cleanup: true });
      console.log(JSON.stringify(results.at(-1))); await page.close();
    }
  } finally { await browser.close(); fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
