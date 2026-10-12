const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path');
const results=[],check=(name,ok,detail)=>{results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}`)};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try {
  await page.waitForSelector('.rail-btn');
  const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());
  if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native data');
  await page.evaluate(async()=>{window.s=await import('./js/state.js');window.t=await import('./js/tools.js');window.p=await import('./js/protocol.js');window.w=await import('./js/ws.js');window.api=await import('./js/api.js');s.state.collections=[s.newCollection('Protocol import')];s.state.tabs=[];s.state.environments=[];s.state.settings.activeEnvironmentId=null;s.newTab();s.emit('tree');});
  const cases=[
   ["curl 'ws://127.0.0.1:19001/echo'",'ws'],
   ["curl 'wss://example.test/socket'",'ws'],
   ["curl 'https://example.test/socket' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Protocol: relay.json'",'ws'],
   ["curl 'http://127.0.0.1:8899/sse' -H 'Accept: text/event-stream'",'sse'],
   ["curl 'https://example.test/events' -H 'Accept: application/json, text/event-stream; charset=utf-8'",'sse'],
   ["curl 'https://example.test/chat' -H 'Content-Type: application/json' -d '{\"stream\":true}'",'sse'],
   ["curl 'https://example.test/chat' -d '{\"stream\":false}'",'http'],
   ["curl -N 'https://example.test/sse'",'http'],
   ["curl 'https://example.test/events' -H 'Accept: text/event-stream; q=0'",'http'],
   ["curl 'https://example.test/plain' -H 'Authorization: Bearer copied-token'",'http'],
  ];
  await page.evaluate(text=>t.importCurlDialog(null,text),cases.map(x=>x[0]).join('\n'));
  const dialog=page.locator('.modal').last();await dialog.locator('.pick').nth(cases.length-1).waitFor();
  for(let i=0;i<cases.length;i++)check(`cURL 自动识别 ${i+1}: ${cases[i][1]}`,await dialog.locator('.import-protocol').nth(i).getAttribute('data-value')===cases[i][1]);
  await page.screenshot({path:'.design-qa/protocol-import-preview.png'});
  await dialog.locator('.import-protocol').nth(7).click();await page.getByRole('menuitem',{name:'SSE',exact:true}).click();
  await dialog.getByRole('textbox',{name:'请求 8 名称',exact:true}).fill('手动指定流');
  await dialog.getByRole('button',{name:'导入',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.overlay:not(.closing)'));
  check('首个 WS 导入后立即进入 WS 面板',await page.evaluate(()=>s.activeTab().protocol==='ws'&&s.activeTab().kind==='ws'));
  check('手动指定 SSE 与名称一起保存',await page.evaluate(()=>s.state.collections[0].children[7].protocol==='sse'&&s.state.collections[0].children[7].name==='手动指定流'));
  check('复制的 Bearer Header 不被空 Token 覆盖',await page.evaluate(()=>{const node=s.state.collections[0].children[9];s.openRequest(node);return s.buildSendDraft(s.activeTab()).draft.headers.find(h=>h.key.toLowerCase()==='authorization')?.value.trim()==='Bearer copied-token'}));
  for(const index of [0,2,3,7]){
   await page.evaluate(index=>{s.state.tabs=[];s.openRequest(s.state.collections[0].children[index]);},index);
   check(`从集合重开协议 ${index}`,await page.evaluate(index=>s.activeTab().protocol===(index===7?'sse':index<3?'ws':'sse'),index));
  }
  check('集合 JSON 导入接口已移除',await page.evaluate(()=>typeof t.importPostmanDialog==='undefined'&&typeof t.fromPostmanCollection==='undefined'&&typeof t.fromPostmanEnvironment==='undefined'));
  check('普通集合 JSON 不触发粘贴导入',await page.evaluate(()=>!t.openImportFromText('{"info":{"_postman_id":"removed"},"item":[]}')&&!document.querySelector('.overlay:not(.closing)')));
  await page.keyboard.press('Control+k');await page.locator('.palette input').fill('导入');
  check('命令面板仅保留 cURL 导入命令',await page.locator('.palette-item').filter({hasText:'Postman'}).count()===0&&await page.locator('.palette-item').filter({hasText:'导入 cURL'}).count()===1);await page.keyboard.press('Escape');
  await page.getByTitle('新建集合、文件夹或请求',{exact:true}).click();
  check('集合菜单仅保留 cURL 导入',await page.getByRole('menuitem',{name:'导入 Postman 导出文件',exact:true}).count()===0&&await page.getByRole('menuitem').filter({hasText:'导入 cURL'}).count()===1);await page.keyboard.press('Escape');
  check('禁用的协议头不参与推断',await page.evaluate(()=>p.inferProtocol({url:'https://test',headers:[{key:'Upgrade',value:'websocket',enabled:false},{key:'Accept',value:'text/event-stream',enabled:false}]})==='http'));
  await page.evaluate(async()=>{s.state.tabs=[];s.openRequest(s.state.collections[0].children[3]);await (await import('./js/request.js')).toggleStream(s.activeTab());});
  await page.waitForFunction(()=>s.activeTab().stream?.count===6&&!s.activeTab().running);
  check('导入 SSE 使用真实事件流接收 6 条事件',await page.evaluate(()=>s.activeTab().protocol==='sse'&&s.activeTab().stream.status===200));
  await page.evaluate(()=>Promise.all(['collections','tabs','settings','environments'].map(domain=>s.flushDomain(domain,{strict:true}))));await page.reload();await page.waitForSelector('.rail-btn');
  await page.evaluate(async()=>{window.s=await import('./js/state.js');window.t=await import('./js/tools.js');window.p=await import('./js/protocol.js');window.w=await import('./js/ws.js');window.api=await import('./js/api.js');});
  check('原生刷新后导入协议和手动选择继续保留',await page.evaluate(()=>s.state.collections[0].children[0].protocol==='ws'&&s.state.collections[0].children[3].protocol==='sse'&&s.state.collections[0].children[7].protocol==='sse'));
  await page.evaluate(async()=>{s.state.tabs=[];s.state.environments=[];const c=s.state.collections[0];c.headers=[{key:'X-Collection',value:'inherited',enabled:true}];c.auth={kind:'bearer',bearer:{token:'{{accessToken}}'}};
   const env=s.newEnvironment('WS env');env.variables=[{key:'accessToken',value:'live-token',enabled:true},{key:'payload',value:'双向消息',enabled:true}];env.defaults={...env.defaults,alwaysOnHeaders:true,headers:[{key:'Origin',value:'https://relay.test',enabled:true},{key:'Cookie',value:'session=fixture',enabled:true}]};s.state.environments=[env];s.state.settings.activeEnvironmentId=env.id;
   const node=c.children[0];node.request.url='ws://127.0.0.1:19001/auth?token=one%2Btwo';node.request.params=[{key:'token',value:'one+two',enabled:true}];node.request.headers=['Host','Upgrade','Connection','Sec-WebSocket-Key','Sec-WebSocket-Version'].map(key=>({key,value:key==='Upgrade'?'websocket':'stale',enabled:true}));node.request.subprotocols=['relay.json'];node.auth={kind:'inherit'};s.openRequest(node);window.tab=s.activeTab();s.emit('rerender');await w.toggle(tab);});
  await page.waitForFunction(()=>tab.ws.status==='open'||tab.ws.status==='error');
  check('真实 WS 继承认证、环境/集合头、Query、子协议后成功握手',await page.evaluate(()=>tab.ws.status==='open'),await page.evaluate(()=>tab.ws.error));
  await page.waitForFunction(()=>tab.ws.events.some(e=>e.text?.includes('hello')));
  check('服务器确认子协议 relay.json',await page.evaluate(()=>JSON.parse(tab.ws.events.find(e=>e.text?.includes('hello')).text).subprotocol==='relay.json'));
  check('WS 的 Auth 页签可用',await page.locator('#request-host .subtab').filter({hasText:/^Auth$/}).count()===1);
  await page.locator('.ws-send textarea').fill('{{payload}}');await page.locator('.ws-send textarea').press('Control+Enter');
  await page.waitForFunction(()=>tab.ws.events.some(e=>e.dir==='in'&&e.text==='双向消息')&&tab.ws.sent===1);
  check('Ctrl+Enter 发送替换后的变量消息并保持连接',await page.evaluate(()=>tab.ws.status==='open'&&tab.ws.events.some(e=>e.dir==='out'&&e.text==='双向消息'&&!e.pending&&!e.sendError)));
  check('消息流页签数量随收发更新',await page.evaluate(()=>document.getElementById(`ws-count-${tab.id}`).textContent===String(tab.ws.events.length)));
  await page.screenshot({path:'.design-qa/ws-authenticated-messages.png'});
  await page.locator('.ws-send textarea').fill('{{missing_message}}');await page.locator('.ws-send textarea').press('Control+Enter');
  check('缺失消息变量阻止发送',await page.evaluate(()=>tab.ws.sent===1)&&await page.locator('.toast').filter({hasText:'missing_message'}).count()>0);
  await page.evaluate(()=>{tab.auth={kind:'bearer',bearer:{token:'saved-token'}};s.markDirty(tab);});await page.locator('[data-save-tab]').click();await page.waitForFunction(()=>!tab.dirty);
  check('WS 保存请求认证落盘',await page.evaluate(async()=>JSON.parse(await api.loadDoc('collections'))[0].children[0].auth.bearer.token==='saved-token'));
  await page.evaluate(async()=>{await api.wsDisconnect(tab.ws.connId);s.state.tabs=[];s.openRequest(s.state.collections[0].children[0]);window.tab=s.activeTab();});
  check('WS 认证从集合重开恢复',await page.evaluate(()=>tab.auth.bearer.token==='saved-token'));
  // Use fresh tabs per connection; no copied transport state or stale callbacks.
  const fresh=async(endpoint,settings={})=>{await page.evaluate(async({endpoint,settings})=>{if(tab.ws)await api.wsDisconnect(tab.ws.connId);s.newTab('ws');window.tab=s.activeTab();tab.draft.url='ws://127.0.0.1:19001/'+endpoint;tab.draft.settings=settings;tab.auth={kind:'noauth'};s.emit('rerender');await w.toggle(tab);},{endpoint,settings});};
  await fresh('duplex');await page.waitForFunction(()=>tab.ws.status==='open'&&tab.ws.recv>3);
  for(let i=0;i<5;i++){await page.locator('.ws-send textarea').fill('duplex-'+i);await page.locator('.ws-send textarea').press('Control+Enter');}
  await page.waitForFunction(()=>tab.ws.sent===5&&Array.from({length:5},(_,i)=>i).every(i=>tab.ws.events.some(e=>e.dir==='in'&&e.text==='duplex-'+i)));
  check('服务器持续推送期间可连续发送并收到回显',await page.evaluate(()=>tab.ws.status==='open'&&tab.ws.recv>5));
  await page.locator('.ws-out .select-field').click();await page.getByRole('menuitem',{name:'二进制 · Base64',exact:true}).click();
  await page.locator('.ws-send textarea').fill('AAEC/w==');await page.locator('.ws-send textarea').press('Control+Enter');
  await page.waitForFunction(()=>tab.ws.events.some(e=>e.dir==='in'&&e.bytesB64==='AAEC/w=='));
  check('真实二进制消息双向传输',await page.evaluate(()=>tab.ws.sent===6));
  await page.locator('.ws-send textarea').fill('invalid%%');await page.locator('.ws-send textarea').press('Control+Enter');check('无效 Base64 不发送',await page.evaluate(()=>tab.ws.sent===6));
  await fresh('ping');await page.waitForFunction(()=>tab.ws.events.some(e=>e.text==='pong-confirmed'));
  check('不手动发送也能自动回应服务器 Ping',await page.evaluate(()=>tab.ws.status==='open'&&tab.ws.events.some(e=>e.kind==='ping')));
  await fresh('close');await page.waitForFunction(()=>tab.ws.status==='closed');
  check('保留服务器关闭码与原因',await page.evaluate(()=>tab.ws.closeCode===1008&&tab.ws.closeReason==='token expired'));
  check('关闭原因在状态栏可见',await page.locator('.ws-pane .response-head').innerText().then(text=>text.includes('1008')&&text.includes('token expired')));
  await fresh('reject');await page.waitForFunction(()=>tab.ws.status==='error');
  check('握手拒绝明确显示 HTTP 401',await page.evaluate(()=>tab.ws.error.includes('HTTP 401')&&tab.ws.error.includes('Auth')));
  await fresh('stall',{timeoutMs:250});await page.waitForFunction(()=>tab.ws.status==='error');
  check('握手超时设置实际生效',await page.evaluate(()=>tab.ws.error.includes('超时')&&Date.now()-tab.ws.startedAt<3000));
  await fresh('stall',{timeoutMs:10000});await page.getByRole('button',{name:'取消连接',exact:true}).click();
  check('连接中可以取消',await page.evaluate(()=>tab.ws.status==='closed'));
  await page.locator('#request-host .subtab').filter({hasText:'设置'}).click();await page.getByRole('spinbutton',{name:'握手超时 (ms)',exact:true}).fill('');
  check('超时留空继承全局值',await page.evaluate(()=>w.buildWsRequest(tab).req.timeoutMs===s.state.settings.timeoutMs));
  await page.getByRole('switch',{name:'校验 SSL 证书',exact:true}).click();check('SSL 开关传递到握手配置',await page.evaluate(()=>w.buildWsRequest(tab).req.sslVerify===false));
  const secure=async(verify)=>{await page.evaluate(async verify=>{s.newTab('ws');window.tab=s.activeTab();tab.draft.url='wss://127.0.0.1:19002/echo';tab.draft.settings={sslVerify:verify,timeoutMs:3000};s.emit('rerender');await w.toggle(tab);},verify);await page.waitForFunction(()=>['open','error'].includes(tab.ws.status));};
  await secure(true);check('WSS 校验开启时拒绝自签证书',await page.evaluate(()=>tab.ws.status==='error'));
  await secure(false);check('WSS 校验关闭时可连接自签证书服务',await page.evaluate(()=>tab.ws.status==='open'),await page.evaluate(()=>tab.ws.error));
  await page.locator('.ws-send textarea').fill('secure-echo');await page.locator('.ws-send textarea').press('Control+Enter');await page.waitForFunction(()=>tab.ws.sent===1&&tab.ws.events.some(e=>e.dir==='in'&&e.text==='secure-echo'));
  check('WSS 真实双向收发',await page.evaluate(()=>tab.ws.sent===1));
  await page.evaluate(async()=>{await api.wsDisconnect(tab.ws.connId);window.docUI=await import('./js/doc.js');window.doc=docUI.createDoc('协议草稿');});
  await page.locator('[aria-label=接口草稿]').fill("curl 'ws://127.0.0.1:19001/echo'\ncurl 'http://127.0.0.1:8899/sse' -H 'Accept: text/event-stream'");await page.locator('[aria-label=接口草稿]').press('Control+Enter');await page.locator('.delivery-endpoint').nth(1).waitFor();
  await page.locator('.delivery-outline-item').first().click();await page.locator('.delivery-endpoint').first().getByRole('button',{name:'运行验证',exact:true}).click();
  check('文档不将 WS 草稿误作为 HTTP 执行',await page.evaluate(()=>!doc.blocks[0].running&&!doc.blocks[0].response)&&await page.locator('.toast').filter({hasText:'WebSocket'}).count()>0);
  await page.locator('.delivery-endpoint').first().getByRole('button',{name:'调试',exact:true}).click();check('文档 cURL 草稿调试打开 WS',await page.evaluate(()=>s.activeTab().protocol==='ws'));
  await page.evaluate(()=>s.openDoc(doc));await page.locator('.delivery-outline-item').nth(1).click();await page.locator('.delivery-endpoint').nth(1).getByRole('button',{name:'调试',exact:true}).click();check('文档 cURL 草稿调试打开 SSE',await page.evaluate(()=>s.activeTab().protocol==='sse'));
  check('无 JavaScript 异常',errors.length===0,errors);
  fs.writeFileSync('.design-qa/protocol-import-results.json',JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await page.evaluate(async()=>{if(window.tab?.ws)await api.wsDisconnect(tab.ws.connId)}).catch(()=>{});await browser.close();}
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
