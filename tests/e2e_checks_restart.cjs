const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path'),results=[];
const check=(name,ok)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0];
 try{
  await page.waitForSelector('.rail-btn');
  await page.evaluate(async()=>{window.s=await import('./js/state.js');});
  if(path.resolve(await page.evaluate(async()=>(await import('./js/api.js')).dataPath())).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated data');
  check('重启恢复已保存的检查与提取',await page.evaluate(()=>{const node=s.state.collections[0].children.find(n=>n.name==='登录');s.openRequest(node,{replaceExisting:false});return s.activeTab().draft.checks.length===3&&s.activeTab().draft.extractors[0].path==='$.data.token';}));
  check('重启保留运行检查证据',await page.evaluate(()=>s.state.runs.some(run=>run.entries.some(entry=>entry.details?.checkResult?.checks.length))));
  check('响应提取值不成为隐藏全局变量',await page.evaluate(()=>!s.state.globals.some(row=>row.key==='token')));
 }catch(e){check('suite completed '+e.message,false);}
 finally{fs.writeFileSync('reports/phase1-0.1.14/restart-native.json',JSON.stringify(results,null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);await browser.close();process.exitCode=results.every(r=>r.ok)?0:1;}
})();
