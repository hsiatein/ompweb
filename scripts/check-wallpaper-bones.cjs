const fs=require('node:fs'),assert=require('node:assert/strict'),sharp=require('sharp');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.QA_BASE||'http://127.0.0.1:13012',out=process.env.QA_OUT||'.tmp/scene-bone-pixels';
const m=x=>[1,0,0,0,0,1,0,0,0,0,1,0,x,0,0,1];
const geometry={positions:[-4,-4,0,4,-4,0,4,4,0,-4,4,0],uvs:[0,0,1,0,1,1,0,1],indices:[0,1,2,0,2,3],joints:Array(16).fill(0),weights:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],bones:[{parent:-1,name:'tip',matrix:m(0)}]};
const common={size:[8,8],scale:[1,1,1],angle:0,parallax:[0,0],alpha:1,blending:'translucent',colorBlendMode:0,texture:'white',passes:[]};
const data={version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},particles:[],textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]}],layers:[
  {...common,id:1,name:'parent',origin:[30,50,0],scale:[2,1,1],color:[1,0,0],mesh:{...geometry,attachments:[{name:'hand',bone:0,matrix:m(10)}],animations:[{id:1,frames:2,fps:1,mode:'loop',tracks:[{bone:0,values:[0,10,0].flatMap(x=>[x,0,0,0,0,0,1,1,1])}]}],playback:{id:1,rate:1,blend:1}}},
  {...common,id:2,name:'child',parent:1,attachment:'hand',origin:[0,0,0],color:[0,1,0],mesh:geometry,scripts:[{property:'visible',properties:{},source:`let dragging=false;export function init(){if(thisLayer.getBoneTransform('tip').translation().x!==50)throw Error('initial world');}
    export function cursorDown(){dragging=true;}export function cursorUp(){dragging=false;}
    export function update(){if(dragging)thisLayer.setBoneTransform('tip',thisLayer.getBoneTransform('tip').translation(input.cursorWorldPosition));}`}]}]};
(async()=>{
  fs.mkdirSync(out,{recursive:true});const results=[],png=await sharp(Buffer.from([255,255,255,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
  const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11']});
  try{for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]){
    const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});
    await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:data}));await page.route('**/qa-white.png',r=>r.fulfill({body:png,contentType:'image/png'}));
    await page.goto(base+'/scene-renderer-qa');await page.waitForFunction(()=>window.sceneRendererQA);
    const before=await page.evaluate(viewport=>{const r=window.sceneRendererQA,c=document.querySelector('canvas');c.style.width=viewport.width+'px';c.style.height=viewport.height+'px';c.style.objectFit='fill';r.resizeDirty=true;r.draw(0);r.draw(.5);r.paused=false;
      const sample=()=>{const t=document.createElement('canvas');t.width=t.height=100;const x=t.getContext('2d');x.drawImage(c,0,0,100,100);return [30,40,50,60,80].map(p=>[...x.getImageData(p,50,1,1).data]);};window.sampleBones=sample;const box=c.getBoundingClientRect();return {pixels:sample(),box:{x:box.x,y:box.y,width:box.width,height:box.height}};},viewport);
    assert.ok(before.pixels[1][0]>250&&before.pixels[3][1]>250,'animation and named attachment move real pixels');
    const b=before.box,xy=x=>({x:b.x+b.width*x/100,y:b.y+b.height*.5});
    await page.mouse.move(xy(60).x,xy(60).y);await page.mouse.down();await page.mouse.move(xy(80).x,xy(80).y);
    const drag=await page.evaluate(()=>{const r=window.sceneRendererQA;r.draw(.01);return {pixels:window.sampleBones(),writes:r.scriptStates.get(2).boneWrites};});
    assert.ok(drag.pixels[4][1]>250&&drag.pixels[3][1]<5,'world-space pointer drags attached bone under scaled parent');
    assert.ok(Object.keys(drag.writes).length>0);
    await page.locator('canvas').screenshot({path:`${out}/drag-${viewport.width}.png`});
    await page.mouse.up();const release=await page.evaluate(()=>{const r=window.sceneRendererQA;r.draw(.01);return {pixels:window.sampleBones(),writes:r.scriptStates.get(2).boneWrites};});
    assert.deepEqual(release.writes,{});assert.ok(release.pixels[3][1]>250&&release.pixels[4][1]<5);
    assert.deepEqual(errors,[]);results.push({viewport,before:before.pixels,drag,release,errors});console.log(JSON.stringify(results.at(-1)));await page.close();
  }}finally{fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
