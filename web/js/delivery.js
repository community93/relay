import { requestUrl, requestCurl } from './preview.js';
import { buildSendDraft } from './state.js';

export const SECRET_KEY = /authorization|cookie|token|secret|password|credential|api[-_]?key/i;
export const clone = value => JSON.parse(JSON.stringify(value));
export const fingerprint = (draft, auth) => {
  const copy=clone(draft || {});delete copy.name;
  if(!copy.checks?.length)delete copy.checks;
  if(!copy.extractors?.length)delete copy.extractors;
  for(const rows of [copy.params,copy.headers,copy.body?.form,copy.body?.urlencoded])for(const row of rows || []){delete row.id;delete row.description;}
  return JSON.stringify([copy, auth || {kind:'noauth'}]);
};

function executionSignature(built) {
  const draft=clone(built.draft),auth=clone(built.auth || {});delete draft.name;
  let text=fingerprint(draft,auth)+JSON.stringify([built.environment,built.missing || []]);
  if(built.preparedChecks?.checks.length || built.preparedChecks?.extractors.length)text+=JSON.stringify(built.preparedChecks);
  for(const variable of built.variables || [])if(variable.key.startsWith('$')&&variable.value)text=text.split(JSON.stringify(variable.value).slice(1,-1)).join(`{{${variable.key}}}`);
  let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return (hash>>>0).toString(16);
}

function verificationChanged(block) {
  if(!block.verified)return false;
  if(block.verified.fingerprint!==fingerprint(block.draft,block.auth))return true;
  if(block.verified.contextSignature)try{return executionSignature(buildSendDraft({draft:block.draft,auth:block.auth,refId:block.sourceId || null}))!==block.verified.contextSignature;}catch{return true;}
  return false;
}

export function contractOf(block) {
  return block.contract || (block.contract = { summary: block.draft?.name || '', description: '', fields: {}, reviewed: false });
}

export function scrub(value, secrets = [], key = '') {
  if (SECRET_KEY.test(key) && value !== undefined && value !== '') return '<redacted>';
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, scrub(item, secrets, name)]));
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length)) text = text.split(secret).join('<redacted>');
    return text;
  }
  return value;
}

export function requestSecrets(draft) {
  const secrets = [];
  for (const row of draft.headers || []) if (SECRET_KEY.test(row.key)) {
    secrets.push(row.value);
    const value=String(row.value || '').trim();secrets.push(value);
    if (/^Bearer\s+/i.test(value)) secrets.push(value.replace(/^Bearer\s+/i,''));
  }
  for (const row of draft.params || []) if (SECRET_KEY.test(row.key)) secrets.push(row.value);
  return secrets.filter(value => value && !value.includes('{{'));
}

export function captureVerification(block, shell, built, response) {
  block.response = clone(response);
  block.view='response';
  block.lastRunAt = Date.now();
  const contract = contractOf(block);contract.reviewed = false;
  const secrets = requestSecrets(built.draft);
  secrets.push(...(built.secrets || []));
  for(const row of built.variables || [])if(SECRET_KEY.test(row.key) && row.value)secrets.push(String(row.value));
  for(const row of response.checkResult?.extractions || [])if(row.ok && row.value)secrets.push(row.value);
  if(response.status>0) {
    block.examples=block.examples || [];
    const sample={status:response.status,at:Date.now(),bodyText:safeResponse(response.bodyText || '',secrets),contentType:response.contentType || 'application/json'};
    block.examples=block.examples.filter(item=>item.status!==response.status).concat(sample).slice(-5);
  }
  if (!response.error && (response.checkResult ? response.checkResult.ok : response.status >= 200 && response.status < 300)) {
    block.verified = {
      at: Date.now(), environment: built.environment, fingerprint: fingerprint(shell.draft, shell.auth),
      contextSignature:executionSignature(built),
      auth: {kind:built.auth?.kind || built.authKind || shell.auth?.kind || 'noauth',...(built.auth?.kind==='apikey'?{apikey:{key:built.auth.apikey.key,addTo:built.auth.apikey.addTo}}:{})},
      request: scrub(clone(built.draft), secrets), response: scrub(clone(response), secrets),
      bodyText: safeResponse(response.bodyText || '', secrets),
    };
    block.verified.response.bodyText=block.verified.bodyText;
  }
}

export function safeResponse(text, secrets = []) {
  try { return JSON.stringify(scrub(JSON.parse(text), secrets), null, 2); }
  catch { return scrub(text, secrets); }
}

function valueType(value) {return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value === 'object' ? 'object' : typeof value;}

