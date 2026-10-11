import { el, icon } from './ui.js';

let open = null;
let opener = null;

function normalise(list) {
  return (list || []).map((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      // hint survives because a picker listing same-named requests from different
      // folders is unusable without the path next to each one
      return {
        value: String(item.value ?? ''),
        label: String(item.label ?? item.text ?? item.value ?? ''),
        hint: item.hint ? String(item.hint) : '',
      };
    }
    if (Array.isArray(item)) return { value: String(item[0]), label: String(item[1] ?? item[0]), hint: '' };
    return { value: String(item), label: String(item), hint: '' };
  });
}

/// A choice control that is not <select>. The closed box can be styled, but the
/// moment it opens Windows hands the list to the OS: a white, unthemed popup with
/// its own metrics, floating over a dark app. This renders the same .menu every
/// other popover uses, so the list is on-theme, and keeps the parts callers rely
/// on — .value, .disabled, .setOptions() — and the .select class, so the existing
/// contextual rules (borderless inside a row, small in a bar) still apply.
export function selectField({
  value = '',
  options = [],
  onChange = null,
  disabled = false,
  title = '',
  className = '',
  placeholder = '',
} = {}) {
  let items = normalise(options);
  let current = String(value ?? '');

  const btn = el('button', {
    type: 'button',
    class: `select select-field ${className}`.trim(),
    title,
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  });

  const labelFor = (v) => {
    const hit = items.find((item) => item.value === String(v));
    return hit ? hit.label : String(v || placeholder);
  };
  const paint = () => {
    btn.replaceChildren(el('span', { class: 'select-text', text: labelFor(current) }));
    btn.title = title || labelFor(current);
    btn.dataset.value = current;
  };

  btn.setOptions = (list) => {
    items = normalise(list);
    if (!items.some((item) => item.value === current)) current = items.length ? items[0].value : '';
    paint();
  };
  Object.defineProperty(btn, 'value', {
    get: () => current,
    set: (next) => {
      current = String(next ?? '');
      paint();
    },
    configurable: true,
  });
  Object.defineProperty(btn, 'disabled', {
    get: () => btn.hasAttribute('disabled'),
    set: (flag) => {
      if (flag) btn.setAttribute('disabled', '');
      else btn.removeAttribute('disabled');
    },
    configurable: true,
  });

  btn.onclick = () => {
    if (btn.disabled) return;
    btn.setAttribute('aria-expanded', 'true');
    menu(btn, items.map((item) => ({
      label: item.label,
      value: item.value,
      // hint has to come through, or a picker that lists same-named items from
      // different folders cannot say which is which
      hint: item.hint,
      selected: item.value === current,
      onSelect: () => {
        btn.setAttribute('aria-expanded', 'false');
        if (item.value === current) return;
        current = item.value;
        paint();
        onChange && onChange(item.value);
      },
    })));
  };

  btn.disabled = disabled;
  paint();
  return btn;
}

export function closeMenu() {
  if (!open) return;
  const back = opener;
  open.remove();
  open = null;
  opener = null;
  // A menu opened from the keyboard belongs to the control that spawned it, so
  // focus has to come back there rather than vanish into the body.
  if (back && document.contains(back) && back !== document.activeElement) {
    try {
      back.focus({ preventScroll: true });
    } catch (error) {
      /* the anchor may no longer accept focus */
    }
  }
}

/// Anchored dropdown. `items` is [{ label, danger, disabled, icon, selected, onSelect }]
/// and supports { separator: true } for a rule. All look comes from .menu in
/// app.css so every popover in the app is the same object.
/// An item may also carry { onSide, sideIcon, sideTitle }: a quiet button pinned
/// to the right of the row for the action that is *not* the row's main verb —
/// picking an environment versus going to configure it, for instance.
/// `selected` marks the row that is already true — the listbox behaviour the
/// replacement for <select> depends on.
/// The list takes focus and answers arrows / Home / End / Enter / Escape, so a
/// menu is reachable without a mouse.
export function menu(anchor, items, { align = 'start' } = {}) {
  closeMenu();
  const rows = [];
  const list = el(
    'div',
    { class: `menu ${align === 'end' ? 'menu-end' : ''}`, style: { position: 'fixed' }, tabindex: '-1' },
    items.map((item, index) =>
      item.separator
        ? el('div', { class: 'menu-sep' })
        : el(
            'div',
            {
              class: `menu-item ${item.danger ? 'danger' : ''} ${item.disabled ? 'disabled' : ''} ${
                item.selected ? 'on' : ''
              } ${item.itemClass || ''}`,
              role: 'menuitem',
              'aria-disabled': item.disabled ? 'true' : 'false',
              // A listbox row carries its own value so callers (and the E2E
              // suite) can pick by value instead of matching visible text.
              'data-value': item.value === undefined ? null : String(item.value),
              onclick: (event) => {
                event.stopPropagation();
                if (item.disabled) return;
                closeMenu();
                item.onSelect && item.onSelect();
              },
            },
            [
              item.icon ? icon(item.icon) : null,
              el('span', { class: 'menu-label', text: item.label, title: item.label }),
              item.hint ? el('span', { class: 'menu-hint', text: item.hint }) : null,
              item.selected ? el('span', { class: 'menu-mark', 'aria-hidden': 'true' }, [icon('check')]) : null,
              item.onSide
                ? el(
                    'button',
                    {
                      class: 'menu-side',
                      type: 'button',
                      title: item.sideTitle || '设置',
                      'aria-label': item.sideTitle || '设置',
                      onclick: (event) => {
                        event.stopPropagation();
                        closeMenu();
                        item.onSide();
                      },
                    },
                    [icon(item.sideIcon || 'gear')]
                  )
                : null
            ]
          )
    )
  );
  for (const node of list.querySelectorAll('.menu-item')) {
    if (!node.classList.contains('disabled')) rows.push(node);
  }
  document.body.appendChild(list);
  const rect = anchor.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  const left = align === 'end' ? rect.right - box.width : rect.left;
  list.style.left = `${Math.max(6, Math.min(left, window.innerWidth - box.width - 6))}px`;
  list.style.top = `${Math.max(6, Math.min(rect.bottom + 6, window.innerHeight - box.height - 6))}px`;
  open = list;
  opener = anchor;

  let cursor = rows.findIndex((row) => row.classList.contains('on'));
  if (cursor < 0) cursor = 0;
  const paint = () => {
    rows.forEach((row, at) => row.classList.toggle('cursor', at === cursor));
    rows[cursor] && rows[cursor].scrollIntoView({ block: 'nearest' });
  };
  const activate = () => {
    const row = rows[cursor];
    if (!row) return;
    row.click();
  };
  list.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = (cursor + 1) % Math.max(rows.length, 1);
      paint();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = (cursor - 1 + rows.length) % Math.max(rows.length, 1);
      paint();
    } else if (event.key === 'Home') {
      event.preventDefault();
      cursor = 0;
      paint();
    } else if (event.key === 'End') {
      event.preventDefault();
      cursor = Math.max(rows.length - 1, 0);
      paint();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      closeMenu();
    }
  });
  paint();
  list.focus({ preventScroll: true });
  setTimeout(() => {
    const dismiss = (event) => {
      if (open && !open.contains(event.target)) {
        closeMenu();
        document.removeEventListener('mousedown', dismiss, true);
      }
    };
    document.addEventListener('mousedown', dismiss, true);
  }, 0);
  return list;
}
