import { el, icon, toast, copy, pickFile, fileMeta, bytes as fmtBytes, autoGrow, oneLine, toggle as switchControl, segmented } from './ui.js';
import { renderKvEditor } from './kv.js';
import { menu, selectField } from './menu.js';
import { renderAuthPicker, authSummary } from './auth.js';
import { renderSseView } from './sse.js';
import { protocolSwitch, setProtocol } from './protocol.js';
import { openRequestPreview, requestSnapshot, requestCurl, requestContext } from './preview.js';
import {
  state,
  activeTab,
  syncParamsFromUrl,
  syncUrlFromParams,
  markDirty,
  touch,
  flushDomain,
  emit,
  newBody,
  buildSendDraft,
  findNode,
  newRequestNode,
  effectiveAuth,
  collectionHeaders,
  pushHistory,
  uid,
} from './state.js';
import * as api from './api.js';
import {createBodyEditor} from './body-editor.js';
import { evaluateChecks } from './checks.js';
import { renderCheckEditor } from './check-editor.js';

const TABS = [
  ['params', 'Params'],
  ['headers', 'Headers'],
  ['body', 'Body'],
  ['auth', 'Auth'],
  ['checks', '检查与提取'],
  ['settings', 'Settings'],
];

export const SUBTAB_HOST = 'request';

export function titleRow(tab, draft, placeholder = '未命名请求') {
  const title = el('input', {
    class: 'req-title',
    value: draft.name || '',
    placeholder,
    spellcheck: 'false',
    title: '重命名（回车完成）',
    oninput: (event) => {
      draft.name = event.target.value;
      tab.title = draft.name || placeholder;
      // the sidebar row carries the same name; leaving it behind reads as "the
      // rename went nowhere". Patch the one row rather than rebuild the tree
      // on every keystroke.
      if (tab.refId && draft.name) {
        const hit = findNode(tab.refId);
        if (hit) {
          hit.node.name = draft.name;
          if (hit.node.request) hit.node.request.name = draft.name;
          touch('collections');
          const row = document.querySelector(`#sidebar .node[data-node="${tab.refId}"] .name`);
          if (row) row.textContent = draft.name;
        }
      }
      markDirty(tab);
      emit('tabs');
    },
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.target.blur();
      }
    },
  });
  /* The strip right of the title was dead for years: a 460px input on a 1111px
     row. What belongs there is the one thing the pane never told you — which
     collection this request lives in. With several tabs open the tab label says
     "订单列表" and nothing says where it came from.
     Deliberately no save indicator: the Send-adjacent button already reads
     保存 / 已保存, and a second copy of that state would go stale on every
     keystroke because renaming does not re-render this row. */
  const hit = tab.refId ? findNode(tab.refId) : null;
  const trail = hit && hit.path.length > 1 ? hit.path.slice(0, -1) : [];
  return el('div', { class: 'titlebar' }, [
    title,
    trail.length
      ? el(
          'button',
          {
            class: 'req-crumb',
            type: 'button',
            title: '在左侧集合树中定位',
            onclick: () => revealInTree(tab.refId),
          },
          trail.flatMap((node, index) => [
            index ? el('span', { class: 'req-crumb-sep', text: '/' }) : null,
            el('span', { text: node.name || '未命名' }),
          ])
        )
      : null,
    tab.protocol==='http'?el('button',{class:'btn sm delivery-add-request',onclick:()=>import('./doc.js').then(({addRequestToDocument})=>addRequestToDocument(tab))},[icon('file'),el('span',{text:'加入文档'})]):null,
  ]);
}

async function revealInTree(nodeId) {
  const hit = findNode(nodeId);
  if (!hit) return;
  // a collapsed ancestor would hide the row, and a control that sometimes does
  // nothing is worse than no control
  for (const ancestor of hit.path) state.expanded[ancestor.id] = true;
  state.pane='collections';state.selectedNodeIds=[nodeId];
  const {setFilter}=await import('./tree.js');setFilter('');
  emit('pane');
  emit('tree');
  const row = document.querySelector(`#sidebar .node[data-node="${nodeId}"]`);
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
    // the import-landing flash already exists and already self-clears on the next
    // tree render; a second "here it is" animation would be the same gesture twice
    row.classList.add('just-added');
  }
}

