// Small DOM helpers plus the two global overlays (toasts, modals).

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    // `aria-*` is tri-state. The generic rule below drops `false` and writes
    // `true` as "", which for a boolean ARIA value means a screen reader gets
    // neither "checked" nor "unchecked" — just silence. Spell both out instead.
    if (key.startsWith('aria-')) {
      if (value === null || value === undefined) continue;
      node.setAttribute(key, value === true ? 'true' : value === false ? 'false' : String(value));
      continue;
    }
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset' && typeof value === 'object') {
      for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = dataValue;
    } else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) {
        // Object.assign cannot reach custom properties; they need setProperty
        if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
        else node.style[prop] = val;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') node[key] = !!value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function frag(children) {
  const f = document.createDocumentFragment();
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    f.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return f;
}

/// The geometric R shares its path with make_icons.py and the native assets.
export const BRAND_SVG =
  '<svg viewBox="0 0 1024 1024" fill="currentColor" fill-rule="evenodd" aria-hidden="true">' +
  '<path d="M300 738V286H538C670 286 742 349 742 445C742 536 672 600 546 600H406V738H300Z M406 382V504H534C599 504 636 486 636 444C636 402 599 382 534 382H406Z"/><path d="M520 638H646L754 738H612Z"/></svg>';

const SOLID_GLYPHS = new Set(['stop']);

export function icon(name) {
  // One 24-grid, one stroke weight, round joins — the shapes matter more than
  // their meaning here, since a mixed set is what makes a UI feel cheap.
  const paths = {
    collections: 'm12 2.5 9 4.7-9 4.7-9-4.7 9-4.7ZM3 12.2l9 4.7 9-4.7M3 16.9l9 4.7 9-4.7',
    history: 'M3.5 9.5A9 9 0 1 1 3 12M3 4.5V9h4.5M12 7.5V12l3.2 2',
    ws: 'M4 8.5h13m0 0-3.5-3.5M17 8.5l-3.5 3.5M20 15.5H7m0 0 3.5-3.5M7 15.5l3.5 3.5',
    plus: 'M12 5v14M5 12h14',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.4-4.4',
    gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm8.4-3.2c0-.6-.06-1.1-.16-1.6l2.02-1.5-1.9-3.3-2.4.9a8.6 8.6 0 0 0-2.7-1.5L14.9 2.4h-3.8l-.44 2.6a8.6 8.6 0 0 0-2.7 1.5l-2.4-.9-1.9 3.3 2.02 1.5a8.5 8.5 0 0 0 0 3.2L3.66 16.1l1.9 3.3 2.4-.9a8.6 8.6 0 0 0 2.7 1.5l.44 2.6h3.8l.44-2.6a8.6 8.6 0 0 0 2.7-1.5l2.4.9 1.9-3.3-2.02-1.5c.1-.5.16-1.05.16-1.6Z',
    download: 'M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M4.5 19.5h15',
    save: 'M5 3.5h12l3.5 3.5v13H3.5V5A1.5 1.5 0 0 1 5 3.5ZM7 3.5v6h9v-6M7 20v-7h10v7',
    upload: 'M12 15V4m0 0 4.5 4.5M12 4 7.5 8.5M4.5 19.5h15',
    flame: 'M12 21.5a7 7 0 0 0 7-7c0-5-4.2-6.7-4.2-11.5 0 0-2.4 1.7-3.4 5.2-1.2-2-2.9-3.4-2.9-3.4-.6 3.3-3.5 4.7-3.5 9.7a7 7 0 0 0 7 7Z',
    env: 'M9.5 3h5M10.5 3v6.6L5.4 18.2A2 2 0 0 0 7.1 21h9.8a2 2 0 0 0 1.7-2.8l-5.1-8.6V3',
    close: 'M18 6 6 18M6 6l12 12',
    chevR: 'm9.5 5.5 6.5 6.5-6.5 6.5',
    chevU: 'm5.5 14.5 6.5-6.5 6.5 6.5',
    chevD: 'm5.5 9.5 6.5 6.5 6.5-6.5',
    bolt: 'M13 2.5 3.5 14.5H12l-1 7 10.5-12H13l1-7Z',
    copy: 'M8.5 8.5h10a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 7 20V10a1.5 1.5 0 0 1 1.5-1.5ZM5 15.5H4.5A1.5 1.5 0 0 1 3 14V4.5A1.5 1.5 0 0 1 4.5 3H14a1.5 1.5 0 0 1 1.5 1.5V5',
    trash: 'M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7m-8.8 0 .9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10.2 11v6M13.8 11v6',
    dots: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
    grip: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4',
    play: 'M8 5.2v13.6L19 12 8 5.2Z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 6.8V12l3.6 2.2',
    stop: 'M8 8h8v8H8z',
    send: 'M21.5 2.5 3 10l7.2 2.8L13 20l8.5-17.5ZM10.2 12.8l4.6-4.6',
    refresh: 'M20.5 12a8.5 8.5 0 1 1-2.5-6M20.5 3v6h-6',
    check: 'm4.5 12.5 5 5 10-11',
    file: 'M14 3v5.5h5.5M6 3h8l5.5 5.5V21H6V3Z',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2.2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
    pencil: 'M12 20.5h8.5M16.4 3.6a2.2 2.2 0 0 1 3.1 3.1L7 19.2l-4 1 1-4L16.4 3.6Z',
    terminal: 'M4 17l6-5.5L4 6M12.5 19H20',
    wrap: 'M4 6h16M4 11h12a4 4 0 0 1 0 8h-4m0 0 3-3m-3 3 3 3M4 16h3',
    code: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16',
    braces: 'M9 4.5C7.2 4.5 6.6 5.4 6.6 7v2.2c0 1.4-.8 2.3-2.1 2.8 1.3.5 2.1 1.4 2.1 2.8V17c0 1.6.6 2.5 2.4 2.5M15 4.5c1.8 0 2.4.9 2.4 2.5v2.2c0 1.4.8 2.3 2.1 2.8-1.3.5-2.1 1.4-2.1 2.8V17c0 1.6.6 2.5-2.4 2.5',
    trash2: 'M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7m-8.8 0 .9 12.1A1.5 1.5 0 0 0 8.9 20.5h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7',
    minimize: 'M5 12h14',
    maximize: 'M6 5.5h12a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 6 5.5Z',
    restore: 'M8.5 8.5h10a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 7 19v-9a1.5 1.5 0 0 1 1.5-1.5ZM5 15.5h-.5A1.5 1.5 0 0 1 3 14V4.5A1.5 1.5 0 0 1 4.5 3H14a1.5 1.5 0 0 1 1.5 1.5V5',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  // Explicit attributes keep an icon in an unsized container from falling back to
  // the 300x150 default; CSS still overrides these.
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // A stop square is an object, not an outline — unstroked it reads as an empty
  // checkbox. Filling it and keeping the same-coloured stroke also rounds the
  // corners, so it stays in the same family as the rest of the set.
  if (SOLID_GLYPHS.has(name)) svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] || paths.file);
  svg.appendChild(path);
  return svg;
}

