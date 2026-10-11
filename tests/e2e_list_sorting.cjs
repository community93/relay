const {chromium}=require('./playwright');
const fs=require('node:fs'),path=require('node:path'),results=[];
const check=(name,ok,detail)=>{results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.waitForSelector('.rail-btn');
  const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());
  if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');
   s.state.tabs=[];s.state.activeTabId=null;s.state.collections=[s.newCollection('请求集')];
   s.state.collections[0].children=[s.newRequestNode('请求 A'),s.newRequestNode('请求 B')];
   s.state.environments=Array.from({length:5},(_,i)=>({...s.newEnvironment(`环境 ${i+1}`),id:`sort-env-${i+1}`,variables:[s.kv('marker',String(i+1))]}));
   s.state.runners=Array.from({length:5},(_,i)=>({...s.newRunner(`计划 ${i+1}`),id:`sort-run-${i+1}`,sources:s.state.collections[0].children.map(n=>n.id)}));
   s.state.docs=Array.from({length:5},(_,i)=>({...s.newDoc(`文档 ${i+1}`),id:`sort-doc-${i+1}`,overview:`正文 ${i+1}`}));
   s.state.settings.activeEnvironmentId='sort-env-2';
   s.touch('settings');s.touch('collections');s.emit('environment');
  });
  const options=[['environments','environments','env'],['runners','runner','runner'],['docs','docs','doc']];
  const order=domain=>page.evaluate(domain=>s.state[domain].map(n=>n.id),domain);
  const row=(domain,id)=>page.locator(`#sidebar [data-sort-domain="${domain}"][data-sort-id="${id}"]`);
  const clean=()=>page.evaluate(()=>!document.querySelector('.tree-drag-ghost,.dragging-src,.drop-before,.drop-after')&&!document.body.classList.contains('pointer-sorting'));
  async function begin(domain,id){const box=await row(domain,id).boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+9,box.y+box.height/2,{steps:3});await page.waitForTimeout(50);}
  const dragShots=new Set();
  async function drop(domain,id,target,after){await begin(domain,id);const box=await row(domain,target).boundingBox();await page.mouse.move(box.x+box.width/2,box.y+(after?box.height-3:3),{steps:12});await page.waitForTimeout(60);const marked=await row(domain,target).getAttribute('class');if(!dragShots.has(domain)){await page.screenshot({path:`.design-qa/sorting-drag-${domain}.png`});dragShots.add(domain);}await page.mouse.up();await page.waitForTimeout(280);return marked;}
  async function stable(){return page.evaluate(()=>({active:s.state.activeTabId,refs:s.state.tabs.map(t=>t.refId),environment:s.state.settings.activeEnvironmentId,pane:s.state.pane,overview:s.state.overviewPane}));}
  const snapshots={};
  for(const [domain,pane,kind] of options){
   const initial=await order(domain),label={environments:'环境',runners:'运行计划',docs:'文档'}[domain];
   await page.locator(`[data-rail="${pane}"]`).click();
   await row(domain,initial[1]).click();
   check(`${label} 单击仍打开对应编辑器`,await page.evaluate(({id,kind})=>s.activeTab().refId===id&&s.activeTab().kind===kind,{id:initial[1],kind}));
   const before=await stable();
   const mark=await drop(domain,initial[0],initial[3],true);
   check(`${label} 拖动显示下方插入线`,mark.includes('drop-after'),mark);
   check(`${label} 向下拖动准确排序`,JSON.stringify(await order(domain))===JSON.stringify([initial[1],initial[2],initial[3],initial[0],initial[4]]),await order(domain));
   check(`${label} 排序不切换标签或当前环境`,JSON.stringify(before)===JSON.stringify(await stable()));
   await drop(domain,initial[4],initial[1],false);
   check(`${label} 向上拖动准确排序`,(await order(domain))[0]===initial[4]);
   const cancelled=await order(domain);
   await begin(domain,initial[2]);check(`${label} 拖动浮层可见且只有一个`,await page.locator('.tree-drag-ghost').count()===1);
   await page.keyboard.press('Escape');await page.mouse.up();await page.waitForTimeout(280);
   check(`${label} Esc 取消并清理拖动状态`,JSON.stringify(cancelled)===JSON.stringify(await order(domain))&&await clean());
   await begin(domain,initial[2]);await page.mouse.move(850,300,{steps:10});await page.mouse.up();await page.waitForTimeout(280);
   check(`${label} 侧栏外松手不改变排序`,JSON.stringify(cancelled)===JSON.stringify(await order(domain))&&await clean());
   await begin(domain,initial[2]);
   const head=await page.locator('#sidebar .sidebar-head').boundingBox();await page.mouse.move(head.x+80,head.y+12,{steps:12});await page.mouse.up();await page.waitForTimeout(280);
   check(`${label} 列表头部可移至首位`,(await order(domain))[0]===initial[2]);
   await begin(domain,initial[2]);
   const list=await page.locator('#sidebar .sidebar-body').boundingBox();await page.mouse.move(list.x+80,list.y+list.height-20,{steps:12});await page.mouse.up();await page.waitForTimeout(280);
   check(`${label} 列表尾部空白可移至末位`,(await order(domain)).at(-1)===initial[2]);
   const same=await order(domain);await drop(domain,initial[2],initial[2],true);
   check(`${label} 原位放下不改变顺序`,JSON.stringify(same)===JSON.stringify(await order(domain))&&await clean());
   await row(domain,initial[2]).focus();await page.keyboard.press('Alt+ArrowUp');
   check(`${label} 键盘排序保持行焦点`,(await order(domain)).at(-2)===initial[2]&&await row(domain,initial[2]).evaluate(node=>node===document.activeElement));
   const live=await order(domain);await begin(domain,initial[0]);await page.evaluate(()=>s.emit('pane'));
   const b=await row(domain,live[0]).boundingBox();await page.mouse.move(b.x+b.width/2,b.y+3,{steps:12});await page.mouse.up();await page.waitForTimeout(280);
   check(`${label} 列表刷新中拖动仍可完成`,(await order(domain))[0]===initial[0]&&await clean());
   const payloadBefore=await page.evaluate(domain=>Object.fromEntries(s.state[domain].map(item=>[item.id,JSON.stringify(item)])),domain);
   await drop(domain,initial[0],initial[2],true);
   check(`${label} 排序保留条目内容`,await page.evaluate(({domain,payloadBefore})=>s.state[domain].every(item=>JSON.stringify(item)===payloadBefore[item.id]),{domain,payloadBefore}));
   snapshots[domain]=await order(domain);
   await page.waitForTimeout(600);
   check(`${label} 松手后顺序已落盘`,await page.evaluate(async({domain,expected})=>{const api=await import('./js/api.js');return JSON.stringify(JSON.parse(await api.loadDoc(domain)).map(n=>n.id))===JSON.stringify(expected);},{domain,expected:snapshots[domain]}));
   if(domain==='environments'){
    await page.locator('.env-switcher').click();const names=await page.locator('.menu-item .menu-label').allTextContents();await page.keyboard.press('Escape');
    check('环境选择菜单同步拖拽顺序',JSON.stringify(names.slice(0,5))===JSON.stringify(await page.evaluate(()=>s.state.environments.map(n=>n.name))));
    await row(domain,initial[1]).dblclick();const input=row(domain,initial[1]).locator('input');await input.click();await page.mouse.move(220,320,{steps:4});
    check('重命名输入不触发拖动',await page.locator('.tree-drag-ghost').count()===0);await page.keyboard.press('Escape');
   }
   if(domain==='docs'){
    await row(domain,initial[1]).hover();await row(domain,initial[1]).locator('.node-actions button').click();check('文档行菜单不触发拖动',await page.locator('.menu').isVisible()&&await page.locator('.tree-drag-ghost').count()===0);await page.keyboard.press('Escape');
    await page.evaluate(async()=>{s.newTab('http');(await import('./js/doc.js')).addRequestToDocument(s.activeTab());});
    check('加入文档选择器同步拖拽顺序',JSON.stringify(await page.locator('.document-attach-option strong').allTextContents())===JSON.stringify(await page.evaluate(()=>s.state.docs.map(n=>n.name))));await page.keyboard.press('Escape');
   }
   await page.locator(`[data-rail="${pane}"]`).click();await page.locator('.section-overview').click();
   const overviewBefore=await stable();await drop(domain,initial[0],initial[4],false);snapshots[domain]=await order(domain);
   check(`${label} 总览与左栏同步顺序`,await page.evaluate(({domain,kind})=>{const selector=kind==='doc'?'.document-library-card h2':'.section-item-title > span:first-child';return JSON.stringify([...document.querySelectorAll(selector)].map(n=>n.textContent))===JSON.stringify(s.state[domain].map(n=>n.name));},{domain,kind}));
   check(`${label} 总览排序仍保留总览`,JSON.stringify(overviewBefore)===JSON.stringify(await stable()));
   await page.screenshot({path:`.design-qa/sorting-${domain}.png`});
  }
  await page.evaluate(async()=>{for(const d of ['environments','runners','docs','settings','collections','tabs'])await s.flushDomain(d,{strict:true});});
  await page.reload();await page.waitForSelector('.rail-btn');await page.evaluate(async()=>window.s=await import('./js/state.js'));
  for(const [domain,pane] of options){await page.locator(`[data-rail="${pane}"]`).click();check(`${domain} 重载恢复列表顺序`,JSON.stringify(await order(domain))===JSON.stringify(snapshots[domain]));}
  const base=await order('environments');
  await page.evaluate(()=>{for(let i=6;i<=70;i++)s.state.environments.push({...s.newEnvironment(`环境 ${i}`),id:`sort-env-${i}`});s.state.pane='environments';s.emit('pane');});
  await page.bringToFront();
  const first=(await order('environments'))[0];await begin('environments',first);
  const scroller=await page.locator('#sidebar .sidebar-body').boundingBox();await page.mouse.move(scroller.x+100,scroller.y+scroller.height-5,{steps:10});await page.waitForTimeout(650);
  const scroll=await page.locator('#sidebar .sidebar-body').evaluate(node=>node.scrollTop);
  check('拖住列表下边缘持续自动滚动',scroll>90,{scroll,dragging:await page.locator('.tree-drag-ghost').count()});
  await page.keyboard.press('Escape');await page.mouse.up();await page.waitForTimeout(280);const stop=await page.locator('#sidebar .sidebar-body').evaluate(node=>node.scrollTop);await page.waitForTimeout(180);
  check('取消停止自动滚动并清理浮层',await clean()&&await page.locator('#sidebar .sidebar-body').evaluate(node=>node.scrollTop)===stop);
  await page.evaluate(ids=>{s.state.environments=ids.map(id=>s.state.environments.find(n=>n.id===id));s.emit('pane');},base);
  await page.locator('#sidebar .sidebar-body').evaluate(node=>node.scrollTop=0);await begin('environments',base[0]);await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();await page.waitForTimeout(280);
  check('窗口失焦取消拖动',await clean()&&JSON.stringify(await order('environments'))===JSON.stringify(base));
  await begin('environments',base[0]);await page.evaluate(()=>{s.state.pane='docs';s.emit('pane');});await page.waitForTimeout(60);await page.mouse.up();await page.waitForTimeout(280);
  check('拖动时切换分类取消排序',await clean()&&JSON.stringify(await order('environments'))===JSON.stringify(base));
  await page.evaluate(async()=>{for(const d of ['environments','runners','docs'])await s.flushDomain(d,{strict:true});});
  fs.writeFileSync('.design-qa/sorting-expected.json',JSON.stringify(snapshots,null,2));
  check('排序交互无 JavaScript 异常',!errors.length,errors);
  fs.writeFileSync('.design-qa/sorting-results.json',JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1)});
