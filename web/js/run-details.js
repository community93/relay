import { el, icon, modal, segmented, copy, bytes, duration } from './ui.js';
import { on } from './state.js';
import { openRequestPreview, requestSnapshot } from './preview.js';
import { renderCheckResults } from './check-editor.js';

const TEXT_LIMIT = 262144;
const ENTRY_LIMIT = 2 * 1024 * 1024;
const RUN_LIMIT = 8 * 1024 * 1024;
const HISTORY_LIMIT = 24 * 1024 * 1024;
const encoder = new TextEncoder();
const sizes = new WeakMap();
const size = value => {
  if (!sizes.has(value)) sizes.set(value, encoder.encode(JSON.stringify(value)).length);
  return sizes.get(value);
};

// Each execution owns its snapshot. Bound payloads while keeping all summaries.
function bounded(value) {
  let truncated = false;
  const visit = item => {
    if (typeof item === 'string') {
      if (item.length <= TEXT_LIMIT) return item;
      truncated = true;
      const end = /[\uD800-\uDBFF]/.test(item[TEXT_LIMIT - 1]) ? TEXT_LIMIT - 1 : TEXT_LIMIT;
      return item.slice(0, end);
    }
    if (Array.isArray(item)) {
      if (item.length > 2048) truncated = true;
      return item.slice(0, 2048).map(visit);
    }
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  };
  return { value: visit(value), truncated };
}

export function captureRunRequest(tab, built) {
  const snapshot = requestSnapshot(tab, built);
  delete snapshot.template;
  const result = bounded(snapshot);
  return { request: result.value, requestTruncated: result.truncated };
}

export function captureRunResponse(details, response) {
  const { bodyRawBase64, bodyBase64, ...rest } = response;
  const result = bounded({ ...rest, ...(response.isText === false ? { bodyBase64: bodyBase64 || bodyRawBase64 || '' } : {}) });
  details.response = result.value;
  details.responseTruncated = result.truncated;
  sizes.delete(details);
}

export function captureRunChecks(details, checkResult) {
  const result = bounded(checkResult);
  details.checkResult = result.value;
  details.checksTruncated = result.truncated;
  sizes.delete(details);
}

export function boundRunDetails(run, history = []) {
  for (const entry of run.entries) {
    if (entry.details && size(entry.details) > ENTRY_LIMIT) {
      delete entry.details;
      entry.detailsUnavailable = '当次内容超过 2 MiB，未保留详情';
    }
  }
  const prune = (runs, limit, reason) => {
    const payloads = runs.flatMap(record => record.entries).filter(entry => entry.details).map(entry => ({ entry, bytes: size(entry.details) }));
    let total = payloads.reduce((sum, row) => sum + row.bytes, 0);
    for (const row of payloads) {
      if (total <= limit) break;
      total -= row.bytes;
      delete row.entry.details;
      row.entry.detailsUnavailable = reason;
    }
  };
  prune([run], RUN_LIMIT, '本轮详情超过 8 MiB，较早的内容已清理');
  prune([...history].reverse().filter(record => record !== run).concat(run), HISTORY_LIMIT, '历史详情超过 24 MiB，较早的内容已清理');
}