/// One entry point for "the screen just changed shape": Chromium snapshots both
/// sides and animates between them, so tab and theme changes read as motion
/// instead of a hard cut. Falls back to a plain update when unsupported.
/// `delay` staggers the incoming layer, which is what turns a crossfade into the
/// iOS fade-through instead of two screens mushing together.
const MORPH = {
  fade: ['vt-out', 'vt-in', 160, 0],
  theme: ['vt-theme-out', 'vt-theme-in', 220, 0],
  'slide-left': ['vt-push-out-left', 'vt-push-in-left', 180, 0],
  'slide-right': ['vt-push-out-right', 'vt-push-in-right', 180, 0],
};
// A tab or rail change only swaps the workspace, so only the workspace should
// move; a theme change repaints every surface, so that one keeps the full screen.
const REGION = { fade: true, 'slide-left': true, 'slide-right': true, theme: false };
let activeTransition = null;
let transitionVersion = 0;

export function morph(update, kind = 'fade', event) {
  const version = ++transitionVersion;
  activeTransition?.skipTransition();
  // Navigation updates immediately. The new pane owns a small arrival motion;
  // snapshotting the workspace here blocks input and freezes live streams.
  if (REGION[kind]) { update(); return null; }
  const [out, inn, ms, delay] = MORPH[kind] || MORPH.fade;
  // scripted clicks skip the snapshot so callers still see the DOM change in the
  // same task; only a real pointer gets the animation
  const trusted = !event || event.isTrusted !== false;
  if (!trusted || !document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return null;
  }
  const root = document.documentElement;
  root.dataset.vtRegion = REGION[kind] ? '1' : '0';
  root.style.setProperty('--vt-old', out);
  root.style.setProperty('--vt-new', inn);
  root.style.setProperty('--vt-dur', `${ms}ms`);
  root.style.setProperty('--vt-delay', `${delay}ms`);
  const transition = document.startViewTransition(() => {
    if (version === transitionVersion) update();
  });
  activeTransition = transition;
  // Skipping an animation rejects ready by contract, even when the update
  // succeeds. Handle that promise so rapid navigation does not log an error.
  transition.ready.catch(() => {});
  const cleanup = () => {
    if (activeTransition !== transition) return;
    activeTransition = null;
    root.style.removeProperty('--vt-old');
    root.style.removeProperty('--vt-new');
    root.style.removeProperty('--vt-dur');
    root.style.removeProperty('--vt-delay');
    delete root.dataset.vtRegion;
  };
  transition.finished.then(cleanup, cleanup);
  return transition;
}

