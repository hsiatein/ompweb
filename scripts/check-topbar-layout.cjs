/* eslint-disable @typescript-eslint/no-require-imports -- Node-only browser QA. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.QA_BASE || 'http://127.0.0.1:13027';
const out = process.env.QA_OUT || '.tmp/topbar-layout-20260920/browser';
const baseline = !!process.env.QA_BASELINE;
const sid = '00000000-0000-4000-8000-000000000001';
const wid = 'a'.repeat(32), cwd = 'D:/QA/ompweb';
const name = 'A detailed analysis of AI research, recent developments and future directions '.repeat(4);
const info = {id:sid,path:'qa-session.jsonl',cwd,projectRoot:cwd,name,created:'2026-01-01',modified:'2026-01-01',messageCount:2,firstMessage:name};
const context = {entryIds:['u','a'],thinkingLevel:'high',model:null,todoPhases:[],messages:[
  {role:'user',content:'Layout test',timestamp:1000},
  {role:'assistant',content:[{type:'text',text:'Layout test ready.'}],timestamp:11000,model:'qa',provider:'qa',usage:{input:1,output:106,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}},
]};
const scene = {version:1,width:1280,height:720,clearColor:[.35,.4,.45],layers:[],particles:[],textures:[],cameraEffects:{parallax:false,amount:0,delay:0,mouse:0,shake:false,amplitude:0,speed:0,roughness:0}};

async function state(page) {
  return page.evaluate(() => {
    const visible = el => el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const rect = el => { const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}; };
    const header = document.querySelector('.shell-topbar');
    const selectors = ['.shell-topbar-tools','.shell-topbar-breadcrumb','[data-topbar-right-group]'];
    const zones = selectors.map(selector=>({selector,el:header.querySelector(selector)})).filter(v=>visible(v.el)).map(v=>({selector:v.selector,...rect(v.el)}));
    const controls = [...header.querySelectorAll('button,summary,input')].filter(visible).map(el=>({label:el.getAttribute('aria-label')||el.title||el.tagName,...rect(el)}));
    const overlaps = [];
    for(let i=0;i<zones.length;i++)for(let j=i+1;j<zones.length;j++)if(Math.min(zones[i].right,zones[j].right)-Math.max(zones[i].left,zones[j].left)>1)overlaps.push([zones[i].selector,zones[j].selector]);
    const clipped = controls.filter(c=>c.left < -1 || c.right > innerWidth+1);
    const collisions=[];
    for(let i=0;i<controls.length;i++)for(let j=i+1;j<controls.length;j++)if(Math.min(controls[i].right,controls[j].right)-Math.max(controls[i].left,controls[j].left)>1 && Math.min(controls[i].bottom,controls[j].bottom)-Math.max(controls[i].top,controls[j].top)>1)collisions.push([controls[i].label,controls[j].label]);
    return {header:rect(header),zones,overlaps,clipped,collisions,compact:header.querySelector('details').dataset.compact,overflow:document.documentElement.scrollWidth>innerWidth,sidebar:document.querySelector('.sidebar-container').className};
  });
}

(async()=>{
 fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({headless:true,args:['--enable-webgl','--use-angle=d3d11']});
 const reports=[];
 try {
  for(const scale of baseline?['standard']:['standard','large']){
   const page=await browser.newPage({viewport:{width:1440,height:900},locale:'zh-CN'}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(({scale,wid})=>{
    localStorage.setItem('omp-ui-scale',scale);localStorage.setItem('omp-lang','zh');
    localStorage.setItem('omp-web:sidebar-width','260');localStorage.setItem('omp-web:right-panel-width','300');
    localStorage.setItem('omp-web:wallpaper',JSON.stringify({id:wid,kind:'scene',muted:true,glass:'default'}));
   },{scale,wid});
   await page.route('**/api/**',route=>{
    const p=new URL(route.request().url()).pathname;
    const reply=json=>route.fulfill({json});
    if(p.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:': qa\n\n'});
    if(p==='/api/sessions')return reply({sessions:[info],runningSessionIds:[],runningSessions:[]});
    if(p===`/api/sessions/${sid}`)return reply({sessionId:sid,filePath:info.path,info,leafId:'a',tree:[],context,agent:{running:false}});
    if(p===`/api/sessions/${sid}/context`)return reply({context,leafId:'a',tree:[]});
    if(p===`/api/agent/${sid}`)return reply({running:false});
    if(p==='/api/projects')return reply({projects:[{path:cwd}]});
    if(p==='/api/cwd/validate')return reply({valid:true,cwd,isDirectory:true});
    if(p==='/api/models')return reply({models:{},modelList:[]});
    if(p===`/api/wallpapers/${wid}/scene`)return reply(scene);
    if(p==='/api/provider-usage')return reply({generatedAt:Date.now(),reports:[]});
    if(p==='/api/worktrees')return reply({worktrees:[]});
    if(p==='/api/git/status')return reply({isGitRepo:false,files:[]});
    if(p==='/api/app-update'||p==='/api/omp-update')return reply({updateAvailable:false});
    if(p==='/api/omp-version')return reply({version:'test'});
    if(route.request().method()!=='GET')return reply({ok:true});
    return reply({entries:[],files:[],providers:[],settings:{},tools:[],commands:[],sessions:[]});
   });
   await page.goto(`${base}/?session=${sid}`,{waitUntil:'domcontentloaded'});
   await page.locator('.shell-metric-pill').waitFor({timeout:60000});
   await page.waitForFunction(()=>document.documentElement.dataset.wallpaper==='on');
   for(const width of baseline?[1440]:[1920,1440,1280,1100,960,768,640,390,320,3840]){
    await page.setViewportSize({width,height:width===3840?2160:900});
    await page.waitForTimeout(300);
    const mobile=width<768;
    for(const sidebar of mobile?[false]:[false,true]){
     const open=await page.locator('.sidebar-container').evaluate(el=>el.classList.contains('sidebar-open'));
     if(open!==sidebar)await page.locator('.shell-topbar-tools > button').click();
     for(const right of width<768?[false]:[false,true]){
      const open=await page.locator('.wallpaper-panel-toggle').evaluate(el=>el.getAttribute('title').includes('隐藏'));
      if(open!==right)await page.locator('.wallpaper-panel-toggle').click();
      await page.waitForTimeout(300);
      const result=await state(page);reports.push({scale,width,sidebar,right,...result});
      if(baseline&&result.overlaps.length){await page.screenshot({path:`${out}/overlap.png`});console.log(JSON.stringify(reports.at(-1)));return;}
      if(!baseline){
       assert.deepEqual(result.overlaps,[],JSON.stringify(reports.at(-1)));
       assert.deepEqual(result.collisions,[],JSON.stringify(reports.at(-1)));
       assert.deepEqual(result.clipped,[],JSON.stringify(reports.at(-1)));
       assert.equal(result.overflow,false);
       if(result.compact==='true'){
        await page.locator('.shell-topbar-overflow > summary').click();
        const menu=await state(page);assert.deepEqual(menu.collisions,[],JSON.stringify(menu));assert.deepEqual(menu.clipped,[],JSON.stringify(menu));
        await page.keyboard.press('Escape');
       }
       if(sidebar&&!right&&[1440,1280,3840].includes(width)||width===390)await page.screenshot({path:`${out}/${scale}-${width}.png`});
      }
     }
    }
   }
   assert.deepEqual(errors,[]);await page.close();
  }
  if(baseline)throw Error('Baseline overlap was not reproduced');
  console.log(JSON.stringify({cases:reports.length,overlaps:0,errors:0}));
 }finally{fs.writeFileSync(`${out}/results.json`,JSON.stringify(reports,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
