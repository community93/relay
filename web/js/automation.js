import { state, uid, kv, newBody, newAuth, newCollection, newRequestNode, newDoc, newReqBlock, newEnvironment, newRunner, findNode, touch, flushDomain, saveState, emit, buildSendDraft, openRequest, openDoc, openRunner, activeEnv, splitQuery, syncParamsFromUrl, syncUrlFromParams } from './state.js';
import * as api from './api.js';
import { evaluateChecks, probePath, valueType } from './checks.js';
import { requestSnapshot, requestCurl } from './preview.js';
import { contractOf, clone, scrub, safeResponse, endpointFields, endpointStatus, reviewIssues, deliveryMarkdown, deliveryOpenApi, SECRET_KEY } from './delivery.js';
import { deliveryHtml, runBlock, cancelBlock } from './doc.js';
import { runRunner, stopRunner, sessionOf, stepsOf } from './runner.js';
import { inferProtocol } from './protocol.js';
import { el, icon, modal, toast, copy, saveAs, segmented } from './ui.js';

const actions = ['workspace.list','entity.find','entity.get','collection.upsert','environment.upsert','request.upsert','document.upsert','document.endpoint.upsert','runner.upsert','request.execute','document.verify','runner.execute','job.get','job.cancel','document.export','entity.open','request.preview'];
/// Mirrors `action_tier`/`scope_tier` in src-tauri/src/automation.rs. The Rust test
/// `every_frontend_action_is_graded` fails the build if the two drift apart.
/// `mcp.tools` is graded too but kept out of `actions`, so it never shows up in the
/// list an agent is invited to call -- it exists only to answer MCP `tools/list`.
const ACTION_TIER = {
  'workspace.list': 0, 'entity.find': 0, 'entity.get': 0, 'job.get': 0, 'mcp.tools': 0,
  'collection.upsert': 1, 'environment.upsert': 1, 'request.upsert': 1, 'document.upsert': 1,
  'document.endpoint.upsert': 1, 'runner.upsert': 1, 'entity.open': 1, 'document.export': 1,
  'request.preview': 1,
  'request.execute': 2, 'document.verify': 2, 'runner.execute': 2, 'job.cancel': 2,
};
const SCOPE_TIER = { read: 0, write: 1, execute: 2 };
const tierOf = scope => SCOPE_TIER[scope] ?? 0;
const reachableActions = scope => actions.filter(action => ACTION_TIER[action] <= tierOf(scope));
/// MCP tool descriptors, one per action. These shapes belong here and not in the
/// transport: they describe the workspace, and `dispatch()` below is the validator
/// that actually enforces them. The transport only decides which tools a connection
/// is allowed to see, so a read-only agent is never offered a button it cannot press.
const ID = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,80}$' };
const REVISION = { type: 'string', description: 'expectedRevision from a prior read; Relay refuses the write if the user edited the entity in the meantime' };
const ROW = { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, value: { type: 'string' }, enabled: { type: 'boolean' }, description: { type: 'string' } }, required: ['key'] };
const ENTITY_TYPE = { type: 'string', enum: ['collection', 'request', 'environment', 'document', 'runner'] };
const DRAFT = {
  type: 'object', additionalProperties: false,
  properties: {
    name: { type: 'string' }, method: { type: 'string', pattern: '^[A-Z]{1,20}$' }, url: { type: 'string' },
    params: { type: 'array', items: ROW, maxItems: 300 }, headers: { type: 'array', items: ROW, maxItems: 300 },
    body: { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['none', 'raw', 'urlencoded', 'form'] }, raw: { type: 'object', additionalProperties: false, properties: { language: { type: 'string', enum: ['json', 'text', 'xml', 'html', 'javascript'] }, content: { type: 'string' } }, required: ['language', 'content'] }, urlencoded: { type: 'array', items: ROW }, form: { type: 'array', items: ROW } }, required: ['mode'] },
    checks: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['status', 'time', 'json'] }, operator: { type: 'string' }, path: { type: 'string' }, expected: { type: 'string' }, enabled: { type: 'boolean' } } } },
    extractors: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, path: { type: 'string' }, source: { type: 'string', enum: ['json', 'header'] }, header: { type: 'string' }, enabled: { type: 'boolean' } } } },
    settings: { type: 'object', additionalProperties: false, properties: { timeoutMs: { type: 'number', minimum: 0, maximum: 300000 }, followRedirects: { type: 'boolean' }, sslVerify: { type: 'boolean' }, cookieJar: { type: 'boolean' }, proxy: { type: 'string' }, maxRedirects: { type: 'number' } } },
    subprotocols: { type: 'array', items: { type: 'string' } },
  },
};
const AUTH = { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', enum: ['inherit', 'noauth', 'bearer', 'basic', 'apikey'] }, bearer: { type: 'object', additionalProperties: false, properties: { token: { type: 'string' } }, required: ['token'] }, basic: { type: 'object', additionalProperties: false, properties: { username: { type: 'string' }, password: { type: 'string' } } }, apikey: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, value: { type: 'string' }, addTo: { type: 'string', enum: ['query', 'header'] } } } }, required: ['kind'] };
const JOB_ID = { ...ID, description: 'Job id returned by an execute call' };
const TOOL_SPECS = {
  'workspace.list': { title: 'Read the workspace map', description: 'A bounded map, not a dump: every collection with its request count, every environment, document and runner, plus this connection\'s scope and allowed hosts. Call this first. Individual requests are NOT listed here — pass collectionId to expand one collection, or use entity.find to search. Always prefer a narrow read over a wide one.', inputSchema: { type: 'object', additionalProperties: false, properties: { collectionId: ID, limit: { type: 'integer', minimum: 1, maximum: 500, description: 'How many entries to return; defaults to 80' } } } },
  'entity.find': { title: 'Search requests', description: 'Substring search over request names and URLs across every collection, optionally filtered by HTTP method. Returns id, method, url, which collection it lives in, and the revision a write needs. This is how you locate a request without reading the whole workspace.', inputSchema: { type: 'object', additionalProperties: false, properties: { query: { type: 'string', description: 'Matched case-insensitively against the request name and URL' }, method: { type: 'string', description: 'HTTP verb to filter by, e.g. POST' }, limit: { type: 'integer', minimum: 1, maximum: 500 } } } },
  'request.preview': { title: 'Preview a request (no traffic)', description: 'Resolve variables, auth and collection defaults through the same pipeline a real send uses and show what would go on the wire, WITHOUT sending anything. Also checks every json path in the checks and extractors against the last real response and reports the sibling keys where a path broke. Use this before request.execute: a wrong path costs an execution and an allowlist hit, a preview costs neither. Secrets are masked.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID }, required: ['id'] } },
  'entity.get': { title: 'Read one entity', description: 'Full saved content of one collection, request, environment, document or runner, with its revision.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, type: ENTITY_TYPE }, required: ['id', 'type'] } },
  'entity.open': { title: 'Show an entity to the user', description: 'Opens the entity in Relay\'s window so the person can see what you are working on.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, type: { ...ENTITY_TYPE, enum: ['request', 'document', 'runner'] } }, required: ['id', 'type'] } },
  'collection.upsert': { title: 'Create or update a collection', description: 'Omit id to create. Always send expectedRevision when updating.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, expectedRevision: REVISION, data: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] } }, required: ['data'] } },
  'environment.upsert': { title: 'Create or update an environment', description: 'Environment variables as {key,value} rows. Values you did not set are left alone only if you read them first; this replaces the variable list.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, expectedRevision: REVISION, data: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, variables: { type: 'array', items: ROW, maxItems: 300 } }, required: ['name'] } }, required: ['data'] } },
  'request.upsert': { title: 'Create or update a request', description: 'Send the whole draft you want, or paste a cURL as data.curl. collectionId is required when creating. Relay reopens the tab for the user afterwards.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, collectionId: ID, expectedRevision: REVISION, data: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, description: { type: 'string' }, protocol: { type: 'string', enum: ['http', 'sse', 'ws'] }, draft: DRAFT, auth: AUTH, curl: { type: 'string' } } } }, required: ['data'] } },
  'document.upsert': { title: 'Create or update a delivery document', description: 'The document shell: name, overview text, version. Endpoints are attached with document.endpoint.upsert.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, expectedRevision: REVISION, data: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, overview: { type: 'string' }, version: { type: 'string' } }, required: ['name'] } }, required: ['data'] } },
  'document.endpoint.upsert': { title: 'Attach a request to a document', description: 'Links a saved request into a delivery document as a verifiable endpoint, with field descriptions and requirements.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, documentId: ID, requestId: ID, expectedRevision: REVISION, data: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' }, description: { type: 'string' }, notes: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, properties: { description: { type: 'string' }, required: { type: ['boolean', 'null'] } } } } } } }, required: ['documentId', 'requestId'] } },
  'runner.upsert': { title: 'Create or update a run plan', description: 'sources are request ids in the order they should run.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, expectedRevision: REVISION, data: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, sources: { type: 'array', items: ID, maxItems: 300 }, stopOnError: { type: 'boolean' }, delayMs: { type: 'number', minimum: 0, maximum: 60000 } }, required: ['name'] } }, required: ['data'] } },
  'request.execute': { title: 'Send a request for real', description: 'Runs a saved request through Relay\'s own pipeline, opens the response in the window, and returns the redacted response plus check results. Only hosts on this connection\'s allowlist are reachable, and a redirect that leaves the allowlist stops the run. Returns a job id; poll job.get.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID }, required: ['id'] } },
  'document.verify': { title: 'Verify a delivery document', description: 'Runs every endpoint of a document and marks each one verified or failed against its declared checks. Refuses up front if any endpoint points outside the allowlist, so no partial run happens. Returns a job id.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID }, required: ['id'] } },
  'runner.execute': { title: 'Run a run plan', description: 'Executes a runner\'s requests in order, with its stop-on-error and delay settings. Refuses up front if any step points outside the allowlist. Returns a job id.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID }, required: ['id'] } },
  'job.get': { title: 'Poll a job', description: 'State of an execute job: running, done, failed or cancelled, with the result once finished.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: JOB_ID }, required: ['id'] } },
  'job.cancel': { title: 'Cancel a job', description: 'Stops a running job mid-flight, the same way the user\'s Stop button does.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: JOB_ID }, required: ['id'] } },
  'document.export': { title: 'Export a document', description: 'Renders a delivery document as markdown, OpenAPI or HTML for pasting into a hand-off.', inputSchema: { type: 'object', additionalProperties: false, properties: { id: ID, format: { type: 'string', enum: ['markdown', 'openapi', 'html'] } }, required: ['id'] } },
};
/// MCP tool names cannot contain dots for some clients, so the public name swaps
/// them for underscores and only the transport flips it back. Filtering by scope is
/// the transport's job -- it owns the grant -- so the table is handed over whole.
const toolName = action => action.replace(/\./g, '_');
const jobs = new Map();
let queue = Promise.resolve(), connected = false;
const fail = (code, message) => { throw Object.assign(Error(message), { code }); };
/// A rejection has to be enough to fix the command without another round trip, so
/// every one of them names what was accepted and echoes back what arrived. The
/// caller sent the value, so echoing is not a leak; it is truncated only to keep a
/// megabyte of base64 out of the error text.
const echo = value => {
  const raw = value === undefined ? 'undefined' : (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value));
  return raw.length > 60 ? `${raw.slice(0, 57)}… (${raw.length} chars)` : raw;
};
const oneOf = values => `expected one of ${values.map(value => JSON.stringify(value)).join(', ')}`;
const choice = (value, allowed, label) => { if (!allowed.includes(value)) fail('invalid', `${label} ${echo(value)} is not supported; ${oneOf(allowed)}`); return value; };
const object = (value, label='data') => { if (!value || typeof value!=='object' || Array.isArray(value)) fail('invalid',`${label} must be an object, got ${echo(value)}`); return value; };
const fields = (value, allowed) => { object(value); const extra = Object.keys(value).filter(key => !allowed.includes(key)); if (extra.length) fail('invalid',`Unknown field(s) ${extra.map(key => JSON.stringify(key)).join(', ')}; allowed: ${allowed.join(', ')}`); return value; };
const text = (value, label, max=10000) => { if(typeof value!=='string') fail('invalid',`${label} must be a string, got ${echo(value)}`); if(value.length>max) fail('invalid',`${label} is ${value.length} characters, over the ${max} limit`); return value; };
const idOf = value => { if(value!==undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('invalid',`ids are 1-80 characters from a-z A-Z 0-9 _ - with no dots, slashes or spaces, got ${echo(value)}`); return value; };
const nameOf = value => { const name=text(value,'name',200).trim();if(!name)fail('invalid','Name is required and cannot be only whitespace');return name; };
const ENTITY_TYPES = ['collection','request','environment','document','runner'];
function entity(type,id) {
  if (!ENTITY_TYPES.includes(type)) fail('invalid', `type ${echo(type)} is not an entity; ${oneOf(ENTITY_TYPES)}`);
  let value;
  if(['collection','request'].includes(type))value=findNode(id)?.node;
  else value=state[{environment:'environments',document:'docs',runner:'runners'}[type]]?.find(item=>item.id===id);
  if(!value || type==='collection'&&value.kind!=='collection' || type==='request'&&!['request','ws'].includes(value.kind))fail('not_found',`No ${type} with id ${echo(id)}; run workspace.list or entity.find to get current ids`);
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
  // Returned so the engine can keep enforcing it on every redirect hop; checking
  // only this first URL would let an allowlisted host bounce us anywhere.
  return allowed;
}
/// The response a preview can check paths against. Only a real execution leaves one
/// behind, so this looks at the open tab first and then at any document endpoint that
/// links the request; when there is none it says so rather than guessing a shape.
function evidenceFor(requestId) {
  const tab = state.tabs.find(t => t.refId === requestId && t.response?.status && !t.dirty);
  if (tab) return { response: tab.response, at: tab.lastRequestSnapshot?.at || null, from: 'the open tab' };
  for (const doc of state.docs) for (const block of doc.blocks) {
    if (block.sourceId === requestId && block.response?.status) {
      return { response: block.response, at: block.lastRequestSnapshot?.at || null, from: `document “${doc.name}”` };
    }
  }
  return null;
}

/// Check every JSON path against the last real response without sending anything.
/// The point is to turn "run it and find out" into an answer the caller can act on
/// now, so a miss names the segment that broke and lists what sits beside it.
function auditPaths(rules, evidence, label) {
  if (!rules?.length) return [];
  if (!evidence) return rules.map(rule => ({ ...ruleRef(rule, label), status: 'unchecked', reason: 'no stored response to check against; run request.execute once, or open the request in Relay and send it' }));
  let parsed;
  try {
    if (evidence.response.truncated || evidence.response.isText === false) throw Error('stored response is truncated or binary');
    parsed = JSON.parse(evidence.response.bodyText || '');
  } catch (error) {
    return rules.map(rule => ({ ...ruleRef(rule, label), status: 'unchecked', reason: `stored response is not JSON: ${error.message}` }));
  }
  return rules.map(rule => {
    const ref = ruleRef(rule, label);
    if (!rule.path) return { ...ref, status: 'missing-path', reason: `${label} has no path` };
    let probed;
    try { probed = probePath(parsed, rule.path); }
    catch (error) { return { ...ref, status: 'bad-path', reason: `${error.message} (path ${echo(rule.path)})` }; }
    if (!probed.exists) {
      const where = probed.at || '$';
      const siblings = probed.available.length
        ? `${probed.isIndex ? 'elements' : 'keys'} at ${where}: ${probed.available.join(', ')}`
        : `${where} is ${probed.actualType}, which has no children`;
      return { ...ref, status: 'not-found', path: rule.path, reason: `${rule.path} not found — ${siblings}` };
    }
    const actual = valueType(probed.value);
    if (rule.operator === 'type' && rule.expected && rule.expected !== actual) {
      return { ...ref, status: 'would-fail', reason: `${rule.path} is ${actual}, check expects type ${rule.expected}` };
    }
    if (rule.operator === 'equals' && rule.expected !== undefined && String(probed.value) !== String(rule.expected)) {
      return { ...ref, status: 'would-fail', reason: `${rule.path} is ${echo(probed.value)}, check expects ${echo(rule.expected)}` };
    }
    return { ...ref, status: 'ok', actualType: actual, value: redacted(probed.value, []) };
  });
}
const ruleRef = (rule, label) => ({ [label === 'check' ? 'operator' : 'name']: rule[label === 'check' ? 'operator' : 'name'] ?? null, path: rule.path ?? null });

function previewRequest(command) {
  fields(command.data ?? {}, []);
  const node = entity('request', command.id);
  const shell = { refId: node.id, draft: clone(node.request), auth: clone(node.auth), protocol: node.protocol || 'http' };
  const built = buildSendDraft(shell, { environment: activeEnv() ? clone(activeEnv()) : null });
  const snapshot = requestSnapshot(shell, built);
  const evidence = evidenceFor(node.id);
  const checks = auditPaths((built.preparedChecks?.checks || []).filter(rule => rule.kind === 'json'), evidence, 'check');
  const extractors = auditPaths(built.preparedChecks?.extractors || [], evidence, 'extractor');
  const problems = [...checks, ...extractors].filter(row => row.status !== 'ok' && row.status !== 'unchecked').length;
  return {
    id: node.id, name: node.name, protocol: node.protocol || 'http', environment: built.environment,
    // Nothing leaves the machine here, but the resolved request still carries real
    // credentials, so it goes through the same redaction an execution result does.
    wire: redacted({ method: built.draft.method, url: built.draft.url, headers: built.draft.headers,
      params: built.draft.params, body: built.draft.body, authKind: built.auth?.kind || 'inherit' }, snapshot.secrets),
    missingVariables: built.missing,
    evidence: evidence ? { from: evidence.from, at: evidence.at, status: evidence.response.status } : null,
    checks, extractors, problems,
    ok: built.missing.length === 0 && problems === 0,
    ...(built.missing.length ? { next: `define ${built.missing.join(', ')} in the active environment, or the placeholders go out as-is` } : {}),
  };
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
  if(!Array.isArray(value))fail('invalid',`${label} must be an array of {key, value} objects, got ${echo(value)}`);
  if(value.length>300)fail('invalid',`${label} has ${value.length} rows, over the 300 limit`);
  return value.map((row,index)=>{try{fields(row,['key','value','enabled','description']);}catch(error){fail(error.code,`${label}[${index}]: ${error.message}`);}const key=text(row.key,`${label}[${index}].key`,500),val=text(row.value??'',`${label}[${index}].value`,65536);if(val.includes('<redacted>'))fail('invalid',`${label}[${index}].value contains a <redacted> placeholder; read the environment for the real value instead of writing the mask back`);return {...kv(key,val,text(row.description??'',`${label}[${index}].description`)),enabled:row.enabled!==false};});
}
function draftPatch(value) {
  fields(value,['name','method','url','params','headers','body','settings','checks','extractors','subprotocols']);
  const draft=clone(value);
  if('name'in draft)draft.name=nameOf(draft.name);
  if('method'in draft && !/^[A-Z]{1,20}$/.test(draft.method))fail('invalid',`method ${echo(draft.method)} is not an HTTP verb; use uppercase letters only, e.g. "GET", "POST", "PATCH"`);
  if('url'in draft){text(draft.url,'url',16384);if(!draft.url.trim())fail('invalid','url cannot be blank');if(draft.url.includes('<redacted>'))fail('invalid','url contains a <redacted> placeholder; put the secret in an environment variable and reference it with {{name}}');}
  for(const key of ['params','headers'])if(key in draft)draft[key]=rows(draft[key],key);
  if('body'in draft){const body=fields(draft.body,['mode','raw','urlencoded','form']);if(!['none','raw','urlencoded','form'].includes(body.mode))fail('invalid',`body.mode ${echo(body.mode)} is not supported; ${oneOf(['none','raw','urlencoded','form'])}. A binary file body is configured in Relay's UI, not through automation`);const out=newBody(body.mode);if(body.mode==='raw'){fields(body.raw,['language','content']);choice(body.raw?.language,['json','text','xml','html','javascript'],'body.raw.language');out.raw={language:body.raw.language,content:text(body.raw.content,'body',1048576)};}for(const key of ['urlencoded','form'])if(key in body)out[key]=rows(body[key],`body.${key}`);draft.body=out;}
  if('settings'in draft){fields(draft.settings,['timeoutMs','followRedirects','sslVerify','cookieJar','proxy','maxRedirects']);if(draft.settings.timeoutMs!==undefined&&(!Number.isFinite(draft.settings.timeoutMs)||draft.settings.timeoutMs<0||draft.settings.timeoutMs>300000))fail('invalid',`settings.timeoutMs must be a number of milliseconds from 0 to 300000, got ${echo(draft.settings.timeoutMs)}`);for(const key of ['followRedirects','sslVerify','cookieJar'])if(key in draft.settings&&typeof draft.settings[key]!=='boolean')fail('invalid',`settings.${key} must be true or false, got ${echo(draft.settings[key])}`);if(draft.settings.proxy!=null)text(draft.settings.proxy,'settings.proxy',2000);}
  if('checks'in draft){if(!Array.isArray(draft.checks)||draft.checks.length>100)fail('invalid',`checks must be an array of at most 100 rules, got ${Array.isArray(draft.checks)?`${draft.checks.length} rows`:echo(draft.checks)}`);for(const [index,rule] of draft.checks.entries()){try{fields(rule,['kind','operator','path','expected','enabled']);}catch(error){fail(error.code,`checks[${index}]: ${error.message}`);}choice(rule.kind,['status','time','json'],`checks[${index}].kind`);if(rule.kind==='json')choice(rule.operator,['exists','equals','type'],`checks[${index}].operator (required for a json check)`);if(rule.path!==undefined)text(rule.path,`checks[${index}].path`,2000);if(rule.expected!==undefined)text(rule.expected,`checks[${index}].expected`,65536);}}
  if('extractors'in draft){if(!Array.isArray(draft.extractors)||draft.extractors.length>100)fail('invalid',`extractors must be an array of at most 100 rules, got ${Array.isArray(draft.extractors)?`${draft.extractors.length} rows`:echo(draft.extractors)}`);for(const [index,rule] of draft.extractors.entries()){try{fields(rule,['name','path','source','header','enabled']);}catch(error){fail(error.code,`extractors[${index}]: ${error.message}`);}nameOf(rule.name);if(rule.path!==undefined)text(rule.path,`extractors[${index}].path`,2000);if(rule.source!==undefined)choice(rule.source,['json','header'],`extractors[${index}].source`);if(rule.header!==undefined)text(rule.header,`extractors[${index}].header`,500);}}
  if('subprotocols'in draft&&(!Array.isArray(draft.subprotocols)||draft.subprotocols.some(v=>typeof v!=='string')))fail('invalid',`subprotocols must be an array of strings, got ${echo(draft.subprotocols)}`);
  return draft;
}
function authPatch(value) {
  fields(value,['kind','bearer','basic','apikey']);
  choice(value.kind,['inherit','noauth','bearer','basic','apikey'],'auth.kind');
  const auth={...newAuth(),kind:value.kind};
  for(const [key,allowed] of [['bearer',['token']],['basic',['username','password']],['apikey',['key','value','addTo']]])if(value[key]){fields(value[key],allowed);for(const [field,val]of Object.entries(value[key])){text(val,`auth.${key}.${field}`,65536);if(val.includes('<redacted>'))fail('invalid',`auth.${key}.${field} contains a <redacted> placeholder; never write a mask back as a value`);auth[key][field]=val;}}
  if(!['query','header'].includes(auth.apikey.addTo))fail('invalid',`auth.apikey.addTo ${echo(auth.apikey.addTo)} is not supported; ${oneOf(['query','header'])}`);return auth;
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
  fields(command,['action','id','commands','type','expectedRevision','data','collectionId','documentId','requestId','format','limit','query','method']);
  // Commands run in order and a failure does not stop the rest: the point of a batch
  // is that "create these twelve requests" costs one round trip, and if the third one
  // was malformed the caller should still get the other eleven plus a precise complaint
  // about the third, not a rollback of everything.
  if (command.commands) {
    if (command.action !== undefined) fail('invalid','commands and action cannot appear together');
    if (!Array.isArray(command.commands)) fail('invalid',`commands must be an array, got ${echo(command.commands)}`);
    const results = [];
    for (const [index, row] of command.commands.entries()) {
      try { results.push({ index, ok: true, data: await dispatch(row) }); }
      catch (error) { results.push({ index, ok: false, action: row?.action ?? null, error: { code: error.code || 'invalid', message: String(error.message || error) } }); }
    }
    const failed = results.filter(row => !row.ok).length;
    return { results, failed, ok: failed === 0, ...(failed ? { next: 'fix only the failed index and resend that one command; the rest already applied' } : {}) };
  }
  if (ACTION_TIER[command.action] === undefined) fail('invalid', `Unknown action ${JSON.stringify(command.action)}; this connection can call: ${reachableActions((await api.invoke('automation_status'))?.scope||'read').join(', ')}`);
  for(const key of ['id','collectionId','documentId','requestId'])idOf(command[key]);
  const {action,id,data={}}=command;
  if(action==='mcp.tools'){return {tools:Object.entries(TOOL_SPECS).map(([action,spec])=>({action,name:toolName(action),...spec}))};}
  if(action==='workspace.list'){const c=await api.invoke('automation_status');return {scope:c?.scope||'read',allowedHosts:c?.allowedHosts||[],actions:reachableActions(c?.scope||'read'),activeEnvironmentId:state.settings.activeEnvironmentId,...workspaceIndex(command)};}
  if(action==='entity.find'){return findRequests(command);}
  if(action==='request.preview'){return previewRequest(command);}
  if(action==='entity.get'){const value=entity(command.type,id);const result=resultEntity(value);if(command.type==='document')result.endpoints=value.blocks.filter(b=>b.type==='req').map(b=>({id:b.id,fields:redacted(endpointFields(b)),status:endpointStatus(b),issues:reviewIssues(b)}));return result;}
  if(action==='entity.open'){const value=entity(command.type,id);if(command.type==='request'){openRequest(value);state.pane='collections';}else if(command.type==='document'){openDoc(value);state.pane='docs';}else if(command.type==='runner'){openRunner(value);state.pane='runner';}else fail('invalid',`entity.open takes a request, document or runner, not ${echo(command.type)}`);state.overviewPane=false;emit('pane');emit('rerender');return {opened:id};}
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
    let parent=existing?findNode(existing.id).parent:entity('collection',command.collectionId);if(!parent?.children)fail('invalid','A new request needs collectionId set to a collection id from workspace.list');
    let patch=data.draft?draftPatch(data.draft):{};
    if(data.curl){if(data.draft)fail('invalid','Use curl or draft');const parsed=await api.parseCurl(text(data.curl,'curl',1048576));if(parsed.length!==1)fail('invalid','One cURL per request');patch=parsedDraft(parsed[0].draft);if(existing&&findNode(id)?.node!==existing)fail('conflict','Request changed while parsing');checkRevision(existing,command.expectedRevision);if(existing)busyRequest(existing);parent=existing?findNode(existing.id).parent:entity('collection',command.collectionId);}
    const next=clone(existing||newRequestNode());if(id)next.id=id;next.name=nameOf(data.name??patch.name??next.name);next.request=newRequestNode(next.name,{...next.request,...patch,name:next.name}).request;if(!next.request.url)fail('invalid','Request URL required');if(data.auth)next.auth=authPatch(data.auth);if('description'in data)next.description=text(data.description,'description');next.protocol=data.protocol??existing?.protocol??inferProtocol(next.request);choice(next.protocol,['http','sse','ws'],'protocol');next.kind=next.protocol==='ws'?'ws':'request';
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
    if(data.fields){object(data.fields,'fields');const available=new Set(endpointFields(block).map(f=>f.id));for(const [key,meta]of Object.entries(data.fields)){if(!available.has(key))fail('invalid',`fields has unknown key ${JSON.stringify(key)}; this endpoint has ${available.size?`[${[...available].join(', ')}]`:'no fields yet'} — run document.verify first to generate them`);fields(meta,['description','required']);if(meta.required!==undefined&&meta.required!==null&&typeof meta.required!=='boolean')fail('invalid','required must be boolean or null');contract.fields[key]={...contract.fields[key],...meta,description:text(meta.description??contract.fields[key]?.description??'','description')};}}
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
    const shell={refId:node.id,draft:clone(node.request),auth:clone(node.auth),protocol:'http'},built=buildSendDraft(shell,{environment:activeEnv()?clone(activeEnv()):null});if(built.missing.length)fail('variables',`Missing variables: ${built.missing.join(', ')}`);const pinned=await requireHosts([built.draft.url],'This request');const snapshot=requestSnapshot(shell,built),execId=uid('ai');
    let cancelled=false;
    return jobStart({action,requestId:id},async()=>{
      const response=await api.execute(built.draft,execId,pinned);response.checkResult=evaluateChecks(built.preparedChecks,response);
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
    const pinned=await requireHosts(docUrls,'This document');
    let cancelled=false;return jobStart({action,documentId:id},async()=>{const endpoints=[];for(const block of blocks){if(cancelled)break;await runBlock(doc,block,pinned);endpoints.push({id:block.id,status:endpointStatus(block),response:redacted(block.response,block.lastRequestSnapshot?.secrets||[]),issues:reviewIssues(block)});}await flushDomain('docs',{strict:true});return {endpoints,revision:revision(doc),ok:endpoints.length===blocks.length&&endpoints.every(e=>['verified','ready'].includes(e.status.kind))};},()=>{cancelled=true;for(const block of blocks)if(block.running)cancelBlock(doc,block);});
  }
  if(action==='runner.execute'){
    fields(data,[]);const runner=entity('runner',id);if(sessionOf(id))fail('busy','Runner is active');const steps=stepsOf(runner);if(!steps.some(s=>!s.skip))fail('invalid','No executable requests');for(const step of steps)busyRequest(step.node);
    const pinned=await requireHosts(steps.filter(step=>!step.skip).map(step=>buildSendDraft({draft:step.node.request,auth:step.node.auth,refId:step.node.id},{environment:activeEnv()?clone(activeEnv()):null}).draft.url),'This runner');
    return jobStart({action,runnerId:id},async()=>{const run=await runRunner(runner,{trigger:'AI',allowedHosts:pinned});await flushDomain('runs',{strict:true});return {run:redacted(run),ok:!!run&&!run.cancelled&&run.totals.failed===0&&run.totals.passed>0};},()=>stopRunner(id));
  }
  if(action==='job.get'||action==='job.cancel'){
    const job=jobs.get(id);if(!job)fail('not_found','Job not found in this session');if(action==='job.cancel'&&job.state==='running'){job.cancel?.();job.state='cancelled';job.finishedAt=Date.now();}return jobView(job);
  }
  if(action==='document.export'){
    const doc=entity('document',id);if(doc.blocks.some(b=>b.running||b.preparing))fail('busy','Wait for validation');const format=command.format||'markdown';choice(format,['markdown','openapi','html'],'format');const content=format==='markdown'?deliveryMarkdown(doc):format==='html'?deliveryHtml(doc):JSON.stringify(deliveryOpenApi(doc),null,2);
    return {name:doc.name,format,content,review:doc.blocks.filter(b=>b.type==='req').map(b=>({id:b.id,status:endpointStatus(b),issues:reviewIssues(b)})),revision:revision(doc)};
  }
}
function listRequests(parent, budget) {
  // Bounded on purpose: the caller is usually an LLM whose whole working set is
  // this response, and a workspace with 300 requests does not fit in one turn.
  const requests = [];
  let hidden = 0;
  const walk = node => {
    if (node.children) { node.children.forEach(walk); return; }
    if (!['request', 'ws'].includes(node.kind)) return;
    if (requests.length >= budget) { hidden += 1; return; }
    requests.push({ id: node.id, name: node.name, protocol: node.protocol || 'http', method: node.request?.method, revision: revision(node) });
  };
  (parent.children || []).forEach(walk);
  return { requests, hidden };
}
function countRequests(parent) {
  return (parent.children || []).reduce((total, node) => total + (node.children
    ? countRequests(node)
    : (['request', 'ws'].includes(node.kind) ? 1 : 0)), 0);
}
const INDEX_LIMIT = 80;
function limitOf(value) {
  if (value === undefined) return INDEX_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > 500) fail('invalid', `limit must be a whole number from 1 to 500, got ${JSON.stringify(value)}`);
  return value;
}
/// One page of the workspace. Without `collectionId` this is a map: every entity
/// with its size, no request bodies of its own. With `collectionId` it expands that
/// one collection. An agent can always reach everything by walking collections;
/// what it must not be able to do is be handed everything at once.
function workspaceIndex(command) {
  const limit = limitOf(command.limit);
  const collections = state.collections.filter(c => c.kind === 'collection');
  const base = { apiVersion: 3, totalCollections: collections.length, totalRequests: collections.reduce((n, c) => n + countRequests(c), 0) };
  if (command.collectionId !== undefined) {
    const collection = entity('collection', command.collectionId);
    const { requests, hidden } = listRequests(collection, limit);
    return { ...base, collectionId: collection.id, name: collection.name, revision: revision(collection),
      requests, hidden, ...(hidden ? { next: `${hidden} more request(s) in this collection; raise limit or use entity.find to narrow` } : {}) };
  }
  const shown = collections.slice(0, limit);
  return {
    ...base,
    collections: shown.map(c => ({ id: c.id, name: c.name, revision: revision(c), requests: countRequests(c) })),
    ...(collections.length > limit ? { hiddenCollections: collections.length - limit } : {}),
    environments: state.environments.map(e => ({ id: e.id, name: e.name, revision: revision(e) })),
    documents: state.docs.map(d => ({ id: d.id, name: d.name, revision: revision(d),
      endpoints: d.blocks.filter(b => b.type === 'req').map(b => ({ id: b.id, sourceId: b.sourceId, status: endpointStatus(b) })) })),
    runners: state.runners.map(r => ({ id: r.id, name: r.name, revision: revision(r) })),
    next: 'This is a map, not a dump: pass collectionId to expand one collection, or call entity.find to search by name, method or URL fragment.',
  };
}
/// Substring search over the whole tree. The alternative is an agent reading every
/// collection to find the one endpoint it was asked about.
function findRequests(command) {
  const limit = limitOf(command.limit);
  const needle = command.query === undefined ? '' : text(command.query, 'query', 500).trim().toLowerCase();
  const method = command.method === undefined ? '' : text(command.method, 'method', 20).trim().toUpperCase();
  if (method && !/^[A-Z]{1,20}$/.test(method)) fail('invalid', `method must be an HTTP verb like GET or POST, got ${JSON.stringify(command.method)}`);
  if (!needle && !method) fail('invalid', 'entity.find needs query, method, or both');
  const matches = [];
  let hidden = 0;
  const walk = (node, collection, path) => {
    if (node.children) { node.children.forEach(child => walk(child, collection, path.concat(node.name))); return; }
    if (!['request', 'ws'].includes(node.kind)) return;
    const url = node.request?.url || '';
    const haystack = `${node.name} ${url}`.toLowerCase();
    if ((needle && !haystack.includes(needle)) || (method && (node.request?.method || 'GET').toUpperCase() !== method)) return;
    if (matches.length >= limit) { hidden += 1; return; }
    matches.push({ id: node.id, name: node.name, method: node.request?.method || 'GET', url, protocol: node.protocol || 'http',
      collectionId: collection.id, folder: path.join(' / ') || null, revision: revision(node) });
  };
  for (const collection of state.collections) if (collection.kind === 'collection') walk(collection, collection, []);
  return { query: needle || null, method: method || null, matches, hidden,
    ...(hidden ? { next: `${hidden} more match(es); raise limit or narrow the query` } : {}) };
}
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
          el('span', { class: 'ai-connection-hint', text: '把它当作 MCP 服务器接进任意 AI 客户端：地址就是上面这个再加 /mcp，鉴权走请求头。下面的按钮给出可直接粘贴的完整配置，含访问凭证，不要贴到公开场合。' }),
        ]),
      ]),
      el('div', { class: 'ai-connection-actions' }, [
        el('button', { class: 'btn primary', text: '保存 MCP 配置', onclick: () => saveAs({ name: 'relay-mcp.json', text: JSON.stringify(mcpConfig(connection), null, 2), extensions: ['json'] }) }),
        el('button', { class: 'btn', text: '复制 MCP 配置', onclick: () => copy(JSON.stringify(mcpConfig(connection), null, 2)) }),
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
