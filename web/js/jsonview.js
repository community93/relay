import { el, copy, icon } from './ui.js';

/// Collapsible JSON tree with per-node "copy value" and "copy path". The point is
/// to grab a value buried a few levels down without hand-editing the raw text.

const MAX_DEPTH_ON_OPEN = 2;

export function renderJsonView(host, text, {expandedPaths=null,restore=false,onExtract=null}={}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    host.replaceChildren(
      el('div', { class: 'empty', style: { height: 'auto', padding: '20px' } }, [
        el('h3', { text: '不是合法 JSON，无法展开成树' }),
        el('p', { text: `${error.message}。可以切到 Raw 看原文。` }),
      ])
    );
    return;
  }

  const list = el('div', { class:'json-tree-list' });
  const all = [];
  list.appendChild(build('$', data, 0, all, '$', true,{expandedPaths,restore,onExtract}));

  const expand = (open) => {
    for (const row of all) {
      if (row.container) {
        row.setOpen(open);
      }
    }
  };

  host.replaceChildren(
    el('div', { class: 'inline json-tree-tools' }, [
      el('button', { class: 'btn sm', text: '全部展开', onclick: () => expand(true) }),
      el('button', { class: 'btn sm', text: '全部收起', onclick: () => expand(false) }),
    ]),
    list
  );
}

function pathFor(parentPath, key, isIndex) {
  if (isIndex) return `${parentPath}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parentPath}.${key}` : `${parentPath}[${JSON.stringify(key)}]`;
}

function preview(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > 120 ? `${value.slice(0, 120)}…` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length})`;
  return `{${Object.keys(value).length}}`;
}

function node(key, value, depth, registry, root) {
  const path = root ? '$' : pathFor('', key, false);
  return build(key, value, depth, registry, path, root);
}

function build(key, value, depth, registry, path, isRoot, expansion={}) {
  const isObject = value !== null && typeof value === 'object';
  const row = el('div', { class:'json-tree-row',style: { paddingLeft: `${depth * 16}px` } });
  const childrenHost = el('div');
  const entries = isObject ? (Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value)) : [];

  const setOpen = (open) => {
    if(expansion.expandedPaths){if(open)expansion.expandedPaths.add(path);else expansion.expandedPaths.delete(path);}
    twist.textContent = open ? '▾' : '▸';
    childrenHost.style.display = open ? '' : 'none';
    if (open && !childrenHost.dataset.built) {
      childrenHost.dataset.built = '1';
      for (const [childKey, childValue] of entries) {
        const childPath = Array.isArray(value) ? pathFor(path, childKey, true) : pathFor(path, childKey, false);
        childrenHost.appendChild(build(childKey, childValue, depth + 1, registry, childPath, false,expansion));
      }
    }
  };

  const twist = el('span', {
    class: 'twist',
    style: { width: '12px', color: 'var(--text-faint)', cursor: isObject ? 'pointer' : 'default' },
    text: isObject ? '▸' : '·',
    onclick: () => isObject && setOpen(childrenHost.style.display === 'none'),
  });

  row.appendChild(twist);
  if (!isRoot) {
    row.appendChild(
      el('span', {
        style: { color: 'var(--accent)', cursor: 'pointer' },
        text: typeof key === 'number' ? `[${key}]` : key,
        title: '复制键名',
        onclick: () => copyText(String(key), '已复制键名'),
      })
    );
    row.appendChild(el('span', { style: { color: 'var(--text-faint)' }, text: ':' }));
  }
  row.appendChild(
    el('span', {
      style: { color: typeof value === 'string' ? 'var(--ok)' : typeof value === 'number' ? 'var(--warn)' : 'var(--text-dim)', cursor: 'pointer', maxWidth: '52vw', overflow: 'hidden', textOverflow: 'ellipsis' },
      text: preview(value),
      title: typeof value === 'string' ? value : undefined,
      onclick: () => copyText(stringify(value), '已复制该节点的值'),
    })
  );
  row.appendChild(
    el('span', { class: 'right json-tree-actions' }, [
      el('button', { class: 'btn ghost sm', title: `复制 ${path}`, onclick: () => copyText(stringify(value), '已复制该节点的值') },[icon('copy'),'复制值']),
      el('button', { class: 'btn ghost sm', title: path, onclick: () => copyText(path, `已复制 ${path}`) },[icon('code'),'复制路径']),
      expansion.onExtract ? el('button', { class: 'btn ghost sm', title: '提取为运行变量', onclick: () => expansion.onExtract(path, key) }, [icon('braces'), '提取']) : null,
    ])
  );

  const container = { container: isObject, setOpen };
  registry.push(container);
  const wrapper = el('div', {}, [row, childrenHost]);
  if (isObject) {
    setOpen(expansion.restore?expansion.expandedPaths?.has(path):depth < MAX_DEPTH_ON_OPEN);
  }
  return wrapper;
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function copyText(text, message) {
  copy(text, message);
}

/// Array-of-objects → CSV, which is what a data-analysis user usually wants next.
export function toCsv(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return null;
  }
  // Real APIs wrap the result ("data.items"), so search the whole tree and use
  // the biggest array of objects we can find.
  const candidates = [];
  const walk = (value, depth) => {
    if (depth > 6 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (value.length && value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) candidates.push(value);
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(data, 0);
  const rows = candidates.sort((a, b) => b.length - a.length)[0] || null;
  if (!rows) return null;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  return ['\ufeff' + columns.join(','), ...rows.map((row) => columns.map((column) => cell(row?.[column])).join(','))].join('\n');
}
