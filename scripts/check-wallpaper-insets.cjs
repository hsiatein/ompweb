/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const sharp = require('sharp');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const api = process.env.QA_API || base;
const out = process.env.QA_OUT || '.tmp/glass-insets-qa';
const id = 'a'.repeat(32);

async function surface(page, selector) {
  return page.locator(selector).first().evaluate(el => {
    const s = getComputedStyle(el), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1);
    let blur = 'none';
    for (let p = el.parentElement; p; p = p.parentElement) {
      const value = getComputedStyle(p).backdropFilter;
      if (value && value !== 'none') { blur = value; break; }
    }
    const inks = [...new Set([el, ...el.querySelectorAll('[data-wallpaper-ink]')].map(e => e.dataset.wallpaperInk).filter(Boolean))];
    return { alpha: ctx.getImageData(0, 0, 1, 1).data[3] / 255, ownBlur: s.backdropFilter, ancestorBlur: blur, inks };
  });
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const pixels = Buffer.alloc(640 * 480 * 3);
  for (let y = 0; y < 480; y++) for (let x = 0; x < 640; x++) {
    const i = (y * 640 + x) * 3, tile = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 ? 22 : 0;
    pixels[i] = 85 + tile; pixels[i + 1] = 110 + tile; pixels[i + 2] = 150 + tile;
  }
  const wallpaper = await sharp(pixels, { raw: { width: 640, height: 480, channels: 3 } }).png().toBuffer();
  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    for (const theme of ['light', 'omp']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.addInitScript(({ theme, id }) => {
        localStorage.setItem('omp-theme', theme);
        localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id, kind: 'image', adaptivePalette: true, adaptiveText: true, glass: 'default', muted: true }));
        localStorage.setItem('omp-web:provider-usage-visible', 'true');
        localStorage.setItem('omp-web:provider-usage-collapsed', 'false');
      }, { theme, id });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/**', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.pathname === `/api/wallpapers/${id}/media`) return route.fulfill({ contentType: 'image/png', body: wallpaper });
        if (url.pathname === '/api/provider-usage') return route.fulfill({ json: { generatedAt: Date.now(), reports: [{ provider: 'charm-hyper', accountLabel: 'Account 1', credits: { remaining: 180, limit: 250, limitSource: 'reported', percent: 28 } }] } });
        if (req.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Read-only QA' } });
        if (url.pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': qa\n\n' });
        if (api !== base) return route.fulfill({ response: await route.fetch({ url: api + url.pathname + url.search, timeout: 60000 }) });
        return route.continue();
      });
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(() => document.documentElement.dataset.wallpaperPalette === 'on', null, { timeout: 120000 });
      if (viewport.width < 768) await page.locator('button:has(svg.lucide-menu)').click();
      await page.locator('.sidebar-new-session').click();
      if (viewport.width < 768) await page.locator('button:has(svg.lucide-menu)').click();
      await page.locator('.provider-usage-name').waitFor();
      const selectors = ['.sidebar-new-session', '.provider-usage-name'];
      if (viewport.width > 960) {
        await page.locator('.shell-topbar-breadcrumb').waitFor();
        selectors.push('.shell-topbar-breadcrumb');
      }
      for (const mode of ['default', 'clear', 'frosted']) {
        await page.evaluate(mode => document.documentElement.dataset.glass = mode, mode);
        await page.mouse.move(viewport.width - 5, 5);
        await page.waitForTimeout(700);
        const measured = {};
        for (const selector of selectors) {
          const value = await surface(page, selector); measured[selector] = value;
          assert.ok(value.alpha < .15, `${selector} must not hide its parent glass`);
          assert.equal(value.ownBlur, 'none', 'avoid stacking backdrop blur');
          assert.equal(value.inks.length, 1, 'one ink per inset');
          if (mode === 'clear') { assert.equal(value.alpha, 0); assert.equal(value.ancestorBlur, 'none'); }
          else assert.match(value.ancestorBlur, /blur\((14|20)px\)/);
          if (mode === 'default') await page.locator(selector).screenshot({ path: `${out}/${theme}-${viewport.width}-${selector.slice(1)}.png` });
        }
        await page.locator('.sidebar-new-session').hover();
        assert.ok((await surface(page, '.sidebar-new-session')).alpha < .2, 'hover stays translucent');
        await page.locator('.sidebar-new-session').focus();
        await page.mouse.move(viewport.width - 5, 5);
        assert.ok((await surface(page, '.sidebar-new-session')).alpha < .2, 'keyboard focus stays translucent');
        await page.locator('.sidebar-new-session').evaluate(el => el.blur());
        assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'no viewport overflow');
        report.push({ theme, viewport, mode, measured });
      }
      await page.evaluate(() => document.documentElement.dataset.wallpaper = 'off');
      await page.waitForTimeout(400);
      for (const selector of selectors) {
        const restored = await page.locator(selector).evaluate(el => {
          const before = getComputedStyle(el).backgroundColor;
          el.classList.remove('wallpaper-inset');
          return { before, after: getComputedStyle(el).backgroundColor };
        });
        assert.equal(restored.before, restored.after, 'inset styling has no effect without wallpaper');
      }
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ theme, viewport, modes: 3, nativeThemeRestored: true, errors }));
      await context.close();
    }
  } finally {
    await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
