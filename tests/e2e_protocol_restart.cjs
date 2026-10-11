const {chromium}=require('./playwright');
const fs=require('node:fs'),path=require('node:path'),results=[];
const check=(name,ok)=>{results.push({name,ok:!!ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.waitForSelector('.rail-btn');await page.evaluate(async()=>{window.s=await import('./js/state.js');window.api=await import('./js/api.js');});
  const data=await page.evaluate(()=>api.dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');
  for(const protocol of ['http','sse','ws']){
   const node=await page.evaluate(protocol=>s.state.collections.flatMap(c=>c.children).find(n=>n.name===`restart-${protocol}`),protocol);if(!node)throw Error('Missing restart fixture');
   await page.locator(`#sidebar [data-node="${node.id}"]`).click();
   check(`真实进程重启 ${protocol} 恢复协议`,await page.evaluate(protocol=>s.activeTab().protocol===protocol,protocol));
   check(`真实进程重启 ${protocol} 恢复节点类型`,await page.evaluate(protocol=>s.activeTab().kind===(protocol==='ws'?'ws':'request'),protocol));
   check(`真实进程重启 ${protocol} 控件选中`,await page.locator('.url-field').getByRole('radio',{name:protocol==='ws'?'WS':protocol.toUpperCase(),exact:true}).getAttribute('aria-checked')==='true');
  }
  check('实际重启无 JavaScript 异常',errors.length===0);fs.writeFileSync('.design-qa/protocol-restart-results.json',JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
