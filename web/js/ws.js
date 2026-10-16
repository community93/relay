import { el, icon, toast, bytes as fmtBytes, duration, exportStream, copy, autoGrow, oneLine, toggle as switchControl } from './ui.js';
import { menu, selectField } from './menu.js';
import { renderKvEditor } from './kv.js';
import {renderAuthPicker} from './auth.js';
import { protocolSwitch } from './protocol.js';
import { titleRow } from './request.js';
import { openRequestPreview, requestSnapshot, requestContext } from './preview.js';
import { state, markDirty, touch, flushDomain, emit, uid, pushHistory, varScope, render, buildSendDraft, syncParamsFromUrl, syncUrlFromParams, findNode, newCollection } from './state.js';
import * as api from './api.js';
import { liveLog, appendLive } from './interaction.js';

const WS_VIEWS = [
  ['messages', '消息流'],
  ['headers', '握手 Headers'],
  ['params', 'Query 参数'],
  ['auth', 'Auth'],
  ['settings', '设置'],
];

function wsState(tab) {
  if (!tab.ws) {
    tab.ws = {
      connId: uid('ws'),
      status: 'idle',
      events: [],
      sent: 0,
      recv: 0,
      bytes: 0,
      startedAt: null,
      endedAt: null,
      error: null,
      handshake: [],
      pingTimer: null,
    };
  }
  return tab.ws;
}

export function renderWsPane(tab) {
  const ws = wsState(tab);
  const draft = tab.draft;
  // WS tabs keep their own view key so switching back from an HTTP tab does not
  // drop the user into the query editor.
  if (!WS_VIEWS.some(([key]) => key === tab.wsView)) tab.wsView = 'messages';
  const wrap = el('div', { class: 'pane-scroll ws-pane' });

  const url = el('textarea', {
    class: 'input url-input',
    rows: 1,
    placeholder: 'wss://echo.websocket.org   或   {{baseUrl}}/socket',
    value: draft.url,
    spellcheck: 'false',
    oninput: (event) => {
      draft.url = oneLine(event.target);
      syncParamsFromUrl(tab);
      autoGrow(event.target);
      markDirty(tab);
      touch('tabs');
    },
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        toggle(tab);
      }
    },
  });

  const connecting = ws.status === 'opening';
  const closing = ws.status === 'closing';
  const open = ws.status === 'open';
  const savedClean = !!tab.refId && !tab.dirty;
  wrap.appendChild(titleRow(tab, draft, '未命名连接'));
  wrap.appendChild(
    el('div', { class: 'urlbar' }, [
      // same bordered field the HTTP composer uses, with the protocol switch
      // inside it: a bare input here is what made every HTTP→WS switch jump
      el('div', { class: 'url-field' }, [protocolSwitch(tab), url]),
      el('button', {
        class: `btn ${open || connecting ? 'danger' : 'primary'}`,
        'aria-busy': String(connecting),
        disabled:closing,
        onclick: () => toggle(tab),
      }, [icon(open || connecting ? 'stop' : 'ws'),el('span', { text: closing?'断开中…':open ? '断开' : connecting ? '取消连接' : '连接' })]),
      el('button', {
        // same rule as the HTTP composer: `ws.refSaved` was read here but written
        // nowhere, so this button could never report a completed save
        class: `btn ${savedClean ? 'success' : ''}`,
        dataset: {saveTab:tab.id},
        title: savedClean ? '已保存（Ctrl+S 可另存）' : '保存到集合',
        text: savedClean ? '已保存' : '保存',
        onclick: () => saveWs(tab),
      }),
      el('button', {
        class: 'btn ghost request-preview-trigger',
        title: '查看替换变量后的握手请求',
        text: '预览',
        onclick: () => openRequestPreview(tab, buildWsRequest(tab).preview, { build: () => buildWsRequest(tab).preview }),
      }),
    ])
  );
  autoGrow(url);
  wrap.append(requestContext(tab, () => buildWsRequest(tab).preview));
  if (tab.previewPinned) wrap.append(el('section', { class: 'request-details', 'aria-label': '解析握手详情' }, [openRequestPreview(tab, buildWsRequest(tab).preview, { embedded: true, build: () => buildWsRequest(tab).preview })]));

  wrap.appendChild(
    el(
      'div',
      { class: 'subtabs' },
      WS_VIEWS.map(([key, label]) =>
        el(
          'button',
          {
            class: `subtab ${tab.wsView === key ? 'on' : ''}`,
            onclick: () => {
              tab.wsView = key;
              rerender(tab);
            },
          },
          [
            el('span', { text: label }),
            key === 'messages' ? el('span', { class: 'count', id:`ws-count-${tab.id}`, hidden:!ws.events.length, text: String(ws.events.length) }) : null,
            key === 'headers' && draft.headers.length ? el('span', { class: 'count', text: String(draft.headers.filter((h) => h.enabled !== false && h.key).length) }) : null,
            key === 'params' && draft.params.length ? el('span', { class: 'count', text: String(draft.params.filter((h) => h.enabled !== false && h.key).length) }) : null,
          ]
        )
      )
    )
  );

  const host = el('div', { class: 'ws-body' });
  wrap.appendChild(host);
  if (tab.wsView === 'messages') drawMessages(tab, ws, host);
  else if (tab.wsView === 'headers') {
    drawKv(tab, host, 'headers', ['握手时带上', '值']);
    host.appendChild(handshakeCard(ws));
  }
  else if (tab.wsView === 'params') drawKv(tab, host, 'params', ['参数', '值']);
  else if(tab.wsView==='auth') {
    const pane=el('div',{class:'pane'});host.append(pane);
    renderAuthPicker(pane,tab,()=>{markDirty(tab);touch('tabs');});
  } else drawSettings(tab, ws, host);
  return wrap;
}

