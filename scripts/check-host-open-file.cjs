/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13028';
const out = process.env.QA_OUT || '.tmp/host-open-file/browser';
const cwd = path.resolve(process.env.QA_CWD || '.').replace(/\\/g, '/');
const relativeImage = (process.env.QA_IMAGE || 'public/icon.png').replace(/\\/g, '/');
const absoluteImage = `${cwd}/${relativeImage}`;
const sid = '00000000-0000-4000-8000-000000000002';
const info = {id:sid,path:'qa-session.jsonl',cwd,projectRoot:cwd,name:'Open image regression',created:'2026-01-01',modified:'2026-01-01',messageCount:1,firstMessage:'Open image'};
const context = {entryIds:['u'],thinkingLevel:'off',model:null,todoPhases:[],messages:[{role:'user',content:'Open the image in the side panel.',timestamp:1000}]};
const agent = {running:true,state:{sessionId:sid,isStreaming:false,isPromptRunning:false}};

(async () => {
  fs.mkdirSync(out,{recursive:true});
  // Only the dedicated preview's allowlist changes; agent/model APIs are mocked.
  const validated = await fetch(`${base}/api/cwd/validate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cwd})});
  assert.equal(validated.status,200,await validated.text());
  const browser = await chromium.launch({headless:true});
  const reports = [];
  try {
    for (const theme of ['light','dark']) for (const width of [1440,390,3840]) {
      const page = await browser.newPage({viewport:{width,height:width===3840?2160:900},locale:'zh-CN'});
      const errors = [];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(({sid,theme}) => {
        localStorage.setItem('omp-lang','zh');
        localStorage.setItem('omp-theme',theme);
        const NativeEventSource = window.EventSource;
        window.__qaAgentStreams = [];
        window.EventSource = class extends EventTarget {
          static CONNECTING=0; static OPEN=1; static CLOSED=2;
          constructor(url,options) {
            super();
            if(!String(url).includes(`/api/agent/${sid}/events`))return new NativeEventSource(url,options);
            this.url=String(url);this.readyState=0;this.sequence=0;
            window.__qaAgentStreams.push(this);
            setTimeout(()=>{
              if(this.readyState===2)return;
              this.readyState=1;this.onopen?.(new Event('open'));
              this.emit({type:'connected'});
            },20);
          }
          emit(frame) {this.onmessage?.(new MessageEvent('message',{data:JSON.stringify({...frame,web:{streamId:'qa-stream',sequence:this.sequence++}})}));}
          close() {this.readyState=2;}
        };
      },{sid,theme});
      await page.route('**/api/**',route=>{
        const request = route.request(),url=new URL(request.url()),p=url.pathname;
        const reply=json=>route.fulfill({json});
        if(p.startsWith('/api/files/'))return route.continue();
        if(p.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:': qa\n\n'});
        if(p==='/api/sessions')return reply({sessions:[info],runningSessionIds:[],runningSessions:[]});
        if(p===`/api/sessions/${sid}`)return reply({sessionId:sid,filePath:info.path,info,leafId:'u',tree:[],context,agent});
        if(p===`/api/sessions/${sid}/context`)return reply({context,leafId:'u',tree:[]});
        if(p===`/api/sessions/${sid}/state`)return reply(agent);
        if(p===`/api/agent/${sid}`)return reply(request.method()==='GET'?agent:{success:true,data:{}});
        if(p==='/api/projects')return reply({projects:[{path:cwd}]});
        if(p==='/api/cwd/validate')return reply({valid:true,cwd,isDirectory:true});
        if(p==='/api/models')return reply({models:{},modelList:[]});
        if(p==='/api/provider-usage')return reply({generatedAt:Date.now(),reports:[]});
        if(p==='/api/worktrees')return reply({worktrees:[]});
        if(p==='/api/git/status')return reply({isGitRepo:false,files:[]});
        if(p==='/api/app-update'||p==='/api/omp-update')return reply({updateAvailable:false});
        if(p==='/api/omp-version')return reply({version:'test'});
        if(request.method()!=='GET')return reply({ok:true});
        return reply({entries:[],files:[],providers:[],settings:{},tools:[],commands:[],sessions:[]});
      });
      await page.goto(`${base}/?session=${sid}`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>window.__qaAgentStreams.some(s=>s.readyState===1),{},{timeout:30000});
      const timings = [];
      for (const [index,filePath] of [relativeImage,relativeImage.replace(/\//g,'\\'),absoluteImage].entries()) {
        const id=`open-${index}`,start=Date.now();
        const resultPromise=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes(`/api/agent/${sid}`)&&r.request().postDataJSON()?.id===id,{timeout:15000});
        await page.evaluate(({id,filePath})=>window.__qaAgentStreams.filter(s=>s.readyState===1).at(-1).emit({type:'host_tool_call',id,toolName:'open_file',arguments:{path:filePath}}),{id,filePath});
        const result=await resultPromise,frame=result.request().postDataJSON();
        assert.equal(frame.isError,false,JSON.stringify(frame));
        assert.equal(frame.result.content[0].text,`Opened ${absoluteImage}`);
        const img=page.locator('.right-panel-open img').filter({visible:true});
        await img.waitFor();
        await page.waitForFunction(()=>[...document.querySelectorAll('.right-panel-open img')].some(img=>img.complete&&img.naturalWidth>0));
        timings.push(Date.now()-start);
        const pixels=await img.evaluate(img=>{
          const c=document.createElement('canvas');c.width=32;c.height=32;
          const ctx=c.getContext('2d');ctx.drawImage(img,0,0,32,32);
          const d=ctx.getImageData(0,0,32,32).data,colors=new Set();
          for(let i=0;i<d.length;i+=4)colors.add(`${d[i]},${d[i+1]},${d[i+2]}`);
          const r=img.getBoundingClientRect();
          return {colors:colors.size,natural:[img.naturalWidth,img.naturalHeight],left:r.left,right:r.right};
        });
        assert.ok(pixels.colors>2,JSON.stringify(pixels));
        assert.ok(pixels.left>=-1&&pixels.right<=width+1,JSON.stringify(pixels));
      }
      await page.screenshot({path:`${out}/${theme}-${width}.png`});
      // A missing image must settle as an error without replacing the valid tab.
      const failed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes(`/api/agent/${sid}`)&&r.request().postDataJSON()?.id==='missing',{timeout:15000});
      await page.evaluate(()=>window.__qaAgentStreams.filter(s=>s.readyState===1).at(-1).emit({type:'host_tool_call',id:'missing',toolName:'open_file',arguments:{path:'__qa_missing_image__.png'}}));
      assert.equal((await failed).request().postDataJSON().isError,true);
      assert.deepEqual(errors,[]);
      reports.push({theme,width,timings,missingFile:'error',imageLoaded:true});
      await page.close();
    }
    console.log(JSON.stringify(reports));
  } finally {
    fs.writeFileSync(`${out}/results.json`,JSON.stringify(reports,null,2));
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