export function renderRequestPane(tab) {
  const draft = tab.draft;
  const wrap = el('div', { class: 'pane-scroll' });
  if(tab.view==='body'&&draft.body?.mode==='raw'&&!tab.previewPinned)wrap.classList.add('body-editing');

  /* ---- URL row ---- */
  const proto = protocolSwitch(tab);

  // the verb colours the composer, and the list of verbs is a themed menu —
  // a native select popup cannot carry the theme and looked foreign here
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const methodName = el('span', { text: draft.method || 'GET' });
  const method = el(
    'button',
    {
      type: 'button',
      class: `method-pick method-${String(draft.method || 'GET').toLowerCase()}`,
      title: '请求方法',
      onclick: (event) => {
        const trigger = event.currentTarget;
        menu(
          trigger,
          METHODS.map((name) => ({
            label: name,
            itemClass: `method-${name.toLowerCase()}`,
            icon: (draft.method || 'GET') === name ? 'check' : null,
            onSelect: () => {
              draft.method = name;
              methodName.textContent = name;
              trigger.className = `method-pick method-${name.toLowerCase()}`;
              persistDraft(tab);
              refreshPendingTarget(tab);
            },
          })),
          { align: 'start' }
        );
      },
    },
    [methodName, icon('chevD')]
  );

  const url = el('textarea', {
    class: 'input url-input',
    'aria-label': '请求地址',
    rows: 1,
    placeholder: 'https://api.example.com/v1/orders?status=paid   或   /orders',
    value: draft.url,
    spellcheck: 'false',
    oninput: (event) => {
      draft.url = oneLine(event.target);
      autoGrow(event.target);
      markDirty(tab);
      pullParamsFromUrl();
      refreshPendingTarget(tab);
    },
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        pullParamsFromUrl();
        send(tab);
      }
    },
  });
  function pullParamsFromUrl() {
    const before = (tab.draft.params || []).map((row) => `${row.key}=${row.value}`).join('&');
    syncParamsFromUrl(tab);
    const after = (tab.draft.params || []).map((row) => `${row.key}=${row.value}`).join('&');
    if (before !== after && tab.view === 'params') {
      const host = document.querySelector('#request-host .pane');
      if (host) drawTab(tab, host);
    }
  }

  const savedClean = !!tab.refId && !tab.dirty;
  const saveBtn = el('button', {
    class: `btn ${savedClean ? 'success' : ''}`,
    dataset: {saveTab:tab.id},
    title: savedClean ? '已保存到集合（Ctrl+S 可另存）' : '保存到集合（Ctrl+S）',
    onclick: () => save(tab),
  }, [icon('save'), el('span', { text: savedClean ? '已保存' : '保存' })]);

  const sendBtn = el('button', {
    class: `btn ${tab.running?'danger':'primary'}`,
    title: '发送或停止请求（Ctrl+Enter）',
    'aria-busy':String(!!tab.running),
    onclick: () => (tab.protocol === 'sse' ? toggleStream(tab) : send(tab)),
  }, [tab.running ? icon('stop') : icon('send'), el('span', { text: sendLabel(tab) })]);

  /* ---- name: rename right here, no dialog ---- */
  wrap.appendChild(titleRow(tab, draft));

  wrap.appendChild(
    el('div', { class: 'urlbar' }, [
      el('div', { class: 'url-field' }, [proto, method, url]),
      sendBtn,
      saveBtn,
      el('button', {
        class: 'btn ghost request-preview-trigger',
        title: '查看替换变量后的请求',
        onclick: () => openRequestPreview(tab),
        text: '预览',
      }),
    ])
  );
  autoGrow(url);
  wrap.append(requestContext(tab));
  if (tab.previewPinned) wrap.append(el('section', { class: 'request-details', 'aria-label': '解析请求详情' }, [openRequestPreview(tab, undefined, { embedded: true })]));

  /* ---- sub tabs ---- */
  const counts = {
    params: (draft.params || []).filter((i) => i.enabled !== false && i.key).length,
    headers: (draft.headers || []).filter((i) => i.enabled !== false && i.key).length,
    body: bodySummary(draft.body),
  };
  const strip = el('div', { class: 'subtabs' });
  const body = el('div', { class: 'pane' });
  for (const [key, label] of TABS) {
    if (key === 'checks' && tab.protocol === 'sse') continue;
    strip.appendChild(
      el(
        'button',
        {
          class: `subtab ${tab.view === key ? 'on' : ''}`,
          onclick: () => {
            tab.view = key;
            renderInto(document.getElementById('request-host'));
          },
        },
        [
          el('span', { text: label }),
          key === 'auth'
            ? shortAuth(tab) === '无'
              ? null
              : el('span', { class: 'count', text: shortAuth(tab) })
            : counts[key]
            ? el('span', { class: 'count', text: String(counts[key]) })
            : null,
        ]
      )
    );
  }
  wrap.appendChild(strip);
  wrap.appendChild(body);
  drawTab(tab, body);
  return wrap;
}

