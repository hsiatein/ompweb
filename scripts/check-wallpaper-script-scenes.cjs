const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.QA_BASE||'http://127.0.0.1:13012';
const output=process.env.QA_OUT||'.tmp/scene-script-scenes';
const ids=(process.env.QA_IDS||'').split(',').map(id=>id.trim()).filter(Boolean);
if(!ids.length)throw new Error('Set QA_IDS to local audio-reactive scenes that generate at least 63 layers.');
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--ignore-gpu-blocklist']});
  const results=[];
  try{
    for(const id of ids){
      const response=await fetch(`${base}/api/wallpapers/${id}/scene`);assert.ok(response.ok);const data=await response.json();
      for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]){
        const page=await browser.newPage({viewport}),errors=[];
        page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
        await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:data}));
        await page.goto(`${base}/scene-renderer-qa`);await page.waitForFunction(()=>window.sceneRendererQA);
        const metrics=await page.evaluate(viewport=>{
          const r=window.sceneRendererQA,c=document.querySelector('canvas');
          c.style.width=viewport.width+'px';c.style.height=viewport.height+'px';r.resizeDirty=true;r.draw(0);
          const hash=()=>{const x=document.createElement('canvas');x.width=192;x.height=108;const ctx=x.getContext('2d');ctx.drawImage(c,0,0,192,108);return x.toDataURL();};
          const silent=hash();const update=r.propertyScripts.update.bind(r.propertyScripts);
          const times=[];for(let i=0;i<100;i++){const start=performance.now();update(i/60,1/60);times.push(performance.now()-start);}
          r.propertyScripts.update=(time,dt)=>update(time,dt,Array(128).fill(.6));
          r.draw(1/60);const loud=hash();
          const layers=Array.from(r.scriptLayers.values()).filter(x=>x.layer.id<0);
          const minY=Math.min(...layers.map(x=>x.mesh.scale.y));
          r.propertyScripts.update=(time,dt)=>update(time,dt,Array(128).fill(0));r.draw(1/60);
          times.sort((a,b)=>a-b);
          return {width:c.width,height:c.height,generated:layers.length,minY,pixelsRespondToAudio:silent!==loud,scriptMedianMs:times[50],scriptP95Ms:times[95]};
        },viewport);
        assert.ok(metrics.generated>=63);assert.ok(metrics.minY>0);assert.ok(metrics.pixelsRespondToAudio);assert.deepEqual(errors,[]);
        await page.locator('canvas').screenshot({path:`${output}/${id}-${viewport.width}.png`});
        results.push({id,viewport,metrics,errors});console.log(JSON.stringify(results.at(-1)));await page.close();
      }
    }
  }finally{fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
