import { el, icon, modal, copy, segmented } from './ui.js';
import { buildSendDraft, effectiveAuth, varScope, render, on, emit, splitQuery } from './state.js';

let previewFrame;
on('changed', () => {
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => document.querySelectorAll('.request-preview-content, .request-context').forEach(node => node.refresh?.()));
});

const sensitiveKey = /authorization|cookie|token|secret|password|credential|api[-_]?key/i;
const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

export function requestUrl(draft) {
  if (draft.resolvedUrl !== undefined) return draft.resolvedUrl;
  let url = draft.url.trim();
  if (url && !url.includes('://')) url = `https://${url}`;
  const encode = value => encodeURIComponent(String(value).trim()).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
  const rows = (draft.params || []).filter(row => row.enabled !== false && row.key.trim());
  if (!rows.length) return url;
  const at = url.indexOf('#'), fragment = at < 0 ? '' : url.slice(at);
  const { base, pairs } = splitQuery(at < 0 ? url : url.slice(0, at));
  // Saved drafts carry query values both in the URL and in Params. Match the
  // send pipeline's precedence without duplicating keys in exported examples.
  const merged = rows.concat(pairs.filter(pair => !rows.some(row => row.key === pair.key)));
  const query = merged.map(row => `${encode(row.key)}=${encode(row.value)}`).join('&');
  return `${base}${query ? '?' + query : ''}${fragment}`;
}

export function requestCurl(draft) {
  const lines = [`curl -X ${draft.method} ${shellQuote(requestUrl(draft))}`];
  for (const header of draft.headers || []) lines.push(`  -H ${shellQuote(`${header.key}: ${header.value}`)}`);
  const body = draft.body || {};
  if (body.mode === 'raw' && body.raw?.content) lines.push(`  --data-raw ${shellQuote(body.raw.content)}`);
  if (body.mode === 'urlencoded') for (const row of body.urlencoded || []) lines.push(`  --data-urlencode ${shellQuote(`${row.key}=${row.value}`)}`);
  if (body.mode === 'form') for (const row of body.form || []) lines.push(`  -F ${shellQuote(`${row.key}=${row.kind === 'file' ? '@' : ''}${row.value}`)}`);
  if (body.mode === 'file' && body.file) lines.push(`  --data-binary ${shellQuote(`@${body.file.path || body.file}`)}`);
  return lines.join(' \\\n');
}

export function requestSnapshot(tab, built = buildSendDraft(tab)) {
  const scope = varScope(tab.refId), auth = built.auth || effectiveAuth(tab);
  const secrets = [...built.variables.filter(row => sensitiveKey.test(row.key)).map(row => row.value)];
  for (const field of ['token', 'password', 'value']) {
    const value = auth[auth.kind]?.[field];
    if (value) secrets.push(built.auth ? value : render(value, scope).text);
  }
  for (const row of built.draft.headers) if (sensitiveKey.test(row.key)) secrets.push(row.value);
  const { scope: transientScope, ...snapshotBuilt } = built;
  return JSON.parse(JSON.stringify({ ...snapshotBuilt, template: {draft:tab.draft,auth:tab.auth || {kind:'noauth'}}, at: Date.now(), secrets: [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length) }));
}

export function requestContext(tab, build = () => buildSendDraft(tab)) {
  const context = el('div', { class: 'request-context' });
  context.refresh = () => {
    const built = build();
    context.replaceChildren(
      el('div', { class: 'request-context-meta' }, [
        el('span', { class: 'request-context-env', title: built.environment }, [icon('env'), el('span', { text: built.environment })]),
        el('span', { class: 'request-context-divider', 'aria-hidden': 'true' }),
        el('button', { type: 'button', class: `request-context-variables${built.missing.length ? ' request-context-missing' : ''}`, 'aria-label': '查看当前请求变量', 'aria-haspopup': 'dialog', title: built.missing.length ? `未解析：${built.missing.join('、')}` : '查看当前请求使用的变量、解析值与来源', onclick: () => openRequestPreview(tab, build(), { variablesOnly: true, build }) }, [
          icon('braces'), el('span', { text: built.missing.length ? `未解析：${built.missing.join('、')}` : `${built.variables.length} 个变量` }),
        ]),
      ]),
      el('button', { class: 'request-context-toggle', 'aria-expanded': String(!!tab.previewPinned), onclick: () => { tab.previewPinned = !tab.previewPinned; emit('rerender'); } }, [
        el('span', { text: tab.previewPinned ? '收起请求详情' : '查看解析请求' }), icon(tab.previewPinned ? 'chevU' : 'chevD'),
      ])
    );
  };
  context.refresh(); return context;
}

