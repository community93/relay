import { el, icon, toast, copy, saveAs, modal, filePicker, segmented } from './ui.js';
import { contractOf, captureVerification, endpointFields, endpointStatus, reviewIssues, deliveryMarkdown, deliveryOpenApi, fingerprint, clone } from './delivery.js';
import { openRequestPreview, requestSnapshot, requestCurl } from './preview.js';
import { menu, selectField } from './menu.js';
import { inferProtocol } from './protocol.js';
import { evaluateChecks } from './checks.js';
import { renderCheckResults } from './check-editor.js';
import { reorderHandle } from './reorder.js';
import { changeList } from './undo.js';
import { publicationMarkup, PUBLICATION_CSS } from './publication.js';
import { renderMarkdown, highlightMarkdown, extractCurl } from './md.js';
import {
  state,
  touch,
  uid,
  emit,
  newDoc,
  newReqBlock,
  openDoc,
  newTab,
  newRequestDraft,
  buildSendDraft,
  pushHistory,
  activeTab,
  findNode,
  openRequest,
  newRequestNode,
  newCollection,
  on,
  saveState,
  flushDomain,
  syncParamsFromUrl,
} from './state.js';
import * as api from './api.js';
import { enterSurface } from './interaction.js';
import { sortableRow } from './sorting.js';

const MAX_PREVIEW = 20000;
const endpointViews=new WeakMap();
const docViews = new WeakMap();
function editorView(doc) { if (!docViews.has(doc)) docViews.set(doc, { all: false }); return docViews.get(doc); }
function selectDocBlock(doc, id) {
  doc.activeBlockId = id;
  document.querySelectorAll('.delivery-body .doc-block').forEach(node => node.classList.toggle('is-collapsed', !editorView(doc).all && node.dataset.block !== id));
  document.querySelector('.delivery-outline')?.refresh?.();
}

function selectControl(label,options,value,onChange) {
  const control=selectField({options,value,onChange});control.setAttribute('aria-label',label);return control;
}

function focusIssue(doc,block,issue) {
  block.view=/字段|必填/.test(issue)?'fields':/样例|验证/.test(issue)?'response':'notes';
  doc.activeBlockId=block.id;save(doc);repaint();
  requestAnimationFrame(()=>{
    const card=document.querySelector(`[data-block="${block.id}"]`);
    card?.scrollIntoView({block:'start',behavior:'auto'});
    const target=issue==='接口名称'?card?.querySelector('[aria-label="接口名称"]'):
      issue==='业务说明'?card?.querySelector('[aria-label="接口业务说明"]'):
      issue.includes('必填')?card?.querySelector('.delivery-field-row .select[data-value="unknown"]'):
      issue.includes('字段')?[...card?.querySelectorAll('.delivery-field-row input') || []].find(input=>!input.value.trim()):null;
    target?.focus({preventScroll:true});
  });
}

function issueSummary(doc,block,host) {
  const issues=reviewIssues(block);
  host.replaceChildren(...(issues.length?issues.map(issue=>el('button',{class:'delivery-issue',text:issue,title:`补充${issue}`,onclick:()=>focusIssue(doc,block,issue)})):[el('span',{text:'说明已完善'})]));
}

function syncLinked(doc) {
  for(const block of doc.blocks.filter(b=>b.type==='req')) {
    const node=block.sourceId?findNode(block.sourceId)?.node:null;
    block.sourceMissing=!!block.sourceId&&!node;
    const tab=state.tabs.find(t=>t.kind==='request'&&(node&&t.refId===node.id || t.docBinding?.docId===doc.id&&t.docBinding.blockId===block.id));
    if(!node&&!tab)continue;
    const draft=tab?.draft || node.request,auth=tab?.auth || node.auth;
    if(fingerprint(draft,auth)!==fingerprint(block.draft,block.auth)) {
      block.draft=clone(draft);block.auth=clone(auth);contractOf(block).reviewed=false;
      save(doc);
    }
  }
}

async function addDraft(doc, area) {
  const text=area.value.trim();if(!text)return;
  const curl=extractCurl(text);
  if(curl) {
    try {
      const parsed=await api.parseCurl(curl);
      if(!parsed.length || parsed.some(item=>!item.draft?.url))throw new Error('部分 cURL 无法解析，请检查命令');
      for(const item of parsed) {
        const block=newReqBlock(item.source || curl);block.draft=item.draft;
        if(!block.draft.params?.length&&block.draft.url.includes('?'))syncParamsFromUrl(block);
        block.parsedCurl=block.curl;block.auth={kind:'noauth'};block.contract={summary:item.draft.name || '',description:'',fields:{},reviewed:false};doc.blocks.push(block);doc.activeBlockId=block.id;
      }
    } catch(error) {toast(String(error.message || error),'err');return;}
  } else doc.blocks.push({id:uid('blk'),type:'text',text});
  doc.pendingDraft='';save(doc);repaint();
}

function pickCollectionRequest(doc) {
  const options=[];
  const walk=(nodes,trail=[])=>{for(const node of nodes){if(node.children)walk(node.children,trail.concat(node.name));else if((node.protocol||'http')==='http')options.push({node,trail});}};
  walk(state.collections);
  const search=el('input',{class:'input',placeholder:'搜索请求…','aria-label':'搜索可关联请求'}),list=el('div',{class:'delivery-request-list'});
  const draw=()=>list.replaceChildren(...options.filter(({node,trail})=>`${node.name} ${trail.join(' ')} ${node.request.url}`.toLowerCase().includes(search.value.toLowerCase())).map(({node,trail})=>el('button',{class:'delivery-request-option',onclick:()=>{linkRequest(doc,node);dialog.close();repaint();}},[el('span',{class:'badge',text:node.request.method}),el('div',{},[el('strong',{text:node.name}),el('span',{text:trail.join(' / ')})])])));
  search.addEventListener('input',draw);draw();
  const dialog=modal({title:'关联集合请求',width:650,body:[search,options.length?list:el('p',{class:'hint',text:'集合中暂无 HTTP 请求'})],cancelText:''});
}

function linkRequest(doc,node,tab) {
  let block=doc.blocks.find(b=>b.type==='req'&&b.sourceId===node.id);
  if(!block){block=newReqBlock('');doc.blocks.push(block);}
  block.sourceId=node.id;block.draft=clone(tab?.draft || node.request);block.auth=clone(tab?.auth || node.auth || {kind:'noauth'});
  contractOf(block);doc.activeBlockId=block.id;
  if(tab?.response&&tab.lastRequestSnapshot)captureVerification(block,tab.lastRequestSnapshot.template || {draft:block.draft,auth:block.auth},tab.lastRequestSnapshot,tab.response);
  save(doc);return block;
}

