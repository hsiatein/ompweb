const fs = require('node:fs');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13012';
const output = process.env.QA_OUT || '.tmp/scene-animation-pixels';
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const scene = {version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]}],layers:[],particles:[]};
const mesh = {...scene,layers:[{id:1,name:'Skin fixture',origin:[50,50,0],size:[100,100],scale:[1,1,1],angle:0,parallax:[0,0],color:[1,1,1],alpha:1,blending:'translucent',colorBlendMode:0,texture:'white',passes:[],
  mesh:{positions:[-40,20,0,-20,20,0,-40,-20,0],uvs:[0,0,1,0,0,1],indices:[0,1,2],joints:Array(12).fill(0),weights:[1,0,0,0,1,0,0,0,1,0,0,0],bones:[{parent:-1,matrix:identity}],
    animations:[{id:1,frames:2,fps:1,mode:'loop',tracks:[{bone:0,values:[0,40,0].flatMap(x=>[x,0,0,0,0,0,1,1,1])}]}],playback:{id:1,rate:1,blend:1}}}]};
const rope = {...scene,particles:[{id:2,origin:[20,50,0],scale:[1,1,1],angle:0,parallax:[0,0],texture:'white',blending:'translucent',overrides:{},children:[],config:{maxcount:10,emitter:[{name:'sphererandom',rate:2}],initializer:[{name:'lifetimerandom',min:10,max:10},{name:'velocityrandom',min:'40 0',max:'40 0'},{name:'sizerandom',min:10,max:10}],renderer:[{name:'rope',subdivision:3}]}}]};
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const png=await sharp(Buffer.from([255,255,255,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
  const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--ignore-gpu-blocklist']});
  const results=[];
  try {
    for(const [name,data] of [['skin',mesh],['rope',rope]])for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]){
      const page=await browser.newPage({viewport}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
      await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:data}));
      await page.route('**/qa-white.png',r=>r.fulfill({body:png,contentType:'image/png'}));
      await page.goto(`${base}/scene-renderer-qa`);
      await page.waitForFunction(()=>window.sceneRendererQA);
      const metrics=await page.evaluate(({name,viewport})=>{
        const r=window.sceneRendererQA,canvas=document.querySelector('canvas');
        canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';r.resizeDirty=true;r.draw(0);
        const sample=()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.drawImage(canvas,0,0,100,100);return [[15,40],[35,40],[50,50],[50,30]].map(([a,b])=>x.getImageData(a,b,1,1).data[0]);};
        const before=sample();r.draw(.5);if(name==='rope')r.draw(.5);const after=sample();r.draw(0);
        return {before,after,paused:sample(),width:canvas.width,height:canvas.height};
      },{name,viewport});
      console.log(name,viewport,metrics,errors);
      if(name==='skin'){assert.ok(metrics.before[0]>250&&metrics.before[1]<2);assert.ok(metrics.after[0]<2&&metrics.after[1]>250,'vertex motion must change actual pixels');}
      else {assert.ok(metrics.before[2]<2&&metrics.after[2]>250,'living particles must be joined by a visible ribbon');assert.ok(metrics.after[3]<2,'rope is not a full-screen sprite');}
      assert.deepEqual(metrics.after,metrics.paused);assert.deepEqual(errors,[]);
      assert.ok(metrics.width>=Math.max(viewport.width,viewport.height),'native-resolution canvas');
      await page.locator('canvas').screenshot({path:`${output}/${name}-${viewport.width}.png`});
      results.push({name,viewport,metrics,errors});console.log(JSON.stringify(results.at(-1)));await page.close();
    }
  } finally {fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
