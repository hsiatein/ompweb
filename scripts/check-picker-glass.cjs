/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sharp = require('sharp');
const base = process.env.QA_BASE || 'http://127.0.0.1:13018';
const out = process.env.QA_OUT || '.tmp/picker-glass-qa';
const pause = page => page.waitForTimeout(300);

async function style(locator) {
  return locator.evaluate(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.fillStyle = s.backgroundColor; ctx.fillRect(0, 0, 1, 1);
    return { alpha: ctx.getImageData(0, 0, 1, 1).data[3] / 255, blur: s.backdropFilter,
      color: s.color, border: s.borderColor, width: r.width, height: r.height,
      inViewport: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1,
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
}

function checkPanel(s, glass) {
  assert.equal(s.inViewport, true, JSON.stringify(s)); assert.equal(s.overflow, false);
  if (glass === 'clear') { assert.equal(s.alpha, 0); assert.equal(s.blur, 'none'); }
  else { assert.ok(s.alpha > 0 && s.alpha < .4); assert.equal(s.blur, `blur(${glass === 'frosted' ? 20 : 14}px)`); }
}

async function checkBlurPixels(page, panel) {
  const r = await panel.boundingBox();
  const clip = { x: Math.ceil(r.x + 95), y: Math.ceil(r.y + 5), width: Math.floor(r.width - 145), height: 8 };
  const deviation = async () => {
    const stats = await sharp(await page.screenshot({ clip })).stats();
    return stats.channels.slice(0, 3).reduce((sum, channel) => sum + channel.stdev, 0) / 3;
  };
  const blurred = await deviation();
  await panel.evaluate(el => el.style.setProperty('backdrop-filter', 'none', 'important'));
  const unblurred = await deviation();
  await panel.evaluate(el => el.style.removeProperty('backdrop-filter'));
  assert.ok(unblurred > 2 && blurred < unblurred * .7, JSON.stringify({ blurred, unblurred }));
  return { blurred, unblurred };
}

(async () => {
  await fs.mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true }), report = [];
  try {
    for (const theme of ['light', 'omp']) for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }, { width: 3840, height: 2160 }]) {
      const page = await browser.newPage({ viewport }), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/picker-glass-qa', { waitUntil: 'networkidle', timeout: 120000 });
      await page.waitForFunction(() => window.pickerQA && document.documentElement.dataset.wallpaperText);
      await page.evaluate(theme => window.pickerQA.theme(theme), theme);
      const model = page.locator('.composer-model-control > button');
      const thinking = page.locator('.composer-thinking-control > button');
      const context = page.locator('.composer-toolbar button[aria-haspopup="dialog"]').last();
      const speed = page.locator('.shell-metric-pill');
      const modes = [];
      for (const glass of ['default', 'clear', 'frosted']) {
        await page.evaluate(glass => window.pickerQA.prefs({ glass }), glass); await pause(page);
        const speedStyle = await style(speed);
        assert.ok(speedStyle.alpha < .15); assert.equal(speedStyle.blur, 'none');
        await model.click(); await pause(page);
        const panel = page.locator('.composer-model-control .picker-panel');
        const modelStyle = await style(panel); checkPanel(modelStyle, glass);
        const pixels = glass === 'clear' ? null : await checkBlurPixels(page, panel);
        for (const selector of ['.picker-search', '.picker-nested-providers']) assert.ok((await style(panel.locator(selector))).alpha < .15);
        const active = panel.locator('.picker-provider-row[data-active="true"]');
        assert.ok((await style(active)).alpha > .15 && (await style(active)).alpha < .25);
        assert.ok((await style(model)).alpha < .25);
        await page.screenshot({ path: `${out}/${theme}-${viewport.width}-${glass}-models.png` });
        await panel.locator('input[type="search"]').fill('model 3'); await pause(page);
        await panel.getByRole('menuitemradio', { name: /Test model 3/ }).click();
        assert.equal(await panel.count(), 0); assert.match(await model.innerText(), /Test model 3/);
        await model.click(); await pause(page);
        await panel.locator('input[type="search"]').press('Escape'); assert.equal(await panel.count(), 0);

        await thinking.click(); await pause(page);
        const thinkingPanel = page.locator('.composer-thinking-control .picker-panel');
        const thinkingStyle = await style(thinkingPanel); checkPanel(thinkingStyle, glass);
        const selected = thinkingPanel.locator('.picker-thinking-card[data-active="true"]');
        assert.ok((await style(selected)).alpha > .15 && (await style(selected)).alpha < .25);
        const option = thinkingPanel.getByRole('menuitemradio', { name: /^low$/i });
        await page.mouse.move(0, 0);
        assert.ok((await style(option)).alpha < .15);
        await option.hover(); await pause(page); assert.ok((await style(option)).alpha < .2);
        await page.screenshot({ path: `${out}/${theme}-${viewport.width}-${glass}-thinking.png` });
        await option.click(); assert.equal(await page.evaluate(() => window.pickerQA.calls().at(-1)), 'low');
        await thinking.click(); await page.getByRole('menuitemradio', { name: /^high$/i }).click();

        await context.click(); await pause(page);
        const contextPanel = page.locator('.composer-toolbar .picker-panel[role="dialog"]');
        const contextStyle = await style(contextPanel); checkPanel(contextStyle, glass);
        const compact = contextPanel.locator('button.wallpaper-inset');
        assert.ok((await style(compact)).alpha < .15);
        assert.ok(await contextPanel.innerText().then(text => text.includes('83k')));
        assert.equal(await contextPanel.evaluate(el => getComputedStyle(el).color), await page.locator('textarea').evaluate(el => getComputedStyle(el).color));
        await page.screenshot({ path: `${out}/${theme}-${viewport.width}-${glass}-context.png` });
        await compact.click(); assert.equal(await page.evaluate(() => window.pickerQA.calls().at(-1)), 'compact');
        modes.push({ glass, pixels, speedStyle, modelStyle, thinkingStyle, contextStyle });
      }
      await page.evaluate(() => {
        const canvas = document.querySelector('.wallpaper-backdrop canvas'), ctx = canvas.getContext('2d');
        ctx.fillStyle = '#eae8ed'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        window.pickerQA.prefs({ textMode: 'auto', brightness: 99, glass: 'default' });
      });
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--wallpaper-unified-text') === '#000000');
      await context.click(); await pause(page);
      const brightPanel = page.locator('.composer-toolbar .picker-panel[role="dialog"]');
      assert.equal((await style(brightPanel)).color, 'rgb(0, 0, 0)');
      await page.screenshot({ path: `${out}/${theme}-${viewport.width}-bright-context.png` });
      await page.evaluate(() => window.pickerQA.prefs({ textMode: 'fixed', textColor: '#c7c4dc' })); await pause(page);
      assert.equal((await style(brightPanel)).color, 'rgb(199, 196, 220)');
      await brightPanel.locator('button.wallpaper-inset').click();
      await page.evaluate(() => window.pickerQA.prefs({ id: null })); await pause(page);
      await model.click(); await pause(page);
      const native = await style(page.locator('.composer-model-control .picker-panel'));
      assert.equal(native.alpha, 1); assert.equal(native.blur, 'none');
      assert.deepEqual(errors, []);
      report.push({ theme, viewport, modes, native, errors });
      console.log(JSON.stringify({ theme, viewport, pass: true })); await page.close();
    }
  } finally { await fs.writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
