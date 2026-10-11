import { el, icon, modal, toast, pickFile, fileMeta, bytes as fmtBytes } from './ui.js';
import { selectField } from './menu.js';
import { kv, uid } from './state.js';

/// A value this long is clipped by the row, and any value with a newline cannot
/// be shown in an `<input>` at all — both cases get the "换行" affordance.
const WRAP_AT = 44;
function needsWrap(value) {
  const text = String(value || '');
  return text.length >= WRAP_AT || text.includes('\n');
}

/* ---------- text → rows ---------- */

/// Turns whatever a user pastes (DevTools header dump, query string, full URL,
/// JSON body, plain `k=v` lines) into key/value rows.
export function parsePairs(text, mode = 'params') {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const out = [];
  const push = (key, value) => {
    const k = String(key || '').trim();
    if (!k) return;
    out.push({ key: k, value: String(value ?? '').trim() });
  };

  if (raw.startsWith('{')) {
    try {
      const doc = JSON.parse(raw);
      for (const [key, value] of Object.entries(doc)) {
        push(key, value && typeof value === 'object' ? JSON.stringify(value) : value);
      }
      return out;
    } catch (error) {
      /* fall through to the line parser */
    }
  }

  const looksLikeQuery = !raw.includes('\n') && raw.includes('=') && (raw.includes('&') || raw.includes('?') || raw.includes('://'));
  if (looksLikeQuery) {
    const query = raw.includes('?') ? raw.slice(raw.lastIndexOf('?') + 1) : raw;
    for (const pair of query.split('&')) {
      if (!pair) continue;
      const [key, ...rest] = pair.split('=');
      push(decode(key), decode(rest.join('=')));
    }
    return out;
  }

  for (const line of raw.split(/\r?\n/)) {
    const text2 = line.trim();
    if (!text2 || text2.startsWith('#') || text2.startsWith('//')) continue;
    if (text2.includes('?') && text2.includes('://')) {
      const query = text2.slice(text2.lastIndexOf('?') + 1);
      for (const pair of query.split('&')) {
        const [key, ...rest] = pair.split('=');
        push(decode(key), decode(rest.join('=')));
      }
      continue;
    }
    const separator = mode === 'headers' || text2.includes(': ') && !text2.includes('=') ? ':' : '=';
    const index = text2.indexOf(separator);
    if (index < 0) {
      push(text2, '');
      continue;
    }
    push(text2.slice(0, index), text2.slice(index + 1));
  }
  return out;
}

function decode(text) {
  try {
    return decodeURIComponent(String(text || '').replace(/\+/g, ' '));
  } catch (error) {
    return String(text || '');
  }
}

export function rowsToText(list, mode = 'params') {
  return (list || [])
    .filter((item) => item.key)
    .map((item) => (mode === 'headers' ? `${item.key}: ${item.value}` : `${item.key}=${item.value}`))
    .join('\n');
}

/* ---------- editor ---------- */

