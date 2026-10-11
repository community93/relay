import { el, icon, toast, modal, confirmDialog, copy, segmented, toggle, row, debounce } from './ui.js';
import { renderKvEditor } from './kv.js';
import { state, touch, emit, uid, closeTab, activeEnv, activeTab, newEnvironment } from './state.js';
import { menu } from './menu.js';
import { sortableRow } from './sorting.js';

const COLORS = ['#08645d', '#287047', '#87581d', '#a4363b', '#74518c', '#326995'];

/* ---------------------------- sidebar list ---------------------------- */

export function renderEnvPane(host) {
  host.replaceChildren(
    el('div', { class: 'sidebar-head' }, [
      el('span', { class: 'sidebar-title', text: '环境' }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn icon', title: '全局变量', onclick: () => openGlobals() }, [icon('braces')]),
        el(
          'button',
          {
            class: 'btn icon',
            title: '新建环境',
            onclick: () => {
              const env = newEnvironment(`环境 ${state.environments.length + 1}`);
              state.environments.push(env);
              touch('environments');
              renderEnvPane(host);
              openEnvironment(env);
            },
          },
          [icon('plus')]
        ),
      ]),
    ]),
    el(
      'div',
      { class: 'sidebar-body' },
      state.environments.length
        ? state.environments.map((env) => envRow(env, host))
        : [el('p', { class: 'hint', style: { padding: '10px' }, text: '暂无环境' })]
    )
  );
}

function envRow(env, host) {
  const active = state.settings.activeEnvironmentId === env.id;
  const viewed = !state.overviewPane && activeTab()?.kind === 'env' && activeTab()?.refId === env.id;
  return el(
    'div',
    {
      class: `node ${viewed ? 'selected' : ''}`,
      title: `${env.name} · 打开设置`,
      // same handle as the collection tree: tests and "reveal this row" code
      // should not have to count siblings
      dataset: { env: env.id },
      ...sortableRow('environments', env, () => renderEnvSwitcher(document.getElementById('env-slot'))),
      onclick: () => openEnvironment(env),
      ondblclick: () => startEnvRename(env),
    },
    [
      el('span', { class: 'swatch', style: { background: env.color || COLORS[0] } }),
      editingEnvId === env.id
        ? el('input', {
            class: 'node-rename env-rename',
            value: env.name || '',
            onclick: (event) => event.stopPropagation(),
            ondblclick: (event) => event.stopPropagation(),
            onkeydown: (event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitEnvRename(env, event.target.value, false);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                commitEnvRename(env, env.name, true);
              }
            },
            onblur: (event) => commitEnvRename(env, event.target.value, false),
          })
        : el('span', { class: 'name', text: env.name }),
      el('span', { class: 'count', text: String((env.variables || []).filter((v) => v.enabled !== false && v.key).length) }),
      active ? el('span', { class: 'tag env-in-use' }, [icon('check'), '使用中']) : null,
      el('span', { class: 'node-actions' }, [
        el('button', {
          text: '⋯',
          onclick: (event) => {
            event.stopPropagation();
            menu(
              event.currentTarget,
              [
                { label: '在右侧打开设置', icon: 'gear', onSelect: () => openEnvironment(env) },
                { label: '重命名', icon: 'pencil', onSelect: () => startEnvRename(env) },
                { label: active ? '取消使用此环境' : '设为当前环境', icon: 'check', onSelect: () => setActive(active ? null : env.id) },
                {
                  label: '创建副本',
                  onSelect: () => {
                    const created = JSON.parse(JSON.stringify(env));
                    created.id = uid('env');
                    created.name = `${env.name} 副本`;
                    state.environments.push(created);
                    touch('environments');
                    repaintEnvChrome();
                  },
                },
                {
                  label: '删除',
                  icon: 'trash',
                  danger: true,
                  onSelect: async () => {
                    if (!(await confirmDialog(`删除环境「${env.name}」？未解析的变量会阻止发送。`))) return;
                    const index = state.environments.indexOf(env);
                    if (index >= 0) state.environments.splice(index, 1);
                    if (state.settings.activeEnvironmentId === env.id) state.settings.activeEnvironmentId = null;
                    for (const tab of [...state.tabs]) {
                      if (tab.kind === 'env' && tab.refId === env.id) closeTab(tab.id);
                    }
                    touch('environments');
                    touch('settings');
                    emit('environment');
                    renderEnvPane(host);
                  },
                },
              ],
              { align: 'end' }
            );
          },
        }),
      ]),
    ]
  );
}