export function schemaFromSample(value, depth = 0) {
  if (depth > 12) return {};
  if (value === null) return {nullable:true};
  const type=valueType(value);
  if (type==='array') return {type:'array',items:value.length ? mergeSchemas(value.slice(0,20).map(item=>schemaFromSample(item,depth+1))) : {}};
  if (type==='object') return {type:'object',properties:Object.fromEntries(Object.entries(value).map(([key,item])=>[key,schemaFromSample(item,depth+1)]))};
  return {type};
}

function mergeSchemas(schemas) {
  const actual=schemas.filter(s=>s.type),nullable=schemas.some(s=>s.nullable);
  const types=[...new Set(actual.map(s=>s.type))];
  if (types.length>1) return {anyOf:types.map(type=>mergeSchemas(actual.filter(s=>s.type===type))),...(nullable?{nullable:true}:{})};
  if (!types.length) return nullable ? {nullable:true} : {};
  const type=types[0],result={type,...(nullable?{nullable:true}:{})};
  if(type==='object') {
    const keys=[...new Set(actual.flatMap(s=>Object.keys(s.properties||{})))];
    result.properties=Object.fromEntries(keys.map(key=>[key,mergeSchemas(actual.map(s=>s.properties?.[key]).filter(Boolean))]));
  }
  if(type==='array')result.items=mergeSchemas(actual.map(s=>s.items));
  return result;
}

export function sampleFields(value, prefix = '', rows = [], depth = 0) {
  if(depth>10 || rows.length>=250)return rows;
  if(Array.isArray(value)) {
    for(const item of value.slice(0,20))sampleFields(item,`${prefix}[]`,rows,depth+1);
  } else if(value && typeof value==='object') {
    for(const [key,item] of Object.entries(value)) {
      const path=prefix?`${prefix}.${key}`:key;
      const found=rows.find(row=>row.path===path),type=valueType(item);
      if(found){if(!found.type.split(' / ').includes(type))found.type+=` / ${type}`;}
      else rows.push({path,type,example:SECRET_KEY.test(key)?'<redacted>':typeof item==='object'?item===null?'null':Array.isArray(item)?`[${item.length}]`:'{…}':String(item)});
      if(item && typeof item==='object')sampleFields(item,path,rows,depth+1);
    }
  }
  return rows;
}

export function endpointFields(block) {
  const draft=block.draft || {},rows=[];
  for(const group of ['params','headers'])for(const row of draft[group]||[])if(row.enabled!==false&&row.key)rows.push({id:`${group}:${row.key}`,path:row.key,group:group==='params'?'Query':'Header',type:'string',example:SECRET_KEY.test(row.key)?'<redacted>':row.value,description:row.description || ''});
  const body=draft.body;
  if(body?.mode==='raw')try {for(const row of sampleFields(JSON.parse(body.raw.content)))rows.push({...row,id:`body:${row.path}`,group:'Body'});}catch{}
  if(body?.mode==='form'||body?.mode==='urlencoded')for(const row of body[body.mode]||[])if(row.enabled!==false&&row.key)rows.push({id:`body:${row.key}`,path:row.key,group:'Body',type:row.kind==='file'?'file':'string',example:SECRET_KEY.test(row.key)?'<redacted>':row.value});
  if(block.verified?.bodyText)try {for(const row of sampleFields(JSON.parse(block.verified.bodyText)))rows.push({...row,id:`response:${row.path}`,group:'Response'});}catch{}
  return rows;
}

export function endpointStatus(block) {
  const contract=contractOf(block);
  if(block.running)return {label:'运行中',kind:'running'};
  if(block.parseError)return {label:'解析失败',kind:'failed'};
  if(block.verified&&!block.sourceId&&block.curl&&block.parsedCurl===null)return {label:'需重新验证',kind:'stale'};
  if(block.response?.checkResult?.outcome==='cancelled')return {label:'已取消',kind:'failed'};
  if(block.response?.checkResult && !block.response.checkResult.ok)return {label:block.response.error?'运行失败':'检查未通过',kind:'failed'};
  if(verificationChanged(block))return {label:'需重新验证',kind:'stale'};
  if(block.response && (block.response.error || (!block.response.checkResult && block.response.status>=400) || !block.response.status))return {label:'运行失败',kind:'failed'};
  if(!block.verified)return {label:'未验证',kind:'draft'};
  if(contract.reviewed)return {label:'可交付',kind:'ready'};
  return {label:'已验证 · 待补充',kind:'verified'};
}

