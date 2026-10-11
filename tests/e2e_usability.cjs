// User-facing contracts: overflow, saved state, cancellation and command routing.
const {chromium}=require('./playwright');
const fs=require('node:fs'),path=require('node:path');
const results=[];function check(name,ok,detail){results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);}
(async()=>{
 const native=!!process.env.RELAY_CDP_URL;
 const browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:920}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try {
  if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
  if(native){const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');}
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');window.r=await import('./js/request.js');window.w=await import('./js/ws.js');window.d=await import('./js/doc.js');window.u=await import('./js/ui.js');
   const c=s.newCollection('用户流程 QA');c.children=[s.newRequestNode('保存契约',{url:'http://127.0.0.1:8899/echo?version=1'})];
   c.children.push(s.newRequestNode('curl '+('https://example.invalid/long-path?x=demo -H example\n'.repeat(24)),{url:'https://example.invalid/'+('segment/'.repeat(40))+'needleAtEnd'}));
   for(let i=0;i<45;i++)c.children.push(s.newRequestNode('Endpoint '+i,{url:'https://example.invalid/'+i}));
   s.state.collections=[c];s.state.tabs=[];s.state.runners=[];s.state.docs=[];s.state.history=[];
   const env=s.newEnvironment('QA Environment');env.variables=[s.kv('qaValue','42')];s.state.environments=[env];s.state.settings.activeEnvironmentId=env.id;
   window.fixture={c,env};s.state.expanded={[c.id]:true};s.openRequest(c.children[0]);s.emit('environment');s.emit('tree');
  });
  await page.evaluate(()=>{fixture.c.children.slice(1,14).forEach(node=>s.openRequest(node));s.openRequest(fixture.c.children[1]);});await page.locator('.tab-more').click();
  const menuGeometry=await page.locator('.menu').evaluate(el=>{const label=[...el.querySelectorAll('.menu-label')].find(n=>n.textContent.includes('curl ')),box=el.getBoundingClientRect();return {width:box.width,left:box.left,right:box.right,viewport:innerWidth,scroll:el.scrollWidth,client:el.clientWidth,truncated:label.scrollWidth>label.clientWidth,ellipsis:getComputedStyle(label).textOverflow,title:label.title,text:label.textContent};});
  check('标签下拉长名称收敛宽度且无横向溢出',menuGeometry.width<=421&&menuGeometry.left>=0&&menuGeometry.right<=menuGeometry.viewport&&menuGeometry.scroll<=menuGeometry.client+1,menuGeometry);
  check('标签下拉省略长名称并提供完整悬停提示',menuGeometry.truncated&&menuGeometry.ellipsis==='ellipsis'&&menuGeometry.title===menuGeometry.text,menuGeometry);
  await page.screenshot({path:`.design-qa/tab-menu-${native?'native':'browser'}.png`});await page.keyboard.press('Escape');await page.evaluate(()=>{s.state.tabs=s.state.tabs.filter(tab=>fixture.c.children.slice(0,2).some(node=>node.id===tab.refId));s.openRequest(fixture.c.children[0]);s.emit('rerender');});
  const palette=async term=>{await page.locator('.command-trigger').click();await page.locator('.palette input').fill(term);};
  const envGeometry=()=>page.locator('.env-switcher-label').evaluate(node=>({text:node.textContent,title:node.title,width:node.clientWidth,scroll:node.scrollWidth,height:node.getBoundingClientRect().height,font:parseFloat(getComputedStyle(node).fontSize)}));
  await page.evaluate(()=>{s.state.settings.activeEnvironmentId=null;s.emit('environment');});const noEnv=await envGeometry();
  check('无环境文字完整显示且有足够行高',noEnv.text==='无环境'&&noEnv.scroll<=noEnv.width+1&&noEnv.height>=noEnv.font*1.4,noEnv);
  await page.evaluate(()=>{fixture.env.name='环境名称'.repeat(30);s.state.settings.activeEnvironmentId=fixture.env.id;s.emit('environment');});const longEnv=await envGeometry();
  check('超长环境名只省略文本，提示保留完整名称',longEnv.scroll>longEnv.width&&longEnv.title===longEnv.text&&await page.locator('.env-switcher').evaluate(el=>el.getBoundingClientRect().width<=181),longEnv);
  await page.locator('.env-switcher').click();check('长环境名下拉仍限制宽度',await page.locator('.menu').evaluate(el=>el.getBoundingClientRect().width<=421&&el.scrollWidth<=el.clientWidth+1));await page.keyboard.press('Escape');
  await page.evaluate(()=>{fixture.env.name='QA Environment';s.emit('environment');});await page.screenshot({path:`.design-qa/topbar-text-${native?'native':'browser'}.png`});
  await palette('');await page.locator('.palette-list').evaluate(el=>el.scrollTop=el.scrollHeight);
  const geometry=await page.locator('.palette-list').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,rows:[...el.querySelectorAll('.palette-item .grow')].map(n=>({height:n.getBoundingClientRect().height,row:n.parentElement.getBoundingClientRect().height,overflow:getComputedStyle(n).overflow,wrap:getComputedStyle(n).whiteSpace}))}));
  check('命令列表长名称不换行、重叠或横向溢出',geometry.scroll<=geometry.width+1&&geometry.rows.every(x=>x.height<=x.row&&x.overflow==='hidden'&&x.wrap==='nowrap'),geometry);
  await page.screenshot({path:`.design-qa/palette-fixed-${native?'native':'browser'}.png`});await page.keyboard.press('Escape');
  await palette('needleAtEnd');check('长 URL 尾部也能搜索到请求',await page.locator('.palette-list .palette-item').count()===1&&!(await page.locator('.palette-list').innerText()).includes('没有匹配项'));await page.keyboard.press('Escape');
  await palette('当前环境的变量编辑');await page.keyboard.press('Enter');await page.waitForSelector('.env-name');
  check('命令直接编辑当前环境',await page.locator('.env-name').inputValue()==='QA Environment');await page.evaluate(()=>s.openRequest(fixture.c.children[0]));
  await page.locator('.url-input').fill('http://127.0.0.1:8899/echo?version=2');
  check('编辑请求后保存按钮立即更新',await page.locator('[data-save-tab]').innerText()==='保存'&&await page.evaluate(()=>s.activeTab().dirty));
  await page.keyboard.press('Control+w');await page.waitForSelector('.modal');
  check('关闭修改过的请求提供保存放弃取消',await page.locator('.modal').innerText().then(x=>['保存并关闭','放弃修改','取消'].every(word=>x.includes(word))));
  await page.getByRole('button',{name:'取消',exact:true}).click();await page.waitForTimeout(220);
  check('取消关闭保留原编辑内容',await page.locator('.url-input').inputValue().then(x=>x.includes('version=2')));
  await page.keyboard.press('Control+w');await page.getByRole('button',{name:'保存并关闭',exact:true}).click();await page.waitForTimeout(250);
  await page.evaluate(()=>s.openRequest(fixture.c.children[0]));check('保存并关闭后重新打开保留修改',await page.locator('.url-input').inputValue().then(x=>x.includes('version=2'))&&!await page.evaluate(()=>s.activeTab().dirty));
  await page.locator('.url-input').fill('http://127.0.0.1:8899/echo?version=discard');await page.keyboard.press('Control+w');await page.getByRole('button',{name:'放弃修改',exact:true}).click();await page.waitForTimeout(230);await page.evaluate(()=>s.openRequest(fixture.c.children[0]));
  check('放弃修改恢复集合中已保存版本',await page.locator('.url-input').inputValue().then(x=>x.includes('version=2')));
  if(native){await page.locator('.url-input').fill('http://127.0.0.1:8899/echo?version=recover');await page.evaluate(()=>s.flushDomain('tabs',{strict:true}));await page.reload();await page.waitForSelector('.url-input');await page.evaluate(async()=>{window.s=await import('./js/state.js');window.r=await import('./js/request.js');window.w=await import('./js/ws.js');window.d=await import('./js/doc.js');window.u=await import('./js/ui.js');});check('重启恢复草稿时仍显示未保存',await page.evaluate(()=>s.activeTab().dirty)&&await page.locator('[data-save-tab]').innerText()==='保存');}
  await page.evaluate(()=>{s.activeTab().response=null;s.state.history=[];});await page.locator('.url-input').fill('http://127.0.0.1:8899/echo?x={{missingQa}}');await page.keyboard.press('Escape');await page.keyboard.press('Control+Enter');await page.waitForTimeout(450);
  check('HTTP 缺失变量阻止发送',await page.evaluate(()=>!s.activeTab().response&&!s.activeTab().running&&s.state.history.length===0));
  await page.evaluate(()=>{const tab=s.activeTab();tab.protocol='sse';s.emit('rerender');});await page.keyboard.press('Control+Enter');await page.waitForTimeout(200);check('SSE 缺失变量阻止连接',await page.evaluate(()=>!s.activeTab().running));
  await page.evaluate(()=>{window.wsTab=s.newTab('ws');wsTab.draft.name='WebSocket 连接';wsTab.draft.url='ws://127.0.0.1:8900/{{missingQa}}';s.emit('rerender');});
  const tabGeometry=await page.locator('.tab.active').evaluate(el=>{const label=el.querySelector('.label'),close=el.querySelector('.close'),a=label.getBoundingClientRect(),b=close.getBoundingClientRect();return {text:label.textContent,title:label.title,width:label.clientWidth,scroll:label.scrollWidth,right:a.right,closeLeft:b.left,closeWidth:b.width,height:a.height,font:parseFloat(getComputedStyle(label).fontSize)};});
  check('WebSocket 中文标题完整显示且关闭按钮不挤压',tabGeometry.text==='WebSocket 连接'&&tabGeometry.scroll<=tabGeometry.width+1&&tabGeometry.closeLeft-tabGeometry.right>=5&&tabGeometry.closeWidth>=17&&tabGeometry.height>=tabGeometry.font*1.4,tabGeometry);
  check('标签标题可悬停查看完整名称',tabGeometry.title===tabGeometry.text);
  await page.waitForTimeout(120);
  const visibleTab=await page.locator('.tabstrip').evaluate(strip=>{const active=strip.querySelector('.tab.active'),a=active.getBoundingClientRect(),button=[...strip.querySelectorAll('.tab-actions button')].find(n=>n.getBoundingClientRect().width>0).getBoundingClientRect();return {right:a.right,closeRight:active.querySelector('.close').getBoundingClientRect().right,buttonLeft:button.left};});
  check('当前标签完整露出且不被右侧操作遮挡',visibleTab.right<=visibleTab.buttonLeft+1&&visibleTab.closeRight<=visibleTab.buttonLeft-5,visibleTab);
  await page.screenshot({path:`.design-qa/tab-title-${native?'native':'browser'}.png`});
  await page.keyboard.press('Control+Enter');await page.waitForTimeout(200);check('WebSocket 缺失变量阻止连接',await page.evaluate(()=>wsTab.ws.status==='idle'));
  await page.locator('.url-input').fill('ws://127.0.0.1:8900/echo');await page.keyboard.press('Control+Enter');await page.waitForFunction(()=>wsTab.ws.status==='open');check('WS Ctrl Enter 使用正确连接流程',await page.evaluate(()=>wsTab.ws.status==='open'&&!wsTab.response));
  await page.keyboard.press('Control+s');await page.waitForFunction(()=>!!wsTab.refId&&!wsTab.dirty);check('WS Ctrl S 保存为 WS 节点',await page.evaluate(()=>s.findNode(wsTab.refId).node.kind==='ws'&&!wsTab.dirty));
  await palette('停止当前请求');await page.keyboard.press('Enter');await page.waitForTimeout(600);check('命令停止 WS 会断开连接',await page.evaluate(()=>!['open','opening'].includes(wsTab.ws.status)));
  await page.evaluate(()=>{window.httpTab=s.newTab();httpTab.draft.url='http://127.0.0.1:8899/slow';s.emit('rerender');r.send(httpTab);});await page.waitForTimeout(45);await page.evaluate(()=>r.stopEverything(httpTab));
  const stopped=await page.evaluate(()=>s.state.history.length);await page.waitForTimeout(650);check('取消 HTTP 后保留取消状态，迟到响应不覆盖',await page.evaluate(n=>!httpTab.running&&httpTab.response.errorKind==='cancelled'&&s.state.history.length===n,stopped));
  await page.evaluate(async()=>{httpTab.draft.url='http://127.0.0.1:8899/echo?version=sent';window.sentPromise=r.send(httpTab);httpTab.draft.url='http://127.0.0.1:8899/echo?version=edited';await sentPromise;});
  check('历史记录对应实际发送的草稿',await page.evaluate(()=>s.state.history[0].snapshot.url.includes('version=sent')));
  check('运行计划缺失变量不发送且遵循遇错停止',await page.evaluate(async()=>{const runnerModule=await import('./js/runner.js');const c=s.newCollection('缺失变量计划');c.children=[s.newRequestNode('缺少变量',{url:'http://127.0.0.1:8899/echo?key={{missingQa}}'}),s.newRequestNode('后续请求',{url:'http://127.0.0.1:8899/echo'})];s.state.collections.push(c);const runner=s.newRunner('验证计划');runner.sources=[c.id];runner.stopOnError=true;const before=s.state.history.length,run=await runnerModule.runRunner(runner);return run.entries.length===1&&run.totals.failed===1&&run.totals.ran===1&&run.entries[0].errorKind==='validation'&&run.stoppedAfter===1&&s.state.history.length===before;}));
  await page.evaluate(()=>{const tab=s.activeTab();tab.draft.body=s.newBody('raw');tab.view='body';s.emit('rerender');});const area=page.locator('.body-code .cm-content');await area.fill('');await area.pressSequentially('{');await area.press('Enter');
  check('JSON 结构括号不会误触发变量补全',await page.evaluate(()=>s.activeTab().draft.body.raw.content)==='{\n  \n}'&&await page.locator('.variable-picker').count()===0);
  await area.fill('{"id":"{qaV');await area.press('End');check('JSON 字符串内仍支持单括号补全',await page.locator('.variable-picker').count()===1);await area.press('Enter');check('字符串内变量正确插入',await page.evaluate(()=>s.activeTab().draft.body.raw.content.includes('{{qaValue}}')));
  await area.fill('{{qaV');await area.press('End');check('JSON 中双括号支持显式补全',await page.locator('.variable-picker').count()===1);await page.keyboard.press('Escape');
  await page.evaluate(()=>{window.doc=d.createDoc('命令路由 QA');});await palette('运行当前接口');await page.keyboard.press('Enter');await page.waitForTimeout(100);check('文档命令不误发普通 HTTP 请求',await page.evaluate(()=>s.activeTab().kind==='doc'&&!s.activeTab().response&&!s.activeTab().running));
  await page.evaluate(()=>{window.empty=s.newCollection('空集合');s.state.collections.push(empty);s.emit('tree');});await page.locator('[data-rail=collections]').click();await page.locator('.section-overview').click();await page.locator('.section-item').filter({hasText:'空集合'}).click();
  check('查看空集合不会擅自新增请求',await page.evaluate(()=>empty.children.length===0)&&await page.locator('.modal').innerText().then(x=>x.includes('集合信息')));await page.keyboard.press('Escape');await page.waitForTimeout(220);
  await page.evaluate(()=>{window.confirmResult=null;u.confirmDialog('QA cancel').then(value=>window.confirmResult=value);});await page.getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>window.confirmResult!==null);check('取消确认弹窗会完成操作而不悬挂',await page.evaluate(()=>confirmResult===false));
  check('整轮操作没有 JavaScript 异常',errors.length===0,errors);
  fs.writeFileSync(`.design-qa/usability-${native?'native':'browser'}-results.json`,JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
