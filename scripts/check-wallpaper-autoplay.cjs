const fs = require('node:fs'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13015';
const id = '11111111111111111111111111111111', imported = '22222222222222222222222222222222';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('omp-web:wallpaper', JSON.stringify({ paused: true })));
    await page.route('**/api/sessions', r => r.fulfill({ json: { sessions: [], runningSessions: [], runningSessionIds: [] } }));
    await page.route('**/api/wallpapers?*', r => r.fulfill({ json: { wallpapers: [{ id, title: 'QA video', kind: 'video', source: 'import', preview: false }], roots: [], warnings: [] } }));
    const video = fs.readFileSync('.tmp/wallpaper-test-video.mp4');
    await page.route('**/api/wallpapers/*/media*', r => r.fulfill({ body: video, contentType: 'video/mp4' }));
    await page.route('**/api/wallpapers/upload?*', r => r.fulfill({ json: { id: imported, kind: 'video' } }));
    await page.goto(base);
    await page.getByRole('button', { name: /^(壁纸|Wallpapers)$/ }).click();
    await page.getByRole('button', { name: 'QA video', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.wallpaper-backdrop video')?.currentTime > .1);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('omp-web:wallpaper')).paused), false);
    await page.evaluate(() => { const p = JSON.parse(localStorage.getItem('omp-web:wallpaper')); localStorage.setItem('omp-web:wallpaper', JSON.stringify({ ...p, paused: true })); window.dispatchEvent(new Event('omp-web:wallpaper-preferences')); });
    await page.waitForFunction(() => document.querySelector('.wallpaper-backdrop video').paused);
    await page.locator('.wallpaper-settings input[type=file]').setInputFiles({ name: 'qa.mp4', mimeType: 'video/mp4', buffer: video });
    await page.waitForFunction(id => { const p = JSON.parse(localStorage.getItem('omp-web:wallpaper')); return p.id === id && p.paused === false && document.querySelector('.wallpaper-backdrop video')?.currentTime > .1; }, imported);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ reducedMotion: true, selectionPlays: true, importPlays: true, manualPause: true, errors }));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
