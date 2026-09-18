const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:30177';
const mode = process.env.QA_MODE || 'video';
const seconds = Math.min(120, Number(process.env.QA_SECONDS || 12));
const sceneId = process.env.QA_ID;
const software = process.env.QA_SOFTWARE_VIDEO === '1';
const out = process.env.QA_OUT || `.tmp/gpu-diagnostic-${mode}-${software ? 'software' : 'default'}`;
const videoScene = process.env.QA_VIDEO_SCENE_ID;
const videoPageUrl = process.env.QA_VIDEO_URL;
if ((mode.startsWith('wallpaper') || mode === 'bilibili') && !sceneId) throw new Error('Set QA_ID to a local scene.');
if (['video', 'video-texture', 'wallpaper-video'].includes(mode) && !videoScene) throw new Error('Set QA_VIDEO_SCENE_ID to a local scene with an MP4 texture.');
if (mode === 'bilibili' && !videoPageUrl) throw new Error('Set QA_VIDEO_URL to the video page to diagnose.');
const report = { mode, software, startedAt: new Date().toISOString(), events: [], media: [], samples: [] };
const bounded = (array, item) => { if (array.length < 200) array.push(item); };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [
    '--autoplay-policy=no-user-gesture-required',
    ...(software ? ['--disable-accelerated-video-decode'] : []),
    ...(process.env.QA_ANGLE ? [`--use-angle=${process.env.QA_ANGLE}`] : []),
  ] });
  const session = await browser.newBrowserCDPSession();
  const gpu = async () => {
    const { gpu } = await session.send('SystemInfo.getInfo');
    return { devices: gpu.devices, featureStatus: gpu.featureStatus, auxAttributes: gpu.auxAttributes };
  };
  try {
    report.browser = browser.version(); report.gpuBefore = await gpu();
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    page.on('pageerror', e => bounded(report.events, { type: 'error', message: e.message }));
    page.on('crash', () => bounded(report.events, { type: 'page-crash' }));
    page.on('console', m => { if (/error|warning/.test(m.type())) bounded(report.events, { type: m.type(), message: m.text().slice(0, 600) }); });
    const media = await context.newCDPSession(page);
    for (const event of ['playerErrorsRaised', 'playerPropertiesChanged', 'playerEventsAdded']) {
      media.on(`Media.${event}`, value => bounded(report.media, { event, value }));
    }
    await media.send('Media.enable');
    await page.addInitScript(() => {
      window.gpuDiagnostics = { lost: 0, creationErrors: [], uploads: 0 };
      document.addEventListener('webglcontextlost', () => window.gpuDiagnostics.lost++, true);
      document.addEventListener('webglcontextcreationerror', e => window.gpuDiagnostics.creationErrors.push(e.statusMessage), true);
    });
    if (mode.startsWith('wallpaper')) {
      await context.route('**/api/sessions', r => r.fulfill({ json: { sessions: [], runningSessionIds: [], runningSessions: [] } }));
      await context.route('**/api/provider-usage*', r => r.fulfill({ json: { generatedAt: Date.now(), reports: [] } }));
      await page.addInitScript(id => localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id, kind: 'scene', paused: false, muted: true, fit: 'cover', brightness: 100, glass: 'clear' })), sceneId);
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.dataset.wallpaper === 'on' || document.querySelector('.wallpaper-error'), {}, { timeout: 45000 });
    } else if (mode === 'bilibili') {
      const wallpaper = await context.newPage();
      await context.route('**/api/sessions', r => r.fulfill({ json: { sessions: [], runningSessionIds: [], runningSessions: [] } }));
      await context.route('**/api/provider-usage*', r => r.fulfill({ json: { generatedAt: Date.now(), reports: [] } }));
      await wallpaper.addInitScript(id => localStorage.setItem('omp-web:wallpaper', JSON.stringify({ id, kind: 'scene', paused: false, muted: true, fit: 'cover', brightness: 100, glass: 'clear' })), sceneId);
      await wallpaper.goto(base, { waitUntil: 'domcontentloaded' });
      await wallpaper.waitForFunction(() => document.documentElement.dataset.wallpaper === 'on' || document.querySelector('.wallpaper-error'), {}, { timeout: 45000 });
      report.wallpaperBefore = await wallpaper.evaluate(() => ({ active: document.documentElement.dataset.wallpaper, error: document.querySelector('.wallpaper-error')?.textContent }));
      report.sceneId = sceneId;
      browser.on('disconnected', () => bounded(report.events, { type: 'browser-disconnected' }));
      await page.goto(videoPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } else {
      await page.route(base + '/gpu-test', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local GPU diagnostic</title><body style="background:#234;color:white">Local GPU diagnostic</body>' }));
      await page.goto(base + '/gpu-test');
    }
    if (['video', 'video-texture', 'wallpaper-video'].includes(mode)) {
      const manifest = await (await fetch(`${base}/api/wallpapers/${videoScene}/scene`)).json();
      const video = manifest.textures.find(t => t.mimeType === 'video/mp4');
      report.video = { width: video.width, height: video.height, key: video.key };
      await page.evaluate(({ url, texture }) => {
        const video = document.createElement('video'); video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
        video.width = 960; video.style.cssText = 'position:fixed;top:0;left:0;z-index:99999'; document.body.append(video); video.src = url;
        if (texture) {
          const canvas = document.createElement('canvas'); canvas.width = 1248; canvas.height = 704; document.body.append(canvas);
          const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }); window.diagnosticGL = gl;
          if (!gl) return;
          gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
          const upload = () => {
            if (gl.isContextLost()) return;
            if (video.readyState >= 2) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); window.gpuDiagnostics.uploads++; }
            requestAnimationFrame(upload);
          }; requestAnimationFrame(upload);
        }
      }, { url: base + video.url, texture: mode === 'video-texture' });
    }
    if (mode === 'bilibili') {
      await page.waitForSelector('video', { timeout: 15000 });
      await page.evaluate(() => { for (const video of document.querySelectorAll('video')) { video.muted = true; void video.play().catch(() => {}); } });
    }
    for (let elapsed = 0; elapsed < seconds; elapsed += 2) {
      await page.waitForTimeout(2000);
      const sample = await page.evaluate(() => ({
        ...window.gpuDiagnostics,
        banner: document.querySelector('.wallpaper-error')?.textContent,
        sceneTime: document.querySelector('.wallpaper-scene')?.dataset.sceneTime,
        videos: [...document.querySelectorAll('video')].map(v => ({ time: v.currentTime, ready: v.readyState, width: v.videoWidth, height: v.videoHeight, frames: v.getVideoPlaybackQuality().totalVideoFrames, dropped: v.getVideoPlaybackQuality().droppedVideoFrames, error: v.error?.message, paused: v.paused })),
      }));
      report.samples.push(sample); console.log(JSON.stringify({ elapsed: elapsed + 2, ...sample }));
      if (sample.lost || sample.creationErrors.length || sample.banner || sample.videos.some(v => v.error)) break;
    }
    report.gpuAfter = await gpu();
    if (mode === 'bilibili') {
      const wallpaper = context.pages().find(p => p.url().startsWith(base));
      await wallpaper.bringToFront();
      await wallpaper.waitForTimeout(1000);
      report.wallpaperAfter = await wallpaper.evaluate(() => {
        const c = document.querySelector('.wallpaper-scene'), gl = c?.getContext('webgl2');
        return { active: document.documentElement.dataset.wallpaper, error: document.querySelector('.wallpaper-error')?.textContent, lost: gl?.isContextLost(), sceneTime: c?.dataset.sceneTime };
      });
      await wallpaper.screenshot({ path: path.join(out, 'wallpaper.png') });
    }
    const diagnostic = await context.newPage();
    await diagnostic.goto('chrome://gpu');
    report.gpuPage = await diagnostic.locator('body').innerText();
    await page.screenshot({ path: path.join(out, 'result.png') });
  } catch (e) { report.error = e.message; console.error(e.message); }
  finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
