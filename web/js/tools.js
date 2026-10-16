import { el, icon, toast, modal, bytes as fmtBytes, duration, prettyTime, saveAs, confirmDialog, debounce, segmented, toggle, row, pickFile } from './ui.js';
import { selectField, menu } from './menu.js';
import { parseImport } from './import-formats.js';
import { state, touch, emit, uid, newRequestNode, newCollection, newTab, pathTo, findNode, openRequest, varScope, render, flushDomain } from './state.js';
import * as api from './api.js';
import { renderEnvPane } from './env.js';
import { applyAppearance, appearancePicker } from './themes.js';
import {inferProtocol, PROTOCOLS} from './protocol.js';

/* ============================= cURL 导入 ============================= */

/// Whatever an import creates is useless if it lands somewhere you are not
/// looking. Land on the first request that arrived (the workspace is where the
/// user lives), jump the tree to the collection pane with the ancestors open,
/// scroll the new rows into view and flash them once.
function revealImported(nodes) {
  const created = (nodes || []).filter((node) => node && node.id);
  if (!created.length) return;
  for (const node of created) {
    const trail = pathTo(node.id) || [];
    // open the collection (and any folder) the new row sits in, otherwise the
    // sidebar shows a collapsed header and the import still looks like it vanished
    for (const ancestor of trail) state.expanded[ancestor.id] = true;
  }
  const first = firstRequestIn(created);
  if (first) {
    state.selectedNodeIds = [first.id];
    openRequest(first);
  }
  if (state.pane !== 'collections') {
    state.pane = 'collections';
    emit('pane');
  } else {
    emit('tree');
  }
  requestAnimationFrame(() => {
    const want = new Set(created.map((node) => node.id));
    const hitRows = [...document.querySelectorAll('#sidebar .node')].filter((rowEl) => want.has(rowEl.dataset.node));
    if (!hitRows.length) return;
    hitRows[0].scrollIntoView({ block: 'center' });
    for (const hit of hitRows) {
      hit.classList.add('just-added');
      setTimeout(() => hit.classList.remove('just-added'), 1700);
    }
  });
}

/// Collections and folders are containers; what the user wants on screen is a
/// request, so walk down to the first one that arrived.
function firstRequestIn(nodes) {
  for (const node of nodes) {
    if (node.kind === 'request' || node.kind === 'ws') return node;
    const hit = firstRequestIn(node.children || []);
    if (hit) return hit;
  }
  return null;
}

/// DevTools' "Copy as cURL" is the single most common way an interface arrives,
/// so the clipboard is read once and decides which dialog is worth opening.
/// Returns false when the text is nothing we import, so the normal paste survives.
export function openImportFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  if (looksLikeCurl(trimmed)) {
    importCurlDialog(null, trimmed);
    return true;
  }
  return false;
}

function looksLikeCurl(text) {
  // a command copied from DevTools starts with curl; a batch may lead with a
  // comment, a semicolon or the tail of a shell continuation
  return /(^|\n|;|&&|\|\|)\s*curl(\s|$)/i.test(`\n${text}`) && text.length > 8;
}

export function importMenu(anchor, targetNode) {
  menu(anchor, [
    { label: 'cURL', hint: 'Ctrl I', icon: 'terminal', onSelect: () => importCurlDialog(targetNode) },
    { label: 'OpenAPI 3 · JSON', icon: 'file', onSelect: () => importFormatDialog('openapi', targetNode) },
    { label: 'HAR', icon: 'file', onSelect: () => importFormatDialog('har', targetNode) },
  ]);
}