export function addRequestToDocument(tab) {
  if(tab.protocol!=='http')return toast('交付文档目前支持 HTTP 接口','err');
  const docs=[...state.docs];
  const linked=doc=>doc.blocks.find(block=>block.type==='req'&&(tab.refId?block.sourceId===tab.refId:tab.docBinding?.docId===doc.id&&block.id===tab.docBinding.blockId));
  let selected=docs.find(doc=>tab.docBinding?.docId===doc.id)?.id||docs[0]?.id,mode=docs.length?'existing':'new',box;
  const nameId=uid('doc-name'),errorId=uid('doc-error');
  const error=el('span',{class:'document-attach-error',id:errorId,hidden:true,text:'请输入文档名称',role:'alert'});
  const name=el('input',{class:'input',id:nameId,value:'接口交付文档','aria-label':'新文档名称','aria-describedby':errorId,dataset:{variables:'false'},oninput:()=>{error.hidden=true;name.removeAttribute('aria-invalid');},onkeydown:event=>{if(event.key==='Enter'&&!event.isComposing){event.preventDefault();box?.querySelector('.modal-foot .primary').click();}}});
  const search=el('input',{class:'input',placeholder:'搜索文档','aria-label':'搜索交付文档',dataset:{variables:'false'}});
  const list=el('div',{class:'document-attach-list',role:'radiogroup','aria-label':'选择交付文档'});
  const panel=el('div',{class:'document-attach-panel'});
  const action=()=>{const button=box?.querySelector('.modal-foot .primary');if(button){button.disabled=mode==='existing'&&!docs.some(doc=>doc.id===selected);button.textContent=mode==='new'?'创建并加入':linked(docs.find(doc=>doc.id===selected)||{blocks:[]})?'更新并打开':'加入文档';}};
  const draw=()=>{
    const visible=docs.filter(doc=>doc.name.toLowerCase().includes(search.value.trim().toLowerCase()));
    list.replaceChildren(...visible.map(doc=>el('button',{type:'button',class:`document-attach-option ${doc.id===selected?'selected':''}`,role:'radio','aria-checked':String(doc.id===selected),tabindex:doc.id===(visible.find(item=>item.id===selected)?.id||visible[0]?.id)?0:-1,dataset:{docId:doc.id},onclick:()=>{selected=doc.id;draw();action();list.querySelector('[aria-checked="true"]')?.focus({preventScroll:true});}},[
      el('span',{class:'document-attach-icon','aria-hidden':'true'},[icon('file')]),
      el('span',{class:'document-attach-option-copy'},[el('strong',{text:doc.name||'未命名文档'}),el('span',{text:`${doc.blocks.filter(block=>block.type==='req').length} 个接口 · v${doc.version||'1.0.0'}`})]),
      linked(doc)?el('span',{class:'document-attach-linked',text:'已收录'}):null,
      el('span',{class:'document-attach-check','aria-hidden':'true'},doc.id===selected?[icon('check')]:[]),
    ])));
    if(!visible.length)list.append(el('div',{class:'document-attach-empty'},[icon('search'),el('span',{text:docs.length?'没有匹配的文档':'暂无文档'}),el('button',{class:'btn sm ghost',text:'新建文档',onclick:()=>tabs.querySelector('[role="radio"]:last-child').click()})]));
  };
  list.addEventListener('keydown',event=>{
    const rows=[...list.querySelectorAll('[role="radio"]')],at=rows.indexOf(document.activeElement);
    if(!rows.length||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    rows[event.key==='Home'?0:event.key==='End'?rows.length-1:(at+(event.key==='ArrowDown'?1:-1)+rows.length)%rows.length].click();
  });
  search.addEventListener('input',draw);
  const show=()=>{
    panel.replaceChildren(...(mode==='new'?[el('label',{class:'document-attach-label',for:nameId,text:'文档名称'}),name,error]:[el('div',{class:'document-attach-search'},[icon('search'),search]),list]));
    if(mode==='existing')draw();action();
  };
  const tabs=segmented([['existing','已有文档'],['new','新建文档']],mode,value=>{mode=value;show();});tabs.classList.add('document-attach-tabs');tabs.setAttribute('aria-label','文档目标');
  const summary=el('div',{class:'document-attach-request'},[
    el('span',{class:`badge method-${(tab.draft.method||'GET').toLowerCase()}`,text:tab.draft.method||'GET'}),
    el('div',{},[el('strong',{text:tab.draft.name||tab.title||'未命名请求'}),el('code',{text:tab.draft.url||'未填写 URL',title:tab.draft.url||''})]),
  ]);
  show();
  modal({title:'加入交付文档',width:560,body:[summary,tabs,panel],footer:[el('span',{class:'document-attach-footnote',text:tab.response&&tab.lastRequestSnapshot?'请求配置 · 响应样例':'请求配置'})],okText:'加入文档',onMount:dialog=>{box=dialog.box;box.classList.add('document-attach-modal');const heading=box.querySelector('.modal-head h2');heading.prepend(el('span',{class:'document-attach-heading-icon','aria-hidden':'true'},[icon('file')]));action();},onOk:()=>{
    let doc=mode==='existing'?state.docs.find(d=>d.id===selected):null;
    if(mode==='existing'&&!doc)return false;
    if(mode==='new'){
      if(!name.value.trim()){error.hidden=false;name.setAttribute('aria-invalid','true');name.focus();return false;}
      doc=newDoc(name.value.trim());state.docs.push(doc);
    }
    const node=tab.refId?findNode(tab.refId)?.node:null;
    let block;
    if(node)block=linkRequest(doc,node,tab);
    else {
      block=tab.docBinding?.docId===doc.id?doc.blocks.find(b=>b.id===tab.docBinding.blockId):null;
      if(!block){block=newReqBlock(requestCurl(tab.draft));doc.blocks.push(block);}
      block.draft=clone(tab.draft);block.auth=clone(tab.auth);contractOf(block);
      block.parsedCurl=block.curl;
      if(tab.response&&tab.lastRequestSnapshot)captureVerification(block,tab.lastRequestSnapshot.template || tab,tab.lastRequestSnapshot,tab.response);
    }
    tab.docBinding={docId:doc.id,blockId:block.id};doc.activeBlockId=block.id;save(doc);touch('tabs');openDoc(doc);
  }});
}

function endpointCard(doc,block) {
  const contract=contractOf(block),status=endpointStatus(block);
  const card=el('section',{class:`delivery-endpoint ${block.running?'is-running':''}`,'aria-busy':String(!!block.running)});
  const title=el('input',{class:'delivery-endpoint-title',value:contract.summary,placeholder:'接口名称','aria-label':'接口名称',dataset:{variables:'false'},oninput:event=>{contract.summary=event.target.value;contract.reviewed=false;save(doc);}});
  card.append(el('header',{class:'delivery-endpoint-head'},[
    el('span',{class:`badge method-${(block.draft?.method || 'get').toLowerCase()}`,text:block.draft?.method || 'cURL'}),title,
    el('span',{class:`delivery-status ${status.kind}`,text:status.label}),
    el('button',{class:`btn sm ${block.running?'danger':'primary'}`,text:block.running?'取消':'运行验证',onclick:()=>block.running?cancelBlock(doc,block):runBlock(doc,block)}),
    el('button',{class:'btn sm',text:'调试',onclick:()=>openAsRequest(block,doc)}),
  ]));
  card.append(el('div',{class:'delivery-endpoint-path mono',text:block.draft?.url || '未解析请求'}));
  if(block.sourceId)card.append(el('div',{class:`delivery-link ${block.sourceMissing?'missing':''}`},[icon('collections'),el('span',{text:block.sourceMissing?'关联请求已删除；草稿与样例保留':`关联集合 · ${findNode(block.sourceId)?.node.name || ''}`}),block.sourceMissing?null:el('button',{class:'btn sm ghost',text:'打开请求',onclick:()=>openAsRequest(block,doc)})]));
  const panel=el('div',{class:'delivery-endpoint-panel'}),tabs=el('div',{class:'subtabs delivery-tabs'});
  const views=[['request','请求'],['response','响应样例'],['fields','字段说明'],['notes','交付说明']];
  if(block.response?.checkResult && (block.response.checkResult.checks.length || block.response.checkResult.extractions.length))views.push(['checks','检查']);
  const view=block.view || 'request';
  if(endpointViews.get(block)!==view){enterSurface(panel);endpointViews.set(block,view);}
  for(const [key,label] of views)tabs.append(el('button',{class:`subtab ${view===key?'on':''}`,text:label,onclick:()=>{block.view=key;save(doc);repaint();}}));
  card.append(tabs,panel);
  if(view==='checks') {
    panel.append(renderCheckResults(block.response?.checkResult,{secrets:block.lastRequestSnapshot?.secrets || []}));
  } else if(view==='request') {
    if(!block.sourceId)panel.append(el('textarea',{class:'doc-curl mono delivery-curl',value:block.curl||'',rows:4,placeholder:'curl https://…','aria-label':'接口 cURL',dataset:{variables:'false'},oninput:event=>{block.curl=event.target.value;block.parsedCurl=null;contract.reviewed=false;save(doc);},onblur:()=>refreshDraft(block).then(()=>{save(doc);repaint();})}));
    const info=block.draft?`${(block.draft.params||[]).filter(r=>r.enabled!==false&&r.key).length} 参数 · ${(block.draft.headers||[]).filter(r=>r.enabled!==false&&r.key).length} Headers · ${{none:'无 Body',raw:block.draft.body?.raw?.language?.toUpperCase() || 'Text',urlencoded:'URL Encoded',form:'Form Data',binary:'Binary'}[block.draft.body?.mode] || block.draft.body?.mode || '无 Body'}`:'等待解析';
    panel.append(el('div',{class:'delivery-request-meta'},[el('span',{text:info}),block.draft?el('button',{class:'btn sm',text:'请求预览',onclick:()=>openRequestPreview({draft:block.draft,auth:block.auth || {kind:'noauth'},refId:block.sourceId,protocol:'http',lastRequestSnapshot:block.lastRequestSnapshot})}):null]));
    if(block.parseError)panel.append(el('p',{class:'delivery-error',text:block.parseError}));
    if(block.draft?.body?.mode==='raw')panel.append(el('pre',{class:'delivery-code',text:block.draft.body.raw.content || ''}));
  } else if(view==='response') {
    panel.append(responsePanel(block));
    if(block.verified) {
      panel.append(el('div',{class:'delivery-verification',text:`验证样例 · ${block.verified.environment} · ${new Date(block.verified.at).toLocaleString()}`}));
      if(block.response?.error || (block.response?.checkResult ? !block.response.checkResult.ok : block.response?.status>=400))panel.append(el('pre',{class:'delivery-code',text:block.verified.bodyText.slice(0,MAX_PREVIEW)}));
    }
  } else if(view==='fields') {
    const rows=endpointFields(block);
    panel.append(el('div',{class:'delivery-field-notice',text:'字段结构取自请求与响应样例'}));
    if(!rows.length)panel.append(el('p',{class:'hint',text:'运行接口后会生成响应字段'}));
    for(const group of ['Query','Header','Body','Response']) {
      const entries=rows.filter(row=>row.group===group);if(!entries.length)continue;
      const tools=el('div',{class:'delivery-field-tools'},[el('h4',{class:'delivery-field-group',text:group==='Response'?'响应字段':`${group} 字段`}),el('span',{class:'count',text:String(entries.length)})]);
      if(group!=='Response')tools.append(el('button',{class:'btn sm ghost',text:'未确认设为可选',disabled:!entries.some(row=>typeof contract.fields[row.id]?.required!=='boolean'),title:'仅将待确认字段设为可选；保留已有规则',onclick:()=>{
        for(const row of entries){const meta=contract.fields[row.id] || (contract.fields[row.id]={});if(typeof meta.required!=='boolean')meta.required=false;}
        contract.reviewed=false;save(doc);repaint();
      }}));
      panel.append(tools,el('div',{class:'delivery-field-table'},[el('div',{class:'delivery-field-header'},['字段','类型',group==='Response'?'—':'规则','说明'].map(text=>el('span',{text}))),...entries.map(row=>{
        const meta=contract.fields[row.id] || (contract.fields[row.id]={});
        const input=el('input',{class:'input',placeholder:'字段含义…',value:meta.description || row.description || '', 'aria-label':`${group} ${row.path} 说明`,dataset:{variables:'false'},oninput:event=>{meta.description=event.target.value;contract.reviewed=false;save(doc);}});
        const required=group==='Response'?el('span',{class:'faint',text:'—'}):selectControl(`${group} ${row.path} 必填`,[['unknown','待确认'],['yes','必填'],['no','可选']],meta.required===true?'yes':meta.required===false?'no':'unknown',value=>{meta.required=value==='unknown'?null:value==='yes';contract.reviewed=false;save(doc);});
        return el('div',{class:'delivery-field-row'},[el('code',{text:row.path,title:row.path}),el('span',{class:'delivery-field-type',text:row.type}),required,input]);
      })]));
    }
  } else {
    panel.append(el('label',{class:'delivery-label',text:'业务说明'}),el('textarea',{class:'textarea',rows:3,value:contract.description,placeholder:'用途、调用条件、业务规则','aria-label':'接口业务说明',dataset:{variables:'false'},oninput:event=>{contract.description=event.target.value;contract.reviewed=false;save(doc);}}),el('label',{class:'delivery-label',text:'交付备注'}),el('textarea',{class:'textarea',rows:2,value:contract.notes || '',placeholder:'错误约定、限制、边界条件','aria-label':'接口交付备注',dataset:{variables:'false'},oninput:event=>{contract.notes=event.target.value;contract.reviewed=false;save(doc);}}));
  }
  const summary=el('span',{class:'delivery-issues'});issueSummary(doc,block,summary);
  card.append(el('footer',{class:'delivery-endpoint-foot'},[
    summary,
    el('button',{class:'btn sm',text:contract.reviewed?'已确认交付':'确认交付',onclick:()=>{
      const pending=reviewIssues(block);if(pending.length){focusIssue(doc,block,pending[0]);return;}
      if(endpointStatus(block).kind==='failed')return toast('当前运行失败，请先重新验证','err');
      contract.reviewed=true;save(doc);repaint();
    }}),
    !block.sourceId?el('button',{class:'btn sm ghost',text:'存入集合',onclick:()=>saveEndpointToCollection(doc,block)}):null,
  ]));
  return card;
}

function saveEndpointToCollection(doc,block) {
  if(!block.draft)return toast('请先解析请求','err');
  const select=selectControl('目标集合',[...state.collections.map(c=>[c.id,c.name]),['new','新建集合']],state.collections[0]?.id || 'new');
  modal({title:'存入集合并关联',width:460,body:[select],okText:'保存',onOk:()=>{
    let collection=state.collections.find(c=>c.id===select.value);if(!collection){collection=newCollection('交付接口');state.collections.push(collection);}
    const draft=clone(block.draft);draft.name=contractOf(block).summary || draft.name;
    const node=newRequestNode(draft.name,draft);node.auth=clone(block.auth || {kind:'noauth'});collection.children.push(node);block.sourceId=node.id;block.draft=clone(node.request);block.auth=clone(node.auth);touch('collections');save(doc);repaint();
  }});
}

export function runActiveDoc() {
  const doc=docOf(activeTab());if(!doc)return;
  const block=doc.blocks.find(b=>b.id===doc.activeBlockId&&b.type==='req') || doc.blocks.find(b=>b.type==='req');
  if(block)block.running?cancelBlock(doc,block):runBlock(doc,block);
}

on('request-completed', ({tab,shell,built,response}) => {
  for(const doc of state.docs)for(const block of doc.blocks.filter(b=>b.type==='req'&&(b.sourceId&&b.sourceId===tab.refId || tab.docBinding?.docId===doc.id&&tab.docBinding.blockId===b.id))) {
    block.draft=clone(shell.draft);block.auth=clone(shell.auth);captureVerification(block,shell,built,response);block.lastRequestSnapshot=requestSnapshot(shell,built);save(doc);
  }
  emit('tree');
});

on('request-saved', tab => {
  const doc=state.docs.find(d=>d.id===tab.docBinding?.docId),block=doc?.blocks.find(b=>b.id===tab.docBinding.blockId);
  if(block){block.sourceId=tab.refId;block.draft=clone(tab.draft);block.auth=clone(tab.auth);save(doc);}
});

function exportMenu(anchor,doc) {
  menu(anchor,[
    {label:'Markdown .md',onSelect:()=>exportDoc(doc)},
    {label:'独立 HTML',onSelect:()=>saveAs({name:`${safeDocName(doc)}.html`,text:deliveryHtml(doc),extensions:['html']})},
    {label:'OpenAPI 3.0 .json',onSelect:()=>{try{return saveAs({name:`${safeDocName(doc)}.openapi.json`,text:JSON.stringify(deliveryOpenApi(doc),null,2),extensions:['json']});}catch(error){toast(error.message,'err');}}},
  ]);
}

const safeDocName=doc=>(doc.name||'API').replace(/[\\/:*?"<>|]+/g,'_');
export function deliveryHtml(doc) {
  const title=String(doc.name).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f3f6f5;padding:40px 24px}html{scroll-behavior:smooth}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media(max-width:600px){body{padding:12px}}@media print{body{padding:0;background:#fff}}${PUBLICATION_CSS}</style></head><body>${publicationMarkup(doc)}</body></html>`;
}

function docOf(tab) {
  return (state.docs || []).find((item) => item.id === tab.refId) || null;
}

function save(doc) {
  doc.updatedAt = Date.now();
  touch('docs');
  if(docOf(activeTab())?.id!==doc.id)return;
  for(const block of doc.blocks.filter(b=>b.type==='req')) {
    const root=document.querySelector(`[data-block="${block.id}"]`);if(!root)continue;
    const status=endpointStatus(block),label=root.querySelector('.delivery-status');
    if(label){label.textContent=status.label;label.className=`delivery-status ${status.kind}`;}
    const foot=root.querySelector('.delivery-endpoint-foot > span');
    if(foot)issueSummary(doc,block,foot);
    const button=root.querySelector('.delivery-endpoint-foot > button');if(button)button.textContent=contractOf(block).reviewed?'已确认交付':'确认交付';
  }
  updateProgress(doc);
  document.querySelector('.delivery-outline')?.refresh?.();
}

function paintAutosave() {
  const status = saveState('docs');
  const node = document.querySelector('.delivery-autosave');
  if (!node) return;
  node.dataset.phase = status.phase;
  node.replaceChildren(el('span', { text: { pending: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' }[status.phase] }));
  if (status.phase === 'error') node.append(el('button', { class: 'btn sm ghost', text: '重试', onclick: () => flushDomain('docs') }));
}
on('persistence', event => { if (event.domain === 'docs') paintAutosave(); });

function updateProgress(doc) {
  const requests=doc.blocks.filter(b=>b.type==='req'),verified=requests.filter(b=>['verified','ready'].includes(endpointStatus(b).kind)).length,ready=requests.filter(b=>endpointStatus(b).kind==='ready').length;
  const progress=document.querySelector('.delivery-progress');if(!progress)return;
  progress.querySelector('[data-stage="total"]').textContent=`${requests.length} 个接口`;
  progress.querySelector('[data-stage="verified"]').textContent=`${verified} 已验证`;
  progress.querySelector('[data-stage="ready"]').textContent=`${ready} 可交付`;
  progress.querySelector('[data-stage="pending"]').textContent=`${requests.length-ready} 待完善`;
  progress.querySelector('.delivery-progress-fill').style.width=`${requests.length?ready/requests.length*100:0}%`;
}

/* ---------- sidebar ---------- */

export function renderDocsPane(host) {
  host.replaceChildren(
    el('div', { class: 'sidebar-head' }, [
      el('span', { class: 'sidebar-title', text: '文档' }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn icon', title: '导入 .md', onclick: () => importDocDialog() }, [icon('upload')]),
        el('button', { class: 'btn icon', title: '新建文档', onclick: () => createDoc() }, [icon('plus')]),
      ]),
    ]),
    el(
      'div',
      { class: 'sidebar-body' },
      state.docs.length
        ? state.docs.map((doc) => docRow(doc))
        : [
            el('div', { class: 'empty', style: { height: 'auto', padding: '22px 14px' } }, [
              el('p', { text: '还没有文档' }),
              el('button', { class: 'btn primary sm', text: '新建文档', onclick: () => createDoc() }),
            ]),
          ]
    )
  );
}

function docRow(doc) {
  const requests = doc.blocks.filter((block) => block.type === 'req').length;
  return el('div', { class: 'node node-doc', dataset: { doc: doc.id }, ...sortableRow('docs', doc), onclick: () => openDoc(doc) }, [
    el('span', { class: 'twist' }),
    icon('file'),
    el('span', { class: 'name', text: doc.name || '未命名文档' }),
    el('span', { class: 'count', text: `${doc.blocks.filter(block=>block.type==='req'&&endpointStatus(block).kind==='ready').length}/${requests}` }),
    el('span', { class: 'node-actions' }, [
      el('button', {
        text: '⋯',
        onclick: (event) => {
          event.stopPropagation();
          menu(event.currentTarget, [
            { label: '打开', icon: 'play', onSelect: () => openDoc(doc) },
            { label: '复制副本', onSelect: () => duplicateDoc(doc) },
            { label: '导出 .md', onSelect: () => exportDoc(doc) },
            { separator: true },
            {
              label: '删除',
              icon: 'trash',
              danger: true,
              onSelect: async () => {
                const { confirmDialog } = await import('./ui.js');
                if (!(await confirmDialog(`删除文档「${doc.name}」？`))) return;
                const index = state.docs.indexOf(doc);
                if (index >= 0) state.docs.splice(index, 1);
                for (const tab of [...state.tabs]) if (tab.kind === 'doc' && tab.refId === doc.id) closeTabOf(tab.id);
                save(doc);
                touch('docs');
                emit('tree');
              },
            },
          ]);
        },
      }),
    ]),
  ]);
}

function closeTabOf(tabId) {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index >= 0) state.tabs.splice(index, 1);
  if (state.activeTabId === tabId) state.activeTabId = (state.tabs[0] || {}).id || null;
  emit('tabs');
  emit('rerender');
  touch('tabs');
}

export function createDoc(name) {
  const doc = newDoc(name || `交付文档 ${state.docs.length + 1}`);
  state.docs.push(doc);
  touch('docs');
  emit('tree');
  openDoc(doc);
  return doc;
}

function duplicateDoc(doc) {
  const copyDoc = JSON.parse(JSON.stringify(doc));
  copyDoc.id = uid('doc');
  copyDoc.name = `${doc.name} 副本`;
  copyDoc.blocks.forEach((block) => {
    block.id = uid('blk');
    block.response = null;
    block.running = false;
  });
  state.docs.push(copyDoc);
  touch('docs');
  emit('tree');
  openDoc(copyDoc);
}

/* ---------- the document pane ---------- */

const outlineState=new Map();
function outlineFor(doc,wrap) {
  const view=outlineState.get(doc.id) || {query:'',pending:false};outlineState.set(doc.id,view);
  const list=el('div',{class:'delivery-outline-list'});
  const search=el('input',{class:'input delivery-outline-search',value:view.query,placeholder:'查找接口…','aria-label':'查找文档接口',dataset:{variables:'false'},oninput:event=>{view.query=event.target.value;draw();}});
  const filter=el('button',{class:`delivery-outline-filter ${view.pending?'on':''}`,text:'待完善','aria-pressed':view.pending,onclick:()=>{view.pending=!view.pending;draw();}});
  const expand = el('button', { class: 'delivery-outline-filter', text: editorView(doc).all ? '聚焦当前' : '展开全部', 'aria-pressed': editorView(doc).all, onclick: () => { editorView(doc).all = !editorView(doc).all; expand.textContent = editorView(doc).all ? '聚焦当前' : '展开全部'; expand.setAttribute('aria-pressed', String(editorView(doc).all)); selectDocBlock(doc, doc.activeBlockId); } });
  const outline=el('nav',{class:'delivery-outline','aria-label':'文档接口目录'},[el('div',{class:'delivery-outline-title'},[el('span',{text:'接口目录'}),el('div',{class:'btn-row'},[expand,filter])]),search,list]);
  const draw=()=>{
    filter.classList.toggle('on',view.pending);filter.setAttribute('aria-pressed',String(view.pending));
    const blocks=doc.blocks.filter(b=>b.type==='req'),query=view.query.toLowerCase().trim();
    const visible=blocks.filter(block=>(!view.pending||endpointStatus(block).kind!=='ready')&&`${contractOf(block).summary} ${block.draft?.url || ''}`.toLowerCase().includes(query));
    list.replaceChildren(...visible.map(block=>{
      const status=endpointStatus(block),active=doc.activeBlockId===block.id;
      return el('div',{class:`delivery-outline-item ${active?'on':''}`,role:'button',tabindex:0,dataset:{orderIndex:doc.blocks.indexOf(block)},title:status.label,'aria-current':active?'true':'false',onkeydown:event=>{if(event.target===event.currentTarget&&['Enter',' '].includes(event.key)){event.preventDefault();event.currentTarget.click();}},onclick:()=>{
        selectDocBlock(doc,block.id);
        wrap.querySelector(`[data-block="${block.id}"]`)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
      }},[reorderHandle(doc.blocks.indexOf(block), {...docOrder(doc),selector:'.delivery-outline-item',name:'拖拽接口目录'}),el('span',{text:contractOf(block).summary || block.draft?.name || '接口草稿'}),el('i',{class:`delivery-dot ${status.kind}`})]);
    }));
    if(!visible.length)list.append(el('div',{class:'delivery-outline-empty',text:query?'无匹配接口':view.pending?'全部已完善':'暂无接口'}));
  };
  outline.refresh=draw;draw();return outline;
}

function jumpToPending(doc) {
  const block=doc.blocks.find(b=>b.type==='req'&&endpointStatus(b).kind!=='ready');if(!block)return;
  const issue=reviewIssues(block)[0] || '重新验证';
  if(doc.mode==='delivery')doc.mode='draft';focusIssue(doc,block,issue);
}

export function renderDocPane(tab) {
  const doc = docOf(tab);
  if (!doc) {
    return el('div', { class: 'pane-scroll' }, [
      el('div', { class: 'empty' }, [el('h3', { text: '文档已删除' }), el('p', { text: '关闭此标签，或在左侧新建一个。' })]),
    ]);
  }
  syncLinked(doc);
  const wrap = el('div', { class: 'pane-scroll doc-scroll delivery-workspace' });
  const blocks=doc.blocks.filter(block=>block.type==='req'),requests=blocks.length;
  if (!doc.blocks.some(block => block.id === doc.activeBlockId)) doc.activeBlockId = blocks[0]?.id || doc.blocks[0]?.id;

  const nameInput = el('input', {
    class: 'doc-name',
    'aria-label': '文档名称',
    value: doc.name,
    spellcheck: 'false',
    oninput: (event) => {
      doc.name = event.target.value;
      tab.title = doc.name || '未命名文档';
      emit('tabs');
      // the sidebar's document list shows this same name
      emit('tree');
      save(doc);
    },
  });

  wrap.appendChild(
    el('div', { class: 'doc-head' }, [
      el('div',{class:'delivery-identity'},[el('div',{class:'delivery-eyebrow',text:'交付文档'}),nameInput]),
      el('span', { class: 'delivery-autosave', role: 'status', 'aria-live': 'polite', dataset: { phase: saveState('docs').phase }, text: { pending: '未保存', saving: '保存中…', saved: '已保存', error: '保存失败' }[saveState('docs').phase] }),
      el('div', { class: 'btn-row right' }, [
        segmented([['draft','草稿调试'],['delivery','交付预览']], doc.mode || 'draft', value=>{doc.mode=value;wrap.scrollTop=0;save(doc);repaint();}),
        el('button', { class: 'btn sm', text: '导入 .md', onclick: () => importDocDialog(doc) }),
        el('button', { class: 'btn sm primary', text: '导出交付', onclick: event => exportMenu(event.currentTarget,doc) }),
      ]),
    ])
  );
  requestAnimationFrame(paintAutosave);

  const ready=blocks.filter(block=>endpointStatus(block).kind==='ready').length,verified=blocks.filter(block=>['ready','verified'].includes(endpointStatus(block).kind)).length;
  const intro=el('textarea', {class:'delivery-intro',rows:1,value:doc.overview || '',placeholder:'项目范围、调用约定或交付说明…', 'aria-label':'交付概述',dataset:{variables:'false'}, oninput:event=>{doc.overview=event.target.value;grow(event.target);save(doc);}});
  if(doc.mode!=='delivery')requestAnimationFrame(()=>{if(intro.isConnected)grow(intro);});
  if(doc.mode!=='delivery')wrap.appendChild(el('div', {class:'delivery-overview'}, [
    intro,
    el('div',{class:'delivery-progress'},[
      el('span',{dataset:{stage:'total'},text:`${requests} 个接口`}),el('span',{dataset:{stage:'verified'},text:`${verified} 已验证`}),el('span',{class:'delivery-ready',dataset:{stage:'ready'},text:`${ready} 可交付`}),
      el('div',{class:'delivery-progress-track','aria-hidden':'true'},[el('div',{class:'delivery-progress-fill',style:{width:`${requests?ready/requests*100:0}%`}})]),
      el('button',{class:'delivery-pending',dataset:{stage:'pending'},text:`${requests-ready} 待完善`,onclick:()=>jumpToPending(doc)}),
      el('label',{class:'delivery-version'},[el('span',{text:'版本'}),el('input',{class:'input mono',value:doc.version || '1.0.0','aria-label':'文档版本',dataset:{variables:'false'},oninput:event=>{doc.version=event.target.value;save(doc);}})]),
    ]),
  ]));
  if(doc.mode==='delivery') {
    const preview=el('div',{class:'delivery-preview'},[el('style',{text:PUBLICATION_CSS}),el('div',{html:publicationMarkup(doc)})]);
    preview.querySelectorAll('.pub-toc a').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();preview.querySelector(link.getAttribute('href'))?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}));
    preview.querySelectorAll('.pub-endpoint').forEach((article,index)=>article.querySelector('.pub-endpoint-head').append(el('button',{class:'btn sm ghost pub-edit',text:'编辑',title:'回到此接口草稿',onclick:()=>{doc.mode='draft';doc.activeBlockId=blocks[index].id;save(doc);repaint();requestAnimationFrame(()=>document.querySelector(`[data-block="${blocks[index].id}"]`)?.scrollIntoView({block:'start'}));}})));
    preview.querySelectorAll('pre').forEach(pre=>{const text=pre.querySelector('code')?.textContent || pre.textContent;pre.prepend(el('button',{class:'pub-copy',text:'复制','aria-label':'复制文档代码',onclick:()=>copy(text,'已复制')}));});
    wrap.append(preview);
    return wrap;
  }
  const paste = el('textarea',{class:'delivery-paste mono',rows:2,value:doc.pendingDraft || '',placeholder:'粘贴 cURL，或直接写说明…', 'aria-label':'接口草稿',dataset:{variables:'false'},oninput:event=>{doc.pendingDraft=event.target.value;save(doc);},onkeydown:event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();event.stopPropagation();addDraft(doc,paste);}}});
  wrap.append(el('details',{class:'delivery-composer',open:editorView(doc).composerOpen ?? (!doc.blocks.length||!!doc.pendingDraft),ontoggle:event=>{if(event.target.isConnected)editorView(doc).composerOpen=event.target.open;}},[el('summary',{class:'delivery-composer-heading'},[icon('terminal'),el('span',{text:'添加接口或说明'}),el('kbd',{text:'Ctrl Enter'}),el('span',{class:'composer-chevron','aria-hidden':'true'},[icon('chevD')])]),paste,el('div',{class:'delivery-composer-actions'},[el('button',{class:'btn primary sm',text:'加入草稿',onclick:()=>addDraft(doc,paste)}),el('button',{class:'btn sm',text:'关联集合请求',onclick:()=>pickCollectionRequest(doc)})])]));
  const layout=el('div',{class:'delivery-layout'});
  const outline=outlineFor(doc,wrap);
  const body = el('div', { class: 'doc-body delivery-body' });
  doc.blocks.forEach((block, index) => {
    body.appendChild(blockView(doc, block, index));
  });
  if(!doc.blocks.length)body.append(el('div',{class:'delivery-start'},[icon('file'),el('h3',{text:'从第一条请求开始'}),el('p',{text:'验证结果会形成响应样例与字段结构。'})]));
  layout.append(outline,body);wrap.append(layout);
  return wrap;
}

function blockView(doc, block, index) {
  const shell = el('div', { class: `doc-block ${block.type === 'req' ? 'is-req' : 'is-text'} ${block.type==='req'&&!editorView(doc).all && doc.activeBlockId!==block.id?'is-collapsed':''}`, dataset:{block:block.id,orderIndex:index}, onfocusin:event=>{if(!event.target.closest('.reorder-handle')&&doc.activeBlockId!==block.id)selectDocBlock(doc,block.id);} });
  shell.appendChild(
    el('div', { class: 'doc-gutter' }, [
      reorderHandle(index, docOrder(doc)),
      el('button', {
        class: 'doc-grip',
        title: '块操作',
        'aria-label': '文档块操作',
        onclick: (event) => {
          event.stopPropagation();
          blockMenu(event.currentTarget, doc, block, index);
        },
      }, [icon('dots')]),
    ])
  );
  shell.appendChild(block.type === 'req' ? endpointCard(doc, block) : textBlock(doc, block));
  if (block.type === 'req') shell.querySelector('.delivery-endpoint-head').append(el('button', { class: 'btn sm ghost endpoint-expand', text: '展开', title: '编辑此接口', onclick: () => selectDocBlock(doc,block.id) }));
  return shell;
}

function blockMenu(anchor, doc, block, index) {
  menu(
    anchor,
    [
      { label: '在上方插入说明', onSelect: () => insertBlock(doc, index, { id: uid('blk'), type: 'text', text: '' }) },
      { label: '在下方插入说明', onSelect: () => insertBlock(doc, index + 1, { id: uid('blk'), type: 'text', text: '' }) },
      { label: '在下方插入 curl 请求', onSelect: () => insertBlock(doc, index + 1, newReqBlock('')) },
      { separator: true },
      { label: '上移', disabled: index === 0, onSelect: () => moveBlock(doc, index, index - 1) },
      { label: '下移', disabled: index === doc.blocks.length - 1, onSelect: () => moveBlock(doc, index, index + 1) },
      { label: '删除此块', danger: true, disabled: doc.blocks.length <= 1, onSelect: () => removeBlock(doc, block) },
    ],
    { align: 'start' }
  );
}

function insertBlock(doc, at, block) {
  doc.activeBlockId = block.id;
  changeList({ ...docOrder(doc), label: '插入文档块' }, rows => rows.splice(Math.max(0, Math.min(at, rows.length)), 0, block));
}

function moveBlock(doc, from, to) {
  changeList(docOrder(doc), list => list.splice(to, 0, list.splice(from, 1)[0]));
}

function removeBlock(doc, block) {
  const index = doc.blocks.indexOf(block);
  if (index >= 0) changeList({ ...docOrder(doc), label: '删除文档块' }, list => list.splice(index, 1));
}

function docOrder(doc) {
  return { selector: '.delivery-body .doc-block', get: () => doc.blocks, set: list => { doc.blocks = list; doc.updatedAt = Date.now(); }, domain: 'docs', label: '文档排序', name: '拖拽文档块', valid: () => state.docs.includes(doc) };
}

const SLASH_ITEMS = [
  { label: '大标题', hint: '#', insert: '# ' },
  { label: '小标题', hint: '###', insert: '### ' },
  { label: '无序列表', hint: '-', insert: '- ' },
  { label: '有序列表', hint: '1.', insert: '1. ' },
  { label: '引用', hint: '>', insert: '> ' },
  { label: '表格', hint: '两列', insert: '| 参数 | 说明 |\n| --- | --- |\n|  |  |\n' },
  { label: '代码块', hint: '```', insert: '```\n\n```\n' },
  { label: '分隔线', hint: '---', insert: '\n---\n' },
  { label: 'curl 请求块', hint: '可执行', special: 'req' },
];

function textBlock(doc, block) {
  if (!block.editing) {
    const empty = !String(block.text || '').trim();
    return el('div', {
      class: `md-body ${empty ? 'md-empty' : ''}`,
      tabindex: '0',
      onclick: () => startEdit(doc, block),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          startEdit(doc, block);
        }
      },
      html: empty ? '' : renderMarkdown(block.text),
    });
  }

  // A transparent textarea sits on top of a styled copy of the same text, so the
  // caret stays on the raw Markdown while it lights up underneath as you type.
  const hl = el('div', { class: 'md-hl', html: highlightMarkdown(block.text || '') });
  const slash = { node: null, items: [], index: 0, start: -1, query: '' };

  const closeSlash = () => {
    if (slash.node) slash.node.remove();
    slash.node = null;
    slash.items = [];
    slash.start = -1;
  };

  const drawSlash = () => {
    if (!slash.node) {
      slash.node = el('div', { class: 'slash' });
      edit.appendChild(slash.node);
    }
    const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 22;
    const line = String(block.text || '').slice(0, slash.start).split('\n').length;
    slash.node.style.top = `${Math.max(line, 1) * lineHeight + 6}px`;
    slash.node.replaceChildren(
      ...slash.items.map((item, index) =>
        el(
          'div',
          {
            class: `slash-item ${index === slash.index ? 'on' : ''}`,
            onmousedown: (event) => {
              event.preventDefault();
              applySlash(item);
            },
            onmouseenter: () => {
              slash.index = index;
              drawSlash();
            },
          },
          [el('span', { text: item.label }), el('span', { class: 'faint small', text: item.hint })]
        )
      )
    );
  };

  const trackSlash = () => {
    const caret = area.selectionStart || 0;
    const lineStart = area.value.lastIndexOf('\n', caret - 1) + 1;
    const match = area.value.slice(lineStart, caret).match(/(^|\s)\/([^\s/]*)$/);
    if (!match) {
      closeSlash();
      return;
    }
    slash.start = caret - match[2].length - 1;
    slash.query = match[2];
    slash.items = SLASH_ITEMS.filter((item) => !match[2] || item.label.includes(match[2]));
    slash.index = 0;
    if (!slash.items.length) return closeSlash();
    drawSlash();
  };

  const applySlash = (item) => {
    const caret = area.selectionStart || 0;
    const before = area.value.slice(0, slash.start);
    const after = area.value.slice(caret);
    closeSlash();
    if (item.special === 'req') {
      block.text = `${before}${after}`.trim();
      const index = doc.blocks.indexOf(block);
      const created = newReqBlock('');
      if (!block.text) doc.blocks.splice(index, 1);
      insertBlock(doc, block.text ? index + 1 : index, created);
      refreshDraft(created).then(repaint);
      return;
    }
    block.text = before + item.insert + after;
    area.value = block.text;
    const next = (before + item.insert).length;
    area.setSelectionRange(next, next);
    hl.innerHTML = highlightMarkdown(block.text);
    grow(area);
    save(doc);
    area.focus();
  };

  const area = el('textarea', {
    class: 'md-src',
    spellcheck: 'false',
    placeholder: '写说明，或按 / 插入块',
    value: block.text || '',
    oninput: (event) => {
      block.text = event.target.value;
      hl.innerHTML = highlightMarkdown(block.text);
      grow(area);
      trackSlash();
      save(doc);
    },
    onkeyup: trackSlash,
    onclick: trackSlash,
    onblur: () => {
      // picking an item uses mousedown + preventDefault, so losing focus here
      // always means the user actually left the block
      closeSlash();
      block.editing = false;
      repaint();
    },
    onkeydown: (event) => {
      if (slash.node && slash.items.length) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          slash.index = (slash.index + (event.key === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length;
          drawSlash();
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          applySlash(slash.items[slash.index]);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSlash();
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        block.editing = false;
        repaint();
      }
    },
    onpaste: (event) => {
      const text = (event.clipboardData || window.clipboardData).getData('text') || '';
      const curl = extractCurl(text);
      if (!curl || curl.length > 4000) return;
      event.preventDefault();
      const head = String(block.text || '').slice(0, area.selectionStart || 0);
      const tail = String(block.text || '').slice(area.selectionStart || 0);
      block.text = `${head}${tail}`.trim();
      const index = doc.blocks.indexOf(block);
      const created = newReqBlock(curl);
      if (!block.text) doc.blocks.splice(index, 1);
      insertBlock(doc, block.text ? index + 1 : index, created);
      refreshDraft(created).then(repaint);
      toast('已识别为 curl 请求块', 'ok', 2000);
    },
  });

  const edit = el('div', { class: 'md-edit' }, [hl, area]);
  queueMicrotask(() => {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    grow(area);
  });
  return edit;
}

