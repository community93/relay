import { el, icon, modal } from './ui.js';
import { selectField } from './menu.js';
import { state, activeTab, activeEnv, collectionOf, kv, touch } from './state.js';

const BUILTINS = [
  ['$guid', '随机 ID'], ['$timestamp', 'Unix 时间戳'], ['$isoTimestamp', 'ISO 时间'],
  ['$randomInt', '随机整数'], ['$randomEmail', '随机邮箱'],
];
let installed = false;
// The same picker serves native fields and code editors. Keep scope precedence,
// secret masking and variable creation in one place.
const editors = new WeakMap();
export function registerVariableEditor(field, adapter) {
  editors.set(field, adapter);
  return () => editors.delete(field);
}

function context() {
  const tab = activeTab();
  return {
    env: tab?.kind === 'env' ? state.environments.find(item => item.id === tab.refId) : activeEnv(),
    collection: tab?.refId ? collectionOf(tab.refId) : null,
  };
}

function candidates(ctx) {
  const values = new Map();
  const add = (list, source, label) => {
    for (const item of list || []) {
      const key = String(item.key || '').trim();
      if (key && item.enabled !== false) values.set(key, { key, value: String(item.value ?? ''), source, label });
    }
  };
  add(state.globals, 'global', '全局');
  if (ctx.collection) add(ctx.collection.variables, 'collection', ctx.collection.name);
  if (ctx.env) {
    add(ctx.env.variables, 'environment', ctx.env.name);
    if (ctx.env.defaults?.baseUrl) for (const key of ['baseUrl', 'base_url']) {
      values.set(key, { key, value: ctx.env.defaults.baseUrl.replace(/\/+$/, ''), source: 'environment', label: ctx.env.name });
    }
  }
  for (const [key, value] of BUILTINS) values.set(key, { key, value, source: 'builtin', label: '动态' });
  return [...values.values()];
}

function tokenAt(field) {
  const source = editors.get(field) || field;
  const end = source.selectionStart;
  if (end === null || end !== source.selectionEnd) return null;
  const match = /(?<!\{)\{{1,2}([\w$.-]*)$/.exec(source.value.slice(0, end));
  if (!match) return null;
  if(field.dataset.variableSyntax==='json'&&!match[0].startsWith('{{')) {
    let quoted=false,escaped=false;
    for(const ch of source.value.slice(0,match.index)) {
      if(escaped){escaped=false;continue;}
      if(ch==='\\'){escaped=true;continue;}
      if(ch==='"')quoted=!quoted;
    }
    if(!quoted)return null;
  }
  const tail = source.value.slice(end);
  const closing = /^(?:[\w$.-]*\}{1,2})/.exec(tail) || /^\}{1,2}/.exec(tail);
  return { start: match.index, end: end + (closing ? closing[0].length : 0), query: match[1] };
}

function eligible(field) {
  if (editors.has(field)) return field.isConnected && field.dataset.variables !== 'false';
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? !field.readOnly && !field.disabled && field.dataset.variables !== 'false'
      && (field.dataset.variables === 'true' || field.matches('.url-input, .kv-value, input.mono, textarea.mono, .editor textarea'))
      && (!field.type || ['text', 'search', 'password', 'textarea'].includes(field.type))
    : false;
}

