import { el, icon, duration } from './ui.js';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
setInterval(()=>{
  for(const node of document.querySelectorAll('[data-live-since]')){
    if(!node.dataset.liveUntil)node.textContent=duration(Date.now()-Number(node.dataset.liveSince));
  }
},1000);

export function liveDuration(startedAt,endedAt) {
  return el('b',{dataset:{liveSince:startedAt,liveUntil:endedAt||''},text:duration((endedAt||Date.now())-startedAt)});
}

export function enterSurface(node) {
  requestAnimationFrame(() => {
    if (!node?.isConnected || reduce() || !node.animate) return;
    node.animate([{ opacity: .45, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 150, easing: 'cubic-bezier(.2,.7,.2,1)' });
  });
}

export function presentPane(host, key) {
  if (!host) return;
  const changed = host._interactionKey !== key;
  host._interactionKey = key;
  if (changed) enterSurface(host.firstElementChild);
}

// Each protocol owns its scroll position; new frames never pull a reader away
// from older data. This state is transient and does not pause the connection.
export function liveLog(tab, key) {
  const state = tab[key] || (tab[key] = { follow: true, top: 0, unread: 0 });
  let scroller;
  const button = el('button', { class: 'btn sm live-follow', 'aria-label': '跟随最新', title: '只控制滚动，连接持续接收数据', onclick: () => {
    state.follow = !state.follow;
    if (state.follow) { state.unread = 0; if (scroller) scroller.scrollTop = scroller.scrollHeight; }
    paint();
  } });
  const paint = () => {
    button.classList.toggle('on', state.follow);
    button.setAttribute('aria-pressed', String(state.follow));
    const label = state.follow ? '跟随最新' : state.unread ? `${state.unread} 条新消息 ↓` : '恢复跟随';
    button.setAttribute('aria-label', label);
    button.replaceChildren(icon(state.follow ? 'check' : 'chevD'), el('span', { text: label }));
  };
  paint();
  return { button, bind(node) {
    scroller = node;
    node._liveLog = { state, paint };
    requestAnimationFrame(() => {
      if (!node.isConnected) return;
      node.scrollTop = state.follow ? node.scrollHeight : state.top;
    });
    node.addEventListener('scroll', () => {
      state.top = node.scrollTop;
      state.follow = node.scrollHeight - node.clientHeight - node.scrollTop < 24;
      if (state.follow) state.unread = 0;
      paint();
    }, { passive: true });
  } };
}

export function appendLive(scroller, node, limit) {
  if (!scroller?.isConnected) return;
  const state = scroller._liveLog?.state;
  if (state && !state.follow) { state.unread = (state.unread || 0) + 1; scroller._liveLog.paint(); }
  if (scroller.querySelector('.empty')) scroller.replaceChildren();
  scroller.appendChild(node);
  let removed = 0;
  while (scroller.childElementCount > limit) {
    const first = scroller.firstElementChild;
    removed += first.getBoundingClientRect().height + (parseFloat(getComputedStyle(scroller).rowGap)||0);
    first.remove();
  }
  if (!state || state.follow) scroller.scrollTop = scroller.scrollHeight;
  else if (removed) scroller.scrollTop = Math.max(0, state.top - removed);
  if (state) state.top = scroller.scrollTop;
}