export function openRunEntry(run, index, openDefinition) {
  let entry = run.entries[index], view = entry.details?.response ? 'response' : 'request', responseView = 'body', pretty = true;
  const content = el('div', { class: 'run-detail-content' });
  const meta = el('div', { class: 'run-detail-meta' });
  const pane = el('div', { class: 'run-detail-pane' });
  const table = (columns, rows) => rows.length ? el('table', { class: 'preview-table' }, [
    el('thead', {}, [el('tr', {}, columns.map(text => el('th', { text })))]),
    el('tbody', {}, rows.map(row => el('tr', {}, row.map(text => el('td', { text }))))),
  ]) : el('div', { class: 'preview-empty', text: '无' });
  const nav = el('div', { class: 'btn-row' });
  let dialog;
  const move = delta => {
    index += delta; entry = run.entries[index];
    view = entry.details?.response ? 'response' : 'request'; responseView = 'body';
    draw();
  };
  const sections = () => [['request', '请求'], ['response', '响应'], ...(entry.details?.checkResult ? [['checks', '检查']] : [])];
  let tabs = segmented(sections(), view, value => { view = value; drawPane(); });
  const drawPane = () => {
    pane.replaceChildren();
    if (!entry.details) {
      pane.append(el('div', { class: 'preview-empty', text: entry.detailsUnavailable || (entry.skipped ? `已跳过：${entry.reason}` : '这条旧记录没有保存请求与响应详情') }));
      return;
    }
    if (view === 'checks') {
      if (entry.details.checksTruncated) pane.append(el('p', {class:'run-detail-notice',text:'部分检查证据过大，已截断保留内容'}));
      pane.append(renderCheckResults(entry.details.checkResult, { secrets: entry.details.request?.secrets || [], environmentId: run.environmentId }));
      return;
    }
    if (view === 'request') {
      if (entry.details.requestTruncated) pane.append(el('p', { class: 'run-detail-notice', text: '请求过大，部分内容仅保留前 262,144 个字符' }));
      pane.append(openRequestPreview({ protocol: 'http', previewSection: 'headers' }, entry.details.request, { embedded: true, frozen: true }));
      return;
    }
    const response = entry.details.response;
    if (!response) {
      pane.append(el('div', { class: 'preview-empty', text: entry.pending ? '正在等待响应…' : entry.error || '没有收到响应' }));
      return;
    }
    if (response.error) pane.append(el('p', { class: 'run-detail-error', text: response.error }));
    if (response.truncated || entry.details.responseTruncated) pane.append(el('p', { class: 'run-detail-notice', text: '响应已截断，以下为保留内容；原始大小见执行摘要' }));
    if (response.note) pane.append(el('p', { class: 'run-detail-notice', text: response.note }));
    const responseTabs = segmented([['body', 'Body'], ['headers', `Headers ${(response.headers || []).length}`], ['cookies', `Cookies ${(response.setCookies || []).length}`]], responseView, value => { responseView = value; drawPane(); });
    const controls = el('div', { class: 'run-detail-toolbar' }, [responseTabs]);
    pane.append(controls);
    if (responseView === 'headers') pane.append(table(['名称', '值'], (response.headers || []).map(row => [row.name, row.value])));
    else if (responseView === 'cookies') pane.append(table(['Set-Cookie'], (response.setCookies || []).map(value => [value])));
    else {
      const raw = response.isText === false ? response.bodyBase64 || '' : response.bodyText || '';
      let text = raw;
      if (pretty && response.isText !== false) { try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch {} }
      controls.append(el('div', { class: 'btn-row' }, [
        response.isText === false ? el('span', { class: 'faint', text: 'Base64' }) : segmented([['pretty', 'Pretty'], ['raw', 'Raw']], pretty ? 'pretty' : 'raw', value => { pretty = value === 'pretty'; drawPane(); }),
        el('button', { class: 'btn sm', onclick: () => copy(text, '已复制响应内容'), disabled: !raw }, [icon('copy'), '复制']),
      ]));
      pane.append(raw ? el('pre', { class: 'run-detail-code', text }) : el('div', { class: 'preview-empty', text: '空响应体' }));
    }
  };
  const draw = () => {
    dialog.box.querySelector('.modal-head h2').textContent = `${index + 1}. ${entry.name} · 执行详情`;
    const response = entry.details?.response;
    let url = response?.finalUrl || entry.url;
    for (const secret of entry.details?.request?.secrets || []) url = url.split(secret).join('••••••••');
    meta.replaceChildren(
      el('div', { class: 'run-detail-summary' }, [
        el('span', { class: `badge method-${(entry.method || 'GET').toLowerCase()}`, text: entry.method || 'GET' }),
        el('span', { class: entry.error ? 'run-detail-error' : '', text: entry.pending ? '执行中' : entry.skipped ? '跳过' : entry.status ? `${entry.status} ${response?.statusText || ''}` : entry.errorKind || '未发送' }),
        el('span', { text: duration(entry.timeMs) }), el('span', { text: bytes(entry.sizeBytes) }),
        el('span', { text: response?.contentType || '' }),
      ]),
      el('code', { class: 'run-detail-url', text: url }),
      el('span', { class: 'faint', text: `${run.runnerName} · ${new Date(entry.at).toLocaleString('zh-CN', { hour12: false })}` }),
    );
    nav.replaceChildren(
      el('button', { class: 'btn sm', 'aria-label': '上一个请求', disabled: index === 0, onclick: () => move(-1) }, [icon('chevU')]),
      el('span', { class: 'faint', text: `${index + 1} / ${run.entries.length}` }),
      el('button', { class: 'btn sm', 'aria-label': '下一个请求', disabled: index === run.entries.length - 1, onclick: () => move(1) }, [icon('chevD')]),
      openDefinition ? el('button', { class: 'btn sm ghost', text: '打开当前定义', onclick: () => { dialog.close(); openDefinition(entry); } }) : null,
    );
    // Recreate the switch when navigating so its selected state matches the pane.
    const nextTabs = segmented(sections(), view, value => { view = value; drawPane(); });
    tabs.replaceWith(nextTabs); tabs = nextTabs;
    drawPane();
  };
  const switchHost = el('div', { class: 'run-detail-toolbar' }, [tabs, nav]);
  content.append(meta, switchHost, pane);
  const unsubscribe = on('run-entry', updated => { if (updated === entry) { if (entry.details?.response) view = 'response'; draw(); } });
  dialog = modal({ title: '执行详情', width: 980, body: [content], cancelText: '', onClose: () => {
    unsubscribe();
    requestAnimationFrame(() => [...document.querySelectorAll('.run-entry')].find(row => row.dataset.run === run.id && Number(row.dataset.entryIndex) === index)?.focus({ preventScroll: true }));
  } });
  dialog.box.classList.add('run-detail-dialog');
  draw();
}
