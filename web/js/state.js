// The single source of truth: data shapes, persistence, variable rendering and
// the pipeline that turns an editor tab into the request the Rust engine sends.

import * as api from './api.js';
import { prepareChecks } from './checks.js';
import { debounce, toast, modal, el } from './ui.js';

export const state = {
  collections: [],
  environments: [],
  docs: [],
  globals: [],
  history: [],
  // 运行计划：有序地跨集合串行跑；runs 是跑完留下的结果，有界。
  runners: [],
  runs: [],
  settings: {
    theme: 'light',
    palette: 'mint',
    activeEnvironmentId: null,
    timeoutMs: 60000,
    followRedirects: true,
    sslVerify: true,
    cookieJar: true,
    proxy: '',
    maxHistory: 300,
    sseFirstByteMs: 15000,
    uiZoom: 1,
    sidebarWidth: 272,
  },
  tabs: [],
  activeTabId: null,
  pane: 'collections',
  // ordered so Shift+click can extend a range and the pick bar can say "已选 N 项"
  selectedNodeIds: [],
  expanded: {},
  booted: false,
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) fn(payload);
}

export function uid(prefix = 'i') {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

/* ---------- factories ---------- */

export function kv(key = '', value = '', description = '') {
  return { id: uid('kv'), key, value, enabled: true, description };
}

export function newBody(mode = 'none') {
  return {
    mode,
    raw: { language: 'json', content: '' },
    urlencoded: [],
    form: [],
    file: null,
  };
}

export function newAuth() {
  return { kind: 'inherit', bearer: { token: '' }, basic: { username: '', password: '' }, apikey: { key: '', value: '', addTo: 'header' } };
}

export function newRequestDraft(overrides = {}) {
  return {
    name: '',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: newBody(),
    settings: {},
    checks: [],
    extractors: [],
    ...overrides,
  };
}

export function newEnvironment(name = '新建环境') {
  return {
    id: uid('env'),
    name,
    color: '#08645d',
    variables: [],
    defaults: {
      baseUrl: '',
      urlPrefixMode: 'prefill',
      headers: [],
      alwaysOnHeaders: false,
      bodyMode: 'none',
      bodyLanguage: 'json',
      bodyContent: '',
      prefillBody: false,
    },
  };
}

export function newSchedule() {
  return { enabled: false, kind: 'interval', everyMinutes: 30, at: '09:00' };
}

/// 执行顺序有两个层次：跑哪几样东西由 sources 的顺序决定，集合或文件夹内部则直接用
/// 树的顺序 —— 不另存一套排序，否则拖完树和运行顺序会各说各话。
/// sources 里放的是树节点 id，集合 / 文件夹 / 单个请求都可以，允许混着排。
export function newRunner(name = '新建运行计划') {
  return {
    id: uid('run'),
    kind: 'runner',
    name,
    sources: [],
    stopOnError: false,
    delayMs: 0,
    schedule: newSchedule(),
    createdAt: Date.now(),
  };
}

export function newDoc(name = '未命名文档') {
  return {
    id: uid('doc'),
    kind: 'doc',
    name,
    blocks: [],
    overview: '', mode: 'draft', version: '1.0.0',
    updatedAt: Date.now(),
  };
}

/// One block per line of pasted text, so a curl command dropped into a prose
/// block still becomes a runnable request.
export function newReqBlock(curl = '') {
  return { id: uid('blk'), type: 'req', curl, response: null, running: false };
}

export function openDoc(doc) {
  const existing = state.tabs.find((tab) => tab.kind === 'doc' && tab.refId === doc.id);
  if (existing) {
    state.activeTabId = existing.id;
    emit('tabs', { activate: true });
    emit('rerender');
    return existing;
  }
  const tab = createTabObject({ kind: 'doc', protocol: 'doc', refId: doc.id, title: doc.name, draft: newRequestDraft() });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  emit('tabs');
  emit('rerender');
  touch('tabs');
  return tab;
}

export function openRunner(runner) {
  const existing = state.tabs.find((tab) => tab.kind === 'runner' && tab.refId === runner.id);
  if (existing) {
    state.activeTabId = existing.id;
    emit('tabs', { activate: true });
    emit('rerender');
    return existing;
  }
  const tab = createTabObject({ kind: 'runner', protocol: 'runner', refId: runner.id, title: runner.name, draft: newRequestDraft() });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  emit('tabs');
  emit('rerender');
  touch('tabs');
  return tab;
}

export function newCollection(name = '新建集合') {
  return {
    id: uid('col'),
    kind: 'collection',
    name,
    children: [],
    variables: [],
    // 集合级默认请求头：发送时附加，不预填进请求的表里。请求自己写了同名头就以
    // 请求为准，所以改集合这一处，所有没自己写的请求下次发送都跟着变。
    headers: [],
    auth: { ...newAuth(), kind: 'noauth' },
    expanded: true,
  };
}

export function newFolder(name = '新建文件夹') {
  return { id: uid('fld'), kind: 'folder', name, children: [], auth: newAuth(), expanded: true };
}

export function newRequestNode(name = '未命名请求', draft = {}) {
  const request = newRequestDraft({ name, ...draft });
  // The URL is the source of truth for the query: opening a tab re-derives the
  // Params table from it, so an importer that hands over a bare base plus a
  // filled table would watch its rows vanish on first paint. Fold them back in.
  if (!request.url.includes('?') && (request.params || []).some((row) => row.enabled !== false && row.key)) {
    request.url = syncUrlFromParams({ draft: request });
  }
  return {
    id: uid('req'),
    kind: 'request',
    name,
    auth: newAuth(),
    protocol: 'http',
    request,
  };
}

/* ---------- persistence ---------- */

const DOMAIN_DEFAULTS = {
  collections: () => [],
  environments: () => [newEnvironment('本地开发'), newEnvironment('生产')],
  docs: () => [],
  history: () => [],
  runners: () => [],
  runs: () => [],
  settings: () => ({ ...state.settings }),
  tabs: () => ({ tabs: [], activeTabId: null }),
};

const persisters = {};
const persistence = new Map();
const writes = new Map();
export function saveState(domain) {
  return persistence.get(domain) || { phase: 'saved', revision: 0 };
}
function setSaveState(domain, value) {
  persistence.set(domain, value);
  emit('persistence', { domain, ...value });
}

function persist(domain) {
  if (!persisters[domain]) {
    persisters[domain] = debounce(() => flushDomain(domain), 450);
  }
  persisters[domain]();
}

/// Which slice of `state` owns a domain. Kept as a table so adding a domain is
/// one line here plus one line in loadAll.
const DOMAIN_SOURCE = {
  collections: () => state.collections,
  environments: () => state.environments,
  docs: () => state.docs,
  history: () => state.history,
  runners: () => state.runners,
  runs: () => state.runs,
  settings: () => ({ ...state.settings, globals: state.globals }),
  tabs: () => ({ tabs: state.tabs.map(serializeTab), activeTabId: state.activeTabId }),
};

export function flushDomain(domain, options = {}) {
  const source = DOMAIN_SOURCE[domain];
  if (!source) return Promise.resolve();
  const revision = saveState(domain).revision;
  const snapshot = JSON.stringify(source());
  setSaveState(domain, { revision, phase: 'saving' });
  // Preserve write order. An older write must never overwrite a newer snapshot.
  const task = (writes.get(domain) || Promise.resolve()).catch(() => {}).then(() => api.saveDoc(domain, snapshot));
  writes.set(domain, task);
  return task.then(() => {
    if (saveState(domain).revision === revision) setSaveState(domain, { revision, phase: 'saved', at: Date.now() });
  }).catch(error => {
    if (saveState(domain).revision === revision) setSaveState(domain, { revision, phase: 'error', error: String(error) });
    toast(`保存 ${domain} 失败：${error}`, 'err');
    if (options.strict) throw error;
  });
}

export function touch(domain) {
  setSaveState(domain, { revision: saveState(domain).revision + 1, phase: 'pending' });
  persist(domain);
  emit('changed', domain);
}

export async function loadAll() {
  const read = async (domain) => {
    try {
      const raw = await api.loadDoc(domain);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed === null || parsed === undefined ? DOMAIN_DEFAULTS[domain]() : parsed;
    } catch (error) {
      console.warn('load failed', domain, error);
      return DOMAIN_DEFAULTS[domain]();
    }
  };
  const [collections, environments, docs, history, runners, runs, settings, tabs] = await Promise.all([
    read('collections'),
    read('environments'),
    read('docs'),
    read('history'),
    read('runners'),
    read('runs'),
    read('settings'),
    read('tabs'),
  ]);
  state.collections = collections;
  const normalizeProtocols = (nodes) => {
    for (const node of nodes || []) {
      if (node.children) normalizeProtocols(node.children);
      else if (['request', 'ws'].includes(node.kind)) {
        node.protocol = savedRequestProtocol(node);
        node.kind = node.protocol === 'ws' ? 'ws' : 'request';
      }
    }
  };
  normalizeProtocols(state.collections);
  state.environments = environments;
    state.docs = Array.isArray(docs) ? docs : [];
    for(const doc of state.docs)for(const block of doc.blocks || []){block.running=false;block.execId=null;block.editing=false;}
  state.history = history;
  state.runners = Array.isArray(runners) ? runners : [];
  state.runs = Array.isArray(runs) ? runs : [];
  state.globals = Array.isArray(settings.globals) ? settings.globals : [];
  delete settings.globals;
  state.settings = { ...state.settings, ...settings };
  state.tabs = (tabs.tabs || []).map(deserializeTab);
  state.activeTabId = tabs.activeTabId || (state.tabs[0] && state.tabs[0].id) || null;
  if (!state.tabs.length) state.tabs = [createTabObject()];
  if (!state.activeTabId) state.activeTabId = state.tabs[0].id;
  state.booted = true;
}

function serializeTab(tab) {
  return {
    id: tab.id,
    kind: tab.kind,
    refId: tab.refId,
    title: tab.title,
    draft: tab.draft,
    dirty:!!tab.dirty,
    protocol: tab.protocol,
    wsView: tab.wsView,
    streamFormat: tab.streamFormat,
    auth: tab.auth,
      description: tab.description,
      docBinding: tab.docBinding,
  };
}

function deserializeTab(raw) {
  const protocol =
    raw.protocol || (raw.kind === 'ws' ? 'ws' : raw.kind === 'env' ? 'env' : raw.kind === 'doc' ? 'doc' : raw.kind === 'runner' ? 'runner' : 'http');
  const kindOf = { ws: 'ws', env: 'env', doc: 'doc', runner: 'runner' };
  const tab = {
    id: raw.id || uid('tab'),
    kind: protocol === 'http' ? 'request' : kindOf[protocol] || 'request',
    protocol,
    wsView: raw.wsView || 'messages',
    streamFormat: raw.streamFormat || 'auto',
    refId: raw.refId || null,
    title: raw.title || '未命名',
    draft: raw.draft || newRequestDraft(),
    auth: raw.auth || newAuth(),
      description: raw.description || '',
      docBinding: raw.docBinding || null,
    dirty: !!raw.dirty,
    sending: false,
    response: null,
    stream: null,
    view: 'params',
    responseView: 'body',
    running: null,
  };
  if (['http', 'sse', 'ws'].includes(protocol) && !(tab.draft.params || []).length && tab.draft.url.includes('?')) {
    syncParamsFromUrl(tab);
  }
  return tab;
}

/* ---------- lookups ---------- */

/// Path from the collection root down to `id` (inclusive). Collections are
/// themselves roots, so path[0] is always a collection.
export function pathTo(id, nodes = state.collections, trail = []) {
  for (const node of nodes) {
    const next = trail.concat(node);
    if (node.id === id) return next;
    const hit = pathTo(id, node.children || [], next);
    if (hit) return hit;
  }
  return null;
}

export function findNode(id) {
  const path = pathTo(id);
  if (!path) return null;
  return {
    node: path[path.length - 1],
    parent: path.length > 1 ? path[path.length - 2] : null,
    siblings: path.length > 1 ? path[path.length - 2].children : state.collections,
    path,
  };
}

export function collectionOf(nodeId) {
  const path = pathTo(nodeId);
  return path ? path[0] : null;
}

/// Collections are not "ancestors" of themselves; this returns everything above
/// the node, nearest last.
export function ancestors(nodeId) {
  const path = pathTo(nodeId);
  return path ? path.slice(0, -1) : [];
}

export function siblingsOf(nodeId) {
  const hit = findNode(nodeId);
  return hit ? hit.siblings : [];
}

export function activeEnv() {
  const id = state.settings.activeEnvironmentId;
  return state.environments.find((env) => env.id === id) || null;
}

/* ---------- variables ---------- */

export function varScope(nodeId, { environment = activeEnv(), runtime } = {}) {
  const scope = new Map();
  scope.sources = new Map();
  scope.used = new Map();
  scope.dynamic = new Map();
  const put = (list, source) => {
    for (const item of list || []) {
      if (item.enabled === false) continue;
      if (!item.key) continue;
      scope.set(item.key.trim(), String(item.value ?? ''));
      scope.sources.set(item.key.trim(), source);
    }
  };
  put(state.globals, '全局');
  const collection = nodeId ? collectionOf(nodeId) : null;
  if (collection) put(collection.variables, `集合 · ${collection.name}`);
  const env = environment;
  if (env) {
    put(env.variables, `环境 · ${env.name}`);
    if (env.defaults.baseUrl) {
      scope.set('baseUrl', env.defaults.baseUrl.replace(/\/+$/, ''));
      scope.set('base_url', env.defaults.baseUrl.replace(/\/+$/, ''));
      scope.sources.set('baseUrl', `环境 · ${env.name}`);
      scope.sources.set('base_url', `环境 · ${env.name}`);
    }
  }
  for (const [key, value] of runtime || []) {
    if (value === null) scope.delete(key);
    else scope.set(key, String(value));
    scope.sources.set(key, '本次运行');
  }
  return scope;
}

const BUILTINS = {
  $guid: () => uid(''),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000) + 1),
  $randomEmail: () => `test${Math.floor(Math.random() * 1e6)}@example.com`,
};

