// Real pointer and keyboard regression checks. Browser mode uses the existing
// preview bridge; RELAY_CDP_URL connects the same checks to an isolated native app.
const { chromium } = require('./playwright.cjs');
const fs = require('node:fs');
const path = require('node:path');
const results = [];
const check = (name, condition, detail) => {
  results.push({name, ok: !!condition, detail});
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ' ' + JSON.stringify(detail)}`);
};
(async () => {
  const native = !!process.env.RELAY_CDP_URL;
  const browser = native ? await chromium.connectOverCDP(process.env.RELAY_CDP_URL) : await chromium.launch({headless:true, executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const context = native ? browser.contexts()[0] : await browser.newContext({viewport:{width:1440,height:920}});
  const page = native ? context.pages().find(p => p.url().includes('tauri')) || context.pages()[0] : await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (!native) await page.goto('http://127.0.0.1:8765');
  await page.waitForSelector('.rail-btn');
  if (native) {
    const directory = await page.evaluate(async () => (await import('./js/api.js')).dataPath());
    if (path.resolve(directory).toLowerCase() !== path.resolve('.design-qa/native-data').toLowerCase()) {
      throw new Error(`Refusing to replace collections outside the isolated test directory: ${directory}`);
    }
  }
  await page.evaluate(async () => {
    const s = await import('./js/state.js');
    window.qaState = s;
    s.state.runners = []; s.state.runs = [];
    s.state.collections = [
      {...s.newCollection('排序测试'), id:'qa-col', children:Array.from({length:6},(_,i)=>({...s.newRequestNode(`Request ${i+1}`),id:`qa-${i+1}`,request:s.newRequestDraft({name:`Request ${i+1}`,url:`http://127.0.0.1:8899/json?item=${i+1}`})}))},
      {...s.newCollection('第二集合'), id:'qa-col2', children:[{...s.newRequestNode('Other'),id:'qa-other'}]},
    ];
    s.state.expanded = {'qa-col':true,'qa-col2':true};
    s.touch('collections'); s.emit('tree');
  });
  const order = () => page.evaluate(() => qaState.state.collections[0].children.map(x=>x.id));
  const box = id => page.locator(`#sidebar [data-node="${id}"]`).boundingBox();
  async function begin(id) {
    const r = await box(id);
    await page.mouse.move(r.x+r.width/2,r.y+r.height/2);
    await page.mouse.down();
    await page.mouse.move(r.x+r.width/2+8,r.y+r.height/2,{steps:3});
    await page.waitForTimeout(40);
    return r;
  }
  async function drop(from,to,after) {
    await begin(from);
    const b=await box(to);
    await page.mouse.move(b.x+b.width/2,b.y+(after?b.height-3:3),{steps:12});
    await page.waitForTimeout(80);
    const mark=await page.locator(`#sidebar [data-node="${to}"]`).getAttribute('class');
    await page.mouse.up();
    await page.waitForTimeout(230);
    return mark;
  }
  await page.locator('#sidebar [data-node="qa-1"]').click();
  check('单击仍打开请求',await page.locator('.req-title').inputValue()==='Request 1');
  const tabsBefore=await page.evaluate(()=>qaState.state.tabs.length);
  const mark=await drop('qa-1','qa-4',true);
  check('拖动显示插入线',mark.includes('drop-after'),mark);
  check('真实鼠标拖到行下方排序',JSON.stringify(await order())===JSON.stringify(['qa-2','qa-3','qa-4','qa-1','qa-5','qa-6']),await order());
  check('松手不会误打开目标请求',await page.evaluate(()=>qaState.state.tabs.length)===tabsBefore);
  await drop('qa-6','qa-2',false);
  check('真实鼠标拖到行上方排序',(await order())[0]==='qa-6',await order());
  const beforeCancel=await order();
  await begin('qa-5');
  check('拖动显示跟随指针的浮层',await page.locator('.tree-drag-ghost').count()===1);
  await page.keyboard.press('Escape'); await page.mouse.up();
  check('Esc 取消且清理浮层',JSON.stringify(await order())===JSON.stringify(beforeCancel) && await page.locator('.tree-drag-ghost').count()===0,await order());
  const beforeOutside=await order();
  await begin('qa-5');await page.mouse.move(780,300,{steps:12});await page.mouse.up();
  check('拖出侧栏取消排序',JSON.stringify(beforeOutside)===JSON.stringify(await order()));
  await page.waitForTimeout(280);
  await drop('qa-5','qa-other',true);
  check('跨父级不会错误重排',JSON.stringify(beforeOutside)===JSON.stringify(await order()));
  await begin('qa-5');
  const header=await page.locator('#sidebar .sidebar-head').boundingBox();
  await page.mouse.move(header.x+80,header.y+10,{steps:12});await page.waitForTimeout(50);await page.mouse.up();await page.waitForTimeout(220);
  check('拖到列表头部移至首位',(await order())[0]==='qa-5',await order());
  await begin('qa-5');
  const list=await page.locator('#sidebar .sidebar-body').boundingBox();
  await page.mouse.move(list.x+80,list.y+list.height-20,{steps:12});await page.waitForTimeout(50);await page.mouse.up();await page.waitForTimeout(220);
  check('拖到列表空白移至末位',(await order()).at(-1)==='qa-5',await order());
  const saved=await order();
  await page.evaluate(()=>qaState.flushDomain('collections'));
  if (native) {
    await page.reload();await page.waitForSelector('#sidebar [data-node="qa-5"]');
    await page.evaluate(async()=>window.qaState=await import('./js/state.js'));
  check('刷新后排序已持久化',JSON.stringify(saved)===JSON.stringify(await order()),await order());
  }
  // A held pointer at the lower edge must continue scrolling without further
  // mousemove events; cancellation must clean up the RAF loop.
  await page.evaluate(()=>{
    const s=qaState;window.qaSix=s.state.collections[0].children.slice();
    for(let i=7;i<=50;i++)s.state.collections[0].children.push({...s.newRequestNode(`Request ${i}`),id:`qa-${i}`});
    s.emit('tree');
  });
  await begin('qa-6');
  const scrollBox=await page.locator('#sidebar .sidebar-body').boundingBox();
  await page.mouse.move(scrollBox.x+80,scrollBox.y+scrollBox.height-5,{steps:15});
  await page.waitForTimeout(360);
  check('拖动时边缘自动滚动',await page.locator('#sidebar .sidebar-body').evaluate(el=>el.scrollTop>40));
  await page.keyboard.press('Escape');await page.mouse.up();
  check('取消后停止自动滚动与浮层',await page.locator('.tree-drag-ghost').count()===0 && await page.locator('body.pointer-sorting').count()===0);
  await page.evaluate(()=>{qaState.state.collections[0].children=window.qaSix;qaState.emit('tree');qaState.touch('collections')});


  await page.locator('.command-trigger').click();
  await page.locator('.palette input').fill('zzzz-no-such-command-4392');
  check('搜索不再显示不匹配命令',await page.locator('.palette-list').innerText()==='没有匹配项');
  await page.keyboard.press('Escape');
  check('搜索关闭后焦点回到入口',await page.locator('.command-trigger').evaluate(el=>el===document.activeElement));
  await page.evaluate(async()=>{ const s=qaState; const r=s.newRunner('QA Search Plan');r.id='qa-plan';s.state.runners.push(r);s.touch('runners'); });
  await page.locator('.command-trigger').click();await page.locator('.palette input').fill('QA Search Plan');await page.keyboard.press('Enter');
  await page.waitForTimeout(180);
  check('搜索计划只打开不执行',await page.evaluate(()=>qaState.state.runs.length===0 && qaState.activeTab().refId==='qa-plan'));

  const modalResult=await page.evaluate(async()=>{
    const {modal,el}=await import('./js/ui.js');
    const opener=document.querySelector('.command-trigger');opener.focus();
    const first=modal({title:'Outer',body:[el('input',{class:'input'})]});
    await new Promise(r=>setTimeout(r,40));
    const second=modal({title:'Inner',body:[el('input',{class:'input'})]});
    window.qaDialogs={first,second,opener};
    return first.box.getAttribute('aria-modal')==='true' && second.box.getAttribute('role')==='dialog';
  });
  check('弹窗有正确的对话框语义',modalResult);
  await page.waitForTimeout(60);await page.keyboard.press('Escape');await page.waitForTimeout(200);
  check('Esc 只关闭最上层弹窗',await page.locator('.overlay:not(.closing)').count()===1);
  await page.evaluate(()=>{const b=qaDialogs.first.box;b.querySelectorAll('button')[b.querySelectorAll('button').length-1].focus()});
  await page.keyboard.press('Tab');
  check('Tab 焦点保留在弹窗内',await page.evaluate(()=>qaDialogs.first.box.contains(document.activeElement)));
  await page.keyboard.press('Escape');await page.waitForTimeout(200);
  check('关闭弹窗恢复原入口焦点',await page.evaluate(()=>document.activeElement===qaDialogs.opener));

  await page.locator('[data-rail=collections]').click();
  await page.locator('#sidebar [data-node="qa-1"]').focus();await page.keyboard.press('Enter');
  check('树行可以用 Enter 打开',await page.locator('.req-title').inputValue()==='Request 1');
  await page.locator('.tab.active').focus();await page.keyboard.press('ArrowLeft');
  check('标签页方向键可切换',await page.locator('.tab.active').evaluate(el=>el===document.activeElement));
  await page.evaluate(async()=>{qaState.newTab();const {openSettingsDialog}=await import('./js/tools.js');openSettingsDialog()});
  await page.waitForTimeout(50);
  const radio=page.locator('.modal [role=radiogroup]').first();
  await radio.locator('[aria-checked=true]').focus();await page.keyboard.press('ArrowRight');
  check('分段选择方向键同步 ARIA',await radio.locator('[aria-checked=true]').evaluate(el=>el===document.activeElement && el.tabIndex===0));
  await page.keyboard.press('Escape');await page.waitForTimeout(200);

  await page.locator('[data-rail=collections]').click();await page.locator('#sidebar [data-node="qa-1"]').click();
  await page.evaluate(()=>{const a=document.querySelector('#sidebar');const w=document.querySelector('.workspace');window.qaSeam={border:getComputedStyle(a).borderRightWidth,left:getComputedStyle(w).marginLeft,frame:getComputedStyle(w).borderLeftWidth}});
  check('侧栏分界不再叠加多个边框',await page.evaluate(()=>Object.values(qaSeam).every(x=>x==='0px')),await page.evaluate(()=>qaSeam));
  check('请求面板已移除教学脚注',!(await page.locator('#request-host').innerText()).includes('同一份数据'));
  await page.evaluate(async()=>{
    const {morph}=await import('./js/ui.js');
    for(let i=0;i<20;i++)morph(()=>document.body.dataset.qaFinal=String(i),'fade');
  });
  await page.waitForTimeout(350);
  check('连续切换动效收敛到最后一次操作',await page.evaluate(()=>document.body.dataset.qaFinal==='19' && !document.documentElement.hasAttribute('data-vt-region')));
  const listHeight=await page.locator('#sidebar').evaluate(el=>el.clientHeight);
  await page.locator('.navigation-collapse').click();
  check('收起导航给请求列表让出空间',await page.locator('.rail').isHidden() && await page.locator('#sidebar').evaluate(el=>el.clientHeight)>listHeight);
  await page.locator('.navigation-collapse').click();
  check('展开导航恢复入口',await page.locator('.rail').isVisible() && await page.locator('.navigation-collapse').getAttribute('aria-expanded')==='true');
  for(const key of ['runner','docs','history','environments','collections']) {
    await page.locator(`[data-rail=${key}]`).click();await page.waitForTimeout(180);
    check(`导航 ${key}`,await page.locator(`[data-rail=${key}]`).getAttribute('aria-current')==='page');
  }
  await page.locator('#sidebar [data-node="qa-1"]').click();
  if (!native) {
    await page.setViewportSize({width:1000,height:640});await page.waitForTimeout(150);
    check('最小窗口没有横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth));
    check('URL 缩窄后自动重算高度',await page.locator('.url-input').evaluate(el=>el.scrollHeight<=el.clientHeight+2),await page.locator('.url-input').evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight})));
    await page.setViewportSize({width:1440,height:920});
  }
  const protocolWidths=[];
  for (const protocol of ['SSE','WS','HTTP']) {
    await page.locator('.url-field .seg button').filter({hasText:new RegExp(`^${protocol}$`)}).click();
    await page.waitForTimeout(100);
    protocolWidths.push(await page.locator('.url-field').evaluate(el=>({x:el.getBoundingClientRect().x,width:el.getBoundingClientRect().width})));
    check(`${protocol} 面板可以切换`,await page.locator('.url-field .seg .on').innerText()===protocol);
  }
  check('HTTP SSE WS 地址栏边缘一致',protocolWidths.every(x=>x.x===protocolWidths[0].x && x.width===protocolWidths[0].width),protocolWidths);
  await page.evaluate(()=>qaState.openRequest(qaState.newRequestNode('Query restore',{url:'http://127.0.0.1:8899/json?limit=20&status=active'})));
  check('打开已有 URL 时查询参数同步进表格',await page.evaluate(()=>qaState.activeTab().draft.params.map(x=>`${x.key}=${x.value}`).join('&')==='limit=20&status=active'));
  await page.locator('#request-host .subtab').filter({hasText:/^Settings$/}).click();
  const requestSwitch=page.locator('#request-host .switch').first();
  const wasOn=await requestSwitch.getAttribute('aria-checked');
  await requestSwitch.click();
  check('请求设置开关立即写入覆盖值',await page.evaluate(()=>qaState.activeTab().draft.settings.followRedirects)===(wasOn!=='true'));
  const knob=await requestSwitch.evaluate(el=>({switchWidth:el.clientWidth,knobWidth:parseFloat(getComputedStyle(el,'::after').width),translation:new DOMMatrix(getComputedStyle(el,'::after').transform).m41}));
  check('开关滑块始终留在轨道内',knob.knobWidth+knob.translation+2<=knob.switchWidth,knob);
  await page.locator('#request-host .subtab').filter({hasText:/^Params/}).click();
  await page.locator('.url-input').fill(native?'http://127.0.0.1:8899/hello':'https://example.com/api');
  await page.locator('.urlbar .primary').click();await page.waitForSelector('.response-head .pill');
  check(native?'真实 Rust HTTP 请求返回 200':'预览请求发送链路完成',await page.locator('.response-head .pill').innerText()==='200 OK');
  check('响应状态向读屏播报',await page.locator('#request-announcement').innerText().then(t=>t.includes('200')));
  await page.screenshot({path:path.resolve('.design-qa',native?'native-workspace.png':'tested-workspace.png')});
  check('整轮无 JavaScript 异常',errors.length===0,errors);
  fs.writeFileSync(path.resolve('.design-qa',native?'native-results.json':'browser-results.json'),JSON.stringify(results,null,2));
  console.log(`${results.filter(x=>x.ok).length}/${results.length} passed`);
  if(!native) await browser.close();
  else await browser.close();
  if(results.some(x=>!x.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
