const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const browser=await chromium.connectOverCDP('http://127.0.0.1:9226'),page=browser.contexts()[0].pages()[0],errors=[],rows=[];
 page.on('pageerror',error=>errors.push(error.message));
 const check=(name,ok)=>{rows.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
 try{
  await page.waitForSelector('.rail-btn');
  const dir=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());
  if(path.resolve(dir).toLowerCase()!==path.resolve('.design-qa/install-smoke/data').toLowerCase())throw Error('Requires installer QA data');
  check('安装后的程序成功启动且使用隔离目录',true);
  const version=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8')).version;
  check('安装后的界面版本与安装器配置一致',await page.locator('.navigation-footer-version').innerText()==='v'+version);
  await page.evaluate(async()=>{const s=await import('./js/state.js');s.newTab('http');});
  await page.locator('.delivery-add-request').waitFor();
  check('安装程序包含最新加入文档弹窗',await page.locator('.delivery-add-request').isVisible());
  const parsed=await page.evaluate(async()=>(await import('./js/api.js')).parseCurl("curl 'http://127.0.0.1:8899/hello' -H 'X-QA: installed'"));
  check('安装程序可以解析 cURL',parsed[0].draft.headers.some(row=>row.key==='X-QA'));
  check('安装程序包含 WS / SSE 导入识别',await page.evaluate(async()=>{const api=await import('./js/api.js'),p=await import('./js/protocol.js');const items=await api.parseCurl("curl 'ws://127.0.0.1:8900'\ncurl 'http://127.0.0.1:8899/sse' -H 'Accept: text/event-stream'");return p.inferProtocol(items[0].draft)==='ws'&&p.inferProtocol(items[1].draft)==='sse';}));
  check('安装程序已移除外部集合导入',await page.evaluate(async()=>{const t=await import('./js/tools.js');return t.importPostmanDialog===undefined&&!t.openImportFromText(JSON.stringify({info:{name:'QA'},item:[]}));}));
  await page.locator('.url-input').fill('http://127.0.0.1:8899/hello');await page.locator('.urlbar .primary').click();await page.waitForSelector('.response-summary .pill');
  check('安装程序完成真实 HTTP 请求',await page.locator('.response-summary .pill').innerText()==='200 OK');
  await page.evaluate(async()=>{window.s=await import('./js/state.js');window.w=await import('./js/ws.js');s.newTab('ws');window.tab=s.activeTab();tab.draft.url='ws://127.0.0.1:8900';s.emit('rerender');await w.toggle(tab);});await page.waitForFunction(()=>tab.ws.status==='open');
  await page.locator('.ws-send textarea').fill('installer-echo');await page.locator('.ws-send textarea').press('Control+Enter');await page.waitForFunction(()=>tab.ws.sent===1&&tab.ws.events.some(e=>e.dir==='in'&&e.text?.includes('installer-echo')));
  check('安装程序完成真实 WS 双向收发',await page.evaluate(()=>tab.ws.status==='open'));
  await page.evaluate(async()=>(await import('./js/api.js')).wsDisconnect(tab.ws.connId));
  await page.evaluate(async()=>{const s=await import('./js/state.js');s.state.globals.push(s.kv('installerMarker','preserved'));await s.flushDomain('settings');});
  await page.reload();await page.waitForSelector('.rail-btn');
  check('安装后保存与重载保留数据',await page.evaluate(async()=>(await import('./js/state.js')).state.globals.some(row=>row.key==='installerMarker')));
  await page.screenshot({path:'.design-qa/installer-smoke.png'});
  check('安装后运行无 JavaScript 异常',errors.length===0);
  fs.writeFileSync('.design-qa/installer-ui-results.json',JSON.stringify({rows,errors},null,2));
  if(rows.some(row=>!row.ok))process.exitCode=1;
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
