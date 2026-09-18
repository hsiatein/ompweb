const fs=require('node:fs'),assert=require('node:assert/strict'),sharp=require('sharp');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.QA_BASE||'http://127.0.0.1:13012',out=process.env.QA_OUT||'.tmp/scene-clipping-pixels';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],samples=xs=>xs.flatMap(x=>[x,0,0,0,0,0,1,1,1]);
const scene={version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},particles:[],textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]},{key:'mask',url:'/qa-mask.png',width:8,height:8,format:0,frames:[]}],layers:[{id:1,name:'Clipped image',origin:[50,50,0],size:[80,80],scale:[1,1,1],angle:0,parallax:[0,0],color:[1,1,1],alpha:1,blending:'translucent',colorBlendMode:0,texture:'white',passes:[],mesh:{positions:[-40,-40,0,40,-40,0,40,40,0,-40,40,0],uvs:[0,0,1,0,1,1,0,1],indices:[0,1,2,0,2,3],joints:Array(4).fill([1,0,0,0]).flat(),weights:Array(4).fill([1,0,0,0]).flat(),bones:[{parent:-1,matrix:identity},{parent:0,matrix:identity}],editedPose:[identity,identity],clips:[{texture:'mask',bonePath:[0],target:1,vertices:[0,1,2,3]}],animations:[{id:1,frames:2,fps:1,mode:'once',tracks:[{bone:0,values:samples([0,20,0])},{bone:1,values:samples([0,-20,0])}]}],playback:{id:1,rate:1,blend:1}}}]};
(async()=>{
  fs.mkdirSync(out,{recursive:true});const results=[],pixels=Buffer.alloc(8*8*4);for(let y=0;y<8;y++)for(let x=0;x<8;x++){const i=(y*8+x)*4;pixels[i]=x>=4?255:0;pixels[i+3]=255;}
  const mask=await sharp(pixels,{raw:{width:8,height:8,channels:4}}).png().toBuffer(),white=await sharp(Buffer.from([255,255,255,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
  const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11']});
  try{for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]){
    const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});
    await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:scene}));await page.route('**/qa-white.png',r=>r.fulfill({body:white,contentType:'image/png'}));await page.route('**/qa-mask.png',r=>r.fulfill({body:mask,contentType:'image/png'}));
    await page.goto(base+'/scene-renderer-qa');await page.waitForFunction(()=>window.sceneRendererQA);
    const values=await page.evaluate(viewport=>{const r=window.sceneRendererQA,c=document.querySelector('canvas');c.style.width=viewport.width+'px';c.style.height=viewport.height+'px';c.style.objectFit='fill';r.resizeDirty=true;r.draw(0);
      const sample=()=>{const t=document.createElement('canvas');t.width=t.height=100;const x=t.getContext('2d');x.drawImage(c,0,0,100,100);return [20,40,60,80].map(p=>x.getImageData(p,50,1,1).data[0]);};const before=sample();r.draw(1);const moving=sample();r.draw(1);return {before,moving,returning:sample()};},viewport);
    assert.ok(values.before[0]<3&&values.before[1]<3&&values.before[2]>250&&values.before[3]>250);assert.ok(values.moving[2]<3&&values.moving[3]>250,'mask follows its bone independently from target bone');assert.deepEqual(values.returning,values.before);assert.deepEqual(errors,[]);
    await page.locator('canvas').screenshot({path:`${out}/clipping-${viewport.width}.png`});results.push({viewport,values,errors});console.log(JSON.stringify(results.at(-1)));await page.close();
  }}finally{fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
