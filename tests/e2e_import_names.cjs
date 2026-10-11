const {chromium}=require('./playwright');
const fs=require('node:fs'),path=require('node:path');
const results=[];const check=(name,ok)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
(async()=>{
 const native=!!process.env.RELAY_CDP_URL;
 const browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:920}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try {
  if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
  if(native){const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw new Error('Requires isolated native-data');}
  await page.evaluate(async()=>{window.s=await import('./js/state.js');window.t=await import('./js/tools.js');window.fixture=s.newCollection('Import QA');s.state.collections=[fixture];s.state.tabs=[];s.newTab();s.emit('tree');});
  const dialog=page.locator('.modal').last();
  const open=async(text)=>{await page.evaluate(text=>t.importCurlDialog(null,text),text);await dialog.locator('.pick input[aria-label]').first().waitFor();};
  const submit=()=>dialog.getByRole('button',{name:'导入',exact:true}).click();
  const closed=()=>page.waitForFunction(()=>!document.querySelector('.overlay:not(.closing)'));
  await open("curl 'https://example.invalid/stats'");
  await dialog.getByRole('textbox',{name:'请求 1 名称',exact:true}).fill('  用量统计  ');
  await submit();await closed();
  check('自定义名称写入节点与请求数据',await page.evaluate(()=>fixture.children[0].name==='用量统计'&&fixture.children[0].request.name==='用量统计'));
  check('左侧请求名称立即生效',await page.locator('#sidebar .node .name').filter({hasText:'用量统计'}).count()===1);
  check('标签页与编辑标题立即生效',await page.locator('.tab.active').innerText().then(x=>x.includes('用量统计'))&&await page.locator('.req-title').inputValue()==='用量统计');
  await open("curl 'https://example.invalid/one'");
  const area=dialog.locator('textarea');
  const batch="curl 'https://example.invalid/one'\ncurl 'https://example.invalid/two'";
  await area.fill(batch);
  await area.evaluate(el=>el.dispatchEvent(new Event('paste',{bubbles:true})));
  await page.waitForFunction(()=>document.querySelectorAll('.overlay:not(.closing) .pick').length===2);
  await dialog.getByRole('textbox',{name:'请求 1 名称',exact:true}).fill('批量自定义一');
  await dialog.getByRole('textbox',{name:'请求 2 名称',exact:true}).fill('批量自定义二');
  await dialog.locator('.pick input[type=checkbox]').nth(1).uncheck();
  await page.waitForTimeout(550);
  check('粘贴后的延迟解析保留修改与勾选',await dialog.getByRole('textbox',{name:'请求 1 名称',exact:true}).inputValue()==='批量自定义一'&&await dialog.getByRole('textbox',{name:'请求 2 名称',exact:true}).inputValue()==='批量自定义二'&&!await dialog.locator('.pick input[type=checkbox]').nth(1).isChecked());
  await area.fill(`${batch}\ncurl 'https://example.invalid/extra'`);
  await page.waitForFunction(()=>document.querySelectorAll('.overlay:not(.closing) .pick').length===3);
  check('追加命令重新解析保留已有名称与选择',await dialog.getByRole('textbox',{name:'请求 1 名称',exact:true}).inputValue()==='批量自定义一'&&!await dialog.locator('.pick input[type=checkbox]').nth(1).isChecked());
  await dialog.locator('.pick input[type=checkbox]').nth(2).uncheck();
  await submit();await closed();
  check('批量导入尊重名称和跳过项',await page.evaluate(()=>fixture.children.length===2&&fixture.children[1].name==='批量自定义一'));
  await open("curl 'https://example.invalid/three'\ncurl 'https://example.invalid/four'");
  await dialog.getByRole('textbox',{name:'请求 1 名称',exact:true}).fill('第三个请求');
  await dialog.getByRole('textbox',{name:'请求 2 名称',exact:true}).fill('第四个请求');
  await submit();await closed();
  const importedNames=await page.evaluate(()=>fixture.children.slice(-2).map(x=>({name:x.name,draftName:x.request.name,url:x.request.url})));
  check('多条请求分别保存自定义名称',importedNames.map(x=>x.name).join(',')==='第三个请求,第四个请求');
  if(importedNames.map(x=>x.name).join(',')!=='第三个请求,第四个请求')console.log(JSON.stringify(importedNames));
  await open("curl 'https://example.invalid/old'");
  await dialog.locator('textarea').fill("curl 'https://example.invalid/latest'");await submit();await closed();
  check('修改命令立即导入使用最新解析结果',await page.evaluate(()=>fixture.children.at(-1).request.url==='https://example.invalid/latest'));
  await open("curl 'https://example.invalid/blank'");await dialog.getByRole('textbox',{name:'请求 1 名称',exact:true}).fill('   ');await submit();await closed();
  check('空白名称回退后节点与编辑标题一致',await page.evaluate(()=>fixture.children.at(-1).name==='https://example.invalid/blank'&&s.activeTab().draft.name===fixture.children.at(-1).name));
  if(native){await page.evaluate(()=>Promise.all(['collections','tabs'].map(x=>s.flushDomain(x))));await page.reload();await page.waitForSelector('.url-input');check('原生刷新后自定义名称仍保留',await page.evaluate(async()=>{const {state}=await import('./js/state.js');const nodes=state.collections.find(c=>c.name==='Import QA').children;return nodes[0].name==='用量统计'&&nodes[0].request.name==='用量统计'&&nodes[2].name==='第三个请求';}));}
  check('无 JavaScript 异常',!errors.length);
  fs.writeFileSync(`.design-qa/import-names-${native?'native':'browser'}-results.json`,JSON.stringify({results,errors},null,2));console.log(`${results.filter(x=>x.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(x=>!x.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
