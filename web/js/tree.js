import { el, icon, toast, confirmDialog, modal } from './ui.js';
import { menu } from './menu.js';
import { changeList } from './undo.js';
import {
  state,
  touch,
  uid,
  newCollection,
  newFolder,
  newRequestNode,
  newRequestDraft,
  openRequest,
  newTab,
  findNode,
  pathTo,
  activeTab,
  activeEnv,
  emit,
} from './state.js';
import { exportCollectionDialog, importCurlDialog, importFormatDialog } from './tools.js';
import { runNodeFromTree, joinPlanMenu, createRunner } from './runner.js';

let filter = '';
let hostEl = null;
let editingId = null;
/// The rows currently on screen, in paint order. Shift+click and Ctrl+A both work
/// on this list, so a collapsed folder can never be swept into a selection.
let visibleOrder = [];
let removing = false;

/// Repaint the tree in place; falls back to a full sidebar rebuild when the
/// caller is not the collections pane.
function refresh() {
  const focused = document.activeElement?.closest('.node')?.dataset.node;
  const scroll = hostEl?.querySelector('.sidebar-body')?.scrollTop || 0;
  if (hostEl && hostEl.isConnected) render(hostEl);
  else emit('tree');
  const scroller = document.querySelector('#sidebar .sidebar-body');
  if (scroller) scroller.scrollTop = scroll;
  if (focused) [...document.querySelectorAll('#sidebar .node')].find((item) => item.dataset.node === focused)?.focus({ preventScroll: true });
}

export function setFilter(value) {
  filter = (value || '').trim().toLowerCase();
  refresh();
}

function matches(node) {
  if (!filter) return true;
  if ((node.name || '').toLowerCase().includes(filter)) return true;
  if ((node.request?.url || '').toLowerCase().includes(filter)) return true;
  if ((node.request?.method || '').toLowerCase().includes(filter)) return true;
  return (node.children || []).some(matches);
}

function expandKey(node) {
  return node.id;
}

function isOpen(node) {
  const stored = state.expanded[expandKey(node)];
  return stored === undefined ? node.expanded !== false : stored;
}

function toggle(node) {
  state.expanded[expandKey(node)] = !isOpen(node);
  refresh();
}

function addInto(parentNode, child) {
  const target = parentNode ? findNode(parentNode.id) : null;
  const list = target ? target.node.children || (target.node.children = []) : state.collections;
  list.push(child);
  touch('collections');
  if (parentNode) state.expanded[parentNode.id] = true;
  return child;
}

export function createCollection(name, { edit = true } = {}) {
  const collection = newCollection(name || '新建集合');
  state.collections.push(collection);
  touch('collections');
  refresh();
  if (edit) rename(collection);
  return collection;
}

function createRequest(parent, name) {
  const env = activeEnv();
  const node = newRequestNode(name || '未命名请求');
  if (env && env.defaults) {
    const defaults = env.defaults;
    if (defaults.urlPrefixMode === 'prefill' && defaults.baseUrl) node.request.url = '{{baseUrl}}/';
    if (defaults.headers && defaults.headers.length) node.request.headers = JSON.parse(JSON.stringify(defaults.headers));
    if (defaults.prefillBody && defaults.bodyMode && defaults.bodyMode !== 'none') {
      node.request.body = {
        mode: defaults.bodyMode,
        raw:
          defaults.bodyMode === 'raw'
            ? { language: defaults.bodyLanguage || 'json', content: defaults.bodyContent || '' }
            : { language: 'json', content: '' },
        urlencoded: defaults.bodyMode === 'urlencoded' ? JSON.parse(JSON.stringify(defaults.urlencodedSeed || [])) : [],
        form: defaults.bodyMode === 'form' ? JSON.parse(JSON.stringify(defaults.formSeed || [])) : [],
        file: null,
      };
    }
  }
  addInto(requestTarget(parent), node);
  const tab = openRequest(node, { replaceExisting: false });
  tab.dirty = false;
  emit('tabs');
  touch('tabs');
  if (!name) rename(node);
  return node;
}

/// Requests are only allowed directly inside a collection or a folder; this
/// resolves whatever the user has selected into such a container.
function requestTarget(node) {
  let cursor = node || null;
  if (cursor && cursor.kind === 'request') cursor = (findNode(cursor.id) || {}).parent;
  if (!cursor || (cursor.kind !== 'collection' && cursor.kind !== 'folder')) {
    cursor = state.collections[0] || createCollection('我的 API', { edit: false });
  }
  return cursor;
}

/// Renaming happens inside the row itself — a dialog for a name is too heavy.
function createFolder(parent) {
  const folder = newFolder();
  addInto(parent, folder);
  rename(folder);
  return folder;
}

function rename(node) {
  editingId = node.id;
  if (state.pane !== 'collections') {
    state.pane = 'collections';
    emit('pane');
  }
  refresh();
  setTimeout(() => {
    const input = hostEl && hostEl.querySelector('.node-rename');
    if (input) {
      input.focus();
      input.select();
    }
  }, 0);
}

