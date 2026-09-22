/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const out = process.env.QA_OUT || '.tmp/thinking-glass-qa';
const pause = page => page.waitForTimeout(300);
async function measure(page) {
  return page.locator('.thinking-output').evaluate(el => {
    const ctx = document.createElement('canvas').getContext('2d');
    const alpha = el => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3] / 255;
    };
    const native = document.createElement('div'); native.style.background = 'var(--bg-subtle)'; document.body.append(native);
    const nativeAlpha = alpha(native); native.remove();
    const s = getComputedStyle(el), parent = el.closest('.wallpaper-assistant'), pane = document.querySelector('.wallpaper-chat-pane');
    return {
      alpha: alpha(el), nativeAlpha, blur: s.backdropFilter,
      parentBlur: getComputedStyle(parent).backdropFilter, parentAlpha: alpha(parent),
      paneBlur: getComputedStyle(pane).backdropFilter,
      ink: el.dataset.wallpaperInk, color: s.color,
      ordinaryColor: getComputedStyle(document.querySelector('#ordinary-text')).color,
      whiteSpace: s.whiteSpace, wordBreak: s.wordBreak, font: s.fontFamily,
      overflow: document.documentElement.scrollWidth > innerWidth || el.scrollWidth > el.clientWidth + 1,
    };
  });
}
(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true }), report = [];
  try {
    for (const theme of ['light', 'omp']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const page = await browser.newPage({ viewport, locale: 'zh-CN' }), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(base + '/thinking-glass-qa', { waitUntil: 'networkidle', timeout: 120000 });
      await page.waitForFunction(() => window.thinkingQA && document.documentElement.dataset.wallpaperPalette === 'on');
      await page.evaluate(theme => window.thinkingQA.theme(theme), theme);
      await page.locator('.activity-row-trigger').click(); await pause(page);
      for (const glass of ['default', 'clear', 'frosted']) {
        await page.evaluate(glass => window.thinkingQA.prefs({ glass }), glass); await pause(page);
        const value = await measure(page);
        assert.ok(value.alpha < .15); assert.equal(value.blur, 'none');
        assert.equal(value.color, value.ordinaryColor); assert.equal(value.ink, 'global');
        assert.equal(value.whiteSpace, 'pre-wrap'); assert.equal(value.wordBreak, 'break-word'); assert.equal(value.overflow, false);
        if (glass === 'default') { assert.equal(value.parentBlur, 'blur(14px)'); assert.ok(value.parentAlpha > 0 && value.parentAlpha < .4); }
        else { assert.equal(value.parentBlur, 'none'); }
        if (glass === 'clear') assert.equal(value.alpha, 0);
        if (glass === 'frosted') assert.equal(value.paneBlur, 'blur(20px)');
        await page.screenshot({ path: `${out}/${theme}-${viewport.width}-${glass}.png` });
      }
      const output = page.locator('.thinking-output');
      await page.evaluate(() => window.thinkingQA.append());
      await page.waitForFunction(() => document.querySelector('.thinking-output').textContent.endsWith('New streamed text'));
      assert.ok((await output.textContent()).includes('\n    Preserve indentation'));
      const copied = await output.evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return selection.toString();
      });
      assert.ok(copied.includes('New streamed text'));
      await page.locator('main').evaluate(el => el.scrollTop = el.scrollHeight);
      assert.ok(await page.locator('main').evaluate(el => el.scrollHeight <= el.clientHeight || el.scrollTop > 0));
      await page.locator('.activity-row-trigger').click();
      assert.equal(await output.count(), 0);
      // Mock both deferred success and failure without accessing any real session.
      let release, started;
      const loadingStarted = new Promise(resolve => { started = resolve; });
      await page.route('**/api/sessions/qa-thinking/entries/deferred/thinking?*', async route => {
        await new Promise(resolve => { release = resolve; started(); });
        await route.fulfill({ json: { thinking: 'Loaded fixture\n    Preserve indentation' } });
      });
      await page.evaluate(() => { window.thinkingQA.prefs({ glass: 'default' }); window.thinkingQA.mode('deferred'); });
      await page.locator('.activity-row-trigger').click(); await loadingStarted;
      assert.ok((await measure(page)).alpha < .15);
      release(); await page.waitForFunction(() => document.querySelector('.thinking-output').textContent.startsWith('Loaded fixture'));
      await pause(page); assert.equal((await measure(page)).ink, 'global');
      await page.route('**/api/sessions/qa-thinking/entries/error/thinking?*', route => route.fulfill({ status: 500, json: { error: 'Preview load failure' } }));
      await page.evaluate(() => window.thinkingQA.mode('error'));
      await page.locator('.activity-row-trigger').click(); await page.locator('.thinking-output-error').waitFor(); await pause(page);
      assert.equal(await output.getAttribute('data-wallpaper-contrast'), 'off');
      assert.equal(await output.getAttribute('data-wallpaper-ink'), null);
      assert.notEqual((await measure(page)).color, (await measure(page)).ordinaryColor);
      await page.evaluate(() => window.thinkingQA.prefs({ id: null })); await pause(page);
      const native = await measure(page); assert.equal(native.alpha, native.nativeAlpha); assert.equal(native.blur, 'none');
      assert.deepEqual(errors, []);
      report.push({ theme, viewport, modes: 3, streaming: true, selection: true, deferred: true, errors });
      console.log(JSON.stringify({ theme, viewport, pass: true })); await page.close();
    }
  } finally { await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
