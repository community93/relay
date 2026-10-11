"""Auth: all five kinds, driven through the picker and checked on the wire.

The Auth subtab had zero coverage before this file — no suite ever clicked it, so
none of the five variants, the Header-vs-Query split, the inherited-from-
collection path, or the subtab badge had ever been exercised end to end. Auth is
also the one feature where a silent failure looks like success: the request still
returns 200, it just arrives unauthenticated.

    python tests/e2e_auth.py [cdp-port]
"""

import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import BASE, Harness  # noqa: E402
from ui_js import pick  # noqa: E402

h = Harness(label="auth")

# The kind picker is an app-drawn listbox now, so it is addressed by its own hook
# and its options only exist while the list is open.
KIND_SELECT = "'#request-host .select-field.auth-kind'"


def open_auth_tab():
    h.js("""(() => {
      document.querySelectorAll('.overlay').forEach((o) => o.remove());
      document.body.classList.remove('has-sheet'); delete document.body.dataset.sheets;
    })()""")
    h.js("document.querySelectorAll('.tabstrip .tab-new')[0].click()")
    time.sleep(0.35)
    h.js("[...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click()")
    time.sleep(0.5)
    h.click_subtab("#request-host", "Auth")
    return h.js("(() => { const s = document.querySelector(%s); return s ? 'picker ready' : 'no picker'; })()"
                % json.dumps(KIND_SELECT[1:-1]))


def set_kind(value):
    """Returns the pick outcome so a failed switch shows up in the next check's
    detail instead of surfacing as a mysterious missing Authorization header."""
    out = h.eval_json(pick(KIND_SELECT[1:-1], value))
    time.sleep(0.4)
    return out


def kind_options(scope="#request-host"):
    """Open the kind listbox and read back the values it offers."""
    return h.eval_json("""(async () => {
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const field = document.querySelector(%s + ' .select-field.auth-kind');
      if (!field) return JSON.stringify({ noPicker: true });
      field.click();
      await nap(260);
      const values = [...document.querySelectorAll('.menu .menu-item')].map((r) => r.getAttribute('data-value'));
      const mm = document.querySelector('.menu');
      if (mm) mm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return JSON.stringify(values);
    })()""" % json.dumps(scope))


def type_field(label, value):
    """Fields are `.field > label + control`, so they are addressed by their own
    caption rather than by index — the apikey row has three controls and the
    third is a listbox, not an input."""
    out = h.js("""(() => {
      const f = [...document.querySelectorAll('#request-host .field')]
        .find((x) => ((x.querySelector('label') || {}).textContent || '') === %s);
      if (!f) return 'no field ' + %s;
      const input = f.querySelector('input');
      if (!input) return 'not an input';
      const type = input.type || null;
      input.value = %s;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return type;
    })()""" % (json.dumps(label, ensure_ascii=False), json.dumps(label, ensure_ascii=False), json.dumps(value)))
    time.sleep(0.3)
    return out


def send_and_echo():
    h.js("""(async () => {
      const s=(ms)=>new Promise(r=>setTimeout(r,ms));
      const u=document.querySelector('.url-input');
      u.value='%s/echo'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(120);
      [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
      await s(1600);
    })()""" % BASE)
    out = h.eval_json("""(() => {
      const pre = document.querySelector('.response-body pre');
      if (!pre) return JSON.stringify({ noResponse: true });
      try {
        const doc = JSON.parse(pre.textContent);
        const lower = Object.fromEntries(Object.entries(doc.headers || {})
          .map(([k, v]) => [k.toLowerCase(), v]));
        return JSON.stringify({ query: doc.query || '', headers: lower });
      } catch (error) { return JSON.stringify({ parseError: String(error.message) }); }
    })()""")
    return out


def badge():
    return h.js("""(() => {
      const t = [...document.querySelectorAll('#request-host .subtab')]
        .find((b) => b.textContent.trim().startsWith('Auth'));
      return (t.textContent || '').replace(/\\s+/g, ' ').trim();
    })()""")


