// AI 接口设置运行计划数据：runner.upsert 的 dataFile（行数组）落成与本地 CSV
// 相同的结构，runner.execute 按行循环跑，dataFile:null 移除，超限与坏结构带
// 候选值式报错。走真实 HTTP 命令通道（本地 8899 + /echo）。
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
  await page.evaluate(async()=>{window.s=await import('./js/state.js');});
  // 开一个可执行连接（与 e2e_automation 同一条路）
  await page.getByRole('button',{name:'AI 连接',exact:true}).click();
  await page.getByRole('radio',{name:'可执行'}).click();
  await page.locator('.ai-connection-hosts input').fill('127.0.0.1');
  await page.getByRole('button',{name:'开启 AI 连接',exact:true}).click();
  await page.waitForSelector('.ai-connection-state.connected');
  const config=await page.evaluate(()=>window.__TAURI__.core.invoke('automation_status'));
  await page.keyboard.press('Escape');await page.waitForTimeout(150);
  const headers={Authorization:'Bearer '+config.token,'Content-Type':'application/json'};
  async function call(command){const r=await fetch(config.baseUrl+'/v1/command',{method:'POST',headers,body:JSON.stringify(command)});const body=await r.json();return {status:r.status,...body};}
  async function wait(id){for(let i=0;i<120;i++){const job=await call({action:'job.get',id});if(job.data?.state!=='running')return job.data;await new Promise(r=>setTimeout(r,100));}throw Error('Job timeout');}

  // 造一个引用 {{user}} 的请求，再用 AI 挂数据
  const ws=await call({action:'workspace.list'});
  const col=ws.data.collections[0]?.id;
  const req=await call({action:'request.upsert',...(col?{collectionId:col}:{}),data:{name:'按 AI 数据查询',draft:{method:'GET',url:'http://127.0.0.1:8899/echo?user={{user}'+'}'}}});
  const planRes=await call({action:'runner.upsert',data:{name:'AI 数据计划',sources:[req.data.entity.id],dataFile:{header:['user','city'],rows:[['tom','上海'],['li','北京'],['joe','深圳']]}}});
  const plan=planRes.data.entity;
  check('dataFile 落成计划的数据结构',plan?.data?.fileName==='AI 提供的数据'&&plan?.data?.header?.join(',')==='user,city'&&plan?.data?.rows?.length===3,plan?.data);
  const run=await wait((await call({action:'runner.execute',id:plan.id})).data?.jobId);
  check('AI 数据按行循环跑了三轮',run.result?.run?.iterations===3&&run.result?.run?.dataFile==='AI 提供的数据',run.result?.run?.totals);
  check('行值覆盖进真实请求',run.result?.run?.entries.filter(e=>e.url.includes('user=tom')).length===1&&run.result?.run?.entries.every(e=>e.url.includes('user=')));
  check('结果如实全部通过',run.result?.ok===true&&run.result?.run?.totals?.passed===3);
  check('数据文件在界面卡片可见',await page.evaluate(async id=>{const s=window.s;const runner=s.state.runners.find(r=>r.id===id);return runner?.data?.header?.join(',');},plan.id).then(h=>h==='user,city'));
  // 每次更新都要带 expectedRevision，顺势当作上一答的修订号
  const cleared=await call({action:'runner.upsert',id:plan.id,expectedRevision:planRes.data.revision,data:{name:'AI 数据计划',dataFile:null}});
  check('dataFile:null 移除数据',cleared.ok===true&&cleared.data?.entity?.data===undefined,cleared);
  const over=await call({action:'runner.upsert',id:plan.id,expectedRevision:cleared.data.revision,data:{name:'AI 数据计划',dataFile:{rows:Array.from({length:2001},(_,i)=>['r'+i,'x'])}}});
  check('行超限报错带现状与上限',over.status===400&&/2000/.test(over.error?.message||'')&&/2001/.test(over.error?.message||''),over.error);
  const bad=await call({action:'runner.upsert',id:plan.id,expectedRevision:cleared.data.revision,data:{name:'AI 数据计划',dataFile:{rows:'tom,上海'}}});
  check('rows 不是数组时报错说明形状',bad.status===400&&/行数组|rows/.test(bad.error?.message||''),bad.error);
  check('页面没有脚本错误',errors.length===0,errors);
  const failed=results.filter(r=>!r.ok);
  console.log(`${results.length-failed.length}/${results.length} passed`);
  process.exit(failed.length?1:0);
 }catch(error){
  console.error(error);process.exit(1);
 }finally{await browser.close();}
})();
