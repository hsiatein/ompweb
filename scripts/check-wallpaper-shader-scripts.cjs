const fs=require('node:fs'),assert=require('node:assert/strict'),sharp=require('sharp');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.QA_BASE||'http://127.0.0.1:13012',out=process.env.QA_OUT||'.tmp/scene-shader-scripts';
const vertex='precision highp float;attribute vec3 a_Position;attribute vec2 a_TexCoord;varying vec2 uv;uniform mat4 g_ModelViewProjectionMatrix;void main(){uv=a_TexCoord;gl_Position=g_ModelViewProjectionMatrix*vec4(a_Position,1.0);}';
const binding=(property,source)=>({property,source,properties:{}});
const tint={vertex,fragment:'precision highp float;uniform vec3 u_Color;void main(){gl_FragColor=vec4(u_Color,1.0);}',uniforms:{u_Color:[1,0,0]},textures:[null],repeats:[],scripts:[binding('u_Color',`import * as WEColor from 'WEColor';export function update(){return WEColor.hsv2rgb(new Vec3(engine.runtime,1,1));}`)]};
const fade={vertex,fragment:'precision highp float;varying vec2 uv;uniform sampler2D g_Texture0;uniform float u_Opacity;void main(){gl_FragColor=texture2D(g_Texture0,uv)*u_Opacity;}',uniforms:{u_Opacity:0},textures:[null],repeats:[],scripts:[binding('u_Opacity',`import * as WEMath from 'WEMath';const a=engine.registerAudioBuffers(16);export function init(){return 0;}export function update(v){return WEMath.mix(v,a.average[0],engine.frametime);}`)]};
const layer={id:1,name:'meter',origin:[50,50,0],size:[80,80],scale:[1,1,1],angle:0,parallax:[0,0],color:[1,1,1],alpha:1,blending:'translucent',colorBlendMode:0,texture:'white',passes:[tint,fade]};
const scene={version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]}],particles:[],layers:[layer]};
(async()=>{
 fs.mkdirSync(out,{recursive:true});const white=await sharp(Buffer.from([255,255,255,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
 const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--ignore-gpu-blocklist']});const results=[];
 try{for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}]){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:scene}));await page.route('**/qa-white.png',r=>r.fulfill({body:white,contentType:'image/png'}));
  await page.goto(base+'/scene-renderer-qa');await page.waitForFunction(()=>window.sceneRendererQA);
  const result=await page.evaluate(()=>{
   const r=window.sceneRendererQA,c=document.querySelector('canvas');r.setPaused(true);
   const pixel=()=>{const a=document.createElement('canvas');a.width=a.height=100;const x=a.getContext('2d');x.drawImage(c,0,0,100,100);return Array.from(x.getImageData(50,50,1,1).data);};
   r.time=1/3;r.draw(0);const silent=pixel();
   r.spectrum=Array(128).fill(1);r.time=1/3-.5;r.draw(.5);const green=pixel();
   r.time=2/3;r.draw(0);const blue=pixel();r.spectrum.fill(0);r.time=2/3-.5;r.draw(.5);const dim=pixel();
   return{silent,green,blue,dim,bindings:r.scriptUniforms.get(1).map(p=>Object.keys(p))};
  });
  assert.ok(result.silent.slice(0,3).every(v=>v<3));assert.ok(result.green[1]>50&&result.green[0]<3&&result.green[2]<3);
  assert.ok(result.blue[2]>50&&result.blue[0]<3&&result.blue[1]<3);assert.ok(result.dim[2]<result.blue[2]/2);assert.deepEqual(errors,[]);
  await page.screenshot({path:`${out}/${viewport.width}.png`});results.push({viewport,...result,errors});await page.close();
 }
 const clone=structuredClone(scene);clone.layers[0].origin=[25,50,0];clone.layers[0].size=[20,20];clone.layers[0].passes=[{...tint,scripts:[binding('u_Color',`export function update(){return thisLayer.origin.x<50?new Vec3(1,0,0):new Vec3(0,1,0);}`)]}];
 clone.scriptTemplates={'models/bar.json':{...clone.layers[0],id:0,scripts:undefined}};
 clone.layers[0].scripts=[binding('visible',`export function init(){const b=thisScene.createLayer('models/bar.json');b.origin=new Vec3(75,50,0);}`)];
 const page=await browser.newPage({viewport:{width:1000,height:1000}});await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:clone}));await page.route('**/qa-white.png',r=>r.fulfill({body:white,contentType:'image/png'}));
 await page.goto(base+'/scene-renderer-qa');await page.waitForFunction(()=>window.sceneRendererQA);
 const colors=await page.evaluate(()=>{const r=window.sceneRendererQA;r.setPaused(true);r.draw(0);return [...r.scriptUniforms].map(([id,p])=>({id,value:p[0].u_Color.value}));});
 assert.deepEqual(colors,[{id:1,value:[1,0,0]},{id:-1,value:[0,1,0]}]);await page.close();results.push({cloneColors:colors});
 fs.writeFileSync(`${out}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
