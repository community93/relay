import { segmented } from './ui.js';
import { markDirty, emit } from './state.js';
import * as api from './api.js';

/// The first control in every request-style tab: pick HTTP, SSE or WebSocket
/// before anything else.
export const PROTOCOLS = [
  ['http', 'HTTP'],
  ['sse', 'SSE'],
  ['ws', 'WS'],
];

export function inferProtocol(draft, explicit) {
  if(PROTOCOLS.some(([value])=>value===explicit))return explicit;
  if(/^wss?:\/\//i.test(String(draft?.url||'').trim()))return 'ws';
  const headers=(draft?.headers||[]).filter(row=>row.enabled!==false&&row.disabled!==true);
  if(headers.some(row=>/^upgrade$/i.test(row.key?.trim())&&/\bwebsocket\b/i.test(row.value)))return 'ws';
  if(headers.some(row=>/^accept$/i.test(row.key?.trim())&&String(row.value).split(',').some(part=>/^text\/event-stream(?:\s*;|\s*$)/i.test(part.trim())&&!/;\s*q\s*=\s*0(?:\.0*)?(?:\s*;|\s*$)/i.test(part))))return 'sse';
  if(draft?.body?.mode==='raw') {
    try {if(JSON.parse(draft.body.raw?.content||'').stream===true)return 'sse';} catch {}
  }
  return 'http';
}

export function protocolSwitch(tab, { onPick } = {}) {
  return segmented(PROTOCOLS, tab.protocol, (value) => (onPick ? onPick(value) : setProtocol(tab, value)));
}

export function setProtocol(tab, next) {
  if (!tab || tab.protocol === next) return;
  if (tab.running) {
    if (tab.running.execId) api.cancel(tab.running.execId).catch(() => {});
    tab.running = null;
  }
  if (tab.stream && tab.stream.connId) {
    api.wsDisconnect(tab.stream.connId).catch(() => {});
    tab.stream = null;
  }
  if (tab.ws) {
    if (tab.ws.pingTimer) clearInterval(tab.ws.pingTimer);
    if (tab.ws.connId && ['opening','open','closing'].includes(tab.ws.status)) api.wsDisconnect(tab.ws.connId).catch(() => {});
    tab.ws = null;
  }
  if(next!=='sse')tab.stream=null;
  tab.protocol = next;
  tab.kind = next === 'ws' ? 'ws' : 'request';
  if (next === 'ws') {
    tab.wsView = 'messages';
    tab.response = null;
  } else if (next === 'sse') {
    tab.stream = null;
    tab.responseView = 'events';
    if (tab.view === 'checks') tab.view = 'params';
  } else {
    tab.responseView = 'body';
  }
  markDirty(tab);
  emit('tabs');
  emit('rerender');
}