function commitRename(node, value, cancelled) {
  if (editingId !== node.id) return;
  editingId = null;
  const name = String(value || '').trim();
  if (!cancelled && name && name !== node.name) {
    node.name = name;
    if (node.request) node.request.name = name;
    const tab = state.tabs.find((item) => item.refId === node.id);
    if (tab) {
      tab.title = name;
      // the editor's own title field reads draft.name, so a rename from the row
      // has to land there too or the two disagree until you save
      tab.draft.name = name;
      emit('rerender');
    }
    touch('collections');
    emit('tabs');
  }
  refresh();
}

async function remove(node) {
  await removeMany([node.id]);
}

function kindLabel(node) {
  return node.kind === 'collection' ? '集合' : node.kind === 'folder' ? '文件夹' : node.kind === 'ws' ? 'WebSocket 连接' : '请求';
}

function eachId(node, fn) {
  fn(node);
  for (const child of node.children || []) eachId(child, fn);
}

/// A picked collection and its own picked children are the same deletion, so the
/// batch collapses to the topmost rows — otherwise the second removal would
/// report "not found" and the undo would restore one copy too many.
function topmostPicked(ids) {
  const picked = new Set(ids);
  const out = [];
  for (const id of picked) {
    const trail = pathTo(id) || [];
    if (!trail.slice(0, -1).some((ancestor) => picked.has(ancestor.id))) out.push(id);
  }
  return out;
}

async function removeMany(ids) {
  // one confirm at a time: two stacked dialogs would both capture the same nodes,
  // and the second undo would splice them back in twice
  if (removing) return;
  const victims = [];
  for (const id of topmostPicked(ids)) {
    const hit = findNode(id);
    if (hit) victims.push({ node: hit.node, list: hit.siblings, index: hit.siblings.indexOf(hit.node) });
  }
  if (!victims.length) return;
  removing = true;
  const gone = new Set();
  for (const victim of victims) eachId(victim.node, (n) => gone.add(n.id));
  const nested = gone.size - victims.length;
  const question =
    victims.length === 1
      ? `确定删除${kindLabel(victims[0].node)}「${victims[0].node.name}」吗？` + (nested ? `其中的 ${nested} 个子项会一并删除。` : '')
      : `确定删除这 ${victims.length} 项吗？` + (nested ? `连同子项共 ${gone.size} 个条目。` : '');
  const ok = await confirmDialog(`${question}删错了可以在提示条上撤销。`);
  removing = false;
  if (!ok) return;
  for (const victim of victims) {
    const at = victim.list.indexOf(victim.node);
    if (at >= 0) victim.list.splice(at, 1);
  }
  for (const tab of [...state.tabs]) {
    if (tab.refId && gone.has(tab.refId)) {
      tab.refId = null;
      tab.dirty = true;
    }
  }
  state.selectedNodeIds = [];
  touch('collections');
  emit('tabs');
  refresh();
  const bar = toast(`已删除 ${victims.length === 1 ? `「${victims[0].node.name}」` : `${victims.length} 项`}`, 'ok', 6000);
  bar.appendChild(
    el('button', {
      class: 'toast-act',
      text: '撤销',
      onclick: () => {
        for (const victim of [...victims].sort((a, b) => a.index - b.index)) {
          victim.list.splice(Math.max(0, Math.min(victim.index, victim.list.length)), 0, victim.node);
        }
        bar.remove();
        touch('collections');
        refresh();
        toast('已还原', 'ok', 1800);
      },
    })
  );
}

/* ---------------------------- multi-selection ---------------------------- */

function isPicked(node) {
  return state.selectedNodeIds.indexOf(node.id) >= 0;
}

function pickingMode() {
  return state.selectedNodeIds.length > 1;
}

function togglePick(node) {
  const at = state.selectedNodeIds.indexOf(node.id);
  if (at >= 0) state.selectedNodeIds.splice(at, 1);
  else state.selectedNodeIds.push(node.id);
  refresh();
}

/// Shift means "the run I can see", not "this whole subtree" — collapsed folders
/// are not in the visible list, so they cannot be swept up by accident.
function rangePick(node) {
  const anchor = state.selectedNodeIds[state.selectedNodeIds.length - 1];
  const from = visibleOrder.indexOf(anchor);
  const to = visibleOrder.indexOf(node.id);
  if (from < 0 || to < 0) {
    togglePick(node);
    return;
  }
  const [lo, hi] = from < to ? [from, to] : [to, from];
  state.selectedNodeIds = [...new Set(state.selectedNodeIds.concat(visibleOrder.slice(lo, hi + 1)))];
  refresh();
}

export function pickAllVisible() {
  if (!state.selectedNodeIds.length && !visibleOrder.length) return;
  state.selectedNodeIds = [...visibleOrder];
  refresh();
}

export function clearPick() {
  if (!state.selectedNodeIds.length) return false;
  state.selectedNodeIds = [];
  refresh();
  return true;
}

