import { el, icon, toast, modal, debounce, morph, duration, bytes, BRAND_SVG } from './ui.js';
import { presentPane } from './interaction.js';
import { undo, undoState } from './undo.js';
import { applyAppearance, themeMenu } from './themes.js';
import { menu } from './menu.js';
import { installVariableCompletion } from './variables.js';
import { renderSection } from './navigation.js';
import {
  state,
  on,
  emit,
  loadAll,
  touch,
  flushDomain,
  activeTab,
  closeTab,
  activateTab,
  newTab,
  openRequest,
  openRunner,
  titleFor,
  pathTo,
  findNode,
} from './state.js';
import { render as renderTree, setFilter, createCollection, pickAllVisible, clearPick, deletePicked, moveSelected } from './tree.js';
import { renderRequestPane, send, save, switchProtocol, stopEverything, renderInto } from './request.js';
import { renderResponsePane } from './response.js';
import { renderWsPane, toggle as toggleWs, disconnect as disconnectWs, saveWs } from './ws.js';
import { renderEnvPane, renderEnvSwitcher, openEnvEditor, openGlobals, renderEnvTab } from './env.js';
import { renderDocsPane, createDoc, renderDocPane } from './doc.js';
import { renderRunnersPane, renderRunnerTab, startScheduler, createRunner } from './runner.js';
import {
  importCurlDialog,
  importMenu,
  importFormatDialog,
  renderHistoryPane,
  openSettingsDialog,
  openShortcuts,
  openImportFromText,
} from './tools.js';

const RAIL = [
  ['collections', 'collections', '集合'],
  ['runner', 'play', '运行'],
  ['docs', 'file', '文档'],
  ['history', 'history', '历史'],
  ['environments', 'env', '环境'],
];

let requestRatio = 47;
const sectionTabs = new Map();
const sectionOf = tab => ({ runner: 'runner', doc: 'docs', env: 'environments' }[tab?.kind] || 'collections');
function rememberWorkspace() {
  const host = document.getElementById('request-host');
  const tab = state.tabs.find(item => item.id === host?._paneTabId);
  if (tab && !state.overviewPane) {
    sectionTabs.set(sectionOf(tab), tab.id);
    tab._scrollTop = host.querySelector('.pane-scroll')?.scrollTop || 0;
    tab._responseTop = (document.querySelector('#response-host .response-content') || document.querySelector('#response-host .response-body'))?.scrollTop || 0;
  }
}

export async function boot() {
  await loadAll();
  // Adopt the reference's light appearance once; subsequent theme choices persist.
  if (state.settings.appearanceRevision !== 'studio-2') {
    state.settings.theme = 'light';
    state.settings.appearanceRevision = 'studio-2';
    touch('settings');
  }
  applyAppearance();
  applyUiZoom();
  applySidebarWidth();
  if (!state.collections.length) seedExamples();
  buildShell();
  wireEvents();
  installVariableCompletion();
  renderTabs();
  renderPanes();
  renderSidebar();
  renderEnvSwitcher(document.getElementById('env-slot'));
  startScheduler();
  const { installAutomation } = await import('./automation.js');
  await installAutomation();
}

function buildShell() {
  const root = document.getElementById('root');
  const navButton = ([key, iconName, label]) => el('button', {
    class: `rail-btn ${state.pane === key ? 'active' : ''}`,
    title: label,
    'aria-label': label,
    'aria-current': state.pane === key ? 'page' : 'false',
    dataset: { rail: key },
    onclick: (event) => morph(() => {
      navigatePane(key);
    }, 'fade', event),
  }, [icon(iconName), el('span', { class: 'rail-label', text: label })]);
  root.replaceChildren(
    el('div', { class: 'shell' }, [
      el('div', { class: 'navigation' }, [
        el('div', { class: 'navigation-brand', dataset: { tauriDragRegion: '' } }, [
          el('div', { class: 'brand' }, [
            el('span', { class: 'brand-mark', html: BRAND_SVG, title: 'Relay' }),
            el('span', { class: 'brand-name', text: 'Relay' }),
          ]),
          el('button', {
            class: 'btn ghost icon navigation-collapse',
            title: '收起导航',
            'aria-label': '收起导航',
            'aria-expanded': 'true',
            onclick: (event) => {
              const nav = document.querySelector('.navigation');
              const collapsed = nav.classList.toggle('nav-collapsed');
              event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
              event.currentTarget.title = collapsed ? '展开导航' : '收起导航';
              event.currentTarget.setAttribute('aria-label', event.currentTarget.title);
            },
          }, [icon('chevR')]),
        ]),
        el('button', {
          class: 'btn command-trigger',
          title: '搜索或执行（Ctrl+K）',
          onclick: () => openPalette(),
        }, [icon('search'), el('span', { text: '搜索与命令' }), el('kbd', { text: 'Ctrl K' })]),
        el('nav', { class: 'rail', 'aria-label': '主导航' }, RAIL.map(navButton)),
        el('aside', { class: 'sidebar', id: 'sidebar' }),
        el('div', { class: 'navigation-footer' }, [
          el('span', { class: 'navigation-footer-mark', html: BRAND_SVG, 'aria-hidden': 'true' }),
          el('span', { class: 'navigation-footer-name', text: 'Relay' }),
          el('span', { class: 'navigation-footer-version', text: 'v0.1.15' }),
        ]),
      ]),
      el('div', { class: 'col-resizer', id: 'col-resizer', title: '拖动调整侧栏宽度，双击复位' }),
      el('div', { class: 'main-area' }, [
        el('header', { class: 'topbar', dataset: { tauriDragRegion: '' } }, [
          el('div', { class: 'tabstrip', id: 'tabstrip', role: 'tablist', 'aria-label': '打开的标签页', dataset: { tauriDragRegion: '' } }),
          el('div', { class: 'inline', id: 'env-slot' }),
          el('button', {
            class: 'btn sm topbar-import', title: '导入 cURL / OpenAPI / HAR',
            onclick: event => importMenu(event.currentTarget),
          }, [icon('upload'), el('span', { text: '导入' })]),
          el('button', { class: 'btn sm ghost icon', title: '快捷键（?）', onclick: () => openShortcuts() }, [icon('bolt')]),
          el('button', { class: 'btn sm ghost icon', title: '切换主题', onclick: (event) => themeMenu(event.currentTarget) }, [icon('sun')]),
          el('button', { class: 'btn sm ghost', title: 'AI 连接', text: 'AI', 'aria-label': 'AI 连接', onclick: async () => (await import('./automation.js')).openAutomationDialog() }),
          el('button', { class: 'btn sm ghost icon', title: '全局变量', onclick: () => openGlobals() }, [icon('braces')]),
          el('button', { class: 'btn sm ghost icon', title: '设置', onclick: () => openSettingsDialog() }, [icon('gear')]),
          el('div', { class: 'caption', id: 'caption' }),
        ]),
        el('main', { class: 'workspace' }, [
          el('div', { class: 'split', id: 'split' }, [
            el('div', { id: 'request-host', style: { display: 'flex', flex: `${requestRatio} 1 0`, minHeight: 0, flexDirection: 'column' } }),
            el('div', { class: 'divider', id: 'divider' }),
            el('div', { id: 'response-host', role: 'region', 'aria-label': '请求响应', style: { display: 'flex', flex: `${100 - requestRatio} 1 0`, minHeight: 0, flexDirection: 'column' } }),
          ]),
        ]),
      ]),
    ]),
    el('footer', { class: 'statusbar', id: 'statusbar' }),
    el('span', { class: 'sr-only', id: 'request-announcement', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }),
  );
  installDivider();
  installColResize();
  installScrollMemory();
  installTabstripScroll();
  installClipboardImport();
  renderCaption();
  renderStatusBar();
}

