/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA runner. */
const fs=require('node:fs');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.QA_BASE||'http://127.0.0.1:13012';
const vertex='precision highp float; attribute vec3 a_Position; attribute vec2 a_TexCoord; uniform mat4 g_ModelViewProjectionMatrix; varying vec2 uv; void main(){uv=a_TexCoord;gl_Position=g_ModelViewProjectionMatrix*vec4(a_Position,1.0);}';
const pass=(body,inputs)=>({vertex,fragment:'precision highp float; varying vec2 uv; uniform sampler2D g_Texture0; uniform sampler2D g_Texture1; void main(){'+body+'}',textures:[null,null],repeats:[],uniforms:{},inputs});
const layer=(extra={})=>({id:1,name:'fixture',origin:[50,50,0],size:[100,100],scale:[1,1,1],angle:0,parallax:[0,0],color:[1,1,1],alpha:1,blending:'translucent',colorBlendMode:0,texture:'base',passes:[],...extra});
const scene=(layers,textures)=>({version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},particles:[],layers,textures});
(async()=>{
 const catalog=await(await fetch(`${base}/api/wallpapers`)).json();
 const id=process.env.QA_ID||catalog.wallpapers.find(w=>w.kind==='scene')?.id;
 if(!id)throw new Error('The UI fixture needs one scene catalog entry.');
 const output=process.env.QA_OUT||'.tmp/scene-renderer-regression';fs.mkdirSync(output,{recursive:true});
 const images={};
 for(const [name,color] of Object.entries({base:[51,102,153,255],top:[102,204,51,128],white:[255,255,255,255],normal:[128,255,0,255]}))images[name]=await sharp(Buffer.from(color),{raw:{width:1,height:1,channels:4}}).png().toBuffer();
 images.quad=await sharp(Buffer.from([255,0,0,255,0,255,0,255,0,0,255,255,255,255,0,255]),{raw:{width:2,height:2,channels:4}}).png().toBuffer();
 const textures=Object.keys(images).map(key=>({key,url:`/api/wallpapers/${id}/scene-assets/${key}`,width:key==='quad'?2:1,height:key==='quad'?2:1,format:0,frames:[]}));
 const fixtures=[
  ['branch',scene([layer({passes:[pass('gl_FragColor=vec4(1.0-texture2D(g_Texture0,uv).rgb,1.0);',{0:-1}),pass('gl_FragColor=vec4(texture2D(g_Texture0,uv).rgb*0.5,1.0);',{0:0}),pass('gl_FragColor=mix(texture2D(g_Texture0,uv),texture2D(g_Texture1,uv),0.5);',{0:1,1:-1})]})],textures),[77,89,102]],
  ['lighten',scene([layer(),layer({id:2,texture:'top',colorBlendMode:6})],textures),[77,153,153]],
  ['vivid',scene([layer(),layer({id:2,texture:'top',colorBlendMode:14})],textures),[26,179,77]],
  ['reflect-blend',scene([layer(),layer({id:2,texture:'top',colorBlendMode:21})],textures),[34,153,134]],
  ['reflect-blend-transparent',scene([layer(),layer({id:2,texture:'top',colorBlendMode:21,alpha:0})],textures),[51,102,153]],
  ['reflect-blend-white',scene([layer(),layer({id:2,texture:'white',colorBlendMode:21})],textures),[255,255,255]],
  ['reflect-blend-tint',scene([layer(),layer({id:2,texture:'white',color:[.4,.8,.2],alpha:.5,colorBlendMode:21})],textures),[34,153,134]],
  ['reflect-blend-stacked',scene([layer(),layer({id:2,texture:'top',colorBlendMode:21}),layer({id:3,texture:'white',colorBlendMode:21,alpha:.5})],textures),[145,204,194]],
  ['additive-blend',scene([layer(),layer({id:2,texture:'top',colorBlendMode:31})],textures),[102,204,179]],
  ['additive-blend-transparent',scene([layer(),layer({id:2,texture:'top',colorBlendMode:31,alpha:0})],textures),[51,102,153]],
  ['additive-blend-saturated',scene([layer(),layer({id:2,texture:'white',colorBlendMode:31,alpha:.5})],textures),[179,230,255]],
  ['composition-empty',scene([layer(),layer({id:2,texture:'@transparent',composition:true,colorBlendMode:21})],textures),[51,102,153]],
  ['composition-reflect',scene([layer(),layer({id:2,texture:'@transparent',composition:true,colorBlendMode:21}),layer({id:3,parent:2,origin:[0,0,0],texture:'top'})],textures),[34,153,134]],
  ['composition-alpha',scene([layer(),layer({id:2,texture:'@transparent',composition:true}),layer({id:3,parent:2,origin:[0,0,0],texture:'top'})],textures),[77,153,102]],
  ['composition-hidden-child',scene([layer(),layer({id:2,texture:'@transparent',composition:true,colorBlendMode:21}),layer({id:3,parent:2,origin:[0,0,0],texture:'top',visible:false})],textures),[51,102,153]],
  ['composition-nested',scene([layer(),layer({id:2,texture:'@transparent',composition:true,colorBlendMode:21}),layer({id:3,parent:2,origin:[0,0,0],texture:'@transparent',composition:true}),layer({id:4,parent:3,origin:[0,0,0],texture:'top'})],textures),[34,153,134]],
  ['quad',scene([layer({texture:'quad'})],textures)],
  ['procedural',scene([layer({texture:'@transparent',passes:[pass('gl_FragColor=vec4(0.2,0.4,0.6,1.0);',{0:-1})]})],textures),[51,102,153]],
  ['refraction',{...scene([layer({texture:'quad'})],textures.map(t=>t.key==='normal'?{...t,format:8}:t)),particles:[{id:5,origin:[50,50,0],scale:[1,1,1],angle:0,parallax:[0,0],texture:'white',blending:'translucent',refraction:{texture:'normal',amount:.8},config:{maxcount:1,emitter:[{name:'sphererandom',instantaneous:1,rate:0}],initializer:[{name:'sizerandom',min:100,max:100}]},overrides:{},children:[]}]}],
  ['capture',scene([layer({texture:'quad'}),layer({id:2,texture:'@scene',origin:[75,25,0],size:[50,50],passes:[pass('gl_FragColor=vec4(1.0-texture2D(g_Texture0,uv).rgb,1.0);',{0:-1})]})],textures)],
  ['atlas',scene([layer({texture:'quad'})],textures.map(t=>t.key==='quad'?{...t,frames:[{x:1,y:0,width:1,height:1,duration:1,axes:[0,1,-1,0]}]}:t))],
  ['pointer',scene([layer({origin:[75,25,0],size:[50,50],passes:[{...pass('vec4 p=g_EffectTextureProjectionMatrixInverse*vec4(g_PointerPosition.x*2.0-1.0,1.0-g_PointerPosition.y*2.0,0.0,1.0);gl_FragColor=vec4(p.xy/p.w*0.5+0.5,0.0,1.0);',{0:-1}),fragment:'precision highp float;uniform mat4 g_EffectTextureProjectionMatrixInverse;uniform vec2 g_PointerPosition;void main(){vec4 p=g_EffectTextureProjectionMatrixInverse*vec4(g_PointerPosition.x*2.0-1.0,1.0-g_PointerPosition.y*2.0,0.0,1.0);gl_FragColor=vec4(p.xy/p.w*0.5+0.5,0.0,1.0);}'}]})],textures)],
 ];
 const refracted=structuredClone(fixtures.find(f=>f[0]==='refraction')[1]);refracted.particles[0].angle=Math.PI/2;
 fixtures.push(['refraction-rotated',refracted]);
 const neutral=structuredClone(refracted);delete neutral.particles[0].refraction.texture;
 fixtures.push(['refraction-neutral',neutral]);
 const reflect=scene([layer({texture:'quad'}),layer({id:2,texture:'base',reflection:{normal:'normal',roughness:0,metallic:.5,reflectivity:1}})],textures);
 fixtures.push(['reflection',reflect]);
 fixtures.push(['mesh',scene([layer({texture:'white',mesh:{positions:[-50,50,0,50,50,0,-50,-50,0],uvs:[0,0,1,0,0,1],indices:[0,1,2]}})],textures)]);
 const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--ignore-gpu-blocklist']});
 const results=[];
 try{
  for(const [name,data,expected]of fixtures.filter(f=>!process.env.QA_FIXTURE||f[0]===process.env.QA_FIXTURE)){
   const page=await browser.newPage({viewport:{width:1000,height:1000}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
   await page.addInitScript(id=>localStorage.setItem('omp-web:wallpaper',JSON.stringify({id,kind:'scene',paused:true,brightness:100,fit:'cover',glass:'clear'})),id);
   await page.route('**/api/sessions',r=>r.fulfill({json:{sessions:[],runningSessionIds:[],runningSessions:[]}}));
   await page.route('**/api/provider-usage*',r=>r.fulfill({json:{generatedAt:Date.now(),reports:[]}}));
   await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:data}));
   await page.route('**/api/wallpapers/*/scene-assets/*',r=>r.fulfill({body:images[r.request().url().split('/').pop()],contentType:'image/png'}));
   await page.goto(base);
   await page.waitForFunction(()=>document.documentElement.dataset.wallpaper==='on',null,{timeout:30000});
   const pixels=await page.evaluate(()=>{const src=document.querySelector('canvas'),c=document.createElement('canvas');c.width=100;c.height=100;const ctx=c.getContext('2d');ctx.drawImage(src,0,0,100,100);return [[50,50],[10,10],[90,10],[10,90],[90,90]].map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data));});
   results.push({name,pixels,errors});console.log(name,JSON.stringify(pixels),errors);
   await page.locator('canvas').first().screenshot({path:`${output}/${name}.png`});
   if(expected)expected.forEach((v,i)=>assert.ok(Math.abs(pixels[0][i]-v)<=3,`${name}: channel ${i} = ${pixels[0][i]} expected ${v}`));
   if(name==='pointer'){
    await page.mouse.move(750,750);
    await page.evaluate(()=>{const key='omp-web:wallpaper';localStorage.setItem(key,JSON.stringify({...JSON.parse(localStorage.getItem(key)),paused:false}));dispatchEvent(new Event('omp-web:wallpaper-preferences'));});
    await page.waitForTimeout(250);
    const after=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=100;const x=c.getContext('2d');x.drawImage(document.querySelector('canvas'),0,0,100,100);return Array.from(x.getImageData(90,90,1,1).data)});
    assert.ok(after[0]>=125&&after[0]<=130&&after[1]>=125&&after[1]<=130,'screen cursor must project to the off-center layer origin');
    results[results.length-1].pointerAfter=after;
   }
   assert.deepEqual(errors,[]);await page.close();
  }
  if(process.env.QA_FIXTURE)return;
  const plain=results.find(x=>x.name==='quad').pixels,capture=results.find(x=>x.name==='capture').pixels;
  for(let p=1;p<5;p++)for(let i=0;i<3;i++)assert.ok(Math.abs(capture[p][i]-(p===4?255-plain[p][i]:plain[p][i]))<=4,'capture must only invert the lower-right region');
  const atlas=results.find(x=>x.name==='atlas').pixels;
  const refract=results.find(x=>x.name==='refraction').pixels;
  for(const [dst,src]of [[1,2],[2,2],[3,4],[4,4]])for(let i=0;i<3;i++)assert.ok(Math.abs(refract[dst][i]-plain[src][i])<=5,'normal map must offset the background, not render a white particle');
  const refractRotated=results.find(x=>x.name==='refraction-rotated').pixels;
  for(const [dst,src]of [[1,1],[2,2],[3,1],[4,2]])for(let i=0;i<3;i++)assert.ok(Math.abs(refractRotated[dst][i]-plain[src][i])<=5,'normal refraction follows the system rotation');
  const refractNeutral=results.find(x=>x.name==='refraction-neutral').pixels;
  for(let p=1;p<5;p++)for(let i=0;i<3;i++)assert.ok(Math.abs(refractNeutral[p][i]-plain[p][i])<=5,'refraction without a normal map samples the unshifted background');
  for(const [dst,src]of [[1,2],[2,4],[3,1],[4,3]])for(let i=0;i<3;i++)assert.ok(Math.abs(atlas[dst][i]-plain[src][i])<=4,'atlas rotation');
  const reflected=results.find(x=>x.name==='reflection').pixels;
  for(let p=1;p<5;p++)for(let i=0;i<3;i++)assert.ok(Math.abs(reflected[p][i]-Math.min(255,[51,102,153][i]+255*Math.pow(plain[p][i]/255*.999,1.5)))<=7,'reflection must add the correctly oriented background using the normal and Fresnel term');
  const mesh=results.find(x=>x.name==='mesh').pixels;
  assert.ok(mesh[1][0]>250&&mesh[4][0]<2,'mesh must use the authored triangle, not a fallback full-screen rectangle');
 }finally{fs.writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
