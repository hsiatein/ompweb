const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13012';
const out = process.env.QA_OUT || '.tmp/scene-text-pixels';
// Dedicated preview route only. No user's wallpaper preferences or art are used.
(async () => {
  fs.mkdirSync(out, {recursive:true});
  const browser = await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--ignore-gpu-blocklist']});
  const errors = [], results = [];
  try {
    for (const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]) {
      const page = await browser.newPage({viewport});
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => {if(m.type()==='error')errors.push(m.text())});
      const scene = {version:1,width:800,height:400,clearColor:[.07,.1,.12],particles:[],textures:[],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},layers:[{
        id:1,name:'Clock',origin:[400,200,0],size:[700,250],scale:[1,1,1],angle:.08,parallax:[0,0],color:[1,1,1],alpha:1,texture:'@text:1',blending:'translucent',colorBlendMode:0,passes:[],text:{font:'@system:sans-serif',value:'',properties:{},pointSize:48,padding:0,horizontal:'center',vertical:'center',script:`export function update(){return 'Clock: '+new Date().getUTCSeconds()+'\\nTEXT 123';}`}
      }]};
      await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:scene}));
      await page.goto(`${base}/scene-renderer-qa`);
      await page.waitForFunction(()=>window.sceneRendererQA);
      const before=await page.evaluate(()=>{
        const r=window.sceneRendererQA;r.canvas.style.width='100vw';r.canvas.style.height='100vh';
        r.textLayers[0].nextUpdate=0;r.textLayers[0].update(1,1000);r.draw(0);
        return {value:r.textLayers[0].previous,image:r.canvas.toDataURL()};
      });
      const after=await page.evaluate(()=>{
        const r=window.sceneRendererQA;r.textLayers[0].update(2,2000);r.draw(0);
        const src=r.textLayers[0].canvas,ctx=src.getContext('2d'),p=ctx.getImageData(0,0,src.width,src.height).data;
        let visible=0;for(let i=3;i<p.length;i+=4)if(p[i]>100)visible++;
        return {value:r.textLayers[0].previous,image:r.canvas.toDataURL(),visible,width:r.canvas.width,height:r.canvas.height};
      });
      assert.equal(before.value,'Clock: 1\nTEXT 123');assert.equal(after.value,'Clock: 2\nTEXT 123');
      assert.notEqual(before.image,after.image);assert.ok(after.visible>2000);
      await page.locator('canvas').first().screenshot({path:`${out}/text-${viewport.width}.png`});
      await page.evaluate(()=>window.sceneRendererQA.dispose());
      results.push({viewport,value:after.value,visiblePixels:after.visible,width:after.width,height:after.height});
      await page.close();
    }
    assert.deepEqual(errors,[]);
  } finally {await browser.close();fs.writeFileSync(`${out}/results.json`,JSON.stringify({results,errors},null,2));}
  console.log(JSON.stringify(results));
})().catch(e=>{console.error(e);process.exitCode=1});