/// The thin line at the bottom: where this request is pointed, and what the last
/// response actually said. Both halves are buttons into the surface that owns
/// them, so the bar is navigation, not decoration.
function renderStatusBar() {
  const host = document.getElementById('statusbar');
  if (!host) return;
  const tab = state.overviewPane ? null : activeTab();
  const env = state.environments.find((e) => e.id === state.settings.activeEnvironmentId);
  const response = tab && tab.response;
  const announcement = document.getElementById('request-announcement');
  if (announcement) {
    const message = tab && tab.running ? '请求进行中' : response ? response.error ? `请求失败：${response.error}` : `响应 ${response.status}，耗时 ${duration(response.timeMs || 0)}` : '';
    if (announcement.textContent !== message) announcement.textContent = message;
  }
  const items = [
    el(
      'button',
      {
        class: 'sb-item',
        title: env ? `当前环境：${env.name}，点击切换` : '未选择环境，点击选择',
        onclick: () => {
          const slot = document.querySelector('#env-slot button');
          if (slot) slot.click();
        },
      },
      [
        el('span', { class: 'sb-dot', style: { background: env ? env.color || 'var(--accent)' : 'var(--line-strong)' } }),
        el('span', { text: env ? env.name : '无环境' }),
      ]
    ),
    el('span', { class: 'sb-sep' }),
  ];

  if (tab && tab.kind === 'request' && tab.draft) {
    const dirty = tab.dirty && tab.refId;
    items.push(
      el('span', { class: 'sb-item' }, [
        el('span', { class: `sb-value method-${(tab.draft.method || 'get').toLowerCase()}`, text: tab.draft.method || 'GET' }),
        el('span', { class: 'sb-url', text: tab.draft.url || '尚未填写 URL' }),
      ]),
      el('span', { class: 'sb-sep' })
    );
    if (dirty) items.push(el('span', { class: 'sb-item sb-dirty', title: '有改动未保存（Ctrl+S）', text: '未保存' }));
  } else if (tab) {
    items.push(el('span', { class: 'sb-item', text: titleFor(tab) }), el('span', { class: 'sb-sep' }));
  }

  const right = el('div', { class: 'sb-right' });
  if (tab && tab.running) {
    right.appendChild(el('span', { class: 'sb-item sb-ok', text: '进行中…' }));
  } else if (response) {
    const failed = !!response.error;
    right.appendChild(
      el(
        'span',
        {
          class: `sb-item ${failed ? 'sb-err' : 'sb-ok'}`,
          title: failed ? '上一次请求失败，点击查看原因' : '上一次响应',
        },
        [
          el('span', { class: 'sb-value', text: failed ? '请求失败' : `${response.status} ${response.statusText || ''}`.trim() }),
          el('span', { text: duration(response.timeMs || 0) }),
          el('span', { text: bytes(response.sizeBytes) }),
        ]
      )
    );
  } else if (tab) {
    right.appendChild(el('span', { class: 'sb-item', text: '尚无响应' }));
  }
  right.appendChild(el('span', { class: 'sb-sep' }));
  right.appendChild(
    el('span', {
      class: 'sb-item',
      title: '打开 / 关闭快捷键面板（?）',
      onclick: () => openShortcuts(),
      text: `${state.tabs.length} 个标签页`,
    })
  );
  host.replaceChildren(...items, right);
}