export function reviewIssues(block) {
  const contract=contractOf(block),issues=[];
  if(!block.verified)issues.push('验证响应样例');
  else if(verificationChanged(block))issues.push('重新验证');
  if(block.response?.checkResult && !block.response.checkResult.ok)issues.push('检查未通过，需重新验证');
  if(!contract.summary.trim())issues.push('接口名称');
  if(!contract.description.trim())issues.push('业务说明');
  const missing=endpointFields(block).filter(row=>!SECRET_KEY.test(row.path)&&!(contract.fields[row.id]?.description || row.description || '').trim());
  if(missing.length)issues.push(`${missing.length} 个字段说明`);
  const unconfirmed=endpointFields(block).filter(row=>row.group!=='Response'&&!SECRET_KEY.test(row.path)&&typeof contract.fields[row.id]?.required!=='boolean');
  if(unconfirmed.length)issues.push(`${unconfirmed.length} 个必填规则`);
  return issues;
}

const cell=value=>String(value??'').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
const fenced=(text,lang='')=>{const fence='`'.repeat(Math.max(3,...(String(text).match(/`+/g)||[]).map(x=>x.length+1)));return `${fence}${lang}\n${text}\n${fence}`;};

export function endpointMarkdown(block,index,{bodyOnly=false}={}) {
  const contract=contractOf(block),draft=block.draft,verified=block.verified;
  if(!draft)return bodyOnly?'待解析 cURL。':`## ${index+1}. ${contract.summary || '未解析接口'}\n\n待解析 cURL。`;
  const secrets=requestSecrets(draft),parts=bodyOnly?[contract.description || '业务说明：待补充']:[`## ${index+1}. ${cell(contract.summary || draft.name || '未命名接口')}`,`**${draft.method || 'GET'}** \`${cell(scrub(draft.url,secrets))}\``, `状态：${endpointStatus(block).label}`,contract.description || '业务说明：待补充'];
  const fields=endpointFields(block);
  for(const group of ['Query','Header','Body','Response']) {
    const items=fields.filter(row=>row.group===group);if(!items.length)continue;
    parts.push(`### ${group==='Response'?'响应字段':`${group} 字段`}`, '| 字段 | 类型 | 必填 | 示例 | 说明 |\n| --- | --- | --- | --- | --- |\n'+items.map(row=>{
      const meta=contract.fields[row.id]||{};
      return `| ${cell(row.path)} | ${cell(row.type)} | ${group==='Response'?'—':meta.required===true?'是':meta.required===false?'否':'待确认'} | ${cell(scrub(row.example,secrets))} | ${cell(meta.description || row.description || '待补充')} |`;
    }).join('\n'));
  }
  if(draft.body?.mode==='raw')parts.push('### 请求 Body',fenced(safeResponse(draft.body.raw.content,secrets),draft.body.raw.language||'text'));
  parts.push('### 请求示例',fenced(scrub(requestCurl(draft),secrets),'bash'));
  if(verified){parts.push('### 已验证响应',`HTTP ${verified.response.status} · ${verified.response.timeMs || 0} ms · ${cell(verified.environment)} · ${new Date(verified.at).toISOString()}`,fenced(verified.bodyText,'json'));}
  else parts.push('### 响应样例','待运行验证。');
  if(contract.notes)parts.push('### 交付备注',contract.notes);
  for(const example of (block.examples || []).filter(item=>item.status>=400))parts.push(`### 错误响应 ${example.status}`,fenced(example.bodyText,'json'));
  return parts.join('\n\n');
}

export function deliveryMarkdown(doc) {
  return [`# ${doc.name || '接口交付文档'}`,doc.overview || '',...doc.blocks.map((block,index)=>block.type==='req'?endpointMarkdown(block,index):String(block.text||'').trim())].filter(Boolean).join('\n\n')+'\n';
}

export function deliveryOpenApi(doc) {
  const result={openapi:'3.0.3',info:{title:doc.name || 'API',version:doc.version || '1.0.0',description:doc.overview || ''},paths:{}};
  const servers=new Set();
  for(const block of doc.blocks.filter(b=>b.type==='req'&&b.draft)) {
    const draft=block.draft,contract=contractOf(block),verified=block.verified;
    let pathname;
    const absolute=/^(https?:\/\/[^/]+)(\/[^?]*)?/i.exec(draft.url);
    if(absolute){pathname=absolute[2] || '/';if(!absolute[1].includes('{{'))servers.add(absolute[1]);}
    else pathname=draft.url.split('?')[0].replace(/^\{\{[^{}]+\}\}/,'')||'/';
    pathname=pathname.replace(/\{\{\s*([^{}]+)\s*\}\}/g,'{$1}');if(!pathname.startsWith('/'))pathname='/'+pathname;
    const operation={summary:contract.summary||draft.name||'',description:contract.description||'', 'x-relay-status':endpointStatus(block).label,parameters:[],responses:{}};
    const auth=block.auth?.kind==='inherit'?(verified?.auth || block.auth):block.auth || {},header=(draft.headers||[]).find(row=>row.enabled!==false&&String(row.key).trim().toLowerCase()==='authorization');
    const authorization=String(header?.value || '').trim();
    let schemeName,scheme;
    if(auth.kind==='bearer'||/^Bearer\s+/i.test(authorization)){schemeName='bearerAuth';scheme={type:'http',scheme:'bearer'};}
    else if(auth.kind==='basic'||/^Basic\s+/i.test(authorization)){schemeName='basicAuth';scheme={type:'http',scheme:'basic'};}
    else if(auth.kind==='apikey'&&auth.apikey?.key){schemeName=`apiKey_${auth.apikey.addTo}_${auth.apikey.key}`.replace(/[^a-zA-Z0-9_]/g,'_');scheme={type:'apiKey',in:auth.apikey.addTo==='query'?'query':'header',name:auth.apikey.key};}
    if(scheme){result.components=result.components||{securitySchemes:{}};result.components.securitySchemes[schemeName]=scheme;operation.security=[{[schemeName]:[]}];}
    const fields=endpointFields(block);
    for(const row of fields.filter(r=>r.group==='Query'||r.group==='Header')) {
      if(/authorization|cookie|host|content-length/i.test(row.path))continue;
      const meta=contract.fields[row.id]||{};operation.parameters.push({name:row.path,in:row.group==='Query'?'query':'header',required:meta.required===true,description:meta.description || row.description || '待确认',schema:{type:'string'},example:scrub(row.example,requestSecrets(draft))});
    }
    for(const match of pathname.matchAll(/\{([^{}]+)\}/g))operation.parameters.push({name:match[1],in:'path',required:true,schema:{type:'string'},description:'待确认'});
    if(draft.body?.mode==='raw'&&draft.body.raw.content) {
      let sample;try{sample=JSON.parse(safeResponse(draft.body.raw.content,requestSecrets(draft)));}catch{sample=scrub(draft.body.raw.content,requestSecrets(draft));}
      operation.requestBody={content:{[typeof sample==='object'?'application/json':'text/plain']:{schema:schemaFromSample(sample),example:sample}}};
      annotateSchema(operation.requestBody.content[Object.keys(operation.requestBody.content)[0]].schema,contract.fields,'body');
    } else if(['urlencoded','form'].includes(draft.body?.mode)) {
      const properties={};for(const row of draft.body[draft.body.mode]||[])if(row.enabled!==false&&row.key)properties[row.key]=row.kind==='file'?{type:'string',format:'binary'}:{type:'string'};
      const schema={type:'object',properties};annotateSchema(schema,contract.fields,'body');operation.requestBody={content:{[draft.body.mode==='form'?'multipart/form-data':'application/x-www-form-urlencoded']:{schema}}};
    }
    if(verified) {
      let sample;try{sample=JSON.parse(verified.bodyText);}catch{sample=verified.bodyText;}
      const schema=schemaFromSample(sample);annotateSchema(schema,contract.fields,'response');
      operation.responses[String(verified.response.status)]={description:'已观察到的响应',content:{[verified.response.contentType?.split(';')[0] || (typeof sample==='object'?'application/json':'text/plain')]:{schema,example:sample}}};
    } else operation.responses.default={description:'尚未验证'};
    for(const example of (block.examples || []).filter(item=>item.status>=400)) {
      let sample;try{sample=JSON.parse(example.bodyText);}catch{sample=example.bodyText;}
      operation.responses[String(example.status)]={description:'已观察到的错误响应',content:{[example.contentType.split(';')[0]]:{schema:schemaFromSample(sample),example:sample}}};
    }
    const method=(draft.method||'GET').toLowerCase();result.paths[pathname]=result.paths[pathname]||{};
    if(result.paths[pathname][method])throw new Error(`接口重复：${draft.method} ${pathname}，请合并后导出 OpenAPI`);
    result.paths[pathname][method]=operation;
  }
  result.servers=[...servers].map(url=>({url}));return result;
}

function annotateSchema(schema,fields,group,path='') {
  if(schema.anyOf)for(const branch of schema.anyOf)annotateSchema(branch,fields,group,path);
  if(schema.properties)for(const [key,item] of Object.entries(schema.properties)) {
    const next=path?`${path}.${key}`:key,meta=fields[`${group}:${next}`];if(meta?.description)item.description=meta.description;
    if(group!=='response'&&meta?.required===true){schema.required=schema.required||[];schema.required.push(key);}
    annotateSchema(item,fields,group,next);
  }
  if(schema.items)annotateSchema(schema.items,fields,group,`${path}[]`);
}
