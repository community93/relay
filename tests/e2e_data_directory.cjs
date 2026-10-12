const {chromium}=require('./playwright.cjs');
const path=require('node:path'),fs=require('node:fs');
const results=[];function check(name,ok){results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);}
(async()=>{
 if(!process.env.RELAY_CDP_URL)throw new Error('Native CDP is required');
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0];
 try{
  await page.evaluate(async()=>{window.s=await import('./js/state.js');window.api=await import('./js/api.js');window.tools=await import('./js/tools.js');});
  const source=await page.evaluate(()=>api.dataPath());if(path.resolve(source).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw new Error('Requires isolated native-data');
  await page.evaluate(async()=>{
    const doc=s.state.docs.find(doc=>doc.name==='项目接口交付')||s.newDoc('项目接口交付');
    if(!s.state.docs.includes(doc))s.state.docs.push(doc);s.openDoc(doc);
    await Promise.all(['collections','environments','docs','history','runners','runs','settings','tabs'].map(domain=>s.flushDomain(domain)));
  });
  const base=path.resolve('.design-qa/migration-'+Date.now()),target=path.join(base,'workspace'),occupied=path.join(base,'occupied');
  if(!base.startsWith(path.resolve('.design-qa')+path.sep))throw new Error('Invalid fixture path');
  fs.mkdirSync(occupied,{recursive:true});fs.writeFileSync(path.join(occupied,'keep.txt'),'untouched');
  await page.evaluate(()=>tools.openSettingsDialog());await page.locator('.settings-nav button').filter({hasText:'数据'}).click();await page.locator('.data-directory-controls').getByRole('button',{name:'更改',exact:true}).click();
  const modal=page.locator('.modal').last();await modal.locator('[aria-label=新数据目录]').fill(occupied);await modal.getByRole('button',{name:'迁移并使用',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.overlay:last-child [role=alert]')?.textContent.includes('非空'));
  check('非空目标拒绝覆盖',fs.readFileSync(path.join(occupied,'keep.txt'),'utf8')==='untouched'&&await page.evaluate(()=>api.dataPath())===source);
  await modal.locator('[aria-label=新数据目录]').fill('relative-folder');await modal.getByRole('button',{name:'迁移并使用',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.overlay:last-child [role=alert]')?.textContent.includes('绝对路径'));check('拒绝相对目录',true);
  await page.evaluate(()=>{s.state.tabs[0].running={execId:'fixture'};});await modal.locator('[aria-label=新数据目录]').fill(target);await modal.getByRole('button',{name:'迁移并使用',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.overlay:last-child [role=alert]')?.textContent.includes('停止'));check('运行时拒绝迁移避免数据交错',true);await page.evaluate(()=>{s.state.tabs[0].running=null;});
  await modal.getByRole('button',{name:'迁移并使用',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.data-directory-controls span')?.textContent.includes('workspace'));
  check('设置展示已切换目录',path.resolve(await page.evaluate(()=>api.dataPath())).toLowerCase()===target.toLowerCase());
  const domains=['collections','environments','docs','history','runners','runs','settings','tabs'];
  check('全部工作区领域已复制',domains.every(domain=>fs.existsSync(path.join(target,domain+'.json'))));
  check('原目录数据保留',domains.every(domain=>fs.existsSync(path.join(source,domain+'.json'))));
  await page.evaluate(()=>{s.state.globals.push(s.kv('migrationMarker','new-directory'));return s.flushDomain('settings');});
  check('后续保存写入新目录',JSON.parse(fs.readFileSync(path.join(target,'settings.json'),'utf8')).globals.some(row=>row.key==='migrationMarker'));
  check('旧目录不会收到后续更改',!JSON.parse(fs.readFileSync(path.join(source,'settings.json'),'utf8')).globals.some(row=>row.key==='migrationMarker'));
  await page.keyboard.press('Escape');await page.waitForTimeout(220);await page.keyboard.press('Escape');await page.waitForTimeout(220);await page.reload();await page.waitForSelector('.delivery-workspace');
  check('迁移后页面重载保留文档与新数据',await page.evaluate(async()=>{const {state}=await import('./js/state.js');return state.docs.some(d=>d.name==='项目接口交付')&&state.globals.some(row=>row.key==='migrationMarker');}));
  fs.writeFileSync('.design-qa/migration-result.json',JSON.stringify({source,target,results},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1)});