export function deletePicked() {
  if (!state.selectedNodeIds.length) return false;
  removeMany(state.selectedNodeIds);
  return true;
}

function duplicate(node) {
  const copy = JSON.parse(JSON.stringify(node));
  const reseed = (item) => {
    item.id = uid(item.kind === 'folder' ? 'fld' : item.kind === 'ws' ? 'ws' : 'req');
    if (item.request) item.request.id = uid('rq');
    (item.children || []).forEach(reseed);
  };
  reseed(copy);
  copy.name = `${node.name} 副本`;
  const hit = findNode(node.id);
  const list = hit ? hit.siblings : state.collections;
  list.push(copy);
  touch('collections');
  refresh();
}

/* ---------------------------- ordering ---------------------------- */

/// The array *is* the order. There is deliberately no "sort mode" flag: a derived
/// sort would mean the tree and the collection runner disagree about what comes
/// next, and dragging would appear to do nothing.
function moveIn(list, from, to) {
  if (!list || from < 0 || to < 0) return false;
  const target = Math.max(0, Math.min(to, list.length - 1));
  if (target === from) return false;
  return changeList({ get: () => list, set: rows => list.splice(0, list.length, ...rows), domain: 'collections', label: '请求排序', valid: () => {
    const attached = nodes => nodes === list || nodes.some(node => node.children && attached(node.children));
    return attached(state.collections);
  } }, rows => rows.splice(target, 0, rows.splice(from, 1)[0]));
}

function committed() {
  const before = new Map([...document.querySelectorAll('#sidebar .node')].map((row) => [row.dataset.node, row.getBoundingClientRect().top]));
  touch('collections');
  refresh();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const row of document.querySelectorAll('#sidebar .node')) {
      const y = before.get(row.dataset.node);
      const delta = y === undefined ? 0 : y - row.getBoundingClientRect().top;
      if (delta) row.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  // an open runner tab lists its steps in tree order, so it has to recompute too
  emit('rerender');
}

/// Shift one step. Returns false at a boundary so the menu can grey the item out
/// rather than silently doing nothing.
function shift(id, delta) {
  const hit = findNode(id);
  if (!hit) return false;
  const list = hit.siblings;
  const from = list.indexOf(hit.node);
  if (from < 0) return false;
  if (!moveIn(list, from, from + delta)) return false;
  keepVisible(id);
  committed();
  return true;
}

export function moveSelected(delta) {
  if (state.selectedNodeIds.length !== 1) return false;
  return shift(state.selectedNodeIds[0], delta);
}

/// A collapsed ancestor would hide the row you just moved, which reads as the row
/// vanishing. Open the chain to wherever it ended up.
function keepVisible(id) {
  for (const ancestor of pathTo(id) || []) state.expanded[ancestor.id] = true;
}

function orderOf(node) {
  const hit = findNode(node.id);
  if (!hit) return { index: -1, total: 0 };
  return { index: hit.siblings.indexOf(hit.node), total: hit.siblings.length };
}

function sortByName(node) {
  const children = node.children || [];
  if (children.length < 2) return false;
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  // folders first, then the rest — a re-sorted collection should still read as a
  // tree, not as an alphabetical pile
  const folders = children.filter((child) => child.kind === 'folder');
  const rest = children.filter((child) => child.kind !== 'folder');
  folders.sort(byName);
  rest.sort(byName);
  children.splice(0, children.length, ...folders, ...rest);
  committed();
  return true;
}

let dragId = null;
/// The sibling list the dragged row came from, captured once at dragstart. A
/// dragover fires per pointer move, so re-resolving the path each time would be
/// wasted work — and an array of node references is exactly the identity we want.
let dragSiblings = null;