assert open_auth_tab() == "picker ready"

# ---------------- bearer ----------------
set_kind("bearer")
type_field("Token", "t0k3n-abc")
echo = send_and_echo()
h.check("Bearer 鉴权真的发出 Authorization: Bearer …，子标签徽标同步",
        echo.get("headers", {}).get("authorization") == "Bearer t0k3n-abc" and "Bearer" in badge(),
        {"auth": echo.get("headers", {}).get("authorization"), "badge": badge()})

# ---------------- basic ----------------
set_kind("basic")
type_field("用户名", "auditor")
pw_type = type_field("密码", "s3cr3t")
expected_basic = "Basic " + base64.b64encode(b"auditor:s3cr3t").decode()
echo = send_and_echo()
h.check("Basic 鉴权发出正确的 base64，且密码框是 password 类型",
        echo.get("headers", {}).get("authorization") == expected_basic and pw_type == "password"
        and "Basic" in badge(),
        {"auth": echo.get("headers", {}).get("authorization"), "expected": expected_basic,
         "inputType": pw_type, "badge": badge()})

# ---------------- api key into a header ----------------
set_kind("apikey")
type_field("Key", "X-Api-Key")
type_field("Value", "kv-77")
h.eval_json(pick("#request-host .select-field.apikey-into", "header"))
echo = send_and_echo()
h.check("API Key 选 Header 时进请求头、不进 query",
        echo.get("headers", {}).get("x-api-key") == "kv-77" and "kv-77" not in echo.get("query", "")
        and "API Key" in badge(),
        {"header": echo.get("headers", {}).get("x-api-key"), "query": echo.get("query")})

# ---------------- api key into the query ----------------
set_kind("apikey")
type_field("Key", "apiKey")
type_field("Value", "qv-88")
h.eval_json(pick("#request-host .select-field.apikey-into", "query"))
echo = send_and_echo()
h.check("API Key 选 Query 时进 query、不进请求头",
        "apiKey=qv-88" in echo.get("query", "") and not echo.get("headers", {}).get("apikey")
        and not echo.get("headers", {}).get("x-api-key"),
        {"query": echo.get("query"), "apikeyHeader": echo.get("headers", {}).get("apikey")})

# ---------------- no auth wins over a collection that has one ----------------
h.js("""(async () => {
  const st = await import('/js/state.js');
  const collection = st.state.collections[0];
  collection.auth = { kind: 'bearer', bearer: { token: 'COLL-9' },
    basic: { username: '', password: '' }, apikey: { key: '', value: '', addTo: 'header' } };
  st.touch('collections');
  return collection.name;
})()""")
set_kind("noauth")
echo = send_and_echo()
# "无" deliberately renders no badge at all — an empty badge is the signal
h.check("请求选「无鉴权」时，即使集合配了 Bearer 也不发，且徽标收起",
        not echo.get("headers", {}).get("authorization") and badge().strip() == "Auth",
        {"auth": echo.get("headers", {}).get("authorization"), "badge": badge()})

# ---------------- inherit ----------------
# A standalone tab has no collection above it, so inheritance has to be tested on
# a request that really is a child — created here through the node's context menu,
# which is the only way to reach it in the app.
h.js("document.querySelector('button[data-rail=collections]').click()")
time.sleep(0.4)
made = h.js("""(() => {
  const node = document.querySelector('#sidebar .node-collection') || document.querySelectorAll('#sidebar .node')[0];
  if (!node) return 'no collection node';
  node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return 'menu fired';
})()""")
time.sleep(0.4)
made += " / " + h.js("""(() => {
  const hit = [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.trim() === '新建请求');
  if (!hit) return 'no 新建请求 item: ' + [...document.querySelectorAll('.menu-item')].map(m=>m.textContent.trim()).join('|');
  hit.click();
  return 'created';
})()""")
time.sleep(0.9)
h.click_subtab("#request-host", "Auth")
set_kind("inherit")
echo = send_and_echo()
h.check("集合下的请求选「继承自集合」时拿到集合的 Bearer，徽标显示解析后的真实方式",
        made.endswith("created") and echo.get("headers", {}).get("authorization") == "Bearer COLL-9"
        and badge().strip() == "AuthBearer",
        {"made": made, "auth": echo.get("headers", {}).get("authorization"), "badge": badge()})