/// Copy a command in the browser, come back to this window, press Ctrl+V — that
/// is the whole gesture, no field to aim at first. Text fields keep pasting as
/// text, because there the characters are what was meant.
function installClipboardImport() {
  document.addEventListener('paste', (event) => {
    if (event.defaultPrevented) return;
    const text = event.clipboardData && event.clipboardData.getData('text/plain');
    if (!text) return;
    const node = event.target;
    const tag = node && node.tagName;
    const editing = tag === 'INPUT' || tag === 'TEXTAREA' || (node && node.isContentEditable);
    // the URL bar is the one field where a pasted curl command is noise rather
    // than content, so it defers to the importer too
    const urlBar = Boolean(node && node.classList && node.classList.contains('url-input'));
    if (editing && !urlBar) return;
    if (openImportFromText(text)) event.preventDefault();
  });
}

/// A vertical wheel over the strip should scroll it sideways, and the ▾ switcher
/// should only appear once there is something to reach.
function installTabstripScroll() {
  const strip = document.getElementById('tabstrip');
  if (!strip) return;
  strip.addEventListener('wheel', (event) => {
    if (strip.scrollWidth <= strip.clientWidth) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY;
    syncTabOverflow(strip);
  });
  strip.addEventListener('scroll', () => syncTabOverflow(strip));
  window.addEventListener('resize', () => syncTabOverflow(strip));
}

/// The native frame is gone, so the caption buttons live in the topbar and
/// take the theme colours with them.
function renderCaption() {
  const host = document.getElementById('caption');
  const win = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.getCurrentWindow
    ? window.__TAURI__.window.getCurrentWindow()
    : null;
  if (!host || !win) return;
  const button = (name, title, onClick, extra) =>
    el('button', { class: `caption-btn ${extra || ''}`, title, onclick: onClick }, [icon(name)]);
  const paint = (maxed) =>
    host.replaceChildren(
      button('minimize', '最小化', () => win.minimize()),
      button(maxed ? 'restore' : 'maximize', maxed ? '向下还原' : '最大化', () => win.toggleMaximize()),
      button('close', '关闭', () => win.close(), 'close')
    );
  const sync = () =>
    Promise.resolve(win.isMaximized())
      .then((maxed) => {
        document.documentElement.dataset.maximized = maxed ? 'true' : 'false';
        paint(maxed);
      })
      .catch(() => paint(false));
  paint(false);
  window.addEventListener('resize', sync);
  sync();
}

function renderRail() {
  document.querySelectorAll('.rail-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.rail === state.pane);
    button.setAttribute('aria-current', button.dataset.rail === state.pane ? 'page' : 'false');
  });
}

export function navigatePane(key) {
  rememberWorkspace();
  const remembered = state.tabs.find(tab => tab.id === sectionTabs.get(key));
  state.pane = key;
  state.overviewPane = remembered ? null : key;
  if (remembered) state.activeTabId = remembered.id;
  renderSidebar();renderRail();renderTabs();renderPanes();renderStatusBar();
}

export function showSectionOverview(key = state.pane) {
  rememberWorkspace();
  state.pane = key;
  state.overviewPane = key;
  renderSidebar();renderRail();renderTabs();renderPanes();renderStatusBar();
}

function renderSidebar() {
  const host = document.getElementById('sidebar');
  if (!host) return;
  if (state.pane === 'collections') renderTree(host);
  else if (state.pane === 'runner') renderRunnersPane(host);
  else if (state.pane === 'history') renderHistoryPane(host);
  else if (state.pane === 'environments') renderEnvPane(host);
  else if (state.pane === 'docs') renderDocsPane(host);
  // A workspace saved back when the Cookie Jar had a pane still says
  // `pane: 'cookies'`; without this the sidebar silently renders nothing.
  else {
    state.pane = 'collections';
    renderTree(host);
  }
  const title = host.querySelector('.sidebar-title');
  if (title) title.replaceWith(el('button', { class: 'sidebar-title section-overview', title: `查看全部${title.textContent}`, onclick: () => showSectionOverview() }, [title.textContent, icon('chevD')]));
}

/// Switching tabs slides the pane in the direction you travelled, which is what
/// makes a jump across twenty tabs read as motion rather than a redraw.
function switchTab(tabId, event) {
  if (state.overviewPane && tabId === state.activeTabId) {
    activateTab(tabId);renderPanes();return;
  }
  const from = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const to = state.tabs.findIndex((tab) => tab.id === tabId);
  if (to < 0 || from === to) {
    renderPanes();
    return;
  }
  morph(() => {
    activateTab(tabId);
    renderPanes();
  }, to > from ? 'slide-left' : 'slide-right', event);
}