export function toast(message, kind = '', ms = 4200) {
  const host = document.getElementById('toasts');
  // Repeated runs should not cover the response or the next action.
  while (host.children.length >= 3) host.firstElementChild.remove();
  const node = el('div', { class: `toast ${kind}`, text: message });
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px) scale(0.97)';
    node.style.transition = 'opacity 200ms cubic-bezier(0.4,0,1,1), transform 200ms cubic-bezier(0.4,0,1,1)';
    setTimeout(() => node.remove(), 220);
  }, ms);
  return node;
}

export function modal({ title, body, footer, width, onMount, onClose, okText, onOk, cancelText = '取消', side = null }) {
  const root = document.getElementById('modal-root');
  const opener = document.activeElement;
  const headingId = `dialog-${Math.random().toString(36).slice(2)}`;
  const box = el('div', {
    class: side ? `modal modal-${side}` : 'modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': headingId,
    tabindex: '-1',
    style: width ? { width: `min(${width}px, 92vw)` } : null,
  });
  let overlay;
  let closed = false;
  // the host behind a sheet recedes and dims, so the layering is felt, not read;
  // a stack of sheets has to be counted, or the first close would un-recede the rest
  document.body.classList.add('has-sheet');
  document.body.dataset.sheets = String(Number(document.body.dataset.sheets || 0) + 1);
  const close = () => {
    if (closed) return;
    closed = true;
    const left = Number(document.body.dataset.sheets || 1) - 1;
    if (left <= 0) {
      delete document.body.dataset.sheets;
      document.body.classList.remove('has-sheet');
    } else {
      document.body.dataset.sheets = String(left);
    }
    document.removeEventListener('keydown', onKey);
    overlay.inert = true;
    overlay.classList.add('closing');
    if (onClose) onClose();
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    setTimeout(() => overlay.remove(), 180);
  };
  const okBtn = onOk
    ? el('button', {
        class: 'btn primary',
        text: okText || '完成',
        onclick: async () => {
          okBtn.disabled = true;
          try {
            const keep = await onOk();
            if (keep === false) okBtn.disabled = false;
            else close();
          } catch (error) {
            okBtn.disabled = false;
            toast(String(error && error.message ? error.message : error), 'err', 7000);
          }
        },
      })
    : null;

  // a drawer has no verbs to confirm with, so an empty action bar would just be
  // a rule sitting under nothing
  const showFoot = Boolean(okBtn || cancelText || (footer && footer.length));
  // Element.append() stringifies null into a literal "null" text node, so the
  // absent-footer case has to be filtered out rather than passed through
  box.append(
    ...[
      el('div', { class: 'modal-head' }, [
        el('h2', { id: headingId, text: title }),
        el('button', { class: 'btn ghost icon', onclick: close, 'aria-label': '关闭' }, [icon('close')]),
      ]),
      el('div', { class: 'modal-body' }, body),
      showFoot
        ? el('div', { class: 'modal-foot' }, [
            el('div', { class: 'grow' }, footer || []),
            cancelText ? el('button', { class: 'btn', text: cancelText, onclick: close }) : null,
            okBtn,
          ])
        : null,
    ].filter(Boolean)
  );
  overlay = el('div', {
    class: 'overlay',
    onclick: (event) => {
      if (event.target === overlay) close();
    },
  }, [box]);
  function onKey(event) {
    if (event.defaultPrevented) return;
    const top = [...root.querySelectorAll('.overlay:not(.closing)')].at(-1);
    if (top !== overlay || document.querySelector('.menu')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const fields = [...box.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
        .filter((node) => node.getClientRects().length && !node.closest('[inert]'));
      const first = fields[0] || box;
      const last = fields.at(-1) || box;
      if (!box.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  }
  document.addEventListener('keydown', onKey);
  root.appendChild(overlay);
  if (onMount) onMount({ close, box });
  setTimeout(() => {
    if (closed || [...root.querySelectorAll('.overlay:not(.closing)')].at(-1) !== overlay) return;
    // Preserve focus if the user has already started editing the dialog.
    if (box.contains(document.activeElement)) return;
    const focusable = [...box.querySelectorAll('.modal-body input:not(:disabled), .modal-body textarea:not(:disabled), .modal-body button:not(:disabled), .modal-foot button:not(:disabled)')].find((node) => node.getClientRects().length);
    (focusable || box).focus();
  }, 30);
  return { close, box };
}

/// A URL is one line by definition, but the field is now a textarea so a paste
/// carrying CR/LF (copied from a terminal, a log, an <a> tag) would otherwise
/// embed the newline and send a broken request line.
export function oneLine(field) {
  if (!field || !/[\r\n]/.test(field.value)) return field ? field.value : '';
  field.value = field.value.replace(/[\r\n]+/g, '');
  field.setSelectionRange(field.value.length, field.value.length);
  return field.value;
}

/// A wrapping single-field input sizes itself: reset to auto so scrollHeight
/// measures the content, then clamp so a pasted megabyte cannot eat the pane.
/// Render builds the composer before it is attached, and a detached node
/// measures 0 — so the first sizing waits for the frame it lands in.
export function autoGrow(field) {
  if (!field || field.tagName !== 'TEXTAREA') return;
  const apply = () => {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 104)}px`;
  };
  if (field.isConnected) apply();
  else requestAnimationFrame(apply);
  if (!field._growObserver && window.ResizeObserver) {
    let width = 0;
    field._growObserver = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      requestAnimationFrame(() => { if(field.isConnected)apply(); });
    });
    field._growObserver.observe(field);
  }
}

/// UISegmentedControl: one thumb travelling between fixed options. `options` is
/// [[value, label]]. The thumb is measured against the real button rather than
/// assumed to be 1/n of the track, because a content-sized track gives its
/// buttons unequal widths and a guessed thumb then visibly misses the label.
export function segmented(options, current, onChange, { grow = false } = {}) {
  let index = Math.max(0, options.findIndex(([value]) => value === current));
  const thumb = el('span', { class: 'seg-thumb' });
  const seg = el(
    'div',
    {
      class: ['seg', grow ? 'grow' : ''].filter(Boolean).join(' '),
      style: { '--seg-i': String(index), '--seg-n': String(options.length) },
      role: 'radiogroup',
    },
    [thumb]
  );
  const place = (button) => {
    if (!button || !button.offsetWidth) return;
    thumb.style.width = `${button.offsetWidth}px`;
    thumb.style.transform = `translateX(${button.offsetLeft - 2}px)`;
  };
  const buttons = options.map(([value, label], i) =>
    el('button', {
      class: value === current ? 'on' : '',
      type: 'button',
      role: 'radio',
      'aria-checked': value === current,
      tabindex: i === index ? '0' : '-1',
      text: label,
      onclick: () => {
        // compare against the live index, not `current`: `current` is frozen at
        // construction time, and guarding on it makes the initially-selected
        // segment permanently unclickable — it looks like the control froze
        if (i === index) return;
        index = i;
        seg.style.setProperty('--seg-i', String(i));
        for (const [j, node] of buttons.entries()) {
          node.classList.toggle('on', j === i);
          node.setAttribute('aria-checked', String(j === i));
          node.tabIndex = j === i ? 0 : -1;
        }
        place(buttons[i]);
        onChange(value);
      },
    })
  );
  seg.append(...buttons);
  seg.addEventListener('keydown', (event) => {
    const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + delta + buttons.length) % buttons.length;
    const scope = seg.closest('[id]');
    const ordinal = scope ? [...scope.querySelectorAll('[role="radiogroup"]')].indexOf(seg) : -1;
    buttons[next].click();
    if (buttons[next].isConnected) buttons[next].focus();
    else if (scope && ordinal >= 0) document.getElementById(scope.id)?.querySelectorAll('[role="radiogroup"]')[ordinal]?.querySelector('[aria-checked="true"]')?.focus();
  });
  // one frame later the node is laid out, and a resize/zoom change re-measures
  requestAnimationFrame(() => place(buttons[index]));
  if (window.ResizeObserver) new ResizeObserver(() => place(buttons[index])).observe(seg);
  return seg;
}

/// UISwitch: kept small so the caller can make the whole row the hit target.
export function toggle(value, onChange, label) {
  return el('button', {
    class: `switch ${value ? 'on' : ''}`,
    type: 'button',
    role: 'switch',
    'aria-checked': !!value,
    'aria-label': label || '',
    onclick: (event) => {
      const next = !event.currentTarget.classList.contains('on');
      event.currentTarget.classList.toggle('on', next);
      event.currentTarget.setAttribute('aria-checked', String(next));
      onChange(next);
    },
  });
}

/// An iOS grouped-list row: label on the left, whatever you pass in on the right.
export function row(label, control, { detail = '', hint = '' } = {}) {
  return el('div', { class: 'row' }, [
    el('div', { class: 'row-label' }, [
      el('span', { text: label }),
      detail ? el('span', { class: 'row-detail', text: detail }) : null,
    ]),
    el('div', { class: 'row-value' }, [hint ? el('span', { class: 'faint small', text: hint }) : null, control]),
  ]);
}

export function confirmDialog(message, { okText = '删除', danger = true } = {}) {
  return new Promise((resolve) => {
    let confirmed=false;
    const dialog=modal({
      title: '请确认',
      width: 420,
      body: [el('p', { text: message, style: { margin: '0', lineHeight: '1.7' } })],
      cancelText: '取消',
      okText,
      onOk: () => {
        confirmed=true;
        resolve(true);
      },
      onClose:()=>resolve(confirmed),
    });
    const overlay = dialog.box.closest('.overlay');
    const okButton = dialog.box.querySelector('.modal-foot .btn.primary');
    if (danger && okButton) okButton.classList.add('danger');
    overlay &&
      overlay.addEventListener(
        'click',
        (event) => {
          if (event.target === overlay) resolve(false);
        },
        { once: true }
      );
  });
}

export function prompt({ title, label, value = '', placeholder = '', okText = '确定', multiline = false }) {
  return new Promise((resolve) => {
    let field;
    modal({
      title,
      width: 460,
      body: [
        el('div', { class: 'field' }, [
          el('label', { text: label }),
          (field = multiline
            ? el('textarea', { class: 'textarea', rows: 8, placeholder, value })
            : el('input', { class: 'input', placeholder, value })),
        ]),
      ],
      okText,
      onClose: () => resolve(null),
      onOk: () => {
        resolve(field.value);
      },
    });
  });
}

/// Native file picker. A webview file input only reveals a sanitised name, but
/// the upload engine needs a real path, so this goes through the Tauri dialog.
export async function pickFile({ title = '选择文件', extensions = null, defaultPath = null, directory = false } = {}) {
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core) {
    toast('没有原生选择器可用，请直接填写绝对路径', 'err');
    return null;
  }
  try {
    const picked = await core.invoke('plugin:dialog|open', {
      options: {
        title,
        multiple: false,
        directory,
        defaultPath: defaultPath || undefined,
        filters: extensions && extensions.length ? [{ name: '文件', extensions }] : [],
      },
    });
    return typeof picked === 'string' && picked ? picked : null;
  } catch (error) {
    toast(String((error && error.message) || error), 'err', 6000);
    return null;
  }
}

/// Saves through the OS "Save As" sheet. The old path built a blob and clicked a
/// hidden <a download>, which dropped exports into whichever folder the webview
/// downloads to and never asked — so a "导出" that overwrote nothing and showed
/// no location read as a failure. Falls back to that behaviour outside Tauri,
/// where the dev server runs in a plain browser.
/// Returns the written path, or null when the user cancelled.
export async function saveAs({ name, text = null, base64 = null, extensions = null }) {
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core) {
    if (base64) {
      toast('浏览器模式下存不了二进制，请在应用里导出', 'err', 5000);
      return null;
    }
    download(name, text ?? '', 'text/plain;charset=utf-8');
    toast(`已下载到浏览器下载目录：${name}`, 'ok', 3200);
    return name;
  }
  const tail = name.includes('.') ? name.split('.').pop() : 'txt';
  const filters = [{ name: '文件', extensions: (extensions && extensions.length && extensions) || [tail] }];
  let path = null;
  // Test seam: the native Save-As sheet blocks the webview, so an automated run
  // cannot answer it — and the previous stub tried to overwrite
  // `window.__TAURI__.core.invoke`, which is frozen, so it silently did nothing
  // and every "export really wrote a file" assertion was vacuous. Setting
  // `__relaySaveTo` makes the write go to a known path and records the name that
  // would have been offered, which is the part worth asserting on.
  const seam = typeof window.__relaySaveTo === 'string' ? window.__relaySaveTo : null;
  if (seam) {
    window.__relaySuggested = name;
    path = seam;
  } else {
    let picked = null;
    try {
      picked = await core.invoke('plugin:dialog|save', { options: { title: '保存到', defaultPath: name, filters } });
    } catch (error) {
      toast(String((error && error.message) || error), 'err', 6000);
      return null;
    }
    path = typeof picked === 'string' ? picked : picked && picked.path;
  }
  if (!path) return null; // cancelled: silence is the right answer, they chose it
  try {
    const written = base64
      ? await core.invoke('save_base64', { path, contentsBase64: base64 })
      : await core.invoke('save_text', { path, contents: text ?? '' });
    toast(`已保存到 ${written}`, 'ok', 5000);
    return written;
  } catch (error) {
    toast(String((error && error.message) || error), 'err', 6000);
    return null;
  }
}

/// Size / name of a path on disk, so an upload row can show what it points at.
export async function fileMeta(path) {
  const core = window.__TAURI__ && window.__TAURI__.core;
  if (!core || !path) return null;
  try {
    return await core.invoke('file_meta', { path });
  } catch (error) {
    return { error: String((error && error.message) || error) };
  }
}

export function prettyTime(millis) {
  if (!millis) return '—';
  const date = new Date(Number(millis));
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}

/// The OS-drawn file box is the one control this design must never show: it brings
/// its own font, border and button. Hide the real input, drive it from a normal
/// `.btn`, and report the chosen file in the same note style as the request's file
/// row — the user still gets the native picker, the row still looks like ours.
export function filePicker({ accept, buttonText = '选择文件', hint = '未选择文件', onPick }) {
  const input = el('input', { type: 'file', accept, class: 'file-native' });
  const note = el('span', { class: 'kv-file-meta small faint', text: hint });
  const button = el('button', { class: 'btn sm', text: buttonText, onclick: () => input.click() });
  input.addEventListener('change', async () => {
    const handle = input.files && input.files[0];
    if (!handle) return;
    note.textContent = `${handle.name} · ${bytes(handle.size)}`;
    note.classList.remove('bad');
    if (onPick) {
      try {
        await onPick(handle);
      } catch (error) {
        note.textContent = `读不了这个文件：${(error && error.message) || error}`;
        note.classList.add('bad');
      }
    }
  });
  return el('div', { class: 'file-pick' }, [button, note, input]);
}

export function bytes(size) {  if (!size && size !== 0) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1048576).toFixed(2)} MB`;
}

export function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function debounce(fn, wait = 400) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function download(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/// Dumps a streamed event log to disk as readable text or structured JSON.
/// Resolves to the path written, or null if the user backed out — saveAs owns the
/// confirmation toast, so callers must not add a second one.
export async function exportStream(baseName, events, format) {
  const safe = String(baseName || 'stream').replace(/[\/:*?"<>|]/g, '_').slice(0, 60);
  const NL = String.fromCharCode(10);
  if (format === 'json') {
    return saveAs({ name: `${safe}-${Date.now()}.json`, text: JSON.stringify(events, null, 2), extensions: ['json'] });
  }
  const stamp = (at) => new Date(Number(at) || Date.now()).toISOString();
  const text = events
    .map((event) => {
      const direction = event.dir ? `${event.dir.toUpperCase()} ` : '';
      const label = event.event || event.kind || 'message';
      const body = event.data ?? event.text ?? (event.bytesB64 ? `base64:${event.bytesB64}` : event.message ?? '');
      return `[${stamp(event.at)}] ${direction}${label}${NL}${body}${NL}`;
    })
    .join(NL);
  return saveAs({ name: `${safe}-${Date.now()}.txt`, text, extensions: ['txt'] });
}

/// Clipboard write with a selection-based fallback: the async API is unreliable
/// in a webview that has lost focus, and copying values is a core action here.
export async function copy(text, message = '已复制') {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    toast(message, 'ok', 1500);
    return true;
  } catch (error) {
    const area = el('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' }, value });
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (inner) {
      ok = false;
    }
    area.remove();
    if (ok) toast(message, 'ok', 1500);
    else toast('复制失败，可手动选中内容', 'err', 2500);
    return ok;
  }
}
