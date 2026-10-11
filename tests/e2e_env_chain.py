"""Chain check for the workflow: define a variable in the environment, prefill a
header whose value references it, then change only the variable and see every
request pick up the new value."""

import json
import sys
import time
import urllib.request

import websocket

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
BASE = "http://127.0.0.1:8899"
results = []

pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5))
sock = websocket.create_connection([p for p in pages if p["type"] == "page"][0]["webSocketDebuggerUrl"], timeout=90)
counter = [0]


def js(expression, timeout=90):
    counter[0] += 1
    marker = counter[0]
    sock.send(json.dumps({"id": marker, "method": "Runtime.evaluate",
                          "params": {"expression": expression, "returnByValue": True, "awaitPromise": True}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = json.loads(sock.recv())
        if payload.get("id") == marker:
            result = payload.get("result", {})
            if "exceptionDetails" in result:
                detail = result["exceptionDetails"]
                return json.dumps({"jsError": detail.get("exception", {}).get("description", detail.get("text"))})
            value = result.get("result", {}).get("value")
            return value if isinstance(value, str) else json.dumps(value)
    return json.dumps({"jsError": "timeout"})


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + str(detail)[:230]) if detail else ''}", flush=True)


HELPERS = """
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const addRow = (kvHost, key, value) => {
    const live = [...kvHost.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)')].find((r) => {
      const i = r.querySelectorAll('input');
      return i[1] && i[1].value === key;
    });
    if (live) {
      const cell = live.querySelectorAll('input')[2];
      type(cell, value);
      cell.dispatchEvent(new Event('blur', { bubbles: true }));
      return;
    }
    const ghost = kvHost.querySelector('.kv-row.ghost');
    type(ghost.querySelectorAll('input')[0], key);
    const rows = kvHost.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)');
    const target = rows[rows.length - 1].querySelectorAll('input');
    type(target[2], value);
  };
  const envTab = () => { document.querySelector('button[data-rail=environments]').click(); document.querySelectorAll('#sidebar .node')[0].click(); };
  const requestTab = () => [...document.querySelectorAll('.tabstrip .tab')].filter((t) => /^GET|^POST/.test(t.textContent.trim())).pop();
  const sendCurrent = async (url) => {
    const field = document.querySelector('.url-input');
    type(field, url);
    [...document.querySelectorAll('.urlbar button')].find((b) => b.textContent.includes('发送')).click();
    await sleep(1500);
    const pre = document.querySelector('.response-body pre');
    return pre ? JSON.parse(pre.textContent) : null;
  };
"""

# ---- 1. variable + prefill header that references it ----
out = json.loads(js(f"""(async () => {{ try {{
{HELPERS}
  await sleep(400);
  envTab(); await sleep(400);
  const kvs = [...document.querySelectorAll('#request-host .kv')];
  addRow(kvs[0], 'user-token', 'AAA111'); await sleep(150);
  addRow(kvs[1], 'token', 'Bearer {{{{user-token}}}}'); await sleep(150);
  const headRow = [...document.querySelectorAll('#request-host .row')]
    .find((r) => r.textContent.includes('每次发送都附加'));
  const headSwitch = headRow.querySelector('.switch');
  if (!headSwitch.classList.contains('on')) headSwitch.click();
  await sleep(200);
  const active = () => document.querySelector('#request-host .switch');
  if (active().classList.contains('on')) {{ active().click(); await sleep(450); }}
  active().click();
  await sleep(600);
  [...document.querySelectorAll('#request-host .btn')].find((b) => b.textContent.includes('用此环境新建请求')).click();
  await sleep(700);
  const echoed = await sendCurrent('{BASE}/echo?step=1');
  const lower = Object.fromEntries(Object.entries(echoed.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return JSON.stringify({{ token: lower['token'], query: echoed.query, prefillUrl: null }});
}} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }} }})()"""))
check("预填 header 写 {{user-token}}，新建的请求发出真实值", out.get("token") == "Bearer AAA111", out)

# ---- 2. change only the variable, resend the same request ----
out = json.loads(js(f"""(async () => {{ try {{
{HELPERS}
  const tab = requestTab();
  tab.click(); await sleep(300);
  const before = await sendCurrent('{BASE}/echo?step=2');
  const lowerBefore = Object.fromEntries(Object.entries(before.headers).map(([k, v]) => [k.toLowerCase(), v]));
  envTab(); await sleep(400);
  const varRow = [...document.querySelectorAll('#request-host .kv-row')].find((r) => {{
    const inputs = r.querySelectorAll('input');
    return inputs[1] && inputs[1].value === 'user-token';
  }});
  type(varRow.querySelectorAll('input')[2], 'BBB222');
  await sleep(300);
  requestTab().click(); await sleep(300);
  const after = await sendCurrent('{BASE}/echo?step=3');
  const lowerAfter = Object.fromEntries(Object.entries(after.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return JSON.stringify({{ before: lowerBefore['token'], after: lowerAfter['token'] }});
}} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }} }})()"""))
check("只改环境里的变量值，同一个请求再发就变成新值", out.get("before") == "Bearer AAA111" and out.get("after") == "Bearer BBB222", out)

# ---- 3. a variable value may itself reference another variable ----
out = json.loads(js(f"""(async () => {{ try {{
{HELPERS}
  envTab(); await sleep(400);
  const kvs = [...document.querySelectorAll('#request-host .kv')];
  addRow(kvs[0], 'tenant', 'branch-011'); await sleep(120);
  addRow(kvs[0], 'trace', '{{{{tenant}}}}-{{{{user-token}}}}'); await sleep(150);
  addRow(kvs[1], 'X-Trace', '{{{{trace}}}}'); await sleep(250);
  const tab = requestTab();
  tab.click(); await sleep(300);
  const echoed = await sendCurrent('{BASE}/echo?step=4');
  const lower = Object.fromEntries(Object.entries(echoed.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return JSON.stringify({{ trace: lower['x-trace'], token: lower['token'] }});
}} catch (error) {{ return JSON.stringify({{ error: String(error && error.message) }}); }} }})()"""))
check("变量值里再引用变量，嵌套解析生效", out.get("trace") == "branch-011-BBB222" and out.get("token") == "Bearer BBB222", out)

# ---- 4. the request itself never stored the secret, only the reference ----
out = json.loads(js("""(async () => {
  const state = await import('/js/state.js');
  const tab = state.state.tabs.find((t) => t.kind !== 'env');
  const stored = (tab.draft.headers || []).map((h) => `${h.key}=${h.value}`);
  const env = state.state.environments[0];
  return JSON.stringify({ stored, envHeaders: env.defaults.headers.map((h) => `${h.key}=${h.value}`), vars: env.variables.map((v) => `${v.key}=${v.value}`) });
})()"""))
stored = json.dumps(out.get("stored", []))
check("请求里存的仍是 {{引用}}，真实值只存在环境里", "AAA111" not in stored and "BBB222" not in stored, out)

def mouse(x, y):
    for kind in ("mousePressed", "mouseReleased"):
        counter[0] += 1
        sock.send(json.dumps({"id": counter[0], "method": "Input.dispatchMouseEvent",
                              "params": {"type": kind, "x": x, "y": y, "button": "left",
                                         "clickCount": 1, "buttons": 1 if kind == "mousePressed" else 0}}))
        time.sleep(0.05)
    time.sleep(0.5)


def centre(selector):
    raw = js("""(() => {
      const n=document.querySelector('%s'); if(!n) return JSON.stringify({missing:true});
      const r=n.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2,
        text: (n.textContent||'').trim().slice(0,20) });
    })()""" % selector)
    return json.loads(raw)


# Switching environments from the top bar must stay put: the request you were
# writing keeps its tab and simply re-resolves against the new environment.
# Only the gear on the right of a row may navigate.
# This block borrows the shared environment list, so it stashes what it found and
# puts it back at the end — otherwise every suite after it runs against a doctored
# collection.
js("""(async () => {
  const st = await import('/js/state.js');
  const { uid } = st;
  globalThis.__envBackup = {
    envs: JSON.parse(JSON.stringify(st.state.environments)),
    activeEnvId: st.state.settings.activeEnvironmentId,
    tabs: st.state.tabs.map((t) => t.id),
    activeTabId: st.state.activeTabId,
  };
  const mk = (name, color, vars) => ({ id: uid('env'), name, color, enabled: true,
    variables: vars.map(([key, value]) => ({ id: uid('v'), key, value, enabled: true, description: '' })),
    defaults: { headers: [], urlPrefix: '', urlPrefixMode: 'manual', bodyType: 'none', body: '', attachBody: false } });
  st.state.environments.push(
    mk('切换甲', '#0a7a4d', [['baseUrl', 'http://127.0.0.1:8899'], ['city', 'shanghai']]),
    mk('切换乙', '#b3261e', [['baseUrl', 'http://127.0.0.1:8899'], ['city', 'chengdu']])
  );
  st.state.settings.activeEnvironmentId = st.state.environments[st.state.environments.length - 2].id;
  st.touch('environments'); st.touch('settings');
  document.querySelectorAll('.tabstrip .tab-new')[0].click();
  await new Promise(r => setTimeout(r, 240));
  [...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('HTTP')).click();
  await new Promise(r => setTimeout(r, 320));
  const u = document.querySelector('.url-input');
  u.value = '{{baseUrl}}/hello?city={{city}}';
  u.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ready';
})()""")
time.sleep(0.8)

env_button = centre("#env-slot button")
mouse(env_button["x"], env_button["y"])
time.sleep(0.4)
rows = json.loads(js("""(() => {
  const menu = document.querySelector('.menu');
  if (!menu) return JSON.stringify({ noMenu: true });
  const pick = (name) => [...menu.querySelectorAll('.menu-item')]
    .find((i) => i.textContent.trim().startsWith(name));
  const one = (name) => {
    const row = pick(name);
    if (!row) return null;
    const gear = row.querySelector('.menu-side');
    const g = gear ? gear.getBoundingClientRect() : null;
    return { title: gear ? gear.title : null, w: g ? Math.round(g.width) : 0, h: g ? Math.round(g.height) : 0 };
  };
  return JSON.stringify({ sandbox: one('切换甲'), prod: one('切换乙'),
    totalGears: menu.querySelectorAll('.menu-side').length,
    envRows: [...menu.querySelectorAll('.menu-item')].filter(i => i.querySelector('.menu-side')).length });
})()"""))
sb, pd = rows.get("sandbox") or {}, rows.get("prod") or {}
check(
    "环境菜单每一行右侧备有设置按钮",
    rows.get("totalGears") == rows.get("envRows")
    and sb.get("title") == "打开 切换甲 的设置" and pd.get("title") == "打开 切换乙 的设置"
    and sb.get("w", 0) >= 16 and pd.get("h", 0) >= 16,
    rows,
)

# click the *label* of 切换乙 — switch, no navigation
TABS = """(async () => {
  const st = await import('/js/state.js');
  const active = st.state.tabs.find(t => t.id === st.state.activeTabId);
  const refEnv = active && active.refId
    ? (st.state.environments.find(e => e.id === active.refId) || {}).name : null;
  return JSON.stringify({
    activeEnv: (st.state.environments.find(e => e.id === st.state.settings.activeEnvironmentId) || {}).name,
    tabKind: active ? active.kind : null,
    refEnv: refEnv,
    envTabs: st.state.tabs.filter(t => t.kind === 'env').length,
    tabCount: st.state.tabs.length,
  });
})()"""
before = json.loads(js(TABS))
prod = json.loads(js("""(() => {
  const row = [...document.querySelectorAll('.menu .menu-item')].find(i => i.textContent.trim() === '切换乙');
  const label = row.querySelector('span');
  const r = label.getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
})()"""))
mouse(prod["x"], prod["y"])
time.sleep(0.6)
after = json.loads(js(TABS))
check(
    "点环境名字只切换环境，不跳走、不新建环境标签页",
    after.get("activeEnv") == "切换乙" and after.get("tabKind") == "request"
    and after.get("envTabs") == before.get("envTabs")
    and after.get("tabCount") == before.get("tabCount"),
    {"before": before, "after": after},
)

sent = json.loads(js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await s(1600);
  const pre=document.querySelector('.response-body pre');
  return JSON.stringify({ query: pre ? JSON.parse(pre.textContent).query : null });
})()"""))
check(
    "切完环境后，当前请求直接用新环境的变量发出",
    "city=chengdu" in (sent.get("query") or ""),
    sent,
)

# and the gear still takes you to that environment's settings
env_button = centre("#env-slot button")
mouse(env_button["x"], env_button["y"])
time.sleep(0.4)
before_gear = json.loads(js(TABS))
gear = json.loads(js("""(() => {
  const row = [...document.querySelectorAll('.menu .menu-item')]
    .find((i) => i.textContent.trim().startsWith('切换乙'));
  const g = row.querySelector('.menu-side');
  const r = g.getBoundingClientRect();
  return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
})()"""))
mouse(gear["x"], gear["y"])
time.sleep(0.8)
via_gear = json.loads(js(TABS))
check(
    "点行右侧齿轮才进入该环境的设置页",
    via_gear.get("tabKind") == "env" and via_gear.get("refEnv") == "切换乙"
    and via_gear.get("envTabs") >= before_gear.get("envTabs"),
    {"before": before_gear, "after": via_gear},
)

# hand the borrowed environments and tabs back so later suites see real data
js("""(async () => {
  const st = await import('/js/state.js');
  const b = globalThis.__envBackup;
  if (!b) return 'nothing to restore';
  st.state.environments = b.envs;
  st.state.settings.activeEnvironmentId = b.activeEnvId;
  st.state.tabs = st.state.tabs.filter((t) => b.tabs.includes(t.id));
  if (!st.state.tabs.find((t) => t.id === st.state.activeTabId)) {
    st.state.activeTabId = b.activeTabId && b.tabs.includes(b.activeTabId)
      ? b.activeTabId : (st.state.tabs[0] || {}).id;
  }
  st.touch('environments'); st.touch('settings');
  st.emit('tabs'); st.emit('environment');
  delete globalThis.__envBackup;
  return 'restored';
})()""")
time.sleep(0.6)

failed = [name for name, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} 通过")
if failed:
    print("失败项：" + "、".join(failed))
sys.exit(1 if failed else 0)