function renderTabs() {
  const strip = document.getElementById('tabstrip');
  if (!strip) return;
  strip.replaceChildren(
    // the strip scrolls, so the far left end is just as unreachable as the right
    // one; this is its mirror fade and it only appears once there is something
    // hidden that way
    el('div', { class: 'tab-fade-left' }),
    ...state.tabs.map((tab) =>
      el(
        'div',
        {
          class: `tab ${!state.overviewPane && tab.id === state.activeTabId ? 'active' : ''}`,
          role: 'tab',
          tabindex: tab.id === state.activeTabId ? '0' : '-1',
          'aria-selected': !state.overviewPane && tab.id === state.activeTabId,
          'aria-label': titleFor(tab) || '未命名请求',
          onkeydown: (event) => {
            if (event.target !== event.currentTarget) return;
            const index = state.tabs.indexOf(tab);
            const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            if (offset || event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              const next = event.key === 'Home' ? state.tabs[0] : event.key === 'End' ? state.tabs.at(-1) : state.tabs[(index + offset + state.tabs.length) % state.tabs.length];
              activateTab(next.id);
              document.querySelector('.tab.active')?.focus();
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              activateTab(tab.id);
              document.querySelector('.tab.active')?.focus();
            }
          },
          onclick: (event) => switchTab(tab.id, event),
          ondblclick: () => {
            activateTab(tab.id);
            renderPanes();
            const input = document.querySelector('.req-title');
            if (input) {
              input.focus();
              input.select();
            }
          },
          onauxclick: (event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            closeTab(tab.id);
            renderTabs();
            renderPanes();
          },
          oncontextmenu: (event) => {
            event.preventDefault();
            tabMenu(event.currentTarget, tab);
          },
        },
        [
          tab.protocol === 'ws'
            ? el('span', { class: 'tag', text: 'WS' })
            : tab.protocol === 'env'
            ? el('span', { class: 'tag meta', text: 'ENV' })
            : tab.protocol === 'doc'
            ? el('span', { class: 'tag meta', text: 'DOC' })
            : tab.protocol === 'sse'
            ? el('span', { class: 'tag meta', text: 'SSE' })
            : tab.protocol === 'runner'
            ? el('span', { class: 'tag meta', text: 'RUN' })
            : null,
          ['ws', 'env', 'doc', 'runner'].includes(tab.protocol)
            ? null
            : el('span', { class: `mono small method-${(tab.draft.method || 'get').toLowerCase()}`, text: tab.draft.method }),
          el('span', { class: 'label', text: titleFor(tab) || '未命名', title: titleFor(tab) || '未命名' }),
          tab.dirty ? el('span', { class: 'dirty', title: '有未保存修改' }) : null,
          el('button', {
            class: 'close',
            type: 'button',
            'aria-label': `关闭 ${titleFor(tab) || '未命名请求'}`,
            text: '×',
            onclick: (event) => {
              event.stopPropagation();
              closeTab(tab.id);
              renderTabs();
              renderPanes();
            },
          }),
        ]
      )
    ),
    el('div', { class: 'tab-actions' }, [
      el('button', {
        class: 'tab-more',
        title: '全部标签（Ctrl+Tab 切换）',
        text: '▾',
        onclick: (event) => openTabList(event.currentTarget),
      }),
      el('button', {
        class: 'tab-new',
        title: '新建标签页',
        text: '＋',
        onclick: (event) => newTabMenu(event.currentTarget),
      }),
    ])
  );
  syncTabOverflow(strip);
  const active = strip.querySelector('.tab.active');
  if (active) {
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const box = active.getBoundingClientRect(), edge = strip.getBoundingClientRect();
    const right = strip.querySelector('.tab-actions').getBoundingClientRect().left;
    const zoom = Number(state.settings.uiZoom) || 1;
    if (box.right > right) strip.scrollLeft += (box.right - right) / zoom;
    else if (box.left < edge.left + 16) strip.scrollLeft -= (edge.left + 16 - box.left) / zoom;
    syncTabOverflow(strip);
  }
}

/// The strip scrolls, so with 30 tabs the far ends are unreachable by clicking;
/// this lists every tab so you can jump straight to it.
function openTabList(anchor) {
  const items = state.tabs.map((tab) => ({
    label: `${tab.protocol === 'ws' ? 'WS' : tab.protocol === 'env' ? 'ENV' : tab.protocol === 'sse' ? 'SSE' : tab.draft.method || 'GET'}  ${titleFor(tab) || '未命名'}`,
    hint: tab.id === state.activeTabId ? '当前' : tab.dirty ? '未保存' : '',
    selected: tab.id === state.activeTabId,
    onSelect: () => switchTab(tab.id),
  }));
  menu(anchor, [
    ...items,
    { separator: true },
    { label: '关闭全部', danger: true, disabled: !state.tabs.length, onSelect: () => closeTabs(state.tabs) },
  ]);
}

function syncTabOverflow(strip) {
  const overflowing = strip.scrollWidth > strip.clientWidth + 4;
  strip.classList.toggle('overflowing', overflowing);
  strip.classList.toggle('fade-left', strip.scrollLeft > 2);
}

async function closeTabs(list) {
  for (const tab of [...list]) if(await closeTab(tab.id)===false)break;
  renderTabs();
  renderPanes();
}

function cycleTab(step, event) {
  if (state.tabs.length < 2) return;
  const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const next = (index + step + state.tabs.length) % state.tabs.length;
  switchTab(state.tabs[next].id, event);
  renderTabs();
}

function tabMenu(anchor, tab) {
  const index = state.tabs.findIndex((item) => item.id === tab.id);
  const last = state.tabs.length - 1;
  menu(anchor, [
    { label: '关闭', hint: 'Ctrl W / 中键', onSelect: () => closeTabs([tab]) },
    { label: '关闭其他', disabled: state.tabs.length < 2, onSelect: () => closeTabs(state.tabs.filter((item) => item.id !== tab.id)) },
    { label: '关闭左侧', disabled: index <= 0, onSelect: () => closeTabs(state.tabs.slice(0, index)) },
    { label: '关闭右侧', disabled: index >= last, onSelect: () => closeTabs(state.tabs.slice(index + 1)) },
    { label: '关闭全部', danger: true, disabled: !state.tabs.length, onSelect: () => closeTabs(state.tabs) },
    { separator: true },
    { label: '复制标签', onSelect: () => duplicateTab(tab) },
    { label: '生成 cURL', onSelect: () => import('./request.js').then(({ showCurl }) => showCurl(tab)) },
  ]);
}

