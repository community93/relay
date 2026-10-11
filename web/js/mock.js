/// Browser-only stand-in for the Rust engine. It exists so the UI can be opened
/// in a plain browser (`python -m http.server`) for layout and interaction
/// checks; the packaged app never loads this file.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MockChannel {
  constructor() {
    this.onmessage = null;
  }
  post(message) {
    if (this.onmessage) this.onmessage(message);
  }
}

function echoResponse(args) {
  const draft = args.draft || args[0] || {};
  const body = {
    mode: 'mock',
    request: {
      method: draft.method,
      url: draft.url,
      headers: draft.headers || [],
      params: draft.params || [],
      body: draft.body || null,
    },
    note: '这是浏览器预览模式的模拟响应；打包后的 exe 会由本地 Rust 引擎真实发请求。',
  };
  const text = JSON.stringify(body, null, 2);
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    timeMs: 128,
    sizeBytes: text.length,
    headerCount: 4,
    headers: [
      { name: 'content-type', value: 'application/json; charset=utf-8' },
      { name: 'server', value: 'mock' },
      { name: 'x-request-id', value: 'c3f1-88a2' },
      { name: 'set-cookie', value: 'sid=mock-session; Path=/; HttpOnly' },
    ],
    setCookies: ['sid=mock-session; Path=/; HttpOnly'],
    contentType: 'application/json',
    isText: true,
    bodyText: text,
    bodyBase64: null,
    truncated: false,
    finalUrl: draft.url || '',
    redirects: 0,
    error: null,
    errorKind: null,
    note: null,
  };
}

function fakeCurl(text) {
  return text
    .split(/\n|;/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('curl'))
    .map((line, index) => {
      const url = (line.match(/'([^']+)'|"([^"]+)"|(https?:\/\/\S+)/) || []).slice(1).find(Boolean) || `https://demo.local/${index}`;
      const method = (line.match(/-X\s+(\w+)/) || [])[1] || (/-d\b|--data/.test(line) ? 'POST' : 'GET');
      const headers = [...line.matchAll(/-H\s+'([^']+)'/g)].map((m) => {
        const [key, ...rest] = m[1].split(':');
        return { id: Math.random().toString(36).slice(2), key: key.trim(), value: rest.join(':').trim(), enabled: true, description: '' };
      });
      return {
        draft: { name: `${method} ${url.split('/').pop()}`, method, url, params: [], headers, body: null, settings: { timeoutMs: 60000, followRedirects: true, sslVerify: true, cookieJar: true } },
        warnings: [],
        source: line,
      };
    });
}

async function handle(command, args) {
  args = args || {};
  switch (command) {
    case 'load_doc':
      return 'null';
    case 'save_doc':
      return 'E:\\postman\\data\\preview';
    case 'data_path':
      return 'E:\\postman\\data（预览模式不写盘）';
    case 'execute':
      await sleep(320);
      return echoResponse(args);
    case 'cancel':
      return null;
    case 'stream_sse': {
      const sink = args.sink;
      await sleep(120);
      sink.post({ kind: 'open', at: Date.now(), status: 200, headers: [{ name: 'content-type', value: 'text/event-stream' }], message: args.draft.url });
      for (let i = 1; i <= 6; i += 1) {
        await sleep(420);
        sink.post({
          kind: 'message',
          at: Date.now(),
          event: i % 3 === 0 ? 'complete' : 'delta',
          data: JSON.stringify({ seq: i, message: `模拟事件 ${i}`, ts: new Date().toISOString() }),
          bytes: i * 64,
        });
      }
      sink.post({ kind: 'done', at: Date.now(), message: '连接结束：6 个事件', bytes: 384 });
      return null;
    }
    case 'ws_connect': {
      const sink = args.sink;
      await sleep(200);
      sink.post({ kind: 'open', at: Date.now(), status: 101, message: '已连接（HTTP 101）', headers: [{ name: 'upgrade', value: 'websocket' }] });
      setTimeout(() => sink.post({ kind: 'message', at: Date.now(), dir: 'in', text: JSON.stringify({ hello: 'from mock server' }), len: 30 }), 900);
      return null;
    }
    case 'ws_send':
      return null;
    case 'ws_close':
    case 'ws_disconnect':
      return null;
    case 'redecode':
      return atob(args.bodyBase64);
    case 'parse_curl':
      return fakeCurl(args.text || '');
    default:
      return null;
  }
}

export function install() {
  window.__TAURI__ = {
    core: {
      Channel: MockChannel,
      invoke: (command, args) => Promise.resolve().then(() => handle(command, args)),
    },
  };
  const banner = document.createElement('div');
  banner.textContent = '浏览器预览模式：界面可点，请求由模拟引擎返回';
  banner.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;height:22px;line-height:22px;text-align:center;' +
    'background:#e8a13a;color:#1b2130;font:12px system-ui;z-index:9999';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(banner));
}
