// 运行计划的数据文件（CSV 循环）：每行跑一遍计划、列名即变量、行值覆盖环境、
// 提取器当轮的值又覆盖行值、stopOnError 一次停全程。原生文件选择器没法自动
// 回答，所以执行路径直接把解析结果写进 runner.data —— 这正是上传按钮 onPick
// 里 buildDataFile 之后交出去的同一个对象。
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
   window.s=await import('./js/state.js');window.r=await import('./js/runner.js');window.d=await import('./js/datafile.js');
   s.state.tabs=[];s.state.activeTabId=null;s.state.runs=[];s.state.runners=[];s.state.collections=[];
   window.env=s.newEnvironment('数据循环');env.variables=[s.kv('host','http://127.0.0.1:8899'),s.kv('user','env里的user')];s.state.environments=[env];s.state.settings.activeEnvironmentId=env.id;
   const c=s.newCollection('循环集合');
   window.echo=s.newRequestNode('按行查询',{url:'{{host}}/echo?user={{user}}&city={{city}}'});
   window.login=s.newRequestNode('登录',{url:'{{host}}/login'});
   login.request.extractors=[{name:'token',source:'json',path:'$.user'}];
   window.who=s.newRequestNode('用令牌',{url:'{{host}}/echo?token={{token}}'});
   c.children=[echo,login,who];s.state.collections=[c];
   window.plan=s.newRunner('三行循环');plan.sources=[echo.id,login.id,who.id];
   plan.data=d.buildDataFile('用户.csv',new TextEncoder().encode('user,city,token\ntom,上海,csv-token\nli,北京,csv-token\njoe,深圳,csv-token\n').buffer);
   s.state.runners=[plan];s.openRunner(plan);s.emit('tree');
   await Promise.all(['collections','runners','environments','settings'].map(domain=>s.flushDomain(domain)));
  });
  check('数据卡显示文件与行列数',await page.locator('.group:has(.group-title:text("数据文件")) .hint').first().innerText().then(t=>t.includes('用户.csv')&&t.includes('3 行 × 3 列')));
  check('预览表按列名出表头',await page.locator('.data-preview th').allInnerTexts().then(h=>h.join(',')==='user,city,token'));
  check('预览只展示前三行',await page.locator('.data-preview tbody tr').count()===3);
  check('空态文案换成了数据说明',await page.locator('.group:has(.group-title:text("数据文件"))').innerText().then(t=>t.includes('第 1 行 → 第 3 行')));
  await page.locator('.group:has(.group-title:text("数据文件")) .btn:text("移除")').click();
  check('移除后回到选择器并标注可选',await Promise.all([page.locator('.group-title:text("数据文件（可选）")').count(),page.getByRole('button',{name:'选择 CSV',exact:true}).count()]).then(([title,btn])=>title===1&&btn===1));
  check('选择器说明第一行是列名',await page.locator('.group:has(.group-title:text("数据文件"))').innerText().then(t=>t.includes('第一行是列名')));
  await page.locator('.file-pick .btn:text("选择 CSV")').click();
  check('原生选择器入口触发的是隐藏 input',await page.evaluate(()=>!!document.querySelector('.file-pick .file-native')));
  // 重新挂上数据（等同于上传成功后的状态），然后真跑
  await page.evaluate(async()=>{
   plan.data=d.buildDataFile('用户.csv',new TextEncoder().encode('user,city,token\ntom,上海,csv-token\nli,北京,csv-token\njoe,深圳,csv-token\n').buffer);
   s.touch('runners');s.emit('rerender');
   window.run=await r.runRunner(plan);await s.flushDomain('runs');
  });
  check('每行跑一遍整个计划',await page.evaluate(()=>run.entries.length)===9);
  check('结果行带轮次标记',await page.evaluate(()=>run.entries.map(e=>e.iteration).join(',')==='1,1,1,2,2,2,3,3,3'));
  check('行值按文件顺序覆盖环境变量',await page.evaluate(()=>[run.entries[0].url,run.entries[3].url,run.entries[6].url].map(u=>decodeURIComponent(u))).then(urls=>urls.every(u=>/user=(tom|li|joe)/.test(u))&&!urls.some(u=>u.includes('env里的user'))));
  check('同一轮内提取器的值优先于行值',await page.evaluate(()=>run.entries[2].url.includes('token=tom')&&run.entries[5].url.includes('token=tom')));
  check('CSV 里的同名列没有抢先进入请求',await page.evaluate(()=>!run.entries[2].url.includes('csv-token')&&!run.entries[5].url.includes('csv-token')));
  await page.evaluate(()=>{s.openRunner(plan);s.emit('rerender');});
  check('运行记录头显示行数',await page.locator('.run-head').first().innerText().then(t=>t.includes('3 行数据')));
  check('记录行显示第N行',await page.locator('.run-entries .run-entry').first().innerText().then(t=>t.includes('第 1 行')));
  check('运行记录持久化带数据文件名',await page.evaluate(()=>s.state.runs[0].dataFile==='用户.csv'&&s.state.runs[0].iterations===3));
  check('历史条目带行号',await page.evaluate(()=>s.state.history.slice(0,9).map(h=>h.name).some(n=>n.includes('第2行'))));

  // stopOnError：坏请求卡在第二轮中间，后面全部不跑
  await page.evaluate(async()=>{
   const dead=s.newRequestNode('死端点',{url:'http://127.0.0.1:59999/dead'});
   s.state.collections[0].children.push(dead);
   window.plan2=s.newRunner('遇错即停');plan2.sources=[echo.id,dead.id,who.id];plan2.stopOnError=true;
   plan2.data=d.buildDataFile('两行.csv',new TextEncoder().encode('user,city\ntom,上海\nli,北京\n').buffer);
   s.state.runners.push(plan2);
   window.run2=await r.runRunner(plan2);await s.flushDomain('runs');
  });
  check('遇错停在当轮且不再进下一轮',await page.evaluate(()=>run2.entries.length===2&&run2.stoppedAfter===2&&run2.entries[1].outcome==='network-error'));
  check('停下的运行不假装全部通过',await page.evaluate(()=>run2.totals.ran===2&&run2.totals.failed===1));

  // 无数据文件时行为不变：单遍执行
  await page.evaluate(async()=>{
   delete plan2.data;delete plan2.stopOnError;
   window.run3=await r.runRunner(plan2);await s.flushDomain('runs');
  });
  check('移除数据文件后回到单遍运行',await page.evaluate(()=>run3.entries.length===3&&run3.entries.every(e=>!e.iteration)));

  check('页面没有脚本错误',errors.length===0,errors);
  const failed=results.filter(r=>!r.ok);
  console.log(`${results.length-failed.length}/${results.length} passed`);
  process.exit(failed.length?1:0);
 }catch(e){console.error(e);process.exit(1);}finally{await browser.close();}
})();
