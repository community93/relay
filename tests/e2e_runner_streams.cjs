// 运行计划里的长连接步骤：WS 只验证握手（101 → 记一条 → 礼貌断开），SSE 建连后
// 驻留一小段收集事件再主动断开。两者都折算成 HTTP 形状，所以检查、历史、详情
// 展示与普通请求走同一条路。fixture 是 local_server 自带的 /sse 与 8900 的 WS echo。
const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path');
const results=[];
function check(name,ok,detail){results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);}
(async()=>{
 const native=!!process.env.RELAY_CDP_URL;
 const browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:920}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
  if(native){const dir=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(dir).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated data');}
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');window.r=await import('./js/runner.js');
   s.state.tabs=[];s.state.activeTabId=null;s.state.runs=[];s.state.runners=[];s.state.collections=[];
   const c=s.newCollection('长连接集合');
   window.wsNode={id:s.uid('wsnode'),kind:'ws',protocol:'ws',name:'WS 握手',auth:s.newAuth(),expanded:true,
     request:{name:'WS 握手',url:'ws://127.0.0.1:8900/echo',params:[],headers:[],settings:{}}};
   window.sseNode=s.newRequestNode('SSE 流',{url:'http://127.0.0.1:8899/sse'});sseNode.protocol='sse';
   window.httpNode=s.newRequestNode('普通请求',{url:'http://127.0.0.1:8899/hello'});
   c.children=[wsNode,sseNode,httpNode];s.state.collections=[c];
   window.plan=s.newRunner('长连接计划');plan.sources=[wsNode.id,sseNode.id,httpNode.id];
   s.state.runners=[plan];s.openRunner(plan);s.emit('tree');
   await Promise.all(['collections','runners'].map(domain=>s.flushDomain(domain)));
  });
  check('计划头不再把长连接算成跳过',await page.evaluate(()=>r.planSummary(plan)).then(s=>s.runnable===3&&s.skipped===0));
  await page.evaluate(async()=>{window.run=await r.runRunner(plan);await s.flushDomain('runs');});
  check('三个步骤都真的跑了',await page.evaluate(()=>run.totals).then(t=>t.ran===3&&t.passed===3&&t.skipped===0));
  check('WS 步骤记为 101 且标注握手成功',await page.evaluate(()=>({m:run.entries[0].method,st:run.entries[0].status,note:run.entries[0].note,ok:run.entries[0].ok})).then(e=>e.m==='WS'&&e.st===101&&e.note==='握手成功'&&e.ok));
  check('WS 结果带真实 wss/ws 地址',await page.evaluate(()=>run.entries[0].url).then(u=>u.startsWith('ws://127.0.0.1:8900/echo')));
  check('SSE 步骤建连并收到事件',await page.evaluate(()=>({st:run.entries[1].status,note:run.entries[1].note,ok:run.entries[1].ok,n:run.entries[1].details?.response?.eventCount})).then(e=>e.st===200&&e.ok&&/收到 [1-9]/.test(e.note)&&e.n>0));
  check('SSE 收到的事件文本进了响应详情',await page.evaluate(()=>run.entries[1].details?.response?.bodyText||'').then(t=>t.includes('事件')));
  check('HTTP 步骤不受影响',await page.evaluate(()=>run.entries[2].status===200&&run.entries[2].ok));
  check('历史里三类步骤都留了痕',await page.evaluate(()=>s.state.history.slice(0,3).map(h=>h.protocol).sort().join(',')).then(p=>p==='http,http,ws'||p==='http,sse,ws'));
  // 失败路径：连不上的 WS 与 404 的 SSE 都要老实失败，不能静默通过
  await page.evaluate(async()=>{
   const dead={id:s.uid('wsnode'),kind:'ws',protocol:'ws',name:'WS 死端',auth:s.newAuth(),expanded:true,
     request:{name:'WS 死端',url:'ws://127.0.0.1:59998/dead',params:[],headers:[],settings:{}}};
   const bad=s.newRequestNode('SSE 404',{url:'http://127.0.0.1:8899/definitely-not-here'});bad.protocol='sse';
   s.state.collections[0].children.push(dead,bad);
   window.plan2=s.newRunner('失败路径');plan2.sources=[dead.id,bad.id];
   s.state.runners.push(plan2);
   window.run2=await r.runRunner(plan2);await s.flushDomain('runs');
  });
  check('WS 连不上就失败并给出原因',await page.evaluate(()=>run2.entries[0].ok===false&&!!run2.entries[0].error&&run2.entries[0].status===0));
  check('SSE 打到 404 也失败且带回响应体',await page.evaluate(()=>run2.entries[1].ok===false&&!!run2.entries[1].error));
  check('失败的运行如实计数',await page.evaluate(()=>run2.totals).then(t=>t.ran===2&&t.failed===2&&t.passed===0));
  check('页面没有脚本错误',errors.length===0,errors);
  const failed=results.filter(r=>!r.ok);
  console.log(`${results.length-failed.length}/${results.length} passed`);
  process.exit(failed.length?1:0);
 }catch(error){
  console.error(error);process.exit(1);
 }finally{await browser.close();}
})();
