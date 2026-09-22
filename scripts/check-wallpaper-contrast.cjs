/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const base = process.env.QA_BASE || 'http://127.0.0.1:13016';
const out = process.env.QA_OUT || '.tmp/region-contrast-qa';
const pause = page => page.waitForTimeout(650);
const ink = (page, selector) => page.locator(selector).evaluate(el => [...new Set([...el.querySelectorAll('[data-wallpaper-ink]')].map(e => e.dataset.wallpaperInk))]);
const styles = (page, selector) => page.locator(selector).first().evaluate(el => {
  const s = getComputedStyle(el); return { color: s.color, fill: s.backgroundColor, blur: s.backdropFilter };
});
const prefs = async (page, value) => { await page.evaluate(value => window.contrastQA.prefs(value), value); await pause(page); };
const pattern = async (page, value) => { await page.evaluate(value => window.contrastQA.pattern(value), value); await pause(page); };

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const report = [];
  try {
    for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.addInitScript(theme => localStorage.setItem('omp-theme', theme), theme);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/contrast-qa', { waitUntil: 'networkidle', timeout: 90000 });
      await page.waitForFunction(() => window.contrastQA && document.querySelector('#message th[data-wallpaper-ink]'));
      assert.equal((await ink(page, '#message')).length, 1, 'message/table/math/emphasis share one ink');
      assert.equal((await ink(page, '#composer')).length, 1);
      assert.equal(await page.locator('#protected-code').getAttribute('data-wallpaper-ink'), null);
      assert.equal(await page.locator('#protected-alert').getAttribute('data-wallpaper-ink'), null);
      assert.equal((await styles(page, '#protected-code')).color, 'rgb(111, 151, 177)');
      assert.ok(!(await page.evaluate(() => CSS.highlights?.has('wallpaper-ink-dark') || CSS.highlights?.has('wallpaper-ink-light'))));
      const table = await page.locator('#message th').first().boundingBox();
      const screenshot = await page.screenshot({ path: `${out}/${theme}-${viewport.width}.png` });
      const { data, info } = await sharp(screenshot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixel = x => { const i = (Math.round(table.y + 2) * info.width + x) * 3; return [...data.subarray(i, i + 3)]; };
      const left = pixel(50), right = pixel(viewport.width - 50);
      assert.ok(Math.abs(left[0] - right[0]) > 40, 'wallpaper remains visible through the header');
      assert.equal((await styles(page, '#message')).blur, 'blur(14px)');
      assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'no horizontal viewport overflow');
      await prefs(page, { glass: 'clear' });
      assert.equal((await styles(page, '#message th')).fill, 'rgba(0, 0, 0, 0)');
      assert.equal((await styles(page, '#message')).blur, 'none');
      assert.deepEqual(await ink(page, '#bright-box'), ['dark']);
      assert.deepEqual(await ink(page, '#dark-box'), ['light']);
      await page.evaluate(() => window.contrastQA.stream()); await pause(page);
      assert.equal((await ink(page, '#message')).length, 1, 'streamed text stays in the same region');
      assert.equal(await page.locator('#long-word').evaluate(el => el.childNodes.length), 1);
      const selected = await page.locator('#long-word').evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const text = selection.toString(); selection.removeAllRanges(); return text;
      });
      assert.equal(selected, 'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ');
      await page.evaluate(() => {
        const hidden = document.createElement('div'); hidden.id = 'hidden-history'; hidden.style.display = 'none';
        for (let i = 0; i < 6100; i++) { const p = document.createElement('p'); p.textContent = 'Earlier hidden message'; hidden.append(p); }
        document.querySelector('.wallpaper-shell').prepend(hidden);
      });
      await pattern(page, 'dark'); assert.deepEqual(await ink(page, '#message'), ['light'], 'hidden history cannot exhaust visible-text budget');
      await page.locator('#hidden-history').evaluate(el => el.remove());
      await pattern(page, 'light'); assert.deepEqual(await ink(page, '#message'), ['dark']);
      await prefs(page, { adaptiveText: false });
      assert.equal(await page.locator('[data-wallpaper-ink]').count(), 0);
      await prefs(page, { adaptiveText: true, glass: 'frosted' });
      assert.equal((await styles(page, '.wallpaper-chat-pane')).blur, 'blur(20px)');
      assert.equal((await styles(page, '#message')).blur, 'none');
      assert.equal((await ink(page, '#message')).length, 1);
      await prefs(page, { id: null });
      assert.equal(await page.locator('[data-wallpaper-ink]').count(), 0);
      assert.equal((await styles(page, '#message')).blur, 'none');
      const nativeFill = await page.locator('#message th').first().evaluate(el => {
        const s = getComputedStyle(el); const c = document.createElement('canvas'); c.width = c.height = 1;
        const ctx = c.getContext('2d'); ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1); return ctx.getImageData(0, 0, 1, 1).data[3];
      });
      assert.equal(nativeFill, 255, 'ordinary theme table restored');
      if (theme === 'light' && viewport.width === 1440) {
        await prefs(page, { id: 'a'.repeat(32), glass: 'clear' });
        await page.evaluate(async () => {
          const canvas = document.querySelector('.wallpaper-backdrop canvas');
          const image = new Image(); image.src = canvas.toDataURL(); await image.decode(); canvas.replaceWith(image);
          window.savedQACanvas = canvas;
        });
        await pause(page); assert.deepEqual(await ink(page, '#message'), ['dark']);
        await page.evaluate(async () => {
          const canvas = window.savedQACanvas, video = document.createElement('video');
          video.muted = true; video.playsInline = true; video.srcObject = canvas.captureStream(15);
          document.querySelector('.wallpaper-backdrop img').replaceWith(video); await video.play();
        });
        await pattern(page, 'dark'); assert.deepEqual(await ink(page, '#message'), ['light']);
        await pattern(page, 'light'); assert.deepEqual(await ink(page, '#message'), ['dark']);
      }
      assert.deepEqual(errors, []);
      const result = { theme, viewport, uniformRegionInk: true, transparentTableHeader: true, preservedSemanticColors: true, streamingAndCopy: true, modes: true, errors };
      report.push(result); console.log(JSON.stringify(result)); await context.close();
    }
  } finally { await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