export function importFormatDialog(format, targetNode, prefill = '') {
  let parsed = null, parsedText = '', generation = 0;
  const area = el('textarea', { class: 'textarea mono', rows: 6, value: prefill, spellcheck: false,
    dataset: {variables:'false'},
    'aria-label': '导入 JSON', placeholder: format === 'har' ? '粘贴 HAR JSON' : '粘贴 OpenAPI 3 JSON' });
  const preview = el('div', { class: 'format-import-preview' });
  const warning = el('div', { class: 'format-import-warnings' });
  const error = el('p', { class: 'check-error', role: 'status' });
  const name = el('input', { class: 'input', value: '', 'aria-label': '新集合名称' });
  const keep = el('input', { type: 'checkbox', onchange: () => parse() });
  const selectedTarget = selectField({title:'导入到',value:'__new',options:[['__new','新集合'],...state.collections.map(c=>[c.id,c.name])],
    onChange:()=>{newField.hidden=selectedTarget.value!=='__new';}});
  selectedTarget.setAttribute('aria-label','导入到');
  selectedTarget.value = targetNode?.kind === 'collection' ? targetNode.id : '__new';
  const newField = el('label', { class: 'rule-field' }, [el('span', { text: '集合名称' }), name]);
  newField.hidden = selectedTarget.value !== '__new';
  const parse = () => {
    generation++; parsed = null; preview.replaceChildren(); warning.replaceChildren(); error.textContent = '';
    if (!area.value.trim()) { parsedText = ''; return; }
    try {
      parsed = parseImport(area.value, format, { keepSensitive: keep.checked }); parsedText = area.value;
      if (!name.value.trim()) name.value = parsed.name;
      if (!parsed.items.length) throw Error('没有可导入的请求');
      for (const item of parsed.items) {
        item.protocol = inferProtocol(item.draft, item.protocol === 'http' ? undefined : item.protocol);
        const title = el('input', { class: 'input', value: item.name, 'aria-label': '请求名称', oninput: event => { item.name = event.target.value; } });
        preview.append(el('div', { class: 'format-import-row' }, [
          el('input', { type: 'checkbox', checked: true, 'aria-label': `导入 ${item.name}` }),
          el('span', { class: `badge method-${item.draft.method.toLowerCase()}`, text: item.draft.method }),
          el('div', { class: 'format-import-identity' }, [title, el('code', { text: item.draft.url, title: item.draft.url })]),
          el('span', { class: 'count', text: item.protocol.toUpperCase() }),
        ]));
      }
      warning.replaceChildren(...parsed.warnings.map(text => el('p', { class: 'rules-note', text })));
    } catch (e) { parsed = null; parsedText = ''; error.textContent = e.message; }
  };
  area.addEventListener('input', () => { parsed = null; parsedText = ''; const current = ++generation; setTimeout(() => { if (generation === current) parse(); }, 250); });
  const file = el('input', { type: 'file', accept: '.json,.har', hidden: true, onchange: async () => {
    const picked = file.files[0]; if (!picked) return;
    if (picked.size > 16 * 1024 * 1024) { error.textContent = '文件超过 16 MiB'; return; }
    try { area.value = await picked.text(); parse(); }
    catch { error.textContent = '无法读取文件，请重新选择或粘贴 JSON'; }
  } });
  const dialog = modal({ title: format === 'har' ? '导入 HAR' : '导入 OpenAPI 3', width: 900,
    body: [el('div', { class: 'stack' }, [
      el('div', { class: 'btn-row' }, [selectField({title:'导入格式',value:format,options:[['openapi','OpenAPI 3 · JSON'],['har','HAR']],onChange:next=>{
        format=next; dialog.box.querySelector('.modal-head h2').textContent=next==='har'?'导入 HAR':'导入 OpenAPI 3'; parse();
      }}),el('button', { class: 'btn sm', text: '选择文件', onclick: () => file.click() }), file,
        el('label', { class: 'format-import-sensitive right' }, [keep, '保留敏感请求头和参数'])]), area, error,
      el('div', { class: 'rules-heading' }, [el('h4', { text: '请求预览' }), el('button', { class: 'btn sm ghost right', text: '全选 / 取消', onclick: () => {
        const boxes = [...preview.querySelectorAll('input[type=checkbox]')], all = boxes.every(box => box.checked); boxes.forEach(box => box.checked = !all);
      } })]), preview, warning,
      el('div', { class: 'rule-fields' }, [el('label', { class: 'rule-field' }, [el('span', { text: '导入到' }), selectedTarget]), newField]),
    ])], okText: '导入', onOk: async () => {
      // Keep edited preview titles: don't reparse unchanged source on confirmation.
      if (parsedText !== area.value) { parse(); toast('来源已更新，请检查预览后再导入', 'err'); return false; }
      if (!parsed) return false;
      const chosen = parsed.items.filter((_, index) => preview.querySelectorAll('input[type=checkbox]')[index].checked);
      if (!chosen.length) { toast('至少选择一条请求', 'err'); return false; }
      let parent = state.collections.find(c => c.id === selectedTarget.value);
      if (selectedTarget.value !== '__new' && !parent) { toast('目标集合已删除，请重新选择', 'err'); return false; }
      const createdCollection = !parent;
      if (!parent) { parent = newCollection(name.value.trim() || parsed.name); state.collections.push(parent); }
      const nodes = chosen.map(item => {
        const title = item.name.trim() || item.draft.url;
        const node = newRequestNode(title, { ...item.draft, name: title });
        node.protocol = item.protocol; node.kind = item.protocol === 'ws' ? 'ws' : 'request'; node.description = item.description || '';
        node.auth = { kind: 'noauth' }; return node;
      });
      parent.children.push(...nodes); touch('collections');
      try { await flushDomain('collections', { strict: true }); }
      catch {
        parent.children = parent.children.filter(node => !nodes.includes(node));
        if (createdCollection) state.collections = state.collections.filter(collection => collection !== parent);
        touch('collections'); error.textContent = '保存失败，未完成导入。修复数据目录后可重试。'; return false;
      }
      revealImported(nodes);
      toast(`已导入 ${nodes.length} 个请求到「${parent.name}」`, 'ok');
    },
  });
  dialog.box.classList.add('format-import-dialog'); parse(); return dialog;
}

