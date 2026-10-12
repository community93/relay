const {chromium}=require('./playwright.cjs');
const fs=require('fs'),path=require('path');
(async()=>{
 const native=!!process.env.RELAY_CDP_URL;
 const browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:920}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
 if(native){const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(!process.env.RELAY_VISUAL_DATA||path.resolve(data).toLowerCase()!==path.resolve(process.env.RELAY_VISUAL_DATA).toLowerCase())throw Error('Requires the designated isolated visual QA directory');}
 await page.evaluate(async()=>{
 window.s=await import('./js/state.js');window.e=await import('./js/env.js');window.r=await import('./js/runner.js');window.t=await import('./js/tools.js');
 s.state.tabs=[];s.state.collections=[];s.state.docs=[];s.state.environments=[];s.state.runners=[];s.state.runs=[];
 window.dev=s.newEnvironment('开发环境');dev.variables=[s.kv('baseUrl','https://api.example.invalid'),s.kv('token','demo-token')];s.state.environments.push(dev);s.state.settings.activeEnvironmentId=dev.id;
 window.col=s.newCollection('项目服务');window.req=s.newRequestNode('查询项目',{url:'{{baseUrl}}/v2/projects',params:[s.kv('page','1'),s.kv('pageSize','20')],headers:[s.kv('Accept','application/json')]});col.children=[req,s.newRequestNode('创建项目',{method:'POST',url:'{{baseUrl}}/v2/projects'}),s.newRequestNode('实时通知',{url:'{{baseUrl}}/v2/events'})];s.state.collections.push(col);s.state.expanded[col.id]=true;
 window.plan=s.newRunner('交付前检查');plan.sources=col.children.map(x=>x.id);s.state.runners.push(plan);
 window.doc=s.newDoc('项目服务 API');doc.overview='项目与成员管理接口。';s.state.docs.push(doc);
 for(const node of col.children){const b=s.newReqBlock(`curl '${node.request.url}'`);b.draft={...node.request};b.parsedCurl=b.curl;b.auth={kind:'noauth'};b.contract={summary:node.name,description:'',fields:{},reviewed:false};doc.blocks.push(b);}
 s.emit('tree');s.emit('environment');s.openRequest(req);
 });
 const version=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8')).version;
 const out=process.env.RELAY_VISUAL_OUT||`reports/visual-review-${version}`;fs.mkdirSync(out,{recursive:true});

 const checks=[],contrasts=[],geometry=[],controls=[];
 const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)console.log('FAIL',name,JSON.stringify(detail));};
 const shot=async(name)=>{await page.waitForTimeout(250);await page.screenshot({path:`${out}/${name}.png`});};
 await page.evaluate(async()=>{
  window.a=await import('./js/app.js');window.colors=await import('./js/themes.js');window.protocol=await import('./js/protocol.js');window.c=await import('./js/delivery.js');
  window.sample={status:200,statusText:'OK',timeMs:127,sizeBytes:373,contentType:'application/json; charset=utf-8',charset:'utf-8',isText:true,headers:[{name:'content-type',value:'application/json'},{name:'x-request-id',value:'trace-01'}],setCookies:[],bodyText:JSON.stringify({data:[{id:'prj_01',name:'Relay',visibility:'private'}],page:1,total:1})};
  s.openRequest(req);s.activeTab().response=sample;s.activeTab().responseView='body';s.emit('rerender');
  const b=doc.blocks[0];b.contract.description='按工作区查询项目。分页从 1 开始。';c.captureVerification(b,b,s.buildSendDraft(b),sample);
  for(const row of c.endpointFields(b))b.contract.fields[row.id]={description:row.group==='Response'?`${row.path} 返回值`:`${row.path} 查询条件`,required:false};b.contract.reviewed=true;doc.version='1.2.0';
 });
 for(const palette of await page.evaluate(()=>colors.THEMES.map(theme=>theme.id)))for(const theme of ['light','dark']){
  await page.setViewportSize({width:1440,height:920});await page.evaluate(({palette,theme})=>{s.state.settings.theme=theme;s.state.settings.palette=palette;s.state.settings.uiZoom=1;a.applyUiZoom();colors.applyAppearance();},{palette,theme});
  const contrast=await page.evaluate(()=>{
   const root=getComputedStyle(document.documentElement),probe=document.createElement('span');document.body.append(probe);
   const rgb=t=>{probe.style.color=root.getPropertyValue(t).trim();return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0,3).map(Number);};
   const lum=v=>v.map(c=>{c/=255;return c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);}).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
   const rows=[];for(const ink of ['--text','--text-dim','--text-faint','--current-ink'])for(const bg of ['--sheet','--bg-panel','--bg-inset','--current-soft']){const x=lum(rgb(ink)),y=lum(rgb(bg));rows.push({ink,bg,ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)});}probe.remove();return rows;
  });contrasts.push({palette,theme,rows:contrast});check(`${palette}/${theme} 正文与辅助文字对比度`,contrast.every(c=>c.ratio>=4.5),contrast.filter(c=>c.ratio<4.5));
  for(const [name,fn] of [['response',()=>page.evaluate(()=>s.openRequest(req))],['environment',()=>page.evaluate(()=>e.openEnvironment(dev))],['runner',()=>page.evaluate(()=>s.openRunner(plan))],['document',()=>page.evaluate(()=>{doc.mode='draft';s.openDoc(doc);})],['publication',()=>page.evaluate(()=>{doc.mode='delivery';s.openDoc(doc);})]]){await fn();await shot(`after-${palette}-${theme}-${name}`);}
  await page.evaluate(()=>s.openRequest(req));
  await page.getByRole('button',{name:'查看当前请求变量',exact:true}).click();await shot(`after-${palette}-${theme}-variables`);await page.keyboard.press('Escape');await page.waitForTimeout(200);
  await page.evaluate(()=>t.importCurlDialog(col,"curl 'https://api.example.invalid/projects'"));await page.locator('.modal .pick').waitFor();await shot(`after-${palette}-${theme}-import`);await page.keyboard.press('Escape');await page.waitForTimeout(200);
  const radius=await page.evaluate(()=>{const selectors=['.btn.primary','.tab.active','.kv','.modal','.menu'],tokens=['--r-xs','--r-sm','--r','--r-lg','--r-xl'];const root=getComputedStyle(document.documentElement);return {tokens:Object.fromEntries(tokens.map(key=>[key,root.getPropertyValue(key).trim()])),components:Object.fromEntries(selectors.map(key=>[key,document.querySelector(key)?getComputedStyle(document.querySelector(key)).borderRadius:null]))};});controls.push({palette,theme,...radius});
 }
 for(const width of [1440,1000])for(const zoom of [1,1.4,2]){
  await page.setViewportSize({width,height:width===1000?640:920});await page.evaluate(zoom=>{s.state.settings.uiZoom=zoom;s.state.settings.palette='mint';s.state.settings.theme='light';a.applyUiZoom();colors.applyAppearance();},zoom);
  for(const [name,fn] of [['request',()=>page.evaluate(()=>s.openRequest(req))],['runner',()=>page.evaluate(()=>s.openRunner(plan))],['document',()=>page.evaluate(()=>{doc.mode='draft';s.openDoc(doc);})],['publication',()=>page.evaluate(()=>{doc.mode='delivery';s.openDoc(doc);})],['environment',()=>page.evaluate(()=>e.openEnvironment(dev))]]){
   await fn();await page.waitForTimeout(60);
   const g=await page.evaluate(()=>{const app=document.querySelector('.app'),host=document.querySelector('#request-host'),r=app.getBoundingClientRect();return{app:{right:r.right,bottom:r.bottom},width:innerWidth,height:innerHeight,hostOverflow:host.scrollWidth-host.clientWidth,sidebarOverflow:document.querySelector('.navigation').scrollWidth-document.querySelector('.navigation').clientWidth};});geometry.push({width,zoom,name,...g});
   check(`${width}px/${zoom} ${name} 工作区无横向溢出`,g.hostOverflow<=2&&g.app.right<=g.width+1&&g.app.bottom<=g.height+1,g);
   if(width===1000&&zoom===1||zoom===2&&width===1440)await shot(`after-${width}-${zoom}-${name}`);
  }
 }
 await page.setViewportSize({width:1440,height:920});await page.evaluate(()=>{s.state.settings.uiZoom=1;a.applyUiZoom();s.openRequest(req);});
 for(const proto of ['sse','ws']){
  await page.evaluate(proto=>{protocol.setProtocol(s.activeTab(),proto);const tab=s.activeTab();
   if(proto==='sse'){tab.responseView='events';tab.running={execId:'visual-sse',live:true,kind:'sse'};tab.stream={startedAt:Date.now(),count:4,bytes:400,status:200,events:Array.from({length:4},(_,i)=>({kind:'message',at:Date.now(),data:JSON.stringify({id:i,event:'project.updated',projectId:'prj_01'})})),raw:[],headers:[]};}
   else{tab.draft.url='wss://api.example.invalid/socket';tab.ws={connId:'visual-ws',status:'open',events:[{kind:'open',at:Date.now(),message:'已连接'},{kind:'message',at:Date.now(),dir:'out',text:'{"action":"subscribe","channel":"projects"}'},{kind:'message',at:Date.now(),dir:'in',text:'{"event":"project.updated","id":"prj_01"}'}],sent:1,recv:1,bytes:120,startedAt:Date.now(),handshake:[]};}s.emit('rerender');},proto);
  await shot(`after-${proto}`);await page.setViewportSize({width:1000,height:640});await shot(`after-compact-${proto}`);await page.setViewportSize({width:1440,height:920});
 }
 await page.evaluate(()=>{const tab=s.activeTab();tab.running=null;tab.ws=null;protocol.setProtocol(tab,'http');tab.draft=JSON.parse(JSON.stringify(req.request));tab.response=sample;s.openRequest(req);s.emit('rerender');});
 await page.getByRole('button',{name:'查看当前请求变量',exact:true}).click();await shot('after-variables');await page.keyboard.press('Escape');await page.waitForTimeout(200);
 await page.evaluate(()=>t.openSettingsDialog());await shot('after-settings');await page.keyboard.press('Escape');await page.waitForTimeout(200);
 await page.keyboard.press('Control+k');await shot('after-command');await page.keyboard.press('Escape');
 for(const pane of ['collections','docs','environments','runner','history']){await page.locator(`[data-rail=${pane}]`).click();if(await page.locator('.section-overview').count())await page.locator('.section-overview').click();await shot(`after-overview-${pane}`);}
 check('所有评审状态无 JS 异常',!errors.length,errors);
 fs.writeFileSync(`${out}/matrix.json`,JSON.stringify({version,native,checks,contrasts,geometry,controls,errors},null,2));console.log(`${checks.filter(c=>c.ok).length}/${checks.length} visual checks passed`);await browser.close();if(checks.some(c=>!c.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
