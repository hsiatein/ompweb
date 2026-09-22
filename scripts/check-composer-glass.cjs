/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const out = process.env.QA_OUT || '.tmp/composer-glass-qa';
const pause = page => page.waitForTimeout(700);
async function measure(page) {
  return page.locator('.composer-primary-action').evaluate(el => {
    const s = getComputedStyle(el), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1);
    return { alpha: ctx.getImageData(0, 0, 1, 1).data[3] / 255, ink: el.dataset.wallpaperInk, color: s.color, shadow: s.boxShadow, ownBlur: s.backdropFilter, disabled: el.disabled, text: el.textContent };
  });
}
(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true }), report = [];
  try {
    for (const theme of ['light', 'omp']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const page = await browser.newPage({ viewport, locale: 'zh-CN' }), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + '/composer-glass-qa', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(() => window.composerQA && document.documentElement.dataset.wallpaperPalette === 'on');
      await page.evaluate(theme => window.composerQA.theme(theme), theme);
      const action = page.locator('.composer-primary-action'), input = page.locator('textarea').first();
      for (const glass of ['default', 'clear', 'frosted']) {
        await page.evaluate(glass => window.composerQA.prefs({ glass }), glass);
        await pause(page);
        assert.equal((await measure(page)).disabled, true);
        for (const [mode, text, expected] of [['idle', 'Test message', 'send'], ['run', '', 'stop'], ['run', 'Queued message', 'queue'], ['compact', '', 'stop-compaction']]) {
          await page.evaluate(mode => window.composerQA.running(mode), mode);
          await input.fill(text); await pause(page);
          const value = await measure(page);
          assert.ok(value.alpha < .15); assert.ok(value.ink, 'glass actions opt into adaptive ink');
          assert.equal(value.shadow, 'none'); assert.equal(value.ownBlur, 'none');
          if (glass === 'clear') assert.equal(value.alpha, 0);
          await action.hover(); assert.ok((await measure(page)).alpha < .2);
          if (glass === 'default' && expected === 'send') await page.locator('.chat-input-shell').screenshot({ path: `${out}/${theme}-${viewport.width}.png` });
          await action.click(); await pause(page);
          assert.equal(await page.evaluate(() => window.composerQA.calls().at(-1)), expected);
          await page.mouse.move(0, 0);
        }
        await page.evaluate(() => window.composerQA.running('idle'));
        await input.fill('Check text contrast');
        for (const color of ['#fafafa', '#101010']) {
          await page.evaluate(color => window.composerQA.prefs({ textMode: 'fixed', textColor: color }), color); await pause(page);
          assert.equal((await measure(page)).ink, 'global', `${glass} uses shared text ink`);
          assert.equal((await measure(page)).color, `rgb(${color.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ')})`);
        }
        assert.equal(await page.locator('#solid-protected').getAttribute('data-wallpaper-ink'), null, 'ordinary filled accent buttons stay protected');
        await input.fill(''); await pause(page);
      }
      await page.evaluate(() => window.composerQA.prefs({ adaptiveText: false }));
      await input.fill('Fallback'); await pause(page);
      assert.equal((await measure(page)).ink, undefined);
      const fallbackColor = await page.locator('.wallpaper-chat-pane').evaluate(el => getComputedStyle(el).color);
      assert.equal((await measure(page)).color, fallbackColor);
      await page.evaluate(() => window.composerQA.prefs({ id: null })); await pause(page);
      assert.equal((await measure(page)).alpha, 1, 'native filled action returns without wallpaper');
      assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
      assert.deepEqual(errors, []);
      const result = { theme, viewport, modes: 3, actionStates: 4, adaptiveInk: true, callbacks: true, errors };
      report.push(result); console.log(JSON.stringify(result)); await page.close();
    }
  } finally { await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