function statusText(ws) {
  if (ws.status === 'open') return `已连接 · 收 ${ws.recv} / 发 ${ws.sent} · ${fmtBytes(ws.bytes)}`;
  if (ws.status === 'opening') return '握手中…';
  if (ws.status === 'closing') return '正在断开…';
  if (ws.status === 'error') return `连接失败：${ws.error || ''}`;
  if (ws.status === 'closed') return `已断开${ws.closeCode?` · ${ws.closeCode}`:''}${ws.closeReason?` · ${ws.closeReason}`:''}`;
  return '未连接';
}

/// The 101 response the server actually sent. It was captured into `ws.handshake`
/// and never read, so the tab labelled 握手 Headers only ever showed the headers we
/// were about to send — the one thing it was named after was missing.
function handshakeCard(ws) {
  const rows = (ws && ws.handshake) || [];
  return el('div', { class: 'group', style: { marginTop: 'var(--s-3)' } }, [
    el('div', { class: 'group-head' }, [el('span', { text: '服务器返回的握手响应头' })]),
    rows.length
      ? el('table', { class: 'table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: '名称' }), el('th', { text: '值' })])]),
          el('tbody', {}, rows.map((h) => el('tr', {}, [el('td', { text: h.name }), el('td', { text: h.value })]))),
        ])
      : el('div', { class: 'empty', style: { height: 'auto', padding: 'var(--s-6) var(--pad-x)' } }, [
          el('p', { text: '暂无 Headers' }),
        ]),
  ]);
}

function drawKv(tab, host, key, labels) {
  tab.draft[key] = tab.draft[key] || [];
  const box = el('div', { class: 'pane' });
  host.appendChild(box);
  renderKvEditor(box, tab.draft[key], {
    labels,
    description: true,
    onChange: () => {
      if(key==='params')syncUrlFromParams(tab);
      markDirty(tab);
      touch('tabs');
    },
  });
}