/// One entry point for "new tab": the type is chosen here, so the strip needs a
/// single ＋ instead of a plain one plus a labelled WS one.
function newTabMenu(anchor) {
  menu(
    anchor,
    [
      { label: 'HTTP 请求', icon: 'play', hint: 'Ctrl N', onSelect: () => createTabOfType('http') },
      { label: 'SSE 事件流', icon: 'bolt', hint: '流式', onSelect: () => createTabOfType('sse') },
      { label: 'WebSocket 连接', icon: 'ws', hint: 'Ctrl Shift N', onSelect: () => createTabOfType('ws') },
      { separator: true },
      { label: '环境设置', icon: 'env', onSelect: () => navigatePane('environments') },
    ],
    { align: 'start' }
  );
}

function createTabOfType(protocol) {
  const tab = newTab(protocol === 'ws' ? 'ws' : 'http');
  if (protocol === 'sse') tab.protocol = 'sse';
  renderTabs();
  renderPanes();
}

function duplicateTab(tab) {
  const copy = newTab(tab.kind);
  copy.draft = JSON.parse(JSON.stringify(tab.draft));
  copy.auth = JSON.parse(JSON.stringify(tab.auth || { kind: 'inherit' }));
  copy.protocol = tab.protocol;
  copy.title = `${titleFor(tab)} 副本`;
  copy.refId = null;
  copy.dirty = true;
  renderTabs();
  renderPanes();
}

function renderPanes() {
  const tab = activeTab();
  const requestHost = document.getElementById('request-host');
  const responseHost = document.getElementById('response-host');
  const divider = document.getElementById('divider');
  if (state.overviewPane && requestHost) {
    requestHost._paneTabId = null;
    responseHost.classList.add('hidden');divider.classList.add('hidden');
    requestHost.replaceChildren(renderSection(state.overviewPane));
    presentPane(requestHost, `overview:${state.overviewPane}`);
    return;
  }
  if (!tab || !requestHost) return;
  const remember = (host, key) => {
    const scroller = host.querySelector('.response-content') || host.querySelector('.pane-scroll, .doc-scroll, .response-body');
    return host._paneTabId === tab.id && scroller ? scroller.scrollTop : tab[key] || 0;
  };
  const keepRequest = remember(requestHost, '_scrollTop');
  const keepResponse = remember(responseHost, '_responseTop');
  requestHost._paneTabId = tab.id;
  const settle = (host, key, top) => {
    host._paneTabId = tab.id;
    const scroller = host.querySelector('.response-content') || host.querySelector('.pane-scroll, .doc-scroll, .response-body');
    if (scroller) scroller.scrollTop = top;
    if (tab[key] !== top) tab[key] = top;
    if (host === requestHost) presentPane(host, `${tab.id}:${tab.protocol}:${tab.view}:${tab.wsView}:${state.docs.find(doc=>doc.id===tab.refId)?.mode||''}`);
  };
  requestHost.replaceChildren();
  if (tab.kind === 'doc' || tab.protocol === 'doc') {
    responseHost.classList.add('hidden');
    divider.classList.add('hidden');
    requestHost.appendChild(renderDocPane(tab));
    settle(requestHost, '_scrollTop', keepRequest);
    return;
  }
  if (tab.kind === 'env' || tab.protocol === 'env') {
    responseHost.classList.add('hidden');
    divider.classList.add('hidden');
    requestHost.appendChild(renderEnvTab(tab));
    settle(requestHost, '_scrollTop', keepRequest);
    return;
  }
  if (tab.kind === 'runner' || tab.protocol === 'runner') {
    responseHost.classList.add('hidden');
    divider.classList.add('hidden');
    requestHost.appendChild(renderRunnerTab(tab));
    settle(requestHost, '_scrollTop', keepRequest);
    return;
  }
  if (tab.protocol === 'ws') {
    responseHost.classList.add('hidden');
    divider.classList.add('hidden');
    requestHost.appendChild(renderWsPane(tab));
    settle(requestHost, '_scrollTop', keepRequest);
    return;
  }
  responseHost.classList.remove('hidden');
  divider.classList.remove('hidden');
  applyRequestSplit(tab);
  requestHost.appendChild(renderRequestPane(tab));
  responseHost.replaceChildren(renderResponsePane(tab));
  settle(requestHost, '_scrollTop', keepRequest);
  settle(responseHost, '_responseTop', keepResponse);
}

function editingBody(tab=activeTab()) {
  return tab?.kind==='request'&&tab.view==='body'&&tab.draft?.body?.mode==='raw';
}

function applyRequestSplit(tab=activeTab()) {
  const height=document.getElementById('split').getBoundingClientRect().height||800;
  const bodyDefault=Math.min(82,Math.max(65,450/height*100));
  const ratio=editingBody(tab)?Math.max(18,Math.min(82,Number(state.settings.bodyRequestRatio)||bodyDefault)):requestRatio;
  document.getElementById('request-host').style.flex=`${ratio} 1 0`;
  document.getElementById('response-host').style.flex=`${100-ratio} 1 0`;
}

function installDivider() {
  const divider = document.getElementById('divider');
  if (!divider) return;
  let dragging = false;
  window.addEventListener('resize',()=>{if(editingBody())applyRequestSplit();});
  divider.addEventListener('mousedown', (event) => {
    dragging = true;
    divider.classList.add('dragging');
    document.body.style.userSelect = 'none';
    event.preventDefault();
  });
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const split = document.getElementById('split').getBoundingClientRect();
    const ratio = ((event.clientY - split.top) / split.height) * 100;
    const next=Math.max(18, Math.min(82, ratio));
    if(editingBody())state.settings.bodyRequestRatio=next;else requestRatio=next;
    applyRequestSplit();
  });
  window.addEventListener('mouseup', () => {
    if(!dragging)return;
    dragging = false;
    if(editingBody())touch('settings');
    divider.classList.remove('dragging');
    document.body.style.userSelect = '';
  });
  divider.addEventListener('dblclick', () => {
    if(editingBody()){delete state.settings.bodyRequestRatio;touch('settings');}else requestRatio=47;
    applyRequestSplit();
  });
}