// Pointer sorting avoids the WebView's native drag-image and drop dispatch.
// A click stays a click until the pointer moves 6px; the entire row is draggable.
let cancelPointerDrag = null;
function startPointerDrag(event, node) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || editingId || event.target.closest('button, input, textarea, .pick-box')) return;
  cancelPointerDrag?.();
  const source = event.currentTarget;
  const origin = { x: event.clientX, y: event.clientY };
  const rect = source.getBoundingClientRect();
  let active = false;
  let ghost = null;
  let target = null;
  let point = origin;
  let frame = 0;
  let lastFrame = 0;
  let marked = null;
  event.preventDefault();

  function locate() {
    const sidebar = document.getElementById('sidebar');
    const bounds = sidebar?.getBoundingClientRect();
    target = null;
    const mark = () => {
      const next = target ? `${target.id}:${target.after}` : null;
      if (next !== marked) {
        clearDropMarks();
        if (target) document.querySelector(`#sidebar .node[data-node="${target.id}"]`)?.classList.add(target.after ? 'drop-after' : 'drop-before');
        marked = next;
      }
      if (ghost) ghost.dataset.valid = String(!!target);
    };
    if (!bounds || point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) {mark();return;}
    const over = document.elementFromPoint(point.x, point.y)?.closest('#sidebar .node');
    if (over) {
      const hit = findNode(over.dataset.node);
      if (!hit || hit.node.id === node.id) {mark();return;}
      const same = dragSiblings.includes(hit.node);
      const parent = hit.node.children === dragSiblings;
      if (!same && !parent) {mark();return;}
      const box = over.getBoundingClientRect();
      // A group's heading is above its children: dropping here means first.
      target = parent ? {id: dragSiblings[0].id, after: false} : { id: hit.node.id, after: point.y > box.top + box.height / 2 };
    } else target = emptySpaceTarget(point.y);
    mark();
  }

  function tick(now = performance.now()) {
    if (!active) return;
    ghost.style.transform = `translate3d(${point.x - origin.x}px, ${point.y - origin.y}px, 0)`;
    const scroller = document.querySelector('#sidebar .sidebar-body');
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const sidebar = document.getElementById('sidebar').getBoundingClientRect();
      if (point.x >= sidebar.left && point.x <= sidebar.right && point.y >= sidebar.top && point.y <= sidebar.bottom) {
        const speed = point.y < box.top + 28 ? -Math.min(300, (box.top + 28 - point.y) * 9) : point.y > box.bottom - 28 ? Math.min(300, (point.y - box.bottom + 28) * 9) : 0;
        if (speed) scroller.scrollTop += speed * Math.min(32, lastFrame ? now - lastFrame : 16) / 1000;
      }
    }
    lastFrame = now;
    locate();
    frame = requestAnimationFrame(tick);
  }

  function move(e) {
    if (e.pointerId !== event.pointerId) return;
    point = { x: e.clientX, y: e.clientY };
    if (!active && Math.hypot(point.x - origin.x, point.y - origin.y) >= 6) {
      active = true;
      const hit = findNode(node.id);
      dragId = node.id;
      dragSiblings = hit?.siblings || [];
      ghost = source.cloneNode(true);
      ghost.className = `${source.className.replace(/\b(selected|picked)\b/g, '')} tree-drag-ghost`;
      ghost.removeAttribute('data-node');
      ghost.removeAttribute('tabindex');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.style.paddingLeft = getComputedStyle(source).paddingLeft;
      document.body.appendChild(ghost);
      source.setPointerCapture?.(event.pointerId);
      source.classList.add('dragging-src');
      document.body.classList.add('pointer-sorting');
      document.getElementById('sidebar')?.classList.add('tree-dragging');
      tick();
    }
    if (active) e.preventDefault();
  }

  function cleanup() {
    cancelAnimationFrame(frame);
    if (source.hasPointerCapture?.(event.pointerId)) source.releasePointerCapture(event.pointerId);
    ghost?.remove();
    document.body.classList.remove('pointer-sorting');
    document.getElementById('sidebar')?.classList.remove('tree-dragging');
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('keydown', key);
    window.removeEventListener('blur', cancel);
    cancelPointerDrag = null;
  }

  function up(e) {
    if (e.pointerId !== event.pointerId) return;
    if (active) {
      point = { x: e.clientX, y: e.clientY };
      locate();
      const swallow = (click) => { click.preventDefault(); click.stopImmediatePropagation(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, true), 250);
      const drop = target;
      cleanup();
      if (drop) dragInto(drop.id, drop.after);
      else endDrag();
    } else cleanup();
  }
  function cancel() { cleanup(); endDrag(); }
  function key(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
  }
  cancelPointerDrag = cancel;
  document.addEventListener('pointermove', move, { passive: false });
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', cancel);
  document.addEventListener('keydown', key);
  window.addEventListener('blur', cancel);
}

function clearDropMarks() {
  for (const mark of document.querySelectorAll('#sidebar .drop-before, #sidebar .drop-after')) mark.classList.remove('drop-before', 'drop-after');
}

function endDrag() {
  dragId = null;
  dragSiblings = null;
  clearDropMarks();
  if (hostEl) {
    hostEl.classList.remove('tree-dragging');
    for (const src of hostEl.querySelectorAll('.dragging-src')) src.classList.remove('dragging-src');
  }
}

/// The pointer spends part of every drag in space no row owns: under the last row
/// (there is always some) and above the first one (the search box and the pane
/// head). Rows only answer dragover on themselves, so a release in either place
/// did nothing and read as "dragging is broken". Both are unambiguous: above the
/// list means "to the top of my group", below means "to the end of it".
function emptySpaceTarget(y) {
  // query the live document, not the cached host: the pane re-renders under a
  // drag more often than you would think, and a stale host reads as "no rows",
  // which silently turned "above the list" into "append to the end"
  const rows = [...document.querySelectorAll('#sidebar .node[data-node]')];
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (y >= box.top && y <= box.bottom) return null;
  }
  if (!dragSiblings || !dragSiblings.length) return null;
  const first = rows.length ? rows[0].getBoundingClientRect() : null;
  if (first && y < first.top) return { id: dragSiblings[0].id, after: false };
  const siblings = rows.filter(row => dragSiblings.some(node => node.id === row.dataset.node));
  for (const row of siblings) {
    const box = row.getBoundingClientRect();
    if (y < box.top + box.height / 2) return {id: row.dataset.node, after: false};
  }
  const last = siblings.at(-1);
  return last ? { id: last.dataset.node, after: true } : null;
}

