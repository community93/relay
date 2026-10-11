import { state, touch, flushDomain, emit } from './state.js';
import { changeList } from './undo.js';

let cancelSort = null;

// Flat sidebar lists share pointer sorting, while the collection tree keeps its
// own nesting rules. The persisted array is also the order used by pickers.
export function sortableRow(domain, item, onReorder) {
  const rows = () => [...document.querySelectorAll(`#sidebar [data-sort-domain="${domain}"]`)];
  const rowOf = id => rows().find(row => row.dataset.sortId === id);

  function commit(targetId, after) {
    const list = state[domain];
    const from = list.findIndex(entry => entry.id === item.id);
    const target = list.findIndex(entry => entry.id === targetId);
    if (from < 0 || target < 0) return;
    const insertion = target + (after ? 1 : 0);
    const to = insertion > from ? insertion - 1 : insertion;
    if (from === to) return;
    const scroll = document.querySelector('#sidebar .sidebar-body')?.scrollTop || 0;
    changeList({ get: () => state[domain], set: rows => { state[domain] = rows; }, domain, label: '侧栏排序', refresh: onReorder }, rows => rows.splice(to, 0, rows.splice(from, 1)[0]));
    flushDomain(domain);
    emit('tree');
    onReorder?.();
    if (state.overviewPane) emit('rerender');
    const scroller = document.querySelector('#sidebar .sidebar-body');
    if (scroller) scroller.scrollTop = scroll;
    rowOf(item.id)?.focus({ preventScroll: true });
  }

  return {
    'data-sort-domain': domain,
    'data-sort-id': item.id,
    tabindex: '0',
    role: 'button',
    'aria-label': item.name || '未命名',
    'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
    onkeydown: event => {
      if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey) return;
      if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const list = state[domain], index = list.findIndex(entry => entry.id === item.id);
        const target = list[index + (event.key === 'ArrowUp' ? -1 : 1)];
        if (target) commit(target.id, event.key === 'ArrowDown');
      } else if (!event.altKey && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); event.currentTarget.click();
      } else if (!event.altKey && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const list = rows(), index = list.indexOf(event.currentTarget);
        const next = event.key === 'Home' ? list[0] : event.key === 'End' ? list.at(-1) : list[index + (event.key === 'ArrowUp' ? -1 : 1)];
        next?.focus();
      }
    },
    onpointerdown: event => {
      if (event.button !== 0 || event.isPrimary === false || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.target.closest('button, input, textarea, select, [contenteditable="true"]')) return;
      cancelSort?.();
      const sidebar = document.getElementById('sidebar');
      const source = event.currentTarget, pane = state.pane;
      const origin = { x: event.clientX, y: event.clientY };
      let point = origin, active = false, ghost = null, target = null, frame = 0, lastFrame = 0;
      event.preventDefault();
      source.focus({ preventScroll: true });

      function clearMarks() {
        rows().forEach(row => row.classList.remove('drop-before', 'drop-after', 'dragging-src'));
      }

      function locate() {
        clearMarks(); target = null;
        const bounds = sidebar.getBoundingClientRect();
        if (point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom) {
          const list = rows();
          const over = list.find(row => { const box = row.getBoundingClientRect(); return point.y >= box.top && point.y <= box.bottom; });
          const before = list.find(row => { const box = row.getBoundingClientRect(); return point.y < box.top + box.height / 2; });
          const row = over || before || list.at(-1);
          if (row) {
            const box = row.getBoundingClientRect();
            const after = over ? point.y >= box.top + box.height / 2 : !before;
            target = { id: row.dataset.sortId, after }; row.classList.add(after ? 'drop-after' : 'drop-before');
          }
        }
        rowOf(item.id)?.classList.add('dragging-src');
        if (ghost) ghost.dataset.valid = String(!!target);
      }

      function tick(now = performance.now()) {
        if (!active) return;
        // Run progress can rebuild rows mid-drag; capture belongs to the stable
        // sidebar, and targets are resolved from the current DOM every frame.
        if (!sidebar.isConnected || state.pane !== pane || !rowOf(item.id)) { cancel(); return; }
        ghost.style.transform = `translate3d(${point.x - origin.x}px, ${point.y - origin.y}px, 0)`;
        const scroller = sidebar.querySelector('.sidebar-body');
        if (scroller) {
          const box = scroller.getBoundingClientRect(), bounds = sidebar.getBoundingClientRect();
          if (point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom) {
            const speed = point.y < box.top + 28 ? -Math.min(300, (box.top + 28 - point.y) * 9) : point.y > box.bottom - 28 ? Math.min(300, (point.y - box.bottom + 28) * 9) : 0;
            scroller.scrollTop += speed * Math.min(32, lastFrame ? now - lastFrame : 16) / 1000;
          }
        }
        lastFrame = now; locate(); frame = requestAnimationFrame(tick);
      }

      function move(e) {
        if (e.pointerId !== event.pointerId) return;
        point = { x: e.clientX, y: e.clientY };
        if (!active && Math.hypot(point.x - origin.x, point.y - origin.y) >= 6) {
          if (state.pane !== pane || !source.isConnected) { cancel(); return; }
          active = true;
          const box = source.getBoundingClientRect();
          ghost = source.cloneNode(true);
          ghost.className = 'node tree-drag-ghost list-drag-ghost';
          for (const attr of [...ghost.attributes]) if (attr.name.startsWith('data-') || ['id', 'tabindex', 'role'].includes(attr.name)) ghost.removeAttribute(attr.name);
          ghost.setAttribute('aria-hidden', 'true');
          Object.assign(ghost.style, { left: `${box.left}px`, top: `${box.top - box.height / 2 - 12}px`, width: `${box.width}px`, height: `${box.height}px`, paddingLeft: getComputedStyle(source).paddingLeft });
          document.body.append(ghost);
          sidebar.setPointerCapture?.(event.pointerId);
          document.body.classList.add('pointer-sorting');
          tick();
        }
        if (active) e.preventDefault();
      }

      function suppressClick() {
        const swallow = click => {
          if (click.pointerId !== undefined && click.pointerId !== event.pointerId) return;
          click.preventDefault(); click.stopImmediatePropagation();
          document.removeEventListener('click', swallow, true);
        };
        document.addEventListener('click', swallow, true);
        setTimeout(() => document.removeEventListener('click', swallow, true), 250);
      }

      function cleanup() {
        cancelAnimationFrame(frame);
        if (sidebar.hasPointerCapture?.(event.pointerId)) sidebar.releasePointerCapture(event.pointerId);
        clearMarks(); ghost?.remove(); document.body.classList.remove('pointer-sorting');
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', cancel);
        document.removeEventListener('keydown', key, true);
        window.removeEventListener('blur', cancel);
        cancelSort = null;
      }

      function up(e) {
        if (e.pointerId !== event.pointerId) return;
        if (active) {
          point = { x: e.clientX, y: e.clientY }; locate(); suppressClick();
          const drop = state.pane === pane ? target : null;
          cleanup(); if (drop) commit(drop.id, drop.after);
        } else cleanup();
      }
      function cancel() { if (active) suppressClick(); cleanup(); }
      function key(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } }
      cancelSort = cancel;
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', cancel);
      document.addEventListener('keydown', key, true);
      window.addEventListener('blur', cancel);
    },
  };
}
