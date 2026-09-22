import '../tests/setup-dom.mjs';
import assert from 'node:assert/strict';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createJiti} from 'jiti';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const jiti = createJiti(import.meta.url, {jsx:{runtime:'automatic'},tsconfigPaths:true});
const {MessageView} = await jiti.import('../components/MessageView.tsx');
const {setLocale} = await jiti.import('../lib/i18n/index.tsx');
setLocale('zh-CN');
const out = process.env.QA_OUT || '.tmp/message-status-glass';
const cssDir = process.env.QA_CSS_DIR || '.next/static/css';
let css = '';
for (const name of await readdir(cssDir)) if (name.endsWith('.css')) css += await readFile(`${cssDir}/${name}`, 'utf8');
css += await readFile('components/wallpapers.css','utf8');
const messages = ['Interrupted by user','Provider connection failed'].map(errorMessage => renderToStaticMarkup(React.createElement(MessageView, {
  message:{role:'assistant',provider:'test',model:'Model',content:[],errorMessage},
}))).join('');

await mkdir(out,{recursive:true});
const browser = await chromium.launch({headless:true});
const results = [];
try {
  for (const theme of ['light','omp']) for (const width of [390,1440,3840]) {
    const page = await browser.newPage({viewport:{width,height:width===3840?2160:900}});
    const errors = [];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setContent(`<html class="${theme}"><head><style>${css}</style></head><body><canvas class="wallpaper-backdrop" width="1200" height="900"></canvas><main class="wallpaper-shell" style="padding:24px;min-height:100vh"><section class="wallpaper-chat-pane" style="padding:12px;max-width:560px">${messages}</section></main></body></html>`);
    await page.evaluate(()=>{
      const c=document.querySelector('canvas'),ctx=c.getContext('2d');
      for(let x=0;x<c.width;x+=12){ctx.fillStyle=['#698593','#baaa9d','#8f9e83'][x/12%3];ctx.fillRect(x,0,12,c.height);}
    });
    for (const mode of ['default','clear','frosted','off']) {
      await page.evaluate(mode=>{
        document.documentElement.dataset.wallpaper=mode==='off'?'off':'on';
        document.documentElement.dataset.glass=mode;
      },mode);
      const measurements = await page.locator('[role="status"], [role="alert"]').evaluateAll(nodes=>{
        const ctx=document.createElement('canvas').getContext('2d');
        return nodes.map(el=>{
          const s=getComputedStyle(el),message=el.closest('.wallpaper-assistant'),r=el.getBoundingClientRect();
          ctx.clearRect(0,0,1,1);ctx.fillStyle=s.backgroundColor;ctx.fillRect(0,0,1,1);
          return {role:el.getAttribute('role'),alpha:ctx.getImageData(0,0,1,1).data[3]/255,color:s.color,blur:s.backdropFilter,messageBlur:getComputedStyle(message).backdropFilter,paneBlur:getComputedStyle(message.parentElement).backdropFilter,overflow:r.right>innerWidth||r.left<0||el.scrollWidth>el.clientWidth};
        });
      });
      assert.equal(measurements.length,2);
      for (const m of measurements) {
        assert.equal(m.overflow,false);
        assert.equal(m.blur,'none','reuse the parent blur instead of stacking it');
        if(mode==='off')assert.equal(m.alpha,1);
        else if(mode==='clear')assert.equal(m.alpha,0);
        else assert.ok(m.alpha>0&&m.alpha<.15,JSON.stringify(m));
        if(mode==='default')assert.equal(m.messageBlur,'blur(14px)');
        if(mode==='frosted')assert.equal(m.paneBlur,'blur(20px)');
      }
      assert.notEqual(measurements[0].color,measurements[1].color,'retain the error text color');
      await page.screenshot({path:`${out}/${theme}-${width}-${mode}.png`});
      results.push({theme,width,mode,measurements});
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log(JSON.stringify({cases:results.length,pass:true}));
} finally {
  await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
  await browser.close();
}