/// Switching the active environment is the one action that deserves a full
/// repaint: the top bar, every tab's variable resolution and the list all change.
export function setActive(envId) {
  state.settings.activeEnvironmentId = envId;
  touch('settings');
  emit('environment');
  const host = document.getElementById('sidebar');
  if (state.pane === 'environments' && host) renderEnvPane(host);
  // deliberately does NOT open the environment's tab: choosing which environment
  // a request runs against is a one-gesture act, and the request you were just
  // writing stays on screen with the new variables applied
}

let editingEnvId = null;

/// A name or colour is shown in three places at once — the sidebar list, the
/// top-bar switcher, the tab strip. It is deliberately not shown anywhere in the
/// workspace, so repainting just these three keeps the focus in whatever field
/// the user is typing in (a full `rerender` would rebuild the editor under them).
function repaintEnvChrome() {
  const host = document.getElementById('sidebar');
  if (state.pane === 'environments' && host) renderEnvPane(host);
  renderEnvSwitcher(document.getElementById('env-slot'));
  for (const tab of state.tabs) {
    if (tab.kind !== 'env') continue;
    const env = state.environments.find((item) => item.id === tab.refId);
    if (env) tab.title = env.name || '未命名环境';
  }
  emit('tabs');
}

/// One way to change the name, whichever surface asked for it.
function applyEnvName(env, name) {
  env.name = name;
  touch('environments');
  touch('tabs');
  repaintEnvChrome();
}

function startEnvRename(env) {
  editingEnvId = env.id;
  const host = document.getElementById('sidebar');
  if (state.pane !== 'environments') {
    state.pane = 'environments';
    emit('pane');
  } else if (host) {
    renderEnvPane(host);
  }
  setTimeout(() => {
    const input = document.getElementById('sidebar') && document.querySelector('#sidebar .env-rename');
    if (input) {
      input.focus();
      input.select();
    }
  }, 0);
}

function commitEnvRename(env, value, cancelled) {
  if (editingEnvId !== env.id) return;
  editingEnvId = null;
  const name = String(value || '').trim();
  if (!cancelled && name && name !== env.name) {
    applyEnvName(env, name);
    return;
  }
  const host = document.getElementById('sidebar');
  if (state.pane === 'environments' && host) renderEnvPane(host);
}

/* ---------------------------- right-side tab ---------------------------- */
export function openEnvironment(env) {
  const existing = state.tabs.find((tab) => tab.kind === 'env' && tab.refId === env.id);
  if (existing) {
    state.activeTabId = existing.id;
  } else {
    state.tabs.push({
      id: uid('tab'),
      kind: 'env',
      protocol: 'env',
      refId: env.id,
      title: env.name,
      draft: { name: '', method: 'GET', url: '', params: [], headers: [], body: null, settings: {} },
      dirty: false,
      response: null,
      stream: null,
      running: null,
      view: 'params',
      responseView: 'body',
    });
    state.activeTabId = state.tabs[state.tabs.length - 1].id;
  }
  emit('tabs', { activate: true });
  emit('rerender');
  touch('tabs');
}

/// Kept so older call sites keep working; the modal editor became the tab.
export function openEnvEditor(env) {
  openEnvironment(env);
}

