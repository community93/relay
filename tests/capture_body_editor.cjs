const {chromium}=require('./playwright');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:920}}),errors=[],results=[];
 const out='reports/body-editor-0.1.11';fs.mkdirSync(out,{recursive:true});
 page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto('http://127.0.0.1:8765');await page.waitForSelector('.url-input');
  await page.evaluate(async()=>{
   window.s=await import('./js/state.js');window.colors=await import('./js/themes.js');window.cm=await import('./js/vendor/editor-core.js');
   s.state.tabs=[];window.tab=s.newTab();tab.view='body';tab.draft.method='POST';tab.draft.name='创建项目';tab.draft.url='{{baseUrl}}/v1/projects';tab.draft.body=s.newBody('raw');
   const env=s.newEnvironment('Development');env.variables=[s.kv('baseUrl','https://api.example.com'),s.kv('projectId','prj_42')];s.state.environments=[env];s.state.settings.activeEnvironmentId=env.id;
   tab.draft.body.raw.content=JSON.stringify({name:'Relay',projectId:'{{projectId}}',createdAt:'{{$isoTimestamp}}',active:true,limit:20,metadata:null,tags:['API','Delivery']},null,2);s.emit('rerender');s.emit('environment');
  });
  for(const palette of await page.evaluate(()=>colors.THEMES.map(t=>t.id)))for(const theme of ['light','dark']){
   await page.evaluate(({palette,theme})=>colors.applyAppearance({palette,theme}),{palette,theme});await page.waitForTimeout(120);
   const detail=await page.locator('.body-editor').evaluate(panel=>{
    const editor=panel.querySelector('.cm-editor'),r=panel.getBoundingClientRect(),host=document.getElementById('request-host').getBoundingClientRect();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
    function rgb(color,base){ctx.clearRect(0,0,1,1);if(base){ctx.fillStyle=base;ctx.fillRect(0,0,1,1);}ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);}
    function luminance(values){return values.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);}
    const bg=getComputedStyle(editor).backgroundColor,active=getComputedStyle(panel.querySelector('.cm-activeLine')).backgroundColor;
    const surfaces=[luminance(rgb(bg)),luminance(rgb(active,bg))];
    const contrasts=[...new Set([...panel.querySelectorAll('.cm-content .cm-line > span')].map(el=>getComputedStyle(el).color))].map(color=>({color,ratio:Math.min(...surfaces.map(surface=>{const l=luminance(rgb(color));return (Math.max(surface,l)+.05)/(Math.min(surface,l)+.05);}))}));
    return {font:getComputedStyle(panel.querySelector('.cm-scroller')).fontSize,inside:r.bottom<=host.bottom+1,overflow:document.documentElement.scrollWidth>innerWidth+1,contrasts};
   });
   const ok=detail.inside&&!detail.overflow&&detail.font==='13px'&&detail.contrasts.every(c=>c.ratio>=4.5);
   results.push({name:`${palette}-${theme}`,ok,detail});console.log(`${ok?'PASS':'FAIL'} ${palette}-${theme} ${JSON.stringify(detail)}`);
   await page.screenshot({path:`${out}/${palette}-${theme}.png`});
  }
  await page.evaluate(()=>colors.applyAppearance({palette:'sky',theme:'light'}));
  await page.getByRole('button',{name:'展开',exact:true}).click();await page.waitForTimeout(200);await page.screenshot({path:`${out}/expanded.png`});await page.keyboard.press('Escape');await page.waitForTimeout(220);
  await page.setViewportSize({width:1000,height:640});await page.waitForTimeout(200);await page.screenshot({path:`${out}/small.png`});
  results.push({name:'no-errors',ok:errors.length===0,detail:errors});
  fs.writeFileSync(`${out}/visual-results.json`,JSON.stringify({results,errors},null,2));console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);
  if(results.some(r=>!r.ok))process.exitCode=1;
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