/// Reusable key/value table (params, headers, env variables, form fields).
/// `list` is owned by the caller and mutated in place so the ghost row can stay
/// mounted while the user types.
export function renderKvEditor(host, list, options = {}) {
  const {
    labels = ['键', '值'],
    description = false,
    types = false,
    mono = true,
    mode = 'params',
    title = '',
    foot = '',
    actions = [],
    onChange = () => {},
    onCommit = null,
  } = options;

  const grid = [
    '30px',
    '1fr',
    '1.5fr',
    types ? '86px' : null,
    description ? '1fr' : null,
    '26px',
  ]
    .filter(Boolean)
    .join(' ');

  const rows = el('div', { class: 'kv-rows' });
  let ghostNode;

  const makeRow = (entry, { ghost = false } = {}) => {
    const keyInput = el('input', {
      dataset: { variables: 'false' },
      class: mono ? 'mono' : '',
      placeholder: ghost ? '添加一行…' : '',
      value: ghost ? '' : entry.key,
      spellcheck: 'false',
      onpaste: (event) => handlePaste(event, entry, ghost),
      oninput: (event) => {
        if (ghost) {
          if (!event.target.value) return;
          const created = materialise(event.target.value);
          event.target.value = '';
          const rowNode = makeRow(created);
          rows.insertBefore(rowNode, ghostNode);
          // caret stays on the new row's key cell so typing the name can continue
          const target = rowNode.querySelectorAll('input')[1];
          target.focus();
          onChange();
          commit();
          return;
        }
        entry.key = event.target.value;
        onChange();
        commit();
      },
      onblur: () => {
        if (!ghost) commit();
      },
    });
    const valueInput = el('input', {
      dataset: { variables: 'true' },
      class: mono ? 'mono' : '',
      value: ghost ? '' : entry.value,
      spellcheck: 'false',
      placeholder: ghost ? '' : '',
      onpaste: (event) => handlePaste(event, entry, ghost),
      oninput: (event) => {
        if (!ghost) {
          entry.value = event.target.value;
          syncWrapButton();
          onChange();
          commit();
          return;
        }
        if (!event.target.value) return;
        const created = materialise('');
        created.value = event.target.value;
        event.target.value = '';
        const rowNode = makeRow(created);
        rows.insertBefore(rowNode, ghostNode);
        rowNode.querySelector('[data-variables="true"]').focus();
        onChange();
        commit();
      },
      onblur: () => {
        if (!ghost) commit();
      },
    });
    // a file field is a path the engine reads at send time, so let the native
    // picker supply it and show what it points at
    const fileNote = el('span', { class: 'kv-file-meta' });
    async function showFileMeta(path) {
      if (!path) {
        fileNote.textContent = '';
        fileNote.title = '';
        return;
      }
      const meta = await fileMeta(path);
      if (!meta) return;
      const bad = !!meta.error;
      fileNote.textContent = bad ? '找不到文件' : fmtBytes(meta.size);
      fileNote.title = bad ? meta.error : `${path}\n${fmtBytes(meta.size)}`;
      fileNote.classList.toggle('bad', bad);
    }
    const pickBtn = el('button', {
      class: 'btn sm kv-pick',
      text: '选择',
      title: '挑一个本地文件，按原文件名上传',
      style: { display: entry.kind === 'file' ? '' : 'none' },
      onclick: async () => {
        const path = await pickFile({ defaultPath: entry.value || undefined });
        if (!path) return;
        entry.value = path;
        valueInput.value = path;
        valueArea.value = path;
        onChange();
        commit();
        showFileMeta(path);
      },
    });
    valueInput.addEventListener('blur', () => {
      if (entry.kind === 'file') showFileMeta(entry.value);
    });
    if (types && entry.kind === 'file') showFileMeta(entry.value);
    // An `<input>` can show neither a clipped tail nor an embedded newline, so a
    // value that needs either can swap this cell for a wrapping textarea.
    let wrapped = false;
    const valueArea = el('textarea', {
      class: 'kv-value',
      rows: 3,
      spellcheck: 'false',
      value: ghost ? '' : entry.value,
      oninput: (event) => {
        entry.value = event.target.value;
        valueInput.value = event.target.value;
        onChange();
        commit();
      },
      onblur: () => {
        if (!ghost) commit();
      },
    });
    const wrapBtn = el('button', {
      class: 'kv-wrap',
      type: 'button',
      hidden: true,
      onclick: (event) => {
        event.stopPropagation();
        setWrapped(!wrapped);
      },
    });
    function setWrapped(next) {
      wrapped = !!next && !ghost;
      node.classList.toggle('wrapped', wrapped);
      const control = wrapped ? valueArea : valueInput;
      if (control !== valueCell.firstChild) {
        // `replaceChildren` stringifies null into a visible "null" text node —
        // unlike `el()`, which filters them out
        valueCell.replaceChildren(...[control, types ? pickBtn : null, types ? fileNote : null, wrapBtn].filter(Boolean));
      }
      if (wrapped) valueArea.value = entry.value || '';
      syncWrapButton();
      control.focus();
    }
    function syncWrapButton() {
      wrapBtn.hidden = ghost || (wrapped ? false : !needsWrap(entry.value));
      wrapBtn.textContent = wrapped ? '收起' : '换行';
      wrapBtn.title = wrapped ? '收起为单行编辑' : '换行显示完整内容';
    }
    valueInput.ondblclick = () => setWrapped(true);
    const valueCell = el('div', { class: 'kv-cell' }, [
      valueInput,
      types ? pickBtn : null,
      types ? fileNote : null,
      wrapBtn,
    ]);
    syncWrapButton();
    const cells = [
      el('div', { class: 'kv-cell kv-cell-check' }, [
        ghost
          ? el('span', { class: 'kv-plus', text: '+' })
          : el('input', {
              class: 'check',
              type: 'checkbox',
              checked: entry.enabled !== false,
              onchange: (event) => {
                entry.enabled = event.target.checked;
                node.classList.toggle('off', !event.target.checked);
                onChange();
                commit();
              },
            }),
      ]),
      el('div', { class: 'kv-cell' }, [keyInput]),
      valueCell,
    ];
    if (types) {
      cells.push(
        el('div', { class: 'kv-cell' }, [
          selectField({
            className: 'bare kv-kind',
            disabled: ghost,
            value: entry.kind || 'text',
            options: [
              ['text', '文本'],
              ['file', '文件'],
            ],
            onChange: (next) => {
              entry.kind = next;
              pickBtn.style.display = entry.kind === 'file' ? '' : 'none';
              if (entry.kind === 'file') showFileMeta(entry.value);
              else {
                fileNote.textContent = '';
                fileNote.title = '';
              }
              onChange();
            },
          }),
        ])
      );
    }
    if (description) {
      cells.push(
        el('div', { class: 'kv-cell' }, [
          el('input', {
            class: 'kv-desc',
            value: ghost ? '' : entry.description || '',
            placeholder: ghost ? '' : '说明',
            oninput: (event) => {
              if (ghost) return;
              entry.description = event.target.value;
              onChange();
            },
          }),
        ])
      );
    }
    cells.push(
      el('div', { class: 'kv-cell kv-cell-last' }, [
        ghost
          ? null
          : el('button', {
              class: 'kv-del',
              title: '删除这一行',
              onclick: () => {
                const index = list.indexOf(entry);
                if (index >= 0) list.splice(index, 1);
                node.remove();
                onChange();
                commit();
              },
            }, [icon('close')]),
      ])
    );
    const node = el('div', { class: `kv-row ${ghost ? 'ghost' : ''} ${entry.enabled === false ? 'off' : ''}`, style: { gridTemplateColumns: grid } }, cells.filter(Boolean));
    return node;
  };

  /// Typing into the blank row materialises it and hands the text over.
  function materialise(firstChar) {
    const created = kv('', '');
    list.push(created);
    created.key = firstChar || '';
    return created;
  }

  /// Multi-line / query-string / JSON pastes become several rows at once.
  function handlePaste(event, entry, ghost) {
    const text = event.clipboardData ? event.clipboardData.getData('text') : '';
    const parsed = parsePairs(text, mode);
    const multiline = /[\r\n]/.test(text) || (text.includes('&') && text.includes('=')) || text.trim().startsWith('{');
    if (!multiline || parsed.length < 2) return;
    event.preventDefault();
    if (!ghost && !entry.key && !entry.value) {
      const [first, ...rest] = parsed;
      entry.key = first.key;
      entry.value = first.value;
      appendPairs(rest);
    } else {
      appendPairs(parsed);
    }
    redraw();
    onChange();
    commit();
  }

  function appendPairs(pairs) {
    for (const pair of pairs) {
      list.push({ id: uid('kv'), key: pair.key, value: pair.value, enabled: true, description: '', kind: 'text' });
    }
  }

  function commit() {
    if (onCommit) onCommit();
  }

  function redraw() {
    rows.replaceChildren(headerRow(), ...list.map((entry) => makeRow(entry)), ghostNode || makeRow({}, { ghost: true }));
  }

  function headerRow() {
    const cells = [el('div', { class: 'kv-cell kv-cell-check' }), el('div', { class: 'kv-cell', text: labels[0] }), el('div', { class: 'kv-cell', text: labels[1] })];
    if (types) cells.push(el('div', { class: 'kv-cell', text: '类型' }));
    if (description) cells.push(el('div', { class: 'kv-cell', text: '说明' }));
    cells.push(el('div', { class: 'kv-cell kv-cell-last' }));
    return el('div', { class: 'kv-row kv-head', style: { gridTemplateColumns: grid } }, cells);
  }

  /* ---- bulk editor: paste a whole DevTools dump in one go ---- */
  function openBulk() {
    const area = el('textarea', {
      class: 'textarea mono',
      rows: 12,
      value: rowsToText(list, mode),
      placeholder: mode === 'headers' ? 'Content-Type: application/json\nAuthorization: Bearer xxx' : 'page=1\nsize=20\nkeyword=订单',
    });
    modal({
      title: `批量编辑${title ? ' · ' + title : ''}`,
      width: 720,
      body: [
        el('p', {
          class: 'hint',
          text: mode === 'headers' ? '也可粘 JSON 对象。' : '也可粘一整串 query、完整 URL 或 JSON。',
        }),
        area,
      ],
      okText: '应用',
      onOk: () => {
        const parsed = parsePairs(area.value, mode);
        list.splice(0, list.length, ...parsed.map((pair) => ({ id: uid('kv'), key: pair.key, value: pair.value, enabled: true, description: '', kind: 'text' })));
        redraw();
        onChange();
        commit();
      },
    });
  }

  const bar = el('div', { class: 'kv-bar' }, [
    el('div', { class: 'inline', style: { gap: '6px' } }, [
      title ? el('span', { class: 'kv-title', text: title }) : null,
      ...actions.map((action) =>
        el('button', {
          class: 'btn sm ghost',
          text: action.label,
          title: action.title || '',
          onclick: () => action.onSelect(),
        })
      ),
    ]),
    el('button', {
      class: 'btn sm ghost',
      title: '一次编辑全部',
      text: '批量编辑',
      onclick: openBulk,
    }),
  ]);

  ghostNode = makeRow({}, { ghost: true });
  rows.appendChild(headerRow());
  for (const entry of list) rows.appendChild(makeRow(entry));
  rows.appendChild(ghostNode);
  // the action bar is the card's own header row, so a table never floats under
  // a label that belongs to nothing
  // a caption that belongs to the table lives inside the table's own frame. Left
  // loose under the card it drifted to the bottom of the pane as soon as the card
  // was allowed to fill the half, ending up further from its data than the header.
  host.replaceChildren(
    el('div', { class: 'kv' }, [bar, rows, foot ? el('div', { class: 'kv-foot', text: foot }) : null])
  );
  return { redraw, openBulk, focusLast: () => ghostNode.querySelector('input').focus() };
}