function shortAuth(tab) {
  // effectiveAuth already walks the chain, so a request set to "inherit" reports
  // what it will actually send ("Bearer") rather than the word "inherit" — that
  // is the more useful badge, and it is why there is no inherit branch here.
  const auth = effectiveAuth(tab);
  if (auth.kind === 'noauth') return '无';
  if (auth.kind === 'bearer') return 'Bearer';
  if (auth.kind === 'basic') return 'Basic';
  if (auth.kind === 'apikey') return 'API Key';
  return auth.kind;
}

function bodySummary(body) {
  if (!body || body.mode === 'none') return 0;
  if (body.mode === 'raw') return body.raw && body.raw.content ? 1 : 0;
  if (body.mode === 'file') return body.file ? 1 : 0;
  return (body[body.mode] || []).filter((i) => i.enabled !== false && i.key).length;
}

function drawTab(tab, host) {
  const draft = tab.draft;
  if (tab.view === 'checks' && tab.protocol !== 'sse') {
    renderCheckEditor(host, draft, () => persistDraft(tab));
  } else if (tab.view === 'params') {
    draft.params = draft.params || [];
    renderKvEditor(host, draft.params, {
      labels: ['参数名', '参数值'],
      description: true,
      mode: 'params',
      title: 'Query 参数',
      onChange: () => persistDraft(tab, false),
      onCommit: () => {
        const url = syncUrlFromParams(tab);
        const field = document.querySelector('#request-host .url-input');
        if (field) {
          field.value = url;
          autoGrow(field);
        }
        // the status bar quotes the URL too, and this path bypasses the URL field
        emit('tabs');
      },
    });
  } else if (tab.view === 'headers') {
    draft.headers = draft.headers || [];
    renderKvEditor(host, draft.headers, {
      labels: ['请求头', '值'],
      description: true,
      mode: 'headers',
      title: '请求头',
      onChange: () => persistDraft(tab, false),
    });
    const env = state.environments.find((item) => item.id === state.settings.activeEnvironmentId);
    const inherited = env && env.defaults.alwaysOnHeaders ? env.defaults.headers.filter((h) => h.enabled !== false && h.key) : [];
    if (inherited.length) {
      host.appendChild(
        el('div', { class: 'section', style: { marginTop: '12px' } }, [
          el('h4', { text: `环境「${env.name}」附加的请求头` }),
          ...inherited.map((item) => el('div', { class: 'pick', style: { cursor: 'default' } }, [
            el('span', { class: 'mono', text: item.key }),
            el('span', { class: 'dim', text: `：${item.value}` }),
          ])),
        ])
      );
    }
    // 集合级默认头：不预填、发送时附加，所以必须在这里露出来，否则用户只会看到
    // 一个"表里没有、线上却有"的头
    const attached = collectionHeaders(tab.refId);
    if (attached.list.length) {
      host.appendChild(
        el('div', { class: 'section', style: { marginTop: '12px' } }, [
          el('h4', { text: `集合「${attached.collection.name}」的默认请求头` }),
          ...attached.list.map((item) => el('div', { class: 'pick', style: { cursor: 'default' } }, [
            el('span', { class: 'mono', text: item.key }),
            el('span', { class: 'dim', text: `：${item.value}` }),
            draft.headers.some((row) => row.enabled !== false && (row.key || '').toLowerCase() === item.key.toLowerCase())
              ? el('span', { class: 'faint small', text: '已覆盖' })
              : null,
          ])),
        ])
      );
    }
  } else if (tab.view === 'body') {
    drawBody(tab, host, draft);
  } else if (tab.view === 'auth') {
    renderAuthPicker(host, tab, () => {
      markDirty(tab);
      touch('tabs');
    });
  } else {
    drawSettings(tab, host, draft);
  }
}