export function renderEnvTab(tab) {
  const env = state.environments.find((item) => item.id === tab.refId);
  if (!env) {
    return el('div', { class: 'pane-scroll' }, [
      el('div', { class: 'empty' }, [el('h3', { text: '环境已删除' })]),
    ]);
  }
  env.defaults = env.defaults || {};
  env.variables = env.variables || [];
  env.defaults.headers = env.defaults.headers || [];
  const isActive = state.settings.activeEnvironmentId === env.id;

  const wrap = el('div', { class: 'pane-scroll' });
  const go = (node) => node.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Text edits only refresh the summary rows; a full repaint would steal focus.
  const persist = () => {
    touch('environments');
    syncSummary();
  };

  const varsHost = el('div');
  renderKvEditor(varsHost, env.variables, { labels: ['变量名', '值'], title: '环境变量', onChange: persist });
  const headsHost = el('div');
  renderKvEditor(headsHost, env.defaults.headers, { labels: ['Header', '值'], title: '预填请求头', onChange: persist });
  const chips = el('div', { class: 'env-chips' });

  const varsGroup = el('div', { class: 'env-kv' }, [varsHost]);
  const headsGroup = el('div', { class: 'env-kv' }, [headsHost]);
  const bodyGroup = el('div', { class: 'body-extras' });

  const baseUrl = el('input', {
    class: 'input mono',
    value: env.defaults.baseUrl || '',
    placeholder: 'https://api.example.com/v1',
    oninput: (event) => {
      env.defaults.baseUrl = event.target.value.trim();
      persist();
    },
  });

  const prefixNote = el('div', { class: 'group-foot' });
  const PREFIX_NOTE = {
    prefill: '新建 URL：{{baseUrl}}/',
    auto: '/path → {{baseUrl}}/path',
    off: 'URL 不变',
  };
  const syncPrefixNote = (value) => {
    prefixNote.textContent = PREFIX_NOTE[value] || '';
  };
  syncPrefixNote(env.defaults.urlPrefixMode || 'prefill');

  const bodyLangRow = el('div');
  const bodyArea = el('textarea', {
    class: 'textarea mono',
    rows: 6,
    value: env.defaults.bodyContent || '',
    placeholder: '{\n  "channel": "{{channel}}"\n}',
    oninput: (event) => {
      env.defaults.bodyContent = event.target.value;
      persist();
    },
  });
  const bodyStack = el('div', { class: 'row-stack' }, [el('span', { class: 'row-label faint', text: 'Body 内容' }), bodyArea]);

  function syncBodyExtras() {
    const mode = env.defaults.bodyMode || 'none';
    if (mode !== 'raw') {
      bodyGroup.replaceChildren();
      return;
    }
    bodyLangRow.replaceChildren(
      row(
        'raw 语言',
        segmented(
          [['json', 'JSON'], ['text', 'Text'], ['xml', 'XML'], ['html', 'HTML']],
          env.defaults.bodyLanguage || 'json',
          (value) => {
            env.defaults.bodyLanguage = value;
            touch('environments');
            syncSummary();
          }
        )
      )
    );
    bodyGroup.replaceChildren(bodyLangRow, bodyStack);
  }

  const summary = el('div', { class: 'group env-summary' });
  function syncSummary() {
    const enabled = (env.variables || []).filter((v) => v.enabled !== false && v.key);
    const heads = (env.defaults.headers || []).filter((h) => h.enabled !== false && h.key);
    const mode = env.defaults.bodyMode || 'none';
    summary.replaceChildren(
      el('div', { class: 'group-head', text: '概览' }),
      el('div', { class: 'row' }, [
        el('div', { class: 'row-label', text: '启用此环境' }),
        el('div', { class: 'row-value' }, [toggle(isActive, (on) => setActive(on ? env.id : null), '启用此环境')]),
      ]),
      infoRow('变量', enabled.length ? `${enabled.length} 个生效` : '未设置', () => go(varsGroup)),
      infoRow('预填请求头', heads.length ? `${heads.length} 个${env.defaults.alwaysOnHeaders ? ' · 每次附加' : ''}` : '未设置', () => go(headsGroup)),
      infoRow(
        '预填 Body',
        env.defaults.prefillBody && mode !== 'none'
          ? `${mode === 'raw' ? (env.defaults.bodyLanguage || 'json').toUpperCase() : mode} · ${(env.defaults.bodyContent || '').length} 字符`
          : '不预填',
        () => go(bodyGroup)
      )
    );
    chips.replaceChildren(
      ...(enabled.length
        ? enabled.map((v) =>
            el('button', {
              class: 'chip',
              title: `复制 {{${v.key}}}`,
              text: `{{${v.key}}}`,
              onclick: () => copy(`{{${v.key}}}`, `已复制 {{${v.key}}}`),
            })
          )
        : [])
    );
  }

  const nameInput = el('input', {
    class: 'env-name',
    value: env.name,
    placeholder: '环境名称',
    oninput: (event) => {
      applyEnvName(env, event.target.value);
      tab.dirty = false;
    },
  });

  wrap.append(
    el('div', { class: 'env-hero' }, [
      el('span', { class: 'tag meta', text: 'ENV' }),
      nameInput,
      el('div', { class: 'inline', style: { justifyContent: 'space-between', marginTop: '6px' } }, [
        el(
          'div',
          { class: 'env-swatches' },
          COLORS.map((color) =>
            el('button', {
              class: `swatch ${env.color === color ? 'on' : ''}`,
              style: { background: color },
              title: '环境颜色',
              onclick: (event) => {
                env.color = color;
                touch('environments');
                // move the ring here: repainting the workspace to do it would
                // destroy whichever field the user is typing in
                for (const sibling of event.currentTarget.parentElement.children) {
                  sibling.classList.toggle('on', sibling === event.currentTarget);
                }
                repaintEnvChrome();
              },
            })
          )
        ),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn',
            text: '用此环境新建请求',
            onclick: async () => {
              const { createRequest } = await import('./tree.js');
              if (!isActive) setActive(env.id);
              createRequest(null);
            },
          }),
          el('button', {
            class: 'btn ghost icon',
            title: '更多',
            onclick: (event) =>
              menu(
                event.currentTarget,
                [
                  { label: '复制此环境', icon: 'copy', onSelect: () => duplicate(env) },
                  { separator: true },
                  { label: '删除环境', icon: 'trash', danger: true, onSelect: () => removeEnv(env) },
                ],
                { align: 'end' }
              ),
          }, [icon('dots')]),
        ]),
      ]),
    ]),
    el('div', { class: 'pane' }, [
      summary,
      varsGroup,
      chips,
      el('div', { class: 'group' }, [
        el('div', { class: 'group-head', text: '请求默认值' }),
        row('URL 前缀', baseUrl, { detail: '新建请求时替换 {{baseUrl}}' }),
        segRow('前缀策略', [
          ['prefill', '预填前缀'],
          ['auto', '自动拼接'],
          ['off', '手动'],
        ], env.defaults.urlPrefixMode || 'prefill', (value) => {
          env.defaults.urlPrefixMode = value;
          syncPrefixNote(value);
          touch('environments');
          syncSummary();
        }),
        prefixNote,
      ]),
      headsGroup,
      el('div', { class: 'group' }, [
        el('div', { class: 'group-head', text: 'Body 与附加请求头' }),
        el('div', { class: 'row' }, [
          el('div', { class: 'row-label' }, [
            el('span', { text: '每次发送都附加这些请求头' }),
            el('span', { class: 'row-detail', text: '请求里同名的 header 仍然优先' }),
          ]),
          el('div', { class: 'row-value' }, [
            toggle(!!env.defaults.alwaysOnHeaders, (on) => {
              env.defaults.alwaysOnHeaders = on;
              touch('environments');
              syncSummary();
            }, '每次发送都附加'),
          ]),
        ]),
        segRow('Body 类型', [['none', '不预填'], ['raw', 'raw'], ['urlencoded', 'URL 编码'], ['form', '表单']], env.defaults.bodyMode || 'none', (value) => {
          env.defaults.bodyMode = value;
          touch('environments');
          syncBodyExtras();
          syncSummary();
        }),
        el('div', { class: 'row' }, [
          el('div', { class: 'row-label', text: '新建请求带上 Body' }),
          el('div', { class: 'row-value' }, [
            toggle(!!env.defaults.prefillBody, (on) => {
              env.defaults.prefillBody = on;
              touch('environments');
              syncSummary();
            }, '新建请求带上 Body'),
          ]),
        ]),
        bodyGroup
      ]),
    ])
  );

  syncBodyExtras();
  syncSummary();
  return wrap;
}

