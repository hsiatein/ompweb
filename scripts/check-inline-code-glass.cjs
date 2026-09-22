/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const out = process.env.QA_OUT || '.tmp/inline-code-glass-qa';
const pause = page => page.waitForTimeout(300);
async function measure(page) {
  return page.locator('#message .markdown-inline-code').evaluateAll(nodes => {
    const ctx = document.createElement('canvas').getContext('2d');
    return nodes.map(el => {
      const s = getComputedStyle(el);
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1);
      return { text: el.textContent, alpha: ctx.getImageData(0, 0, 1, 1).data[3] / 255, color: s.color, parentColor: getComputedStyle(el.parentElement).color, blur: s.backdropFilter, shadow: s.boxShadow, font: s.fontFamily };
    });
  });
}
async function syntaxColors(page) {
  return page.locator('.markdown-code-block pre span[style*="color"]:not(.linenumber)').evaluateAll(nodes => nodes.map(el => [el.textContent, getComputedStyle(el).color]));
}
(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true }), report = [];
  try {
    for (const theme of ['light', 'omp']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const page = await browser.newPage({ viewport, locale: 'zh-CN' }), errors = [];
      await page.addInitScript(theme => {
        localStorage.setItem('omp-theme', theme);
        localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id: 'a'.repeat(32), kind: 'scene', adaptivePalette: true, brightness: 100 }));
      }, theme);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/palette-qa', { waitUntil: 'networkidle', timeout: 120000 });
      await page.waitForFunction(() => window.paletteQA && document.documentElement.dataset.wallpaperPalette === 'on');
      await page.locator('.markdown-code-block pre span[style*="color"]').first().waitFor();
      const syntax = await syntaxColors(page);
      assert.ok(syntax.length > 0);
      for (const glass of ['default', 'clear', 'frosted']) {
        await page.evaluate(glass => window.paletteQA.prefs({ glass }), glass); await pause(page);
        const data = await measure(page);
        assert.equal(data.length, 7);
        for (const row of data) {
          assert.ok(row.alpha < .15); assert.equal(row.blur, 'none');
          assert.equal(row.color, row.parentColor); assert.match(row.font, /mono|Consolas/i);
          assert.notEqual(row.shadow, 'none');
          if (glass === 'clear') assert.equal(row.alpha, 0);
        }
        assert.equal(await page.locator('pre .markdown-inline-code').count(), 0);
        assert.deepEqual(await syntaxColors(page), syntax);
        assert.equal(await page.locator('#protected-code').evaluate(el => getComputedStyle(el).color), 'rgb(111, 151, 177)');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: `${out}/${theme}-${viewport.width}-${glass}.png` });
      }
      await page.evaluate(() => window.paletteQA.prefs({ textMode: 'fixed', textColor: '#c7c4dc' })); await pause(page);
      assert.ok((await measure(page)).every(row => row.color === 'rgb(199, 196, 220)'));
      assert.deepEqual(await syntaxColors(page), syntax);
      const selected = await page.locator('.markdown-inline-code').first().evaluate(el => {
        const range = document.createRange(); range.selectNodeContents(el);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        return selection.toString();
      });
      assert.equal(selected, 'useTheme');
      await page.evaluate(() => window.paletteQA.prefs({ id: null })); await pause(page);
      assert.ok((await measure(page)).every(row => row.alpha === 1));
      assert.deepEqual(errors, []);
      report.push({ theme, viewport, modes: 3, syntaxPreserved: true, selection: true, nativeRestored: true, errors });
      console.log(JSON.stringify({ theme, viewport, pass: true })); await page.close();
    }
  } finally { await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
