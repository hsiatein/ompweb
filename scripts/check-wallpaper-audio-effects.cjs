const fs = require('node:fs'), assert = require('node:assert/strict'), sharp = require('sharp');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13012', out = '.tmp/scene-audio-effects';
function tone() {
  const rate = 48000, samples = rate * 2, b = Buffer.alloc(44 + samples * 4);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 4, 40);
  for (let i = 0; i < samples; i++) { b.writeInt16LE(Math.sin(i * Math.PI * 2000 / rate) * 16000, 44 + i * 4); b.writeInt16LE(Math.sin(i * Math.PI * 4000 / rate) * 12000, 46 + i * 4); }
  return b;
}
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const png = await sharp(Buffer.from([255,255,255,255]), {raw:{width:1,height:1,channels:4}}).png().toBuffer();
  const data = {version:1,width:100,height:100,clearColor:[0,0,0],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0},textures:[{key:'white',url:'/qa-white.png',width:1,height:1,format:0,frames:[]}],particles:[],layers:[{id:1,name:'meter',origin:[50,50,0],size:[50,50],scale:[1,1,1],angle:0,parallax:[0,0],color:[1,1,1],alpha:1,blending:'translucent',colorBlendMode:0,texture:'white',scripts:[{property:'scale',properties:{},source:'const a=engine.registerAudioBuffers(64); export function update(){return new Vec3(1+a.average.reduce((n,v)=>n+v,0)/10);}' }],passes:[{vertex:'precision highp float;attribute vec3 a_Position;uniform mat4 g_ModelViewProjectionMatrix;void main(){gl_Position=g_ModelViewProjectionMatrix*vec4(a_Position,1.0);}',fragment:'precision highp float;uniform float g_AudioSpectrum64Left[64];void main(){float v=0.0;for(int i=0;i<64;i++)v=max(v,g_AudioSpectrum64Left[i]);gl_FragColor=vec4(vec3(v),1.0);}',uniforms:{g_AudioSpectrum64Left:Array(64).fill(0)},textures:[null],repeats:[]}]}]};
  const browser = await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11','--ignore-gpu-blocklist']});
  try {
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/wallpapers/*/scene',r=>r.fulfill({json:data}));await page.route('**/qa-white.png',r=>r.fulfill({body:png,contentType:'image/png'}));await page.route('**/qa-tone.wav',r=>r.fulfill({body:tone(),contentType:'audio/wav'}));
    await page.goto(base+'/scene-renderer-qa');await page.waitForFunction(()=>window.wallpaperAudioQA);await page.keyboard.press('Shift');
    const result=await page.evaluate(async()=>{
      const {WallpaperAudio}=window.wallpaperAudioQA,r=window.sceneRendererQA,c=document.querySelector('canvas');
      const pixel=()=>{const a=document.createElement('canvas');a.width=a.height=100;const x=a.getContext('2d');x.drawImage(c,0,0,100,100);return Array.from(x.getImageData(50,50,1,1).data);};
      const before=pixel();
      const audio=new WallpaperAudio([{id:1,files:[{key:'tone',url:'/qa-tone.wav',mimeType:'audio/wav'}],volume:1,mode:'loop',startSilent:false,minTime:1,maxTime:2}],{volume:30,muted:false,paused:false});r.setAudio(audio);
      await new Promise(resolve=>setTimeout(resolve,500));r.draw(.02);
      const after=pixel(),stereo=audio.spectrum(),scale=r.scriptLayers.get(1).mesh.scale.x;
      audio.configure({volume:30,muted:false,paused:true});r.draw(0);const paused=pixel();
      audio.dispose();
      const ctx=new AudioContext();await ctx.resume();const oscillator=ctx.createOscillator(),dest=ctx.createMediaStreamDestination();oscillator.frequency.value=440;oscillator.connect(dest);oscillator.start();
      const capture=new WallpaperAudio([],{volume:50,muted:false,paused:false});
      Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>dest.stream});
      await capture.startCapture();await new Promise(resolve=>setTimeout(resolve,200));
      const captureActive=capture.state.capturing,captureSpectrum=Math.max(...capture.spectrum());capture.stopCapture();
      const tracksStopped=dest.stream.getTracks().every(t=>t.readyState==='ended');capture.dispose();oscillator.stop();await ctx.close();
      return{before,after,paused,scale,left:Math.max(...stereo.slice(0,64)),right:Math.max(...stereo.slice(64)),captureActive,captureSpectrum,tracksStopped};
    });
    assert.equal(result.before[0],0);assert.ok(result.after[0]>100);assert.equal(result.paused[0],0);assert.ok(result.scale>1);assert.ok(result.left>0&&result.right>0);assert.ok(result.captureActive&&result.captureSpectrum>0&&result.tracksStopped);assert.deepEqual(errors,[]);
    fs.writeFileSync(out+'/results.json',JSON.stringify({result,errors},null,2));console.log(JSON.stringify(result));await page.close();
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