function grow(area) {
  area.style.height = 'auto';
  const style = getComputedStyle(area);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  area.style.height = `${Math.max(area.scrollHeight + border, 46)}px`;
}

function startEdit(doc, block) {
  doc.blocks.forEach((item) => {
    item.editing = item === block;
  });
  repaint();
}

function reqBlock(doc, block) {
  const left = el('div', { class: 'doc-cmd' });
  const cmd = el('textarea', {
    class: 'doc-curl mono',
    spellcheck: 'false',
    placeholder: "curl -X POST 'https://api…' -H 'token: Bearer {{user-token}}' -d '{}'",
    value: block.curl || '',
    oninput: (event) => {
      block.curl = event.target.value;
      grow(event.target);
      save(doc);
    },
    onblur: () => refreshDraft(block, summary),
  });
  const summary = el('div', { class: 'doc-summary' }, [summaryNode(block)]);
  const running = !!block.running;

  const run = el('button', {
    class: `btn sm ${running ? 'danger' : 'primary'}`,
    text: running ? '取消' : '执行',
    title: '执行这条 curl（Ctrl+Enter）',
    onclick: () => (running ? cancelBlock(doc, block) : runBlock(doc, block)),
  });
  left.replaceChildren(
    el('div', { class: 'doc-cmd-head' }, [
      summary,
      run,
      el('button', {
        class: 'btn sm ghost icon',
        title: '更多',
        text: '⋯',
        onclick: (event) => {
          event.stopPropagation();
          menu(event.currentTarget, [
            { label: '在请求页打开', icon: 'play', onSelect: () => openAsRequest(block) },
            { label: '复制命令', icon: 'copy', onSelect: () => block.curl && copy(block.curl, 'curl 已复制') },
          ], { align: 'end' });
        },
      }),
    ]),
    cmd
  );

  return el('div', { class: 'doc-req' }, [left, responsePanel(block)]);
}