export function render(text, scope) {
  const missing = new Set();
  if (typeof text !== 'string') return { text: '', missing };
  let out = text;
  // A variable value may itself reference another variable, so keep substituting
  // until the text stops changing. A self-referencing value converges on pass 2.
  for (let pass = 0; pass < 5; pass += 1) {
    const before = out;
    out = out.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, name) => {
      scope?.used?.set(name, { key: name, source: BUILTINS[name] ? '动态' : scope.sources?.get(name) || '未定义' });
      if (BUILTINS[name]) {
        if (!scope?.dynamic) return BUILTINS[name]();
        if (!scope.dynamic.has(name)) scope.dynamic.set(name, BUILTINS[name]());
        return scope.dynamic.get(name);
      }
      if (scope && scope.has(name)) return String(scope.get(name));
      missing.add(name);
      return '';
    });
    if (out === before) break;
  }
  for (const match of out.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) missing.add(match[1]);
  return { text: out, missing };
}

export function renderKvs(list, scope) {
  const missing = new Set();
  const out = (list || [])
    .filter((item) => item.enabled !== false && item.key)
    .map((item) => {
      const key = render(item.key, scope);
      const value = render(item.value, scope);
      for (const name of key.missing) missing.add(name);
      for (const name of value.missing) missing.add(name);
      return { ...item, key: key.text, value: value.text };
    });
  return { list: out, missing };
}

