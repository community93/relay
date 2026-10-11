import { el, icon } from './ui.js';
import { changeList } from './undo.js';

let cancelDrag;

// Indices identify occurrences, so a plan can contain the same request twice.
// A changed source list cancels the gesture rather than moving a stale index.
export function reorderHandle(index, config) {
  const { selector, get, name = '排序' } = config;
  const commit = (from, to) => {
    const moved = changeList(config, list => list.splice(to, 0, list.splice(from, 1)[0]));
    if (moved) requestAnimationFrame(() => document.querySelector(`${selector}[data-order-index="${to}"] .reorder-handle`)?.focus({ preventScroll: true }));
  };
  return el('button', {
    class: 'reorder-handle', type: 'button', title: `${name}（Alt+↑/↓）`, 'aria-label': name,
    'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
    onclick: event => event.stopPropagation(),
    onkeydown: event => {
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const to = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < get().length) commit(index, to);
    },
    onpointerdown: event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault(); event.stopPropagation(); cancelDrag?.();
      const handle = event.currentTarget, origin = { x: event.clientX, y: event.clientY }, original = [...get()];
      const row = handle.closest(selector), scroller = row?.closest('.pane-scroll');
      if (!row || !scroller) return;
      let point = origin, active = false, destination = null, frame, ghost;
      handle.focus({ preventScroll: true });
      const rows = () => [...document.querySelectorAll(selector)];
      const valid = () => row.isConnected && (!config.valid || config.valid()) && get().length === original.length && get().every((item, i) => item === original[i]);
      const clear = () => rows().forEach(node => node.classList.remove('drop-before', 'drop-after', 'dragging-src'));
      const locate = () => {
        clear(); destination = null;
        const box = scroller.getBoundingClientRect();
        if (point.x < box.left || point.x > box.right || point.y < box.top || point.y > box.bottom) return;
        const candidates = rows();
        const over = candidates.find(node => { const b = node.getBoundingClientRect(); return point.y >= b.top && point.y <= b.bottom; });
        const before = candidates.find(node => point.y < node.getBoundingClientRect().top);
        const target = over || before || candidates.at(-1);
        if (!target) return;
        const after = over ? point.y >= target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2 : !before;
        const insertion = Number(target.dataset.orderIndex) + Number(after);
        destination = insertion > index ? insertion - 1 : insertion;
        target.classList.add(after ? 'drop-after' : 'drop-before'); row.classList.add('dragging-src');
      };
      const tick = () => {
        if (!valid()) { finish(false); return; }
        const box = scroller.getBoundingClientRect();
        if (point.x >= box.left && point.x <= box.right) {
          const speed = point.y < box.top + 36 ? -8 : point.y > box.bottom - 36 ? 8 : 0;
          scroller.scrollTop += speed;
        }
        ghost.style.transform = `translate(${point.x-origin.x}px, ${point.y-origin.y}px)`;
        locate(); frame = requestAnimationFrame(tick);
      };
      const move = e => {
        if (e.pointerId !== event.pointerId) return;
        point = { x: e.clientX, y: e.clientY };
        if (!active && Math.hypot(point.x-origin.x, point.y-origin.y) >= 6) {
          active = true;
          const box = row.getBoundingClientRect();
          // A compact text ghost avoids cloning editable fields or their IDs.
          ghost = el('div', { class: 'content-sort-ghost', 'aria-hidden': 'true', text: row.querySelector('.name, .delivery-endpoint-title, .md-body')?.value || row.querySelector('.name, .delivery-endpoint-title, .md-body')?.textContent || name });
          const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
          Object.assign(ghost.style, { zoom: String(1 / zoom), left: `${box.left}px`, top: `${point.y-18}px`, width: `${Math.min(box.width, 380)}px` });
          document.body.append(ghost); document.body.classList.add('pointer-sorting'); tick();
        }
        if (active) e.preventDefault();
      };
      const finish = drop => {
        const to = destination, canMove = valid();
        cancelAnimationFrame(frame); clear(); ghost?.remove(); document.body.classList.remove('pointer-sorting');
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancel);
        cancelDrag = null;
        if (drop && active && canMove && to !== null && to !== index) commit(index, to);
      };
      const up = e => { if (e.pointerId === event.pointerId) { point = { x: e.clientX, y: e.clientY }; if (active) locate(); finish(true); } };
      const cancel = () => finish(false);
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); } };
      cancelDrag = cancel;
      document.addEventListener('pointermove', move, { passive: false }); document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key, true); window.addEventListener('blur', cancel);
    },
  }, [icon('grip')]);
}
