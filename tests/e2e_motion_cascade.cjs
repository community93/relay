const {chromium}=require('./playwright');
const fs=require('node:fs'),path=require('node:path');
const rows=[],check=(name,ok,detail)=>{rows.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.waitForSelector('.rail-btn');
  const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());
  if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native data');
  await page.evaluate(async()=>{window.s=await import('./js/state.js');window.ui=await import('./js/ui.js');window.m=await import('./js/menu.js');window.colors=await import('./js/themes.js');window.app=await import('./js/app.js');s.state.tabs=[];s.state.overviewPane=null;window.first=s.newTab('http');first.draft.url='https://example.invalid';s.emit('rerender');});
  const loaded=await page.evaluate(()=>[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules].filter(rule=>rule.type===CSSRule.KEYFRAMES_RULE).map(rule=>({file:sheet.href.split('/').at(-1),name:rule.name}))));
  for(const name of ['materialize','present','dismiss','selection-arrive'])check(`动效 ${name} 在加载后的样式中只有一个定义`,loaded.filter(rule=>rule.name===name).length===1&&loaded.find(rule=>rule.name===name)?.file==='interaction.css');
  check('无遗留的未使用动效',!loaded.some(rule=>['nav-materialize','ws-present','ws-dismiss'].includes(rule.name)));
  await page.emulateMedia({reducedMotion:'no-preference'});
  const menuMotion=await page.evaluate(()=>{const trigger=document.querySelector('.topbar-import');m.menu(trigger,[{label:'检查菜单',onSelect:()=>{}}]);const menu=document.querySelector('.menu');const animation=menu.getAnimations().find(a=>a.animationName==='materialize');animation?.pause();return {name:getComputedStyle(menu).animationName,frames:animation?.effect.getKeyframes(),duration:animation?.effect.getTiming().duration};});
  check('真实菜单使用短距离的单一入场动画',menuMotion.name==='materialize'&&menuMotion.duration===140&&menuMotion.frames?.[0].transform==='translateY(-2px) scale(0.99)',menuMotion);
  await page.keyboard.press('Escape');
  const modalMotion=await page.evaluate(()=>{window.dialog=ui.modal({title:'动画检查',body:[ui.el('input',{'aria-label':'编辑检查'})]});const animation=dialog.box.getAnimations().find(a=>a.animationName==='present');animation?.pause();return {name:getComputedStyle(dialog.box).animationName,frames:animation?.effect.getKeyframes(),duration:animation?.effect.getTiming().duration};});
  check('真实弹窗使用 180ms 的轻量入场',modalMotion.name==='present'&&modalMotion.duration===180&&modalMotion.frames?.[0].transform==='translateY(6px) scale(0.995)',modalMotion);
  await page.locator('.modal').getByRole('button',{name:'关闭',exact:true}).click();
  const closeMotion=await page.evaluate(()=>{const box=document.querySelector('.overlay.closing .modal');const animation=box?.getAnimations().find(a=>a.animationName==='dismiss');animation?.pause();return {name:animation?.animationName,frames:animation?.effect.getKeyframes()};});
  check('弹窗关闭与入场方向一致',closeMotion.name==='dismiss'&&closeMotion.frames?.at(-1).transform==='translateY(4px)',closeMotion);
  await page.waitForFunction(()=>!document.querySelector('.overlay'));
  const indicator=await page.evaluate(()=>getComputedStyle(document.querySelector('.tab.active'),'::after').animationName);
  check('标签选择只有淡入反馈',indicator==='selection-arrive',indicator);
  for(const palette of await page.evaluate(()=>colors.THEMES.map(t=>t.id)))for(const theme of ['light','dark']){
   await page.evaluate(({palette,theme})=>{s.state.settings.theme=theme;s.state.settings.palette=palette;colors.applyAppearance();},{palette,theme});
   const button=page.locator('.urlbar > .btn.primary');await button.hover();await page.waitForTimeout(250);
   check(`${palette}/${theme} 主按钮悬停没有发光`,await button.evaluate(node=>getComputedStyle(node).boxShadow==='none'));
   await button.focus();check(`${palette}/${theme} 键盘焦点仍可辨识`,await button.evaluate(node=>parseFloat(getComputedStyle(node).outlineWidth)>=2));
  }
  await page.evaluate(()=>{for(let i=0;i<18;i++){const tab=s.newTab('http');tab.draft.name='长请求标签 '+i;}s.activateTab(first.id);s.emit('rerender');});
  for(const [width,zoom] of [[1440,1],[1000,1],[1000,1.4],[1440,2]]){
   await page.setViewportSize({width,height:width===1000?640:920});await page.evaluate(zoom=>{s.state.settings.uiZoom=zoom;app.applyUiZoom();},zoom);await page.waitForTimeout(250);
   await page.locator('.tab.active').scrollIntoViewIfNeeded();
   const geometry=await page.evaluate(()=>{const strip=document.querySelector('.tabstrip'),tab=document.querySelector('.tab.active'),sr=strip.getBoundingClientRect(),tr=tab.getBoundingClientRect(),pseudo=getComputedStyle(tab,'::after');return {verticalOverflow:strip.scrollHeight-strip.clientHeight,horizontalOverflow:strip.scrollWidth-strip.clientWidth,insideBottom:tr.bottom-parseFloat(pseudo.bottom)<=sr.bottom+0.1,bottom:pseudo.bottom};});
   check(`${width}/${zoom} 多标签横向滚动且指示条完整显示`,geometry.verticalOverflow===0&&geometry.horizontalOverflow>0&&geometry.insideBottom,geometry);
   if(zoom===1){await page.locator('.tab').last().scrollIntoViewIfNeeded();const pos=await page.locator('.tabstrip').evaluate(n=>n.scrollLeft);check(`${width}px 可滚动到最后一个标签`,pos>0,pos);}
  }
  await page.setViewportSize({width:1440,height:920});await page.evaluate(()=>{s.state.settings.uiZoom=1;app.applyUiZoom();s.activateTab(first.id);});
  await page.waitForFunction(()=>!document.getAnimations().some(a=>a.playState==='running'));await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{window.dialog=ui.modal({title:'减少动态效果',body:[ui.el('input')]});});await page.waitForTimeout(60);
  check('减少动态效果时弹窗不持续播放动画',await page.evaluate(()=>!document.querySelector('.modal').getAnimations().some(a=>a.playState==='running')));
  await page.evaluate(()=>dialog.close());await page.waitForTimeout(200);await page.emulateMedia({reducedMotion:'no-preference'});
  const config=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'));
  check('界面版本与安装包配置一致',await page.locator('.navigation-footer-version').innerText()==='v'+config.version);
  check('无 JavaScript 异常',errors.length===0,errors);
 }finally{await browser.close();}
 fs.writeFileSync('.design-qa/motion-cascade-results.json',JSON.stringify({rows,errors},null,2));console.log(`${rows.filter(row=>row.ok).length}/${rows.length} passed`);if(rows.some(row=>!row.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1)});
