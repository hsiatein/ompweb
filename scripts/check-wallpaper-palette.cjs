/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const out = process.env.QA_OUT || '.tmp/palette-qa';
const color = page => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
const prefs = (page, patch) => page.evaluate(patch => window.paletteQA.prefs(patch), patch);
const active = page => page.waitForFunction(() => document.documentElement.dataset.wallpaperPalette === 'on');
const pause = page => page.waitForTimeout(650);
const report = [];

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.addInitScript(theme => {
        localStorage.setItem('omp-theme', theme);
        localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id: 'a'.repeat(32), kind: 'scene', adaptivePalette: true, brightness: 100, glassOpacity: 35 }));
        window.paletteStats = { workers: 0, samples: 0, maxSampleMs: 0, terminated: 0 };
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) { super(...args); window.paletteStats.workers++; }
          postMessage(...args) { const start = performance.now(); window.paletteStats.samples++; this.addEventListener('message', () => { window.paletteStats.maxSampleMs = Math.max(window.paletteStats.maxSampleMs, performance.now() - start); }, { once: true }); return super.postMessage(...args); }
          terminate() { window.paletteStats.terminated++; return super.terminate(); }
        };
      }, theme);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/wallpapers?*', route => route.fulfill({ json: { wallpapers: [], roots: [], warnings: [] } }));
      await page.route('**/api/wallpapers/scene-status', route => route.fulfill({ json: { available: true } }));
      await page.goto(base + '/palette-qa', { waitUntil: 'networkidle', timeout: 120000 });
      await active(page); await pause(page);
      const initial = await color(page);
      const audit = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const button = document.querySelector('#filled');
        return {
          accent: root.getPropertyValue('--accent').trim(),
          buttonColor: getComputedStyle(button).color,
          protectedButton: !button.hasAttribute('data-wallpaper-ink'),
          ink: [...new Set([...document.querySelectorAll('#message [data-wallpaper-ink]')].map(el => el.dataset.wallpaperInk))],
          glass: getComputedStyle(document.querySelector('#message')).backdropFilter,
          code: getComputedStyle(document.querySelector('#protected-code')).color,
          error: getComputedStyle(document.querySelector('#protected-alert')).color,
          overflow: document.documentElement.scrollWidth > innerWidth,
          stats: window.paletteStats,
        };
      });
      assert.equal(audit.buttonColor, 'rgb(255, 255, 255)');
      assert.equal(audit.protectedButton, true);
      assert.equal(audit.ink.length, 1);
      assert.equal(audit.glass, 'blur(14px)');
      assert.equal(audit.code, 'rgb(111, 151, 177)');
      assert.equal(audit.overflow, false);
      await page.screenshot({ path: `${out}/${theme}-${viewport.width}.png` });
      await prefs(page, { adaptivePalette: false }); await pause(page);
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-wallpaper-palette')), false);
      assert.notEqual(await color(page), initial);
      assert.equal(await page.evaluate(() => [...document.documentElement.style].some(n => n.startsWith('--wallpaper-palette-'))), false);
      assert.equal(await page.locator('#protected-alert').evaluate(el => getComputedStyle(el).color), audit.error);
      await prefs(page, { adaptivePalette: true }); await active(page);
      assert.equal(await color(page), initial);
      await page.evaluate(theme => window.paletteQA.theme(theme === 'light' ? 'dark' : 'light'), theme); await pause(page);
      assert.equal(await color(page), initial, 'global wallpaper ink determines surface polarity');
      await page.evaluate(theme => window.paletteQA.theme(theme), theme); await pause(page);
      assert.equal(await color(page), initial);
      for (const glass of ['clear', 'frosted', 'default']) {
        await prefs(page, { glass }); await pause(page);
        assert.equal(await color(page), initial);
      }
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const checkbox = page.getByRole('checkbox', { name: '壁纸配色', exact: true });
      await checkbox.uncheck(); await pause(page);
      assert.notEqual(await color(page), initial);
      await checkbox.check(); await active(page);
      await page.screenshot({ path: `${out}/settings-${theme}-${viewport.width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      if (theme === 'light' && viewport.width === 1440) {
        // Real canvas pixels may change every frame; palette changes are deliberately slow.
        await page.evaluate(() => window.paletteQA.pattern('red'));
        await page.waitForTimeout(16500);
        assert.equal(await color(page), initial, 'first changed sample is held pending');
        await page.waitForFunction(initial => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() !== initial, initial, { timeout: 20000 });
        await page.screenshot({ path: `${out}/dynamic-red.png` });
        const stats = await page.evaluate(() => window.paletteStats);
        assert.ok(stats.samples <= 10, JSON.stringify(stats));
        report.push({ dynamicStability: true, stats });
        // Test decoded image, video, and sandboxed-web preview sources separately.
        await page.evaluate(async () => {
          const canvas = document.querySelector('.wallpaper-backdrop canvas');
          window.savedPaletteCanvas = canvas;
          const image = new Image(); image.src = canvas.toDataURL(); await image.decode(); canvas.replaceWith(image);
          window.paletteQA.prefs({ kind: 'image' });
        });
        await active(page);
        assert.notEqual(await color(page), initial);
        await page.evaluate(async () => {
          const video = document.createElement('video'); video.muted = true; video.playsInline = true;
          video.srcObject = window.savedPaletteCanvas.captureStream(10);
          document.querySelector('.wallpaper-backdrop img').replaceWith(video);
          await video.play(); window.paletteQA.prefs({ kind: 'video' });
        });
        await active(page); assert.notEqual(await color(page), initial);
        const preview = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#337f59' } }).png().toBuffer();
        await page.route('**/media?preview=1', route => route.fulfill({ contentType: 'image/png', body: preview }));
        await prefs(page, { kind: 'web' }); await active(page);
        assert.notEqual(await color(page), initial);
        report.push({ imageVideoWebPreview: true });
      }
      await prefs(page, { id: null }); await pause(page);
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-wallpaper-palette')), false);
      assert.equal(await page.locator('[data-wallpaper-ink]').count(), 0);
      assert.deepEqual(errors, []);
      const result = { theme, viewport, ...audit, switchingAndRestoration: true, settings: true, errors };
      report.push(result); console.log(JSON.stringify(result)); await context.close();
    }
  } finally { await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