function summaryNode(block) {
  const draft = block.draft;
  if (!draft) return el('span', { class: 'faint small', text: '粘贴一条 curl 命令，或点执行时自动解析' });
  const method = el('span', { class: `pill method-${(draft.method || 'get').toLowerCase()}`, text: draft.method || 'GET' });
  const bits = [
    method,
    el('span', { class: 'doc-sum-url mono', title: draft.url || '', text: draft.url || '(无 URL)' }),
    el('span', { class: 'faint small', text: `${(draft.headers || []).length} 个头` }),
  ];
  const params = (draft.params || []).filter((row) => row.key);
  if (params.length) bits.push(el('span', { class: 'faint small', text: `${params.length} 个参数` }));
  if (draft.body && draft.body.mode !== 'none') bits.push(el('span', { class: 'faint small', text: draft.body.mode }));
  return el('div', { class: 'inline', style: { gap: '7px' } }, bits);
}

/// Parsing is cheap and lets the card show method / URL / header count before
/// the first run; a broken command just keeps the placeholder.
async function refreshDraft(block, host) {
  if(block.sourceId)return;
  const command = String(block.curl || '').trim();
  if (!command) {block.draft=null;block.parseError='请输入 cURL';return;}
  if(block.parsedCurl===command&&block.draft)return;
  try {
    const parsed = await api.parseCurl(command);
    if(command!==String(block.curl || '').trim())return;
    if(parsed.length!==1||!parsed[0]?.draft?.url)throw new Error('请输入一条有效 cURL；批量命令使用顶部草稿框');
    block.draft = parsed[0].draft;
    if(!block.draft.params?.length&&block.draft.url.includes('?'))syncParamsFromUrl(block);
    block.parsedCurl=command;block.parseError='';block.auth=block.auth || {kind:'noauth'};
    contractOf(block);if(!block.contract.summary)block.contract.summary=block.draft.name || '';
  } catch (error) {
    if(command!==String(block.curl || '').trim())return;
    block.draft=null;block.parseError=String(error.message || error);
  }
  if (host) host.replaceChildren(summaryNode(block));
}

