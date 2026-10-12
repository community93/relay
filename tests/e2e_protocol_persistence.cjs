// Use real save controls, then reopen collection nodes and reload persisted data.
const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path'),results=[];
const check=(name,ok,detail)=>{results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const imports=()=>page.evaluate(async()=>{window.s=await import('./js/state.js');window.api=await import('./js/api.js');window.p=await import('./js/protocol.js');});
 try{
  await page.waitForSelector('.rail-btn');await imports();
  const data=await page.evaluate(()=>api.dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');
  for(const from of ['http','sse','ws'])for(const to of ['http','sse','ws']){
   if(from===to)continue;
   await page.evaluate(({from,to})=>{const c=s.newCollection('协议保存 QA'),node=s.newRequestNode(`${from} to ${to}`,{url:'http://127.0.0.1:8899/sse'});node.protocol=from;node.kind=from==='ws'?'ws':'request';c.children=[node];s.state.collections=[c];s.state.tabs=[];s.state.expanded={[c.id]:true};window.nodeId=node.id;s.openRequest(node);s.emit('tree');},{from,to});
   await page.locator('.url-field').getByRole('radio',{name:to==='ws'?'WS':to.toUpperCase(),exact:true}).click();
   await page.locator('[data-save-tab]').click();
   await page.waitForFunction(()=>!s.activeTab().dirty);
   const node=await page.evaluate(()=>s.findNode(nodeId).node);
   check(`${from} → ${to} 保存协议和节点类型`,node.protocol===to&&node.kind===(to==='ws'?'ws':'request'),{protocol:node.protocol,kind:node.kind});
   check(`${from} → ${to} 显示已保存前已写入磁盘`,await page.evaluate(async({id,to})=>{const node=JSON.parse(await api.loadDoc('collections'))[0].children.find(n=>n.id===id);return node?.protocol===to&&node.kind===(to==='ws'?'ws':'request');},{id:node.id,to}));
   await page.keyboard.press('Control+w');await page.locator(`#sidebar [data-node="${node.id}"]`).click();
   const reopened=await page.evaluate(()=>({protocol:s.activeTab().protocol,kind:s.activeTab().kind,dirty:s.activeTab().dirty}));
   check(`${from} → ${to} 从集合重开恢复协议`,reopened.protocol===to&&reopened.kind===(to==='ws'?'ws':'request')&&!reopened.dirty,reopened);
   check(`${from} → ${to} 协议控件恢复选中`,await page.locator('.url-field').getByRole('radio',{name:to==='ws'?'WS':to.toUpperCase(),exact:true}).getAttribute('aria-checked')==='true');
   await page.evaluate(async()=>{await s.flushDomain('collections',{strict:true});s.state.tabs=[];await s.flushDomain('tabs',{strict:true});});await page.reload();await page.waitForSelector('.rail-btn');await imports();
   await page.locator(`#sidebar [data-node="${node.id}"]`).click();
   check(`${from} → ${to} 重载后从集合恢复协议`,await page.evaluate(to=>s.activeTab().protocol===to,to));
  }
  await page.evaluate(()=>{const node=s.state.collections[0].children[0];node.protocol='sse';node.kind='ws';s.state.tabs=[];s.openRequest(node);});
  check('兼容旧节点冲突：显式 SSE 类型优先',await page.evaluate(()=>s.activeTab().protocol==='sse'&&s.activeTab().kind==='request'));
  await page.evaluate(()=>{const node=s.state.collections[0].children[0];delete node.protocol;node.kind='ws';s.state.tabs=[];s.openRequest(node);});
  check('兼容未记录 protocol 的旧 WS 节点',await page.evaluate(()=>s.activeTab().protocol==='ws'));
  await page.evaluate(()=>{const node=s.state.collections[0].children[0];node.kind='request';node.protocol='http';s.state.tabs=[];s.openRequest(node);window.first=s.activeTab();s.openRequest(node,{replaceExisting:false});p.setProtocol(s.activeTab(),'sse');});
  await page.locator('[data-save-tab]').click();await page.waitForFunction(()=>!s.activeTab().dirty);await page.locator(`#sidebar [data-node]`).filter({hasText:'ws to sse'}).last().click();
  check('同一请求另一个干净标签恢复最新保存协议',await page.evaluate(()=>s.activeTab().protocol==='sse'));
  await page.evaluate(()=>{const node=s.state.collections[0].children[0];s.state.tabs=[];node.protocol='http';s.openRequest(node);p.setProtocol(s.activeTab(),'ws');s.openRequest(node);});
  check('集合点击保留未保存的协议草稿',await page.evaluate(()=>s.activeTab().protocol==='ws'&&s.activeTab().dirty));
  for(const protocol of ['http','sse','ws']){
    await page.evaluate(protocol=>{s.state.collections=[];s.state.tabs=[];s.newTab(protocol);s.activeTab().draft.url='http://127.0.0.1:8899/sse';s.emit('tree');s.emit('rerender');},protocol);
    await page.locator('[data-save-tab]').click();await page.waitForFunction(()=>!!s.activeTab().refId&&!s.activeTab().dirty);
    const id=await page.evaluate(()=>s.activeTab().refId);
    check(`新建 ${protocol} 首次保存落盘`,await page.evaluate(async protocol=>JSON.parse(await api.loadDoc('collections'))[0].children[0].protocol===protocol,protocol));
    await page.keyboard.press('Control+w');await page.locator(`#sidebar [data-node="${id}"]`).click();
    check(`新建 ${protocol} 从集合恢复协议`,await page.evaluate(protocol=>s.activeTab().protocol===protocol,protocol));
  }
  await page.evaluate(async()=>{
    const c=s.newCollection('重启协议 QA');
    c.children=['http','sse','ws'].map(protocol=>{const node=s.newRequestNode(`restart-${protocol}`,{url:protocol==='ws'?'ws://127.0.0.1:8900':'http://127.0.0.1:8899/sse'});node.protocol=protocol;node.kind=protocol==='ws'?'ws':'request';return node;});
    s.state.collections=[c];s.state.expanded={[c.id]:true};s.state.tabs=[];s.state.environments=[];s.state.settings.activeEnvironmentId=null;
    await Promise.all(['collections','tabs','settings','environments'].map(domain=>s.flushDomain(domain,{strict:true})));s.emit('tree');
  });
  check('重启夹具实际落盘包含三种协议',await page.evaluate(async()=>{const nodes=JSON.parse(await api.loadDoc('collections'))[0].children;return ['http','sse','ws'].every(protocol=>nodes.some(node=>node.protocol===protocol&&node.kind===(protocol==='ws'?'ws':'request')));}));
  check('协议保存回归无 JavaScript 异常',errors.length===0,errors);
  fs.writeFileSync('.design-qa/protocol-persistence-results.json',JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