# ---------------- the collection's own picker must not offer self-inherit ----------------
h.js("document.querySelector('button[data-rail=collections]').click()")
time.sleep(0.4)
h.js("""(() => {
  const node = document.querySelector('#sidebar .node-collection') || document.querySelectorAll('#sidebar .node')[0];
  node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
})()""")
time.sleep(0.4)
opened = h.js("""(() => {
  const hit = [...document.querySelectorAll('.menu-item')]
    .find((m) => m.textContent.trim() === '集合信息 / 变量');
  if (!hit) return 'no menu item: ' + [...document.querySelectorAll('.menu-item')].map(m=>m.textContent.trim()).join('|');
  hit.click();
  return 'opened';
})()""")
time.sleep(0.9)
collection_kinds = kind_options(".overlay")
h.check("集合自己的鉴权下拉不再提供「继承自集合」（集合是链顶，选了等于静默无鉴权）",
        opened == "opened" and isinstance(collection_kinds, list) and collection_kinds
        and "inherit" not in collection_kinds,
        {"opened": opened, "options": collection_kinds})
h.js("""(() => { const b = document.querySelector('.overlay .modal-head button'); if (b) b.click(); })()""")
time.sleep(0.5)

# ---------------- 集合级默认请求头：发送时附加，不是预填 ----------------
h.js("""(async () => {
  const s = await import('/js/state.js');
  const col = s.newCollection('头测试集合');
  col.headers = [
    { id: s.uid('kv'), key: 'X-Tenant', value: 'from-collection', enabled: true, description: '' },
    { id: s.uid('kv'), key: 'X-Trace', value: 'collection-trace', enabled: true, description: '' },
  ];
  const node = s.newRequestNode('集合里的请求');
  node.request.url = '%s/echo';
  col.children.push(node);
  s.state.collections.push(col);
  s.touch('collections');
  s.openRequest(node, { replaceExisting: false });
  return 'ok';
})()""" % BASE)
time.sleep(0.9)

h.js("""(() => {
  [...document.querySelectorAll('#request-host .subtab')].find((b) => b.textContent.trim().startsWith('Headers')).click();
  return 1;
})()""")
time.sleep(0.6)
shown = h.eval_json("""(() => {
  const heads = [...document.querySelectorAll('#request-host .section h4')].map((x) => x.textContent);
  const rows = [...document.querySelectorAll('#request-host .pick')].length;
  const inTable = [...document.querySelectorAll('#request-host .kv input')].map((i) => i.value).filter(Boolean);
  return JSON.stringify({ heads, rows, inTable });
})()""")
h.check("Headers 面板里能看见集合会附加哪些头",
        any("头测试集合" in t for t in shown.get("heads", [])), shown)
h.check("集合默认头没有被预填进请求自己的请求头表",
        "X-Tenant" not in shown.get("inTable", []) and "X-Trace" not in shown.get("inTable", []), shown)

echo = send_and_echo()
h.check("集合默认头在发送时真的带上",
        echo.get("headers", {}).get("x-tenant") == "from-collection"
        and echo.get("headers", {}).get("x-trace") == "collection-trace", echo)

# 请求自己写了同名头 —— 以请求为准，而且不能出现两份
h.js("""(() => {
  const s0 = document.querySelector('#request-host .kv');
  [...document.querySelectorAll('#request-host .subtab')].find((b) => b.textContent.trim().startsWith('Headers')).click();
  return 1;
})()""")
time.sleep(0.5)
h.js("""(async () => {
  const s = await import('/js/state.js');
  const t = s.state.tabs.find((x) => x.id === s.state.activeTabId);
  t.draft.headers.push({ id: s.uid('kv'), key: 'X-Trace', value: 'request-wins', enabled: true, description: '' });
  s.markDirty(t);
  s.emit('rerender');
  return 'ok';
})()""")
time.sleep(0.6)
echo = send_and_echo()
trace = echo.get("headers", {}).get("x-trace")
h.check("请求自己写了同名头就以请求为准", trace == "request-wins", echo)
h.check("同名头不会被发两遍",
        "request-wins" in str(trace) and "collection-trace" not in str(trace)
        and echo.get("headers", {}).get("x-tenant") == "from-collection", echo)