function drawBody(tab, host, draft) {
  draft.body = draft.body || newBody();
  const body = draft.body;
  const choice=body.mode==='raw'?(body.raw?.language==='json'?'json':'text'):body.mode;
  const modes=segmented([['none','无'],['json','JSON'],['text','文本'],['form','表单'],['urlencoded','URL 编码'],['file','二进制']],choice,next=>{
    const previous=bodyContentType(body);
    body.mode=['json','text'].includes(next)?'raw':next;
    if(body.mode==='raw'){
      body.raw=body.raw || {language:'json',content:''};
      body.raw.language=next==='json'?'json':body.raw.language==='json'?'text':body.raw.language || 'text';
    }
    // Update an automatically managed type only. Imported/custom media types
    // remain visible and are never silently replaced when changing formats.
    const header=(draft.headers || []).find(row=>row.key.trim().toLowerCase()==='content-type');
    if(header&&header.value===previous){
      if(body.mode==='raw')header.value=bodyContentType(body);
      else draft.headers=draft.headers.filter(row=>row!==header);
    }
    persistDraft(tab);renderInto(document.getElementById('request-host'));
  });
  modes.classList.add('body-formats');modes.setAttribute('aria-label','请求体格式');
  const hints=['不发送请求体','application/json','文本、XML、HTML、JavaScript','multipart/form-data · 支持文本与文件','application/x-www-form-urlencoded','整个文件作为请求体'];
  [...modes.querySelectorAll('button')].forEach((button,index)=>button.title=hints[index]);
  const type=(draft.headers || []).find(row=>row.enabled!==false&&row.key.trim().toLowerCase()==='content-type')?.value || bodyContentType(body);
  const head=el('div',{class:'body-format-bar'},[modes,el('span',{class:'body-content-type mono',text:type,title:type})]);
  host.appendChild(head);

  if (body.mode === 'raw' || body.mode === 'none') {
    if (body.mode === 'none') {
      host.appendChild(el('div', { class: 'empty body-empty' }, [icon('file'), el('span', { text: '无请求体' })]));
      return;
    }
    body.raw = body.raw || { language: 'json', content: '' };
    const language = body.raw.language;
    const lang = language === 'json' ? null : selectField({
      value: language,
      options: [['text', 'Text'], ['xml', 'XML'], ['html', 'HTML'], ['javascript', 'JavaScript']],
      onChange: next => {
        body.raw.language = next;
        persistDraft(tab);
        syncContentType(tab);
        renderInto(document.getElementById('request-host'));
      },
    });
    host.appendChild(createBodyEditor({
      tab, language, content: body.raw.content || '', languageControl: lang,
      onChange: content => { body.raw.content = content; persistDraft(tab); },
    }));
    return;
  }

  if (body.mode === 'file') {
    const input = el('input', {
      class: 'input mono',
      value: body.file || '',
      placeholder: 'D:\\data\\payload.bin',
      oninput: (event) => {
        body.file = event.target.value;
        persistDraft(tab);
        describe();
      },
    });
    const note = el('span', { class: 'kv-file-meta small faint' });
    async function describe() {
      const path = (body.file || '').trim();
      note.textContent = '';
      note.classList.remove('bad');
      if (!path) return;
      const meta = await fileMeta(path);
      if (!meta || meta.error) {
        note.textContent = meta && meta.error ? '找不到文件' : '';
        note.classList.add('bad');
        return;
      }
      note.textContent = fmtBytes(meta.size);
    }
    const pick = el('button', {
      class: 'btn sm',
      text: '选择文件',
      onclick: async () => {
        const path = await pickFile({ title: '选择要发送的文件' });
        if (!path) return;
        body.file = path;
        input.value = path;
        persistDraft(tab);
        describe();
      },
    });
    host.appendChild(
      el('div', { class: 'group' }, [
        el('div', { class: 'group-head' }, [
          el('span', { text: '二进制文件' }),
          el('span', { class: 'dim small', text: '整个文件原样作为请求体' }),
        ]),
        el('div', { class: 'group-body' }, [
          el('div', { class: 'field' }, [
            el('label', { text: '文件路径' }),
            el('div', { class: 'file-pick' }, [input, pick, note]),
          ]),

        ]),
      ])
    );
    if (body.file) describe();
    return;
  }

  const list = body[body.mode] || (body[body.mode] = []);
  // the table owns its card and replaces everything inside the host it is given,
  // so it needs a holder of its own — handing it the pane would eat the mode select
  const holder = el('div');
  host.appendChild(holder);
  renderKvEditor(holder, list, {
    labels: ['字段', '值'],
    description: true,
    types: body.mode === 'form',
    title:body.mode==='form'?'表单字段 · 文件上传':'URL 编码表单',
    onChange: () => persistDraft(tab),
  });
}

