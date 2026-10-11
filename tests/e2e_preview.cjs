const {chromium}=require('./playwright');
const fs=require('node:fs'),path=require('node:path');
const results=[];
function check(name,ok) {results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);}
(async()=>{
 const native=!!process.env.RELAY_CDP_URL;
 const browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:920}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try {
  if (!native) await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.url-input');
  if(native){const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw new Error('Requires isolated native-data');}
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');window.p=await import('./js/preview.js');
   const c=s.newCollection('Workspace API');c.variables=[s.kv('workspace','collection')];c.headers=[s.kv('X-Collection','{{workspace}}')];
   const env=s.newEnvironment('Development');env.defaults.baseUrl='http://127.0.0.1:8899';env.defaults.urlPrefixMode='auto';env.defaults.alwaysOnHeaders=true;env.defaults.headers=[s.kv('X-Environment','{{workspace}}')];env.variables=[s.kv('workspace','ws_42'),s.kv('accessToken','test-secret-428'),s.kv('alias','{{workspace}}')];
   s.state.globals=[s.kv('workspace','global'),s.kv('limit','20')];s.state.collections=[c];s.state.environments=[env];s.state.settings.activeEnvironmentId=env.id;s.state.tabs=[];
   const req=s.newRequestNode('List projects',{method:'POST',url:'/echo?workspace={{workspace}}&limit={{limit}}',headers:[s.kv('X-Alias','{{alias}}'),s.kv('X-Random','{{$guid}}')],body:{...s.newBody('raw'),raw:{language:'json',content:'{"workspace":"{{alias}}","nonce":"{{$guid}}"}'}}});req.auth={kind:'bearer',bearer:{token:'{{accessToken}}'}};c.children=[req];window.fixture={c,env,req};s.openRequest(req);s.emit('environment');
  });
  const before=await page.evaluate(()=>JSON.stringify(s.activeTab().draft));
  await page.locator('.request-preview-trigger').click();
  const modal=page.locator('.request-preview');await modal.waitFor();
  check('发送旁可直接打开请求预览',await modal.isVisible());
  check('预览展示替换后的完整 URL 与 query',(await modal.locator('.preview-url').innerText())==='http://127.0.0.1:8899/echo?workspace=ws_42&limit=20');
  check('默认不显示 token',!(await modal.innerText()).includes('test-secret-428'));
  check('默认呈现头来源',(await modal.innerText()).includes('环境 · Development')&&(await modal.innerText()).includes('集合 · Workspace API')&&(await modal.innerText()).includes('鉴权'));
  check('打开预览不修改草稿也不发送',await page.evaluate(before=>JSON.stringify(s.activeTab().draft)===before&&!s.activeTab().response&&!s.activeTab().running,before));
  await modal.getByRole('button',{name:'显示敏感值',exact:true}).click();check('按需显示解析后的鉴权值',(await modal.innerText()).includes('Bearer test-secret-428'));
  await modal.getByRole('tab',{name:'Auth',exact:true}).click();check('Auth 展示解析后的鉴权字段',(await modal.innerText()).includes('test-secret-428')&&(await modal.innerText()).includes('Bearer Token'));
  await modal.getByRole('tab',{name:'变量',exact:true}).click();
  check('变量列出覆盖来源与嵌套解析',(await modal.innerText()).includes('环境 · Development')&&(await modal.innerText()).includes('alias')&&(await modal.innerText()).includes('ws_42')&&(await modal.innerText()).includes('全局'));
  check('动态变量显示发送时重算提示',(await modal.innerText()).includes('动态变量在发送时重新生成'));
  await modal.getByRole('tab',{name:'Body',exact:true}).click();check('Body 展示解析后的 JSON',(await modal.locator('.preview-code').innerText()).includes('"workspace":"ws_42"'));
  await modal.getByRole('tab',{name:'cURL',exact:true}).click();check('cURL 包含完整 query 与 auth',(await modal.locator('.preview-code').innerText()).includes('?workspace=ws_42&limit=20')&&(await modal.locator('.preview-code').innerText()).includes('Bearer test-secret-428'));
  await modal.getByRole('tab',{name:'设置',exact:true}).click();await page.keyboard.press('ArrowLeft');check('预览标签支持方向键',await modal.getByRole('tab',{name:'变量',exact:true}).getAttribute('aria-selected')==='true');
  await page.screenshot({path:`.design-qa/preview-variables-${native?'native':'browser'}.png`});
  await page.keyboard.press('Escape');await page.waitForTimeout(220);check('Esc 关闭且恢复入口焦点',await page.locator('.request-preview').count()===0&&await page.locator('.request-preview-trigger').evaluate(el=>el===document.activeElement));
  const built=await page.evaluate(()=>s.buildSendDraft(s.activeTab()));
  check('同一请求的动态变量在 Headers 和 Body 中一致',JSON.parse(built.draft.body.raw.content).nonce===built.draft.headers.find(h=>h.key==='X-Random').value);
  check('禁用变量不进入解析',await page.evaluate(()=>{fixture.env.variables.push({...s.kv('disabled','bad'),enabled:false});const tab={...s.activeTab(),draft:{...s.activeTab().draft,url:'https://example.invalid/{{disabled}}'}};return s.buildSendDraft(tab).missing.includes('disabled');}));
  check('Basic 与 API Key 统一替换变量',await page.evaluate(()=>{const tab={...s.activeTab(),auth:{kind:'basic',basic:{username:'{{workspace}}',password:'{{accessToken}}'}}};const basic=s.buildSendDraft(tab).draft.headers.find(h=>h.key==='Authorization');tab.auth={kind:'apikey',apikey:{key:'key',value:'{{accessToken}}',addTo:'query'}};const key=s.buildSendDraft(tab).draft.params.find(row=>row.key==='key');return atob(basic.value.slice(6))==='ws_42:test-secret-428'&&key.value==='test-secret-428';}));
  check('表单和环境头缺失变量进入检查结果',await page.evaluate(()=>{const tab={...s.activeTab(),draft:{...s.activeTab().draft,body:{...s.newBody('urlencoded'),urlencoded:[s.kv('id','{{missingForm}}')]}}};fixture.env.defaults.headers.push(s.kv('X-Missing','{{missingHeader}}'));const built=s.buildSendDraft(tab);fixture.env.defaults.headers.pop();return built.missing.includes('missingForm')&&built.missing.includes('missingHeader');}));
  check('循环变量被标记为未解析',await page.evaluate(()=>{fixture.env.variables.push(s.kv('cycle','{{cycle}}'));const tab={...s.activeTab(),draft:{...s.activeTab().draft,url:'https://example.invalid/{{cycle}}'}};return s.buildSendDraft(tab).missing.includes('cycle');}));
  check('cURL 保留二进制文件路径和 query 特殊字符',await page.evaluate(()=>{const draft={method:'POST',url:'example.invalid',params:[s.kv('name',"a !'()*")],headers:[],body:{mode:'file',file:'D:/data/body.bin'}};const curl=p.requestCurl(draft);return curl.includes('name=a+%21%27%28%29%2A')&&curl.includes("--data-binary '@D:/data/body.bin'");}));
  check('文档模板URL和Params不会重复query',await page.evaluate(()=>p.requestUrl({url:'https://example.invalid/items?page=1',params:[s.kv('page','1')]})==='https://example.invalid/items?page=1'));
  check('查询表覆盖URL同名值且保留其他参数',await page.evaluate(()=>p.requestUrl({url:'https://example.invalid/items?page=1&sort=asc',params:[s.kv('page','2')]})==='https://example.invalid/items?page=2&sort=asc'));
  check('重复查询键与fragment保留',await page.evaluate(()=>p.requestUrl({url:'https://example.invalid/items?tag=a&tag=b#section',params:[s.kv('page','1')]})==='https://example.invalid/items?page=1&tag=a&tag=b#section'));
  await page.locator('.urlbar .primary').click();await page.waitForFunction(()=>s.activeTab().response&&!s.activeTab().running);
  const last=await page.evaluate(()=>s.activeTab().lastRequestSnapshot);
  check('发送保留当次变量快照',last.environment==='Development'&&last.draft.headers.find(row=>row.key==='Authorization').value==='Bearer test-secret-428');
  if(native){const echo=await page.evaluate(()=>JSON.parse(s.activeTab().response.bodyText));check('真实引擎收到解析后的 Authorization',Object.entries(echo.headers).some(([k,v])=>k.toLowerCase()==='authorization'&&v==='Bearer test-secret-428'));check('预览与真实 query 一致',echo.query==='workspace=ws_42&limit=20');check('预览与真实 Body 和动态变量一致',echo.received===last.draft.body.raw.content&&Object.entries(echo.headers).some(([k,v])=>k.toLowerCase()==='x-random'&&v===JSON.parse(echo.received).nonce));}
  else {const echo=await page.evaluate(()=>JSON.parse(s.activeTab().response.bodyText));check('快照与提交引擎的请求完全一致',JSON.stringify(last.draft.headers)===JSON.stringify(echo.request.headers)&&JSON.stringify(last.draft.body)===JSON.stringify(echo.request.body));}
  await page.evaluate(()=>{fixture.env.name='Staging';fixture.env.variables.find(row=>row.key==='workspace').value='ws_99';});
  await page.locator('.request-preview-trigger').click();check('当前请求反映最新环境',(await modal.locator('.preview-url').innerText()).includes('workspace=ws_99'));
  await modal.getByRole('radio',{name:'上次发送',exact:true}).click();check('上次发送不受后续环境修改影响',(await modal.locator('.preview-url').innerText()).includes('workspace=ws_42')&&(await modal.innerText()).includes('Development'));
  await page.waitForTimeout(220);await page.screenshot({path:`.design-qa/preview-headers-${native?'native':'browser'}.png`});
  if(!native)await page.setViewportSize({width:1000,height:640});await page.waitForTimeout(120);check('小窗口预览没有横向溢出',await modal.evaluate(el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=innerWidth&&el.scrollWidth<=el.clientWidth+1));
  await page.screenshot({path:`.design-qa/preview-compact-${native?'native':'browser'}.png`});await page.keyboard.press('Escape');await page.waitForTimeout(220);
  await page.evaluate(()=>{s.activeTab().draft.headers.push(s.kv('X-Missing','{{notDefined}}'));s.emit('rerender');});await page.locator('.request-preview-trigger').click();check('缺失变量在预览中明确标出',(await modal.locator('.request-preview-warning').innerText()).includes('notDefined'));await page.keyboard.press('Escape');await page.waitForTimeout(220);
  await page.evaluate(()=>{s.activeTab().protocol='ws';s.activeTab().kind='ws';s.activeTab().draft.url='wss://example.invalid/{{workspace}}';s.activeTab().draft.params=[];s.activeTab().draft.headers=[];s.emit('rerender');});
  await page.locator('.request-preview-trigger').click();check('WebSocket 显示实际握手地址',(await modal.locator('.preview-url').innerText())==='wss://example.invalid/ws_99');check('WebSocket 不显示 cURL 与 HTTP Body',await modal.getByRole('tab',{name:'cURL',exact:true}).count()===0&&await modal.getByRole('tab',{name:'Body',exact:true}).count()===0);await page.keyboard.press('Escape');await page.waitForTimeout(220);
  await page.evaluate(()=>{s.activeTab().protocol='sse';s.activeTab().kind='request';s.activeTab().draft.url='http://127.0.0.1:8899/sse?workspace={{workspace}}';s.emit('rerender');});await page.locator('.request-preview-trigger').click();check('SSE 共用预览入口',(await modal.locator('.preview-url').innerText()).includes('workspace=ws_99'));await page.keyboard.press('Escape');
  check('无 JavaScript 异常',!errors.length);
  fs.writeFileSync(`.design-qa/preview-${native?'native':'browser'}-results.json`,JSON.stringify({results,errors},null,2));console.log(`${results.filter(x=>x.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(x=>!x.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1)});