/// 集合级默认请求头：发送时附加，不写进请求的表里。值同样按变量作用域渲染，所以
/// 集合变量可以在里面引用（`X-Tenant: {{tenant}}`）。返回渲染后的列表与还缺哪些变量。
export function collectionHeaders(nodeId, scope = varScope(nodeId)) {
  const collection = nodeId ? collectionOf(nodeId) : null;
  if (!collection || !(collection.headers || []).length) return { collection: null, list: [], missing: [] };
  const rendered = renderKvs(collection.headers, scope);
  return {
    collection,
    missing: [...rendered.missing],
    list: rendered.list.map((item) => ({ ...item, id: uid('h'), description: `集合「${collection.name}」` })),
  };
}

/* ---------- auth ---------- */

export function effectiveAuth(tab) {
  const own = tab.auth || newAuth();
  if (own.kind !== 'inherit') return own;
  const chain = tab.refId ? pathTo(tab.refId) : null;
  if (chain) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const auth = chain[i].auth;
      if (auth && auth.kind !== 'inherit') return auth;
    }
  }
  return { ...own, kind: 'noauth' };
}

function applyAuth(auth, headers, params) {
  const setHeader = (name, value) => {
    if (!headers.some((h) => h.key.toLowerCase() === name.toLowerCase())) headers.push({ id: uid('h'), key: name, value, enabled: true, description: 'auto' });
  };
  switch (auth.kind) {
    case 'bearer':
      if (auth.bearer && auth.bearer.token) setHeader('Authorization', `Bearer ${auth.bearer.token}`);
      break;
    case 'basic':
      if (auth.basic) {
        const raw = `${auth.basic.username || ''}:${auth.basic.password || ''}`;
        setHeader('Authorization', `Basic ${btoa(unescape(encodeURIComponent(raw)))}`);
      }
      break;
    case 'apikey':
      if (auth.apikey && auth.apikey.key) {
        if (auth.apikey.addTo === 'query') params.push({ id: uid('q'), key: auth.apikey.key, value: auth.apikey.value, enabled: true });
        else setHeader(auth.apikey.key, auth.apikey.value);
      }
      break;
    default:
      break;
  }
}

