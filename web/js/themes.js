import { state, touch, emit } from './state.js';
import { el, icon } from './ui.js';
import { menu } from './menu.js';

export const THEMES = [
  { id: 'mint', name: '薄荷', color: '#08645d', paper: '#eef6f2' },
  { id: 'sky', name: '晴空', color: '#285d91', paper: '#edf4fc' },
  { id: 'iris', name: '雾紫', color: '#6a4d91', paper: '#f3eff9' },
  { id: 'peach', name: '桃杏', color: '#a04c43', paper: '#fcf1ed' },
  { id: 'cream', name: '奶油', color: '#80601e', paper: '#f8f4e8' },
  { id: 'slate', name: '石板', color: '#3451b2', paper: '#eef1fa' },
];

export function applyAppearance({ theme = state.settings.theme, palette = state.settings.palette } = {}) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.palette = THEMES.some(item => item.id === palette) ? palette : 'mint';
}

export function appearancePicker(current, onChange) {
  const grid = el('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': '主题配色' });
  const buttons = THEMES.map(item => el('button', {
    class: 'theme-card', type: 'button', role: 'radio', 'aria-label': item.name,
    dataset: { palette: item.id }, style: { '--preview-accent': item.color, '--preview-paper': item.paper },
    onclick: () => { select(item.id); onChange(item.id); },
  }, [
    el('span', { class: 'theme-preview', 'aria-hidden': 'true' }, [
      el('span', { class: 'theme-preview-nav' }, [el('i'), el('i'), el('i')]),
      el('span', { class: 'theme-preview-main' }, [el('i', { class: 'theme-preview-tab' }), el('i', { class: 'theme-preview-url' }), el('span', { class: 'theme-preview-code' }, [el('i'), el('i'), el('i')])]),
    ]),
    el('span', { class: 'theme-card-foot' }, [el('span', { text: item.name }), el('span', { class: 'theme-card-check', 'aria-hidden': 'true' }, [icon('check')])]),
  ]));
  function select(id) {
    buttons.forEach((button, index) => { const selected = THEMES[index].id === id; button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1; });
  }
  grid.append(...buttons); select(current || 'mint');
  grid.addEventListener('keydown', event => {
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + delta + buttons.length) % buttons.length;
    buttons[next].click(); buttons[next].focus();
  });
  return grid;
}

export function themeMenu(anchor) {
  menu(anchor, [
    ...THEMES.map(item => ({ label: item.name, selected: (state.settings.palette || 'mint') === item.id, onSelect: () => { state.settings.palette = item.id; applyAppearance(); touch('settings'); emit('theme'); } })),
    { separator: true },
    { label: state.settings.theme === 'dark' ? '使用浅色' : '使用深色', hint: 'Ctrl /', onSelect: () => { state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark'; applyAppearance(); touch('settings'); emit('theme'); } },
  ]);
}
