const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path'),rows=[];
const check=(name,ok,detail)=>{rows.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);};
(async()=>{
 const native=!!process.env.RELAY_CDP_URL;
 const browser=native?await chromium.connectOverCDP(process.env.RELAY_CDP_URL):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=native?browser.contexts()[0].pages()[0]:await browser.newPage({viewport:{width:1440,height:920}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  if(!native)await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.rail-btn');
  if(native){const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');}
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');window.a=await import('./js/app.js');window.t=await import('./js/themes.js');window.d=await import('./js/doc.js');
   s.state.overviewPane=null;s.state.tabs=[];s.state.collections=[];s.state.runners=[];s.state.environments=[];s.state.docs=[];
   window.col=s.newCollection('服务');window.req=s.newRequestNode('创建项目',{method:'POST',url:'https://api.example.invalid/projects/'+ 'long-path/'.repeat(80)});col.children=[req];s.state.collections.push(col);
   window.plan=s.newRunner('校验');plan.sources=[req.id,col.id];s.state.runners.push(plan);
   window.doc=s.newDoc('交付文档');doc.overview='第一行\n第二行\n第三行';const b=s.newReqBlock("curl 'https://example.invalid/projects'");b.draft=s.newRequestDraft({url:'https://example.invalid/projects'});b.parsedCurl=b.curl;b.auth={kind:'noauth'};doc.blocks.push(b);s.state.docs.push(doc);s.emit('tree');s.openRunner(plan);
  });
  check('执行步骤直接识别方法与地址',await page.locator('.plan-step').first().innerText().then(t=>t.includes('POST')&&t.includes('https://api.example.invalid/projects')));
  check('执行步骤长地址有截断且保留完整提示',await page.locator('.plan-path').first().evaluate(n=>n.scrollWidth>n.clientWidth&&getComputedStyle(n).textOverflow==='ellipsis'&&n.title===n.textContent));
  check('集合执行仍显示集合类型与请求数',await page.locator('.plan-step').nth(1).innerText().then(t=>t.includes('集合')&&t.includes('1 个请求')));
  await page.locator('.plan-step').first().locator('.reorder-handle').focus();await page.keyboard.press('Alt+ArrowDown');
  check('显示方法和地址后键盘排序仍保持来源顺序',await page.evaluate(()=>plan.sources[0]===col.id&&plan.sources[1]===req.id));
  await page.evaluate(()=>s.openRequest(req));
  check('空响应使用清晰中文操作',await page.locator('.response').getByRole('button',{name:'发送请求',exact:true}).isVisible());
  check('请求和文档标题具有可辨识层级',await page.locator('.req-title').evaluate(n=>parseFloat(getComputedStyle(n).fontSize)>=22));
  await page.evaluate(()=>s.openDoc(doc));await page.waitForTimeout(150);
  check('多行概述连同边框完整显示',await page.getByLabel('交付概述').evaluate(n=>n.scrollHeight<=n.clientHeight+1));
  check('概述输入有可见的编辑焦点',await page.getByLabel('交付概述').evaluate(n=>{n.focus();return getComputedStyle(n).borderTopStyle==='solid'&&getComputedStyle(n).borderTopColor!==getComputedStyle(n).backgroundColor;}));
  check('接口草稿添加入口可键盘展开',await page.locator('.delivery-composer-heading').evaluate(n=>{n.focus();return document.activeElement===n;}));await page.keyboard.press('Enter');
  check('展开后接口草稿可编辑',await page.getByLabel('接口草稿').isVisible());
  for(const palette of await page.evaluate(()=>t.THEMES.map(theme=>theme.id)))for(const theme of ['light','dark']){
   await page.evaluate(({palette,theme})=>{s.state.settings.palette=palette;s.state.settings.theme=theme;t.applyAppearance();},{palette,theme});
   const ratios=await page.evaluate(()=>{
    const style=getComputedStyle(document.documentElement),probe=document.createElement('span');document.body.append(probe);
    const rgb=token=>{probe.style.color=style.getPropertyValue(token);return getComputedStyle(probe).color.match(/[\d.]+/g).slice(0,3).map(Number);};
    const lum=values=>values.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    const rows=[];for(const ink of ['--text','--text-dim','--text-faint','--current-ink'])for(const bg of ['--sheet','--bg-panel','--bg-inset','--current-soft']){const x=lum(rgb(ink)),y=lum(rgb(bg));rows.push({ink,bg,ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)});}probe.remove();return rows;
   });check(`${palette}/${theme} 基础文字对比度达4.5`,ratios.every(r=>r.ratio>=4.5),ratios.filter(r=>r.ratio<4.5));
  }
  for(const [width,height,zoom] of [[1440,920,1],[1000,640,1],[1440,920,1.4],[1440,920,2]]){
   await page.setViewportSize({width,height});await page.evaluate(zoom=>{s.state.settings.uiZoom=zoom;a.applyUiZoom();},zoom);
   for(const [name,kind] of [['request','request'],['runner','runner'],['doc','doc']]){
    await page.evaluate(kind=>kind==='request'?s.openRequest(req):kind==='runner'?s.openRunner(plan):s.openDoc(doc),kind);await page.waitForTimeout(80);
    const g=await page.evaluate(()=>{const host=document.querySelector('#request-host'),bar=document.querySelector('.statusbar').getBoundingClientRect();return {overflow:host.scrollWidth-host.clientWidth,bottom:bar.bottom,height:innerHeight};});
    check(`${width}/${zoom} ${name} 无页面溢出且保留状态栏`,g.overflow<=2&&g.bottom<=g.height+1,g);
   }
  }
  check('视觉回归无 JS 异常',!errors.length,errors);
 }finally{await browser.close();}
 fs.writeFileSync(`.design-qa/visual-craft-${native?'native':'browser'}-results.json`,JSON.stringify({rows,errors},null,2));
 console.log(`${rows.filter(r=>r.ok).length}/${rows.length} passed`);if(rows.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1)});