/* ---------- send pipeline ---------- */

export function joinUrl(base, path) {
  if (!base) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function buildSendDraft(tab, context = {}) {
  const scope = varScope(tab.refId, context);
  const draft = tab.draft;
  const missing = new Set();
  const renderedUrl = render(draft.url, scope);
  for (const name of renderedUrl.missing) missing.add(name);
  const env = 'environment' in context ? context.environment : activeEnv();

  let finalUrl = renderedUrl.text.trim();
  if (env && env.defaults.urlPrefixMode === 'auto' && finalUrl.startsWith('/') && env.defaults.baseUrl) {
    finalUrl = joinUrl(env.defaults.baseUrl, finalUrl);
  }
  // The URL keeps the query visible for the user, but the engine gets it once:
  // absorb any query in the URL into the params list and send the bare base.
  const inUrl = splitQuery(finalUrl);
  finalUrl = inUrl.base;

  const renderedParams = renderKvs(draft.params, scope);
  const renderedHeaders = renderKvs(draft.headers, scope);
  const params = renderedParams.list.slice();
  const headers = renderedHeaders.list.slice();
  const headerSources = headers.map(() => '请求');
  for (const pair of inUrl.pairs) {
    if (!params.some((row) => row.key === pair.key)) params.push({ id: uid('q'), key: pair.key, value: pair.value, enabled: true, description: '' });
  }
  for (const name of renderedParams.missing) missing.add(name);
  for (const name of renderedHeaders.missing) missing.add(name);

  // 附加顺序 = 优先级：请求自己的 > 环境 > 集合。同名就不再加第二份，所以请求里
  // 写了什么，发出去的就是什么。
  if (env && env.defaults.alwaysOnHeaders) {
    const envHeaders = renderKvs(env.defaults.headers, scope);
    for (const item of envHeaders.list) {
      if (!headers.some((h) => h.key.toLowerCase() === item.key.toLowerCase())) headers.push(item);
      else continue;
      headerSources.push(`环境 · ${env.name}`);
    }
    for (const name of envHeaders.missing) missing.add(name);
  }
  const fromCollection = collectionHeaders(tab.refId, scope);
  for (const item of fromCollection.list) {
    if (!headers.some((h) => h.key.toLowerCase() === item.key.toLowerCase())) {
      headers.push(item);headerSources.push(`集合 · ${fromCollection.collection.name}`);
    }
  }
  for (const name of fromCollection.missing) missing.add(name);

  const body = JSON.parse(JSON.stringify(draft.body || newBody()));
  if (body.mode === 'raw' && body.raw) {
    const rendered = render(body.raw.content || '', scope);
    body.raw.content = rendered.text;
    for (const name of rendered.missing) missing.add(name);
  }
  for (const mode of ['urlencoded', 'form']) {
    if (body[mode] && body[mode].length) {
      const rendered = renderKvs(body[mode], scope);
      body[mode] = rendered.list;
      for (const name of rendered.missing) missing.add(name);
    }
  }

  const auth = JSON.parse(JSON.stringify(effectiveAuth(tab)));
  const fields = { bearer: ['token'], basic: ['username', 'password'], apikey: ['key', 'value'] }[auth.kind] || [];
  for (const key of fields) {
    const rendered = render(String(auth[auth.kind]?.[key] || ''), scope);
    auth[auth.kind] = auth[auth.kind] || {};
    auth[auth.kind][key] = rendered.text;
    for (const name of rendered.missing) missing.add(name);
  }
  applyAuth(auth, headers, params);
  while (headerSources.length < headers.length) headerSources.push('鉴权');

  const settings = {
    timeoutMs: draft.settings && draft.settings.timeoutMs !== undefined ? draft.settings.timeoutMs : state.settings.timeoutMs,
    followRedirects: draft.settings?.followRedirects ?? state.settings.followRedirects,
    sslVerify: draft.settings?.sslVerify ?? state.settings.sslVerify,
    cookieJar: draft.settings?.cookieJar ?? state.settings.cookieJar,
    proxy: (draft.settings && draft.settings.proxy) || state.settings.proxy || null,
    maxRedirects: draft.settings?.maxRedirects ?? null,
  };

  const preparedChecks = prepareChecks(draft, text => render(text, scope));
  const variables = [...scope.used.values()].map(item => {
    const resolved = render(`{{${item.key}}}`, scope);
    return { ...item, value: resolved.text, missing: resolved.missing.size > 0 };
  });
  return {
    scope,
    preparedChecks,
    environment: env?.name || '无环境',
    authKind: auth.kind,
    auth,
    headerSources,
    variables,
    draft: {
      name: draft.name || tab.title || '',
      method: draft.method || 'GET',
      url: finalUrl,
      params,
      headers,
      body,
      settings,
    },
    missing: [...missing],
  };
}

/* ---------- URL <-> params ---------- */

export function splitQuery(url) {
  const index = String(url || '').indexOf('?');
  if (index < 0) return { base: url || '', pairs: [] };
  const base = url.slice(0, index);
  const query = url.slice(index + 1).split('#')[0];
  const pairs = query
    .split('&')
    .filter((pair) => pair.length)
    .map((pair) => {
      const at = pair.indexOf('=');
      return { key: at < 0 ? pair : pair.slice(0, at), value: at < 0 ? '' : pair.slice(at + 1) };
    })
    .map((pair) => ({ key: decodeQuiet(pair.key), value: decodeQuiet(pair.value) }));
  return { base, pairs };
}

function decodeQuiet(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, ' '));
  } catch (error) {
    return String(text);
  }
}