/// Shared by the list body and the pane head above it, so the whole sidebar
/// answers the gesture rather than only the part where rows happen to be.
function answerEmptySpace(event) {
  if (!dragId) return;
  if (event.target.closest && event.target.closest('.node')) return;
  const hit = emptySpaceTarget(event.clientY);
  if (!hit) return;
  const to = findNode(hit.id);
  const own = !!to && !!dragSiblings && dragSiblings.includes(to.node);
  const container = !!to && !!to.node.children && to.node.children === dragSiblings;
  if (!own && !container) {
    event.dataTransfer.dropEffect = 'none';
    clearDropMarks();
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const scroller = hostEl ? hostEl.querySelector('.sidebar-body') : null;
  if (scroller) dragAutoScroll(scroller, event.clientY);
  clearDropMarks();
  const row = document.querySelector(`#sidebar .node[data-node="${hit.id}"]`);
  if (row) row.classList.add(hit.after ? 'drop-after' : 'drop-before');
}

function dropOnEmptySpace(event) {
  if (!dragId) return;
  if (event.target.closest && event.target.closest('.node')) return;
  const hit = emptySpaceTarget(event.clientY);
  if (!hit) return;
  const to = findNode(hit.id);
  const own = !!to && !!dragSiblings && dragSiblings.includes(to.node);
  const container = !!to && !!to.node.children && to.node.children === dragSiblings;
  if (!own && !container) return;
  event.preventDefault();
  dragInto(hit.id, hit.after);
}

/// A list you cannot scroll while dragging is a list you cannot reorder past
/// what fits on screen, so edge proximity scrolls it a step per dragover.
function dragAutoScroll(box, y) {
  const rect = box.getBoundingClientRect();
  const edge = 30;
  if (y < rect.top + edge) box.scrollTop -= 12;
  else if (y > rect.bottom - edge) box.scrollTop += 12;
}

function dragInto(targetId, after) {
  if (!dragId) return;
  const from = findNode(dragId);
  const to = findNode(targetId);
  endDrag();
  if (!from || !to) return;
  // Dropping a row on the collection/folder that contains it is not a cross-level
  // move at all — it is "put me at the end of this group", and refusing it with an
  // error toast was the single most common way a drag looked dead.
  if (to.node.children && to.node.children === from.siblings) {
    const last = from.siblings[from.siblings.length - 1];
    if (!last || last === from.node) return;
    targetId = last.id;
    after = true;
    const again = findNode(targetId);
    if (!again) return;
    return moveNodeTo(from, again, after);
  }
  if (from.siblings !== to.siblings) {
    toast('只能在同一层里排序；跨层级移动请用行菜单', 'err', 5000);
    return;
  }
  return moveNodeTo(from, to, after);
}

function moveNodeTo(from, to, after) {
  const source = from.siblings.indexOf(from.node);
  // dropping past the row you left behind shifts by one, because removing the
  // dragged node already pulled the target's index down
  const dest = after ? to.siblings.indexOf(to.node) + 1 : to.siblings.indexOf(to.node);
  const adjusted = dest > source ? dest - 1 : dest;
  if (moveIn(to.siblings, source, adjusted)) {
    keepVisible(from.node.id);
    committed();
  }
}

/// 集合、文件夹、单个请求都给这两条：想跑一条请求不该被迫把整个集合拖进来。
function runItems(anchor, node) {
  return [
    { label: '运行这一项', icon: 'send', hint: '串行跑', onSelect: () => runNodeFromTree(node) },
    { label: '加入运行计划', icon: 'plus', onSelect: () => joinPlanMenu(anchor, node) },
  ];
}

function orderItems(node) {
  const { index, total } = orderOf(node);
  const out = [
    { label: '上移', icon: 'chevU', hint: 'Alt ↑', disabled: index <= 0, onSelect: () => shift(node.id, -1) },
    { label: '下移', icon: 'chevD', hint: 'Alt ↓', disabled: index >= total - 1, onSelect: () => shift(node.id, 1) },
  ];
  // jumping a long way is what the drag is for, so the menu only carries the
  // fine-grained step — otherwise every row would open a five-item ordering block
  if (node.children && node.children.length > 1) {
    out.push({ label: '按名称排序子项', icon: 'refresh', onSelect: () => sortByName(node) });
  }
  return out;
}

function nodeMenu(anchor, node) {
  // right-clicking inside a multi-selection acts on the whole selection, the way
  // a file manager does — otherwise "删除" would silently mean one of the N
  if (pickingMode() && isPicked(node)) {
    menu(
      anchor,
      [
        { label: `删除这 ${state.selectedNodeIds.length} 项`, icon: 'trash', danger: true, onSelect: () => removeMany(state.selectedNodeIds) },
        { label: '取消选择', onSelect: () => clearPick() },
      ],
      { align: 'end' }
    );
    return;
  }
  const isCollection = node.kind === 'collection';
  const items = isCollection
    ? [
        { label: '新建请求', icon: 'plus', onSelect: () => createRequest(node) },
        { label: '新建文件夹', icon: 'folder', onSelect: () => createFolder(node) },
        { separator: true },
        ...runItems(anchor, node),
        { separator: true },
        { label: '导入 cURL 到此集合', icon: 'upload', onSelect: () => importCurlDialog(node) },
        { label: '导入 OpenAPI / HAR', icon: 'upload', onSelect: () => importFormatDialog('openapi', node) },
        { label: '导出集合', icon: 'download', onSelect: () => exportCollectionDialog(node) },
        { separator: true },
        ...orderItems(node),
        { label: '集合信息 / 变量', icon: 'gear', onSelect: () => collectionInfo(node) },
        { label: '重命名', icon: 'pencil', onSelect: () => rename(node) },
        { label: '创建副本', icon: 'copy', onSelect: () => duplicate(node) },
        { label: '删除', icon: 'trash', danger: true, onSelect: () => remove(node) },
      ]
    : [
        { label: '打开', icon: 'play', onSelect: () => openRequest(node, { replaceExisting: false }) },
        node.kind === 'folder' ? { label: '新建请求', icon: 'plus', onSelect: () => createRequest(node) } : null,
        node.kind === 'folder' ? { label: '新建文件夹', icon: 'folder', onSelect: () => createFolder(node) } : null,
        { separator: true },
        ...runItems(anchor, node),
        ...orderItems(node),
        { label: '重命名', onSelect: () => rename(node) },
        { label: '创建副本', icon: 'copy', onSelect: () => duplicate(node) },
        { label: '删除', icon: 'trash', danger: true, onSelect: () => remove(node) },
      ].filter(Boolean);
  menu(anchor, items, { align: 'end' });
}

export function collectionInfo(collection) {
  const nameInput = el('input', { class: 'input', value: collection.name });
  // plain hosts: renderKvEditor builds the `.kv` card itself, and handing it a
  // host that is already a card produced .kv > .kv — a border inside a border and
  // the empty-table hint painted twice
  const varsHost = el('div');
  const headsHost = el('div');
  // `stack`, not `inline`: the picker now hands back a single card, and a flex
  // row shrink-wraps that card to its content (217px beside a 688px table).
  const authHost = el('div', { class: 'stack' });
  modal({
    title: '集合信息',
    width: 720,
    body: [
      el('div', { class: 'field' }, [el('label', { text: '集合名称' }), nameInput]),
      el('div', { class: 'section' }, [el('h4', { text: '集合变量（优先级低于环境）' }), varsHost]),
      el('div', { class: 'section' }, [
        el('h4', { text: '默认请求头（发送时附加）' }),
        headsHost,
        el('p', {
          class: 'hint',
          text: '请求级 Header 优先。',
        }),
      ]),
      el('div', { class: 'section' }, [el('h4', { text: '集合级鉴权（请求可继承）' }), authHost]),
    ],
    okText: '保存',
    onOk: () => {
      collection.name = nameInput.value.trim() || collection.name;
      touch('collections');
      refresh();
    },
  });
  const box = document.querySelector('.modal');
  import('./kv.js').then(({ renderKvEditor }) => {
    collection.variables = collection.variables || [];
    renderKvEditor(varsHost, collection.variables, {
      labels: ['变量名', '默认值'],
      onChange: () => {
        touch('collections');
      },
    });
    collection.headers = collection.headers || [];
    renderKvEditor(headsHost, collection.headers, {
      labels: ['请求头', '值'],
      description: true,
      mode: 'headers',
      onChange: () => {
        touch('collections');
        // 请求面板里那一行「集合还会带上哪些头」得立刻跟上
        emit('rerender');
      },
    });
  });
  import('./auth.js').then(({ renderAuthPicker }) => {
    // a collection is the top of the auth chain, so "继承自集合" here would mean
    // inheriting from itself — effectiveAuth then falls through to no auth
    renderAuthPicker(authHost, collection, () => {
      touch('collections');
      // an open request's Auth badge shows the *effective* method, which may be
      // inherited from this collection
      emit('rerender');
    }, { allowInherit: false });
  });
}

function row(node, depth) {
  const isCollection = node.kind === 'collection';
  const isFolder = node.kind === 'folder';
  const openable = isCollection || isFolder;
  const selected = state.selectedNodeIds.length === 1 && state.selectedNodeIds[0] === node.id;
  const picked = isPicked(node);
  const multi = pickingMode();
  const method = (node.request && node.request.method) || (node.kind === 'ws' ? 'WS' : '');
  const badgeClass = method ? `method-${method.toLowerCase()}` : '';
  return el(
    'div',
    {
      class: `node ${isCollection ? 'node-collection' : isFolder ? 'node-folder' : 'node-request'} ${openable && isOpen(node) ? 'open' : ''} ${selected ? 'selected' : ''} ${picked ? 'picked' : ''} tree-pad-${Math.min(depth, 3)}`,
      // every row carries its node id, so "reveal this thing I just created" has
      // a handle and tests stop having to count siblings
      dataset: { node: node.id },
      onpointerdown: (event) => startPointerDrag(event, node),
      tabindex: '0',
      role: 'treeitem',
      'aria-label': `${method ? method + ' ' : ''}${node.name || '未命名'}`,
      'aria-selected': selected || picked,
      'aria-expanded': openable ? isOpen(node) : null,
      onkeydown: (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.currentTarget.click();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const rows = [...document.querySelectorAll('#sidebar .node')];
          const index = rows.indexOf(event.currentTarget);
          const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1) : rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
          next?.focus();
        } else if (openable && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          event.preventDefault();
          const wanted = event.key === 'ArrowRight';
          if (isOpen(node) !== wanted) toggle(node);
        } else if (event.key === 'F2') {
          event.preventDefault();
          rename(node);
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          nodeMenu(event.currentTarget, node);
        }
      },
      onclick: (event) => {
        if (event.ctrlKey || event.metaKey) {
          togglePick(node);
          return;
        }
        if (event.shiftKey) {
          rangePick(node);
          return;
        }
        if (openable && filter === '') {
          toggle(node);
        }
        state.selectedNodeIds = [node.id];
        if (!openable) openRequest(node);
        refresh();
      },
      oncontextmenu: (event) => {
        event.preventDefault();
        nodeMenu(event.currentTarget, node);
      },
      // same gesture as the environment list: double-click a row to rename it in
      // place rather than hunting for the menu item
      ondblclick: () => rename(node),
      // `draggable` is an enum attribute, so it needs the literal string — and an
      // inline rename must not be draggable or the text selection breaks.
      draggable: editingId === node.id ? false : 'true',
      ondragstart: (event) => {
        if (cancelPointerDrag) {event.preventDefault();return;}
        const hit = findNode(node.id);
        dragId = node.id;
        dragSiblings = hit ? hit.siblings : null;
        event.dataTransfer.effectAllowed = 'move';
        // Chromium/Windows 在拖拽数据为空时直接放弃这次拖拽 —— dragstart 会触发，
        // 但之后没有任何 dragover。合成 DragEvent 测不出来，因为只有真拖拽才走
        // 这一步；不写这行就是"测试全绿、鼠标拖不动"。
        event.dataTransfer.setData('text/relay-node', node.id);
        event.dataTransfer.setData('text/plain', node.name || node.id);
        if (hostEl) hostEl.classList.add('tree-dragging');
        // the row you are holding has to look held, or the gesture reads as dead
        event.currentTarget.classList.add('dragging-src');
      },
      ondragend: endDrag,
      ondragover: (event) => {
        if (!dragId || dragId === node.id) return;
        const sameLevel = !!dragSiblings && dragSiblings.includes(node);
        // the group that owns the dragged row is a legal target: it means
        // "append me at the end of this group", so it must not show a dead cursor
        const isContainer = !!node.children && node.children === dragSiblings;
        if (!sameLevel && !isContainer) {
          event.dataTransfer.dropEffect = 'none';
          clearDropMarks();
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const box = event.currentTarget.getBoundingClientRect();
        const after = isContainer ? true : event.clientY > box.top + box.height / 2;
        clearDropMarks();
        event.currentTarget.classList.add(after ? 'drop-after' : 'drop-before');
      },
      ondragleave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        event.currentTarget.classList.remove('drop-before', 'drop-after');
      },
      ondrop: (event) => {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        dragInto(node.id, event.clientY > box.top + box.height / 2);
      },
    },
    [
      multi
        ? el(
            'span',
            {
              class: `pick-box ${picked ? 'on' : ''}`,
              title: picked ? '取消选择' : '加入选择',
              onclick: (event) => {
                event.stopPropagation();
                togglePick(node);
              },
            },
            picked ? [icon('check')] : []
          )
        : null,
      openable
        ? el('span', { class: 'twist' }, [icon('chevR')])
        : el('span', { class: 'twist' }),
      isCollection ? icon('collections') : isFolder ? icon('folder') : null,
      method && !openable ? el('span', { class: `badge ${badgeClass}`, text: node.kind === 'ws' ? 'WS' : method.slice(0, 6) }) : null,
      editingId === node.id
        ? el('input', {
            class: 'node-rename',
            value: node.name || '',
            onclick: (event) => event.stopPropagation(),
            ondblclick: (event) => event.stopPropagation(),
            oninput: (event) => {
              event.stopPropagation();
            },
            onkeydown: (event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                commitRename(node, event.target.value, false);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                commitRename(node, node.name, true);
              }
            },
            onblur: (event) => commitRename(node, event.target.value, false),
          })
        : el('span', { class: 'name', text: node.name || (isCollection ? '未命名集合' : '未命名请求') }),
      node.protocol === 'sse' ? el('span', { class: 'count', text: 'SSE' }) : null,
      el(
        'span',
        { class: 'node-actions' },
        [
          el('button', {
            title: '更多',
            text: '⋯',
            onclick: (event) => {
              event.stopPropagation();
              nodeMenu(event.currentTarget, node);
            },
          }),
        ]
      ),
    ]
  );
}