function segRow(label, options, current, onChange) {
  return el('div', { class: 'row seg-row' }, [
    el('div', { class: 'row-label', text: label }),
    segmented(options, current, onChange, { grow: true }),
  ]);
}

function infoRow(label, value, onOpen) {
  return el('div', { class: 'row', style: { cursor: 'pointer' }, onclick: onOpen }, [
    el('div', { class: 'row-label', text: label }),
    el('div', { class: 'row-value' }, [el('span', { text: value }), el('span', { class: 'disclosure' }, [icon('chevR')])]),
  ]);
}

function duplicate(env) {
  const created = JSON.parse(JSON.stringify(env));
  created.id = uid('env');
  created.name = `${env.name} 副本`;
  state.environments.push(created);
  touch('environments');
  // `environment` alone would refresh the switcher but leave the sidebar list
  // without the new row
  repaintEnvChrome();
  openEnvironment(created);
}

async function removeEnv(env) {
  const message = `删除「${env.name}」？引用它的请求不会报错，变量会被替换成空值。`;
  if (!(await confirmDialog(message))) return;
  const index = state.environments.indexOf(env);
  if (index >= 0) state.environments.splice(index, 1);
  if (state.settings.activeEnvironmentId === env.id) state.settings.activeEnvironmentId = null;
  for (const tab of [...state.tabs]) {
    if (tab.kind === 'env' && tab.refId === env.id) closeTab(tab.id);
  }
  touch('environments');
  touch('settings');
  emit('environment');
}