// Mirror only while opening the picker; wrapping and horizontal scroll match
// the real input, including the body editor's current line.
function caretRect(field) {
  if (editors.has(field)) return editors.get(field).caretRect();
  const style = getComputedStyle(field), rect = field.getBoundingClientRect();
  const mirror = el('div', { class: 'variable-caret-mirror' });
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'wordBreak', 'overflowWrap', 'tabSize']) mirror.style[key] = style[key];
  mirror.style.width = `${field.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
  mirror.style.whiteSpace = field.tagName === 'INPUT' ? 'pre' : 'pre-wrap';
  mirror.textContent = field.value.slice(0, field.selectionStart);
  const marker = el('span', { text: field.value.slice(field.selectionStart) || '\u200b' });
  mirror.append(marker);document.body.append(mirror);
  const point = marker.getBoundingClientRect(), base = mirror.getBoundingClientRect();
  const x = rect.left + point.left - base.left - field.scrollLeft;
  const y = rect.top + point.top - base.top - field.scrollTop;
  mirror.remove();
  return { x: Math.max(rect.left, Math.min(x, rect.right - 8)), y: Math.max(rect.top, Math.min(y, rect.bottom - 16)), height: parseFloat(style.lineHeight) || 18 };
}

export function installVariableCompletion() {
  if (installed) return;
  installed = true;
  let owner = null, popup = null, token = null, options = [], index = 0, composing = false;
  let originalAria = null;
  const close = () => {
    popup?.remove();popup = null;
    if (owner && originalAria) for (const [key, value] of Object.entries(originalAria)) {
      if (value === null) owner.removeAttribute(key);else owner.setAttribute(key, value);
    }
    owner = null;originalAria = null;
  };
  const insert = (field, range, key) => {
    close();
    if (!field.isConnected) return;
    field.focus();
    const editor=editors.get(field);
    (editor || field).setRangeText(`{{${key}}}`, range.start, range.end, 'end');
    if(!editor)field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const select = (position) => {
    index = position;
    popup.querySelectorAll('[role=option]').forEach((row, i) => row.setAttribute('aria-selected', String(i === index)));
    const selected = popup.querySelector(`[data-choice="${index}"]`);
    owner.setAttribute('aria-activedescendant', selected.id);
    const list = selected.parentElement;
    if (list.classList.contains('variable-picker-list')) {
      const top = selected.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + selected.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + selected.offsetHeight - list.clientHeight;
    }
  };
  const create = (field, range, ctx) => {
    close();
    const scopes = [
      ctx.env && { value: 'environment', label: ctx.env.name, hint: '环境' },
      ctx.collection && { value: 'collection', label: ctx.collection.name, hint: '集合' },
      { value: 'global', label: '全局', hint: '' },
    ].filter(Boolean);
    let scope = scopes[0].value, savedKey = null;
    const name = el('input', { class: 'input mono', value: range.query, placeholder: 'accessToken', dataset: { variables: 'false' }, 'aria-label': '变量名' });
    const value = el('textarea', { class: 'textarea mono', rows: 3, placeholder: '值', 'aria-label': '变量值' });
    const error = el('span', { class: 'variable-form-error', role: 'alert' });
    modal({
      title: '新建变量', width: 460, okText: '创建并插入',
      body: [el('div', { class: 'variable-form' }, [
        el('div', { class: 'field' }, [el('label', { text: '保存到' }), selectField({ value: scope, options: scopes, onChange: next => { scope = next; } })]),
        el('div', { class: 'field' }, [el('label', { text: '变量名' }), name]),
        el('div', { class: 'field' }, [el('label', { text: '值' }), value]), error,
      ])],
      onMount: () => { setTimeout(() => {name.focus();name.select();}, 40); },
      onOk: () => {
        const key = name.value.trim();
        if (!/^[\w.-]+$/.test(key)) {error.textContent = '使用字母、数字、下划线、点或连字符';name.focus();return false;}
        const target = scope === 'environment' ? ctx.env : scope === 'collection' ? ctx.collection : state;
        const prop = scope === 'global' ? 'globals' : 'variables';
        const list = target[prop] || (target[prop] = []);
        if (list.some(item => String(item.key).trim() === key)) {error.textContent = '此作用域已有同名变量';name.focus();return false;}
        list.push(kv(key, value.value));
        touch(scope === 'environment' ? 'environments' : scope === 'collection' ? 'collections' : 'settings');
        savedKey = key;
      },
      // Wait for the dialog's focus restoration, then restore the insertion point.
      onClose: () => {if (savedKey) setTimeout(() => insert(field, range, savedKey), 200);},
    });
  };
  const accept = () => {
    const field = owner, range = token, choice = options[index];
    if (choice.create) create(field, range, context());else insert(field, range, choice.key);
  };
  const open = (field) => {
    const range = eligible(field) && tokenAt(field);
    if (!range || composing || !field.isConnected) {close();return;}
    const same = field === owner && token?.query === range.query;
    close();owner = field;token = range;
    const query = range.query.toLowerCase(), rank = { environment: 0, collection: 1, global: 2, builtin: 3 };
    options = candidates(context()).filter(item => item.key.toLowerCase().includes(query)).sort((a, b) => Number(!a.key.toLowerCase().startsWith(query)) - Number(!b.key.toLowerCase().startsWith(query)) || rank[a.source] - rank[b.source] || a.key.localeCompare(b.key));
    options.push({ create: true });
    index = same ? Math.min(index, options.length - 1) : 0;
    popup = el('div', { class: 'variable-picker', id: 'variable-picker', role: 'listbox', 'aria-label': '变量补全' }, [
      el('div', { class: 'variable-picker-head' }, [icon('braces'), el('span', { text: '变量' }), el('span', { class: 'variable-picker-total', text: String(options.length - 1) })]),
      el('div', { class: 'variable-picker-list' }, options.slice(0, -1).map((item, i) => {
        const sensitive = /token|secret|password|credential/i.test(item.key);
        return el('div', { class: 'variable-option', role: 'option', id: `variable-choice-${i}`, dataset: { choice: i }, 'aria-selected': i === index }, [
          el('span', { class: 'variable-option-mark', text: '{}' }),
          el('div', { class: 'variable-option-text' }, [el('code', { text: item.key }), el('span', { class: 'variable-option-value', text: sensitive && item.value ? '••••••••' : item.value || '空值' })]),
          el('span', { class: `variable-source ${item.source}`, text: item.label }),
        ]);
      })),
      options.length === 1 ? el('div', { class: 'variable-no-match', text: '无匹配变量' }) : null,
      el('div', { class: 'variable-create', role: 'option', id: `variable-choice-${options.length - 1}`, dataset: { choice: options.length - 1 }, 'aria-selected': index === options.length - 1 }, [icon('plus'), el('span', { text: range.query ? `新建 ${range.query}` : '新建变量' }), el('kbd', { text: '↵' })]),
    ]);
    popup.addEventListener('pointerdown', event => {event.preventDefault();const row = event.target.closest('[data-choice]');if (row) {index = Number(row.dataset.choice);accept();}});
    popup.addEventListener('pointermove', event => {const row = event.target.closest('[data-choice]');if (row && Number(row.dataset.choice) !== index) select(Number(row.dataset.choice));});
    originalAria = Object.fromEntries(['role', 'aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant'].map(key => [key, field.getAttribute(key)]));
    field.setAttribute('role', 'combobox');field.setAttribute('aria-autocomplete', 'list');field.setAttribute('aria-expanded', 'true');field.setAttribute('aria-controls', popup.id);
    document.body.append(popup);
    const point = caretRect(field), width = Math.min(360, innerWidth - 24);
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(12, Math.min(point.x, innerWidth - width - 12))}px`;
    const height = popup.offsetHeight, below = point.y + point.height + 9;
    popup.style.top = `${Math.max(12, below + height < innerHeight - 12 ? below : point.y - height - 9)}px`;
    select(index);
  };
  document.addEventListener('input', event => {
    if (composing || event.isComposing) return;
    // KV ghost rows replace their field during the input event.
    queueMicrotask(() => {const field = document.activeElement;if (eligible(field)) open(field);else close();});
  });
  document.addEventListener('keydown', event => {
    if (!popup || event.target !== owner || composing || event.isComposing) return;
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) {if (event.ctrlKey || event.metaKey || event.altKey) close();return;}
    event.preventDefault();event.stopImmediatePropagation();
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') select((index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    else if (event.key === 'Tab' && event.shiftKey) close();else accept();
  }, true);
  document.addEventListener('click', event => {
    const field=event.target.closest?.('.cm-content') || event.target;
    if (eligible(field)) open(field);
  });
  document.addEventListener('pointerdown', event => {if (popup && event.target !== owner && !popup.contains(event.target)) close();}, true);
  document.addEventListener('focusout', () => {queueMicrotask(() => {if (owner && document.activeElement !== owner) close();});});
  document.addEventListener('compositionstart', () => {composing = true;close();});
  document.addEventListener('compositionend', event => {composing = false;queueMicrotask(() => {if (eligible(event.target)) open(event.target);});});
  document.addEventListener('scroll', event => {if (popup && event.target !== popup && !popup.contains(event.target)) close();}, true);
  window.addEventListener('resize', close);window.addEventListener('blur', close);
  new MutationObserver(() => {if (owner && !owner.isConnected) close();}).observe(document.getElementById('root'), { childList: true, subtree: true });
}