function bodyContentType(body) {
  if(body.mode==='raw')return ({json:'application/json',xml:'application/xml',html:'text/html',text:'text/plain',javascript:'application/javascript'})[body.raw?.language] || 'text/plain';
  return ({form:'multipart/form-data',urlencoded:'application/x-www-form-urlencoded',file:'application/octet-stream',none:'不发送 Body'})[body.mode] || '';
}

function drawSettings(tab, host, draft) {
  draft.settings = draft.settings || {};
  const s = draft.settings;
  const number = (key, label, hint, placeholder) => {
    const input = el('input', {
      class: 'input mono',
      type: 'number',
      min: '0',
      value: s[key] === undefined || s[key] === null ? '' : s[key],
      placeholder: placeholder || globalHint(state.settings[key]),
      oninput: (event) => {
        s[key] = event.target.value === '' ? null : Number(event.target.value);
        persistDraft(tab, false);
      },
    });
    return el('div', { class: 'field' }, [el('label', { text: label }), input]);
  };
  const toggle = (key, label, hint) =>
    el('div', { class: 'inline', style: { justifyContent: 'space-between' } }, [
      el('span', { text: label }),
      switchControl(s[key] ?? state.settings[key], (checked) => {
          s[key] = checked;
          persistDraft(tab, false);
      }, label),
    ]);

  host.appendChild(
    el('div', { class: 'group' }, [
      el('div', { class: 'group-head' }, [
        el('span', { text: '请求设置' }),
        el('span', { class: 'dim small', text: '留空继承全局' }),
      ]),
      el('div', { class: 'group-body' }, [
        number('timeoutMs', '请求超时 (ms)', '留空表示跟随全局设置。SSE 连接不受该超时限制。', String(state.settings.timeoutMs)),
        el('div', { class: 'divider-h' }),
        toggle('followRedirects', '自动跟随重定向', '关闭后 3xx 会作为正常响应展示。'),
        toggle('sslVerify', '校验 SSL 证书', '内网自签证书环境可临时关闭。'),
        toggle('cookieJar', '共享 Cookie', '开启后同一 profile 内的请求共用 Cookie。'),
        el('div', { class: 'divider-h' }),
        (() => {
          const input = el('input', {
            class: 'input mono',
            value: s.proxy || '',
            placeholder: globalHint(state.settings.proxy) || 'http://127.0.0.1:7890',
            oninput: (event) => {
              s.proxy = event.target.value;
              persistDraft(tab, false);
            },
          });
          return el('div', { class: 'field' }, [el('label', { text: '代理（HTTP / SOCKS5）' }), input]);
        })(),
        number('maxRedirects', '最大重定向次数', '默认 10 次。'),
      ]),
    ])
  );
}