function wireEvents() {
  let workspaceTabId = state.activeTabId;
  on('tabs', (payload) => {
    const tab = activeTab();
    if (workspaceTabId !== tab?.id || payload?.activate) {
      rememberWorkspace();
      state.overviewPane = null;
      state.pane = sectionOf(tab);
      if (tab) sectionTabs.set(state.pane, tab.id);
      workspaceTabId = tab?.id;
      renderSidebar();renderRail();
    }
    renderTabs();
    renderStatusBar();
    const saveButton=document.querySelector('[data-save-tab]');
    if(saveButton&&saveButton.dataset.saveTab===tab?.id) {
      const clean=!!tab.refId&&!tab.dirty;
      saveButton.classList.toggle('success',clean);
      (saveButton.querySelector('span') || saveButton).textContent=clean?'已保存':'保存';
      saveButton.title=clean?'已保存到集合':'保存到集合（Ctrl+S）';
    }
  });
  on('rerender', () => {
    renderPanes();
    renderStatusBar();
  });
  on('environment', () => {
    renderEnvSwitcher(document.getElementById('env-slot'));
    emit('rerender');
  });
  on('pane', () => {
    renderSidebar();
    renderRail();
    if (state.overviewPane) renderPanes();
  });
  on('tree', renderSidebar);
  on('response', () => {
    const responseHost = document.getElementById('response-host');
    const tab = activeTab();
    if (responseHost && tab && tab.protocol !== 'ws' && !state.overviewPane) responseHost.replaceChildren(renderResponsePane(tab));
  });
  on('theme', () => {
    applyAppearance();
  });
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', () => {
    for (const domain of ['collections', 'environments', 'docs', 'history', 'settings', 'tabs', 'runners', 'runs']) flushDomain(domain);
  });
}

function onKey(event) {
  if(event.defaultPrevented)return;
  const mod = event.ctrlKey || event.metaKey;
  const target = event.target;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (event.key === 'Escape' && document.querySelector('.overlay')) return;
  if (!mod) {
    if (event.key === 'F6' && typing) {
      event.preventDefault();
      const url = document.querySelector('.url-input');
      if (url) url.focus();
    } else if (event.key === '?' && !typing) {
      event.preventDefault();
      openShortcuts();
    } else if (event.key === 'Delete' && !typing && state.pane === 'collections') {
      event.preventDefault();
      deletePicked();
    } else if (event.key === 'Escape' && !typing && state.pane === 'collections') {
      event.preventDefault();
      clearPick();
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && !typing && state.pane === 'collections') {
      // the same step the row menu takes: one selected row, one position
      event.preventDefault();
      moveSelected(event.key === 'ArrowUp' ? -1 : 1);
    }
    return;
  }
  const key = event.key.toLowerCase();
  if ((key === 'z' || key === 'y') && !typing && !document.querySelector('.overlay')) {
    event.preventDefault(); undo(key === 'y' || event.shiftKey);
  } else if (event.key === 'Tab') {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
  } else if (/^[1-9]$/.test(event.key) && !typing) {
    event.preventDefault();
    const index = event.key === '9' ? state.tabs.length - 1 : Number(event.key) - 1;
    const tab = state.tabs[index];
    if (tab) {
      switchTab(tab.id, event);
      renderTabs();
    }
  } else if (key === 'enter') {
    event.preventDefault();
    const tab = activeTab();
      if (tab && !state.overviewPane) {
        if(tab.kind==='doc')import('./doc.js').then(({runActiveDoc})=>runActiveDoc());
        else if(tab.protocol==='ws')toggleWs(tab);
        else if(tab.kind==='request')send(tab);
      }
  } else if (key === 's') {
    event.preventDefault();
    const tab = activeTab();
    if (tab && tab.kind === 'doc') {
      flushDomain('docs', { strict: true }).then(() => toast('文档已保存', 'ok', 1500)).catch(() => {});
    } else if (tab?.protocol==='ws') {
      saveWs(tab);
    } else if (tab?.kind==='request') {
      save(tab);
    }
  } else if (key === 'k') {
    event.preventDefault();
    openPalette();
  } else if (key === 'i') {
    event.preventDefault();
    importCurlDialog();
  } else if (key === 'n' && !event.shiftKey) {
    event.preventDefault();
    newTab('request');
    renderTabs();
    renderPanes();
  } else if (key === 'n' && event.shiftKey) {
    event.preventDefault();
    newTab('ws');
    renderTabs();
    renderPanes();
  } else if (key === 'w') {
    event.preventDefault();
    const tab = activeTab();
    if (tab) {
      closeTab(tab.id);
      renderTabs();
      renderPanes();
    }
  } else if (key === 'a' && !typing && state.pane === 'collections') {
    event.preventDefault();
    pickAllVisible();
  } else if (key === '/') {
    event.preventDefault();
    toggleTheme(event);
  } else if (key === 'f' && typing) {
    /* let the webview handle find */
  }
}

/// One knob scales the whole UI; the stylesheet reads it as `zoom`.
export function applyUiZoom() {
  const zoom = Number(state.settings.uiZoom) || 1;
  document.documentElement.style.setProperty('--ui-zoom', String(Math.min(2, Math.max(0.85, zoom))));
}

