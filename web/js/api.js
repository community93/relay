// Thin bridge over Tauri IPC. Everything the UI sends goes through here so the
// transport stays in one place.

let bridge = window.__TAURI__;

if (!bridge || !bridge.core) {
  if (location.protocol.startsWith('http')) {
    // Plain browser (dev preview): stand in for the Rust engine.
    const { install } = await import('./mock.js');
    install();
    bridge = window.__TAURI__;
  } else {
    document.getElementById('root').innerHTML =
      '<div style="padding:40px;font-family:system-ui;line-height:1.8">当前不是在我的应用窗口里打开。<br/>' +
      '请运行打包好的 <b>Relay.exe</b>（它会把界面注入到内嵌 WebView 中）。</div>';
    throw new Error('Tauri bridge unavailable');
  }
}

const { invoke, Channel } = bridge.core;
export { invoke };

export function loadDoc(domain) {
  return invoke('load_doc', { domain });
}

export function saveDoc(domain, content) {
  return invoke('save_doc', { domain, content });
}

export function dataPath() {
  return invoke('data_path');
}

export function migrateDataDirectory(path) {
  return invoke('migrate_data_directory', { path });
}

export function execute(draft, execId) {
  return invoke('execute', { draft, execId });
}

export function cancel(execId) {
  return invoke('cancel', { execId });
}

export function streamSse({ draft, execId, firstByteTimeoutMs, streamFormat, onEvent }) {
  const channel = new Channel();
  channel.onmessage = onEvent;
  return invoke('stream_sse', { draft, execId, firstByteTimeoutMs, streamFormat, sink: channel });
}

export function wsConnect({ req, onEvent }) {
  const channel = new Channel();
  channel.onmessage = onEvent;
  return invoke('ws_connect', { req, sink: channel });
}

export function wsSend(connId, payload) {
  return invoke('ws_send', { connId, payload });
}

export function wsClose(connId) {
  return invoke('ws_close', { connId });
}

export function wsDisconnect(connId) {
  return invoke('ws_disconnect', { connId });
}

export function redecode(bodyBase64, charset) {
  return invoke('redecode', { bodyBase64, charset });
}

/// One round trip for a whole streamed log: entries without bytes (the chunks
/// that were already valid UTF-8) come back as null and keep their shown text.
export function redecodeChunks(bases, charset) {
  return invoke('redecode_chunks', { bases, charset });
}

export function parseCurl(text) {
  return invoke('parse_curl', { text });
}
