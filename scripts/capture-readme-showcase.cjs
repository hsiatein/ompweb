/* eslint-disable @typescript-eslint/no-require-imports -- Node-only documentation capture. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.QA_BASE || 'http://127.0.0.1:13030';
const out = process.env.QA_OUT || 'docs/showcase';
const sid = '00000000-0000-4000-8000-000000000001';
const wid = 'a'.repeat(32);
const cwd = '/workspace/demo';
const info = { id: sid, path: '/demo/session.jsonl', cwd, projectRoot: cwd,
  name: 'A quieter workspace', created: '2026-01-01', modified: '2026-01-01',
  messageCount: 2, firstMessage: 'Plan a focused workspace.' };
const context = { entryIds: ['u', 'a'], thinkingLevel: 'high', model: null, todoPhases: [], messages: [
  { role: 'user', content: 'Plan a calm workspace for a small research project.', timestamp: 1767268800000 },
  { role: 'assistant', content: [{ type: 'text', text: [
    '## A quieter workspace',
    'Keep the conversation in focus, with reference material one click away.',
    '| Area | Purpose | Status |\n| --- | --- | --- |\n| Notes | Questions and references | Ready |\n| Experiments | Reproducible runs | Ready |\n| Results | Figures and comparisons | Next |',
    '### Start small',
    '1. Write down one question worth testing.\n2. Keep the first experiment reproducible.\n3. Save the result alongside its assumptions.',
    'Use `notes/`, `experiments/` and `results/` to keep the project easy to revisit.',
  ].join('\n\n') }], timestamp: 1767268810000, model: 'Demo Model', provider: 'demo',
    usage: { input: 840, output: 260, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
] };

// Original procedural artwork, generated in memory. No workshop art or personal
// files are read. All app API responses below are synthetic and intercepted.
async function makeArtwork(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1920; canvas.height = 1200;
    const c = canvas.getContext('2d');
    let seed = 7;
    const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
    const sky = c.createLinearGradient(0, 0, 0, 1000);
    sky.addColorStop(0, '#122c37'); sky.addColorStop(.42, '#5c9292');
    sky.addColorStop(.73, '#dfb7ba'); sky.addColorStop(1, '#efceb0');
    c.fillStyle = sky; c.fillRect(0, 0, 1920, 1200);
    for (let i = 0; i < 250; i++) {
      c.fillStyle = `rgba(240,249,255,${.15 + random() * .65})`;
      c.fillRect(random() * 1920, random() * 480, 1 + random() * 2, 1 + random() * 2);
    }
    const ridge = (points, fill) => {
      c.beginPath(); c.moveTo(0, 1200);
      for (const [x, y] of points) c.lineTo(x, y);
      c.lineTo(1920, 1200); c.closePath(); c.fillStyle = fill; c.fill();
    };
    ridge([[0,680],[200,520],[380,650],[620,365],[760,540],[940,465],[1190,665],[1390,510],[1590,690],[1820,410],[1920,480]], '#809eaa');
    ridge([[0,830],[210,770],[470,570],[670,760],[850,650],[1060,770],[1340,620],[1610,820],[1840,660],[1920,730]], '#526d80');
    ridge([[0,900],[280,880],[550,970],[850,955],[1100,1000],[1390,965],[1640,850],[1920,820]], '#263f50');
    const water = c.createLinearGradient(0, 950, 0, 1200);
    water.addColorStop(0, '#789f9f'); water.addColorStop(1, '#1d4e5a');
    ridge([[0,1200],[410,1150],[760,1050],[1160,1020],[1520,1060],[1920,1170]], water);
    for (let i = 0; i < 100; i++) {
      const y = 1040 + random() * 160, x = 500 + random() * 1000;
      c.fillStyle = 'rgba(207,222,211,.18)'; c.fillRect(x, y, 5 + random() * 70, 1);
    }
    return canvas.toDataURL('image/png').split(',')[1];
  });
}

async function setup(page, artwork, theme = 'dark') {
  await page.addInitScript(({ wid, theme }) => {
    localStorage.setItem('omp-lang', 'en'); localStorage.setItem('omp-theme', theme);
    localStorage.setItem('omp-web:sidebar-width', '256');
    localStorage.setItem('omp-web:provider-usage-collapsed', 'false');
    localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id: wid, kind: 'image',
      glass: 'default', brightness: 90, glassOpacity: 35, adaptivePalette: true, textMode: 'material', muted: true }));
  }, { wid, theme });
  await page.route('**/api/**', route => {
    const p = new URL(route.request().url()).pathname;
    const reply = json => route.fulfill({ json });
    if (p.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': demo\n\n' });
    if (p === '/api/sessions') return reply({ sessions: [info], runningSessionIds: [], runningSessions: [] });
    if (p === `/api/sessions/${sid}`) return reply({ sessionId: sid, filePath: info.path, info, leafId: 'a', tree: [], context, agent: { running: false } });
    if (p === `/api/sessions/${sid}/context`) return reply({ context, leafId: 'a', tree: [] });
    if (p === `/api/agent/${sid}`) return reply({ running: false });
    if (p === '/api/projects') return reply({ projects: [{ path: cwd }] });
    if (p === '/api/cwd/validate') return reply({ valid: true, cwd, isDirectory: true });
    if (p === '/api/models') return reply({ models: {}, modelList: [] });
    if (p === `/api/wallpapers/${wid}/media`) return route.fulfill({ contentType: 'image/png', body: artwork });
    if (p === '/api/wallpapers') return reply({ wallpapers: [{ id: wid, title: 'Alpine dusk (demo)', kind: 'image', source: 'folder', preview: true }], roots: [], warnings: [] });
    if (p === '/api/wallpapers/scene-status') return reply({ available: true });
    if (p === '/api/provider-usage') return reply({ generatedAt: Date.now(), reports: [{ provider: 'charm-hyper', accountLabel: 'Demo account', accountIndex: 0, credits: { remaining: 175, limit: 250, limitSource: 'fallback', percent: 30 } }] });
    if (p === '/api/worktrees') return reply({ worktrees: [] });
    if (p === '/api/git/status') return reply({ isGitRepo: false, files: [] });
    if (p === '/api/pets') return reply({ pets: [], skipped: 0 });
    if (p === '/api/app-update' || p === '/api/omp-update') return reply({ updateAvailable: false });
    if (p === '/api/omp-version') return reply({ version: 'demo' });
    if (p === '/api/omp-settings') return reply({ settings: {}, catalog: [] });
    if (p === '/api/stt') return reply({ text: 'A synthetic transcription for the public demo.' });
    return reply({ ok: true, entries: [], files: [], providers: [], settings: {}, tools: [], commands: [], sessions: [] });
  });
  await page.goto(`${base}/?session=${sid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wallpaper === 'on' && document.documentElement.dataset.wallpaperPalette === 'on');
  await page.locator('.wallpaper-assistant').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
}

async function capture(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal overflow');
  await page.screenshot({ path: path.join(out, name), animations: 'disabled' });
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: [
    '--enable-webgl', '--use-angle=d3d11',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  ] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    const artwork = Buffer.from(await makeArtwork(page), 'base64');
    await setup(page, artwork);
    if (!await page.locator('.sidebar-container').evaluate(el => el.classList.contains('sidebar-open'))) await page.locator('.shell-topbar-tools > button').click();
    await page.waitForTimeout(400);
    await capture(page, 'workspace.png');
    await page.getByRole('button', { name: 'Start dictation', exact: true }).click();
    await page.getByRole('button', { name: 'Pause recording', exact: true }).waitFor();
    await page.waitForTimeout(2300);
    const recordingButton = page.getByRole('button', { name: 'Pause recording', exact: true });
    assert.equal(await recordingButton.evaluate(el => el.classList.contains('wallpaper-inset')), true);
    await page.locator('.chat-input-shell').screenshot({ path: path.join(out, 'dictation.png'), animations: 'disabled' });
    await recordingButton.click();
    await page.getByRole('button', { name: 'Resume recording', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
    await page.getByRole('textbox').filter({ visible: true }).first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(el => el.value === 'A synthetic transcription for the public demo.'));
    await page.locator('.sidebar-settings-row').click();
    await page.locator('#settings-tab-wallpapers').click();
    await page.locator('.wallpaper-thumbnail img').waitFor();
    await page.waitForTimeout(800);
    await capture(page, 'wallpaper-settings.png');
    await page.close();
    const mobile = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    mobile.on('pageerror', error => errors.push(error.message));
    await setup(mobile, artwork);
    await capture(mobile, 'mobile.png');
    await mobile.close();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ captures: 4, errors, dictation: 'fake microphone and synthetic transcription', data: 'synthetic', artwork: 'original procedural landscape' }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
