// Regression for clipped CJK labels across themes, window sizes and UI zoom.
const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path'),rows=[];
const check=(name,ok,detail)=>{rows.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.waitForSelector('.rail-btn');
  const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());
  if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');
  await page.evaluate(async()=>{window.s=await import('./js/state.js');window.a=await import('./js/app.js');s.state.settings.activeEnvironmentId=null;s.state.tabs=[];const tab=s.newTab('ws');tab.draft.name='WebSocket 连接';s.emit('environment');s.emit('rerender');});
  for(const scenario of [{width:1440,zoom:1},{width:1000,zoom:1},{width:1440,zoom:1.4},{width:1000,zoom:1.4}]){
   await page.setViewportSize({width:scenario.width,height:920});
   for(const theme of ['light','dark']){
    await page.evaluate(({zoom,theme})=>{document.documentElement.dataset.theme=theme;s.state.settings.uiZoom=zoom;a.applyUiZoom();a.renderTabs();},{...scenario,theme});
    await page.waitForTimeout(120);
    const geometry=await page.evaluate(()=>{
     const bounds=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
     const label=document.querySelector('.env-switcher-label'),style=getComputedStyle(label);
     const titles=[...document.querySelectorAll('.topbar button')].filter(n=>n.getBoundingClientRect().width>0).map(n=>({title:n.title,...bounds(n)}));
     return {env:{height:label.getBoundingClientRect().height,font:parseFloat(style.fontSize),scroll:label.scrollWidth,width:label.clientWidth},zoom:Number(s.state.settings.uiZoom),app:bounds(document.querySelector('.app')),status:bounds(document.querySelector('.statusbar')),strip:bounds(document.querySelector('.tabstrip')),active:bounds(document.querySelector('.tab.active')),actions:bounds([...document.querySelectorAll('.tab-actions button')].find(n=>n.getBoundingClientRect().width>0)),buttons:titles,width:innerWidth,height:innerHeight};
    });
    const tag=`${scenario.width}px / ${scenario.zoom} / ${theme}`;
    check(`${tag} 环境文字无裁切`,geometry.env.scroll<=geometry.env.width+1&&geometry.env.height>=geometry.env.font*scenario.zoom*1.4,geometry.env);
    check(`${tag} 顶栏操作及当前标签无覆盖`,geometry.buttons.every(b=>b.left>=0&&b.right<=geometry.width+1)&&geometry.active.left>=geometry.strip.left-1&&geometry.active.right<=geometry.actions.left+1,geometry);
    check(`${tag} 状态栏完整保留在窗口内`,geometry.status.bottom<=geometry.height+1,geometry);
    await page.screenshot({path:`.design-qa/typography-${scenario.width}-${scenario.zoom}-${theme}.png`});
   }
  }
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';s.state.settings.uiZoom=1;a.applyUiZoom();});await page.setViewportSize({width:1440,height:920});
  for(const pane of ['collections','runner','docs','environments']){
   await page.locator(`[data-rail=${pane}]`).click();
   const clipped=await page.evaluate(()=>[...document.querySelectorAll('.select-text,.env-switcher-label,.menu-label,.tab .label')].filter(n=>{const r=n.getBoundingClientRect();if(!r.width||!r.height)return false;return parseFloat(getComputedStyle(n).lineHeight)<parseFloat(getComputedStyle(n).fontSize)*1.4;}).map(n=>n.className));
   check(`${pane} 页面共享控件有足够文字行高`,!clipped.length,clipped);
  }
  check('全局文字检查无 JavaScript 异常',!errors.length,errors);
  fs.writeFileSync('.design-qa/typography-native-results.json',JSON.stringify({rows,errors},null,2));console.log(`${rows.filter(r=>r.ok).length}/${rows.length} passed`);
 }finally{await browser.close();}
 if(rows.some(r=>!r.ok))process.exitCode=1;
})().catch(error=>{console.error(error);process.exit(1);});
