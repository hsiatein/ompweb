/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const api = process.env.QA_API || base;
const out = process.env.QA_OUT || '.tmp/settings-contrast-qa';
const id = 'a'.repeat(32);
const repro = process.env.QA_REPRO === '1';

async function measure(page) {
  return page.locator('.settings-content').evaluate(root => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = value => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    const luminance = rgb => {
      const c = rgb.slice(0, 3).map(v => v / 255 <= .04045 ? v / 255 / 12.92 : ((v / 255 + .055) / 1.055) ** 2.4);
      return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
    };
    return [...root.querySelectorAll('h2, .settings-content-subtitle, .settings-card-title, .settings-card-desc')].flatMap(el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight) return [];
      const layers = [];
      for (let p = el; p; p = p.parentElement) layers.unshift(rgba(getComputedStyle(p).backgroundColor));
      let bg = [8, 12, 20];
      for (const fill of layers) bg = bg.map((v, i) => v * (1 - fill[3] / 255) + fill[i] * fill[3] / 255);
      const color = getComputedStyle(el).color;
      const a = luminance(rgba(color)), b = luminance(bg);
      return [{ text: el.textContent.slice(0, 45), color, background: bg, ink: el.dataset.wallpaperInk, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }];
    });
  });
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    for (const theme of repro ? ['light'] : ['light', 'omp']) {
      for (const viewport of repro ? [{ width: 1440, height: 960 }] : [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
        const context = await browser.newContext({ viewport, locale: 'zh-CN' });
        const wallpaper = await sharp({ create: { width: 640, height: 480, channels: 3, background: theme === 'light' ? '#080c14' : '#f4f2ed' } }).png().toBuffer();
        await context.addInitScript(({ theme, id }) => {
          localStorage.setItem('omp-theme', theme);
          localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id, kind: 'image', adaptivePalette: true, adaptiveText: true, muted: true }));
        }, { theme, id });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/api/**', async route => {
          const req = route.request(), url = new URL(req.url());
          if (url.pathname === `/api/wallpapers/${id}/media`) return route.fulfill({ contentType: 'image/png', body: wallpaper });
          if (req.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only QA' } });
          if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': qa\n\n' });
          if (api !== base) return route.fulfill({ response: await route.fetch({ url: api + url.pathname + url.search, timeout: 60000 }) });
          return route.continue();
        });
        await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => document.documentElement.dataset.wallpaperPalette === 'on', null, { timeout: 120000 });
        if (viewport.width < 768) await page.locator('button:has(svg.lucide-menu)').click();
        await page.locator('.sidebar-settings-row').click();
        await page.locator('.settings-content h2').waitFor();
        await page.waitForTimeout(1100);
        const initial = await measure(page);
        await page.locator('.settings-view').screenshot({ path: `${out}/${theme}-${viewport.width}.png` });
        const result = { theme, viewport, minContrast: Math.min(...initial.map(x => x.ratio)), samples: initial, errors };
        report.push(result); console.log(JSON.stringify(result));
        if (!repro) {
          assert.ok(initial.length >= 4);
          assert.ok(initial.every(x => x.ratio >= 4.5), 'all visible settings labels/descriptions meet AA');
          assert.deepEqual(errors, []);
          // A custom global ink must also pair the real opaque settings surfaces.
          for (const color of ['#171b1f', '#faf8ff', '#757575']) {
            await page.evaluate(color => {
              const key = 'omp-web:wallpaper';
              localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), textMode: 'fixed', textColor: color }));
              window.dispatchEvent(new Event('omp-web:wallpaper-preferences'));
            }, color);
            await page.waitForTimeout(1100);
            const changed = await measure(page);
            assert.ok(changed.every(x => x.ratio >= 4.5), `fixed color ${color} pairs settings fills`);
            assert.ok(changed.every(x => x.ink === 'global'));
            assert.equal(new Set(changed.map(x => x.color)).size, 1);
          }
          await page.locator('#settings-tab-wallpapers').click();
          const mode = page.getByRole('combobox', { name: '文字配色模式' });
          await mode.selectOption('fixed');
          const hex = page.getByRole('textbox', { name: '文字颜色 HEX' });
          await hex.fill('#c7c4dc'); await hex.press('Enter');
          await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--wallpaper-unified-text') === '#c7c4dc');
          for (const choice of ['auto', 'material']) {
            await mode.selectOption(choice);
            await page.waitForFunction(choice => document.documentElement.dataset.wallpaperText === choice, choice);
          }
          await page.waitForTimeout(800);
          await page.locator('.settings-view').screenshot({ path: `${out}/wallpaper-options-${theme}-${viewport.width}.png` });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        }
        await context.close();
      }
    }
  } finally {
    await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
