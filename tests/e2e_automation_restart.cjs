const {chromium}=require('./playwright');
const path=require('node:path'),results=[];
const check=(name,ok)=>{results.push(!!ok);console.log(`${ok?'PASS':'FAIL'} ${name}`);};
(async()=>{const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0];try{
 await page.waitForSelector('.rail-btn');
 if(path.resolve(await page.evaluate(async()=>(await import('./js/api.js')).dataPath())).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated data');
 const result=await page.evaluate(async()=>{const s=await import('./js/state.js'),d=await import('./js/delivery.js');const doc=s.state.docs.find(d=>d.id==='ai-delivery'),node=s.findNode('ai-project')?.node;return {off:!(await window.__TAURI__.core.invoke('automation_status')),requests:!!node&&s.findNode('ai-ws').node.protocol==='ws'&&s.findNode('ai-sse').node.protocol==='sse',checks:node?.request.checks[0].operator==='equals',fields:doc?.blocks[0].contract.fields['params:page']?.description==='页码，从1开始',evidence:!!doc?.blocks[0].verified&&doc.blocks[0].response.checkResult.ok===false,status:doc&&d.endpointStatus(doc.blocks[0]).kind,runner:s.state.runners.some(r=>r.id==='ai-chain')&&s.state.runs.some(r=>r.runnerId==='ai-chain'&&r.totals.passed===2)};});
 check('应用重启后AI连接默认关闭',result.off);check('AI创建请求和协议持久保存',result.requests);check('AI检查规则持久保存',result.checks);check('AI字段说明持久保存',result.fields);check('真实成功样例与最近失败证据同时保留',result.evidence&&result.status==='failed');check('AI计划和逐请求结果持久保存',result.runner);
}catch(error){check(error.message,false);}finally{await browser.close();}console.log(`${results.filter(Boolean).length}/${results.length} passed`);process.exitCode=results.some(ok=>!ok)?1:0;})();