override = h.eval_json("""(() => {
  const picks = [...document.querySelectorAll('#request-host .pick')].map((p) => p.textContent.replace(/\\s+/g, ' ').trim());
  return JSON.stringify(picks.filter((t) => t.includes('X-Trace')));
})()""")
h.check("被覆盖的那一项在界面上说清楚了自己被覆盖",
        any("覆盖" in t for t in override), override)

# 改集合那一处，不重开请求，下一次发送就是新值
h.js("""(async () => {
  const s = await import('/js/state.js');
  const col = s.state.collections.find((c) => c.name === '头测试集合');
  col.headers.find((x) => x.key === 'X-Tenant').value = 'tenant-after-edit';
  s.touch('collections');
  return 'ok';
})()""")
time.sleep(0.6)
echo = send_and_echo()
h.check("改集合的默认头，下一次发送立刻是新值（不用重开请求）",
        echo.get("headers", {}).get("x-tenant") == "tenant-after-edit", echo)

h.js("""(async () => {
  const s = await import('/js/state.js');
  const col = s.state.collections.find((c) => c.name === '头测试集合');
  col.headers.find((x) => x.key === 'X-Tenant').enabled = false;
  s.touch('collections');
  return 'ok';
})()""")
time.sleep(0.6)
echo = send_and_echo()
h.check("把某一行停用，就不再附加",
        not echo.get("headers", {}).get("x-tenant"), echo)

# 值里能引用变量
h.js("""(async () => {
  const s = await import('/js/state.js');
  const col = s.state.collections.find((c) => c.name === '头测试集合');
  col.variables = [{ id: s.uid('kv'), key: 'tenantId', value: 't-9527', enabled: true, description: '' }];
  col.headers.find((x) => x.key === 'X-Tenant').value = '{{tenantId}}';
  col.headers.find((x) => x.key === 'X-Tenant').enabled = true;
  s.touch('collections');
  return 'ok';
})()""")
time.sleep(0.7)
echo = send_and_echo()
h.check("集合默认头的值里可以引用集合变量",
        echo.get("headers", {}).get("x-tenant") == "t-9527", echo)

# 集合信息里得有编辑入口
h.js("document.querySelectorAll('.overlay').forEach((o) => o.remove()); 1")
opened_info = h.eval_json("""(async () => {
  const s = await import('/js/state.js');
  const col = s.state.collections.find((c) => c.name === '头测试集合');
  document.querySelector('.rail-btn[data-rail=collections]').click();
  await new Promise((r) => setTimeout(r, 250));
  const row = document.querySelector('.node[data-node=' + col.id + ']');
  if (!row) return JSON.stringify({ noRow: true });
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 250));
  const item = [...document.querySelectorAll('.menu .menu-item')].find((i) => i.textContent.includes('集合信息'));
  if (!item) return JSON.stringify({ noItem: true });
  item.click();
  await new Promise((r) => setTimeout(r, 500));
  return JSON.stringify({
    heads: [...document.querySelectorAll('.overlay .section h4')].map((x) => x.textContent),
    inputs: document.querySelectorAll('.overlay .kv input').length,
  });
})()""")
h.check("集合信息里有「默认请求头（发送时附加）」这一节",
        any("默认请求头" in t for t in opened_info.get("heads", [])), opened_info)
h.js("(() => { const b = document.querySelector('.overlay .modal-head button'); if (b) b.click(); return 1; })()")
time.sleep(0.4)

h.check("整轮鉴权测试没有产生 JS 报错", not h.console_errors(), h.console_errors()[:3])

h.finish()