function drawMessages(tab, ws, host) {
  const log=liveLog(tab,'_wsLog');
  // Same head language as the HTTP/SSE response bar: the facts on the left, the
  // verbs that act on the message list on the right, each carrying its glyph.
  // A bare row of text-only buttons under a textarea is what made this pane look
  // unfinished next to the rest of the app.
  host.appendChild(
    el('div', { class: 'response-head' }, [
      // statusText already spells out 已连接 · 收 N / 发 M · size, so the head adds
      // no counters of its own — repeating them read as two different totals
      el('span', { class: `status-dot ${ws.status === 'open' ? 'live' : ws.status === 'error' ? 'err' : ''}` }),
      el('span', { class: 'meta', id: `ws-status-${tab.id}`, text: statusText(ws) }),
      el('div', { class: 'btn-row right' }, [
        log.button,
        el('button', {
          class: 'btn sm',
          title: '导出这次连接的消息流',
          onclick: (event) => exportMenu(event.currentTarget, tab),
        }, [icon('download'), el('span', { text: '导出' })]),
        el('button', {
          class: 'btn sm',
          title: '清空消息流',
          onclick: () => {
            ws.events = [];
            ws.recv = 0;
            ws.sent = 0;
            ws.bytes = 0;
            rerender(tab);
          },
        }, [icon('trash'), el('span', { text: '清空' })]),
      ]),
    ])
  );
  const messages=el('div', { class: 'events live-events', id: `ws-list-${tab.id}` }, ws.events.length ? ws.events.map((event) => eventNode(event)) : [emptyHint(ws)]);
  host.appendChild(messages);log.bind(messages);
  const area = el('textarea', {
    class: 'textarea mono',
    placeholder: '{"action":"subscribe","channel":"orders"}   Enter 换行，Ctrl+Enter 发送',
    rows: 3,
    value: ws.draftMessage || '',
    oninput: (event) => {
      ws.draftMessage = event.target.value;
    },
    onkeydown: (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        submit(tab);
      }
    },
  });
  const kind = selectField({
    value: ws.kind === 'binary' ? 'binary' : 'text',
    options: [
      ['text', '文本'],
      ['binary', '二进制 · Base64'],
    ],
    onChange: (next) => {
      ws.kind = next;
    },
  });
  const formatBtn = el('button', {
    class: 'btn sm',
    title: '把待发送的内容按 JSON 缩进重排',
    onclick: () => {
      try {
        area.value = JSON.stringify(JSON.parse(area.value), null, 2);
        ws.draftMessage = area.value;
      } catch (error) {
        toast('不是合法 JSON', 'err');
      }
    },
  }, [icon('braces'), el('span', { text: '格式化 JSON' })]);
  // the composer is a card like every other object on this screen: its own head
  // row with the choices that describe the frame, the textarea as its body, and
  // the send verb at the bottom right where every other card keeps its verbs
  host.appendChild(
    el('div', { class: 'group ws-out' }, [
      el('div', { class: 'group-head' }, [el('span', { text: '发送消息' }), el('div', { class: 'btn-row' }, [kind, formatBtn])]),
      el('div', { class: 'ws-send' }, [
        area,
        el('div', { class: 'ws-send-row' }, [
          // the placeholder already teaches the shortcut; repeating it under the
          // textarea made the card say the same sentence twice
          ws.status === 'open'
            ? null
            : el('span', { class: 'hint', text: '未连接时无法发送' }),
          el('button', {
            class: 'btn primary',
            disabled: ws.status !== 'open',
            title: '发送消息（Ctrl+Enter）',
            onclick: () => submit(tab),
          }, [icon('send'), el('span', { text: '发送' })]),
        ]),
      ]),
    ])
  );
}

function emptyHint(ws) {
  return el('div', { class: 'empty' }, [
    el('h3', { text: ws.status === 'open' ? '已连接，等待消息' : '尚未连接' }),
  ]);
}