function globalHint(value) {
  return value === undefined || value === null || value === '' ? '' : String(value);
}

function syncContentType(tab) {
  const body = tab.draft.body || {};
  if (body.mode !== 'raw') return;
  const map = { json: 'application/json', xml: 'application/xml', html: 'text/html', text: 'text/plain', javascript: 'application/javascript' };
  const want = map[body.raw.language] || 'text/plain';
  const existing = (tab.draft.headers || []).find((h) => h.key.toLowerCase() === 'content-type');
  if (existing) existing.value = want;
  else tab.draft.headers.push({ id: uid('h'), key: 'Content-Type', value: want, enabled: true, description: '' });
  persistDraft(tab, false);
}

function persistDraft(tab, dirty = true) {
  if (dirty) markDirty(tab);
  touch('tabs');
}

function renderInto(host) {
  emit('rerender');
}

/// The empty response plate quotes the verb and the URL, so it has to follow every
/// keystroke: a stated target that goes stale is worse than no stated target,
/// because it is a claim about what will hit the wire. Only while there is no
/// response — once one lands the plate is replaced by the payload anyway. Cheap
/// enough to do per keystroke (six nodes) and it must not touch the request pane,
/// or the URL field loses the caret you are typing with.
function refreshPendingTarget(tab) {
  if (tab.response || tab.running) return;
  const host = document.getElementById('response-host');
  if (host) import('./response.js').then(({ renderResponsePane }) => host.replaceChildren(renderResponsePane(tab)));
}

function sendLabel(tab) {
  if (tab.protocol === 'sse') {
    if (tab.running && tab.running.live) return '断开';
    return '连接';
  }
  return tab.running ? '取消' : '发送';
}

export function switchProtocol(tab, protocol) {
  if (tab.running) stopEverything(tab);
  setProtocol(tab, protocol);
  renderInto(document.getElementById('request-host'));
}

export function stopEverything(tab) {
  if (!tab?.running) return;
  const { execId, checkRules, environmentId } = tab.running;
  tab.running = null;
  if(tab.protocol==='sse'&&tab.stream){tab.stream.endedAt=Date.now();tab.stream.note='已断开';}
  else tab.response={ok:false,status:0,error:'请求已取消',errorKind:'cancelled',headers:[],bodyText:'',isText:true};
  if(checkRules && tab.response){tab.response.checkResult=evaluateChecks(checkRules,tab.response);tab.response.checkEnvironmentId=environmentId;}
  api.cancel(execId).catch(() => {});
  emit('response');
  renderInto(document.getElementById('request-host'));
}

