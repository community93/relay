const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path');
const results=[];
function check(name,ok,detail){results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);}
(async()=>{
 const native=!!process.env.RELAY_CDP_URL;
 const browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:920}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 if(!native)await page.addInitScript(()=>{
  let bridge;
  Object.defineProperty(window,'__TAURI__',{configurable:true,get:()=>bridge,set:value=>{
   const original=value.core.invoke;
   value.core.invoke=async(command,args)=>{
    if(command!=='execute')return original(command,args);
    const d=args.draft,base={ok:true,status:200,statusText:'OK',timeMs:5,sizeBytes:100,headers:[{name:'content-type',value:'application/json'}],setCookies:[],contentType:'application/json',isText:true,bodyText:'',finalUrl:d.url};
    if(d.url.includes('59999'))return {...base,ok:false,status:0,error:'连接失败',errorKind:'connect'};
    if(d.url.includes('/login'))return {...base,bodyText:'{"user":"tom"}',setCookies:['session=abc123; Path=/; HttpOnly']};
    if(d.url.includes('/bin'))return {...base,isText:false,bodyBase64:'AAECA//+fw==',contentType:'application/octet-stream'};
    if(d.url.includes('/slow')){await new Promise(resolve=>setTimeout(resolve,500));return {...base,bodyText:'{"slow":true}'};}
    return {...base,bodyText:JSON.stringify({received:d.body.raw.content,headers:Object.fromEntries(d.headers.map(h=>[h.key,h.value]))})};
   };bridge=value;
  }});
 });
 try{
  if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
  if(native){const dir=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(dir).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated data');}
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');window.r=await import('./js/runner.js');window.details=await import('./js/run-details.js');
   s.state.tabs=[];s.state.activeTabId=null;s.state.runs=[];s.state.runners=[];
   window.env=s.newEnvironment('详情测试');env.variables=[s.kv('host','http://127.0.0.1:8899'),s.kv('authToken','runner-private-token')];s.state.environments=[env];s.state.settings.activeEnvironmentId=env.id;
   const c=s.newCollection('快照');window.req=s.newRequestNode('提交项目',{method:'POST',url:'{{host}}/echo?run={{$guid}}',headers:[s.kv('Content-Type','application/json'),s.kv('Authorization','Bearer {{authToken}}')],body:{...s.newBody('raw'),raw:{language:'json',content:'{"project":"before","nonce":"{{$guid}}"}'}}});
   const cookie=s.newRequestNode('登录',{url:'{{host}}/login'}),binary=s.newRequestNode('二进制',{url:'{{host}}/bin'}),dead=s.newRequestNode('失败请求',{url:'http://127.0.0.1:59999/dead'}),missing=s.newRequestNode('缺失变量',{url:'{{notDefined}}/echo'}),skip=s.newRequestNode('流请求',{url:'{{host}}/sse'});skip.protocol='sse';
   c.children=[req,cookie,binary,dead,missing,skip];s.state.collections=[c];window.plan=s.newRunner('逐条执行详情');plan.sources=[req.id,req.id,cookie.id,binary.id,dead.id,missing.id,skip.id];s.state.runners=[plan];s.openRunner(plan);s.emit('tree');
   await Promise.all(['collections','runners','environments','settings'].map(domain=>s.flushDomain(domain)));
   window.run=await r.runRunner(plan);await s.flushDomain('runs');
  });
  check('最新运行完成后自动显示逐条结果',await page.locator('.run-entry').count()===7);
  const data=await page.evaluate(()=>run.entries.map(e=>({name:e.name,status:e.status,details:!!e.details,skipped:!!e.skipped,response:e.details?.response})));
  check('真实请求响应体与头信息保存',data[0].status===200&&data[0].response.bodyText.includes('before')&&data[0].response.headers.length>0);
  check('重复请求每次都有独立快照',await page.evaluate(()=>run.entries[0].details.request.draft.params[0].value!==run.entries[1].details.request.draft.params[0].value&&run.entries[0].details!==run.entries[1].details));
  check('响应回显与当次提交Body一致',await page.evaluate(()=>JSON.parse(run.entries[0].details.response.bodyText).received===run.entries[0].details.request.draft.body.raw.content));
  check('文本响应不重复存储原始Base64',await page.evaluate(()=>!('bodyRawBase64' in run.entries[0].details.response)&&!('bodyBase64' in run.entries[0].details.response)));
  await page.locator('.run-entry').first().click();
  const dialog=page.locator('.run-detail-dialog');await dialog.waitFor();
  check('点击结果行在弹窗展示当次响应',await dialog.locator('.run-detail-code').innerText().then(t=>t.includes('before'))&&await page.evaluate(()=>s.activeTab().kind==='runner'));
  await dialog.getByRole('radio',{name:'请求',exact:true}).click();
  check('请求预览显示当次环境且敏感值默认隐藏',await dialog.innerText().then(t=>t.includes('详情测试')&&!t.includes('runner-private-token')));
  await dialog.locator('.preview-tabs').getByRole('tab',{name:'Body',exact:true}).click();
  check('请求Body保留变量解析结果',await dialog.locator('.preview-code').innerText().then(t=>t.includes('before')&&!t.includes('{{$guid}}')));
  await page.evaluate(()=>{env.variables[0].value='https://changed.example.invalid';req.request.body.raw.content='{"project":"after"}';s.touch('environments');});await page.waitForTimeout(100);
  check('修改环境和请求不改变历史快照',await dialog.innerText().then(t=>t.includes('127.0.0.1:8899')&&t.includes('before')&&!t.includes('changed.example.invalid')));
  await dialog.getByRole('button',{name:'下一个请求',exact:true}).click();
  check('弹窗可切换相邻请求且正确切回响应',await dialog.locator('.modal-head h2').innerText().then(t=>t.startsWith('2.'))&&await dialog.locator('.run-detail-code').isVisible());
  await dialog.getByRole('button',{name:'下一个请求',exact:true}).click();
  await dialog.getByRole('radio',{name:'Cookies 1',exact:true}).click();
  check('响应Cookies可查看',await dialog.locator('.preview-table').innerText().then(t=>t.includes('session=abc123')));
  await dialog.getByRole('button',{name:'下一个请求',exact:true}).click();
  check('二进制响应显示Base64',await dialog.innerText().then(t=>t.includes('Base64'))&&await dialog.locator('.run-detail-code').innerText().then(t=>t.length>0));
  await dialog.getByRole('button',{name:'下一个请求',exact:true}).click();
  check('请求失败仍可查看错误与请求',await dialog.locator('.run-detail-error').count()>0);
  await dialog.getByRole('button',{name:'下一个请求',exact:true}).click();await dialog.getByRole('radio',{name:'响应',exact:true}).click();
  check('变量校验失败明确没有收到响应',await dialog.locator('.preview-empty').innerText().then(t=>t.includes('缺少变量')));
  await dialog.getByRole('button',{name:'下一个请求',exact:true}).click();
  check('SSE 步骤真的跑了并保存了事件流证据',await dialog.innerText().then(t=>t.includes('200')&&t.includes('事件 1')&&!t.includes('已跳过')));
  await page.keyboard.press('Escape');await page.waitForTimeout(200);
  await page.evaluate(async()=>{
   const slow=s.newRequestNode('进行中的请求',{url:'http://127.0.0.1:8899/slow'});s.state.collections[0].children.push(slow);window.livePlan=s.newRunner('实时详情');livePlan.sources=[slow.id];s.state.runners.push(livePlan);s.openRunner(livePlan);window.livePromise=r.runRunner(livePlan);
  });
  await page.locator('.live-run-entries .run-entry').click();await dialog.getByRole('radio',{name:'响应',exact:true}).click();
  check('进行中的请求显示等待响应',await dialog.locator('.preview-empty').innerText().then(t=>t.includes('等待响应')));
  await page.waitForFunction(()=>document.querySelector('.run-detail-code')?.textContent.includes('slow'));
  check('请求完成后弹窗自动显示响应',await dialog.locator('.run-detail-code').innerText().then(t=>t.includes('slow')));
  await page.keyboard.press('Escape');await page.waitForTimeout(200);await page.evaluate(()=>s.openRunner(plan));
  if(await page.locator('.run-block .run-head').first().getAttribute('aria-expanded')!=='true')await page.locator('.run-block .run-head').first().click();
  await page.evaluate(()=>{s.state.collections=[];s.emit('tree');s.emit('rerender');});await page.locator('.run-entry').first().click();
  check('原请求删除后仍可查看执行响应',await dialog.locator('.run-detail-code').innerText().then(t=>t.includes('before')));
  await page.keyboard.press('Escape');await page.waitForTimeout(200);
  await page.evaluate(()=>details.openRunEntry({runnerName:'旧计划',entries:[{name:'旧请求',method:'GET',url:'https://example.invalid',at:Date.now(),timeMs:1,sizeBytes:0,status:200}]},0));
  check('旧记录不伪造历史响应',await dialog.innerText().then(t=>t.includes('旧记录没有保存')));await page.keyboard.press('Escape');await page.waitForTimeout(200);
  const bounded=await page.evaluate(()=>{
   const snapshot=JSON.parse(JSON.stringify(run.entries[0].details));snapshot.request.draft.body.raw.content='x'.repeat(300000);
   const captured=details.captureRunRequest({draft:snapshot.request.draft},snapshot.request);
   details.captureRunResponse(captured,{bodyText:'y'.repeat(300000),isText:true});
   const quota={entries:Array.from({length:45},()=>({details:JSON.parse(JSON.stringify(captured))}))};details.boundRunDetails(quota);
   return {request:captured.request.draft.body.raw.content.length,response:captured.response.bodyText.length,flags:captured.requestTruncated&&captured.responseTruncated,retained:quota.entries.filter(e=>e.details).length,cleared:quota.entries.filter(e=>e.detailsUnavailable).length,total:new TextEncoder().encode(JSON.stringify(quota.entries.filter(e=>e.details).map(e=>e.details))).length};
  });
  check('大请求和响应明确截断',bounded.request===262144&&bounded.response===262144&&bounded.flags,bounded);
  check('大量结果保留上限且摘要不丢失',bounded.cleared>0&&bounded.retained>0&&bounded.total<=8*1024*1024,bounded);
  if(native){
   await page.evaluate(()=>s.flushDomain('runs'));const expected=await page.evaluate(()=>({id:run.id,body:run.entries[0].details.response.bodyText}));await page.reload();await page.waitForSelector('.rail-btn');
   check('重载后保留当次请求与响应',await page.evaluate(async expected=>{window.s=await import('./js/state.js');window.run=s.state.runs.find(record=>record.id===expected.id);window.plan=s.state.runners.find(p=>p.id===run.runnerId);return run.entries[0].details.response.bodyText===expected.body;},expected));
  }
  await page.evaluate(()=>{s.openRunner(plan);});
  if(await page.locator('.run-block .run-head').first().getAttribute('aria-expanded')!=='true')await page.locator('.run-block .run-head').first().click();
  await page.locator('.run-entry').first().click();await page.waitForTimeout(250);
  await page.screenshot({path:`.design-qa/run-details-${native?'native':'browser'}.png`});
  check('无JavaScript页面异常',errors.length===0,errors);
  fs.writeFileSync(`.design-qa/run-details-${native?'native':'browser'}-results.json`,JSON.stringify({results,errors},null,2));
  console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