export function encodePair(key, value) {
  const enc = (text) => encodeURIComponent(String(text ?? '')).replace(/%20/g, '+');
  return `${enc(key)}=${enc(value)}`;
}

/// Typing or pasting a URL with a query fills the Params table. Disabled rows
/// survive, because the whole point of disabling one is to drop it from the URL.
export function syncParamsFromUrl(tab) {
  const { pairs } = splitQuery(tab.draft.url);
  const existing = tab.draft.params || [];
  const next = [];
  const used = new Set();
  for (const pair of pairs) {
    const match = existing.find((row) => !used.has(row.id) && row.key === pair.key && row.enabled !== false);
    if (match) {
      used.add(match.id);
      match.value = pair.value;
      next.push(match);
    } else {
      next.push({ id: uid('kv'), key: pair.key, value: pair.value, enabled: true, description: '' });
    }
  }
  for (const row of existing) {
    if (row.enabled === false && !pairs.some((pair) => pair.key === row.key)) next.push(row);
  }
  tab.draft.params = next;
  return next;
}

/// Editing the Params table rewrites the query part of the URL, so the two never
/// disagree about what will actually be sent.
export function syncUrlFromParams(tab) {
  const { base } = splitQuery(tab.draft.url);
  const rows = (tab.draft.params || []).filter((row) => row.enabled !== false && row.key);
  const query = rows.map((row) => encodePair(row.key, row.value)).join('&');
  tab.draft.url = query ? `${base}?${query}` : base;
  return tab.draft.url;
}

