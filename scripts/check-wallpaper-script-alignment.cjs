const fs=require('node:fs');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.QA_BASE||'http://127.0.0.1:13014';
const out=process.env.QA_OUT||'.tmp/scene-script-alignment';
const id='11111111111111111111111111111111';
const layer={id:1,name:'box',origin:[25,25,0],scale:[1,1,1],angle:0,parallax:[1,1],size:[20,20],color:[0,0,1],alpha:1,texture:'white',passes:[],blending:'translucent',colorBlendMode:0};
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  const png=await sharp(Buffer.from([255,255,255,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
  const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--ignore-gpu-blocklist']});const results=[];
  try{
    for(const rotated of [false,true]){
      const data={version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:true,amount:1,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]}],particles:[],layers:[{...layer,scripts:[{property:'visible',properties:{},source:`export function init(){thisLayer.alignment='bottom';${rotated?"thisLayer.origin=new Vec3(75,50,0);thisLayer.angles=new Vec3(0,0,90);":""}}export function update(v){return v;}`}]}]};
      const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(id=>localStorage.setItem('omp-web:wallpaper',JSON.stringify({id,kind:'scene',paused:true,fit:'cover',brightness:100})),id);
      await page.route('**/api/sessions',r=>r.fulfill({json:{sessions:[],runningSessionIds:[],runningSessions:[]}}));
      await page.route('**/api/provider-usage*',r=>r.fulfill({json:{generatedAt:Date.now(),reports:[]}}));
      await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:data}));
      await page.route('**/qa-white.png',r=>r.fulfill({body:png,contentType:'image/png'}));
      await page.goto(base);await page.locator('html[data-wallpaper="on"]').waitFor({timeout:30000});
      const pixels=await page.locator('.wallpaper-scene').evaluate((c,rotated)=>{
        const a=document.createElement('canvas');a.width=a.height=100;const x=a.getContext('2d');x.drawImage(c,0,0,100,100);
        return (rotated?[[95,50],[75,50]]:[[5,95],[5,75]]).map(([u,v])=>Array.from(x.getImageData(u,v,1,1).data).slice(0,3));
      },rotated);
      assert.deepEqual(pixels,[[0,0,255],[0,0,0]],'alignment offset must not be parallax-expanded');assert.deepEqual(errors,[]);
      results.push({rotated,pixels,errors});await page.close();
    }
  }finally{fs.writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2));await browser.close();}
  console.log(JSON.stringify(results));
})().catch(e=>{console.error(e);process.exitCode=1;});