export async function save(tab) {
  if(!tab||!['request','ws'].includes(tab.kind))return;
  const draft = tab.draft;
  const savedRevision = JSON.stringify([tab.protocol, draft, tab.auth, tab.description]);
  if (tab.refId) {
    const hit = findNode(tab.refId);
    if (hit) {
      hit.node.name = draft.name || hit.node.name;
      hit.node.request = JSON.parse(JSON.stringify(draft));
      hit.node.auth = JSON.parse(JSON.stringify(tab.auth || hit.node.auth));
        hit.node.protocol = tab.protocol;
        hit.node.kind = tab.protocol === 'ws' ? 'ws' : 'request';
        hit.node.description = tab.description;
        try { await flushDomain('collections', { strict: true }); } catch { return; }
        tab.dirty = savedRevision !== JSON.stringify([tab.protocol, tab.draft, tab.auth, tab.description]);
      touch('tabs');
        emit('request-saved',tab);
      tab.title = hit.node.name;
      touch('collections');
      emit('tabs');
      emit('tree');
      toast('已保存到集合', 'ok', 1600);
      renderInto(document.getElementById('request-host'));
      return;
    }
  }
  const name = draft.name || deriveName(draft.url) || '未命名请求';
  draft.name = name;
  const newRevision = JSON.stringify([tab.protocol, draft, tab.auth, tab.description]);
  const node = newRequestNode(name, JSON.parse(JSON.stringify(draft)));
  node.auth = JSON.parse(JSON.stringify(tab.auth));
    node.protocol = tab.protocol;
    node.kind = tab.protocol === 'ws' ? 'ws' : 'request';
  const collection = state.collections[0] || { id: uid('col'), kind: 'collection', name: '我的 API', children: [], variables: [], auth: { kind: 'noauth' }, expanded: true };
  if (!state.collections.includes(collection)) state.collections.push(collection);
  collection.children.push(node);
  tab.refId = node.id;
    tab.title = name;
    try { await flushDomain('collections', { strict: true }); } catch { return; }
    tab.dirty = newRevision !== JSON.stringify([tab.protocol, tab.draft, tab.auth, tab.description]);
  touch('tabs');
  emit('request-saved',tab);
  draft.name = name;
  touch('collections');
  emit('tabs');
  emit('tree');
  toast(`已保存到集合「${collection.name}」`, 'ok', 2000);
  renderInto(document.getElementById('request-host'));
}

function deriveName(url) {
  const path = (url || '').replace(/^https?:\/\/[^/]+/i, '').split('?')[0];
  const tail = path.split('/').filter(Boolean).pop();
  return tail || '';
}

/* ---------- send ---------- */

export async function send(tab) {
  if(!tab||tab.kind!=='request')return;
  if (tab.protocol === 'sse') return toggleStream(tab);
  if (tab.running) {
    stopEverything(tab);
    renderInto(document.getElementById('request-host'));
    return;
  }
  const built = buildSendDraft(tab);
  const { draft, missing } = built;
  if (!draft.url) {
    toast('请先填写 URL', 'err');
    return;
  }
  if (missing.length) {toast(`缺少变量：${missing.join('、')}`,'err',6000);return;}
  tab.lastRequestSnapshot = requestSnapshot(tab, built);
  const sentShell=tab.lastRequestSnapshot.template;
  const rules = built.preparedChecks;
  const environmentId = state.settings.activeEnvironmentId;
  const execId = uid('exec');
  tab.running = { execId,startedAt:Date.now(),checkRules:rules,environmentId };
  tab.response = null;
  emit('rerender');
  const started = Date.now();
  try {
    const response = await api.execute(draft, execId);
    if(tab.running?.execId!==execId)return;
    tab.response = response;
    tab.response.checkResult = evaluateChecks(rules, response);
    tab.response.checkEnvironmentId = environmentId;
    emit('request-completed',{tab,shell:sentShell,built,response});
    tab.responseView = response && response.is_text === false && response.error ? 'headers' : tab.responseView === 'events' ? 'body' : tab.responseView || 'body';
    pushHistory({
      kind: 'http',
      name: draft.name || deriveName(draft.url) || '未命名请求',
      method: draft.method,
      url: draft.url,
      status: response.status || 0,
      timeMs: response.timeMs || Date.now() - started,
      sizeBytes: response.sizeBytes || 0,
      errorKind: response.errorKind || null,
      snapshot: JSON.parse(JSON.stringify(sentShell.draft)),
      auth: JSON.parse(JSON.stringify(sentShell.auth || { kind: 'inherit' })),
      protocol: 'http',
    });
  } catch (error) {
    if(tab.running?.execId!==execId)return;
    const message = String((error && error.message) || error);
    tab.response = { ok: false, error: message, errorKind: 'client', status: 0, headers: [], bodyText: '', isText: true };
    tab.response.checkResult = evaluateChecks(rules, tab.response);
    tab.response.checkEnvironmentId = environmentId;
  } finally {
    if(tab.running?.execId===execId) {
      tab.running = null;
      if(activeTab()?.id===tab.id&&!state.overviewPane)emit('rerender');
      else emit('tabs');
    }
  }
}