/* ---------- history ---------- */

export function pushHistory(entry) {
  state.history.unshift({ id: uid('h'), at: Date.now(), ...entry });
  const max = state.settings.maxHistory || 300;
  if (state.history.length > max) state.history.length = max;
  touch('history');
}

/* ---------- tabs ---------- */

export function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function createTabObject(overrides = {}) {
  return deserializeTab({ id: uid('tab'), draft: newRequestDraft(), ...overrides });
}

function savedRequestProtocol(node) {
  return ['http', 'sse', 'ws'].includes(node.protocol) ? node.protocol : node.kind === 'ws' ? 'ws' : 'http';
}

export function openRequest(node, { replaceExisting = true } = {}) {
  const protocol = savedRequestProtocol(node);
  if (replaceExisting) {
    const existing = state.tabs.find((tab) => tab.refId === node.id);
      if (existing) {
        // A second tab may have saved a different protocol for this request.
        // Keep unsaved edits and live connections; refresh an idle clean tab.
        if (!existing.dirty && !existing.running && !['opening', 'open', 'closing'].includes(existing.ws?.status) && existing.protocol !== protocol) {
          Object.assign(existing, createTabObject({
            id: existing.id, refId: node.id, protocol,
            title: node.name || '未命名',
            draft: JSON.parse(JSON.stringify(node.request || newRequestDraft())),
            auth: JSON.parse(JSON.stringify(node.auth || newAuth())),
            description: node.description || '',
          }));
          touch('tabs');
        }
      state.activeTabId = existing.id;
      emit('tabs', { activate: true });
      emit('rerender');
      return existing;
    }
  }
  const tab = createTabObject({
    refId: node.id,
      kind: protocol === 'ws' ? 'ws' : 'request',
    title: node.name || '未命名',
    draft: JSON.parse(JSON.stringify(node.request || newRequestDraft())),
      protocol,
    auth: JSON.parse(JSON.stringify(node.auth || newAuth())),
    description: node.description || '',
  });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  emit('tabs');
  emit('rerender');
  touch('tabs');
  return tab;
}

