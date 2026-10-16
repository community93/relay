// 托盘常驻：点关闭（真实的 CloseRequested 路径）→ 窗口藏进托盘、进程活着；
// 隐藏期间到点的定时计划照常触发；窗口拉回后能看见运行记录。最后把设置里的
// 「收进托盘」关掉再关一次窗，这次必须是真退出（进程没了，CDP 连接断开）。
const {chromium}=require('./playwright.cjs');
const path=require('node:path');
const results=[];
function check(name,ok,detail){results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);}
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.waitForSelector('.rail-btn');
  const dataPath=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());
  if(path.resolve(dataPath).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated data');
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');window.r=await import('./js/runner.js');
   s.state.tabs=[];s.state.activeTabId=null;s.state.runs=[];s.state.runners=[];s.state.collections=[];
   const c=s.newCollection('巡检集合');
   const ping=s.newRequestNode('探活',{url:'http://127.0.0.1:8899/hello'});
   c.children=[ping];s.state.collections=[c];
   window.plan=s.newRunner('托盘巡检');plan.sources=[ping.id];
   plan.schedule={enabled:true,kind:'interval',everyMinutes:1,at:'09:00',anchorAt:Date.now()-61000};
   s.state.runners=[plan];
   s.state.settings.hideToTray=true;
   await Promise.all(['collections','runners','settings'].map(domain=>s.flushDomain(domain)));
  });
  check('关闭设置默认收进托盘',await page.evaluate(()=>s.state.settings.hideToTray===true));
  // 真实关窗路径：走 Tauri 的 window.close()，与点标题栏 X 完全同源。
  // 可见性要用原生窗口的 isVisible 判断——Playwright 的 CDP 连接会把页面的
  // visibilityState 强制成 visible，页内信号在测试环境里不可信。
  await page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().close());
  const seq=[];
  let hidden=false;
  for(let i=0;i<16;i++){await page.waitForTimeout(700);const v=await page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().isVisible()).catch(e=>'ERR');seq.push(v);if(v===false){hidden=true;break;}}
  check('关窗后进程还在、窗口只是藏起',hidden,JSON.stringify(seq));
  // 隐藏期间等定时触发（心跳 20s 一查，最多等 90s）；运行落进记录时必已跑完
  let fired=false;
  for(let i=0;i<45;i++){
   fired=await page.evaluate(()=>s.state.runs[0]?.trigger==='timer'&&s.state.runs[0]?.runnerId===s.state.runners[0]?.id).catch(()=>false);
   if(fired)break;
   await page.waitForTimeout(2000);
  }
  check('窗口隐藏时定时计划照常触发',fired);
  await page.evaluate(()=>window.__TAURI__.core.invoke('window_show'));
  await page.waitForTimeout(600);
  check('窗口能拉回来且看得见记录',await page.evaluate(async()=>{const vis=await window.__TAURI__.window.getCurrentWindow().isVisible();const run=s.state.runs[0]?.totals;return {vis,ran:run?.ran,passed:run?.passed};}).then(e=>e.vis===true&&e.ran===1&&e.passed===1));
  check('回归提示已就绪（不报脚本错误）',errors.length===0,errors);
  // 关掉「收进托盘」再关窗：这次必须整个退出
  await page.evaluate(async()=>{s.state.settings.hideToTray=false;await s.flushDomain('settings');});
  await page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().close());
  let exited=false;
  for(let i=0;i<10;i++){
   try{await page.evaluate(()=>1);await page.waitForTimeout(500);}
   catch{exited=true;break;}
  }
  check('设置改为直接退出后关窗就是真退出',exited);
  const failed=results.filter(r=>!r.ok);
  console.log(`${results.length-failed.length}/${results.length} passed`);
  process.exit(failed.length?1:0);
 }catch(error){
  console.error(error);process.exit(1);
 }
})();