function eventNode(event, fresh=false) {
  const dirTag = event.dir === 'out' ? 'out' : 'msg';
  const label = event.kind === 'open' ? 'OPEN' : event.kind === 'closed' ? 'CLOSE' : event.kind === 'error' ? 'ERROR' : event.kind === 'ping' ? 'PING' : event.kind === 'pong' ? 'PONG' : event.sendError?'SEND ERROR':event.pending?'SENDING':event.dir === 'out' ? 'SEND' : 'RECV';
  const body = event.text ?? (event.bytesB64 ? `base64 (${(event.bytesB64 || '').length} 字符)` : event.message || '');
  const pre = el('pre', { text: body });
  if (event.kind === 'message' && event.text) {
    const trimmed = event.text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        pre.textContent = JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch (error) {
        /* keep raw */
      }
    }
  }
  return el('div', { class: `event ${fresh?'event-arrival':''}`,dataset:{direction:event.dir||'in',kind:event.sendError?'error':event.kind,...(event.frameId?{frameId:event.frameId}:{})} }, [
    el('div', { class: 'event-head' }, [
      el('span', { class: `tag ${event.kind === 'error' ? 'err' : dirTag}`, text: label }),
      el('span', { class: 'faint small', text: `${event.len || (event.text || '').length} B` }),
      el('span', { class: 'right faint small', text: clock(event.at) }),
      event.text
        ? el('button', {
            class: 'btn ghost sm',
            text: '复制',
            onclick: () => copy(event.text || '', '已复制该消息'),
          })
        : null,
    ]),
    pre,
    event.sendError?el('span',{class:'ws-frame-error',text:event.sendError}):null,
  ]);
}