export function importCurlDialog(targetNode, prefill = '') {
  const area = el('textarea', {
    class: 'textarea mono',
    rows: 9,
    placeholder:
      "curl -X POST 'https://api.example.com/v1/orders' -H 'Content-Type: application/json' -d '{\"id\":1}'\n" +
      '每行一条，也可用 ; 分隔批量粘贴。',
  });
  const preview = el('div', { class: 'rows' });
  const note = el('p', { class: 'hint', style: { margin: '0' }, text: '' });
  const targetSelect = selectField({
    className: 'import-target',
    onChange: () => {
      newField.style.display = targetSelect.value === '__new' ? '' : 'none';
    },
  });
  const newName = el('input', { class: 'input', value: `导入的接口 ${new Date().toISOString().slice(0, 10)}` });
  // hide the whole field, not just the input — an orphan label reads as unfinished
  const newField = el('div', { class: 'field', style: { minWidth: '260px', display: 'none' } }, [
    el('label', { text: '新集合名称' }),
    newName,
  ]);
  let parsed = [];
  let broken = '';
  let parsedText = null;
  let parseVersion = 0;
  let pendingParse = null;
  const edits = new Map();
  const itemKey = (item, index) => `${index}:${item.source || `${item.draft?.method}:${item.draft?.url}`}`;

  const fillTargets = () => {
    targetSelect.setOptions([
      ...state.collections.map((collection) => ({ value: collection.id, label: collection.name })),
      { value: '__new', label: '＋ 新建集合并导入' },
    ]);
    if (targetNode) {
      const hit = findNode(targetNode.id);
      const collection = hit ? pathTo(targetNode.id)[0] : null;
      if (collection) targetSelect.value = collection.id;
    }
    newField.style.display = targetSelect.value === '__new' ? '' : 'none';
  };
  fillTargets();

  /// Parsing is not a step of its own: the list fills while you paste, so 导入
  /// is always the next thing you can do.
  async function runParse({ noisy = false } = {}) {
    const text = area.value.trim();
    if (text === parsedText && !broken) return;
    if (pendingParse?.text === text) return pendingParse.promise;
    const version = ++parseVersion;
    const before = parsed.length;
    if (!text) {
      parsed = [];
      parsedText = text;
      broken = '';
      drawPreview();
      return;
    }
    const promise = (async () => {
      try {
        const result = await api.parseCurl(text);
        if (version !== parseVersion || text !== area.value.trim()) return;
        parsed = result;
        parsedText = text;
        broken = '';
        if (parsed.length > 1 && parsed.length !== before) toast(`识别到 ${parsed.length} 条命令`, 'ok', 2200);
      } catch (error) {
        if (version !== parseVersion || text !== area.value.trim()) return;
        parsed = [];
        parsedText = null;
        broken = String((error && error.message) || error);
        if (noisy) toast(broken, 'err', 6000);
      }
      drawPreview();
    })();
    pendingParse = { text, promise };
    try { await promise; }
    finally { if (pendingParse?.promise === promise) pendingParse = null; }
  }
  area.addEventListener('input', debounce(() => runParse(), 400));
  area.addEventListener('paste', () => setTimeout(() => runParse(), 0));
  // Ctrl+V on the page hands the text straight over, so the list is already
  // filled by the time the dialog is up
  if (prefill) {
    area.value = prefill;
    runParse();
  }

  function drawPreview() {
    preview.replaceChildren(
      ...parsed.map((item, index) => {
        const key = itemKey(item, index);
        const edit = edits.get(key) || { selected: true };
        edits.set(key, edit);
        const checkbox = el('input', { type: 'checkbox', class: 'check', checked: edit.selected, onchange: () => {edit.selected = checkbox.checked;} });
        checkbox.dataset.index = String(index);
        const draft = item.draft || {};
        const protocol=edit.protocol || inferProtocol(draft,item.protocol);
        item.protocol=protocol;
        if (edit.name !== undefined) draft.name = edit.name;
        const failed = !draft.url;
        const nameInput = el('input', {
          class: 'input', value: draft.name ?? `请求 ${index + 1}`, style: { width: '200px' },
          'aria-label': `请求 ${index + 1} 名称`, dataset: { variables: 'false' },
          oninput: (event) => {draft.name = event.target.value;edit.name = draft.name;},
        });
        return el('div', { class: 'pick' }, [
          checkbox,
          selectField({value:protocol,options:PROTOCOLS,title:`请求 ${index+1} 协议`,className:'import-protocol',onChange:next=>{edit.protocol=next;item.protocol=next;}}),
          el('span', { class: `mono small method-${(draft.method || 'get').toLowerCase()}`, text: draft.method || '—', style: { minWidth: '52px' } }),
          nameInput,
          el('span', { class: 'grow mono small', text: draft.url || item.source, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
          el('span', { class: 'count', text: `${(draft.headers || []).length} 头` }),
          draft.body && draft.body.mode !== 'none' ? el('span', { class: 'count', text: draft.body.mode }) : null,
          (item.warnings || []).length
            ? el('span', {
                class: 'hint',
                title: item.warnings.join('\n'),
                text: `⚠ ${item.warnings.length}`,
                style: { color: failed ? 'var(--err)' : 'var(--warn)' },
              })
            : null,
        ]);
      })
    );
    if (parsed.length) {
      preview.appendChild(
        el('p', { class: 'hint', text: '由引擎计算的头（Content-Length / Host）会自动忽略，悬停 ⚠ 看原因。' })
      );
    }
    if (broken) {
      preview.appendChild(el('p', { class: 'hint', style: { color: 'var(--err-ink)' }, text: broken }));
    }
    note.textContent = parsed.length
      ? `识别到 ${parsed.length} 条 · 取消勾选即可跳过`
      : '';
  }

  modal({
    title: '导入 cURL',
    width: 980,
    body: [
      el('div', { class: 'section' }, [el('h4', { text: '粘贴 curl 命令' }), area, note]),
      el('div', { class: 'section' }, [el('h4', { text: '识别到的请求' }), preview]),
      el('div', { class: 'inline' }, [
        el('div', { class: 'field', style: { minWidth: '260px' } }, [el('label', { text: '导入到' }), targetSelect]),
        newField,
      ]),
    ],
    okText: '导入',
    onOk: async () => {
      await runParse({ noisy: true });
      if (broken || parsedText !== area.value.trim()) return false;
      const boxes = [...preview.querySelectorAll('input[type=checkbox]')];
      const chosen = boxes.map((box, index) => ({ box, index })).filter((entry) => entry.box.checked).map((entry) => parsed[entry.index]);
      if (!chosen.length) {
        toast('至少勾选一条', 'err');
        return false;
      }
      let parent;
      if (targetSelect.value === '__new') {
        const collection = newCollection(newName.value.trim() || '导入的接口');
        state.collections.push(collection);
        parent = collection;
      } else {
        parent = state.collections.find((item) => item.id === targetSelect.value) || state.collections[0];
      }
      if (!parent) parent = createCollectionFallback();
      const created = [];
      for (const item of chosen) {
        if (!item.draft || !item.draft.url) continue;
        const draft = { ...item.draft, name: item.draft.name?.trim() || item.draft.url };
        const node = newRequestNode(draft.name || draft.url, draft);
        node.protocol=item.protocol || inferProtocol(draft);
        node.kind=node.protocol==='ws'?'ws':'request';
        if(node.protocol==='ws') {
          node.request.subprotocols=(draft.headers||[]).filter(h=>h.enabled!==false&&/^sec-websocket-protocol$/i.test(h.key)).flatMap(h=>h.value.split(',').map(value=>value.trim()).filter(Boolean));
        }
        node.request.params = draft.params || [];
        node.request.headers = draft.headers || [];
        node.request.body = draft.body || node.request.body;
        node.request.settings = draft.settings || {};
        node.auth = { kind: 'noauth' };
        parent.children.push(node);
        created.push(node);
      }
      touch('collections');
      toast(
        `已导入 ${created.length} 个请求到「${parent.name}」` + (created.length > 1 ? '，已打开第一个，其余在集合里' : ''),
        'ok',
        3000
      );
      revealImported(created);
    },
  });
}

function createCollectionFallback() {
  const collection = newCollection('导入的接口');
  state.collections.push(collection);
  return collection;
}

/* ============================= 导出 ============================= */

export function exportCollectionDialog(collection) {
  const json = toPostmanCollection(collection);
  const area = el('textarea', { class: 'textarea mono', rows: 16, readonly: true, value: JSON.stringify(json, null, 2) });
  modal({
    title: `导出集合：${collection.name}`,
    width: 900,
    body: [
      el('p', { class: 'hint', text: '集合 JSON' }),
      area,
    ],
    okText: '保存 JSON',
    cancelText: '关闭',
    onOk: async () => {
      await saveAs({
        name: `${safe(collection.name)}-collection.json`,
        text: JSON.stringify(json, null, 2),
        extensions: ['json'],
      });
    },
  });
}

function safe(name) {
  return String(name || 'collection').replace(/[\\/:*?"<>|]/g, '_');
}

export function toPostmanCollection(collection) {
  return {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      description: collection.description || '由 Relay 导出',
    },
    item: (collection.children || []).map(toPostmanItem),
    variable: (collection.variables || []).map((v) => ({ key: v.key, value: v.value, description: v.description })),
    // Preserve collection defaults in the export's extension metadata.
    _relay: (collection.headers || []).length
      ? { headers: collection.headers.map((v) => ({ key: v.key, value: v.value, description: v.description, enabled: v.enabled !== false })) }
      : undefined,
    auth: collection.auth && collection.auth.kind !== 'inherit' ? toPostmanAuth(collection.auth) : undefined,
  };
}

function toPostmanItem(node) {
  if (node.kind === 'folder') {
    return { name: node.name, auth: node.auth && node.auth.kind !== 'inherit' ? toPostmanAuth(node.auth) : undefined, item: (node.children || []).map(toPostmanItem) };
  }
  const request = node.request || {};
  return {
    name: node.name,
    _relay:{protocol:node.protocol || (node.kind==='ws'?'ws':'http'),subprotocols:request.subprotocols || []},
    request: {
      auth:node.auth && node.auth.kind !== 'inherit' ? toPostmanAuth(node.auth) : undefined,
      method: request.method || 'GET',
      header: (request.headers || []).map((h) => ({ key: h.key, value: h.value, disabled: h.enabled === false, description: h.description })),
      url: {
        raw: request.url || '',
        query: (request.params || []).map((p) => ({ key: p.key, value: p.value, disabled: p.enabled === false })),
      },
      body: toPostmanBody(request.body),
      description: node.description || undefined,
    },
  };
}

function toPostmanBody(body) {
  if (!body || body.mode === 'none') return undefined;
  if (body.mode === 'raw') return { mode: 'raw', raw: body.raw.content, options: { raw: { language: body.raw.language } } };
  if (body.mode === 'urlencoded') return { mode: 'urlencoded', urlencoded: body.urlencoded.map((i) => ({ key: i.key, value: i.value, disabled: i.enabled === false })) };
  if (body.mode === 'form') return { mode: 'formdata', formdata: body.form.map((i) => ({ key: i.key, value: i.value, type: i.kind === 'file' ? 'file' : 'text', src: i.kind === 'file' ? i.value : undefined, disabled: i.enabled === false })) };
  if (body.mode === 'file') return { mode: 'file', file: { src: body.file } };
  return undefined;
}

function toPostmanAuth(auth) {
  if (auth.kind === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: auth.bearer.token }] };
  if (auth.kind === 'basic') return { type: 'basic', basic: [{ key: 'username', value: auth.basic.username }, { key: 'password', value: auth.basic.password }] };
  if (auth.kind === 'apikey') return { type: 'apikey', apikey: [{ key: 'key', value: auth.apikey.key }, { key: 'value', value: auth.apikey.value }, { key: 'in', value: auth.apikey.addTo }] };
  return { type: 'noauth' };
}

/* ============================= 历史 ============================= */

let historyFilter = '';

export function renderHistoryPane(host) {
  const search = el('input', {
    class: 'input',
    placeholder: '搜索历史',
    value: historyFilter,
    oninput: (event) => {
      historyFilter = event.target.value.toLowerCase();
      paint(listHost);
    },
  });
  const listHost = el('div', { class: 'sidebar-body' });
  host.replaceChildren(
    el('div', { class: 'sidebar-head' }, [
      el('div', { class: 'search' }, [search]),
      el('button', {
        class: 'btn icon',
        title: '清空历史',
        onclick: async () => {
          if (!state.history.length) return;
          if (!(await confirmDialog('清空全部历史记录？'))) return;
          state.history = [];
          touch('history');
          paint(listHost);
        },
      }, [icon('trash')]),
    ]),
    listHost
  );
  paint(listHost);
}

function paint(listHost) {
  const items = state.history.filter((entry) => !historyFilter || `${entry.name} ${entry.url}`.toLowerCase().includes(historyFilter));
  if (!items.length) {
    listHost.replaceChildren(el('p', { class: 'hint', style: { padding: '10px' }, text: '还没有历史记录。' }));
    return;
  }
  listHost.replaceChildren(
    ...items.map((entry) =>
      el(
        'div',
        {
          class: 'node',
          title: `${entry.url}\n${prettyTime(entry.at)}`,
          onclick: () => {
            const tab = newTab(entry.kind === 'ws' ? 'ws' : 'request');
            tab.draft = JSON.parse(JSON.stringify(entry.snapshot || tab.draft));
            tab.auth = JSON.parse(JSON.stringify(entry.auth || { kind: 'inherit' }));
            tab.protocol = entry.protocol || 'http';
            tab.title = entry.name || '历史请求';
            emit('tabs');
            emit('rerender');
          },
        },
        [
          el('span', { class: `badge method-${(entry.method || 'get').toLowerCase()}`, text: entry.kind === 'ws' ? 'WS' : (entry.method || '').slice(0, 6) }),
          el('span', { class: 'name', text: entry.name || entry.url }),
          entry.status ? el('span', { class: `count`, text: String(entry.status), style: { color: entry.status < 400 ? 'var(--ok)' : 'var(--err)' } }) : null,
          el('span', { class: 'faint small nowrap', text: duration(entry.timeMs || 0) }),
          el('span', { class: 'faint small nowrap', text: fmtBytes(entry.sizeBytes) }),
          el('span', { class: 'faint small nowrap', text: relative(entry.at) }),
        ]
      )
    )
  );
}

function relative(at) {
  const delta = Date.now() - Number(at);
  if (delta < 60000) return '刚刚';
  if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`;
  if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`;
  return `${Math.floor(delta / 86400000)} 天前`;
}

/* ============================= 设置 ============================= */

export function openSettingsDialog() {
  let appearanceSaved = false;
  const palette = appearancePicker(state.settings.palette || 'mint', value => {
    pending.palette = value; applyAppearance(pending);
  });
  const theme = segmented(
    [['dark', '深色'], ['light', '浅色']],
    state.settings.theme === 'light' ? 'light' : 'dark',
    (value) => { pending.theme = value; applyAppearance(pending); }
  );
  const uiZoom = segmented(
    [['0.94', '紧凑'], ['1', '标准'], ['1.08', '偏大'], ['1.18', '大字'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%']],
    String(state.settings.uiZoom || 1),
    (value) => (pending.uiZoom = Number(value))
  );
  const timeout = el('input', { class: 'input mono', type: 'number', min: '0', value: state.settings.timeoutMs });
  const sseTimeout = el('input', { class: 'input mono', type: 'number', min: '0', value: state.settings.sseFirstByteMs });
  const maxHistory = el('input', { class: 'input mono', type: 'number', min: '10', value: state.settings.maxHistory });
  const proxy = el('input', { class: 'input mono', value: state.settings.proxy || '', placeholder: 'http://127.0.0.1:7890' });
  const ssl = toggle(state.settings.sslVerify, (on) => (pending.sslVerify = on), '校验 SSL 证书');
  const redirects = toggle(state.settings.followRedirects, (on) => (pending.followRedirects = on), '自动跟随重定向');
  const jar = toggle(state.settings.cookieJar, (on) => (pending.cookieJar = on), '共享 Cookie');
  const hideToTray = toggle(state.settings.hideToTray !== false, (on) => (pending.hideToTray = on), '关闭窗口时收进托盘');
  const pathHost = el('span', { class: 'mono small' });
  api.dataPath().then((value) => (pathHost.textContent = value));
  const changeDirectory = () => {
    const path = el('input', { class: 'input mono', 'aria-label': '新数据目录', placeholder: 'D:\\Relay-data', dataset: { variables: 'false' } });
    const error = el('div', { class: 'variable-form-error', role: 'alert' });
    modal({title: '迁移数据目录', width: 620, okText: '迁移并使用', body: [
      el('p', { class: 'hint', text: '选择空目录。复制全部工作区数据后立即切换，原目录保留。' }),
      el('div', { class: 'inline' }, [path, el('button', { class: 'btn', text: '选择目录', onclick: async () => {const picked = await pickFile({ title: '选择数据目录', directory: true });if(picked)path.value=picked;} })]),error,
    ], onOk: async () => {
      if (!path.value.trim()) {error.textContent='请选择或填写目录';return false;}
      const {sessionOf}=await import('./runner.js');
      if (state.tabs.some(tab=>tab.running || ['open','opening'].includes(tab.ws?.status)) || state.docs.some(doc=>doc.blocks.some(block=>block.running || block.preparing)) || state.runners.some(runner=>sessionOf(runner.id))) {error.textContent='请先停止正在运行的请求和计划';return false;}
      try {
        await Promise.all(['collections','environments','docs','history','runners','runs','settings','tabs'].map(domain=>flushDomain(domain,{strict:true})));
        pathHost.textContent = await api.migrateDataDirectory(path.value.trim());
        toast('数据目录已切换，原数据保留', 'ok');
      } catch (e) {error.textContent=String(e.message || e);return false;}
    }});
  };
  const pending = {
    theme: state.settings.theme,
    palette: state.settings.palette || 'mint',
    uiZoom: Number(state.settings.uiZoom || 1),
    sslVerify: state.settings.sslVerify,
    followRedirects: state.settings.followRedirects,
    cookieJar: state.settings.cookieJar,
    hideToTray: state.settings.hideToTray !== false,
  };

  const sections = [
    {
      id: 'general',
      label: '通用',
      icon: 'sun',
      title: '通用',
      body: [
        el('div', { class: 'group' }, [
          row('外观', theme),
          row('界面字号', uiZoom),
          toggleRow(hideToTray, '关闭窗口时收进托盘', '定时计划在后台继续运行。关掉后，点关闭窗口就是退出。'),
        ]),
        el('div', { class: 'theme-section' }, [el('h3', { text: '主题配色' }), palette]),
      ],
    },
    {
      id: 'request',
      label: '请求',
      icon: 'send',
      title: '请求默认值',
      body: [
        el('div', { class: 'group' }, [
          row('默认超时', timeout, { detail: '毫秒，0 表示不限' }),
          row('SSE 首帧超时', sseTimeout, { detail: 'ms' }),
        ]),
        el('div', { class: 'group' }, [
          toggleRow(ssl, '校验 SSL 证书', ''),
          toggleRow(redirects, '自动跟随重定向', ''),
          toggleRow(jar, '共享 Cookie', ''),
        ]),
      ],
    },
    {
      id: 'data',
      label: '数据',
      icon: 'folder',
      title: '数据与网络',
      body: [
        el('div', { class: 'group' }, [
          row('全局代理', proxy, { detail: '留空则跟随系统' }),
          row('历史条数上限', maxHistory, { detail: '' }),
        ]),
        el('div', { class: 'group' }, [row('数据目录', el('div', { class: 'data-directory-controls' }, [pathHost, el('button', { class: 'btn sm', text: '更改', onclick: changeDirectory })]))]),
      ],
    },
    {
      id: 'keys',
      label: '快捷键',
      icon: 'bolt',
      title: '快捷键',
      // the full list lives in its own drawer, so settings just points at it
      body: [
        el('div', { class: 'group' }, [
          el('div', { class: 'row' }, [
            el('div', { class: 'row-label' }, [
              el('span', { text: '快捷键列表' }),
              el('span', { class: 'row-detail', text: '按 ? 也能打开' }),
            ]),
            el('div', { class: 'row-value' }, [
              el('button', { class: 'btn sm', text: '查看列表', onclick: () => openShortcuts() }),
            ]),
          ]),
        ]),
      ],
    },
  ];
  sections.splice(3, 0, {
    id: 'automation', label: 'AI 连接', icon: 'braces', title: 'AI 连接',
    body: [el('div', { class: 'group' }, [row('当前工作区', el('button', { class: 'btn', text: '管理连接', onclick: async () => (await import('./automation.js')).openAutomationDialog() }), { detail: '创建请求 · 运行检查 · 编写文档' })])],
  });

  const main = el('div', { class: 'settings-main' });
  const navButtons = sections.map((item, index) =>
    el(
      'button',
      {
        class: index === 0 ? 'on' : '',
        type: 'button',
        onclick: () => {
          navButtons.forEach((b, i) => b.classList.toggle('on', i === index));
          main.replaceChildren(
            el('div', { class: 'settings-title', text: item.title }),
            ...item.body
          );
        },
      },
      [icon(item.icon), el('span', { text: item.label })]
    )
  );
  navButtons[0].click();

  modal({
    title: '设置',
    width: 720,
    body: [el('div', { class: 'settings' }, [el('nav', { class: 'settings-nav' }, navButtons), main])],
    okText: '保存设置',
    onClose: () => { if (!appearanceSaved) applyAppearance(); },
    onOk: async () => {
      const previousSettings = { ...state.settings };
      state.settings.theme = pending.theme;
      state.settings.palette = pending.palette;
      state.settings.uiZoom = pending.uiZoom || 1;
      state.settings.timeoutMs = Number(timeout.value || 60000);
      state.settings.sseFirstByteMs = Number(sseTimeout.value || 15000);
      state.settings.maxHistory = Number(maxHistory.value || 300);
      state.settings.proxy = proxy.value.trim();
      state.settings.sslVerify = pending.sslVerify;
      state.settings.followRedirects = pending.followRedirects;
      state.settings.cookieJar = pending.cookieJar;
      state.settings.hideToTray = pending.hideToTray;
      touch('settings');
      try { await flushDomain('settings', { strict: true }); }
      catch (error) { state.settings = previousSettings; throw error; }
      appearanceSaved = true;
      emit('theme');
      applyAppearance();
      import('./app.js').then(({ applyUiZoom }) => applyUiZoom());
    },
  });
}

const SHORTCUT_GROUPS = [
  ['通用', [
    ['命令面板', ['Ctrl', 'K']],
    ['打开/关闭本面板', ['?']],
    ['切换深浅色', ['Ctrl', '/']],
    ['导入 cURL', ['Ctrl', 'I']],
    ['关闭当前标签', ['Ctrl', 'W']],
  ]],
  ['请求', [
    ['发送当前请求', ['Ctrl', '↵']],
    ['保存', ['Ctrl', 'S']],
    ['新建请求', ['Ctrl', 'N']],
    ['新建 WebSocket', ['Ctrl', '⇧', 'N']],
    ['聚焦地址栏', ['F6']],
  ]],
  ['标签页', [
    ['下一个标签', ['Ctrl', '⇥']],
    ['上一个标签', ['Ctrl', '⇧', '⇥']],
    ['跳到第 N 个', ['Ctrl', '1…8']],
    ['跳到最后一个', ['Ctrl', '9']],
  ]],
  ['集合树', [
    ['加选 / 减选一项', ['Ctrl', '点击']],
    ['连选可见的一串', ['⇧', '点击']],
    ['全选可见项', ['Ctrl', 'A']],
    ['删除选中的项', ['Delete']],
    ['取消选择', ['Esc']],
  ]],
];

/// The one place bindings are listed. It is a drawer rather than a page because
/// nobody reads a shortcut sheet on the way past it — they call it when stuck.
/// `?` both opens and closes it, so the key never needs to know which state it is in.
let closeShortcuts = null;

export function openShortcuts() {
  if (closeShortcuts) {
    closeShortcuts();
    return;
  }
  const search = el('input', {
    class: 'input',
    placeholder: '搜索快捷键',
    'aria-label': '搜索快捷键',
    oninput: () => draw(),
  });
  const list = el('div', { class: 'stack' });

  function matches(query, label, keys) {
    return (
      !query ||
      label.toLowerCase().includes(query) ||
      keys.join(' ').toLowerCase().includes(query)
    );
  }

  function draw() {
    const query = search.value.trim().toLowerCase();
    const shown = SHORTCUT_GROUPS
      .map(([title, items]) => [title, items.filter(([label, keys]) => matches(query, label, keys))])
      .filter(([, items]) => items.length);
    if (!shown.length) {
      list.replaceChildren(
        el('div', { class: 'empty', style: { height: 'auto', padding: '28px' } }, [
          el('p', { text: `没有匹配「${search.value.trim()}」的快捷键` }),
        ])
      );
      return;
    }
    list.replaceChildren(
      ...shown.map(([title, items]) =>
        el('div', { class: 'group' }, [
          el('div', { class: 'group-head', text: title }),
          ...items.map(([label, keys]) =>
            el('div', { class: 'row' }, [
              el('div', { class: 'row-label', text: label }),
              el('div', { class: 'row-value' }, [
                el('div', { class: 'inline', style: { gap: '4px' } }, keys.map((k) => el('kbd', { class: 'kbd', text: k }))),
              ]),
            ])
          ),
        ])
      )
    );
  }

  draw();
  modal({
    title: '快捷方式',
    side: 'right',
    width: 400,
    cancelText: '',
    body: [search, list],
    onClose: () => {
      closeShortcuts = null;
    },
    onMount: ({ close }) => {
      closeShortcuts = close;
      // ? is the panel's own binding, so once the panel is up it has to close it
      search.addEventListener('keydown', (event) => {
        if (event.key === '?' && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          close();
        }
      });
    },
  });
}

function toggleRow(input, label, hint) {
  return el('div', { class: 'row' }, [
    el('div', { class: 'row-label' }, [
      el('span', { text: label }),
      hint ? el('span', { class: 'row-detail', text: hint }) : null,
    ]),
    el('div', { class: 'row-value' }, [input]),
  ]);
}
