// Document authoring and publication contracts. Native mode requires QA data.
const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path');
const results=[];
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
   window.s=await import('./js/state.js');window.d=await import('./js/doc.js');window.c=await import('./js/delivery.js');window.p=await import('./js/publication.js');
   s.state.tabs=[];s.state.docs=[];s.state.collections=[];s.state.environments=[];s.state.settings.activeEnvironmentId=null;
   window.doc=d.createDoc('项目协作 API');doc.overview='## 调用约定\n项目、成员与权限接口。响应时间采用 UTC，分页从 1 开始。';doc.version='2.4.0';
   for(const [index,name] of ['查询项目列表','创建项目','查询成员权限'].entries()){
    const block=s.newReqBlock(`curl 'https://api.example.invalid/v2/${index===2?'members':'projects'}'`);
    block.draft=s.newRequestDraft({name,url:`https://api.example.invalid/v2/${index===2?'members':'projects'}`,method:index===1?'POST':'GET',params:[s.kv('workspaceId','42'),s.kv('page','1')]});block.parsedCurl=block.curl;block.auth={kind:'noauth'};
    block.contract={summary:name,description:index===0?'按工作区查询可访问项目，支持分页与成员权限过滤。':'',fields:{},reviewed:false};
    if(index!==1)c.captureVerification(block,block,s.buildSendDraft(block),{status:200,timeMs:38,bodyText:JSON.stringify({data:[{id:'prj_01',name:'Relay',visibility:'private'}],total:1,accessToken:'example-sensitive-token'}),headers:[],contentType:'application/json'});
    if(index===0){for(const row of c.endpointFields(block))block.contract.fields[row.id]={description:row.group==='Response'?`${row.path} 返回值`:`${row.path} 查询条件`,required:false};block.contract.reviewed=true;}
    if(index===1){block.contract.fields['params:workspaceId']={required:true,description:'目标工作区 ID'};block.view='fields';}
    doc.blocks.push(block);
   }
   doc.activeBlockId=doc.blocks[0].id;s.emit('environment');s.emit('tree');s.emit('rerender');
  });
  check('文档编辑器没有原生选择框',await page.locator('.delivery-workspace select').count()===0);
  await page.waitForFunction(()=>{const area=document.querySelector('.delivery-intro');return area.scrollHeight<=area.clientHeight+1;});
  check('已保存多行概述完整显示',await page.getByLabel('交付概述').evaluate(el=>el.scrollHeight<=el.clientHeight+1));
  check('验证和可交付数量独立显示',await page.locator('[data-stage=verified]').innerText()==='2 已验证'&&await page.locator('[data-stage=ready]').innerText()==='1 可交付');
  await page.getByRole('button',{name:'待完善',exact:true}).click();
  check('待完善目录只显示未交付接口',await page.locator('.delivery-outline-item').count()===2&&!(await page.locator('.delivery-outline-list').innerText()).includes('查询项目列表'));
  await page.getByLabel('查找文档接口').fill('members');check('目录按请求路径搜索',await page.locator('.delivery-outline-item').count()===1&&(await page.locator('.delivery-outline-list').innerText()).includes('查询成员权限'));
  await page.getByLabel('查找文档接口').fill('absent');check('目录无匹配时有明确反馈',await page.locator('.delivery-outline-empty').innerText()==='无匹配接口');
  await page.getByLabel('查找文档接口').fill('');await page.getByRole('button',{name:'待完善',exact:true}).click();
  await page.locator('.delivery-outline-item').nth(1).click();check('目录点击更新当前项',await page.locator('.delivery-outline-item[aria-current=true]').innerText().then(text=>text.includes('创建项目')));
  const second=()=>page.locator('.delivery-endpoint').nth(1);
  await second().getByRole('button',{name:'业务说明',exact:true}).click();
  check('点击待补充项直接聚焦业务说明',await page.getByLabel('接口业务说明').evaluate(el=>el===document.activeElement));
  await page.getByLabel('接口业务说明').fill('创建工作区项目。名称在同一工作区内唯一。');
  await second().locator('.delivery-issue').filter({hasText:'必填规则'}).click();
  await page.waitForFunction(()=>document.activeElement?.classList.contains('select')&&document.activeElement.dataset.value==='unknown');
  check('点击缺失规则聚焦待确认字段',await page.evaluate(()=>document.activeElement?.classList.contains('select')&&document.activeElement.dataset.value==='unknown'));
  await second().getByRole('button',{name:'未确认设为可选',exact:true}).click();
  check('批量设置只改变未确认项',await page.evaluate(()=>doc.blocks[1].contract.fields['params:workspaceId'].required===true&&doc.blocks[1].contract.fields['params:page'].required===false));
  check('规则已确认后禁用批量操作',await second().getByRole('button',{name:'未确认设为可选',exact:true}).isDisabled());
  await second().locator('.delivery-issue').filter({hasText:'字段说明'}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Query page 说明');
  check('缺失字段说明聚焦首个空输入',await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')==='Query page 说明'));
  await page.getByLabel('Query page 说明').fill('页码，从 1 开始');
  check('输入立即刷新缺失清单',!(await second().locator('.delivery-issues').innerText()).includes('字段说明'));
  await page.getByLabel('文档版本').fill('2.5.0');
  await page.getByRole('radio',{name:'交付预览',exact:true}).click();
  check('交付封面显示编辑后的版本',await page.locator('.pub-version').innerText()==='v2.5.0');
  check('交付目录和接口一一对应',await page.locator('.pub-toc a').count()===3&&await page.locator('.pub-endpoint').count()===3);
  check('交付预览保留业务说明与字段表',(await page.locator('.pub-main').innerText()).includes('页码，从 1 开始')&&await page.locator('.pub-main table').count()>0);
  check('预览响应样例隐藏敏感令牌',!(await page.locator('.delivery-preview').innerText()).includes('example-sensitive-token'));
  const startUrl=page.url();await page.locator('.pub-toc a').nth(2).click();await page.waitForTimeout(450);
  check('目录定位不改变应用地址',page.url()===startUrl&&await page.locator('.pub-endpoint').nth(2).evaluate(el=>el.getBoundingClientRect().top<innerHeight));
  await page.locator('.pub-endpoint').nth(2).getByRole('button',{name:'编辑',exact:true}).click();
  check('预览编辑直接返回对应草稿',await page.evaluate(()=>doc.mode==='draft'&&doc.activeBlockId===doc.blocks[2].id)&&await page.locator('.delivery-endpoint').count()===3);
  await page.getByRole('radio',{name:'交付预览',exact:true}).click();
  const html=await page.evaluate(()=>d.deliveryHtml(doc));
  check('HTML 导出与预览共用版式与版本',html.includes('pub-cover')&&html.includes('pub-toc')&&html.includes('v2.5.0')&&!html.includes('example-sensitive-token'));
  const exportPage=native?await browser.contexts()[0].newPage():await browser.newPage({viewport:{width:1440,height:1000}});
  await exportPage.setContent(html);
  check('独立 HTML 可渲染全部接口且目录有效',await exportPage.locator('.pub-endpoint').count()===3&&await exportPage.locator('#endpoint-3').count()===1);
  check('预览和独立 HTML 正文相同',await page.locator('.pub-content').allTextContents().then(async text=>JSON.stringify(text.map(x=>x.replace(/复制/g,'')))===JSON.stringify(await exportPage.locator('.pub-content').allTextContents())));
  await exportPage.screenshot({path:`.design-qa/document-export-${native?'native':'browser'}.png`});await exportPage.close();
  check('标题和 URL 中的 HTML 被转义',await page.evaluate(()=>{const test=c.clone(doc);test.name='<img src=x onerror=alert(1)>';test.blocks[0].contract.summary='<script>bad</script>';test.blocks[0].draft.url='https://example.invalid/<img src=x>';const root=document.createElement('div');root.innerHTML=p.publicationMarkup(test);return !root.querySelector('script,img')&&root.textContent.includes('<script>bad</script>');}));
  check('带竖线的字段说明不会拆散表格',await page.evaluate(async()=>{const {renderMarkdown}=await import('./js/md.js');const root=document.createElement('div');root.innerHTML=renderMarkdown('| 值 | 说明 |\n| --- | --- |\n| a \\| b | `one|two` |');return root.querySelectorAll('tbody td').length===2&&root.querySelector('tbody td').textContent==='a | b';}));
  check('代码中有三反引号仍保留完整样例',await page.evaluate(async()=>{const {renderMarkdown}=await import('./js/md.js');const root=document.createElement('div');root.innerHTML=renderMarkdown('````json\n{"markdown":"```"}\n````');return root.querySelector('pre code')?.textContent==='{"markdown":"```"}';}));
  await page.evaluate(()=>document.querySelector('.delivery-workspace').scrollTop=0);await page.screenshot({path:`.design-qa/document-preview-${native?'native':'browser'}.png`});
  await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
  check('深色预览纸面使用主题颜色',await page.locator('.delivery-publication').evaluate(el=>{const color=getComputedStyle(el).backgroundColor;return color!=='rgb(255, 255, 255)'&&color!=='rgba(0, 0, 0, 0)';}));
  await page.screenshot({path:`.design-qa/document-dark-${native?'native':'browser'}.png`});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.getByRole('radio',{name:'草稿调试',exact:true}).click();await page.locator('.delivery-outline-item').first().click();await page.locator('.delivery-endpoint').first().getByRole('button',{name:'字段说明',exact:true}).click();
  await page.evaluate(()=>document.querySelector('.delivery-workspace').scrollTop=0);await page.screenshot({path:`.design-qa/document-editor-${native?'native':'browser'}.png`});
  if(!native){for(const width of [1200,1000]){await page.setViewportSize({width,height:800});check(`${width}px 编辑器无横向溢出且目录仍可用`,await page.evaluate(()=>document.querySelector('.delivery-workspace').scrollWidth<=document.querySelector('.delivery-workspace').clientWidth+1)&&await page.getByLabel('查找文档接口').isVisible());await page.getByRole('radio',{name:'交付预览',exact:true}).click();check(`${width}px 预览无横向溢出`,await page.evaluate(()=>document.querySelector('.delivery-workspace').scrollWidth<=document.querySelector('.delivery-workspace').clientWidth+1));await page.getByRole('radio',{name:'草稿调试',exact:true}).click();}await page.setViewportSize({width:1440,height:1000});}
  await page.locator('[data-rail=docs]').click();await page.locator('.section-overview').click();check('文档库卡片显示版本与完成数',await page.locator('.document-library-card').innerText().then(text=>text.includes('v2.5.0')&&text.includes('1 可交付')));await page.waitForTimeout(300);await page.screenshot({path:`.design-qa/document-library-${native?'native':'browser'}.png`});
  await page.locator('.document-library-card').click();check('文档库可重新打开已有草稿',await page.getByLabel('文档版本').inputValue()==='2.5.0');
  if(native){await page.evaluate(()=>Promise.all(['docs','tabs','settings','collections','environments'].map(domain=>s.flushDomain(domain))));await page.reload();await page.waitForSelector('.delivery-workspace');check('重载保留版本和字段规则',await page.evaluate(async()=>{const {state}=await import('./js/state.js');const doc=state.docs.find(d=>d.name==='项目协作 API');return doc.version==='2.5.0'&&doc.blocks[1].contract.fields['params:workspaceId'].required===true&&doc.blocks[1].contract.fields['params:page'].required===false;}));}
  check('整轮编写与阅读无 JS 异常',!errors.length,errors);
  fs.writeFileSync(`.design-qa/document-design-${native?'native':'browser'}-results.json`,JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}
 if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1);});