export function applySidebarWidth() {
  const width = Number(state.settings.sidebarWidth) || 272;
  document.documentElement.style.setProperty('--sidebar', `${Math.min(520, Math.max(200, width))}px`);
}

/// The sidebar gutter is the one split the shell never let you move. Same
/// affordance as the horizontal divider: drag, and double-click to let go.
function installColResize() {
  const handle = document.getElementById('col-resizer');
  if (!handle) return;
  let dragging = false;
  handle.addEventListener('mousedown', (event) => {
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    event.preventDefault();
  });
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const width = Math.min(520, Math.max(200, event.clientX - document.querySelector('.shell').getBoundingClientRect().left - 2));
    document.documentElement.style.setProperty('--sidebar', `${width}px`);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    const used = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar')) || 272;
    state.settings.sidebarWidth = Math.round(used);
    touch('settings');
  });
  handle.addEventListener('dblclick', () => {
    state.settings.sidebarWidth = 272;
    touch('settings');
    applySidebarWidth();
  });
}

/// Re-rendering a pane rebuilds its scroller, which threw the reader back to the
/// top on every tab switch. Each tab now carries its own offset.
function installScrollMemory() {
  for (const hostId of ['request-host', 'response-host']) {
    const host = document.getElementById(hostId);
    if (!host) continue;
    const key = hostId === 'request-host' ? '_scrollTop' : '_responseTop';
    host.addEventListener(
      'scroll',
      (event) => {
        const target = event.target;
        if (!target.classList || !(target.classList.contains('pane-scroll') || target.classList.contains('doc-scroll') || target.classList.contains('response-body') || target.classList.contains('response-content'))) return;
        const tab = activeTab();
        if (tab) tab[key] = target.scrollTop;
      },
      true
    );
  }
}

function toggleTheme(event) {
  morph(() => {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    applyAppearance();
    touch('settings');
  }, 'theme', event);
}

/* ---------------------------- command palette ---------------------------- */

function allRequests() {
  const out = [];
  const walk = (nodes, trail) => {
    for (const node of nodes || []) {
      if (node.kind === 'request' || node.kind === 'ws') out.push({ node, trail });
      walk(node.children, trail.concat(node.name));
    }
  };
  walk(state.collections, []);
  return out;
}

function openPalette() {
  if (document.querySelector('.palette')) return;
  const opener = document.activeElement;
  const close = () => {
    overlay.remove();
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  };
  const input = el('input', { placeholder: '搜索请求、执行命令、跳转到…', oninput: () => paint() });
  const list = el('div', { class: 'palette-list' });
  const overlay = el('div', {
    class: 'overlay',
    style: { placeItems: 'start center', paddingTop: '10vh' },
    onclick: (event) => {
      if (event.target === overlay) close();
    },
  });
  const box = el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': '搜索与命令' }, [
    input, list,
    el('div', { class: 'palette-footer' }, ['↑ ↓ 选择', 'Enter 打开', 'Esc 关闭']),
  ]);
  input.setAttribute('aria-label', '搜索请求、运行计划和命令');
  overlay.appendChild(box);
  document.getElementById('modal-root').appendChild(overlay);
  input.focus();

  const commands = [
    ...(undoState().undo ? [{ label: `撤销${undoState().undo}`, hint: 'Ctrl Z', run: () => undo() }] : []),
    ...(undoState().redo ? [{ label: `重做${undoState().redo}`, hint: 'Ctrl Shift Z', run: () => undo(true) }] : []),
    { label: '新建请求', hint: 'Ctrl N', run: () => (newTab('request'), renderTabs(), renderPanes()) },
    { label: '新建 WebSocket 标签', hint: 'Ctrl Shift N', run: () => (newTab('ws'), renderTabs(), renderPanes()) },
    { label: '新建集合', icon: 'collections', run: () => createCollection('新建集合') },
    { label: '新建文档', icon: 'file', hint: '接口交付', run: () => createDoc() },
    { label: '新建运行计划', icon: 'play', hint: '跨集合串行', run: () => createRunner() },
    { label: '运行计划列表', icon: 'play', hint: '串行 / 定时', run: () => showSectionOverview('runner') },
    { label: '导入 cURL', hint: 'Ctrl I', run: () => importCurlDialog() },
    { label: '导入 OpenAPI 3 · JSON', run: () => importFormatDialog('openapi') },
    { label: '导入 HAR', run: () => importFormatDialog('har') },
    { label: '管理环境', run: () => navigatePane('environments') },
    { label: '全局变量', run: () => openGlobals() },
    { label: '当前环境的变量编辑', run: () => (activeEnvId() ? openEnvEditor(activeEnvId()) : toast('尚未选择环境', 'err')) },
    { label: '历史记录', run: () => navigatePane('history') },
    { label: '设置', run: () => openSettingsDialog() },
    { label: '快捷键列表', hint: '?', icon: 'bolt', run: () => openShortcuts() },
    { label: '切换深浅主题', hint: 'Ctrl /', run: () => toggleTheme() },
    { label: '运行当前接口', hint: 'Ctrl Enter', run: () => {
      const tab=activeTab();if(!tab || state.overviewPane)return toast('请先打开一个接口','err');
      if(tab.kind==='doc')import('./doc.js').then(({runActiveDoc})=>runActiveDoc());
      else if(tab.protocol==='ws')toggleWs(tab);
      else if(tab.kind==='request')send(tab);
      else toast('当前页面没有可运行的接口','err');
    } },
    { label: '停止当前请求 / 断开流', run: () => {
      const tab=activeTab();if(!tab)return;
      if(tab.protocol==='ws'&&['open','opening'].includes(tab.ws?.status))disconnectWs(tab);
      else if(tab.kind==='request')stopEverything(tab);
    } },
  ];

  function activeEnvId() {
    return state.environments.find((env) => env.id === state.settings.activeEnvironmentId) || null;
  }

  let items = [];
  let cursor = 0;

  function score(text, term) {
    const haystack = text.toLowerCase();
    if (!term) return 1;
    if (haystack.startsWith(term)) return 100;
    if (haystack.includes(term)) return Math.max(30,60 - haystack.indexOf(term));
    let index = -1;
    let points = 0;
    for (const ch of term) {
      index = haystack.indexOf(ch, index + 1);
      if (index < 0) return 0;
      points += 2;
    }
    return points;
  }

  function paint() {
    const term = input.value.trim().toLowerCase();
    const requestItems = allRequests().map(({ node, trail }) => ({
      label: node.name || '未命名',
      sub: `${trail.join(' / ')}${node.request && node.request.url ? ' · ' + node.request.url : ''}`,
      points: score(`${node.name} ${trail.join(' ')} ${node.request ? node.request.url : ''}`, term),
      run: () => {
        openRequest(node, { replaceExisting: true });
        renderTabs();
        renderPanes();
      },
    }));
    const runnerItems = state.runners.map((runner) => ({
      label: runner.name,
      sub: `运行计划 · ${(runner.sources || []).length} 个步骤` + (runner.schedule && runner.schedule.enabled ? ' · 定时开启' : ''),
      points: rankedScore(`${runner.name} 运行计划 run`, term, 4),
      run: () => (state.pane = 'runner', renderSidebar(), renderRail(), openRunner(runner)),
    }));
    const commandItems = commands.map((command) => ({
      label: command.label,
      sub: command.hint || '',
      points: rankedScore(`${command.label} ${command.hint || ''}`, term, 8),
      run: command.run,
    }));
    items = [...commandItems, ...runnerItems, ...requestItems].filter((item) => item.points > 0).sort((a, b) => b.points - a.points).slice(0, 60);
    cursor = 0;
    list.replaceChildren(
      ...items.map((item, index) =>
        el(
          'div',
          {
            class: `palette-item ${index === 0 ? 'on' : ''}`,
            onmouseenter: () => {
              cursor = index;
              highlight();
            },
            onclick: () => {
              close();
              item.run();
            },
          },
          [el('span', { class: 'grow', text: item.label, title: item.label }), item.sub ? el('span', { class: 'sub', text: item.sub, title: item.sub }) : null]
        )
      )
    );
    if (!items.length) list.replaceChildren(el('div', { class: 'palette-item faint', text: '没有匹配项' }));
  }

  function highlight() {
    [...list.children].forEach((child, index) => child.classList.toggle('on', index === cursor));
    list.children[cursor]?.scrollIntoView({ block: 'nearest' });
  }

  function rankedScore(text, term, bonus) {
    const points = score(text, term);
    return points > 0 ? points + bonus : 0;
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(items.length - 1, cursor + 1);
      highlight();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(0, cursor - 1);
      highlight();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[cursor];
      close();
      if (item) item.run();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  });
  paint();
}