export async function toggleStream(tab) {
  if (tab.running && tab.running.live) {
    stopEverything(tab);
    return;
  }
  const built = buildSendDraft(tab);
  const { draft, missing } = built;
  if (!draft.url) {
    toast('请先填写 SSE 地址', 'err');
    return;
  }
  if (missing.length) {toast(`缺少变量：${missing.join('、')}`,'err',5000);return;}
  tab.lastRequestSnapshot = requestSnapshot(tab, built);
  const execId = uid('sse');
  tab.stream = { events: [], raw: [], rawSeq: 0, status: null, headers: [], startedAt: Date.now(), endedAt: null, bytes: 0, count: 0, error: null, execId };
  tab.running = { execId, live: true, kind: 'sse' };
  tab.responseView = 'events';
  emit('rerender');
  await api.streamSse({
    draft,
    execId,
    firstByteTimeoutMs: state.settings.sseFirstByteMs || null,
    streamFormat: tab.streamFormat || 'auto',
    onEvent: (event) => {if(tab.running?.execId===execId)onSseEvent(tab, event);},
  }).catch((error) => {
    if(tab.running?.execId===execId)onSseEvent(tab, { kind: 'error', at: Date.now(), message: String((error && error.message) || error) });
  });
}

function onSseEvent(tab, event) {
  const stream = tab.stream || (tab.stream = { events: [], raw: [], rawSeq: 0, status: null, headers: [], startedAt: Date.now(), count: 0, bytes: 0 });
  if (event.kind === 'raw') {
    stream.rawSeq += 1;
    stream.raw.push({ seq: stream.rawSeq, at: event.at, bytes: event.bytes, text: event.data || '', b64: event.rawBase64 || '' });
    if (stream.raw.length > 500) stream.raw.splice(0, stream.raw.length - 500);
    renderSseView(tab,event);
    return;
  }
  if (event.kind === 'open') {
    stream.status = event.status;
    stream.headers = event.headers || [];
  } else if (event.kind === 'message') {
    stream.count += 1;
    stream.bytes = event.bytes || stream.bytes;
  } else if (event.kind === 'error') {
    stream.error = event.message;
    // every Rust error path emits `error` and returns without a `done`, so ending
    // the run only on `done` left a failed stream saying "已连接，正在接收事件"
    // with a duration counting up forever
    finishStream(tab, stream);
  } else if (event.kind === 'done') {
    finishStream(tab, stream, event.message);
  }
  const events = stream.events;
  events.push(event);
  if (events.length > 800) events.splice(0, events.length - 800);
  renderSseView(tab,event);
  if ((event.kind === 'done' || event.kind === 'error')&&activeTab()?.id===tab.id&&!state.overviewPane) renderInto(document.getElementById('request-host'));
}

function finishStream(tab, stream, note) {
  stream.endedAt = Date.now();
  if (note) stream.note = note;
  tab.running = null;
  pushHistory({
    kind: 'sse',
    name: tab.draft.name || tab.draft.url,
    method: tab.draft.method,
    url: tab.draft.url,
    status: stream.status || 0,
    timeMs: stream.endedAt - stream.startedAt,
    sizeBytes: stream.bytes,
    note: stream.error || `收到 ${stream.count} 个事件`,
    snapshot: JSON.parse(JSON.stringify(tab.draft)),
    auth: JSON.parse(JSON.stringify(tab.auth || { kind: 'inherit' })),
    protocol: 'sse',
  });
}

export async function showCurl(tab) {
  const { draft } = buildSendDraft(tab);
  const text = requestCurl(draft);
  const { modal } = await import('./ui.js');
  modal({
    title: '复制为 cURL',
    width: 760,
    body: [el('textarea', { class: 'textarea mono', rows: 12, readonly: true, value: text })],
    cancelText: '',
    okText: '复制到剪贴板',
    onOk: async () => {
      await copy(text, '已复制到剪贴板');
    },
  });
}

export { renderInto };
