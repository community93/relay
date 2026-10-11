"""End-to-end checks against the running Relay window over CDP.

Start `python tests/local_server.py`, launch the exe with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`, then run
`python tests/e2e_cdp.py`.
"""

import json
import os
import sys
import time
import urllib.request

import websocket

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ui_js import PICK  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
BASE = "http://127.0.0.1:8899"
WS = "ws://127.0.0.1:8900"

results = []
console_errors = []


def target_socket():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5) as response:
        for page in json.load(response):
            if page.get("type") == "page" and "tauri" in page.get("url", ""):
                return page["webSocketDebuggerUrl"]
    raise RuntimeError("Relay window not found")


class CDP:
    def __init__(self, url):
        self.ws = websocket.create_connection(url, timeout=30)
        self.id = 0

    def send(self, method, params=None):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method, "params": params or {}}))
        return self.id

    def wait(self, message_id, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                payload = json.loads(self.ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            if payload.get("id") == message_id:
                if "error" in payload:
                    raise RuntimeError(json.dumps(payload["error"]))
                return payload.get("result", {})
            if payload.get("method") == "Runtime.consoleAPICalled":
                text = " ".join(str(arg.get("value", arg.get("description", ""))) for arg in payload["params"]["args"])
                if payload["params"]["type"] in ("error", "warning"):
                    console_errors.append(f"{payload['params']['type']}: {text}")
            if payload.get("method") == "Runtime.exceptionThrown":
                detail = payload["params"]["exceptionDetails"]
                console_errors.append(f"exception: {detail.get('text')} {detail.get('exception', {}).get('description', '')}")
        raise TimeoutError(f"no reply for {message_id}")

    def js(self, expression, timeout=40):
        message_id = self.send(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        result = self.wait(message_id, timeout).get("result", {})
        value = result.get("value")
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False)


def prefill_ok(out):
    """The env panel should prefill the URL with a literal baseUrl placeholder."""
    return out.get("prefill") == "{" + "{baseUrl}" + "}" + "/"


def check(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    flag = "PASS" if condition else "FAIL"
    print(f"[{flag}] {name}{(' — ' + str(detail)[:220]) if detail else ''}", flush=True)


def main():
    cdp = CDP(target_socket())
    cdp.send("Runtime.enable")

    boot = cdp.js(
        "JSON.stringify({topbar: !!document.querySelector('.topbar'), rail: document.querySelectorAll('.rail-btn').length,"
        " docs: !!document.querySelector('button[data-rail=docs]'), nodes: document.querySelectorAll('#sidebar .node').length, tab: !!document.querySelector('.url-input')})"
    )
    check("应用启动并渲染主界面", json.loads(boot)["topbar"] and json.loads(boot)["rail"] >= 4 and json.loads(boot)["docs"], boot)

    # ---- plain GET ----
    out = cdp.js(
        """(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
        document.querySelector('.method-pick').click(); await sleep(160); [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.trim() === 'GET').click(); await sleep(160);
        const url = document.querySelector('.url-input');
        url.value = '%s/hello?name=tom'; url.dispatchEvent(new Event('input', {bubbles:true}));
        [...document.querySelectorAll('.urlbar button')].find(b => b.textContent.includes('发送')).click();
        await sleep(1500);
        const pre = document.querySelector('.response-body pre');
        return JSON.stringify({pill: document.querySelector('.pill')?.textContent, body: pre ? pre.textContent.slice(0,120) : null,
          meta: document.querySelector('.response-head')?.textContent.replace(/\\s+/g,' ').slice(0,120)});
        })()"""
        % BASE
    )
    data = json.loads(out)
    check("真实 HTTP GET 成功", "200" in (data.get("pill") or "") and "你好 Relay" in (data.get("body") or ""), data)

    # ---- POST with JSON body + custom header ----
    out = cdp.js(
        """(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
        document.querySelector('.method-pick').click(); await sleep(160); [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.trim() === 'POST').click(); await sleep(150);
        const url = document.querySelector('.url-input');
        url.value = '%s/echo?src=ui'; url.dispatchEvent(new Event('input', {bubbles:true}));
        [...document.querySelectorAll('.subtab')].find(b => b.textContent.trim().startsWith('Headers')).click(); await sleep(120);
        const ghost = document.querySelector('.kv-row.ghost');
        const key = ghost.querySelectorAll('input')[0]; key.value='X-Trace'; key.dispatchEvent(new Event('input',{bubbles:true})); await sleep(80);
        const rows = document.querySelectorAll('.kv-row:not(.ghost)');
        const last = rows[rows.length-1].querySelectorAll('input'); last[2].value='abc'; last[2].dispatchEvent(new Event('input',{bubbles:true}));
        [...document.querySelectorAll('.subtab')].find(b => b.textContent.trim().startsWith('Body')).click(); await sleep(200);
        %s
        [...document.querySelectorAll('#request-host .body-formats button')].find(r=>r.textContent.trim()==='JSON').click(); await sleep(250);
        const {EditorView}=await import('./js/vendor/editor-core.js');
        const editor=EditorView.findFromDOM(document.querySelector('.body-code .cm-content'));
        editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:'{"orderId": 42}'}});
        [...document.querySelectorAll('.urlbar button.btn.primary')].find(b => /发送|POST|连接/.test(b.textContent)).click();
        await sleep(1500);
        const pre = document.querySelector('.response-body pre');
        const echoed = JSON.parse(pre.textContent);
        return JSON.stringify({received: echoed.received, query: echoed.query, trace: echoed.headers['X-Trace'] || echoed.headers['x-trace'], ct: echoed.headers['Content-Type'] || echoed.headers['content-type']});
        })()"""
        % (BASE, PICK)
    )
    data = json.loads(out)
    check(
        "POST + 自定义头 + raw JSON 全部送达",
        data.get("received") == '{"orderId": 42}' and data.get("trace") == "abc" and "application/json" in (data.get("ct") or "") and data.get("query") == "src=ui",
        data,
    )

    # ---- SSE ----
    out = cdp.js(
        """(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
        document.querySelector('.method-pick').click(); await sleep(160); [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.trim() === 'GET').click(); await sleep(120);
        [...document.querySelectorAll('.seg button')].find(b => b.textContent.trim()==='SSE').click(); await sleep(150);
        const url = document.querySelector('.url-input');
        url.value = '%s/sse'; url.dispatchEvent(new Event('input',{bubbles:true}));
        [...document.querySelectorAll('.urlbar button')].find(b => b.textContent.trim()==='连接').click();
        await sleep(3000);
        const events = [...document.querySelectorAll('.events .event')].map(e => e.textContent.replace(/\\s+/g,' ').slice(0,44));
        return JSON.stringify({count: events.length, sample: events.slice(0,3), last: events.slice(-1), live: !!document.querySelector('.status-dot.live')});
        })()"""
        % BASE
    )
    data = json.loads(out)
    check(
        "SSE 逐条接收并解析 event/id/data",
        data.get("count", 0) >= 7 and any("tick" in (s or "") for s in data.get("sample", [])),
        data,
    )

    # ---- WebSocket ----
    out = cdp.js(
        """(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(200); [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('WebSocket')).click(); await sleep(300);
        const url = document.querySelector('#request-host .url-input');
        url.value = '%s'; url.dispatchEvent(new Event('input',{bubbles:true}));
        [...document.querySelectorAll('#request-host .urlbar button')].find(b => b.textContent.trim()==='连接').click();
        await sleep(1200);
        const area = document.querySelector('.ws-out textarea');
        area.value = '{"action":"subscribe"}'; area.dispatchEvent(new Event('input',{bubbles:true}));
        [...document.querySelectorAll('#request-host button')].filter(b => b.textContent.trim()==='发送').pop().click();
        await sleep(1200);
        const events = [...document.querySelectorAll('#request-host .events .event')].map(e => e.textContent.replace(/\\s+/g,' ').slice(0,60));
        return JSON.stringify({events, status: document.querySelector('#request-host .urlbar .dim')?.textContent});
        })()"""
        % WS
    )
    data = json.loads(out)
    texts = json.dumps(data, ensure_ascii=False)
    check("WebSocket 握手、收欢迎帧、发送并收到回显", "hello" in texts and "subscribe" in texts and "已连接" in texts, data)

    # ---- curl 批量导入（真实 Rust 解析器）----
    out = cdp.js(
        """(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        [...document.querySelectorAll('.topbar button')].find(b => b.textContent.includes('导入')).click(); await sleep(250);
        [...document.querySelectorAll('.menu-item')].find(b => b.textContent.includes('cURL')).click(); await sleep(250);
        const area = document.querySelector('.modal textarea');
        const okBtn = [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('导入'));
        okBtn.click(); await sleep(300);
        const stillUsable = !okBtn.disabled && !!document.querySelector('.modal');
        area.value = "curl -X POST '%s/orders?src=curl' -H 'Content-Type: application/json' -H 'X-Batch: 1' -d '{\\"id\\":7}'\\ncurl -u tom:123456 '%s/basic-auth/tom/123456'\\ncurl '%s/bin' --compressed -sS";
        area.dispatchEvent(new Event('input',{bubbles:true}));
        await sleep(900);
        const rows = [...document.querySelectorAll('.modal .pick')].map(p => p.textContent.replace(/\\s+/g,' ').slice(0,80));
        [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('导入')).click(); await sleep(500);
        document.querySelector('button[data-rail=history]').click(); await sleep(250);
        const history = [...document.querySelectorAll('#sidebar .node')].map(n => n.textContent.replace(/\\s+/g,' ').slice(0,50));
        document.querySelector('button[data-rail=collections]').click(); await sleep(200);
        const nodes = [...document.querySelectorAll('#sidebar .node .name')].map(n => n.textContent);
        return JSON.stringify({stillUsable, rows, historyCount: history.length, history: history.slice(0,4), nodes});
        })()"""
        % (BASE, BASE, BASE)
    )
    data = json.loads(out)
    check(
        "curl 批量导入：粘贴即识别，空表点导入也不会锁死按钮",
        data.get("stillUsable") is True
        and len(data.get("rows", [])) == 3
        and len([n for n in data.get("nodes", []) if n]) >= 8,
        data,
    )
    check("历史自动记录", data.get("historyCount", 0) >= 3, data.get("history"))

    # ---- 环境：右侧面板设置 baseUrl/变量/预填头，再新建请求验证生效 ----
    env_js = """(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
      const steps = [];
      try {
        document.querySelector('button[data-rail=environments]').click(); await sleep(250);
        document.querySelectorAll('#sidebar .node')[0].click(); await sleep(400);
        const kvs = [...document.querySelectorAll('#request-host .kv')];
        steps.push('envTab=' + !!document.querySelector('.tabstrip .tab.active .tag'));
        type(kvs[0].querySelector('.kv-row.ghost').querySelectorAll('input')[0], 'token'); await sleep(150);
        let rows = kvs[0].querySelectorAll('.kv-row:not(.ghost):not(.kv-head)');
        type(rows[rows.length - 1].querySelectorAll('input')[2], 'abc123');
        type(kvs[1].querySelector('.kv-row.ghost').querySelectorAll('input')[0], 'X-Tenant'); await sleep(150);
        rows = kvs[1].querySelectorAll('.kv-row:not(.ghost):not(.kv-head)');
        type(rows[rows.length - 1].querySelectorAll('input')[2], 'demo');
        type([...document.querySelectorAll('#request-host .input.mono')][0], 'BASE');
        const headRow = [...document.querySelectorAll('#request-host .row')].find((r) => r.textContent.includes('每次发送都附加'));
        const headSwitch = headRow.querySelector('.switch');
        if (!headSwitch.classList.contains('on')) headSwitch.click();
        await sleep(250);
        steps.push('rows=' + [...document.querySelectorAll('#request-host .group .row')].length);
        const active = document.querySelector('#request-host .switch');
        if (active.classList.contains('on')) { active.click(); await sleep(450); }
        document.querySelector('#request-host .switch').click(); await sleep(600);
        [...document.querySelectorAll('#request-host .btn')].find((b) => b.textContent.includes('用此环境新建请求')).click(); await sleep(700);
        const urlField = document.querySelector('.url-input');
        const prefill = urlField ? urlField.value : null;
        type(urlField, '{{baseUrl}}/echo?kw={{token}}');
        [...document.querySelectorAll('.urlbar button')].find((b) => b.textContent.includes('发送')).click(); await sleep(1500);
        const echoed = JSON.parse(document.querySelector('.response-body pre').textContent);
        return JSON.stringify({ steps, prefill, query: echoed.query, tenant: echoed.headers['x-tenant'] || echoed.headers['X-Tenant'], pill: document.querySelector('.pill') ? document.querySelector('.pill').textContent : null });
      } catch (error) {
        return JSON.stringify({ steps, error: String(error && error.message) });
      }
    })()""".replace('BASE', '%s')

    out = json.loads(cdp.js(env_js % BASE))
    check(
        "环境面板设 baseUrl/变量/预填头 → 新建请求预填并真实发送",
        prefill_ok(out) and "kw=abc123" in (out.get("query") or "") and out.get("tenant") == "demo" and "200" in (out.get("pill") or ""),
        out,
    )

    # ---- 主题切换 + 命令面板 ----
    out = cdp.js(
        """(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const before = document.documentElement.dataset.theme;
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',ctrlKey:true,bubbles:true})); await sleep(150);
        const after = document.documentElement.dataset.theme;
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'/',ctrlKey:true,bubbles:true})); await sleep(100);
        window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true})); await sleep(250);
        const items = document.querySelectorAll('.palette-item').length;
        const input = document.querySelector('.palette input'); input.value = 'Echo'; input.dispatchEvent(new Event('input',{bubbles:true})); await sleep(200);
        const filtered = document.querySelectorAll('.palette-item').length;
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
        const overlay = document.querySelector('.palette')?.closest('.overlay'); if (overlay) overlay.remove();
        return JSON.stringify({before, after, items, filtered});
        })()"""
    )
    data = json.loads(out)
    check(
        "主题切换与命令面板可用",
        data.get("before") != data.get("after") and data.get("items", 0) > 5 and 0 < data.get("filtered", 0) < data.get("items", 0),
        data,
    )

    check("运行期间没有 JS 报错", not console_errors, console_errors[:6])

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
    if failed:
        print("失败项：" + "、".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
