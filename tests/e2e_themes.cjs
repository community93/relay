const {chromium}=require('./playwright.cjs');
const fs=require('node:fs'),path=require('node:path'),results=[];
const check=(name,ok,detail)=>{results.push({name,ok:!!ok,detail});console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':' '+JSON.stringify(detail)}`);};
(async()=>{
 const browser=await chromium.connectOverCDP(process.env.RELAY_CDP_URL),page=browser.contexts()[0].pages()[0],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const setup=()=>page.evaluate(async()=>{window.s=await import('./js/state.js');window.appearance=await import('./js/themes.js');window.tools=await import('./js/tools.js');});
 try{
  await page.waitForSelector('.rail-btn');await setup();
  const data=await page.evaluate(async()=>(await import('./js/api.js')).dataPath());if(path.resolve(data).toLowerCase()!==path.resolve('.design-qa/native-data').toLowerCase())throw Error('Requires isolated native-data');
  await page.evaluate(()=>{s.state.settings.palette='mint';s.state.settings.theme='light';appearance.applyAppearance();tools.openSettingsDialog();});
  const palettes=await page.evaluate(()=>appearance.THEMES.map(t=>t.id));
  check('设置完整展示已注册的配色预览',await page.locator('.theme-card').count()===palettes.length&&await page.locator('.theme-preview').count()===palettes.length);
  await page.getByRole('radio',{name:'晴空',exact:true}).click();
  check('配色点击立即预览且未改动已保存设置',await page.evaluate(()=>document.documentElement.dataset.palette==='sky'&&s.state.settings.palette==='mint'));
  await page.keyboard.press('ArrowRight');check('键盘选择同步唯一选中项',await page.locator('.theme-card[aria-checked=true]').getAttribute('data-palette')==='iris'&&await page.locator('.theme-card[aria-checked=true]').count()===1);
  await page.keyboard.press('Escape');await page.waitForTimeout(200);check('取消设置恢复已保存的主题',await page.evaluate(()=>document.documentElement.dataset.palette==='mint'));
  for(const palette of palettes)for(const mode of ['light','dark']){
   await page.evaluate(({palette,mode})=>{s.state.settings.palette=palette;s.state.settings.theme=mode;appearance.applyAppearance();s.activeTab().response={status:200,statusText:'OK',bodyText:'{"message":"主题检查","success":true}',headers:[],contentType:'application/json',isText:true,timeMs:12,sizeBytes:48};s.emit('rerender');},{palette,mode});
   const contrast=await page.evaluate(()=>{
    const style=getComputedStyle(document.documentElement),rgb=color=>{const n=color.match(/\d+(?:\.\d+)?/g).map(Number);return n.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;});},l=color=>{const c=rgb(color);return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
    const probe=document.createElement('span');document.body.append(probe);const resolve=token=>{probe.style.color=style.getPropertyValue(token);return getComputedStyle(probe).color;};
    const pairs=[];for(const text of ['--text','--text-dim','--text-faint','--current-ink','--m-get','--m-post','--m-put','--m-patch','--m-delete','--m-other'])for(const bg of ['--bg','--bg-panel','--sheet','--bg-hover']){const a=l(resolve(text)),b=l(resolve(bg));pairs.push({text,bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});}
    for(const [text,bg] of [['--on-accent','--accent'],['--current-ink','--current-soft']]){const a=l(resolve(text)),b=l(resolve(bg));pairs.push({text,bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});}probe.remove();return pairs.filter(p=>p.ratio<4.5);
   });
   check(`${palette}/${mode} 文字、方法、主按钮对比度 AA`,!contrast.length,contrast);
   for(const pane of ['collections','runner','docs','environments']){await page.locator(`[data-rail=${pane}]`).click();check(`${palette}/${mode} ${pane} 共用主题无横向溢出`,await page.evaluate(()=>document.querySelector('.main-area').scrollWidth<=document.querySelector('.main-area').clientWidth+1));}
   await page.evaluate(()=>{s.state.overviewPane=null;s.emit('rerender');tools.openSettingsDialog();});
   check(`${palette}/${mode} 设置主题卡片无裁切`,await page.locator('.theme-grid').evaluate(grid=>grid.scrollWidth<=grid.clientWidth+1&&[...grid.querySelectorAll('.theme-card')].every(card=>card.getBoundingClientRect().height>90)));
   await page.waitForTimeout(220);await page.screenshot({path:`.design-qa/theme-${palette}-${mode}.png`});await page.keyboard.press('Escape');await page.waitForTimeout(190);
  }
  await page.evaluate(()=>tools.openSettingsDialog());await page.getByRole('radio',{name:'桃杏',exact:true}).click();await page.getByRole('radio',{name:'浅色',exact:true}).click();await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.waitForTimeout(220);
  check('保存主题立即落盘',await page.evaluate(async()=>{const api=await import('./js/api.js'),settings=JSON.parse(await api.loadDoc('settings'));return settings.palette==='peach'&&settings.theme==='light';}));
  await page.reload();await page.waitForSelector('.rail-btn');await setup();check('重载保留已选配色及深浅模式',await page.evaluate(()=>document.documentElement.dataset.palette==='peach'&&document.documentElement.dataset.theme==='light'));
  await page.locator('[title="切换主题"]').click();await page.locator('.menu-item').filter({hasText:'奶油'}).click();check('顶栏快捷入口选择配色',await page.evaluate(()=>s.state.settings.palette==='cream'&&document.documentElement.dataset.palette==='cream'));
  await page.keyboard.press('Control+/');await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');check('Ctrl / 切换深浅色保留配色',await page.evaluate(()=>document.documentElement.dataset.theme==='dark'&&document.documentElement.dataset.palette==='cream'));
  await page.evaluate(()=>{appearance.applyAppearance({palette:'missing',theme:'missing'});});check('无效主题安全回退',await page.evaluate(()=>document.documentElement.dataset.theme==='light'&&document.documentElement.dataset.palette==='mint'));
  check('主题检查无 JavaScript 异常',!errors.length,errors);fs.writeFileSync('.design-qa/themes-results.json',JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
 }finally{await browser.close();}if(results.some(r=>!r.ok))process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
