/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13022';
const out = process.env.QA_OUT || '.tmp/elaina-qa';
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11']});
  const results = [];
  try {
    for (const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]) {
      const page = await browser.newPage({viewport});
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
      await page.addInitScript(() => { window.qaNow = new Date(2026,8,19,12).getTime(); Date.now = () => window.qaNow; });
      await page.goto(base + '/scene-renderer-qa');
      await page.waitForFunction(() => window.sceneRendererQA || document.body?.dataset.error, null, {timeout:120000});
      const loadError = await page.evaluate(() => document.body.dataset.error);
      if (loadError) { fs.writeFileSync(`${out}/load-errors.json`,JSON.stringify({loadError,errors},null,2)); console.log(JSON.stringify({loadError,errors})); }
      assert.equal(loadError, undefined);
      for (const [hour, name] of [[5,'morning'],[12,'day'],[18,'dusk'],[22,'night'],[5,'morning']]) {
        await page.evaluate(hour => { window.qaNow = new Date(2026,8,19,hour).getTime(); },hour);
        await page.waitForTimeout(1200);
        const state = await page.evaluate(() => {
          const r = window.sceneRendererQA, canvas = document.querySelector('canvas');
          const tmp = document.createElement('canvas'); tmp.width = 80; tmp.height = 45;
          const ctx = tmp.getContext('2d'); ctx.drawImage(canvas,0,0,80,45);
          const pixels = [...ctx.getImageData(0,0,80,45).data];
          const videos = r.data.layers.filter(l => r.textures.get(l.texture)?.isVideoTexture).map(l => {
            const video=r.textures.get(l.texture).image,s=r.scriptStates.get(l.id);
            return {name:l.name,visible:s?.visible,requested:s?.videoPlaying,paused:video.paused,time:video.currentTime,width:video.videoWidth,height:video.videoHeight};
          });
          return {videos,pixels,warnings:JSON.parse(canvas.dataset.compatibilityWarnings||'[]'),error:document.body.dataset.error,size:[canvas.width,canvas.height]};
        });
        assert.equal(state.error,undefined);
        assert.deepEqual(state.videos.filter(v=>v.visible).map(v=>v.name),[name]);
        assert.deepEqual(state.videos.filter(v=>!v.paused).map(v=>v.name),[name]);
        assert.ok(new Set(state.pixels).size>30,'scene must not be blank');
        assert.ok(!state.warnings.some(w=>w.includes('6852')),'time controller must not be disabled');
        const selected = state.videos.find(v=>v.name===name);
        await page.waitForTimeout(400);
        const time = await page.evaluate(name=>{const r=window.sceneRendererQA,l=r.data.layers.find(l=>l.name===name);return r.textures.get(l.texture).image.currentTime;},name);
        assert.ok(time>selected.time,'selected video must advance');
        const screenshot = `${out}/${viewport.width}-${hour}.png`;
        await page.locator('canvas').screenshot({path:screenshot});
        delete state.pixels;
        results.push({viewport,hour,name,...state,errors:[...errors]}); console.log(JSON.stringify(results.at(-1)));
      }
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally { fs.writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2)); await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
