import { el, icon, bytes as fmtBytes, duration, exportStream, saveAs, toast, copy } from './ui.js';
import { menu, selectField } from './menu.js';
import { state, activeTab, emit, touch } from './state.js';
import { highlight, escapeHtml, CHARSETS } from './response.js';
import * as api from './api.js';
import { liveLog, appendLive, liveDuration } from './interaction.js';

/// Event list ids are per tab so a background stream cannot paint over the
/// tab the user is looking at.
function hostId(tab) {
  return `sse-list-${tab.id}`;
}

export function renderSsePane(tab) {
  const stream = tab.stream;
  const wrap = el('div', { class: 'response' });
  const live = !!(tab.running && tab.running.live);
  const log=liveLog(tab,tab.responseView==='raw'?'_sseRawLog':'_sseLog');

  wrap.appendChild(
    el('div', { class: 'response-head stream-summary' }, [
      el('span', { class: `status-dot ${live ? 'live' : stream && stream.error ? 'err' : ''}` }),
      el('span', {
        id:`sse-status-${tab.id}`,text: live
          ? stream?.status?'接收中':'连接中…'
          : stream && stream.error
          ? `连接失败：${stream.error}`
          : stream && stream.status
          ? `连接结束（HTTP ${stream.status}）`
          : 'SSE 未连接',
      }),
      stream && stream.status ? el('span', { class: `pill ${stream.status < 400 ? 'ok' : 'err'}`, text: String(stream.status) }) : null,
      el('span', { class: 'meta' }, [el('b', { id:`sse-count-${tab.id}`,text: String(stream ? stream.count : 0) }), ' 个事件 · 累计']),
      el('span', { class: 'meta' }, [el('b', { id:`sse-bytes-${tab.id}`,text: fmtBytes(stream ? stream.bytes : 0) })]),
      stream ? el('span', { class: 'meta' }, [liveDuration(stream.startedAt,stream.endedAt), ' 时长']) : null,
      el('div', { class: 'btn-row right' }, [
        tab.responseView==='headers'?null:log.button,
        // the frame format describes the stream, not the request, so it lives
        // with the stream's own toolbar — keeping it in the composer made the
        // URL field's left edge jump every time the protocol switched to SSE
        selectField({
          title: live ? '当前连接的帧格式；断开后可修改' : '流帧格式，默认自动识别',
          disabled: live,
          value: tab.streamFormat || 'auto',
          options: [
            ['auto', '自动识别'],
            ['sse', '标准 SSE'],
            ['ndjson', 'NDJSON 行'],
            ['text', '纯文本分块'],
          ],
          onChange: (next) => {
            tab.streamFormat = next;
            touch('tabs');
            refresh(tab);
          },
        }),
        el('button', {
          class: 'btn sm',
          title: '清空显示，保留本次连接累计统计',
          onclick: () => {
            if (tab.stream) {
              tab.stream.events = [];
              tab.stream.raw = [];
              delete tab._sseLog; delete tab._sseRawLog;
            }
            refresh(tab);
          },
        }, [icon('trash'), el('span', { text: '清空显示' })]),
        el('button', {
          class: 'btn sm',
          title: '把已收到的事件全部复制到剪贴板',
          onclick: () => copyAll(tab),
        }, [icon('copy'), el('span', { text: '复制全部' })]),
        el('button', {
          class: 'btn sm',
          title: '导出为 txt / json',
          onclick: (event) => exportMenu(event.currentTarget, tab),
        }, [icon('download'), el('span', { text: '导出' })]),
        el('button', {
          class: `btn sm ${live ? 'danger' : 'primary'}`,
        text: live ? '断开' : '连接',
          onclick: () => {
            import('./request.js').then(({ toggleStream }) => toggleStream(tab));
          },
        }),
      ]),
    ])
  );

  const rawChunks = (stream && stream.raw) || [];
  const views = [
    ['events', `事件 (${stream ? stream.events.length : 0})`],
    ['raw', `原始流 (${rawChunks.length} 段)`],
    ['headers', `Headers (${stream && stream.headers ? stream.headers.length : 0})`],
  ];
  wrap.appendChild(
    el(
      'div',
      { class: 'subtabs stream-tabs' },
      views.map(([key, label]) =>
        el(
          'button',
          {
            class: `subtab ${(tab.responseView || 'events') === key ? 'on' : ''}`,
            onclick: () => {
              tab.responseView = key;
              refresh(tab);
            },
          },
          [el('span', { id:`sse-tab-${key}-${tab.id}`,text: label })]
        )
      )
    )
  );

  const body = el('div', { class: 'response-body stream-body' });
  if (tab.responseView === 'raw') {
    body.appendChild(rawView(tab, rawChunks));
    const raw=body.querySelector('.raw-log');if(raw)log.bind(raw);
  } else if (tab.responseView === 'headers') {
    const headers = (stream && stream.headers) || [];
    body.appendChild(
      headers.length
        ? el('table', { class: 'table' }, [
            el('thead', {}, [el('tr', {}, [el('th', { text: '名称' }), el('th', { text: '值' })])]),
            el('tbody', {}, headers.map((h) => el('tr', {}, [el('td', { text: h.name }), el('td', { text: h.value })]))),
          ])
        : el('div', { class: 'empty' }, [el('p', { text: '暂无 Headers' })])
    );
  } else {
    const events=el(
        'div',
        { class: 'events live-events', id: hostId(tab) },
        stream && stream.events.length ? stream.events.map((event) => eventNode(event)) : [idleNotice(tab, live)]
      );
    body.appendChild(events);log.bind(events);
  }
  wrap.appendChild(body);
  return wrap;
}

