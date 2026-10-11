import { el, icon, toast, bytes as fmtBytes, duration, copy, segmented, saveAs } from './ui.js';
import { renderSsePane } from './sse.js';
import { renderJsonView, toCsv } from './jsonview.js';
import { menu, selectField } from './menu.js';
import * as api from './api.js';
import { state, activeTab, emit, markDirty } from './state.js';
import { prompt } from './ui.js';
import { send, stopEverything, renderInto } from './request.js';
import { enterSurface, liveDuration } from './interaction.js';
import { renderCheckResults } from './check-editor.js';

export const CHARSETS = [
  ['utf-8', 'UTF-8'],
  ['gb18030', 'GB18030 / GBK'],
  ['big5', 'Big5'],
  ['shift_jis', 'Shift_JIS'],
  ['euc-kr', 'EUC-KR'],
  ['windows-1252', 'Windows-1252'],
  ['utf-16', 'UTF-16'],
];

async function reDecode(tab, charset) {
  const raw = tab.response && tab.response.bodyRawBase64;
  if (!raw) return;
  try {
    const text = await api.redecode(raw, charset);
    tab.response = { ...tab.response, bodyText: text, charset, isText: true };
    refresh();
    toast(`已按 ${charset} 重新解码`, 'ok', 1800);
  } catch (error) {
    toast(String((error && error.message) || error), 'err');
  }
}

