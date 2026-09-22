/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const out = process.env.QA_OUT || '.tmp/text-modes-qa';
const prefs = (page, patch) => page.evaluate(patch => window.paletteQA.prefs(patch), patch);
const pause = page => page.waitForTimeout(700);
const report = [];
const rgb = hex => `rgb(${hex.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ')})`;
const ink = page => page.evaluate(() => document.documentElement.style.getPropertyValue('--wallpaper-unified-text'));

async function audit(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const plain = [...document.querySelectorAll('[data-wallpaper-ink="global"]')];
    const visible = plain.filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height && r.top < innerHeight && r.bottom > 0; });
    const luminance = color => {
      const c = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
    };
    const ratios = [...document.querySelectorAll('.wallpaper-settings select, .wallpaper-settings input[type="text"]')].map(el => {
      const s = getComputedStyle(el), a = luminance(s.color), b = luminance(s.backgroundColor);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    });
    return {
      mode: root.dataset.wallpaperText,
      color: root.style.getPropertyValue('--wallpaper-unified-text'),
      colors: [...new Set(visible.map(el => getComputedStyle(el).color))],
      count: visible.length,
      ratios,
      overflow: root.scrollWidth > innerWidth,
      oldMarkers: document.querySelectorAll('[data-wallpaper-ink="light"], [data-wallpaper-ink="dark"]').length,
    };
  });
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of ['light', 'dark']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.addInitScript(theme => {
        localStorage.setItem('omp-theme', theme);
        localStorage.setItem('omp-web:locale', 'zh-CN');
        if (!localStorage.getItem('omp-web:wallpaper')) localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id: 'a'.repeat(32), kind: 'scene', adaptivePalette: true, brightness: 100, glassOpacity: 35 }));
        window.sampleCount = 0;
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          postMessage(...args) { window.sampleCount++; return super.postMessage(...args); }
        };
      }, theme);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/wallpapers?*', route => route.fulfill({ json: { wallpapers: [], roots: [], warnings: [] } }));
      await page.route('**/api/wallpapers/scene-status', route => route.fulfill({ json: { available: true } }));
      await page.goto(base + '/palette-qa', { waitUntil: 'networkidle', timeout: 120000 });
      await page.waitForFunction(() => document.documentElement.dataset.wallpaperPalette === 'on');
      await pause(page);
      let a = await audit(page);
      assert.equal(a.mode, 'material');
      assert.ok(a.count > 12);
      assert.deepEqual(a.colors, [rgb(a.color)]);
      assert.equal(a.oldMarkers, 0);
      assert.equal(a.overflow, false);
      assert.equal(await page.locator('#protected-code').evaluate(el => getComputedStyle(el).color), 'rgb(111, 151, 177)');
      assert.equal(await page.locator('#filled').getAttribute('data-wallpaper-ink'), null);
      assert.equal(await page.locator('#filled').evaluate(el => getComputedStyle(el).color), 'rgb(255, 255, 255)');
      const initial = a.color;
      for (const glass of ['default', 'clear', 'frosted']) {
        await prefs(page, { glass }); await pause(page);
        assert.equal(await ink(page), initial);
        assert.deepEqual((await audit(page)).colors, [rgb(initial)]);
        await page.screenshot({ path: `${out}/${theme}-${viewport.width}-${glass}.png` });
      }
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const mode = page.getByRole('combobox', { name: '文字配色模式' });
      await mode.selectOption('fixed');
      const hex = page.getByRole('textbox', { name: '文字颜色 HEX' });
      await hex.fill('#c7c4dc'); await hex.press('Enter'); await pause(page);
      a = await audit(page);
      assert.equal(a.color, '#c7c4dc');
      assert.ok(a.ratios.every(r => r >= 4.5));
      assert.deepEqual(a.colors, [rgb(a.color)]);
      await hex.fill('#x'); await hex.blur();
      assert.equal(await hex.inputValue(), '#c7c4dc');
      await hex.fill('#757575'); await hex.press('Enter'); await pause(page);
      a = await audit(page);
      assert.ok(a.ratios.every(r => r >= 4.5), JSON.stringify(a));
      await page.screenshot({ path: `${out}/settings-fixed-${theme}-${viewport.width}.png` });
      await page.reload({ waitUntil: 'networkidle' }); await pause(page);
      assert.equal(await ink(page), '#757575', 'custom color persists across reloads');
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await mode.selectOption('auto'); await pause(page);
      a = await audit(page);
      assert.ok(['#000000', '#ffffff'].includes(a.color));
      assert.deepEqual(a.colors, [rgb(a.color)]);
      assert.ok(a.ratios.every(r => r >= 4.5));
      assert.equal(a.overflow, false);
      await mode.selectOption('material'); await pause(page);
      a = await audit(page);
      assert.equal(a.color, initial);
      assert.ok(a.ratios.every(r => r >= 4.5));
      await page.screenshot({ path: `${out}/settings-material-${theme}-${viewport.width}.png` });
      await page.getByRole('checkbox', { name: '文字配色', exact: true }).uncheck(); await pause(page);
      assert.equal(await page.locator('[data-wallpaper-ink]').count(), 0);
      assert.equal(await ink(page), '');
      assert.equal(await mode.isDisabled(), true);
      await page.getByRole('checkbox', { name: '文字配色', exact: true }).check(); await pause(page);
      assert.equal(await ink(page), initial);
      // Explicit brightness changes recompute promptly instead of waiting for animation hysteresis.
      await prefs(page, { brightness: 20 }); await pause(page);
      await page.waitForFunction(c => document.documentElement.style.getPropertyValue('--wallpaper-unified-text') !== c, initial);
      const darkInk = await ink(page);
      await page.evaluate(theme => window.paletteQA.theme(theme === 'light' ? 'dark' : 'light'), theme); await pause(page);
      assert.equal(await ink(page), darkInk, 'wallpaper-driven ink is independent of native theme');
      await prefs(page, { id: null }); await pause(page);
      assert.equal(await ink(page), '');
      assert.equal(await page.locator('[data-wallpaper-ink]').count(), 0);
      assert.deepEqual(errors, []);
      const result = { theme, viewport, initial, darkInk, samples: await page.evaluate(() => window.sampleCount), errors, pass: true };
      report.push(result); console.log(JSON.stringify(result)); await context.close();
    }
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id: 'a'.repeat(32), kind: 'scene', textMode: 'material' }));
      window.Worker = class { constructor() { throw new Error('Blocked for fallback test'); } };
    });
    await page.goto(base + '/palette-qa', { waitUntil: 'networkidle' });
    await pause(page);
    assert.match(await ink(page), /^#[0-9a-f]{6}$/);
    await prefs(page, { textMode: 'fixed', textColor: '#c7c4dc' }); await pause(page);
    assert.equal(await ink(page), '#c7c4dc');
    report.push({ workerBlockedFallback: true });
    await page.close();
  } finally { await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