function idleNotice(tab, live) {
  if (live) {
    return el('div', { class: 'empty' }, [
      el('h3', { text: '已连接，等待第一条事件' }),

    ]);
  }
  if (tab.stream && tab.stream.error) {
    return el('div', { class: 'empty' }, [
      el('h3', { style: { color: 'var(--err)' }, text: '连接失败' }),
      el('p', { text: tab.stream.error }),
    ]);
  }
  return el('div', { class: 'empty' }, [
    el('h3', { text: '未连接' }),

  ]);
}

function eventNode(event, fresh=false) {
  const attrs={class:`event ${fresh?'event-arrival':''}`,dataset:{kind:event.kind}};
  if (event.kind === 'error') {
    return el('div', attrs, [
      el('div', { class: 'event-head' }, [el('span', { class: 'tag err', text: 'ERROR' }), el('span', { class: 'right faint small', text: clock(event.at) })]),
      el('pre', { text: event.message || '' }),
    ]);
  }
  if (event.kind === 'done') {
    return el('div', attrs, [
      el('div', { class: 'event-head' }, [el('span', { class: 'tag meta', text: 'DONE' }), el('span', { class: 'dim small', text: event.message || '' })]),
    ]);
  }
  if (event.kind === 'open') {
    return el('div', attrs, [
      el('div', { class: 'event-head' }, [
        el('span', { class: 'tag meta', text: `HTTP ${event.status || ''}` }),
        el('span', { class: 'dim small', text: event.message || '连接已建立' }),
        el('span', { class: 'right faint small', text: clock(event.at) }),
      ]),
    ]);
  }
  const name = event.event || 'message';
  let parsed = null;
  const trimmed = (event.data || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      parsed = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (error) {
      parsed = null;
    }
  }
  const pre = el('pre');
  pre.innerHTML = highlight(parsed ?? event.data ?? '', parsed ? 'json' : 'text');
  return el('div', attrs, [
    el('div', { class: 'event-head' }, [
      el('span', { class: 'tag msg', text: name }),
      event.id ? el('span', { class: 'tag meta', text: `id ${event.id}` }) : null,
      event.retry ? el('span', { class: 'faint small', text: `retry ${event.retry}ms` }) : null,
      el('span', { class: 'faint small', text: `${(event.data || '').length} 字符` }),
      el('span', { class: 'right faint small', text: clock(event.at) }),
      el('button', {
        class: 'btn ghost sm',
        text: '复制',
        onclick: () => copy(event.data || '', '已复制该事件'),
      }),
    ]),
    pre,
  ]);
}

