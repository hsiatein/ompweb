const fs = require('node:fs');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13012';
const output = process.env.QA_OUT || '.tmp/scene-property-pixels';
const layer = {id:1,name:'script',origin:[25,50,0],size:[20,20],scale:[1,1,1],angle:0,parallax:[0,0],color:[1,0,0],alpha:1,blending:'translucent',colorBlendMode:0,texture:'white',passes:[]};
const data = {version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]}],particles:[],
  scriptTemplates:{'models/box.json':{...layer,color:[0,0,1]}},layers:[{...layer,scripts:[{property:'visible',properties:{},source:`
    let clone;const audio=engine.registerAudioBuffers(64);
    export function init(){clone=thisScene.createLayer('models/box.json');}
    export function update(){clone.origin=new Vec3(25+engine.runtime*50,50,0);clone.scale=new Vec3(1+audio.average[0]);}
  `}]}]};
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const png=await sharp(Buffer.from([255,255,255,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
  const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--ignore-gpu-blocklist']});
  const results=[];
  try{
    for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]){
      const page=await browser.newPage({viewport}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:data}));
      await page.route('**/qa-white.png',r=>r.fulfill({body:png,contentType:'image/png'}));
      await page.goto(`${base}/scene-renderer-qa`);
      await page.waitForFunction(()=>window.sceneRendererQA);
      const metrics=await page.evaluate(viewport=>{
        const r=window.sceneRendererQA,c=document.querySelector('canvas');
        c.style.width=viewport.width+'px';c.style.height=viewport.height+'px';r.resizeDirty=true;r.draw(0);
        const sample=()=>{const a=document.createElement('canvas');a.width=a.height=100;const x=a.getContext('2d');x.drawImage(c,0,0,100,100);return [25,38,75,88].map(n=>Array.from(x.getImageData(n,50,1,1).data).slice(0,3));};
        const before=sample();r.draw(.5);r.draw(.5);const moved=sample();
        const update=r.propertyScripts.update.bind(r.propertyScripts);r.propertyScripts.update=(time,dt)=>update(time,dt,Array(128).fill(1));r.draw(0);const audio=sample();
        r.draw(0);const paused=sample();
        return {before,moved,audio,paused,layers:c.dataset.scriptLayerCount,warnings:JSON.parse(c.dataset.compatibilityWarnings||'[]'),width:c.width,height:c.height};
      },viewport);
      assert.deepEqual(metrics.before[0],[0,0,255],'new layer is in front');
      assert.deepEqual(metrics.moved[0],[255,0,0],'original layer remains unchanged');
      assert.deepEqual(metrics.moved[2],[0,0,255],'script moves actual pixels');
      assert.deepEqual(metrics.moved[3],[0,0,0]);assert.deepEqual(metrics.audio[3],[0,0,255],'injected audio enlarges actual geometry');
      assert.deepEqual(metrics.paused,metrics.audio);assert.equal(metrics.layers,'2');assert.deepEqual(errors,[]);
      assert.ok(metrics.warnings.some(s=>s.includes('need wallpaper audio')));
      await page.locator('canvas').screenshot({path:`${output}/script-${viewport.width}.png`});
      results.push({viewport,metrics,errors});console.log(JSON.stringify(results.at(-1)));await page.close();
    }
  }finally{fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
