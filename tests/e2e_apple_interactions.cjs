const {chromium}=require('./playwright');
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
   const invoke=value.core.invoke;
   value.core.invoke=async(command,args)=>{
    if(command==='save_doc'&&args.domain==='docs'){
     if(window.__failDocs)throw Error('测试磁盘不可写');
     if(window.__holdDocs)await new Promise(resolve=>(window.__gates||(window.__gates=[])).push(resolve));
     window.__lastDocs = args.content;
    }
    return invoke(command,args);
   };bridge=value;
  }});
 });
 try{
  if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
  if(native){const dir=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(dir).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated data');}
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');window.d=await import('./js/doc.js');window.e=await import('./js/env.js');window.r=await import('./js/runner.js');window.u=await import('./js/undo.js');window.a=await import('./js/app.js');
   s.state.tabs=[];s.state.activeTabId=null;s.state.docs=[];s.state.runners=[];
   window.dev=s.newEnvironment('开发环境'),window.prod=s.newEnvironment('生产环境');dev.variables=[s.kv('baseUrl','https://dev.example.invalid')];prod.variables=[s.kv('baseUrl','https://api.example.invalid')];s.state.environments=[dev,prod];s.state.settings.activeEnvironmentId=dev.id;
   const col=s.newCollection('项目');window.req=s.newRequestNode('项目查询',{url:'{{baseUrl}}/projects'});col.children=[req,s.newRequestNode('项目创建'),s.newRequestNode('成员查询')];s.state.collections=[col];
   window.runner=s.newRunner('检查');runner.sources=[col.children[0].id,col.children[1].id,col.children[0].id,col.children[2].id];s.state.runners.push(runner);
   window.doc=s.newDoc('交付');for(const node of col.children){const b=s.newReqBlock(`curl 'https://example.invalid/${node.id}'`);b.draft={...node.request};b.parsedCurl=b.curl;b.auth={kind:'noauth'};doc.blocks.push(b);}s.state.docs.push(doc);
   s.emit('tree');s.emit('environment');e.openEnvironment(prod);
  });
  check('查看环境与生效环境分开显示',await page.locator('#sidebar .node.selected').innerText().then(t=>t.includes('生产环境'))&&await page.locator('#sidebar .env-in-use').innerText()==='使用中'&&await page.evaluate(()=>s.state.settings.activeEnvironmentId===dev.id));
  await page.evaluate(()=>s.openDoc(doc));await page.waitForTimeout(150);
  check('默认只展开当前接口',await page.locator('.doc-block.is-req:not(.is-collapsed)').count()===1);
  await page.locator('.delivery-outline-item').nth(1).click();
  check('目录切换展开对应接口',await page.locator('.doc-block.is-req:not(.is-collapsed)').count()===1&&await page.evaluate(()=>doc.activeBlockId===doc.blocks[1].id));
  await page.getByRole('button',{name:'展开全部',exact:true}).click();check('可展开全部对照',await page.locator('.doc-block.is-collapsed').count()===0);
  await page.getByRole('button',{name:'聚焦当前',exact:true}).click();
  check('已有文档的添加区域默认收起',await page.locator('details.delivery-composer').getAttribute('open')===null);
  await page.locator('.delivery-composer-heading').click();check('添加区域可直接展开',await page.getByLabel('接口草稿').isVisible());
  check('文档块菜单点击区域至少28px',await page.locator('.doc-grip').first().evaluate(n=>{const b=n.getBoundingClientRect();return b.width>=28&&b.height>=28}));
  const first=await page.evaluate(()=>doc.blocks.map(b=>b.id));
  const handle=page.locator('.delivery-body .doc-block').first().locator('.reorder-handle');
  await handle.focus();await page.keyboard.press('Alt+ArrowDown');
  check('文档块可用键盘排序',await page.evaluate(ids=>doc.blocks[1].id===ids[0],first));
  await page.keyboard.press('Control+z');check('Ctrl+Z撤销文档排序',await page.evaluate(ids=>JSON.stringify(doc.blocks.map(b=>b.id))===JSON.stringify(ids),first));
  await page.keyboard.press('Control+Shift+z');check('Ctrl+Shift+Z重做文档排序',await page.evaluate(ids=>doc.blocks[1].id===ids[0],first));
  await page.evaluate(()=>u.undo());
  await page.waitForTimeout(180);
  const source=page.locator('.delivery-body .doc-block').first().locator('.reorder-handle'),target=page.locator('.delivery-body .doc-block').nth(2);
  await source.scrollIntoViewIfNeeded();
  let p=await source.boundingBox(),q=await target.boundingBox();
  const scrollBox=await page.locator('.delivery-workspace').boundingBox(),scrollEdge=scrollBox.y+scrollBox.height-12;
  await page.mouse.move(p.x+p.width/2,p.y+p.height/2);await page.mouse.down();
  for(let tries=0;q.y+q.height>scrollEdge&&tries<24;tries++){await page.mouse.move(p.x+70,scrollEdge,{steps:8});await page.waitForTimeout(150);q=await target.boundingBox();}
  await page.mouse.move(q.x+q.width/2,q.y+q.height-4,{steps:8});await page.mouse.up();await page.waitForTimeout(180);
  check('文档块可指针拖拽',await page.evaluate(ids=>doc.blocks[2].id===ids[0],first),await page.evaluate(()=>doc.blocks.map(b=>b.id)));
  await page.evaluate(()=>u.undo());
  await page.evaluate(()=>{document.querySelector('.delivery-workspace').scrollTop=140;});
  await page.locator('[data-rail=collections]').click();await page.locator('[data-rail=docs]').click();
  check('模块返回恢复文档和滚动位置',await page.evaluate(()=>!s.state.overviewPane&&s.activeTab().refId===doc.id&&document.querySelector('.delivery-workspace').scrollTop>=100),await page.evaluate(()=>({pane:s.state.overviewPane,top:document.querySelector('.delivery-workspace')?.scrollTop})));
  await page.locator('.section-overview').click();check('独立入口可查看文档库',await page.locator('.document-library-card').count()===1);await page.locator('.document-library-card').click();
  await page.evaluate(()=>s.openRunner(runner));await page.waitForTimeout(150);
  const plan=await page.evaluate(()=>[...runner.sources]);
  p=await page.locator('.plan-step').nth(2).locator('.reorder-handle').boundingBox();q=await page.locator('.plan-step').nth(3).boundingBox();
  await page.mouse.move(p.x+12,p.y+12);await page.mouse.down();await page.mouse.move(q.x+100,q.y+q.height-4,{steps:8});await page.mouse.up();await page.waitForTimeout(180);
  check('重复请求按步骤位置排序且数量不变',await page.evaluate(ids=>runner.sources.length===4&&runner.sources[0]===ids[0]&&runner.sources[3]===ids[2]&&runner.sources[2]===ids[3],plan));
  await page.evaluate(()=>u.undo());check('重复步骤撤销后顺序正确',await page.evaluate(ids=>JSON.stringify(runner.sources)===JSON.stringify(ids),plan));
  p=await page.locator('.plan-step').first().locator('.reorder-handle').boundingBox();q=await page.locator('.plan-step').nth(3).boundingBox();
  await page.mouse.move(p.x+12,p.y+12);await page.mouse.down();await page.mouse.move(q.x+100,q.y+q.height-4,{steps:8});await page.keyboard.press('Escape');await page.mouse.up();
  check('Esc取消拖拽不改变顺序且清理预览',await page.evaluate(ids=>JSON.stringify(runner.sources)===JSON.stringify(ids)&&!document.querySelector('.content-sort-ghost,.drop-after,.drop-before'),plan));
  await page.locator('.plan-move button[title="从队列里移除这一个"]').nth(2).click();await page.evaluate(()=>u.undo());check('移除重复步骤可以撤销',await page.evaluate(ids=>JSON.stringify(runner.sources)===JSON.stringify(ids),plan));
  await page.evaluate(()=>s.openRequest(req));
  await page.getByRole('button',{name:'查看解析请求',exact:true}).click();
  check('解析详情可固定查看且变量已替换',await page.locator('.request-details').innerText().then(t=>t.includes('https://dev.example.invalid/projects')));
  await page.evaluate(()=>{e.setActive(prod.id);});
  check('切换环境刷新固定详情',await page.locator('.request-details').innerText().then(t=>t.includes('https://api.example.invalid/projects')));
  await page.evaluate(()=>{prod.variables.push(s.kv('unused','not-in-request'));});
  const editorHeight = await page.locator('#request-host').evaluate(n=>n.scrollHeight);
  await page.getByRole('button',{name:'查看当前请求变量',exact:true}).click();
  check('点击变量数量弹窗显示使用值与来源',await page.locator('.request-variables .preview-table').innerText().then(t=>t.includes('baseUrl')&&t.includes('https://api.example.invalid')&&t.includes('生产环境')&&!t.includes('unused')));
  check('变量弹窗不增加请求编辑区高度',await page.locator('#request-host').evaluate(n=>n.scrollHeight)===editorHeight&&await page.locator('.request-variables .preview-table').isVisible());
  await page.evaluate(()=>{prod.variables[0].value='https://updated.example.invalid';s.touch('environments');});await page.waitForFunction(()=>document.querySelector('.request-variables .preview-table')?.textContent.includes('https://updated.example.invalid'));
  check('变量值修改实时刷新弹窗表格',await page.locator('.request-variables .preview-table').innerText().then(t=>t.includes('https://updated.example.invalid')));
  await page.keyboard.press('Escape');await page.waitForTimeout(200);
  check('Esc关闭变量弹窗并返回入口焦点',await page.locator('.request-variables').count()===0&&await page.getByRole('button',{name:'查看当前请求变量',exact:true}).evaluate(n=>n===document.activeElement));
  await page.evaluate(()=>{prod.variables[0].value='https://api.example.invalid';s.touch('environments');});
  await page.evaluate(()=>{req.request.url='{{missing}}/projects';s.activeTab().draft.url=req.request.url;s.touch('tabs');});await page.waitForTimeout(60);
  check('请求附近直接显示缺失变量',await page.locator('.request-context-missing').innerText().then(t=>t.includes('missing')));
  await page.evaluate(async()=>{window.p=await import('./js/protocol.js');p.setProtocol(s.activeTab(),'sse');window.stream=s.activeTab();stream.stream={events:[{kind:'message',data:'a',at:Date.now()}],raw:[{seq:1,text:'a'}],count:99,bytes:1234,startedAt:Date.now(),status:200};stream.running={live:true};s.emit('rerender');});
  check('SSE连接期间帧格式不可误改',await page.locator('.stream-summary .select-field').isDisabled());
  await page.getByRole('button',{name:'清空显示',exact:true}).click();
  check('清空显示保留连接累计统计',await page.evaluate(()=>stream.stream.events.length===0&&stream.stream.raw.length===0&&stream.stream.count===99&&stream.stream.bytes===1234));
  await page.evaluate(()=>{stream.running=null;s.emit('rerender');});check('断开后可选择新格式',await page.locator('.stream-summary .select-field').isEnabled());
  await page.evaluate(async()=>{
   p.setProtocol(stream,'ws');stream.draft.url='wss://example.invalid/socket?token={{authToken}}';prod.variables.push(s.kv('authToken','ws-secret'));stream.previewPinned=true;stream.previewSection='headers';s.emit('rerender');
  });
  check('WS固定详情显示握手且默认遮罩令牌',await page.locator('.request-details').innerText().then(t=>t.includes('wss://example.invalid/socket')&&!t.includes('ws-secret'))&&await page.locator('.request-details .preview-tabs').innerText().then(t=>!t.includes('Body')&&!t.includes('cURL')));
  await page.getByRole('button',{name:'查看当前请求变量',exact:true}).click();
  check('WS变量入口默认遮罩敏感值',await page.locator('.request-variables .preview-table').innerText().then(t=>t.includes('authToken')&&!t.includes('ws-secret')));
  await page.locator('.request-variables').getByRole('button',{name:'显示敏感值',exact:true}).click();
  check('显式选择后可查看敏感变量值',await page.locator('.request-variables .preview-table').innerText().then(t=>t.includes('ws-secret')));
  await page.locator('.request-variables').getByRole('button',{name:'关闭',exact:true}).click();await page.waitForTimeout(200);
  await page.evaluate(async()=>{
   const {liveLog,appendLive}=await import('./js/interaction.js');window.auditLog={};
   const outer=document.createElement('div');outer.id='audit-live';const scroller=document.createElement('div');scroller.style.cssText='height:120px;overflow:auto';
   for(let i=0;i<15;i++){const row=document.createElement('div');row.style.height='40px';row.textContent=String(i);scroller.append(row);}
   const log=liveLog(auditLog,'log');outer.append(log.button,scroller);document.body.append(outer);log.bind(scroller);window.auditScroller=scroller;window.auditAppend=appendLive;
  });await page.waitForTimeout(60);
  await page.evaluate(()=>auditScroller.scrollTop=60);await page.waitForTimeout(60);
  await page.evaluate(()=>{const row=document.createElement('div');row.style.height='40px';row.textContent='new';auditAppend(auditScroller,row,100);});
  check('暂停跟随后显示新增消息且不抢滚动',await page.locator('#audit-live button').innerText().then(t=>t.includes('1 条新消息'))&&await page.evaluate(()=>auditScroller.scrollTop===60));
  await page.locator('#audit-live button').click();
  check('点击新消息恢复跟随并清零未读',await page.evaluate(()=>auditLog.log.follow&&auditLog.log.unread===0&&auditScroller.scrollTop+auditScroller.clientHeight>=auditScroller.scrollHeight));
  await page.evaluate(()=>document.querySelector('#audit-live').remove());
  await page.evaluate(()=>s.openDoc(doc));
  if(!native){
   await page.evaluate(()=>s.flushDomain('docs'));
   await page.evaluate(()=>{window.__failDocs=true;});await page.getByLabel('交付概述').fill('故障注入');
   await page.waitForFunction(()=>document.querySelector('.delivery-autosave')?.dataset.phase==='error');
   check('保存失败就地提供重试',await page.locator('.delivery-autosave').innerText().then(t=>t.includes('保存失败'))&&await page.locator('.delivery-autosave').getByRole('button',{name:'重试',exact:true}).isVisible());
   await page.evaluate(()=>{window.__failDocs=false;});await page.locator('.delivery-autosave').getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>s.saveState('docs').phase==='saved');check('重试真正成功后显示已保存',await page.locator('.delivery-autosave').innerText()==='已保存');
   await page.evaluate(()=>{window.__holdDocs=true;window.__gates=[];doc.overview='旧版';s.touch('docs');s.flushDomain('docs');});await page.waitForFunction(()=>window.__gates.length===1);
   await page.evaluate(()=>{doc.overview='新版';s.touch('docs');s.flushDomain('docs');});await page.waitForTimeout(60);
   check('旧写盘未结束时不会并发覆盖',await page.evaluate(()=>window.__gates.length===1));
   await page.evaluate(()=>window.__gates[0]());await page.waitForFunction(()=>window.__gates.length===2);
   check('旧保存成功不会把新修改标成已保存',await page.evaluate(()=>s.saveState('docs').phase!=='saved'));
   await page.evaluate(()=>{window.__holdDocs=false;window.__gates[1]();});await page.waitForFunction(()=>s.saveState('docs').phase==='saved');
   check('最终写盘提交最新文档',await page.evaluate(()=>JSON.parse(window.__lastDocs).find(d=>d.id===doc.id).overview==='新版'));
  }
  if(!native)await page.setViewportSize({width:1000,height:800});
  for(const zoom of [1.25,1.5,2]){
   await page.evaluate(z=>{s.state.settings.uiZoom=z;a.applyUiZoom();s.emit('rerender');},zoom);await page.waitForTimeout(120);
   check(`${zoom*100}%文档没有横向溢出`,await page.locator('.delivery-workspace').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
   check(`${zoom*100}%文档主要操作可见`,await page.getByRole('button',{name:'导出交付',exact:true}).isVisible());
  }
  await page.evaluate(()=>{s.state.settings.uiZoom=1;a.applyUiZoom();});
  if(!native)await page.setViewportSize({width:1440,height:920});
  await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>s.emit('rerender'));await page.waitForTimeout(100);
  check('减少动态效果时不播放切页动画',await page.evaluate(()=>!document.getAnimations().some(a=>a.playState==='running'&&a.effect?.target?.closest('#request-host'))));
  check('无JS页面异常',errors.length===0,errors);
  await page.screenshot({path:`.design-qa/apple-interactions-${native?'native':'browser'}.png`});
  fs.writeFileSync(`.design-qa/apple-interactions-${native?'native':'browser'}-results.json`,JSON.stringify({results,errors},null,2));
  console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
