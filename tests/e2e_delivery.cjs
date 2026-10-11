const {chromium}=require('./playwright');
const fs=require('node:fs'),path=require('node:path'),results=[];
function check(name,ok,detail){results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':JSON.stringify(detail)}`);}
(async()=>{
 const native=!!process.env.RELAY_CDP_URL,browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:920}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try {
  if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
  if(native){const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw new Error('Requires isolated native-data');}
  await page.evaluate(async()=>{window.s=await import('./js/state.js');window.d=await import('./js/doc.js');window.contract=await import('./js/delivery.js');const env=s.newEnvironment('Local QA');env.variables=[s.kv('projectId','42'),s.kv('accessToken','private-test-secret')];s.state.environments=[env];s.state.settings.activeEnvironmentId=env.id;s.state.docs=[];s.state.collections=[];s.state.tabs=[];window.doc=d.createDoc('项目接口交付');s.emit('environment');});
  check('新文档是空白交付草稿',await page.locator('.delivery-paste').isVisible()&&await page.locator('.delivery-endpoint').count()===0);
  const curl="curl 'http://127.0.0.1:18999/projects?id={{projectId}}' -H 'Authorization: Bearer {{accessToken}}'\ncurl 'http://127.0.0.1:18999/health'";
  await page.locator('[aria-label=接口草稿]').fill(curl);await page.locator('[aria-label=接口草稿]').press('Control+Enter');await page.waitForSelector('.delivery-endpoint');
  check('Ctrl Enter 批量 cURL 形成两个接口草稿',await page.locator('.delivery-endpoint').count()===2&&await page.evaluate(()=>doc.blocks.every(b=>!b.response)));
  const card=()=>page.locator('.delivery-endpoint').first();
  await card().locator('[aria-label=接口名称]').fill('查询项目列表');
  await card().getByRole('button',{name:'运行验证',exact:true}).click();await page.waitForFunction(()=>doc.blocks[0].verified&&!doc.blocks[0].running);
  check('成功运行自动保留响应与验证环境',await page.evaluate(()=>doc.blocks[0].verified.response.status===200&&doc.blocks[0].verified.environment==='Local QA'));
  check('环境变量改动让验证过期，恢复原值后匹配',await page.evaluate(()=>{const row=s.state.environments[0].variables.find(v=>v.key==='projectId'),old=row.value;row.value='changed';const stale=contract.endpointStatus(doc.blocks[0]).kind==='stale';row.value=old;return stale&&contract.endpointStatus(doc.blocks[0]).kind==='verified';}));
  check('动态变量不会让刚完成的验证立即过期',await page.evaluate(()=>{const block={type:'req',draft:s.newRequestDraft({url:'https://example.invalid/echo',headers:[s.kv('X-Trace','{{$guid}}')]}),auth:{kind:'noauth'}};const built=s.buildSendDraft(block);contract.captureVerification(block,block,built,{status:200,bodyText:'{}',headers:[]});return contract.endpointStatus(block).kind==='verified';}));
  check('自动鉴权头不误报过期，凭据修改后需重新验证',await page.evaluate(()=>{const block={type:'req',draft:s.newRequestDraft({url:'https://example.invalid/echo'}),auth:{kind:'bearer',bearer:{token:'{{accessToken}}'}}};contract.captureVerification(block,block,s.buildSendDraft(block),{status:200,bodyText:'{}',headers:[]});const fresh=contract.endpointStatus(block).kind==='verified',row=s.state.environments[0].variables.find(v=>v.key==='accessToken'),old=row.value;row.value='updated';const stale=contract.endpointStatus(block).kind==='stale';row.value=old;return fresh&&stale;}));
  check('响应生成字段结构',await page.evaluate(()=>contract.endpointFields(doc.blocks[0]).some(f=>f.group==='Response')));
  const savedFields=await page.evaluate(()=>{const sample=[{id:1,value:null},{id:2,active:true}];return contract.sampleFields({data:sample}).map(x=>x.path);});
  check('数组多条样例合并字段',savedFields.includes('data[].active')&&savedFields.includes('data[].value'));
  await card().getByRole('button',{name:'交付说明',exact:true}).click();await card().locator('[aria-label=接口业务说明]').fill('查询当前工作区的项目，用于交付方核对项目配置。');
  await card().getByRole('button',{name:'字段说明',exact:true}).click();
  const fieldInputs=card().locator('.delivery-field-row input');for(let i=0;i<await fieldInputs.count();i++)await fieldInputs.nth(i).fill('字段说明 '+(i+1));
  const required=card().locator('.delivery-field-row .select');for(let i=0;i<await required.count();i++){await required.nth(i).click();await page.locator('.menu-item').filter({hasText:/^可选$/}).click();}
  await card().getByRole('button',{name:'确认交付',exact:true}).click();
  check('填写说明并确认后标记可交付',await page.evaluate(()=>contract.endpointStatus(doc.blocks[0]).kind==='ready'));
  const md=await page.evaluate(()=>d.docToMarkdown(doc));
  check('Markdown 包含字段与响应样例',md.includes('查询项目列表')&&md.includes('已验证响应')&&md.includes('响应字段')&&md.includes('字段说明'));
  check('交付示例不泄露请求令牌',!md.includes('private-test-secret'));
  if(native)check('交付响应令牌被隐藏',!md.includes('response-secret-for-export'));
  check('OpenAPI 包含参数与响应 schema',await page.evaluate(()=>{const spec=contract.deliveryOpenApi(doc),op=spec.paths['/projects'].get;return spec.openapi==='3.0.3'&&op.parameters.some(p=>p.name==='id')&&!!op.responses['200'].content['application/json'].schema;}));
  check('OpenAPI 声明 Bearer 鉴权且不导出令牌',await page.evaluate(()=>{const spec=contract.deliveryOpenApi(doc),op=spec.paths['/projects'].get,key=Object.keys(op.security?.[0]||{})[0];return !!key&&spec.components.securitySchemes[key].scheme==='bearer'&&!JSON.stringify(spec).includes('private-test-secret');}));
  check('继承鉴权以验证时的方式写入规范',await page.evaluate(()=>{const block=contract.clone(doc.blocks[0]);block.auth={kind:'inherit'};block.draft.headers=[];block.verified.auth={kind:'apikey',apikey:{key:'X-Workspace-Key',addTo:'header'}};const spec=contract.deliveryOpenApi({name:'test',blocks:[block]}),key=Object.keys(spec.paths['/projects'].get.security[0])[0];return spec.components.securitySchemes[key].name==='X-Workspace-Key';}));
  check('响应普通文本中的已知令牌也会隐藏',await page.evaluate(()=>!contract.safeResponse('{"message":"echo private-test-secret"}',contract.requestSecrets({headers:[{key:'Authorization',value:' Bearer private-test-secret'}]})).includes('private-test-secret')));
  check('OpenAPI 路径变量保留且为必填',await page.evaluate(()=>{const b={type:'req',draft:s.newRequestDraft({url:'https://api.example.invalid/projects/{{projectId}}'}),contract:{summary:'test',description:'',fields:{}}};const spec=contract.deliveryOpenApi({name:'test',blocks:[b]});return spec.paths['/projects/{projectId}'].get.parameters[0].required===true;}));
  check('HTML 为独立文档并转义标题',await page.evaluate(()=>{const html=d.deliveryHtml({...doc,name:'<script>test</script>'});return html.startsWith('<!doctype html>')&&html.includes('&lt;script&gt;')&&!html.includes('<title><script>');}));
  check('普通 JSON 代码块不会变成可执行接口',await page.evaluate(()=>{const imported=d.markdownToDoc('test','```json\n{"id":1}\n```');return imported.blocks.every(b=>b.type==='text');}));
  check('错误响应保留成功样例并进入交付文档',await page.evaluate(()=>{const block=contract.clone(doc.blocks[0]),shell={draft:block.draft,auth:block.auth};const built=s.buildSendDraft(shell);contract.captureVerification(block,shell,built,{status:422,bodyText:'{"error":"invalid","accessToken":"hidden-error-token"}',contentType:'application/json',headers:[]});const md=contract.deliveryMarkdown({name:'test',blocks:[block]}),api=contract.deliveryOpenApi({name:'test',blocks:[block]});return block.verified.response.status===200&&contract.endpointStatus(block).kind==='failed'&&md.includes('错误响应 422')&&!md.includes('hidden-error-token')&&!!api.paths['/projects'].get.responses['422'];}));
  await page.evaluate(()=>{document.querySelector('.delivery-workspace').scrollTop=0;});
  await page.screenshot({path:`.design-qa/delivery-fields-${native?'native':'browser'}.png`});
  await page.getByRole('radio',{name:'交付预览',exact:true}).click();await page.waitForSelector('.delivery-preview');check('交付预览与导出使用同一内容',(await page.locator('.delivery-preview').innerText()).includes('查询项目列表'));
  await page.screenshot({path:`.design-qa/delivery-preview-${native?'native':'browser'}.png`});await page.getByRole('radio',{name:'草稿调试',exact:true}).click();
  await card().getByRole('button',{name:'调试',exact:true}).click();await page.waitForSelector('.url-input');
  check('文档接口能直接返回请求编辑器',await page.evaluate(()=>!!s.activeTab().docBinding&&s.activeTab().draft.url.includes('/projects')));
  await page.locator('.url-input').fill('http://127.0.0.1:18999/projects?id=99');await page.evaluate(()=>s.openDoc(doc));
  check('请求改动使验证过期而保留字段说明',await page.evaluate(()=>contract.endpointStatus(doc.blocks[0]).kind==='stale'&&Object.values(doc.blocks[0].contract.fields).some(f=>f.description==='字段说明 1')));
  await card().getByRole('button',{name:'调试',exact:true}).click();await page.waitForSelector('.url-input');await page.locator('.urlbar .primary').click();await page.waitForFunction(()=>s.activeTab().response&&!s.activeTab().running);await page.evaluate(()=>s.openDoc(doc));
  check('请求页重跑会回写文档验证结果',await page.evaluate(()=>doc.blocks[0].verified.request.params.some(p=>p.key==='id'&&p.value==='99')&&contract.endpointStatus(doc.blocks[0]).kind==='verified'));
  await card().getByRole('button',{name:'存入集合',exact:true}).click();await page.locator('.modal').last().getByRole('button',{name:'保存',exact:true}).click();await page.waitForTimeout(250);
  check('文档接口存入集合并建立关联',await page.evaluate(()=>!!doc.blocks[0].sourceId&&s.state.collections[0].children[0].name==='查询项目列表'));
  await card().getByRole('button',{name:'打开请求',exact:true}).click();await page.waitForSelector('.url-input');
  await page.locator('.delivery-add-request').click();await page.getByRole('radiogroup',{name:'选择交付文档',exact:true}).getByRole('radio').filter({hasText:'项目接口交付'}).click();await page.locator('.modal').last().getByRole('button',{name:'更新并打开',exact:true}).click();
  check('集合请求重复加入同一文档不会重复接口',await page.evaluate(()=>doc.blocks.filter(b=>b.sourceId).length===1));
  await page.evaluate(()=>{s.state.collections[0].children=[];s.emit('rerender');});check('删除来源后文档保留草稿与样例',(await card().innerText()).includes('关联请求已删除')&&await page.evaluate(()=>!!doc.blocks[0].verified));
  if(!await page.locator('[aria-label=接口草稿]').isVisible())await page.locator('.delivery-composer-heading').click();await page.locator('[aria-label=接口草稿]').fill('## 调用约定\n所有时间使用 UTC。');await page.getByRole('button',{name:'加入草稿',exact:true}).click();check('草稿支持 Markdown 说明',await page.evaluate(()=>doc.blocks.some(b=>b.type==='text'&&b.text.includes('调用约定'))));
  await page.evaluate(()=>{doc.blocks[1].draft.headers.push(s.kv('X-Missing','{{undefinedKey}}'));doc.blocks[1].parsedCurl=doc.blocks[1].curl;s.emit('rerender');});await page.locator('.delivery-outline-item').nth(1).click();await page.locator('.delivery-endpoint').nth(1).getByRole('button',{name:'运行验证',exact:true}).click();await page.waitForTimeout(300);check('文档运行前阻止缺失变量',await page.evaluate(()=>!doc.blocks[1].verified&&!doc.blocks[1].running));
  if(!native)await page.setViewportSize({width:1000,height:640});await page.screenshot({path:`.design-qa/delivery-compact-${native?'native':'browser'}.png`});check('最小窗口工作台没有横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.querySelector('.delivery-workspace').scrollWidth<=document.querySelector('.delivery-workspace').clientWidth+1));
  if(native){await page.evaluate(()=>Promise.all(['docs','collections','tabs','settings','environments'].map(domain=>s.flushDomain(domain))));await page.reload();await page.waitForSelector('.delivery-workspace');check('重载保留草稿字段说明和验证样例',await page.evaluate(async()=>{const s=await import('./js/state.js');const doc=s.state.docs.find(d=>d.name==='项目接口交付');return doc.blocks[0].verified&&Object.values(doc.blocks[0].contract.fields).some(f=>f.description==='字段说明 1');}));}
  if(native){
    for(const [label,extension] of [['Markdown .md','md'],['独立 HTML','html'],['OpenAPI 3.0 .json','json']]) {
      const file=path.resolve('.design-qa',`delivery-export.${extension}`);if(fs.existsSync(file))fs.unlinkSync(file);
      await page.evaluate(file=>{window.__relaySaveTo=file;document.querySelector('.delivery-workspace').scrollTop=0;},file);
      await page.getByRole('button',{name:'导出交付',exact:true}).click();await page.locator('.menu-item').filter({hasText:label}).click();
      for(let attempt=0;attempt<30&&!fs.existsSync(file);attempt++)await page.waitForTimeout(100);
      const text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
      check(`原生 ${extension} 导出写入文件且隐藏令牌`,text.includes('项目接口交付')&&!text.includes('private-test-secret')&&!text.includes('response-secret-for-export'));
    }
  }
  check('无 JavaScript 异常',!errors.length,errors);fs.writeFileSync(`.design-qa/delivery-${native?'native':'browser'}-results.json`,JSON.stringify({results,errors},null,2));console.log(`${results.filter(x=>x.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(x=>!x.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1)});
