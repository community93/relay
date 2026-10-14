const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{execFile}=require('node:child_process');
const APP_VERSION=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8')).version,SHOTS='reports/automation-'+APP_VERSION;
const results=[];const check=(name,ok,detail)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];
 page.on('pageerror',e=>errors.push(e.message));let config,connectionPath=path.resolve('.design-qa/automation-connection.json');
 try {
  if(process.env.RELAY_QA_SOURCE){await page.route('**/js/automation.js',route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync('web/js/automation.js','utf8')}));await page.reload();}
  await page.waitForSelector('.rail-btn');
  const dataPath=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(dataPath).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated data');
  check('连接默认关闭',await page.evaluate(async()=>!(await window.__TAURI__.core.invoke('automation_status'))));
  await page.getByRole('button',{name:'AI 连接',exact:true}).click();
  await page.getByRole('radio',{name:'可执行'}).click();
  await page.locator('.ai-connection-hosts input').fill('127.0.0.1');
  await page.getByRole('button',{name:'开启 AI 连接',exact:true}).click();await page.waitForSelector('.ai-connection-state.connected');
  config=await page.evaluate(()=>window.__TAURI__.core.invoke('automation_status'));
  fs.mkdirSync(SHOTS,{recursive:true});await page.waitForTimeout(300);await page.screenshot({path:`${SHOTS}/connection-light.png`});
  check('连接面板不暴露token且地址完整',!(await page.locator('.modal').innerText()).includes(config.token)&&(await page.locator('.ai-connection-address').innerText())===config.baseUrl);
  await page.keyboard.press('Escape');await page.waitForTimeout(150);
  const headers={Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
  async function raw(command,extra={}){const r=await fetch(config.baseUrl+'/v1/command',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(command)});return {status:r.status,...await r.json()};}
  async function call(command){const r=await raw(command);if(!r.ok)throw Error(JSON.stringify(r));return r.data;}
  async function wait(id){for(let i=0;i<120;i++){const job=await call({action:'job.get',id});if(job.state!=='running')return job;await new Promise(r=>setTimeout(r,100));}throw Error('Job timeout');}
  check('未认证请求返回401',(await raw({action:'workspace.list'},{Authorization:''})).status===401);
  /* ---- capability tiers -------------------------------------------------------
     The tier check is the only thing standing between "an AI tool can drive Relay"
     and "an AI tool can aim Relay at anything the user's saved credentials reach",
     so the boundary is tested directly rather than assumed from the happy path. */
  check('可执行连接回报权限与主机白名单',config.scope==='execute'&&Array.isArray(config.allowedHosts)&&config.allowedHosts.includes('127.0.0.1'),{scope:config.scope,hosts:config.allowedHosts});
  const listed=await call({action:'workspace.list'});
  const aRequestId=listed.collections[0]?.requests[0]?.id;
  check('workspace.list 只回报当前权限可达的 action',listed.scope==='execute'&&listed.actions.includes('request.execute')&&listed.actions.length===15,{actions:listed.actions});
  async function reopen(scope,allowedHosts){
    await page.evaluate(()=>window.__TAURI__.core.invoke('automation_stop'));
    config=await page.evaluate(async a=>window.__TAURI__.core.invoke('automation_start',{scope:a.scope,allowedHosts:a.allowedHosts}),{scope,allowedHosts});
    headers.Authorization='Bearer '+config.token;
    return config;
  }
  await reopen('write',[]);
  const refusedExecute=await raw({action:'request.execute',id:aRequestId});
  check('可编辑连接下真实执行被403拒绝',refusedExecute.status===403&&refusedExecute.error.code==='insufficient_scope'&&/scope "execute"/.test(refusedExecute.error.message),refusedExecute);
  check('可编辑连接仍可写入配置',(await raw({action:'entity.get',type:'request',id:aRequestId})).status===200);
  await reopen('read',[]);
  const refusedWrite=await raw({action:'environment.upsert',data:{name:'只读越权'}});
  check('只读连接下写入被403拒绝',refusedWrite.status===403&&refusedWrite.error.code==='insufficient_scope',refusedWrite);
  check('只读连接仍可读取',(await raw({action:'workspace.list'})).status===200);
  check('未知 action 被拒绝',(await raw({action:'request.delete_everything'})).status===400);
  check('空白名单的可执行连接开不起来',await page.evaluate(async()=>{try{await window.__TAURI__.core.invoke('automation_start',{scope:'execute',allowedHosts:[]});return 'started';}catch(e){return String(e&&e.message||e);}}).then(r=>r!=='started'&&/主机/.test(r)),'');
  await reopen('execute',['127.0.0.1']);
  const offList=await call({action:'request.upsert',id:'ai-offlist',collectionId:listed.collections[0].id,data:{draft:{method:'GET',url:'https://api.off-list.test/health'}}});
  const blocked=await raw({action:'request.execute',id:'ai-offlist'});
  check('白名单外主机在执行前被拦下',blocked.ok===false&&blocked.error.code==='scope'&&/off-list\.test/.test(blocked.error.message),blocked);
  // Refusing before a job exists is the point: a blocked execution that still left a
  // job record would look to the user like an attempt had been made.
  check('被拦下的请求没有留下任务记录',blocked.error.jobId===undefined&&blocked.status===403,blocked);
  /* ---- MCP over the same listener, and the per-hop host pin ----
     Two different clients speak to this port: a hand-written skill posts Relay's own
     envelope, an MCP client posts JSON-RPC. Both must land on the same gate, so the
     scope checks above are repeated through /mcp rather than assumed. */
  async function rpc(method,params,extra={},id='rpc-1'){const r=await fetch(config.baseUrl+'/mcp',{method:'POST',headers:{...headers,...extra},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});return {status:r.status,text:await r.text()};}
  async function call2(method,params,extra={}){const r=await rpc(method,params,extra);let body;try{body=JSON.parse(r.text);}catch{body=null;}return {status:r.status,body,data:body?.result,error:body?.error};}
  const init=await call2('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'e2e',version:'1'}});
  check('MCP initialize 报协议版本与权限',init.status===200&&init.data?.protocolVersion==='2025-03-26'&&init.data?.serverInfo?.name==='Relay'&&/scope "execute"/.test(init.data?.instructions||''),init);
  check('MCP 不认识的协议版本回落到最新实现',(await call2('initialize',{protocolVersion:'2099-01-01',capabilities:{},clientInfo:{name:'e2e',version:'1'}})).data?.protocolVersion==='2025-06-18');
  const listedTools=(await call2('tools/list',{})).data?.tools||[];
  check('可执行连接下 MCP 工具表完整且名字不含点',listedTools.length===15&&listedTools.every(t=>/^[a-z0-9_]+$/.test(t.name)&&t.inputSchema&&t.description),listedTools.map(t=>t.name));
  check('MCP 工具表不暴露内部动作',!listedTools.some(t=>t.name==='mcp_tools'),listedTools.map(t=>t.name));
  const ping=await call2('ping',{});check('MCP ping 可用',ping.status===200&&ping.body?.result!==undefined,ping);
  // A notification carries no id, so the answer must be an empty 202. Replying with a
  // body makes strict clients treat the connection as broken.
  const CRLF = String.fromCharCode(13, 10);
  const notifyBody = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const notedRaw = await new Promise((resolve, reject) => { const u = new URL(config.baseUrl), socket = net.connect(Number(u.port), '127.0.0.1', () => socket.write(['POST /mcp HTTP/1.1', `Host: ${u.host}`, `Authorization: Bearer ${config.token}`, 'Content-Type: application/json', `Content-Length: ${notifyBody.length}`, '', notifyBody].join(CRLF))); let raw = ''; socket.on('data', c => raw += c); socket.on('end', () => { const i = raw.indexOf(CRLF + CRLF); resolve({ head: raw.slice(0, i), body: raw.slice(i + 4) }); }); socket.on('error', reject); });
  check('MCP 通知返回202且没有响应体',/^HTTP\/1\.1 202/.test(notedRaw.head)&&notedRaw.body==='',notedRaw);
  check('MCP 未知方法返回JSON-RPC错误',(await call2('resources/list',{})).error?.code===-32601);
  check('MCP 未鉴权返回401',(await rpc('tools/list',{},{Authorization:''})).status===401);
  await reopen('read',[]);
  const readOnly=(await call2('tools/list',{})).data?.tools||[];
  check('只读连接的MCP只给读工具',readOnly.length===3&&readOnly.map(t=>t.name).sort().join()==='entity_get,job_get,workspace_list',readOnly.map(t=>t.name));
  const crossed=await call2('tools/call',{name:'request_execute',arguments:{id:aRequestId}});
  // The refusal must come back as a tool result the model can read, not a transport
  // error it will retry or a hard JSON-RPC failure it will swallow.
  check('越过MCP工具表直接调用高权限工具被拒',crossed.data?.isError===true&&/scope "execute"/.test(crossed.data?.content?.[0]?.text||''),crossed);
  check('只读连接下MCP读取可用',(await call2('tools/call',{name:'workspace_list',arguments:{}})).data?.isError===false);
  await reopen('execute',['127.0.0.1']);
  const viaMcp=await call2('tools/call',{name:'request_execute',arguments:{id:'ai-offlist'}});
  check('MCP路径同样受主机白名单约束',viaMcp.data?.isError===true&&/off-list\.test/.test(viaMcp.data?.content?.[0]?.text||''),viaMcp);
  const badTool=await call2('tools/call',{name:'collection_delete_everything',arguments:{}});
  check('MCP未知工具返回-32602',badTool.error?.code===-32602,badTool);
  // 127.0.0.1 and localhost are different strings but the same machine, which makes
  // them a cheap cross-host redirect. The allowlist has to cover the hop, not just
  // the URL the agent typed -- otherwise any allowlisted host can bounce traffic
  // somewhere the user never named while carrying the same credentials.
  await call({action:'request.upsert',id:'ai-pin',collectionId:listed.collections[0].id,data:{name:'跳转出白名单',draft:{method:'GET',url:'http://127.0.0.1:8899/redirect-cross'}}});
  const bounced=await wait((await call({action:'request.execute',id:'ai-pin'})).jobId);
  check('跟随跳转离开白名单时中止并把原因报出来',bounced.state==='completed'&&bounced.result?.ok===false&&/未授权主机 localhost/.test(bounced.result?.response?.error||'')&&bounced.result?.response?.errorKind==='redirect',bounced);
  await reopen('execute',['127.0.0.1','localhost']);
  const followed=await wait((await call({action:'request.execute',id:'ai-pin'})).jobId);
  check('白名单覆盖跳转目标后正常跟随',followed.state==='completed'&&followed.result?.response?.status===200&&/localhost:8899\/hello$/.test(followed.result?.response?.finalUrl||''),followed);
  // A human pressing Send passes an empty allowlist, which must stay unrestricted.
  const byHand=await page.evaluate(async()=>{const s=await import('./js/state.js'),api=await import('./js/api.js');
    return await api.execute(s.findNode('ai-pin').node.request,'hand-pin',[]).catch(e=>({error:String(e)}));});
  check('手动发送不受跳转白名单限制',byHand.status===200&&/localhost:8899\/hello$/.test(byHand.finalUrl||''),byHand);
  await call({action:'request.upsert',id:'ai-offlist',collectionId:listed.collections[0].id,expectedRevision:offList.revision,data:{draft:{method:'GET',url:'http://127.0.0.1:19110/health'}}});
  check('错误token返回401',(await raw({action:'workspace.list'},{Authorization:'Bearer wrong'})).status===401);
  check('浏览器Origin请求返回403',(await raw({action:'workspace.list'},{Origin:'https://example.invalid'})).status===403);
  const health=await (await fetch(config.baseUrl+'/v1/health',{headers})).json();check('真实服务返回版本和实例ID',health.ok&&health.data.version===APP_VERSION&&health.data.instanceId===config.instanceId);
  check('未知命令和字段被拒绝',(await raw({action:'delete.everything'})).status===400&&(await raw({action:'workspace.list',unexpected:true})).status===400);
  const oversize=await new Promise((resolve,reject)=>{const u=new URL(config.baseUrl),socket=net.connect(Number(u.port),'127.0.0.1',()=>socket.write(`POST /v1/command HTTP/1.1\r\nHost: ${u.host}\r\nContent-Length: 2097153\r\n\r\n`));let response='';socket.on('data',chunk=>response+=chunk);socket.on('end',()=>resolve(response));socket.on('error',reject);});
  check('大于2MiB请求在读取Body前拒绝',oversize.startsWith('HTTP/1.1 413'));
  await call({action:'collection.upsert',id:'ai-collection',data:{name:'AI 接口交付',description:'真实执行演示'}});
  let req=await call({action:'request.upsert',id:'ai-project',collectionId:'ai-collection',data:{name:'项目列表',curl:"curl 'http://127.0.0.1:18999/projects?page=1' -H 'Authorization: Bearer private-ai-secret'"}});
  check('cURL通过真实解析器创建请求',req.entity.request.method==='GET'&&req.entity.request.url.includes('projects')&&req.entity.request.headers.length===1,req);
  check('敏感header读出被脱敏',req.entity.request.headers[0].value==='<redacted>'&&JSON.stringify(req).indexOf('private-ai-secret')<0);
  req=await call({action:'request.upsert',id:'ai-project',expectedRevision:req.revision,data:{draft:{checks:[{kind:'status',expected:'200'},{kind:'json',operator:'type',path:'$.data',expected:'array'}]}}});
  check('新集合和检查实时显示',await page.evaluate(async()=>{const s=await import('./js/state.js');return s.findNode('ai-project')?.node.request.checks.length===2&&s.state.collections.some(c=>c.id==='ai-collection');}));
  check('无版本更新返回冲突',(await raw({action:'request.upsert',id:'ai-project',data:{name:'覆盖'}})).status===409);
  const rev=req.revision;req=await call({action:'request.upsert',id:'ai-project',expectedRevision:req.revision,data:{description:'读取项目列表'}});
  check('旧版本更新返回冲突',(await raw({action:'request.upsert',id:'ai-project',expectedRevision:rev,data:{name:'旧版本覆盖'}})).status===409);
  await call({action:'entity.open',type:'request',id:'ai-project'});
  await page.evaluate(async()=>{const s=await import('./js/state.js');s.activeTab().draft.name='用户未保存草稿';s.markDirty();});
  check('AI不能覆盖用户未保存草稿',(await raw({action:'request.upsert',id:'ai-project',expectedRevision:req.revision,data:{name:'AI覆盖'}})).status===409);
  check('原草稿保留',await page.evaluate(async()=>(await import('./js/state.js')).activeTab().draft.name==='用户未保存草稿'));
  await page.evaluate(async()=>{const s=await import('./js/state.js');const tab=s.activeTab();tab.draft=structuredClone(s.findNode('ai-project').node.request);tab.dirty=false;});
  await page.evaluate(async()=>{const s=await import('./js/state.js');let unlisten;unlisten=s.on('persistence',event=>{if(event.domain==='collections'&&event.phase==='saving'){unlisten();const tab=s.activeTab();tab.draft.name='保存期间输入的草稿';s.markDirty(tab);}});});
  req=await call({action:'request.upsert',id:'ai-project',expectedRevision:req.revision,data:{description:'AI保存期间允许继续编辑'}});
  check('AI保存期间新输入的草稿也不覆盖',await page.evaluate(async()=>{const s=await import('./js/state.js');return s.activeTab().dirty&&s.activeTab().draft.name==='保存期间输入的草稿';}));
  await page.evaluate(async()=>{const s=await import('./js/state.js');const tab=s.activeTab();tab.draft=structuredClone(s.findNode('ai-project').node.request);tab.dirty=false;});
  let job=await call({action:'request.execute',id:'ai-project'});job=await wait(job.jobId);
  check('外部调用真实HTTP并检查响应',job.state==='completed'&&job.result.ok&&job.result.response.status===200&&job.result.response.checkResult.checks.length===2,job);
  check('请求工作台可查看AI执行响应',await page.locator('#response-host').innerText().then(t=>t.includes('200')));
  check('响应token脱敏且不含原始字节副本',!JSON.stringify(job).includes('response-secret-for-export')&&!JSON.stringify(job).includes('private-ai-secret')&&!('bodyRawBase64'in job.result.response));
  let doc=await call({action:'document.upsert',id:'ai-delivery',data:{name:'项目接口交付',overview:'提供项目列表查询。',version:'1.0.0'}});
  let link=await call({action:'document.endpoint.upsert',documentId:'ai-delivery',requestId:'ai-project',expectedRevision:doc.revision,data:{summary:'查询项目列表',description:'列出可见项目。',notes:'本例用于验证交付流程。'}});
  check('关联文档复用真实响应证据',link.entity.blocks[0].verified&&link.entity.blocks[0].contract.reviewed===false,link);
  await call({action:'entity.open',type:'document',id:'ai-delivery'});doc=await call({action:'entity.get',type:'document',id:'ai-delivery'});
  await page.evaluate(async()=>{const s=await import('./js/state.js');let unlisten;unlisten=s.on('persistence',event=>{if(event.domain==='docs'&&event.phase==='saving'){unlisten();const input=document.querySelector('[aria-label="交付概述"]');input.value='用户在AI保存期间补写的概述';input.dispatchEvent(new Event('input',{bubbles:true}));}});});
  doc=await call({action:'document.upsert',id:'ai-delivery',expectedRevision:doc.revision,data:{version:'1.0.1'}});
  check('AI保存期间文档编辑仍写入当前对象',doc.entity.overview==='用户在AI保存期间补写的概述');
  job=await call({action:'document.verify',id:'ai-delivery'});job=await wait(job.jobId);
  check('文档批量验证通过且保留检查',job.state==='completed'&&job.result.ok&&job.result.endpoints[0].response.checkResult.ok,job);
  doc=await call({action:'entity.get',type:'document',id:'ai-delivery'});
  const endpoint=doc.endpoints[0],metadata=Object.fromEntries(endpoint.fields.map(f=>[f.id,{description:({'params:page':'页码，从1开始','response:data[].id':'项目编号','response:data[].name':'项目名称','response:data[].active':'是否启用'})[f.id]||f.path+' 字段',...(f.group!=='Response'?{required:false}:{})}]));
  link=await call({action:'document.endpoint.upsert',id:endpoint.id,documentId:'ai-delivery',requestId:'ai-project',expectedRevision:doc.revision,data:{fields:metadata}});
  check('AI补写真实字段说明',Object.keys(metadata).length>=4&&link.issues.length===0,link.issues);
  check('API拒绝伪造验证和已确认状态',(await raw({action:'document.endpoint.upsert',id:endpoint.id,documentId:'ai-delivery',requestId:'ai-project',expectedRevision:link.revision,data:{reviewed:true,verified:{at:1}}})).status===400);
  await call({action:'entity.open',type:'document',id:'ai-delivery'});await page.waitForSelector('.delivery-endpoint');
  check('应用中直接查看AI文档',await page.locator('.delivery-endpoint-title').inputValue()==='查询项目列表');
  await page.locator('.delivery-tabs').getByRole('button',{name:'字段说明',exact:true}).click();await page.screenshot({path:`${SHOTS}/document-light.png`});
  const draftExport=await call({action:'document.export',id:'ai-delivery',format:'markdown'});
  check('导出保留未确认交付状态',draftExport.review[0].status.kind==='verified');
  await page.locator('.delivery-endpoint-foot').getByRole('button',{name:'确认交付',exact:true}).click();
  const finalExport=await call({action:'document.export',id:'ai-delivery',format:'markdown'});
  check('用户确认后导出为可交付',finalExport.review[0].status.kind==='ready'&&finalExport.content.includes('页码，从1开始'));
  check('交付请求示例不重复query参数',!finalExport.content.includes('page=1&page=1'));
  check('三种格式导出包含说明并脱敏',await Promise.all(['markdown','html','openapi'].map(async format=>{const e=await call({action:'document.export',id:'ai-delivery',format});return e.content.includes('查询项目列表')&&!e.content.includes('private-ai-secret')&&!e.content.includes('response-secret-for-export');})).then(rows=>rows.every(Boolean)));
  await call({action:'request.upsert',id:'ai-ws',collectionId:'ai-collection',data:{name:'WS连接',curl:"curl 'ws://127.0.0.1:8900/echo'"}});
  await call({action:'request.upsert',id:'ai-sse',collectionId:'ai-collection',data:{name:'SSE连接',curl:"curl 'http://127.0.0.1:8899/sse' -H 'Accept: text/event-stream'"}});
  check('AI导入保留WS和SSE类型',(await call({action:'entity.get',type:'request',id:'ai-ws'})).entity.protocol==='ws'&&(await call({action:'entity.get',type:'request',id:'ai-sse'})).entity.protocol==='sse');
  const queryDraft=await call({action:'request.upsert',id:'ai-params',collectionId:'ai-collection',data:{name:'URL查询参数',draft:{url:'http://127.0.0.1:18999/projects?page=2&token=private-query-token'}}});
  check('AI直接填写URL也生成查询字段并脱敏',queryDraft.entity.request.params.length===2&&queryDraft.entity.request.params[0].value==='2'&&!JSON.stringify(queryDraft).includes('private-query-token'));
  const repeatedQuery=await call({action:'request.upsert',id:'ai-repeated-query',collectionId:'ai-collection',data:{name:'重复查询参数',draft:{url:'http://127.0.0.1:18999/projects?tag=a&tag=b',params:[{key:'page',value:'3'}]}}});
  check('AI查询表覆盖同名值且保留重复的其他键',repeatedQuery.entity.request.url.endsWith('page=3&tag=a&tag=b')&&repeatedQuery.entity.request.params.length===3,repeatedQuery);
  check('不支持的自动流式执行明确报错',(await raw({action:'request.execute',id:'ai-ws'})).error.code==='unsupported');
  check('文件访问配置不被接口接受',(await raw({action:'request.upsert',collectionId:'ai-collection',data:{name:'文件',draft:{url:'http://127.0.0.1:18999',body:{mode:'file',file:'C:/private.txt'}}}})).status===400);
  await call({action:'request.upsert',id:'ai-login',collectionId:'ai-collection',data:{name:'登录',draft:{url:'http://127.0.0.1:19110/login',extractors:[{name:'token',source:'json',path:'$.data.token'}]}}});
  await call({action:'request.upsert',id:'ai-query',collectionId:'ai-collection',data:{name:'鉴权查询',draft:{url:'http://127.0.0.1:19110/items/7',headers:[{key:'Authorization',value:'Bearer {{token}}'}],checks:[{kind:'json',operator:'equals',path:'$.authorized',expected:'true'}]}}});
  await call({action:'runner.upsert',id:'ai-chain',data:{name:'AI 登录链路',sources:['ai-login','ai-query'],stopOnError:true}});
  job=await call({action:'runner.execute',id:'ai-chain'});job=await wait(job.jobId);
  check('AI运行计划可提取token并串行验证',job.result.ok&&job.result.run.totals.passed===2,job);
  check('变量链路证据不泄露token',!JSON.stringify(job).includes('chain-token'));
  await call({action:'request.upsert',id:'ai-slow',collectionId:'ai-collection',data:{name:'慢请求',draft:{url:'http://127.0.0.1:19110/slow'}}});
  job=await call({action:'request.execute',id:'ai-slow'});await new Promise(r=>setTimeout(r,100));const cancel=await call({action:'job.cancel',id:job.jobId});check('可以取消AI执行',cancel.state==='cancelled');
  const retry=await call({action:'request.execute',id:'ai-slow'});const retried=await wait(retry.jobId);
  check('取消后重试不会被旧响应覆盖',retried.result.ok&&await page.evaluate(async()=>{const s=await import('./js/state.js');return s.state.tabs.find(t=>t.refId==='ai-slow')?.response?.status===200;}));
  fs.writeFileSync(connectionPath,JSON.stringify(config));
  const py=process.env.RELAY_PYTHON||'python',script='skills/relay-workflow/scripts/relay_client.py';
  const runClient=(args,input)=>new Promise(resolve=>{const process=execFile(py,[script,'--config',connectionPath,...args],{encoding:'utf8'},(error,stdout,stderr)=>resolve({status:error?error.code:0,stdout,stderr}));if(input!==undefined)process.stdin.end(input);});
  const list=await runClient(['list']);
  check('可移植客户端真实读取工作区',list.status===0&&JSON.parse(list.stdout).documents.some(d=>d.id==='ai-delivery'),list.stderr);
  const output=path.resolve(`${SHOTS}/ai-delivery.html`);if(fs.existsSync(output))fs.unlinkSync(output);
  const exported=await runClient(['export','--id','ai-delivery','--format','html','--output',output]);
  check('skill客户端真实导出HTML',exported.status===0&&fs.readFileSync(output,'utf8').includes('查询项目列表'),exported.stderr);
  const current=await call({action:'entity.get',type:'request',id:'ai-project'});
  await call({action:'request.upsert',id:'ai-project',expectedRevision:current.revision,data:{draft:{checks:[{kind:'json',operator:'equals',path:'$.data',expected:'[]'}]}}});
  const changedDoc=await call({action:'entity.get',type:'document',id:'ai-delivery'});check('AI改请求后文档自动过期',changedDoc.endpoints[0].status.kind==='stale');
  const beforeFailed=changedDoc.entity.blocks[0].verified.at;
  const business=await runClient(['call','--file','-','--wait'],JSON.stringify({action:'document.verify',id:'ai-delivery'}));
  check('skill等待真实执行且业务失败返回非零',business.status===2&&JSON.parse(business.stdout).result.ok===false,business.stderr);
  const failedDoc=await call({action:'entity.get',type:'document',id:'ai-delivery'});check('验证失败保留上次样例且取消交付状态',failedDoc.entity.blocks[0].verified.at===beforeFailed&&failedDoc.endpoints[0].status.kind==='failed'&&!failedDoc.entity.blocks[0].contract.reviewed);
  const duplicate=await runClient(['export','--id','ai-delivery','--format','html','--output',output]);check('客户端避免意外覆盖文件',duplicate.status!==0);
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.getByRole('button',{name:'AI 连接',exact:true}).click();await page.waitForSelector('.ai-connection-state.connected');await page.waitForTimeout(300);await page.screenshot({path:`${SHOTS}/connection-dark.png`});
  await page.getByRole('button',{name:'断开',exact:true}).click();check('断开后旧端口不可访问',await fetch(config.baseUrl+'/v1/health',{headers}).then(()=>false).catch(()=>true));
  await page.getByRole('button',{name:'开启 AI 连接',exact:true}).click();const next=await page.evaluate(()=>window.__TAURI__.core.invoke('automation_status'));check('重启连接轮换token和实例',next.token!==config.token&&next.instanceId!==config.instanceId);
  const old=await fetch(next.baseUrl+'/v1/health',{headers}).then(r=>r.status);check('旧token无法访问新连接',old===401);
  await page.getByRole('button',{name:'断开',exact:true}).click();await page.keyboard.press('Escape');
  check('无未捕获前端异常',errors.length===0,errors);
 }catch(error){check('automation scenario',false,error.stack);}finally{if(fs.existsSync(connectionPath))fs.unlinkSync(connectionPath);await browser.close();}
 console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);fs.writeFileSync(`${SHOTS}/results.json`,JSON.stringify(results,null,2));process.exitCode=results.some(r=>!r.ok)?1:0;
})();