/* ---------------------------- first run examples ---------------------------- */

function seedExamples() {
  const collection = {
    id: 'col-example',
    kind: 'collection',
    name: '示例接口',
    expanded: true,
    variables: [
      { id: 'v1', key: 'echoHost', value: 'https://postman-echo.com', enabled: true, description: '回显服务地址' },
    ],
    auth: { kind: 'noauth' },
    children: [],
  };
  const make = (name, patch) => ({
    id: `req-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'request',
    name,
    protocol: patch.protocol || 'http',
    auth: { kind: 'inherit' },
    request: {
      name,
      method: 'GET',
      url: '',
      params: [],
      headers: [],
      body: { mode: 'none', raw: { language: 'json', content: '' }, urlencoded: [], form: [], file: null },
      settings: {},
      ...patch,
    },
  });
  collection.children = [
    make('Echo GET', {
      url: '{{echoHost}}/get',
      params: [{ id: 'p1', key: 'foo', value: 'bar', enabled: true, description: '示例参数' }],
    }),
    make('Echo POST JSON', {
      method: 'POST',
      url: '{{echoHost}}/post',
      headers: [{ id: 'h1', key: 'Content-Type', value: 'application/json', enabled: true, description: '' }],
      body: {
        mode: 'raw',
        raw: { language: 'json', content: '{\n  "name": "Relay",\n  "at": "{{$isoTimestamp}}"\n}' },
        urlencoded: [],
        form: [],
        file: null,
      },
    }),
    make('SSE 事件流', {
      protocol: 'sse',
      method: 'GET',
      url: 'https://httpbin.org/eventstream/10',
      headers: [{ id: 'h2', key: 'Accept', value: 'text/event-stream', enabled: true, description: '' }],
    }),
    make('延迟响应（测试超时）', {
      url: '{{echoHost}}/delay/3',
      settings: { timeoutMs: 2000, sslVerify: true, followRedirects: true, cookieJar: true },
    }),
  ];
  state.collections.push(collection);
  touch('collections');
}

export { renderPanes, renderTabs, openPalette };

window.addEventListener('error', (event) => {
  console.error('未捕获错误', event.message, event.filename, event.lineno);
});

boot().catch((error) => {
  console.error('启动失败', error);
  document.getElementById('root').innerHTML =
    `<div style="padding:32px;font-family:system-ui;line-height:1.8;color:#f2555a">启动失败：${String(
      (error && error.stack) || error
    ).replace(/</g, '&lt;')}</div>`;
});