/* ---------------------------- top bar switcher ---------------------------- */

/// A navigation title that opens a list, not a native select popup.
export function renderEnvSwitcher(host) {
  const env = activeEnv();
  const button = el(
    'button',
    {
      class: 'btn sm ghost env-switcher',
      title: env ? `当前环境：${env.name}` : '选择环境',
      onclick: (event) =>
        menu(
          event.currentTarget,
          [
            ...state.environments.map((item) => ({
              label: item.name,
              icon: state.settings.activeEnvironmentId === item.id ? 'check' : null,
              onSelect: () => setActive(item.id),
              sideTitle: `打开 ${item.name} 的设置`,
              onSide: () => openEnvironment(item),
            })),
            state.environments.length ? { separator: true } : null,
            { label: '不使用环境', onSelect: () => setActive(null) },
            {
              label: '管理环境',
              icon: 'env',
              onSelect: () => {
                state.pane = 'environments';
                renderEnvPane(document.getElementById('sidebar'));
              },
            },
          ].filter(Boolean),
          { align: 'end' }
        ),
    },
    [
      el('span', { class: 'swatch', style: { background: env ? env.color || COLORS[0] : 'var(--line-strong)' } }),
      el('span', { class: 'env-switcher-label', text: env ? env.name : '无环境', title: env ? env.name : '无环境' }),
      icon('chevD'),
    ]
  );
  host.replaceChildren(button);
  return button;
}

/* ---------------------------- global variables ---------------------------- */

export function openGlobals() {
  const host = el('div');
  state.globals = state.globals || [];
  // 改一个全局变量，正在开着的那条请求就该立刻按新值解析 —— 不该等到按「完成」。
  // 防抖是因为 renderKvEditor 每敲一个字就回调一次。
  const live = debounce(() => emit('environment'), 260);
  modal({
    title: '全局变量',
    width: 760,
    body: [host, el('p', { class: 'hint', text: '环境 > 集合 > 全局' })],
    cancelText: '',
    okText: '完成',
    onOk: () => {
      touch('settings');
      emit('environment');
    },
  });
  renderKvEditor(host, state.globals, {
    labels: ['变量名', '值'],
    description: true,
    onChange: () => {
      touch('settings');
      live();
    },
  });
}