export function newTab(protocol = 'http') {
  // Normalise here rather than trusting callers: 'request' is a tab *kind*, not a
  // protocol, and four call sites had been passing it for years. The protocol
  // switch is a segmented control keyed by http/sse/ws, so an unknown value lit
  // no segment at all — and clicking HTTP could not repair it, because the
  // comparison was against the same unknown value.
  const wanted = protocol === 'ws' ? 'ws' : protocol === 'sse' ? 'sse' : 'http';
  const kind = wanted === 'ws' ? 'ws' : 'request';
  const env = activeEnv();
  let draft = newRequestDraft();
  if (kind === 'request' && env && env.defaults) {
    const defaults = env.defaults;
    if (defaults.urlPrefixMode === 'prefill' && defaults.baseUrl) draft.url = '{{baseUrl}}/';
    if (defaults.headers && defaults.headers.length) draft.headers = JSON.parse(JSON.stringify(defaults.headers));
    if (defaults.prefillBody && defaults.bodyMode && defaults.bodyMode !== 'none') {
      draft.body = newBody(defaults.bodyMode);
      if (defaults.bodyMode === 'raw') draft.body.raw = { language: defaults.bodyLanguage || 'json', content: defaults.bodyContent || '' };
    }
  }
  const tab = createTabObject({
    kind,
    protocol: wanted,
    title: kind === 'ws' ? 'WebSocket 连接' : '未命名请求',
    draft: kind === 'ws' ? { name: '', method: 'GET', url: '', params: [], headers: [], body: newBody(), settings: {} } : draft,
  });
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  emit('tabs');
  emit('rerender');
  touch('tabs');
  return tab;
}