function responsePanel(block) {
  const panel = el('div', { class: 'doc-res' });
  const response = block.response;
  if (!response) {
    panel.appendChild(el('div', { class: 'empty', style: { height: 'auto', padding: '18px' } }, [el('p', { text: '暂无响应' })]));
    return panel;
  }
  const statusClass = response.error ? 'err' : response.status >= 400 ? 'warn' : 'ok';
  panel.appendChild(
    el('div', { class: 'doc-res-head' }, [
      el('span', { class: `pill ${statusClass}`, text: response.error ? '请求失败' : `${response.status} ${response.statusText || ''}`.trim() }),
      el('span', { class: 'faint small', text: `${response.timeMs || 0} ms` }),
      el('span', { class: 'faint small', text: `${response.sizeBytes || 0} B` }),
      el('button', {
        class: 'btn sm ghost right',
        text: '复制响应',
        onclick: () => copy(response.bodyText || '', '响应已复制'),
      }),
    ])
  );
  if (response.error) {
    panel.appendChild(el('p', { class: 'doc-res-error', text: response.error }));
    return panel;
  }
  const text = response.bodyText || '';
  panel.appendChild(el('pre', { class: 'doc-res-body mono', text: text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n… 共 ${text.length} 字符` : text || '(空响应体)' }));
  return panel;
}

/* ---------- running ---------- */

export async function runBlock(doc, block) {
  if (block.running) return cancelBlock(doc, block);
  if(block.preparing)return;
  block.preparing=true;
  try {syncLinked(doc);await refreshDraft(block);}
  finally {block.preparing=false;}
  if(block.parseError||!block.draft){toast(block.parseError || '请先填写请求','err');return repaint();}
  const protocol=inferProtocol(block.draft,block.sourceId?findNode(block.sourceId)?.node?.protocol:undefined);
  if(protocol!=='http'){toast(`${protocol==='ws'?'WebSocket':'SSE'} 请在请求工作台中调试，交付文档验证目前支持 HTTP`,'err');return;}
  const shell = { draft: clone(block.draft), refId: block.sourceId || null, auth: clone(block.auth || {kind:'noauth'}) };
  const built=buildSendDraft(shell),{ draft, missing }=built;
  const rules=built.preparedChecks;
  if(missing.length){toast(`变量未解析：${missing.join('、')}`,'err');return;}
  if (!draft.url) {
    block.response = { error: '这条 curl 没有 URL', status: 0, headers: [], bodyText: '', timeMs: 0, sizeBytes: 0 };
    save(doc);
    return repaint();
  }
  block.running = true;
  block.execId = uid('doc');
  const execId=block.execId;
  block.lastRequestSnapshot=requestSnapshot(shell,built);
  repaint();
  try {
    const response = await api.execute(draft, execId);
    if(block.execId!==execId)return;
    response.checkResult=evaluateChecks(rules,response);
    captureVerification(block,shell,built,response);
    pushHistory({
      kind: 'http',
      name: `${doc.name} · ${draft.method} ${draft.url}`.slice(0, 90),
      method: draft.method,
      url: draft.url,
      status: response.status || 0,
      timeMs: response.timeMs || 0,
      sizeBytes: response.sizeBytes || 0,
      errorKind: response.errorKind || null,
      snapshot: JSON.parse(JSON.stringify(draft)),
      auth: { kind: 'inherit' },
      protocol: 'http',
    });
  } catch (error) {
    if(block.execId===execId)block.response = { error: String((error && error.message) || error), status: 0, headers: [], bodyText: '', timeMs: 0, sizeBytes: 0 };
  } finally {
    if(block.execId===execId){block.running = false;block.execId = null;save(doc);repaint();}
  }
}

export function cancelBlock(doc, block) {
  if (block.execId) api.cancel(block.execId);
  block.running = false;
  block.execId = null;
  save(doc);
  repaint();
}

async function openAsRequest(block,doc) {
  await refreshDraft(block);
  if(!block.draft)return toast(block.parseError || '请先解析请求','err');
  const draft = block.draft || newRequestDraft();
  const node=block.sourceId?findNode(block.sourceId)?.node:null;
  let tab;
  if(node)tab=openRequest(node);
  else {
    tab=state.tabs.find(t=>t.docBinding?.docId===doc?.id&&t.docBinding.blockId===block.id);
    if(tab){state.activeTabId=tab.id;emit('tabs',{activate:true});}
    else {tab = newTab(inferProtocol(draft));tab.draft = clone(draft);tab.auth=clone(block.auth || {kind:'noauth'});tab.dirty = true;}
  }
  if(doc)tab.docBinding={docId:doc.id,blockId:block.id};
  if (block.response) tab.response = block.response;
  touch('tabs');emit('tabs');
  emit('rerender');
  toast('已在请求页打开', 'ok', 1600);
}

function repaint() {
  const tab = activeTab();
  if (tab && (tab.kind === 'doc' || tab.protocol === 'doc')) emit('rerender');
  emit('tree');
}

/* ---------- import / export ---------- */

export function docToMarkdown(doc) {
  syncLinked(doc);
  return deliveryMarkdown(doc);
}

export function markdownToDoc(name, source) {
  const doc = newDoc(name);
  doc.blocks = [];
  const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
  let buffer = [];
  let fence = null;
  const flushText = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text) doc.blocks.push({ id: uid('blk'), type: 'text', text });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (line.trim() === '```') {
        doc.blocks.push(newReqBlock(fence.join('\n').trim()));
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^\s*```(?:curl|bash|sh|shell)?\s*$/.test(line) && /^\s*curl\s/i.test(lines[index+1]||'')) {
      flushText();
      fence = [];
      continue;
    }
    if (/^\s*curl(\s|$)/i.test(line)) {
      flushText();
      const command = [line];
      // a trailing backslash means the command continues on the next line
      while (/\\\s*$/.test(command[command.length - 1]) && index + 1 < lines.length) {
        index += 1;
        command.push(lines[index]);
      }
      doc.blocks.push(newReqBlock(command.join(' ').replace(/\\\s+/g, ' ').trim()));
      continue;
    }
    buffer.push(line);
  }
  if (fence) doc.blocks.push(newReqBlock(fence.join('\n').trim()));
  flushText();
  if (!doc.blocks.length) doc.blocks.push({ id: uid('blk'), type: 'text', text: String(source || '') });
  return doc;
}

async function exportDoc(doc) {
  const name = `${(doc.name || 'doc').replace(/[\\/:*?"<>|]+/g, '_')}.md`;
  await saveAs({ name, text: docToMarkdown(doc), extensions: ['md', 'txt'] });
}

function importDocDialog(target) {
  const area = el('textarea', { class: 'textarea mono', rows: 16, placeholder: '粘贴 Markdown，其中的 curl 代码块会变成可执行请求块。' });
  const pick = filePicker({
    accept: '.md,.markdown,.txt',
    buttonText: '选择 .md 文件',
    hint: '未选择文件',
    onPick: async (handle) => {
      area.value = await handle.text();
    },
  });
  modal({
    title: target ? `导入到「${target.name}」` : '导入 Markdown 文档',
    width: 780,
    body: [el('div', { class: 'field' }, [el('label', { text: '选择 .md 文件' }), pick]), el('div', { class: 'field' }, [el('label', { text: '或直接粘贴内容' }), area])],
    okText: '导入',
    onOk: async () => {
      const source = area.value.trim();
      if (!source) {toast('没有内容', 'err', 1800);return false;}
      const parsed = markdownToDoc((target && target.name) || '导入的文档', source);
      await Promise.all(parsed.blocks.filter(block=>block.type==='req').map(block=>refreshDraft(block)));
      if (target) {
        target.blocks = parsed.blocks;
        save(target);
      } else {
        state.docs.push(parsed);
        touch('docs');
        emit('tree');
        openDoc(parsed);
      }
      toast(`已导入 ${parsed.blocks.length} 个块`, 'ok', 2200);
    },
  });
}