export function openRequestPreview(tab, built, { embedded = false, variablesOnly = false, frozen = false, build = () => buildSendDraft(tab) } = {}) {
  let current = frozen ? built : requestSnapshot(tab, built);
  let snapshot = current, section = variablesOnly ? 'variables' : embedded ? tab.previewSection || 'headers' : 'headers', reveal = false;
  const content = el('div', { class: 'request-preview-content' });
  const header = el('div', { class: 'request-preview-summary' });
  const detail = el('div', { class: 'request-preview-detail' });
  const warning = el('div', { class: 'request-preview-warning', role: 'status' });
  const tabs = el('div', { class: 'subtabs preview-tabs', role: 'tablist', 'aria-label': '请求详情' });
  const variableSummary = el('div', { class: 'preview-variable-summary' });
  const redact = value => {
    let text = String(value ?? '');
    if (!reveal) for (const secret of snapshot.secrets) text = text.split(secret).join('••••••••');
    return text;
  };
  const mask = (key, value) => !reveal && sensitiveKey.test(key) && value ? '••••••••' : redact(value);
  const textBlock = text => el('pre', { class: 'preview-code', text });
  const table = (columns, rows) => rows.length ? el('table', { class: 'preview-table' }, [
    el('thead', {}, [el('tr', {}, columns.map(text => el('th', { text })))]),
    el('tbody', {}, rows.map(row => el('tr', {}, row.map((text, i) => el('td', { class: i < 2 ? 'mono' : '', text }))))),
  ]) : el('div', { class: 'preview-empty', text: '无' });
  const authNames = { bearer: 'Bearer Token', basic: 'Basic Auth', apikey: 'API Key', noauth: '无鉴权', inherit: '无鉴权' };
  const sections = [['headers', 'Headers'], ['params', 'Params'], ...(tab.protocol === 'ws' ? [] : [['body', 'Body']]), ['auth', 'Auth'], ['variables', '变量'], ['settings', '设置'], ...(tab.protocol === 'ws' ? [] : [['curl', 'cURL']])];
  const drawDetail = () => {
    if (embedded) tab.previewSection = section;
    content.classList.toggle('is-variable-view', embedded && section === 'variables');
    const { draft } = snapshot;
    tabs.querySelectorAll('button').forEach(button => {
      const selected = button.dataset.section === section;
      button.classList.toggle('on', selected);button.setAttribute('aria-selected', String(selected));button.tabIndex = selected ? 0 : -1;
    });
    let node;
    if (section === 'headers') node = table(['名称', '值', '来源'], draft.headers.map((row, i) => [row.key, mask(row.key, row.value), snapshot.headerSources[i] || '请求']));
    if (section === 'params') node = table(['名称', '值'], draft.params.map(row => [row.key, mask(row.key, row.value)]));
    if (section === 'variables') node = snapshot.variables.length ? table(['变量', '解析值', '来源'], snapshot.variables.map(row => [row.key, row.missing ? '未解析' : mask(row.key, row.value), row.source])) : el('div', { class: 'preview-empty', text: '当前请求未使用变量' });
    if (section === 'auth') {
      const auth = snapshot.auth || { kind: 'noauth' }, values = auth[auth.kind] || {};
      const rows = [['类型', authNames[auth.kind] || auth.kind]];
      if (auth.kind === 'bearer') rows.push(['Token', mask('token', values.token)]);
      if (auth.kind === 'basic') rows.push(['用户名', redact(values.username)], ['密码', mask('password', values.password)]);
      if (auth.kind === 'apikey') rows.push(['名称', redact(values.key)], ['值', mask('apikey', values.value)], ['位置', values.addTo === 'query' ? 'Query' : 'Header']);
      node = table(['鉴权', '值'], rows);
    }
    if (section === 'body') {
      const body = draft.body;
      if (body.mode === 'raw') node = textBlock(redact(body.raw?.content || ''));
      else if (body.mode === 'form' || body.mode === 'urlencoded') node = table(['名称', '值', '类型'], (body[body.mode] || []).map(row => [row.key, mask(row.key, row.value), row.kind === 'file' ? '文件' : '文本']));
      else node = el('div', { class: 'preview-empty', text: body.file ? redact(body.file.path || body.file) : '无 Body' });
    }
    if (section === 'settings') node = table(['设置', '值'], tab.protocol === 'ws' ? [
      ['超时', `${draft.settings.timeoutMs} ms`], ['SSL 校验', draft.settings.sslVerify ? '开启' : '关闭'], ['子协议', (draft.subprotocols || []).join(', ') || '无'],
    ] : [
      ['超时', `${draft.settings.timeoutMs} ms`], ['重定向', draft.settings.followRedirects ? '跟随' : '不跟随'],
      ['SSL 校验', draft.settings.sslVerify ? '开启' : '关闭'], ['Cookie Jar', draft.settings.cookieJar ? '开启' : '关闭'],
      ['代理', redact(draft.settings.proxy || '无')],
    ]);
    if (section === 'curl') node = textBlock(redact(requestCurl(draft)));
    detail.replaceChildren(node);
  };
  for (const [key, label] of sections) tabs.append(el('button', {
    class: 'subtab', role: 'tab', dataset: { section: key }, onclick: () => {section = key;drawDetail();},
    onkeydown: event => {
      const index = sections.findIndex(item => item[0] === key);
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % sections.length;
      if (event.key === 'ArrowLeft') next = (index + sections.length - 1) % sections.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = sections.length - 1;
      if (next !== undefined) {event.preventDefault();section = sections[next][0];drawDetail();tabs.children[next].focus();}
    }, text: label,
  }));
  const draw = () => {
    variableSummary.replaceChildren(icon('env'), el('span', { class: 'preview-variable-environment', text: snapshot.environment, title: snapshot.environment }), el('span', { class: 'preview-variable-count', text: `${snapshot.variables.length} 个变量` }));
    header.replaceChildren(
      el('div', { class: 'preview-context' }, [
        el('span', { class: 'tag', text: snapshot.draft.method }),
        el('span', { text: snapshot.environment }), el('span', { text: authNames[snapshot.authKind] || snapshot.authKind }),
        snapshot !== current ? el('span', { class: 'preview-timestamp', text: new Date(snapshot.at).toLocaleTimeString() }) : null,
      ]),
      el('code', { class: 'preview-url', text: redact(requestUrl(snapshot.draft)) }),
    );
    const notices = [];
    if (snapshot.missing.length) notices.push(`未解析变量：${snapshot.missing.join('、')}`);
    if (!frozen && snapshot === current && snapshot.variables.some(row => row.source === '动态')) notices.push('动态变量在发送时重新生成；上次发送保留当时值。');
    warning.textContent = notices.join(' · ');warning.hidden = !notices.length;
    warning.classList.toggle('has-missing', !!snapshot.missing.length);
    drawDetail();
  };
  const revealButton = el('button', { class: 'btn sm', text: '显示敏感值', 'aria-pressed': false, onclick: () => {
    reveal = !reveal;revealButton.textContent = reveal ? '隐藏敏感值' : '显示敏感值';revealButton.setAttribute('aria-pressed', String(reveal));draw();
  } });
  const toolbar = el('div', { class: 'preview-toolbar' }, [
    variablesOnly ? variableSummary : !frozen && tab.lastRequestSnapshot ? segmented([['current', '当前请求'], ['last', '上次发送']], 'current', value => {snapshot = value === 'last' ? tab.lastRequestSnapshot : current;draw();}) : el('span', { class: 'preview-mode', text: frozen ? '当次提交' : '当前请求' }),
    el('div', { class: 'btn-row' }, [revealButton, variablesOnly || tab.protocol === 'ws' ? null : el('button', { class: 'btn sm', onclick: () => copy(redact(requestCurl(snapshot.draft)), reveal ? '已复制 cURL' : '已复制 cURL（敏感值已隐藏）') }, [icon('copy'), '复制 cURL'])]),
  ]);
  if (variablesOnly) content.append(toolbar, warning, detail);
  else content.append(toolbar, header, warning, tabs, detail, el('div', { class: 'preview-transport-note', text: 'Cookie、Host、Content-Length 与 multipart boundary 由发送引擎处理；此处显示提交给引擎的请求。' }));
  if (!frozen) content.refresh = () => { const latest = snapshot === current; current = requestSnapshot(tab, build()); if (latest) snapshot = current; draw(); };
  if (embedded) { draw(); return content; }
  const dialog = modal({title: variablesOnly ? '当前请求变量' : '请求预览', width: variablesOnly ? 760 : 940, body: [content], cancelText: '', onClose: variablesOnly ? () => requestAnimationFrame(() => document.querySelector('.request-context-variables')?.focus({ preventScroll: true })) : undefined});
  dialog.box.classList.add('request-preview');
  if (variablesOnly) dialog.box.classList.add('request-variables');
  draw();
}