export async function closeTab(id, { force = false } = {}) {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const tab = state.tabs[index];
  if(!force&&tab.dirty&&['request','ws'].includes(tab.kind)) {
    if(tab.closePending)return false;
    tab.closePending=true;
    return new Promise(resolve=>{
      let outcome=false;
      const dialog=modal({title:'保存修改后关闭？',width:460,body:[el('p',{text:titleFor(tab),style:{overflowWrap:'anywhere'}})],cancelText:'取消',okText:'保存并关闭',
        footer:[el('button',{class:'btn ghost',text:'放弃修改',onclick:async()=>{outcome=true;await closeTab(id,{force:true});dialog.close();}})],
        onOk:async()=>{if(tab.protocol==='ws')await (await import('./ws.js')).saveWs(tab);else await (await import('./request.js')).save(tab);if(tab.dirty)return false;outcome=true;await closeTab(id,{force:true});},
        onClose:()=>{tab.closePending=false;resolve(outcome);},
      });
    });
  }
  if (tab.running && tab.running.execId) api.cancel(tab.running.execId).catch(() => {});
  if (tab.stream && tab.stream.connId) api.wsDisconnect(tab.stream.connId).catch(() => {});
  if (tab.ws && tab.ws.connId) {
    if (tab.ws.pingTimer) clearInterval(tab.ws.pingTimer);
    api.wsDisconnect(tab.ws.connId).catch(() => {});
  }
  state.tabs.splice(index, 1);
  if (!state.tabs.length) state.tabs.push(createTabObject());
  if (state.activeTabId === id) state.activeTabId = state.tabs[Math.max(0, index - 1)].id;
  emit('tabs');
  emit('rerender');
  touch('tabs');
  return true;
}

export function activateTab(id) {
  if (state.activeTabId === id && !state.overviewPane) return;
  state.activeTabId = id;
  emit('tabs', { activate: true });
  emit('rerender');
  touch('tabs');
}

export function markDirty(tab = activeTab()) {
  if (!tab) return;
  tab.dirty = true;
  emit('tabs');
  touch('tabs');
}

export function titleFor(tab) {
  if (tab.kind === 'doc') {
    const doc = (state.docs || []).find((item) => item.id === tab.refId);
    return (doc && doc.name) || tab.title || '未命名文档';
  }
  if (tab.protocol === 'ws') return tab.draft.name || tab.title || 'WebSocket';
  return tab.draft.name || tab.title || '未命名请求';
}
