const {chromium}=require('./playwright');
const fs=require('node:fs'),path=require('node:path'),results=[];
function check(name,ok,detail){results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);}
(async()=>{
 const native=!!process.env.RELAY_CDP_URL;
 const browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
  if(native){const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');}
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');s.state.tabs=[];s.state.collections=[];s.state.environments=[];s.state.settings.activeEnvironmentId=null;
   window.tab=s.newTab();tab.draft.url='http://127.0.0.1:8899/echo';tab.draft.method='POST';tab.draft.name='项目详情';tab.view='body';s.emit('rerender');
  });
  const choose=async label=>{await page.getByRole('radiogroup',{name:'请求体格式'}).getByRole('radio',{name:label,exact:true}).click();};
  check('请求体六种方式直接可见',await page.locator('.body-formats [role=radio]').allTextContents().then(text=>JSON.stringify(text)===JSON.stringify(['无','JSON','文本','表单','URL 编码','二进制'])));
  await choose('JSON');check('JSON 一次选择即进入编辑',await page.evaluate(()=>tab.draft.body.mode==='raw'&&tab.draft.body.raw.language==='json')&&await page.locator('.body-code .cm-content').isVisible());
  await page.locator('.body-code .cm-content').fill('{"name":"Relay","note":"{{projectName}}"}');
  check('正文编辑即时标记未保存且更新字符数',await page.evaluate(()=>tab.dirty)&&await page.locator('.body-editor-status .right').innerText()===await page.evaluate(()=>`${tab.draft.body.raw.content.length} 字符`));
  await choose('表单');check('表单显示清晰标题和上传类型列',await page.locator('.kv-title').innerText()==='表单字段 · 文件上传'&&(await page.locator('.kv-head').innerText()).includes('类型'));
  await page.evaluate(()=>{tab.draft.body.form=[s.kv('name','Relay'),{...s.kv('attachment','E:\\sample.txt'),kind:'file'}];s.emit('rerender');});
  await choose('URL 编码');await page.evaluate(()=>{tab.draft.body.urlencoded=[s.kv('page','1')];s.emit('rerender');});
  await choose('二进制');check('二进制上传入口可见',await page.getByRole('button',{name:'选择文件',exact:true}).isVisible());
  await choose('JSON');check('切换类型保留各模式已填内容',await page.evaluate(()=>tab.draft.body.raw.content.includes('Relay')&&tab.draft.body.form[0].value==='Relay'&&tab.draft.body.urlencoded[0].key==='page'));
  await page.evaluate(()=>{tab.draft.headers=[s.kv('Content-Type','application/json')];s.emit('rerender');});await choose('表单');
  check('从 JSON 切表单不携带过期 JSON 类型',await page.evaluate(()=>!tab.draft.headers.some(h=>h.key==='Content-Type'))&&await page.locator('.body-content-type').innerText()==='multipart/form-data');
  await page.evaluate(()=>{tab.draft.headers=[s.kv('Content-Type','application/vnd.company+json')];s.emit('rerender');});await choose('JSON');
  check('自定义媒体类型保留且显示',await page.locator('.body-content-type').innerText()==='application/vnd.company+json');
  await choose('文本');check('文本模式隐藏 JSON 专用操作',await page.getByRole('button',{name:'格式化 JSON',exact:true}).count()===0);
  await page.locator('.editor-bar .select').click();await page.locator('.menu-item').filter({hasText:/^XML$/}).click();
  check('文本可选 XML 且请求头同步',await page.evaluate(()=>tab.draft.body.raw.language==='xml'&&tab.draft.headers[0].value==='application/xml'));
  await choose('JSON');await page.locator('.body-code .cm-content').fill('{"name":"Relay","active":true}');
  await page.getByRole('button',{name:'格式化 JSON',exact:true}).click();check('JSON 格式化后内容正确且计数同步',await page.evaluate(()=>JSON.parse(tab.draft.body.raw.content).name==='Relay')&&await page.locator('.body-editor-status .right').innerText().then(async count=>count===await page.evaluate(()=>`${tab.draft.body.raw.content.length} 字符`)));
  await page.evaluate(()=>{
   tab.draft.headers=[];tab.response={status:200,statusText:'OK',timeMs:127,sizeBytes:373,contentType:'application/json; charset=utf-8',charset:'utf-8',isText:true,headers:[{name:'content-type',value:'application/json'},{name:'x-request-id',value:'trace-01'}],setCookies:[],bodyText:JSON.stringify({id:'prj_01',name:'Relay',description:'A'.repeat(900),members:[{id:1,name:'Relay',active:true},{id:2,name:'Demo',active:false}],meta:{page:1,total:2}})};tab.responseView='body';s.emit('rerender');
  });
  check('响应概览显示简洁 MIME 并保留完整标题',await page.locator('.response-media').innerText()==='application/json'&&await page.locator('.response-media').getAttribute('title')==='application/json; charset=utf-8');
  check('JSON 代码具有顺序行号',await page.locator('.code-line').count()>10&&await page.locator('.code-line').first().getAttribute('data-line')==='1');
  check('Pretty 保留换行与完整文本',await page.locator('pre.code').textContent().then(async text=>text===await page.evaluate(()=>JSON.stringify(JSON.parse(tab.response.bodyText),null,2))));
  await page.getByLabel('搜索响应',{exact:true}).fill('Relay');
  check('搜索仅高亮匹配文本并给出数量',await page.locator('.mark').allTextContents().then(text=>text.length===2&&text.every(x=>x==='Relay'))&&await page.locator('.response-search-count').innerText()==='1 / 2');
  await page.getByLabel('搜索响应',{exact:true}).press('Enter');check('Enter 跳到下一个匹配',await page.locator('.response-search-count').innerText()==='2 / 2');
  await page.getByLabel('搜索响应',{exact:true}).press('Shift+Enter');check('Shift Enter 返回前一个匹配',await page.locator('.response-search-count').innerText()==='1 / 2');
  await page.getByLabel('搜索响应',{exact:true}).fill('not-found');check('搜索无匹配有明确状态',await page.locator('.response-search-count').innerText()==='无匹配');
  await page.getByLabel('搜索响应',{exact:true}).press('Escape');check('Esc 清空搜索而不关闭请求',await page.getByLabel('搜索响应',{exact:true}).inputValue()===''&&await page.locator('pre.code').isVisible());
  await page.getByLabel('自动换行',{exact:true}).click();check('换行后长文本不横向溢出',await page.locator('.response-content').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  check('换行后行号仍属于原始逻辑行',await page.locator('.code-line[data-line="4"]').count()===1);
  await page.locator('.code-bar').getByRole('radio',{name:'树',exact:true}).click();check('切到树视图明确禁用文本搜索',await page.getByLabel('搜索响应',{exact:true}).isDisabled()&&await page.getByLabel('自动换行',{exact:true}).isDisabled());
  await page.getByRole('button',{name:'全部收起',exact:true}).click();await page.getByRole('button',{name:'全部展开',exact:true}).click();check('树节点可全部展开',await page.locator('.json-tree-row').count()>12);
  const expanded=await page.locator('.json-tree-list .twist').allTextContents();
  await page.evaluate(()=>{window.treeOther=s.newTab();s.activateTab(tab.id);});await page.waitForTimeout(150);
  check('切换标签保留树节点展开状态',await page.locator('.json-tree-list .twist').allTextContents().then(text=>JSON.stringify(text)===JSON.stringify(expanded)));
  await page.locator('.code-bar').getByRole('radio',{name:'Raw',exact:true}).click();check('切回 Raw 恢复搜索并保持原始内容',!await page.getByLabel('搜索响应',{exact:true}).isDisabled()&&await page.locator('pre.code').textContent()===await page.evaluate(()=>tab.response.bodyText));
  await page.locator('.response-tabs').getByRole('button',{name:/Headers/}).click();check('响应头仍可正常查看',await page.locator('.response-body .table').innerText().then(text=>text.includes('x-request-id')));
  await page.locator('.response-tabs').getByRole('button',{name:'Body',exact:true}).click();
  await page.locator('.code-bar').getByRole('radio',{name:'Pretty',exact:true}).click();
  await page.evaluate(()=>{const data=JSON.parse(tab.response.bodyText);data.description='项目成员共享的接口工作区，记录请求、字段约定与交付状态。';tab.response.bodyText=JSON.stringify(data);s.emit('rerender');});
  await page.waitForTimeout(220);
  await page.locator('.response-content').evaluate(el=>el.scrollTop=0);await page.screenshot({path:`.design-qa/response-layout-${native?'native':'browser'}.png`});
  const sampleFile=path.resolve('.design-qa','response-payload.json');fs.writeFileSync(sampleFile,'{"project":"Relay"}\n');await page.evaluate(file=>{tab.draft.body.form[1].value=file;s.emit('rerender');},sampleFile);
  await choose('表单');await page.waitForTimeout(250);await page.screenshot({path:`.design-qa/body-formats-${native?'native':'browser'}.png`});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:`.design-qa/response-dark-${native?'native':'browser'}.png`});
  check('深色响应阅读区使用深色背景',await page.locator('.response-content').evaluate(el=>getComputedStyle(el.closest('.response-body')).backgroundColor!=='rgb(255, 255, 255)'));
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.locator('.response-content').evaluate(el=>el.scrollTop=260);await page.waitForTimeout(80);
  const scroll=await page.locator('.response-content').evaluate(el=>el.scrollTop);
  await page.evaluate(()=>{window.other=s.newTab();s.activateTab(tab.id);});await page.waitForTimeout(150);
  check('切换标签保留响应阅读位置',await page.locator('.response-content').evaluate((el,top)=>Math.abs(el.scrollTop-top)<2,scroll));
  await page.evaluate(()=>{tab.response.bodyText='\n'.repeat(200001);tab.response.contentType='text/plain';s.emit('rerender');});check('极多空行响应受节点预算限制',await page.locator('.code-line').count()<=6000&&await page.locator('.render-note').isVisible());
  if(!native){await page.setViewportSize({width:1000,height:740});check('小窗口请求体选项不造成页面横向溢出',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));check('小窗口响应工具栏完整可用',await page.getByLabel('搜索响应',{exact:true}).isVisible()&&await page.getByLabel('自动换行',{exact:true}).isVisible());}
  if(native){await page.evaluate(()=>Promise.all(['tabs','collections','settings','environments'].map(domain=>s.flushDomain(domain))));await page.reload();await page.waitForSelector('.url-input');await page.evaluate(async()=>{const s=await import('./js/state.js');s.activeTab().view='body';s.emit('rerender');});await page.waitForSelector('.body-formats');check('重载恢复表单字段和选择',await page.evaluate(async()=>{const {activeTab}=await import('./js/state.js');const tab=activeTab();return tab.draft.body.mode==='form'&&tab.draft.body.form[0].key==='name';}));}
  check('整轮无 JavaScript 异常',errors.length===0,errors);fs.writeFileSync(`.design-qa/response-layout-${native?'native':'browser'}-results.json`,JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1);});
