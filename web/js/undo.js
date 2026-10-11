import { emit, touch } from './state.js';
import { toast } from './ui.js';

const past = [], future = [];
const matches = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);

export function changeList({ get, set, domain, label, valid = () => true, refresh, selector }, mutate) {
  const before = [...get()], after = [...before];
  mutate(after);
  if (matches(before, after)) return false;
  const apply = list => {
    const positions = new Map(selector ? [...document.querySelectorAll(selector)].map(node => [Number(node.dataset.orderIndex), node.getBoundingClientRect().top]) : []);
    const old = [...get()];
    set([...list]); touch(domain); emit('tree'); emit('rerender'); refresh?.();
    if (selector && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const used = new Set();
      document.querySelectorAll(selector).forEach(node => {
        const index = Number(node.dataset.orderIndex), previous = old.findIndex((item, at) => item === list[index] && !used.has(at));
        used.add(previous);
        const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1;
        const delta = (positions.get(previous) - node.getBoundingClientRect().top) / zoom;
        if (Number.isFinite(delta) && delta) node.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 140, easing: 'cubic-bezier(.2,.7,.2,1)' });
      });
    }
  };
  apply(after);
  past.push({ label, valid, get, apply, before, after });
  if (past.length > 100) past.shift();
  future.length = 0;
  emit('undo-state');
  return true;
}

export function undo(redo = false) {
  const source = redo ? future : past, destination = redo ? past : future;
  let command;
  while ((command = source.pop())) {
    if (!command.valid() || !matches(command.get(), redo ? command.before : command.after)) continue;
    command.apply(redo ? command.after : command.before);
    destination.push(command);
    toast(`${redo ? '已重做' : '已撤销'}${command.label}`, 'ok', 1800);
    emit('undo-state');
    return true;
  }
  emit('undo-state');
  return false;
}

export function undoState() { return { undo: past.at(-1)?.label, redo: future.at(-1)?.label }; }
