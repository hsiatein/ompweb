const fs=require('node:fs'),assert=require('node:assert/strict'),sharp=require('sharp');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.QA_BASE||'http://127.0.0.1:13012',out=process.env.QA_OUT||'.tmp/scene-interaction-pixels';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const geometry={positions:[-40,-40,0,40,-40,0,40,40,0,-40,40,0],uvs:[0,0,1,0,1,1,0,1],indices:[0,1,2,0,2,3],joints:Array(16).fill(0),weights:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],bones:[{parent:-1,matrix:identity}]};
const layer={id:1,name:'button',origin:[50,50,0],size:[80,80],scale:[1,1,1],angle:0,parallax:[0,0],color:[1,1,1],alpha:1,blending:'translucent',colorBlendMode:0,texture:'white',passes:[]};
const scene={version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},particles:[],textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]}],layers:[]};
const opacity={...scene,layers:[{...layer,mesh:{...geometry,animations:[{id:1,frames:2,fps:1,mode:'single',tracks:[{bone:0,values:Array.from({length:3},()=>[0,0,0,0,0,0,1,1,1]).flat()}],opacity:[[1,.5,0]]}],playback:{id:1,rate:1,blend:1}}}]};
const sounds=[{id:2,name:'voice',files:[{key:'tone',url:'/qa-tone.wav',mimeType:'audio/wav'}],volume:.7,mode:'single',startSilent:true,minTime:0,maxTime:0}];
const interaction={...scene,sounds,layers:[{...layer,scripts:[{property:'visible',properties:{},source:`let hits=0;
  export function cursorEnter(){thisLayer.color=new Vec3(0,1,0);}
  export function cursorLeave(){thisLayer.color=new Vec3(1);}
  export function cursorMove(e){if(e.localPosition.x<0||e.localPosition.x>80)throw Error('localPosition');}
  export function cursorClick(){hits++;thisLayer.color=new Vec3(1,0,0);thisScene.getLayer('voice').play();thisScene.getLayer('voice').volume=.2;engine.setTimeout(()=>{thisLayer.alpha=.5;},100);}
  export function update(){thisLayer.angles=new Vec3(0,0,hits);return true;}`}]}]};
function tone(){const n=48000*3,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);for(let i=0;i<n;i++)b.writeInt16LE(Math.round(Math.sin(i/48000*Math.PI*880)*5000),44+i*2);return b;}
(async()=>{
  fs.mkdirSync(out,{recursive:true});const results=[],png=await sharp(Buffer.from([255,255,255,255]),{raw:{width:1,height:1,channels:4}}).png().toBuffer(),wav=tone();
  const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--autoplay-policy=user-gesture-required']});
  try{for(const viewport of [{width:1280,height:800},{width:390,height:844},{width:3840,height:2160}])for(const [kind,data]of [['opacity',opacity],['interaction',interaction]]){
    const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});
    await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:data}));await page.route('**/qa-white.png',r=>r.fulfill({body:png,contentType:'image/png'}));await page.route('**/qa-tone.wav',r=>r.fulfill({body:wav,contentType:'audio/wav'}));
    await page.goto(base+'/scene-renderer-qa');await page.waitForFunction(()=>window.sceneRendererQA);
    await page.evaluate(({viewport,sounds,kind})=>{const r=window.sceneRendererQA,c=document.querySelector('canvas');document.body.style.margin='0';c.style.width=viewport.width+'px';c.style.height=viewport.height+'px';c.style.objectFit='fill';r.resizeDirty=true;r.draw(0);
      window.sampleInteraction=()=>{const t=document.createElement('canvas');t.width=t.height=10;const x=t.getContext('2d');x.drawImage(c,0,0,10,10);return [...x.getImageData(5,5,1,1).data];};
      if(kind==='interaction'){window.audioTest=new window.wallpaperAudioQA.WallpaperAudio(sounds,{volume:30,muted:false,paused:false});r.setAudio(window.audioTest);r.paused=false;}
    },{viewport,sounds,kind});
    if(kind==='opacity'){
      const values=await page.evaluate(()=>{const r=window.sceneRendererQA,a=[window.sampleInteraction()];r.draw(1);a.push(window.sampleInteraction());r.draw(1);a.push(window.sampleInteraction());return a;});
      assert.ok(values[0][0]>250&&values[1][0]>110&&values[1][0]<145&&values[2][0]<3,'bone opacity must change actual pixels');results.push({kind,viewport,values});
    }else{
      const draw=()=>page.evaluate(()=>{window.sceneRendererQA.draw(.01);return {pixel:window.sampleInteraction(),state:window.sceneRendererQA.scriptStates.get(1),warnings:window.sceneRendererQA.scriptWarnings};});
      await page.mouse.move(viewport.width*.5,viewport.height*.5);let frame=await draw();assert.ok(frame.pixel[1]>250&&frame.pixel[0]<2);
      await page.mouse.click(viewport.width*.5,viewport.height*.5);frame=await draw();assert.equal(frame.state.angles[2],1);assert.ok(frame.pixel[0]>250&&frame.pixel[1]<2);
      await page.waitForFunction(()=>window.audioTest.tracks[0].media.currentTime>.05&&!window.audioTest.tracks[0].media.paused);
      const audio=await page.evaluate(()=>({states:window.audioTest.soundStates(),volume:window.audioTest.tracks[0].gain.gain.value}));assert.ok(Math.abs(audio.volume-.2)<1e-5);assert.equal(audio.states[0].playing,true);
      frame=await page.evaluate(()=>{window.sceneRendererQA.draw(.2);return {pixel:window.sampleInteraction(),state:window.sceneRendererQA.scriptStates.get(1)};});assert.equal(frame.state.alpha,.5);assert.ok(frame.pixel[0]>110&&frame.pixel[0]<145);
      await page.mouse.down();await page.mouse.move(2,2);await page.mouse.up();frame=await draw();assert.equal(frame.state.angles[2],1,'release outside must not click');
      await page.mouse.move(viewport.width*.5,viewport.height*.5);await page.mouse.down();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();frame=await draw();assert.equal(frame.state.angles[2],1,'blur releases without click');
      await page.evaluate(()=>{const b=document.createElement('button');b.id='block';b.textContent='button';b.style.cssText='position:fixed;left:45%;top:45%;width:10%;height:10%;';document.body.append(b);});
      await page.locator('#block').click();frame=await draw();assert.equal(frame.state.angles[2],1,'UI button must not trigger wallpaper');assert.deepEqual(frame.warnings,[]);
      const paused=await page.evaluate(()=>{const a=window.audioTest;a.command({id:2,action:'pause'});a.configure({volume:30,muted:false,paused:true});a.configure({volume:30,muted:false,paused:false});return a.tracks[0].media.paused;});assert.equal(paused,true);
      await page.evaluate(()=>{window.audioTest.command({id:2,action:'stop'});});assert.equal(await page.evaluate(()=>window.audioTest.tracks[0].media.currentTime),0);
      results.push({kind,viewport,audio,pixel:frame.pixel});await page.evaluate(()=>window.audioTest.dispose());
    }
    assert.deepEqual(errors,[]);await page.locator('canvas').screenshot({path:`${out}/${kind}-${viewport.width}.png`});console.log(JSON.stringify(results.at(-1)));await page.close();
  }}finally{fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