function fileName(tab, ext) {
  const url = (tab.response && tab.response.finalUrl) || tab.draft.url || 'response';
  const tail = url.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() || 'response';
  const clean = tail.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'response';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${clean}-${stamp}.${ext}`;
}

async function saveBody(tab, ext) {
  const response = tab.response || {};
  const text = response.bodyText || '';
  if (ext === 'json') {
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch (error) {
      /* keep as-is */
    }
    await saveAs({ name: fileName(tab, 'json'), text: pretty, extensions: ['json'] });
  } else if (ext === 'csv') {
    const csv = toCsv(text);
    if (!csv) {
      toast('响应里没有可转成表格的对象数组', 'err');
      return;
    }
    await saveAs({ name: fileName(tab, 'csv'), text: csv, extensions: ['csv'] });
  } else {
    await saveAs({ name: fileName(tab, 'txt'), text, extensions: ['txt'] });
  }
}

function exportMenu(anchor, tab) {
  const text = (tab.response && tab.response.bodyText) || '';
  const looksJson = /^\s*[[{]/.test(text);
  menu(
    anchor,
    [
      { label: '下载为 .json', disabled: !looksJson, onSelect: () => saveBody(tab, 'json') },
      { label: '下载为 .txt', disabled: !text, onSelect: () => saveBody(tab, 'txt') },
      { label: '下载为 .csv（对象数组转表格）', disabled: !looksJson || !toCsv(text), onSelect: () => saveBody(tab, 'csv') },
      { separator: true },
      { label: '复制整个响应体', disabled: !text, onSelect: () => copyBody(tab) },
    ],
    { align: 'end' }
  );
}

const ERROR_LABEL = {
  timeout: '超时',
  connect: '连接失败',
  dns: '解析失败',
  tls: '证书错误',
  redirect: '重定向异常',
  cancelled: '已取消',
  invalid: '配置有误',
  body: '读取失败',
  network: '网络错误',
  client: '内部错误',
};

export function renderResponsePane(tab) {
  if (tab.protocol === 'sse' || (tab.stream && !tab.response)) return renderSsePane(tab);
  if (tab.protocol === 'ws') return el('div', { class: 'empty' }, [el('h3', { text: 'WebSocket 面板' })]);

  const wrap = el('div', { class: 'response' });
  const phase = tab.running ? tab.running.execId : tab.response || 'idle';
  if (tab._responsePhase !== phase || tab._responseSubview !== tab.responseView) enterSurface(wrap);
  tab._responsePhase = phase;tab._responseSubview = tab.responseView;
  if (tab.running && tab.running.kind !== 'sse') {
    wrap.appendChild(
      el('div', { class: 'response-head' }, [
        el('span', { class: 'status-dot live' }),
        el('span', { class: 'dim', text: '请求发送中…' }),
        el('span',{class:'meta'},[liveDuration(tab.running.startedAt||Date.now())]),
        el('button', {
          class: 'btn sm right',
          text: '取消',
          onclick: () => {
            stopEverything(tab);
            renderInto(document.getElementById('request-host'));
          },
        }),
      ])
    );
    wrap.appendChild(el('div', { class: 'request-waiting', role: 'status' }, [
      el('div', { class: 'request-waiting-symbol', 'aria-hidden':'true' }, [icon('send')]),
      el('strong', { text: '等待响应' }),
      el('code', { text: tab.lastRequestSnapshot?.draft?.url || tab.draft.url }),
      el('div', { class: 'loading', 'aria-hidden':'true' }),
    ]));
    return wrap;
  }

  const response = tab.response;
  if (!response) {
    // Show the pending target without tutorial text.
    const target = (tab.draft.url || '').trim();
    const method = tab.draft.method || 'GET';
    wrap.appendChild(el('div', { class: 'response-head' }, [
      el('span', { class: 'response-label', text: 'Response' }),
    ]));
    wrap.appendChild(
      el('div', { class: 'empty' }, [
        el('div', { class: 'response-symbol', 'aria-hidden': 'true' }, [icon('terminal')]),
        el('h3', { text: '暂无响应' }),
        target
          ? el('div', { class: 'empty-target' }, [
              el('span', { class: `method-${method.toLowerCase()}`, text: method }),
              el('code', { text: target }),
            ])
          : null,
        el('div', { class: 'btn-row', style: { justifyContent: 'center' } }, [
          el('button', {
            class: 'btn',
            text: '发送请求',
            onclick: () => send(activeTab()),
          }),
        ]),
        el('span', { class: 'empty-shortcut' }, [el('kbd', { text: 'Ctrl' }), ' + ', el('kbd', { text: 'Enter' })]),
      ])
    );
    return wrap;
  }

  const statusClass = response.error ? 'err' : response.status >= 400 ? 'warn' : 'ok';
  const errorLabel = ERROR_LABEL[response.errorKind] || (response.errorKind || 'ERROR');
  const head = el('div', { class: 'response-head response-summary' }, [
    el('span', { class: 'response-label', text: 'Response' }),
    response.error
      ? el('span', { class: `pill ${statusClass}`, text: errorLabel })
      : el('span', { class: `pill ${statusClass}`, text: `${response.status} ${response.statusText || ''}`.trim() }),
    el('span', { class: 'meta', title: '响应耗时' }, [icon('clock'), el('b', { text: duration(response.timeMs || 0) })]),
    el('span', { class: 'meta', title: '响应大小' }, [icon('file'), el('b', { text: fmtBytes(response.sizeBytes) })]),
    response.contentType ? el('span', { class: 'meta response-media mono', text: response.contentType.split(';')[0],title:response.contentType }) : null,
    response.charset && !response.bodyRawBase64
      ? el('span', { class: 'meta', title: '响应编码' }, [el('b', { text: String(response.charset).toUpperCase() })])
      : null,
    response.bodyRawBase64
      ? selectField({
          className: 'sm response-charset',
          title: '按指定编码重新解码同一批字节',
          value: response.charset || '',
          options: [['', '编码…'], ...CHARSETS],
          onChange: (next) => reDecode(tab, next),
        })
      : null,
    el('div', { class: 'btn-row right' }, [
      el('button', {
        class: 'btn sm',
        title: '把响应体复制到剪贴板',
        onclick: () => copyBody(tab),
      }, [icon('copy'), el('span', { text: '复制 Body' })]),
      el('button', {
        class: 'btn sm',
        title: '导出为 json / txt / csv',
        onclick: (event) => exportMenu(event.currentTarget, tab),
      }, [icon('download'), el('span', { text: '导出' })]),
    ]),
  ]);
  wrap.appendChild(head);
  if (response.checkResult && (response.checkResult.checks.length || response.checkResult.extractions.length)) head.insertBefore(el('button', {
    class: `btn sm check-pill ${response.checkResult.ok ? '' : 'danger'}`,
    text: response.checkResult.ok ? '检查通过' : response.checkResult.outcome === 'cancelled' ? '已取消' : '检查未通过',
    onclick: () => { tab.responseView = 'checks'; refresh(); },
  }), head.querySelector('.btn-row'));

  if (response.error) {
    wrap.appendChild(
      el('div', { class: 'pane' }, [
        el('div', { class: 'stack' }, [
          el('strong', { style: { color: 'var(--err)' }, text: '请求失败' }),
          el('p', { text: response.error, style: { margin: '0', lineHeight: '1.7' } }),
          response.finalUrl ? el('span', { class: 'hint mono', text: response.finalUrl }) : null,
        ]),
      ])
    );
  }

  const views = [['body', 'Body',null], ['headers', 'Headers',(response.headers || []).length], ['cookies', 'Cookies',(response.setCookies || []).length]];
  if (response.checkResult && (response.checkResult.checks.length || response.checkResult.extractions.length)) views.push(['checks', '检查', `${response.checkResult.passed}/${response.checkResult.checks.length}`]);
  const strip = el(
    'div',
    { class: 'subtabs response-tabs' },
    views.map(([key, label,count]) =>
      el(
        'button',
        {
          class: `subtab ${tab.responseView === key ? 'on' : ''}`,
          onclick: () => {
            tab.responseView = key;
            refresh();
          },
        },
        [el('span', { text: label }),count!==null?el('span',{class:'count',text:String(count)}):null]
      )
    )
  );
  if (response.note) strip.appendChild(el('span', { class: 'hint right', style: { marginRight: '10px' }, text: response.note }));
  wrap.appendChild(strip);

  const body = el('div', { class: 'response-body' });
  if (tab.responseView === 'checks') body.appendChild(renderCheckResults(response.checkResult, { secrets: tab.lastRequestSnapshot?.secrets || [], environmentId: response.checkEnvironmentId }));
  else if (tab.responseView === 'headers') body.appendChild(renderHeaders(response.headers || []));
  else if (tab.responseView === 'cookies') body.appendChild(renderCookies(response.setCookies || []));
  else body.appendChild(renderBody(tab, response));
  wrap.appendChild(body);
  return wrap;
}

function refresh() {
  const host = document.getElementById('response-host');
  if (!host) return;
  host.replaceChildren(renderResponsePane(activeTab()));
}

function renderHeaders(headers) {
  return el(
    'table',
    { class: 'table' },
    [
      el('thead', {}, [el('tr', {}, [el('th', { text: '名称' }), el('th', { text: '值' })])]),
      el(
        'tbody',
        {},
        headers.map((item) => el('tr', {}, [el('td', { style: { width: '260px', color: 'var(--accent)' }, text: item.name }), el('td', { text: item.value })]))
      ),
    ]
  );
}

function renderCookies(list) {
  if (!list.length) return el('div', { class: 'empty' }, [el('p', { text: '没有 Set-Cookie。' })]);
  return el(
    'div',
    { class: 'pane' },
    [el('h4', { style: { margin: '0 0 8px' }, text: '本次响应写入的 Cookie' })].concat(
      list.map((raw) => el('div', { class: 'pick', style: { cursor: 'default', marginBottom: '6px' } }, [el('span', { class: 'mono small', text: raw })]))
    )
  );
}

function renderBody(tab, response) {
  const host = el('div', { style: { height: '100%' } });
  if (!response.bodyText && !response.bodyBase64) {
    host.appendChild(
      el('div', { class: 'empty' }, [
        el('h3', { text: '没有响应体' }),
      ])
    );
    return host;
  }
  if (response.isText === false) {
    // A binary body used to be an empty-state paragraph with two small buttons,
    // which read as "nothing arrived". It is a file: give it the file card —
    // identity row, then the bytes themselves, then the verb that saves them.
    const size = response.sizeBytes || 0;
    const bytes = decodeBytes(response.bodyBase64);
    let view = tab.binaryView || 'hex';
    const pre = el('pre', { class: 'code' });
    const paint = () => {
      tab.binaryView = view;
      if (view === 'base64') {
        pre.textContent = (response.bodyBase64 || '').slice(0, 20000);
        return;
      }
      pre.textContent = hexDump(bytes);
    };
    paint();
    const given = serverFileName(response);
    host.appendChild(
      el('div', { class: 'group binary-card' }, [
        el('div', { class: 'group-head' }, [
          el('span', { text: '二进制响应' }),
          el('div', { class: 'btn-row' }, [
            segmented(
              [
                ['hex', '十六进制'],
                ['base64', 'Base64'],
              ],
              view,
              (value) => {
                view = value;
                paint();
              }
            ),
            el('button', { class: 'btn sm primary', title: '另存为文件', onclick: () => downloadBody(tab) }, [
              icon('download'),
              el('span', { text: '下载文件' }),
            ]),
          ]),
        ]),
        el('div', { class: 'binary-meta' }, [
          el('span', { class: 'binary-glyph' }, [icon('file')]),
          el('div', { class: 'stack', style: { gap: '2px' } }, [
            el('b', { text: response.contentType || '未知类型' }),
            el('span', {
              class: 'hint',
              text: `${fmtBytes(size)} · ${given ? '服务器给的文件名' : '下载时建议命名'} ${suggestName(response)}`,
            }),
          ]),
        ]),
        el('div', { class: 'binary-dump' }, [pre]),
      ])
    );
    return host;
  }
  const text = response.bodyText || '';
  const isJson = (response.contentType || '').includes('json') || looksJson(text);
  let mode = tab.bodyMode || 'pretty';
  if (mode === 'tree' && !isJson) mode = 'pretty';
  // A megabyte of highlighted markup is not something a <pre> paints quickly, and
  // a frozen pane never explains itself. Render a budget, say that we did, and
  // keep 复制 / 导出 on the full body. The tree view is already lazy per node.
  const RENDER_CAP = 200000;
  // Pretty formats the whole body first and clips after: slicing a JSON string
  // before parsing it leaves invalid JSON, and the fallback would make Pretty
  // look exactly like Raw. Raw must stay the bytes it received, so it never
  // borrows Pretty's formatting pass.
  const PARSE_CAP = 2000000;
  const sourceFor = (want) =>
    want === 'pretty' && isJson && text.length <= PARSE_CAP ? formatJson(text) : text;
  host.classList.add('response-viewer');
  const search = el('input', { class: 'input', placeholder: '搜索响应…','aria-label':'搜索响应',value:tab._responseSearch || '',dataset:{variables:'false'} });
  const pre = el('pre', { class: 'code' });
  const treeHost = el('div',{class:'response-tree'});
  const content = el('div', { class:'response-content',tabindex:'0','aria-label':'响应内容' });
  requestAnimationFrame(()=>{if(content.isConnected)content.scrollTop=tab._responseTop || 0;});
  const count=el('span',{class:'response-text-count mono'});
  const hitCount=el('span',{class:'response-search-count mono','aria-live':'polite'});
  let marks=[],index=-1;
  const updateHits=()=>{
    hitCount.textContent=search.value?(marks.length?`${index+1} / ${marks.length}${marks.length===1000?'+':''}`:'无匹配'):'';
    prev.disabled=next.disabled=!marks.length;
  };
  const step=delta=>{
    if(!marks.length)return;
    marks[index]?.classList.remove('current');index=(index+delta+marks.length)%marks.length;
    marks[index].classList.add('current');updateHits();
    marks[index].scrollIntoView({block:'center',inline:'nearest'});
  };
  const prev=el('button',{class:'btn sm icon ghost',title:'上一个匹配（Shift+Enter）','aria-label':'上一个匹配',onclick:()=>step(-1)},[icon('chevU')]);
  const next=el('button',{class:'btn sm icon ghost',title:'下一个匹配（Enter）','aria-label':'下一个匹配',onclick:()=>step(1)},[icon('chevD')]);
  const clear=el('button',{class:'btn sm icon ghost',title:'清除搜索','aria-label':'清除响应搜索',onclick:()=>{search.value='';tab._responseSearch='';paint();search.focus();}},[icon('close')]);
  const wrap=el('button',{class:'btn sm response-wrap','aria-label':'自动换行','aria-pressed':!!tab._responseWrap,text:'换行',title:'切换长行自动换行',onclick:()=>{tab._responseWrap=!tab._responseWrap;wrap.setAttribute('aria-pressed',String(tab._responseWrap));pre.classList.toggle('wrap',!!tab._responseWrap);}},[icon('wrap')]);
  const paint = (navigate=false) => {
    tab.bodyMode = mode;
    const tree=mode==='tree';search.disabled=tree;wrap.disabled=tree;search.placeholder=tree?'树视图可复制节点':'搜索响应…';clear.disabled=tree;
    hitCount.textContent='';prev.disabled=next.disabled=true;marks=[];index=-1;
    if (mode === 'tree') {
      content.replaceChildren(treeHost);
      const restore=!!tab._responseTreePaths;
      tab._responseTreePaths=tab._responseTreePaths || new Set();
      renderJsonView(treeHost,text,{expandedPaths:tab._responseTreePaths,restore,onExtract:async(path,key)=>{
        const name = await prompt({title:'提取变量',label:'变量名',value:/^[A-Za-z_][\w]*$/.test(String(key)) ? String(key) : 'value'});
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed || /[{}\s]/.test(trimmed) || trimmed.startsWith('$')) { toast('请输入有效变量名', 'err'); return; }
        tab.draft.extractors ||= [];
        if (tab.draft.extractors.some(rule => rule.name.trim() === trimmed)) { toast('这个变量已有提取规则，请在检查与提取中修改', 'err'); return; }
        tab.draft.extractors.push({ name: trimmed, source: 'json', path, enabled: true });
        tab.view='checks'; markDirty(tab); emit('rerender'); toast('已添加提取规则，下次执行生效', 'ok');
      }});
      count.textContent='JSON';
      return;
    }
    const source = sourceFor(mode);
    // Bound both bytes and line nodes: a response of only newlines should not
    // create hundreds of thousands of elements while staying below the byte cap.
    const sliced=source.slice(0,RENDER_CAP),lines=sliced.split('\n'),shownLines=lines.slice(0,6000);
    const over=source.length>RENDER_CAP || lines.length>6000;
    const language=isJson?'json':looksXml(sliced)?'xml':'text';
    pre.innerHTML=shownLines.map((line,lineIndex)=>`<span class="code-line" data-line="${lineIndex+1}">${mode==='raw'?escapeHtml(line):highlight(line,language)}</span>`).join('\n');
    pre.classList.toggle('wrap',!!tab._responseWrap);
    count.textContent=`${isJson?'JSON · ':''}${shownLines.length.toLocaleString()} 行`;
    // the band only exists when it is true: a hidden one still reads as text to
    // anything scraping the pane
    const note = over
      ? el('div', {
          class: 'render-note',
          text: `显示前 ${Math.min(RENDER_CAP,shownLines.join('\n').length).toLocaleString()} 字符，共 ${source.length.toLocaleString()} 个 · 复制与导出保留全量`,
        })
      : null;
    // replaceChildren does not filter null — it would write "null" onto the screen
    content.replaceChildren(...(note ? [note] : []), pre);
    marks=applySearch(pre,search.value);index=marks.length?0:-1;marks[0]?.classList.add('current');updateHits();
    if(navigate&&marks[0])marks[0].scrollIntoView({block:'center',inline:'nearest'});
  };
  search.addEventListener('input', () => {
    tab._responseSearch=search.value;if(mode!=='tree')paint(true);
  });
  search.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();step(event.shiftKey?-1:1);}if(event.key==='Escape'&&search.value){event.preventDefault();event.stopPropagation();clear.click();}});
  const modes = [['pretty', 'Pretty'], ...(isJson ? [['tree', '树']] : []), ['raw', 'Raw']];
  host.appendChild(
    el('div', { class: 'code-bar' }, [
      segmented(modes, mode, (value) => {
        mode = value;
        paint();
      }),
      count,
      wrap,
      el('div',{class:'response-search'},[icon('search'),search,hitCount,prev,next,clear]),
    ])
  );
  host.appendChild(content);
  paint();
  return host;
}

function applySearch(pre, term) {
  if (!term) return [];
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  const targets = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.toLowerCase().includes(term.toLowerCase())) targets.push(walker.currentNode);
  }
  const marks=[];
  for (const node of targets) {
    const text=node.nodeValue,lower=text.toLowerCase(),needle=term.toLowerCase(),fragment=document.createDocumentFragment();let start=0,offset;
    while(marks.length<1000&&(offset=lower.indexOf(needle,start))!==-1){
      fragment.append(document.createTextNode(text.slice(start,offset)));
      const mark=el('span',{class:'mark',text:text.slice(offset,offset+term.length)});fragment.append(mark);marks.push(mark);start=offset+term.length;
    }
    fragment.append(document.createTextNode(text.slice(start)));node.replaceWith(fragment);
    if(marks.length>=1000)break;
  }
  return marks;
}

function looksJson(text) {
  const trimmed = (text || '').trim();
  return (trimmed.startsWith('{') || trimmed.startsWith('[')) && isJsonish(trimmed);
}

function isJsonish(trimmed) {
  try {
    JSON.parse(trimmed);
    return true;
  } catch (error) {
    return false;
  }
}

function looksXml(text) {
  const trimmed = (text || '').trim();
  return trimmed.startsWith('<') && trimmed.endsWith('>');
}

function formatJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch (error) {
    return text;
  }
}

export function escapeHtml(input) {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const JSON_RE = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

export function highlight(text, language = 'json') {
  const safe = escapeHtml(text);
  if (language === 'json') {
    return safe.replace(JSON_RE, (match, key, str, bool, num) => {
      if (key) return `<span class="tok-key">${key}</span>`;
      if (str) return `<span class="tok-str">${str}</span>`;
      if (bool) return `<span class="tok-bool">${bool}</span>`;
      return `<span class="tok-num">${num}</span>`;
    });
  }
  if (language === 'xml') {
    return safe
      .replace(/(&lt;\/?)([\w:.-]+)/g, (m, a, b) => `${a}<span class="tok-key">${b}</span>`)
      .replace(/([\w:.-]+)=(&quot;[^&]*?&quot;)/g, (m, k, v) => `<span class="tok-str">${k}</span>=${v}`);
  }
  return safe;
}

function bodyText(tab) {
  const response = tab.response || {};
  return response.bodyText || '';
}

function copyBody(tab) {
  const text = bodyText(tab);
  if (!text) {
    toast('没有可复制的文本响应', 'err');
    return;
  }
  copy(text, '响应已复制');
}

async function downloadBody(tab) {
  const response = tab.response || {};
  const name = suggestName(response);
  if (response.isText === false && response.bodyBase64) {
    // Hand the base64 to Rust and decode there. Going through atob() here used to
    // build a JS string of char codes and let Blob() re-encode it as UTF-8, which
    // silently doubled every byte above 0x7F and corrupted images and archives.
    await saveAs({ name, base64: response.bodyBase64 });
    return;
  }
  await saveAs({ name, text: response.bodyText || '' });
  emit('response');
}

/// The server's own filename wins. A download endpoint usually says
/// `Content-Disposition: attachment; filename="report.xlsx"`, and for non-ASCII
/// the RFC 5987 form `filename*=UTF-8''…` — dropping that and naming the file
/// `response-….txt` discards the one fact the server volunteered.
export function serverFileName(response) {
  const headers = Array.isArray(response && response.headers) ? response.headers : [];
  const hit = headers.find(
    (row) => String((row && (row.name || row.key)) || '').toLowerCase() === 'content-disposition'
  );
  if (!hit) return '';
  const line = String(hit.value || '');
  let name = '';
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(line);
  if (extended) {
    const raw = extended[1].trim();
    const first = raw.indexOf("'");
    const value = first >= 0 ? raw.slice(raw.indexOf("'", first + 1) + 1) : raw;
    const unquoted = value.replace(/^"|"$/g, '');
    try {
      name = decodeURIComponent(unquoted);
    } catch (error) {
      name = unquoted;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*("([^"]*)"|[^;]*)/i.exec(line);
    if (plain) name = (plain[2] !== undefined ? plain[2] : plain[1]).trim();
  }
  // a header must never steer the save dialog out of a single file name
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').slice(0, 120).trim();
  return name === '.' || name === '..' ? '' : name;
}

function suggestName(response) {
  const given = serverFileName(response);
  if (given) return given;
  const ct = response.contentType || '';
  const ext = ct.includes('json') ? 'json' : ct.includes('html') ? 'html' : ct.includes('xml') ? 'xml' : ct.includes('csv') ? 'csv' : 'txt';
  return `response-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
}

function decodeBytes(base64) {
  try {
    const bin = atob(base64 || '');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch (error) {
    return new Uint8Array(0);
  }
}

/// offset | hex | printable, first 256 bytes — enough to recognise a PNG or a
/// gzip by eye without pretending the whole file fits on screen.
function hexDump(bytes) {
  const head = bytes.subarray(0, 256);
  const lines = [];
  for (let off = 0; off < head.length; off += 16) {
    const chunk = head.subarray(off, off + 16);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47, ' ')}  ${ascii}`);
  }
  if (!lines.length) return '（没有字节）';
  if (bytes.length > head.length) lines.push(`… 其余 ${(bytes.length - head.length).toLocaleString()} 字节请下载后查看`);
  return lines.join('\n');
}