function clock(at) {
  const date = new Date(Number(at));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function drawSettings(tab, ws, host) {
  const box = el('div', { class: 'pane' });
  host.appendChild(box);
  const settings=tab.draft.settings ||= {};
  const timeout=el('input',{class:'input mono',type:'number',min:'0',value:settings.timeoutMs??'',placeholder:String(state.settings.timeoutMs),
    'aria-label':'握手超时 (ms)',oninput:event=>{settings.timeoutMs=event.target.value===''?null:Number(event.target.value);markDirty(tab);touch('tabs');}});
  const ping = el('input', { class: 'input', type: 'number', min: '0', 'aria-label':'心跳间隔（秒）', value: ws.pingSeconds || 0, style: { width: '110px' } });
  const subprotocols = el('input', {
    class: 'input mono',
    value: (tab.draft.subprotocols || []).join(', '),
    placeholder: 'graphql-ws, wamp',
    oninput: (event) => {
      tab.draft.subprotocols = event.target.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      markDirty(tab);
      touch('tabs');
    },
  });
  box.appendChild(
    el('div', { class: 'stack', style: { maxWidth: '620px' } }, [
      el('div', { class: 'field' }, [el('label', { text: 'Sec-WebSocket-Protocol' }), subprotocols]),
      el('div', { class: 'field' }, [el('label', { text: '握手超时 (ms)' }), timeout]),
      el('div', { class: 'inline', style:{justifyContent:'space-between'} }, [el('span',{text:'校验 SSL 证书'}),switchControl(settings.sslVerify??state.settings.sslVerify,checked=>{settings.sslVerify=checked;markDirty(tab);touch('tabs');},'校验 SSL 证书')]),
      el('div', { class: 'field' }, [
        el('label', { text: '心跳间隔（秒，0 表示关闭）' }),
        ping,
      ]),
      el('div', { class: 'divider-h' }),
      el('button', {
        class: 'btn',
        text: ws.pingTimer ? '停止心跳' : '启动心跳',
        disabled: ws.status !== 'open' && !ws.pingTimer,
        onclick: () => {
          if (ws.pingTimer) {
            clearInterval(ws.pingTimer);
            ws.pingTimer = null;
          } else {
            if (ws.status !== 'open') return;
            const seconds = Number(ping.value || 0);
            if (seconds <= 0) {
              toast('请先填写大于 0 的间隔', 'err');
              return;
            }
            ws.pingSeconds = seconds;
            ws.pingTimer = setInterval(() => api.wsSend(ws.connId, { kind: 'ping', text: 'ping' }).catch(() => {}), seconds * 1000);
          }
          rerender(tab);
        },
      }),
    ])
  );
}

export function buildWsRequest(tab, context = {}) {
  const ws=wsState(tab);
  // Share URL/query shaping, inherited headers, auth and settings with HTTP.
  // A WS handshake has no HTTP request body to interpolate.
  const built=buildSendDraft({...tab,draft:{...tab.draft,method:'GET',body:{mode:'none'}}}, context);
  built.draft.settings.timeoutMs=tab.draft.settings?.timeoutMs??state.settings.timeoutMs;
  const url=built.draft.url.replace(/^https:/i,'wss:').replace(/^http:/i,'ws:');
  const query=built.draft.params.map(p=>`${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  const finalUrl=url+(query?(url.includes('?')?'&':'?')+query:'');
  const scope=varScope(tab.refId, context),missing=new Set(built.missing);
  const subprotocols=(tab.draft.subprotocols?.length?tab.draft.subprotocols:
    built.draft.headers.filter(h=>/^sec-websocket-protocol$/i.test(h.key)).flatMap(h=>h.value.split(',')))
    .map(value=>{const result=render(value.trim(),scope);for(const key of result.missing)missing.add(key);return result.text;}).filter(Boolean);
  const managed=/^(host|connection|upgrade|content-length|sec-websocket-(key|version|extensions|protocol))$/i;
  const headers=[],headerSources=[];
  built.draft.headers.forEach((h,index)=>{if(!managed.test(h.key.trim())){headers.push(h);headerSources.push(built.headerSources[index]||'请求');}});
  const req={connId:ws.connId,name:tab.draft.name||tab.title,url:finalUrl,headers,subprotocols,
    sslVerify:built.draft.settings.sslVerify,timeoutMs:built.draft.settings.timeoutMs};
  const variables=new Map(built.variables.map(item=>[item.key,item]));
  for(const item of scope.used.values()){const resolved=render(`{{${item.key}}}`,scope);variables.set(item.key,{...item,value:resolved.text,missing:resolved.missing.size>0});}
  return {req,preview:{...built,variables:[...variables.values()],headerSources,missing:[...missing],
    draft:{...built.draft,url:finalUrl,resolvedUrl:finalUrl,headers,params:built.draft.params,subprotocols,body:{mode:'none'}}}};
}

export async function toggle(tab) {
  const ws = wsState(tab);
  if(ws.status==='closing')return;
  if (ws.status === 'open' || ws.status === 'opening') return disconnect(tab);
  if (!tab.draft.url) {
    toast('请填写 WebSocket 地址', 'err');
    return;
  }
  const built = buildWsRequest(tab);
  if(built.preview.missing.length){toast(`缺少变量：${built.preview.missing.join('、')}`,'err',6000);return;}
  ws.connId = uid('ws');
  built.req.connId=ws.connId;
  const connId=ws.connId;
  ws.status = 'opening';
  ws.error = null;
  ws.closeCode=null;ws.closeReason='';ws.handshake=[];ws.endedAt=null;
  ws.events = [];
  ws.sent = 0;
  ws.recv = 0;
  ws.bytes = 0;
  ws.startedAt = Date.now();
  rerender(tab);
  const { req } = built;
  tab.lastRequestSnapshot = requestSnapshot(tab, built.preview);
  try {
    await api.wsConnect({
      req,
      onEvent: (event) => {if(tab.ws===ws&&ws.connId===connId)onEvent(tab, event);else if(event.kind==='open')api.wsDisconnect(connId).catch(()=>{});},
    });
  } catch (error) {
    if(tab.ws===ws&&ws.connId===connId)onEvent(tab, { kind: 'error', at: Date.now(), message: String((error && error.message) || error) });
  }
}

function onEvent(tab, event) {
  const ws = wsState(tab);
  if (event.kind === 'open') {
    ws.status = 'open';
    ws.handshake = event.headers || [];
  } else if (event.kind === 'closed') {
    ws.status = 'closed';
    ws.endedAt = Date.now();
    ws.closeCode=event.code;ws.closeReason=event.reason || '';
    if (ws.pingTimer) {
      clearInterval(ws.pingTimer);
      ws.pingTimer = null;
    }
    pushHistory({
      kind: 'ws',
      name: tab.draft.name || tab.draft.url,
      method: 'WS',
      url: tab.draft.url,
      status: 101,
      timeMs: ws.endedAt - ws.startedAt,
      sizeBytes: ws.bytes,
      note: `收 ${ws.recv} / 发 ${ws.sent}`,
      snapshot: JSON.parse(JSON.stringify(tab.draft)),
      protocol: 'ws',
    });
  } else if (event.kind === 'error') {
    ws.status = 'error';
    ws.error = event.message;
    if (ws.pingTimer) { clearInterval(ws.pingTimer); ws.pingTimer = null; }
  }
  if (event.kind === 'message' || event.kind === 'pong' || event.kind === 'ping') ws.recv += 1;
  ws.bytes += event.len || 0;
  ws.events.push({ ...event, dir: event.dir || 'in' });
  if (ws.events.length > 600) ws.events.splice(0, ws.events.length - 600);
  paint(tab, event);
}

function paint(tab, event) {
  // Connection-state changes must rebuild the pane: the composer's disabled
  // flag and the status line are derived from ws.status.
  if (event.kind === 'open' || event.kind === 'closed' || event.kind === 'error') {
    rerender(tab);
    return;
  }
  const list = document.getElementById(`ws-list-${tab.id}`);
  if (list && tab.wsView === 'messages') {
    // `.events` is the scroller itself (it carries overflow:auto and the flex
    // height); its parent is the plain column host, so writing scrollTop there
    // was a no-op and new frames piled up below the fold
    const existing=event.frameId?list.querySelector(`[data-frame-id="${event.frameId}"]`):null;
    if(existing)existing.replaceWith(eventNode(event));
    else appendLive(list,eventNode(event,true),600);
    // the head bar is the one place that states the running totals
    const head = document.getElementById(`ws-status-${tab.id}`);
    const text = statusText(wsState(tab));
    if (head) head.textContent = text;
    const count=document.getElementById(`ws-count-${tab.id}`);
    if(count){count.textContent=String(wsState(tab).events.length);count.hidden=!wsState(tab).events.length;}
    return;
  }
  rerender(tab);
}

export function disconnect(tab) {
  const ws = wsState(tab);
  const connId=ws.connId;
  if(ws.status==='opening'){
    ws.connId=uid('ws');ws.status='closed';ws.endedAt=Date.now();
    api.wsDisconnect(connId).catch(()=>{});rerender(tab);return;
  }
  if (ws.pingTimer) {
    clearInterval(ws.pingTimer);
    ws.pingTimer = null;
  }
  api.wsClose(connId).catch(() => {});
  ws.status = 'closing';
  setTimeout(() => api.wsDisconnect(connId).catch(() => {}), 400);
  rerender(tab);
}

function submit(tab) {
  const ws = wsState(tab);
  if (ws.status !== 'open') {
    toast('尚未连接', 'err');
    return;
  }
  const kind = ws.kind === 'binary' ? 'binary' : 'text';
  const resolved=render(ws.draftMessage || '',varScope(tab.refId));
  if(resolved.missing.size){toast(`缺少变量：${[...resolved.missing].join('、')}`,'err');return;}
  const text = kind === 'binary' ? resolved.text.replace(/\s/g,'') : resolved.text;
  if (!text) return;
  let payload,len;
  if(kind==='binary'){
    try {
      const decoded=atob(text);
      if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))throw Error('invalid');
      payload={kind,bytesB64:text};len=decoded.length;
    } catch {toast('请输入合法的 Base64','err');return;}
  } else {payload={kind,text};len=new TextEncoder().encode(text).length;}
  const connId=ws.connId;
  const frame={frameId:uid('frame'),kind:'message',at:Date.now(),dir:'out',text,len,bytesB64:payload.bytesB64,pending:true};
  ws.events.push(frame);
  if(ws.events.length>600)ws.events.splice(0,ws.events.length-600);
  paint(tab,frame);
  api.wsSend(connId, payload).then(
    () => {
      if(tab.ws!==ws||ws.connId!==connId)return;
      frame.pending=false;
      ws.sent += 1;
      paint(tab,frame);
    },
    (error) => {
      if(tab.ws!==ws||ws.connId!==connId)return;
      frame.pending=false;frame.sendError=String(error?.message||error);paint(tab,frame);toast(frame.sendError,'err');
    }
  );
}

export async function saveWs(tab) {
  const name = tab.draft.name || `WS ${hostname(tab.draft.url)}`;
  tab.draft.name = name;
  const snapshot = JSON.parse(JSON.stringify(tab.draft));
  const auth=JSON.parse(JSON.stringify(tab.auth || {kind:'inherit'}));
  const savedRevision = JSON.stringify([tab.protocol, snapshot, auth]);
  if (tab.refId) {
    // An already-saved connection has to carry the edits back to the node they
    // came from. This one used to only flip dirty off and toast 已保存, so every
    // change to the URL / headers / params of a saved WS was silently discarded
    // — and reopening the node showed the old values.
    const hit = findNode(tab.refId);
    if (!hit) {
      toast('原来那条连接已经不在集合里了，请另存为新节点', 'err', 4000);
      return;
    }
    hit.node.request = snapshot;
    hit.node.auth = auth;
    hit.node.name = name;
    hit.node.subprotocols = tab.draft.subprotocols || [];
    hit.node.kind = 'ws';
    hit.node.protocol = 'ws';
  } else {
    const collection = state.collections[0];
    if (!collection) {
      state.collections.push(newCollection('我的 API'));
      return saveWs(tab);
    }
    const node = { id: uid('wsnode'), kind: 'ws', protocol: 'ws', name, auth, request: snapshot, subprotocols: tab.draft.subprotocols || [], expanded: true };
    collection.children.push(node);
    tab.refId = node.id;
    tab.title = name;
  }
  touch('collections');
  try { await flushDomain('collections', { strict: true }); } catch { return; }
  tab.dirty = savedRevision !== JSON.stringify([tab.protocol, tab.draft, tab.auth || {kind:'inherit'}]);
  touch('tabs');
  emit('tabs');
  // a first save creates the tree node, so the sidebar has to hear about it too
  emit('tree');
  // the save button's own label is derived from refId/dirty, so without a pane
  // repaint it keeps saying 保存 even though the save worked
  emit('rerender');
  toast('已保存', 'ok', 1500);
}

function hostname(url) {
  const stripped = (url || '').replace(/^wss?:\/\//i, '');
  return stripped.split('/')[0] || 'WebSocket';
}

function rerender(tab) {
  if (activeTabId(tab)&&!state.overviewPane) emit('rerender');
  else emit('tabs');
}

function activeTabId(tab) {
  return state.activeTabId === tab.id;
}

function exportMenu(anchor, tab) {
  const events = wsState(tab).events;
  menu(
    anchor,
    [
      // exportStream is async and saveAs already reports a failure; interpolating
      // its return value into a toast printed "[object Promise]"
      { label: '导出为 .txt（按时间线）', disabled: !events.length, onSelect: () => exportStream(tab.draft.name || 'websocket', events, 'txt') },
      { label: '导出为 .json（含方向与长度）', disabled: !events.length, onSelect: () => exportStream(tab.draft.name || 'websocket', events, 'json') },
    ],
    { align: 'end' }
  );
}
