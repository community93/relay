const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path'),results=[];
const check=(name,ok)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0];
 try{
  await page.waitForSelector('.rail-btn');
  const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');
  const expected=JSON.parse(fs.readFileSync('.design-qa/sorting-expected.json','utf8'));
  for(const [domain,pane] of [['environments','environments'],['runners','runner'],['docs','docs']]){
   await page.locator(`[data-rail="${pane}"]`).click();
   check(`${domain} 实际进程重启恢复排序`,await page.evaluate(async({domain,ids})=>JSON.stringify((await import('./js/state.js')).state[domain].map(n=>n.id))===JSON.stringify(ids),{domain,ids:expected[domain]}));
   check(`${domain} 重启后界面顺序一致`,JSON.stringify(await page.locator(`#sidebar [data-sort-domain="${domain}"]`).evaluateAll(rows=>rows.map(n=>n.dataset.sortId)))===JSON.stringify(expected[domain]));
  }
  check('重启后保留当前环境',await page.evaluate(async()=>(await import('./js/state.js')).state.settings.activeEnvironmentId==='sort-env-2'));
  fs.writeFileSync('.design-qa/sorting-restart-results.json',JSON.stringify(results,null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1)});
