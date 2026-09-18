const fs=require('node:fs'),assert=require('node:assert/strict');
const {createJiti}=require('jiti'),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {webWallpaperHtml}=createJiti(__filename)('../lib/wallpaper-web.ts');
const base=process.env.QA_BASE||'http://127.0.0.1:13012',id='11111111111111111111111111111111';
function wav(){const b=Buffer.alloc(44+48000*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=0;i<(b.length-44)/2;i++)b.writeInt16LE(Math.sin(i/48000*Math.PI*880)*4000,44+i*2);return b;}
(async()=>{const browser=await chromium.launch({headless:true});const results=[];try{
for(const variant of ['video','web','web-settings']){const kind=variant==='video'?'video':'web';const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/api/sessions',r=>r.fulfill({json:{sessions:[],runningSessions:[],runningSessionIds:[]}}));
await page.addInitScript(({id,kind})=>{window.qaNativeVolume=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'volume').get;if(window===top)localStorage.setItem('omp-web:wallpaper',JSON.stringify({id,kind,volume:40,paused:false}));},{id,kind});
if(kind==='video')await page.route('**/api/wallpapers/*/media',r=>r.fulfill({body:fs.readFileSync('.tmp/wallpaper-test-video.mp4'),contentType:'video/mp4'}));
else{await page.route('**/api/wallpapers/*/web',r=>r.fulfill({json:{url:'/qa-web.html'}}));await page.route('**/qa-web.html',r=>r.fulfill({body:webWallpaperHtml('<html><body><audio id="music" autoplay loop src="/qa-tone.wav"></audio><script>const m=document.getElementById("music");m.volume=.5;m.play();'+(variant==='web-settings'?'window.wallpaperPropertyListener={applyGeneralProperties(p){m.volume=.5*p.audioVolume/100;}};':'')+'</script></body></html>',{}),contentType:'text/html'}));await page.route('**/qa-tone.wav',r=>r.fulfill({body:wav(),contentType:'audio/wav',headers:{'Access-Control-Allow-Origin':'*'}}));}
await page.goto(base);await page.waitForFunction(()=>document.documentElement.dataset.wallpaper==='on');await page.keyboard.press('Shift');
if(kind==='web')await page.locator('iframe.wallpaper-web').waitFor();
const frame=kind==='web'?await page.locator('iframe.wallpaper-web').elementHandle().then(el=>el.contentFrame()):page.mainFrame(),selector=kind==='web'?'audio':'video';
await frame.waitForFunction(selector=>{const m=document.querySelector(selector);return m&&!m.paused&&m.currentTime>.1;},selector);
let properties=await frame.locator(selector).evaluate(m=>({volume:window.qaNativeVolume.call(m),muted:m.muted,paused:m.paused}));
assert.equal(properties.volume,kind==='video'?.4:.2);
await page.locator('.wallpaper-volume').fill('20');
await frame.waitForFunction(({selector,expected})=>window.qaNativeVolume.call(document.querySelector(selector))===expected,{selector,expected:kind==='video'?.2:.1});
await page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('omp-web:wallpaper'));localStorage.setItem('omp-web:wallpaper',JSON.stringify({...p,paused:true,muted:true}));window.dispatchEvent(new Event('omp-web:wallpaper-preferences'));});
await frame.waitForFunction(selector=>document.querySelector(selector).paused,selector);
if(kind==='web'){
 await frame.evaluate(()=>{document.querySelector('audio').pause();});
 await page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('omp-web:wallpaper'));localStorage.setItem('omp-web:wallpaper',JSON.stringify({...p,paused:false}));window.dispatchEvent(new Event('omp-web:wallpaper-preferences'));});
 // Authored autoplay media resumes with the wallpaper; non-autoplay manual media is covered by the bridge's requested set.
}
assert.deepEqual(errors,[]);results.push({kind:variant,properties,volume:true,pause:true});await page.close();}
}finally{await browser.close();fs.mkdirSync('.tmp/scene-media-audio',{recursive:true});fs.writeFileSync('.tmp/scene-media-audio/results.json',JSON.stringify(results,null,2));}console.log(JSON.stringify(results));})().catch(e=>{console.error(e);process.exitCode=1;});