function clock(at) {
  const date = new Date(Number(at));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function refresh(tab) {
  if(tab&&activeTab()?.id!==tab.id||state.overviewPane)return;
  const host = document.getElementById('response-host');
  if (!host) return;
  import('./response.js').then(({ renderResponsePane }) => {
    if(tab&&activeTab()?.id!==tab.id||state.overviewPane)return;
    host.replaceChildren(renderResponsePane(tab || activeTab()));
  });
}

/// Called for every streamed event: appends without rebuilding the pane, so a
/// fast stream does not thrash the DOM.
export function renderSseView(tab, event) {
  if (!tab.stream) return;
  if(activeTab()?.id!==tab.id||state.overviewPane)return;
  for(const [key,text] of [['count',String(tab.stream.count)],['bytes',fmtBytes(tab.stream.bytes)],['status',tab.stream.error?'连接失败':tab.running?tab.stream.status?'接收中':'连接中…':'连接结束']]){
    const node=document.getElementById(`sse-${key}-${tab.id}`);if(node)node.textContent=text;
  }
  for(const [key,text] of [['events',`事件 (${tab.stream.events.length})`],['raw',`原始流 (${tab.stream.raw.length} 段)`],['headers',`Headers (${tab.stream.headers?.length||0})`]]){
    const node=document.getElementById(`sse-tab-${key}-${tab.id}`);if(node)node.textContent=text;
  }
  if(event?.kind==='done'||event?.kind==='error'){refresh(tab);return;}
  if (tab.responseView === 'raw') {
    if(event&&event.kind!=='raw')return;
    const log = document.getElementById(rawId(tab));
    const chunk = tab.stream.raw[tab.stream.raw.length - 1];
    if (!log || !chunk) return;
    const append = () => {
      if(log.querySelector(`[data-seq="${chunk.seq}"]`))return;
      appendLive(log,rawNode(tab,chunk),500);
    };
    // one call for the frame that just landed, not one for the whole log
    if (tab.rawCharset && chunk.b64) {
      api
        .redecode(chunk.b64, tab.rawCharset)
        .then((text) => {
          chunk.shown = text;
          append();
        })
        .catch(append);
    } else {
      append();
    }
    return;
  }
  if(event?.kind==='raw')return;
  const list = document.getElementById(hostId(tab));
  if (!list) return;
  const last = tab.stream.events[tab.stream.events.length - 1];
  if (!last) return;
  appendLive(list,eventNode(last,true),800);
}

function copyAll(tab) {
  const stream = tab.stream;
  if (!stream || !stream.events.length) return;
  const text = stream.events
    .filter((event) => event.kind === 'message')
    .map((event) => `${event.event || 'message'}\n${event.data || ''}`)
    .join('\n\n');
  copy(text, '事件流已复制');
}

function exportMenu(anchor, tab) {
  const events = ((tab.stream && tab.stream.events) || []).filter((event) => event.kind !== 'open');
  menu(
    anchor,
    [
      { label: '导出为 .txt（可读事件流）', disabled: !events.length, onSelect: () => exportStream(tab.draft.name || 'sse', events, 'txt') },
      { label: '导出为 .json（结构化事件）', disabled: !events.length, onSelect: () => exportStream(tab.draft.name || 'sse', events, 'json') },
    ],
    { align: 'end' }
  );
}

/* ---------- raw wire view: exactly what arrived, no parsing ---------- */

function rawId(tab) {
  return `sse-raw-${tab.id}`;
}

function rawView(tab, chunks) {
  const marks = tab.rawMarks !== false;
  const toggle = el('input', {
    type: 'checkbox',
    class: 'check',
    checked: marks,
    onchange: (event) => {
      tab.rawMarks = event.target.checked;
      refresh(tab);
    },
  });
  const redecodable = chunks.some((chunk) => chunk.b64);
  const charset = selectField({
    className: 'raw-charset',
    title: redecodable
      ? '按指定编码重新解码已收到的字节，不用重新连接'
      : '每一段都是合法的 UTF-8，没有需要换码重解的字节',
    disabled: !redecodable,
    value: tab.rawCharset || '',
    options: [['', '自动'], ...CHARSETS.filter(([value]) => value !== 'utf-8')],
    onChange: (next) => {
      tab.rawCharset = next;
      applyCharset(tab).then(() => refresh(tab));
    },
  });
  const total = chunks.reduce((sum, chunk) => sum + (chunk.bytes || 0), 0);
  return el('div', { class: 'raw-wrap' }, [
    el('div', { class: 'raw-bar' }, [
      el('label', { class: 'inline' }, [toggle, el('span', { class: 'dim small', text: '标记 ␍ ' })]),
      charset,
      el('span', {
        class: 'faint small',
        text: chunks.length ? `${chunks.length} 段 · ${fmtBytes(total)} · 末段 ${clock(chunks[chunks.length - 1].at)}` : '还没有收到字节',
      }),
      el('button', { class: 'btn sm ghost', text: '复制原始流', onclick: () => copyRaw(tab) }),
      el('button', { class: 'btn sm ghost', text: '导出 .txt', onclick: () => exportRaw(tab) }),
    ]),
    el('pre', { class: 'raw-log', id: rawId(tab) },chunks.length?chunks.map(chunk=>rawNode(tab,chunk)):[el('span',{class:'empty',text:'暂无数据'})]),
  ]);
}

/// The engine only ships bytes for segments that were not valid UTF-8, so the
/// segments it could read stay as they are and the rest get replaced.
async function applyCharset(tab) {
  const chunks = rawChunks(tab);
  const charset = tab.rawCharset || '';
  const label = (CHARSETS.find(([value]) => value === charset) || [])[1] || charset;
  if (!charset) {
    for (const chunk of chunks) chunk.shown = null;
    return;
  }
  try {
    const texts = await api.redecodeChunks(chunks.map((chunk) => chunk.b64 || ''), charset);
    chunks.forEach((chunk, index) => {
      chunk.shown = texts[index] == null ? null : texts[index];
    });
    toast(`原始流已按 ${label} 重新解码`, 'ok', 2000);
  } catch (error) {
    tab.rawCharset = '';
    toast(`按 ${label} 解码失败：${(error && error.message) || error}`, 'err', 5000);
  }
}

function rawNode(tab, chunk) {
  const marks = tab.rawMarks !== false;
  const text = String(shownText(chunk));
  return el('div', { class: 'raw-chunk',dataset:{seq:chunk.seq} }, [
    el('span', { class: 'raw-meta', text: `#${chunk.seq} · ${chunk.bytes} B · ${clock(chunk.at)}` }),
    el('span', { class: 'raw-text', text: marks ? text.replace(/\r/g, '␍').replace(/\n/g, '␊\n') : text }),
  ]);
}

function rawChunks(tab) {
  return (tab.stream && tab.stream.raw) || [];
}

/// Copy and export follow whatever the view is showing, not the first decode.
function shownText(chunk) {
  return chunk.shown || chunk.text;
}

function copyRaw(tab) {
  const chunks = rawChunks(tab);
  if (!chunks.length) return toast('还没有收到字节', 'err', 1800);
  copy(chunks.map(shownText).join(''), '原始流已复制');
}

async function exportRaw(tab) {
  const chunks = rawChunks(tab);
  if (!chunks.length) return toast('还没有收到字节', 'err', 1800);
  const body = chunks.map((chunk) => `# ${chunk.seq} · ${chunk.bytes} B · ${clock(chunk.at)}` + String.fromCharCode(10) + shownText(chunk)).join(String.fromCharCode(10));
  const name = `${(tab.draft.name || 'sse').replace(/[\/:*?"<>|]+/g, '_')}-raw.txt`;
  await saveAs({ name, text: body, extensions: ['txt'] });
}
