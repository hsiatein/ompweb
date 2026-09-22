/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const out = process.env.QA_OUT || '.tmp/status-glass-qa';
const pause = page => page.waitForTimeout(250);

async function measure(page) {
  return page.locator('.composer-status-bar').evaluate(el => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    const alpha = element => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = getComputedStyle(element).backgroundColor; ctx.fillRect(0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3] / 255;
    };
    const composer = document.querySelector('.chat-input-shell');
    const parent = document.querySelector('.wallpaper-chat-pane');
    const panel = document.querySelector('.composer-subagents-panel');
    const nativePanel = document.createElement('div');
    nativePanel.style.background = 'var(--bg-subtle)'; document.body.append(nativePanel);
    const nativePanelAlpha = alpha(nativePanel); nativePanel.remove();
    const r = el.getBoundingClientRect(), c = composer.getBoundingClientRect();
    return {
      alpha: alpha(el), blur: getComputedStyle(el).backdropFilter,
      parentAlpha: alpha(parent), parentBlur: getComputedStyle(parent).backdropFilter,
      panelAlpha: alpha(panel), panelBlur: getComputedStyle(panel).backdropFilter, nativePanelAlpha,
      composerAlpha: alpha(composer), composerBlur: getComputedStyle(composer).backdropFilter,
      gap: c.top - r.bottom, widthDifference: Math.abs(c.width - r.width),
      role: el.getAttribute('role'), live: el.getAttribute('aria-live'),
      color: getComputedStyle(el.querySelector('span:last-child')).color,
      inputColor: getComputedStyle(composer.querySelector('textarea')).color,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true }), report = [];
  try {
    for (const theme of ['light', 'omp']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const page = await browser.newPage({ viewport, locale: 'zh-CN' }), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/composer-glass-qa', { waitUntil: 'networkidle', timeout: 120000 });
      await page.waitForFunction(() => window.composerQA && document.documentElement.dataset.wallpaperPalette === 'on');
      await page.evaluate(theme => {
        window.composerQA.theme(theme);
        window.composerQA.subagents(true);
        const canvas = document.querySelector('.wallpaper-backdrop canvas'), ctx = canvas.getContext('2d');
        for (let x = 0; x < canvas.width; x += 20) {
          ctx.fillStyle = x % 40 ? '#486979' : '#283e48'; ctx.fillRect(x, 0, 20, canvas.height);
        }
      }, theme);
      const input = page.locator('textarea').first(), action = page.locator('.composer-primary-action');
      const modes = [];
      for (const glass of ['default', 'clear', 'frosted']) {
        await page.evaluate(glass => window.composerQA.prefs({ glass }), glass);
        await input.fill('Local waiting-state test'); await action.click();
        await page.locator('.composer-status-bar').waitFor(); await pause(page);
        await page.evaluate(() => window.composerQA.status('正在运行 web_search, web_search…'));
        await pause(page);
        const style = await measure(page);
        assert.equal(style.role, 'status'); assert.equal(style.live, 'polite');
        assert.equal(style.widthDifference, 0); assert.equal(style.gap, 0);
        assert.equal(style.overflow, false); assert.equal(style.color, style.inputColor);
        assert.equal(style.alpha, style.composerAlpha);
        assert.equal(style.panelAlpha, style.alpha); assert.equal(style.panelBlur, style.blur);
        if (glass === 'default') { assert.ok(style.alpha > 0 && style.alpha < .4); assert.equal(style.blur, 'blur(14px)'); }
        else {
          assert.equal(style.alpha, 0); assert.equal(style.blur, 'none');
          if (glass === 'frosted') { assert.equal(style.parentBlur, 'blur(20px)'); assert.ok(style.parentAlpha < .4 && style.parentAlpha > 0); }
        }
        await page.screenshot({ path: `${out}/${theme}-${viewport.width}-${glass}.png` });
        const panel = page.locator('.composer-subagents-panel');
        await panel.locator(':scope > button').click(); await pause(page);
        const child = panel.locator('.wallpaper-inset').first();
        const childAlpha = () => child.evaluate(el => {
          const ctx = document.createElement('canvas').getContext('2d');
          ctx.fillStyle = getComputedStyle(el).backgroundColor; ctx.fillRect(0, 0, 1, 1);
          return ctx.getImageData(0, 0, 1, 1).data[3] / 255;
        });
        assert.ok(await childAlpha() < .15);
        assert.equal(await child.evaluate(el => getComputedStyle(el).backdropFilter), 'none');
        await child.hover(); assert.ok(await childAlpha() < .2);
        await child.click(); assert.equal(await page.evaluate(() => window.composerQA.calls().at(-1)), 'qa-0');
        await page.mouse.move(0, 0);
        if (glass === 'default') await page.screenshot({ path: `${out}/${theme}-${viewport.width}-expanded.png` });
        await panel.locator(':scope > button').click();
        await page.evaluate(() => window.composerQA.queued(true)); await pause(page);
        assert.equal((await measure(page)).gap, 0);
        await page.evaluate(() => { window.composerQA.queued(false); window.composerQA.status(null); });
        await pause(page);
        assert.equal(await page.locator('.composer-status-bar').count(), 0, 'status disappears when output begins');
        assert.notEqual(await page.locator('.chat-input-shell').evaluate(el => getComputedStyle(el).borderTopLeftRadius), '0px');
        await page.evaluate(() => window.composerQA.status('等待模型回复…'));
        await action.click(); await pause(page);
        assert.equal(await page.locator('.composer-status-bar').count(), 0, 'stop clears waiting state');
        modes.push({ glass, ...style });
      }
      await page.evaluate(() => { window.composerQA.prefs({ id: null }); window.composerQA.status('Waiting'); }); await pause(page);
      const native = await measure(page);
      assert.equal(native.alpha, 1); assert.equal(native.blur, 'none');
      assert.equal(native.panelAlpha, native.nativePanelAlpha); assert.equal(native.panelBlur, 'none');
      assert.deepEqual(errors, []);
      const result = { theme, viewport, modes, nativeRestored: true, errors };
      report.push(result); console.log(JSON.stringify({ theme, viewport, pass: true }));
      await page.close();
    }
  } finally { await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