function renderNodes(nodes, depth, host) {
  for (const node of nodes) {
    if (!matches(node)) continue;
    visibleOrder.push(node.id);
    host.appendChild(row(node, depth));
    const kids = node.children || [];
    if (kids.length && (isOpen(node) || filter)) renderNodes(kids, depth + 1, host);
  }
}

function newMenu(anchor) {
  const last = state.selectedNodeIds[state.selectedNodeIds.length - 1];
  const hit = last ? findNode(last) : null;
  const target = hit ? requestTarget(hit.node) : null;
  const where = target ? target.name : '我的 API';
  menu(
    anchor,
    [
      { label: '集合', icon: 'collections', hint: '顶层', onSelect: () => createCollection('新建集合') },
      { label: '请求', icon: 'plus', hint: `放入 ${where}`, onSelect: () => createRequest(hit ? hit.node : null) },
      { label: '文件夹', icon: 'folder', hint: `放入 ${where}`, onSelect: () => createFolder(target) },
      { label: 'WebSocket 连接', icon: 'ws', hint: '标签页', onSelect: () => newTab('ws') },
      { separator: true },
      { label: '运行计划', icon: 'play', hint: '跨集合串行 / 定时', onSelect: () => createRunner() },
      { label: '导入 cURL', icon: 'upload', hint: 'Ctrl+I', onSelect: () => importCurlDialog() },
    ],
    { align: 'end' }
  );
}

