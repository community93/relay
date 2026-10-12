import { state, uid, kv, newBody, newAuth, newCollection, newRequestNode, newDoc, newReqBlock, newEnvironment, newRunner, findNode, touch, flushDomain, saveState, emit, buildSendDraft, openRequest, openDoc, openRunner, activeEnv, splitQuery, syncParamsFromUrl, syncUrlFromParams } from './state.js';
import * as api from './api.js';
import { evaluateChecks } from './checks.js';
import { requestSnapshot, requestCurl } from './preview.js';
import { contractOf, clone, scrub, safeResponse, endpointFields, endpointStatus, reviewIssues, deliveryMarkdown, deliveryOpenApi, SECRET_KEY } from './delivery.js';
import { deliveryHtml, runBlock, cancelBlock } from './doc.js';
import { runRunner, stopRunner, sessionOf, stepsOf } from './runner.js';
import { inferProtocol } from './protocol.js';
import { el, icon, modal, toast, copy, saveAs, segmented } from './ui.js';

const actions = ['workspace.list','entity.get','collection.upsert','environment.upsert','request.upsert','document.upsert','document.endpoint.upsert','runner.upsert','request.execute','document.verify','runner.execute','job.get','job.cancel','document.export','entity.open'];
/// Mirrors `action_tier`/`scope_tier` in src-tauri/src/automation.rs. The Rust test
/// `every_frontend_action_is_graded` fails the build if the two drift apart.
const ACTION_TIER = {
  'workspace.list': 0, 'entity.get': 0, 'job.get': 0,
  'collection.upsert': 1, 'environment.upsert': 1, 'request.upsert': 1, 'document.upsert': 1,
  'document.endpoint.upsert': 1, 'runner.upsert': 1, 'entity.open': 1, 'document.export': 1,
  'request.execute': 2, 'document.verify': 2, 'runner.execute': 2, 'job.cancel': 2,
};
const SCOPE_TIER = { read: 0, write: 1, execute: 2 };
const tierOf = scope => SCOPE_TIER[scope] ?? 0;
const reachableActions = scope => actions.filter(action => ACTION_TIER[action] <= tierOf(scope));
const jobs = new Map();
let queue = Promise.resolve(), connected = false;
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
const object = (value, label='data') => { if (!value || typeof value!=='object' || Array.isArray(value)) fail('invalid',`${label} must be an object`); return value; };
const fields = (value, allowed) => { object(value); for(const key of Object.keys(value)) if(!allowed.includes(key)) fail('invalid',`Unknown field: ${key}`); return value; };
const text = (value, label, max=10000) => { if(typeof value!=='string' || value.length>max) fail('invalid',`${label} must be a string (max ${max})`);return value; };
const idOf = value => { if(value!==undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('invalid','Invalid id'); return value; };
const nameOf = value => { const name=text(value,'name',200).trim();if(!name)fail('invalid','Name is required');return name; };
function entity(type,id) {
  let value;
  if(['collection','request'].includes(type))value=findNode(id)?.node;
  else value=state[{environment:'environments',document:'docs',runner:'runners'}[type]]?.find(item=>item.id===id);
  if(!value || type==='collection'&&value.kind!=='collection' || type==='request'&&!['request','ws'].includes(value.kind))fail('not_found','Entity not found');
  return value;
}
export function revision(value) {
  // Include actual saved content, including user changes made outside this API.
  const canonical=JSON.stringify(value,(key,item)=>['running','preparing','execId','view','activeBlockId'].includes(key)?undefined:item);
  let a=2166136261,b=5381;for(const char of canonical){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b,33)^char.charCodeAt(0);}
  return `${(a>>>0).toString(16)}${(b>>>0).toString(16)}`;
}
function checkRevision(existing, expected) {
  if(existing && expected!==revision(existing))fail('conflict','Content changed; read entity.get and merge before retrying');
  if(!existing && expected!==undefined)fail('conflict','Entity no longer exists');
}
function busyRequest(node) {
  if(state.tabs.some(tab=>tab.refId===node.id&&(tab.dirty || tab.running || ['opening','open','closing'].includes(tab.ws?.status))))fail('busy','Request has an unsaved draft or active connection');
  if([...jobs.values()].some(job=>job.state==='running' && job.requestId===node.id) || state.runners.some(runner=>sessionOf(runner.id)&&stepsOf(runner).some(step=>step.node.id===node.id)) || state.docs.some(doc=>doc.blocks.some(block=>block.sourceId===node.id&&(block.running || block.preparing))))fail('busy','Request is running');
}
function redacted(value, secrets=[]) {
  const walk=item=>{
    if(Array.isArray(item))return item.map(walk);
    if(item&&typeof item==='object'){
      const out=Object.fromEntries(Object.entries(item).filter(([key])=>!['bodyBase64','bodyRawBase64','fingerprint','secrets','_secrets','scope'].includes(key)).map(([key,v])=>[key,key==='bodyText'?safeResponse(String(v||''),secrets).slice(0,262144):walk(v)]));
      if(typeof item.bodyText==='string'&&item.bodyText.length>262144)out.apiTruncated=true;
      if(item.language==='json'&&typeof out.content==='string')out.content=safeResponse(out.content,secrets);
      if(SECRET_KEY.test(String(item.path||'')))for(const key of ['actual','expected','value'])if(key in out)out[key]='<redacted>';
      if(SECRET_KEY.test(String(item.key || item.name || ''))&&'value' in out)out.value='<redacted>';
      if(typeof out.url==='string')out.url=out.url.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g,'$1<redacted>@').replace(/([?&](?:token|api[_-]?key|password|secret)=)[^&#]*/gi,'$1<redacted>');
      return out;
    }
    return item;
  };
  return scrub(walk(value),secrets);
}
function resultEntity(value) { return {entity:redacted(value),revision:revision(value)}; }
function busyDocument(doc) { if(doc.blocks.some(b=>b.running||b.preparing)||[...jobs.values()].some(j=>j.state==='running'&&j.documentId===doc.id))fail('busy','Document is running'); }
/// The transport grades *which* actions a connection may call, but it cannot judge
/// *where* a request goes: the URL is only absolute after variable resolution,
/// which happens here. So the host allowlist is enforced at this last point before
/// traffic leaves the machine.
const hostOf = raw => { try { return new URL(raw).hostname.toLowerCase(); } catch { return null; } };
const hostMatch = (pattern, host) => pattern.startsWith('*.')
  ? host === pattern.slice(2) || host.endsWith(`.${pattern.slice(2)}`)
  : pattern === host;
async function requireHosts(urls, what) {
  const connection = await api.invoke('automation_status');
  const allowed = connection?.allowedHosts || [];
  // Unparseable hosts fail closed: a URL we cannot read is not a URL we may send.
  const blocked = [...new Set(urls.map(u => ({ raw: u, host: hostOf(u) }))
    .filter(({ host }) => !host || !allowed.some(pattern => hostMatch(pattern, host)))
    .map(({ raw, host }) => host || raw))];
  if (blocked.length) fail('scope', `${what} targets host(s) outside this connection's allowlist: ${blocked.join(', ')}. Ask the user to add the host under Relay → AI → 允许的主机, then retry.`);
}
function parsedDraft(draft) {
  const out=clone(draft);
  if(!out.name)delete out.name;
  if(!out.body)delete out.body;
  if(!out.settings)delete out.settings;
  const stripRows=rows=>(rows||[]).map(({key,value,enabled,description,kind})=>{if(kind==='file')fail('invalid','Configure file uploads in Relay');return {key,value,enabled,description};});
  for(const key of ['headers','params'])out[key]=stripRows(out[key]);
  if(out.body){delete out.body.file;out.body.form=stripRows(out.body.form);out.body.urlencoded=stripRows(out.body.urlencoded);if(!out.body.raw)delete out.body.raw;}
  if(out.settings?.timeoutMs===null)delete out.settings.timeoutMs;
  return draftPatch(out);
}
function rows(value,label='rows') {
  if(!Array.isArray(value)||value.length>300)fail('invalid',`${label} must contain at most 300 rows`);
  return value.map(row=>{fields(row,['key','value','enabled','description']);const key=text(row.key,'key',500),val=text(row.value??'','value',65536);if(val.includes('<redacted>'))fail('invalid','Do not write redaction placeholders');return {...kv(key,val,text(row.description??'','description')),enabled:row.enabled!==false};});
}
function draftPatch(value) {
  fields(value,['name','method','url','params','headers','body','settings','checks','extractors','subprotocols']);
  const draft=clone(value);
  if('name'in draft)draft.name=nameOf(draft.name);
  if('method'in draft && !/^[A-Z]{1,20}$/.test(draft.method))fail('invalid','Invalid HTTP method');
  if('url'in draft){text(draft.url,'url',16384);if(!draft.url.trim()||draft.url.includes('<redacted>'))fail('invalid','Invalid URL');}
  for(const key of ['params','headers'])if(key in draft)draft[key]=rows(draft[key]);
  if('body'in draft){const body=fields(draft.body,['mode','raw','urlencoded','form']);if(!['none','raw','urlencoded','form'].includes(body.mode))fail('invalid','Local file bodies are configured in Relay');const out=newBody(body.mode);if(body.mode==='raw'){fields(body.raw,['language','content']);if(!['json','text','xml','html','javascript'].includes(body.raw.language))fail('invalid','Unsupported body language');out.raw={language:body.raw.language,content:text(body.raw.content,'body',1048576)};}for(const key of ['urlencoded','form'])if(key in body)out[key]=rows(body[key]);draft.body=out;}
  if('settings'in draft){fields(draft.settings,['timeoutMs','followRedirects','sslVerify','cookieJar','proxy','maxRedirects']);if(draft.settings.timeoutMs!==undefined&&(!Number.isFinite(draft.settings.timeoutMs)||draft.settings.timeoutMs<0||draft.settings.timeoutMs>300000))fail('invalid','timeoutMs: 0–300000');for(const key of ['followRedirects','sslVerify','cookieJar'])if(key in draft.settings&&typeof draft.settings[key]!=='boolean')fail('invalid',`${key} must be boolean`);if(draft.settings.proxy!=null)text(draft.settings.proxy,'proxy',2000);}
  if('checks'in draft){if(!Array.isArray(draft.checks)||draft.checks.length>100)fail('invalid','At most 100 checks');for(const rule of draft.checks){fields(rule,['kind','operator','path','expected','enabled']);if(!['status','time','json'].includes(rule.kind))fail('invalid','Invalid check kind');if(rule.kind==='json'&&!['exists','equals','type'].includes(rule.operator))fail('invalid','Invalid JSON operator');if(rule.path!==undefined)text(rule.path,'path',2000);if(rule.expected!==undefined)text(rule.expected,'expected',65536);}}
  if('extractors'in draft){if(!Array.isArray(draft.extractors)||draft.extractors.length>100)fail('invalid','At most 100 extractors');for(const rule of draft.extractors){fields(rule,['name','path','source','header','enabled']);nameOf(rule.name);if(rule.path!==undefined)text(rule.path,'path',2000);if(rule.source!==undefined&&!['json','header'].includes(rule.source))fail('invalid','Invalid extraction source');if(rule.header!==undefined)text(rule.header,'header',500);}}
  if('subprotocols'in draft&&(!Array.isArray(draft.subprotocols)||draft.subprotocols.some(v=>typeof v!=='string')))fail('invalid','Invalid subprotocols');
  return draft;
}
function authPatch(value) {
  fields(value,['kind','bearer','basic','apikey']);
  if(!['inherit','noauth','bearer','basic','apikey'].includes(value.kind))fail('invalid','Invalid auth');
  const auth={...newAuth(),kind:value.kind};
  for(const [key,allowed] of [['bearer',['token']],['basic',['username','password']],['apikey',['key','value','addTo']]])if(value[key]){fields(value[key],allowed);for(const [field,val]of Object.entries(value[key])){text(val,field,65536);if(val.includes('<redacted>'))fail('invalid','Do not write redaction placeholders');auth[key][field]=val;}}
  if(!['query','header'].includes(auth.apikey.addTo))fail('invalid','Invalid API key location');return auth;
}
function normalizeQuery(draft, patch, creating) {
  if('params' in patch){
    const declared=new Set(draft.params.map(row=>row.key));
    for(const pair of splitQuery(draft.url).pairs)if(!declared.has(pair.key))draft.params.push(kv(pair.key,pair.value));
    syncUrlFromParams({draft});
  }else if('url' in patch || creating)syncParamsFromUrl({draft});
}
async function persist(domain, mutate, rollback) {
  mutate();touch(domain);
  const writeRevision=saveState(domain).revision;
  // Switch editors to the committed objects before yielding to disk I/O. Their
  // input handlers must never keep writing to a detached, replaced document.
  emit('tree');emit('pane');emit('tabs');emit('rerender');
  try{await flushDomain(domain,{strict:true});}
  catch(error){if(saveState(domain).revision===writeRevision){rollback();touch(domain);}emit('tree');emit('rerender');fail('persistence','Save failed; read current content and persistence status before retrying');}
  emit('tree');emit('pane');emit('tabs');emit('rerender');
}
function jobStart(meta, execute, cancel) {
  if([...jobs.values()].filter(job=>job.state==='running').length>=8)fail('busy','Too many running jobs');
  for(const [id,job]of jobs)if(jobs.size>=50 && job.state!=='running')jobs.delete(id);
  const job={id:uid('job'),state:'running',startedAt:Date.now(),...meta};jobs.set(job.id,job);job.cancel=cancel;
  Promise.resolve().then(execute).then(result=>{if(job.state!=='cancelled'){job.state='completed';job.result=result;}}).catch(error=>{if(job.state!=='cancelled'){job.state='failed';job.error={code:error.code||'execution',message:String(error.message||error)};}}).finally(()=>{job.finishedAt=Date.now();delete job.cancel;});
  return {jobId:job.id,state:job.state};
}
function jobView(job){const {cancel,...copy}=job;return redacted(copy,job._secrets||[]);}
export async function dispatch(command) {
  fields(command,['action','id','type','expectedRevision','data','collectionId','documentId','requestId','format']);
  if(!actions.includes(command.action))fail('invalid','Unknown action');
  for(const key of ['id','collectionId','documentId','requestId'])idOf(command[key]);
  const {action,id,data={}}=command;
  if(action==='workspace.list'){const c=await api.invoke('automation_status');return {apiVersion:2,scope:c?.scope||'read',allowedHosts:c?.allowedHosts||[],actions:reachableActions(c?.scope||'read'),activeEnvironmentId:state.settings.activeEnvironmentId,collections:state.collections.map(c=>({id:c.id,name:c.name,revision:revision(c),requests:listRequests(c)})),environments:state.environments.map(e=>({id:e.id,name:e.name,revision:revision(e)})),documents:state.docs.map(d=>({id:d.id,name:d.name,revision:revision(d),endpoints:d.blocks.filter(b=>b.type==='req').map(b=>({id:b.id,sourceId:b.sourceId,status:endpointStatus(b)}))})),runners:state.runners.map(r=>({id:r.id,name:r.name,revision:revision(r)}))};}
  if(action==='entity.get'){const value=entity(command.type,id);const result=resultEntity(value);if(command.type==='document')result.endpoints=value.blocks.filter(b=>b.type==='req').map(b=>({id:b.id,fields:redacted(endpointFields(b)),status:endpointStatus(b),issues:reviewIssues(b)}));return result;}
  if(action==='entity.open'){const value=entity(command.type,id);if(command.type==='request'){openRequest(value);state.pane='collections';}else if(command.type==='document'){openDoc(value);state.pane='docs';}else if(command.type==='runner'){openRunner(value);state.pane='runner';}else fail('invalid','Open a request, document or runner');state.overviewPane=false;emit('pane');emit('rerender');return {opened:id};}
  if(action==='collection.upsert'){
    fields(data,['name','description']);const existing=id?findNode(id)?.node:null;if(existing&&existing.kind!=='collection')fail('invalid','Id belongs to another entity');checkRevision(existing,command.expectedRevision);
    const next={...(existing||newCollection())};if(id)next.id=id;next.name=nameOf(data.name??next.name);if('description'in data)next.description=text(data.description,'description');
    await replace('collections',existing,next);return resultEntity(next);
  }
  if(action==='environment.upsert'){
    fields(data,['name','variables']);const existing=state.environments.find(e=>e.id===id);checkRevision(existing,command.expectedRevision);const next=clone(existing||newEnvironment());if(id)next.id=id;next.name=nameOf(data.name??next.name);if('variables'in data)next.variables=rows(data.variables);
    await replace('environments',existing,next);emit('environment');return resultEntity(next);
  }
  if(action==='request.upsert'){
    fields(data,['name','description','draft','auth','protocol','curl']);const existing=id?findNode(id)?.node:null;if(existing&&!['request','ws'].includes(existing.kind))fail('invalid','Id belongs to another entity');checkRevision(existing,command.expectedRevision);if(existing)busyRequest(existing);
    let parent=existing?findNode(existing.id).parent:entity('collection',command.collectionId);if(!parent?.children)fail('invalid','collectionId required');
    let patch=data.draft?draftPatch(data.draft):{};
    if(data.curl){if(data.draft)fail('invalid','Use curl or draft');const parsed=await api.parseCurl(text(data.curl,'curl',1048576));if(parsed.length!==1)fail('invalid','One cURL per request');patch=parsedDraft(parsed[0].draft);if(existing&&findNode(id)?.node!==existing)fail('conflict','Request changed while parsing');checkRevision(existing,command.expectedRevision);if(existing)busyRequest(existing);parent=existing?findNode(existing.id).parent:entity('collection',command.collectionId);}
    const next=clone(existing||newRequestNode());if(id)next.id=id;next.name=nameOf(data.name??patch.name??next.name);next.request=newRequestNode(next.name,{...next.request,...patch,name:next.name}).request;if(!next.request.url)fail('invalid','Request URL required');if(data.auth)next.auth=authPatch(data.auth);if('description'in data)next.description=text(data.description,'description');next.protocol=data.protocol??existing?.protocol??inferProtocol(next.request);if(!['http','sse','ws'].includes(next.protocol))fail('invalid','Invalid protocol');next.kind=next.protocol==='ws'?'ws':'request';
    normalizeQuery(next.request,patch,!existing);
    const index=existing?parent.children.indexOf(existing):-1;
    await persist('collections',()=>index<0?parent.children.push(next):parent.children.splice(index,1,next),()=>index<0?parent.children.splice(parent.children.indexOf(next),1):parent.children.splice(index,1,existing));
    for(const tab of state.tabs.filter(t=>t.refId===next.id&&!t.dirty&&!t.running&&!['opening','open','closing'].includes(t.ws?.status))){tab.draft=clone(next.request);tab.auth=clone(next.auth);tab.protocol=next.protocol;tab.kind=next.kind;tab.title=next.name;tab.description=next.description||'';tab.response=null;tab.lastRequestSnapshot=null;}
    for(const doc of state.docs){let changed=false;for(const block of doc.blocks.filter(b=>b.sourceId===next.id)){block.draft=clone(next.request);block.auth=clone(next.auth);contractOf(block).reviewed=false;changed=true;}if(changed)touch('docs');}
    touch('tabs');emit('rerender');return resultEntity(next);
  }
  if(action==='document.upsert'){
    fields(data,['name','overview','version']);const existing=state.docs.find(d=>d.id===id);checkRevision(existing,command.expectedRevision);if(existing)busyDocument(existing);const next=clone(existing||newDoc());if(id)next.id=id;next.name=nameOf(data.name??next.name);for(const key of ['overview','version'])if(key in data)next[key]=text(data[key],key,key==='version'?80:65536);next.updatedAt=Date.now();
    await replace('docs',existing,next);return resultEntity(next);
  }
  if(action==='document.endpoint.upsert'){
    fields(data,['summary','description','notes','fields']);const doc=entity('document',command.documentId);checkRevision(doc,command.expectedRevision);busyDocument(doc);
    const node=entity('request',command.requestId);if(node.protocol!=='http')fail('unsupported','Delivery verification currently supports HTTP');busyRequest(node);
    const next=clone(doc);let block=next.blocks.find(b=>id?b.id===id:b.sourceId===node.id);if(block&&block.type!=='req')fail('conflict','Id belongs to a text block');if(block?.sourceId&&block.sourceId!==node.id)fail('conflict','Endpoint already links another request');if(!block){block=newReqBlock();if(id)block.id=id;next.blocks.push(block);}
    block.sourceId=node.id;block.draft=clone(node.request);block.auth=clone(node.auth);const contract=contractOf(block);for(const key of ['summary','description','notes'])if(key in data)contract[key]=text(data[key],key,65536);
    if(data.fields){object(data.fields,'fields');const available=new Set(endpointFields(block).map(f=>f.id));for(const [key,meta]of Object.entries(data.fields)){if(!available.has(key))fail('invalid',`Unknown field ${key}; verify first for response fields`);fields(meta,['description','required']);if(meta.required!==undefined&&meta.required!==null&&typeof meta.required!=='boolean')fail('invalid','required must be boolean or null');contract.fields[key]={...contract.fields[key],...meta,description:text(meta.description??contract.fields[key]?.description??'','description')};}}
    contract.reviewed=false;next.updatedAt=Date.now();next.activeBlockId=block.id;
    // Reuse real execution evidence if the linked request ran through this API/UI.
    const tab=state.tabs.find(t=>t.refId===node.id&&!t.dirty&&t.response&&t.lastRequestSnapshot);
    if(!block.verified&&tab){const {captureVerification}=await import('./delivery.js');captureVerification(block,tab.lastRequestSnapshot.template,tab.lastRequestSnapshot,tab.response);}
    checkRevision(doc,command.expectedRevision);await replace('docs',doc,next);return {...resultEntity(next),endpointId:block.id,fields:redacted(endpointFields(block)),issues:reviewIssues(block)};
  }
  if(action==='runner.upsert'){
    fields(data,['name','sources','stopOnError','delayMs']);const existing=state.runners.find(r=>r.id===id);checkRevision(existing,command.expectedRevision);if(existing&&sessionOf(id))fail('busy','Runner is active');const next=clone(existing||newRunner());if(id)next.id=id;next.name=nameOf(data.name??next.name);if(data.sources){if(!Array.isArray(data.sources)||data.sources.length>300)fail('invalid','At most 300 sources');for(const source of data.sources){idOf(source);if(!findNode(source))fail('not_found',`Missing source ${source}`);}next.sources=clone(data.sources);}if('stopOnError'in data){if(typeof data.stopOnError!=='boolean')fail('invalid','stopOnError must be boolean');next.stopOnError=data.stopOnError;}if('delayMs'in data){if(!Number.isFinite(data.delayMs)||data.delayMs<0||data.delayMs>60000)fail('invalid','Invalid delay');next.delayMs=data.delayMs;}
    await replace('runners',existing,next);return resultEntity(next);
  }
  if(action==='request.execute'){
    fields(data,[]);const node=entity('request',id);busyRequest(node);if(node.protocol!=='http')fail('unsupported','Automatic execution currently supports HTTP; open SSE/WS in Relay');
    const shell={refId:node.id,draft:clone(node.request),auth:clone(node.auth),protocol:'http'},built=buildSendDraft(shell,{environment:activeEnv()?clone(activeEnv()):null});if(built.missing.length)fail('variables',`Missing variables: ${built.missing.join(', ')}`);await requireHosts([built.draft.url],'This request');const snapshot=requestSnapshot(shell,built),execId=uid('ai');
    let cancelled=false;
    return jobStart({action,requestId:id},async()=>{
      const response=await api.execute(built.draft,execId);response.checkResult=evaluateChecks(built.preparedChecks,response);
      if(cancelled)return {ok:false,cancelled:true};
      let tab=state.tabs.find(t=>t.refId===id);if(!tab){tab=openRequest(node);state.pane='collections';state.overviewPane=false;emit('pane');}if(!tab.dirty&&!tab.running){tab.response=response;tab.lastRequestSnapshot=snapshot;touch('tabs');}
      emit('request-completed',{tab:{...shell,id:tab.id},shell:snapshot.template,built:snapshot,response});await flushDomain('docs',{strict:true});emit('rerender');
      return {request:redacted(snapshot,snapshot.secrets),response:redacted(response,snapshot.secrets),ok:response.checkResult.ok};
    },()=>{cancelled=true;api.cancel(execId).catch(()=>{});});
  }
  if(action==='document.verify'){
    fields(data,[]);const doc=entity('document',id);busyDocument(doc);const blocks=doc.blocks.filter(b=>b.type==='req');if(!blocks.length)fail('invalid','Document has no endpoints');const docUrls=[];for(const block of blocks){if(block.sourceId)busyRequest(entity('request',block.sourceId));const built=buildSendDraft({draft:block.draft,auth:block.auth,refId:block.sourceId});if(built.missing.length)fail('variables',`Missing variables: ${built.missing.join(', ')}`);docUrls.push(built.draft.url);}
    // Refuse the whole document up front. Checking per-endpoint mid-run would send
    // the allowed ones first and stop at the first blocked host, which is a partial
    // verification that still looks like a run happened.
    await requireHosts(docUrls,'This document');
    let cancelled=false;return jobStart({action,documentId:id},async()=>{const endpoints=[];for(const block of blocks){if(cancelled)break;await runBlock(doc,block);endpoints.push({id:block.id,status:endpointStatus(block),response:redacted(block.response,block.lastRequestSnapshot?.secrets||[]),issues:reviewIssues(block)});}await flushDomain('docs',{strict:true});return {endpoints,revision:revision(doc),ok:endpoints.length===blocks.length&&endpoints.every(e=>['verified','ready'].includes(e.status.kind))};},()=>{cancelled=true;for(const block of blocks)if(block.running)cancelBlock(doc,block);});
  }
  if(action==='runner.execute'){
    fields(data,[]);const runner=entity('runner',id);if(sessionOf(id))fail('busy','Runner is active');const steps=stepsOf(runner);if(!steps.some(s=>!s.skip))fail('invalid','No executable requests');for(const step of steps)busyRequest(step.node);
    await requireHosts(steps.filter(step=>!step.skip).map(step=>buildSendDraft({draft:step.node.request,auth:step.node.auth,refId:step.node.id},{environment:activeEnv()?clone(activeEnv()):null}).draft.url),'This runner');
    return jobStart({action,runnerId:id},async()=>{const run=await runRunner(runner,{trigger:'AI'});await flushDomain('runs',{strict:true});return {run:redacted(run),ok:!!run&&!run.cancelled&&run.totals.failed===0&&run.totals.passed>0};},()=>stopRunner(id));
  }
  if(action==='job.get'||action==='job.cancel'){
    const job=jobs.get(id);if(!job)fail('not_found','Job not found in this session');if(action==='job.cancel'&&job.state==='running'){job.cancel?.();job.state='cancelled';job.finishedAt=Date.now();}return jobView(job);
  }
  if(action==='document.export'){
    const doc=entity('document',id);if(doc.blocks.some(b=>b.running||b.preparing))fail('busy','Wait for validation');const format=command.format||'markdown';if(!['markdown','openapi','html'].includes(format))fail('invalid','Unsupported format');const content=format==='markdown'?deliveryMarkdown(doc):format==='html'?deliveryHtml(doc):JSON.stringify(deliveryOpenApi(doc),null,2);
    return {name:doc.name,format,content,review:doc.blocks.filter(b=>b.type==='req').map(b=>({id:b.id,status:endpointStatus(b),issues:reviewIssues(b)})),revision:revision(doc)};
  }
}
function listRequests(parent){return (parent.children||[]).flatMap(n=>n.children?listRequests(n):[{id:n.id,name:n.name,protocol:n.protocol||'http',method:n.request?.method,revision:revision(n)}]);}
async function replace(domain,existing,next){const list=state[domain],index=existing?list.indexOf(existing):-1;await persist(domain,()=>index<0?list.push(next):list.splice(index,1,next),()=>index<0?list.splice(list.indexOf(next),1):list.splice(index,1,existing));}
export async function installAutomation() {
  if(connected || !window.__TAURI__?.event?.listen)return;
  connected=true;
  await window.__TAURI__.event.listen('relay-automation',event=>{
    const {id,instanceId,command}=event.payload;
    queue=queue.catch(()=>{}).then(async()=>{
      let result;
      try{const status=await api.invoke('automation_status');if(status?.instanceId!==instanceId)fail('disabled','Connection closed');result={ok:true,data:await dispatch(command)};}
      catch(error){result={ok:false,error:{code:error.code||'invalid',message:String(error.message||error)}};}
      await api.invoke('automation_reply',{id,instanceId,result});
    });
  });
}
const SCOPE_OPTIONS = [['read', '只读'], ['write', '可编辑'], ['execute', '可执行']];
const SCOPE_LABEL = { read: '只读', write: '可编辑', execute: '可执行' };
const parseHosts = raw => [...new Set(String(raw || '').split(/[\s,;]+/)
  .map(h => h.trim().replace(/^https?:\/\//, '').replace(/[/:].*$/, '').toLowerCase())
  .filter(h => /^[a-z0-9*.-]+$/.test(h) && h.includes('.')))].slice(0, 64);

export async function openAutomationDialog() {
  const body = el('div', { class: 'ai-connection-body' });
  const error = el('p', { class: 'variable-form-error', role: 'alert' });
  const draw = async () => {
    error.textContent = '';
    let connection = null;
    try { connection = await api.invoke('automation_status'); } catch { /* not available outside the app */ }
    body.replaceChildren(connection ? connectedView(connection) : startView());
  };
  const connectedView = connection => {
    const scope = SCOPE_LABEL[connection.scope] || connection.scope || '只读';
    const limit = connection.scope === 'execute'
      ? ` · 仅 ${(connection.allowedHosts || []).join(' / ') || '无主机'}` : '';
    return el('div', { class: 'stack' }, [
      el('div', { class: 'ai-connection-card' }, [
        el('span', { class: 'ai-connection-symbol', 'aria-hidden': 'true' }, [icon('braces')]),
        el('div', {}, [
          el('span', { class: 'ai-connection-state connected', text: '已连接 · 仅本机' }),
          el('code', { class: 'ai-connection-address', text: connection.baseUrl }),
          // The grant is shown where the credential is copied from, so the person
          // handing the file to an AI tool sees what they are handing over.
          el('span', { class: 'ai-connection-scope', text: `权限：${scope}${limit}` }),
        ]),
      ]),
      el('div', { class: 'ai-connection-actions' }, [
        el('button', { class: 'btn primary', text: '保存连接配置', onclick: () => saveAs({ name: 'relay-connection.json', text: JSON.stringify(connection, null, 2), extensions: ['json'] }) }),
        el('button', { class: 'btn', text: '复制配置', onclick: () => copy(JSON.stringify(connection, null, 2)) }),
        el('button', { class: 'btn ghost', text: '断开', onclick: async () => { await api.invoke('automation_stop'); await draw(); } }),
      ]),
    ]);
  };
  function startView() {
    let scope = 'write';
    // Prefill from the environment the user is actually working in; a blank box
    // here would just be refused on submit.
    const guess = hostOf(activeEnv()?.defaults?.baseUrl || '') || '';
    const hosts = el('input', { class: 'input mono', placeholder: 'api.test 或 *.example.com', value: guess, disabled: true });
    const hostField = el('div', { class: 'field ai-connection-hosts' }, [
      el('label', { text: '允许的主机' }), hosts,
      el('span', { class: 'hint', text: '逗号或换行分隔，* 开头匹配子域。AI 只能向这些地址发请求。' }),
    ]);
    const seg = segmented(SCOPE_OPTIONS, scope, value => {
      scope = value;
      hosts.disabled = value !== 'execute';
      hostField.classList.toggle('muted', value !== 'execute');
    });
    return el('div', { class: 'stack' }, [
      el('div', { class: 'ai-connection-card' }, [
        el('span', { class: 'ai-connection-symbol', 'aria-hidden': 'true' }, [icon('braces')]),
        el('div', {}, [
          el('span', { class: 'ai-connection-state', text: '未开启' }),
          el('code', { class: 'ai-connection-address', text: '开启后，AI 工具可操作当前工作区' }),
        ]),
      ]),
      el('div', { class: 'field' }, [el('label', { text: '权限' }), seg,
        el('span', { class: 'hint', text: '只读：查看集合与文档。可编辑：另可创建和修改。可执行：另可真实发送请求。' })]),
      hostField,
      el('div', { class: 'ai-connection-actions' }, [
        el('button', { class: 'btn primary', text: '开启 AI 连接', onclick: async () => {
          const allowed = scope === 'execute' ? parseHosts(hosts.value) : [];
          if (scope === 'execute' && !allowed.length) { error.textContent = '可执行需要至少填一个允许的主机'; hosts.focus(); return; }
          try { await api.invoke('automation_start', { scope, allowedHosts: allowed }); await draw(); }
          catch (e) { error.textContent = String(e?.message || e); }
        } }),
      ]),
    ]);
  }
  modal({ title: 'AI 连接', width: 600, cancelText: '关闭', body: [body, el('p', { class: 'hint', text: '连接配置包含访问凭证，关闭应用后失效。默认不给执行权。' }), error] });
  try { await draw(); } catch { error.textContent = '请在 Relay 应用中开启连接'; }
}
