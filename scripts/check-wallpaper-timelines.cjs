const fs=require('node:fs'),assert=require('node:assert/strict'),sharp=require('sharp');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.QA_BASE||'http://127.0.0.1:13012',out=process.env.QA_OUT||'.tmp/scene-timeline-pixels';
const close=(values,expected)=>values.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<1e-6,`${values} != ${expected}`));
const layer={id:1,name:'red',origin:[50,50,0],size:[80,80],scale:[1,1,1],angle:0,parallax:[0,0],color:[1,0,0],alpha:1,blending:'translucent',colorBlendMode:0,texture:'white',passes:[]};
const timeline=(values)=>({property:'alpha',name:'fade',fps:30,frames:120,mode:'single',startPaused:true,wrapLoop:false,relative:false,base:[1],channels:[values.map((value,i)=>({frame:i*60,value,step:false}))]});
const control=(id,target)=>({...layer,id,name:'control'+id,alpha:0,scripts:[{property:'visible',properties:{},source:`export function cursorClick(){const a=thisScene.getLayer('${target}').getAnimation('fade');a.play();engine.setTimeout(()=>a.pause(),2000);}`} ]});
const scene={version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},particles:[],textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]}],layers:[{...layer,timelines:[timeline([1,0,1])]},{...layer,id:2,name:'green',color:[0,1,0],timelines:[timeline([0,1,0])]},control(3,'red'),control(4,'green')]};
(async()=>{
  fs.mkdirSync(out,{recursive:true});const results=[],png=await sharp(Buffer.from([255,255,255,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
  const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--disable-accelerated-video-decode']});
  try{for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]){
    const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});
    await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:scene}));await page.route('**/qa-white.png',r=>r.fulfill({body:png,contentType:'image/png'}));
    await page.goto(base+'/scene-renderer-qa');await page.waitForFunction(()=>window.sceneRendererQA);
    await page.evaluate(viewport=>{const r=window.sceneRendererQA,c=document.querySelector('canvas');document.body.style.margin='0';c.style.width=viewport.width+'px';c.style.height=viewport.height+'px';c.style.objectFit='fill';r.resizeDirty=true;r.draw(0);r.paused=false;
      window.sampleTimeline=()=>{const t=document.createElement('canvas');t.width=t.height=10;const x=t.getContext('2d');x.drawImage(c,0,0,10,10);return [...x.getImageData(5,5,1,1).data];};
    },viewport);
    const draw=dt=>page.evaluate(dt=>{const r=window.sceneRendererQA;r.draw(dt);return {pixel:window.sampleTimeline(),alphas:[1,2].map(id=>r.scriptStates.get(id).alpha),warnings:r.scriptWarnings};},dt);
    let frame=await draw(0);assert.deepEqual(frame.alphas,[1,0]);assert.ok(frame.pixel[0]>250&&frame.pixel[1]<2);
    for(let cycle=0;cycle<3;cycle++){
      await page.mouse.click(viewport.width/2,viewport.height/2);await draw(0);await draw(.8);await draw(.9);frame=await draw(.7);
      const green=cycle%2===0;close(frame.alphas,green?[0,1]:[1,0]);assert.ok(frame.pixel[green?1:0]>250&&frame.pixel[green?0:1]<2);assert.deepEqual(frame.warnings,[]);
      await page.locator('canvas').screenshot({path:`${out}/cycle-${cycle}-${viewport.width}.png`});
    }
    await page.evaluate(()=>{window.sceneRendererQA.scriptLayers.get(4).layer.disablePropagation=true;});
    await page.mouse.click(viewport.width/2,viewport.height/2);await draw(0);await draw(1);frame=await draw(1);
    close(frame.alphas,[0,0]);
    await page.evaluate(()=>{const b=document.createElement('button');b.id='block';b.textContent='UI';b.style.cssText='position:fixed;inset:40%';document.body.append(b);});
    await page.locator('#block').click();await draw(0);await draw(1);frame=await draw(1);close(frame.alphas,[0,0]);
    assert.deepEqual(errors,[]);results.push({viewport,cycles:3,blocking:true,errors});await page.close();
  }}finally{fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));await browser.close();}
  console.log(JSON.stringify(results));
})().catch(e=>{console.error(e);process.exitCode=1});