export function render(host) {
  if (!host) return;
  hostEl = host;
  visibleOrder = [];
  const multi = pickingMode();
  host.replaceChildren(
    el('div', {
      class: 'sidebar-head',
      style: { flexDirection: 'column', gap: '7px', alignItems: 'stretch' },
      // "drag it above the list" is how you move something to the top of its
      // group, and the head is what is actually there — so the head answers
      ondragover: answerEmptySpace,
      ondrop: dropOnEmptySpace,
    }, [
      el('div', { class: 'inline', style: { justifyContent: 'space-between' } },
        multi
          ? [
              el('span', { class: 'sidebar-title', text: `已选 ${state.selectedNodeIds.length} 项` }),
              el('div', { class: 'btn-row' }, [
                el(
                  'button',
                  {
                    class: 'btn sm danger',
                    title: '删除选中的每一项（Delete）',
                    onclick: () => removeMany(state.selectedNodeIds),
                  },
                  [icon('trash'), el('span', { text: '删除' })]
                ),
                el('button', { class: 'btn sm', text: '取消', title: 'Esc', onclick: () => clearPick() }),
              ]),
            ]
          : [
              el('span', { class: 'sidebar-title', text: '集合' }),
              el(
                'button',
                {
                  class: 'btn sm primary',
                  title: '新建集合、文件夹或请求',
                  onclick: (event) => newMenu(event.currentTarget),
                },
                [icon('plus'), el('span', { text: '新建' })]
              ),
            ]
      ),
      el('div', { class: 'search' }, [
        el('input', {
          class: 'input',
          placeholder: '搜索集合 / 请求',
          value: filter,
          oninput: (event) => setFilter(event.target.value),
        }),
      ]),
    ]),
    el(
      'div',
      {
        class: 'sidebar-body',
        role: 'tree',
        'aria-label': '集合和请求',
        // rows answer dragover on themselves; the host answers everywhere else
        // (the empty stretch under the list and the head above it) and keeps the
        // list scrolling while the pointer is near an edge
        ondragover: answerEmptySpace,
        ondrop: dropOnEmptySpace,
        ondragleave: (event) => {
          if (event.currentTarget.contains(event.relatedTarget)) return;
          clearDropMarks();
        },
      },
      state.collections.length
        ? (() => {
            const box = el('div');
            renderNodes(state.collections, 0, box);
            return box.childNodes.length ? box : el('p', { class: 'hint', text: '没有匹配项。' });
          })()
        : [
            el('div', { class: 'empty', style: { height: 'auto', padding: '40px 16px' } }, [
              el('h3', { text: '还没有集合' }),

              el('div', { class: 'btn-row', style: { justifyContent: 'center' } }, [
                el('button', { class: 'btn primary sm', text: '新建集合', onclick: () => createCollection('我的 API') }),
                el('button', { class: 'btn sm', text: '导入 cURL', onclick: () => importCurlDialog() }),
              ]),
            ]),
          ]
    )
  );
}

export { createRequest, rename as renameNode, remove as removeNode };
