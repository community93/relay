"""Reads computed styles out of the running window and reports contrast ratios,
so the light theme can be checked objectively instead of by eye."""

import json
import os
import sys
import tempfile
import time
import urllib.request

import websocket

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# the file-upload row states only exist once a real path is in them
UPLOAD_FILE = os.path.join(tempfile.gettempdir(), "relay-audit-upload.bin")
with open(UPLOAD_FILE, "wb") as _handle:
    _handle.write(b"audit payload" * 40)
UPLOAD_ROWS = json.dumps(
    [["good", UPLOAD_FILE], ["bad", "D:\\relay\\missing-for-audit.bin"]],
    ensure_ascii=False,
)

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=5))
target = [p["webSocketDebuggerUrl"] for p in pages if p.get("type") == "page"][0]
sock = websocket.create_connection(target, timeout=60)
counter = [0]


def js(expression, timeout=60):
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
                return json.dumps({"error": result["exceptionDetails"].get("text")})
            value = result.get("result", {}).get("value")
            return value if isinstance(value, str) else json.dumps(value)
    return json.dumps({"error": "timeout"})


WARMUP = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const url = document.querySelector('.url-input');
  if (url && !url.value) { url.value = 'http://127.0.0.1:8899/list'; url.dispatchEvent(new Event('input', { bubbles: true })); }
  const send = [...document.querySelectorAll('.urlbar button')].find((b) => /Send|发送/.test(b.textContent));
  if (send) send.click();
  await sleep(1600);
  const tree = [...document.querySelectorAll('.response-body .seg button')].find((b) => b.textContent.trim() === '树');
  if (tree) tree.click();
  await sleep(400);
  return 'warmed';
})()
"""

SAMPLE = r"""
(async () => {
  const parse = (c) => {
    const raw = String(c).trim();
    if (raw.startsWith('#')) {
      const hex = raw.slice(1);
      const full = hex.length === 3 ? hex.split('').map((x) => x + x).join('') : hex.slice(0, 6);
      return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    }
    const body = raw.replace(/color\(srgb\s*/, '').replace(/^rgba?\(/, '');
    const m = body.match(/-?\d+(\.\d+)?/g);
    if (!m) return [0, 0, 0];
    // color(srgb ...) is 0..1 floats; rgb()/hex is 0..255
    const scale = raw.startsWith('color(srgb') ? 255 : 1;
    return m.slice(0, 3).map((v) => Math.round(parseFloat(v) * (scale === 255 && parseFloat(v) <= 1 ? 255 : 1)));
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(parse(a)), lum(parse(b))].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const alpha = (rgb) => {
    const m = String(rgb).match(/\/\s*([\d.]+)\s*\)|rgba?\(([^)]*)\)/);
    if (!m) return 1;
    const parts = (m[1] !== undefined ? m[1] : m[2].split(',')[3]);
    return parts === undefined ? 1 : parseFloat(parts);
  };
  const flatten = (rgb, backdrop) => {
    const a = alpha(rgb);
    if (a >= 1) return rgb;
    const fg = parse(rgb);
    const bg = parse(backdrop);
    return `rgb(${fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a))).join(', ')})`;
  };
  const bgOf = (node) => {
    const chain = [];
    let cur = node;
    while (cur && cur !== document.documentElement) {
      const c = getComputedStyle(cur).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') chain.push(c);
      cur = cur.parentElement;
    }
    chain.push(getComputedStyle(document.body).backgroundColor);
    let base = chain.pop();
    while (chain.length) base = flatten(chain.pop(), base);
    return base;
  };
  const targets = /*TARGETS*/[];
  const rows = [];
  for (const [label, selector] of targets) {
    const node = document.querySelector(selector);
    if (!node) { rows.push({ label, missing: true }); continue; }
    const cs = getComputedStyle(node);
    const bg = bgOf(node);
    rows.push({ label, color: cs.color, bg, ratio: +ratio(cs.color, bg).toFixed(2), size: cs.fontSize });
  }
  // The lit segment sits on a sibling .seg-thumb, not on any ancestor's
  // background, so bgOf() structurally cannot see it and this pair would sail
  // through every other check. Measure it against the thing actually behind it.
  for (const seg of document.querySelectorAll('.seg')) {
    const on = seg.querySelector('.seg button.on');
    const thumb = seg.querySelector('.seg-thumb');
    if (!on || !thumb) continue;
    const bg = getComputedStyle(thumb).backgroundColor;
    rows.push({ label: '活动分段「' + on.textContent.trim() + '」', color: getComputedStyle(on).color,
      bg, ratio: +ratio(getComputedStyle(on).color, bg).toFixed(2), size: getComputedStyle(on).fontSize });
  }
  const tokens = getComputedStyle(document.documentElement);
  return JSON.stringify({
    theme: document.documentElement.dataset.theme,
    page: { bg: tokens.getPropertyValue('--bg').trim(), text: tokens.getPropertyValue('--text').trim(), accent: tokens.getPropertyValue('--accent').trim(), line: tokens.getPropertyValue('--line').trim() },
    bodyRatio: +ratio(tokens.getPropertyValue('--text'), tokens.getPropertyValue('--bg')).toFixed(2),
    faintRatio: +ratio(tokens.getPropertyValue('--text-faint'), tokens.getPropertyValue('--bg')).toFixed(2),
    dimRatio: +ratio(tokens.getPropertyValue('--text-dim'), tokens.getPropertyValue('--bg')).toFixed(2),
    accentOnBg: +ratio(tokens.getPropertyValue('--accent'), tokens.getPropertyValue('--bg-raised')).toFixed(2),
    lineVsBg: +ratio(tokens.getPropertyValue('--line'), tokens.getPropertyValue('--bg')).toFixed(2),
    rows,
  });
})()
"""

SSE_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
  [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('SSE')).click(); await sleep(350);
  const u = document.querySelector('.url-input');
  u.value = 'http://127.0.0.1:8899/sse'; u.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.urlbar button')].find((b) => /连接|Send/.test(b.textContent)).click();
  await sleep(2200);
  return 'sse';
})()
"""

RAW_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
  [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('SSE')).click(); await sleep(300);
  const u = document.querySelector('.url-input');
  u.value = 'http://127.0.0.1:8899/sse'; u.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.urlbar button')].find((b) => /连接|Send/.test(b.textContent)).click();
  await sleep(2400);
  [...document.querySelectorAll('.subtab')].find((b) => b.textContent.indexOf('原始流') === 0).click();
  await sleep(400);
  return 'raw';
})()
"""

ENV_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('button[data-rail=environments]').click(); await sleep(300);
  document.querySelectorAll('#sidebar .node')[0].click(); await sleep(500);
  return 'env';
})()
"""

ERR_HTTP_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
  [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
  const u = document.querySelector('.url-input');
  u.value = 'http://127.0.0.1:59999/dead'; u.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.urlbar button')].find((b) => /Send|发送/.test(b.textContent)).click();
  await sleep(2800);
  return 'err-http';
})()
"""

# a 4xx is the only thing that puts the amber warn pill on screen; without this
# pass that pill is measured purely by luck of whatever a suite left behind
WARN_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
  [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
  const u = document.querySelector('.url-input');
  u.value = 'http://127.0.0.1:8899/does-not-exist'; u.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.urlbar button')].find((b) => /Send|发送/.test(b.textContent)).click();
  await sleep(2000);
  const pill = document.querySelector('.response-head .pill');
  return pill && pill.classList.contains('warn') ? 'warn' : 'no-warn-pill:' + (pill ? pill.className : 'none');
})()
"""

ERR_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
  [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('SSE')).click(); await sleep(300);
  const u = document.querySelector('.url-input');
  u.value = 'http://127.0.0.1:59999/dead'; u.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.urlbar button')].find((b) => /连接|Send/.test(b.textContent)).click();
  await sleep(2600);
  return 'err';
})()
"""

BACK_NAV = r"""
(async () => {
  const tabs = [...document.querySelectorAll('.tabstrip .tab')];
  (tabs.find((t) => t.textContent.includes('GET')) || tabs[0]).click();
  return 'back';
})()
"""

# a form-data file row is the only screen holding the picker chip and the
# resolved/missing size labels, so it has to be built before it can be measured
UPLOAD_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await sleep(250);
  [...document.querySelectorAll('.menu-item')].find((m) => m.textContent.includes('HTTP')).click(); await sleep(300);
  [...document.querySelectorAll('.subtab')].find((b) => b.textContent.trim().startsWith('Body')).click(); await sleep(260);
  [...document.querySelectorAll('#request-host .body-formats button')].find((r) => r.textContent.trim() === '表单').click();
  await sleep(420);
  const kv = document.querySelector('#request-host .kv');
  const type = (i, v) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
  for (const [key, path] of %%ROWS%%) {
    type(kv.querySelector('.kv-row.ghost').querySelectorAll('input')[0], key); await sleep(240);
    const row = [...kv.querySelectorAll('.kv-row:not(.ghost):not(.kv-head)')].pop();
    const kind = row.querySelector('.select-field.kv-kind');
    kind.click(); await sleep(240);
    [...document.querySelectorAll('.menu .menu-item')]
      .find((r) => r.getAttribute('data-value') === 'file').click();
    await sleep(300);
    const valueInput = row.querySelectorAll('input')[2];
    type(valueInput, path); valueInput.dispatchEvent(new Event('blur')); await sleep(1000);
  }
  return 'upload';
})()
""".replace("%%ROWS%%", UPLOAD_ROWS)

# a saved request nobody has sent yet: the one screen where the empty state and
# the "已保存" button exist together
EMPTY_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('button[data-rail=collections]').click(); await sleep(300);
  // any saved request that is not already open: no response yet, so the empty
  // screen and the "已保存" state are both on screen
  const open = new Set([...document.querySelectorAll('.tabstrip .tab')].map((tab) => tab.textContent.trim()));
  const node = [...document.querySelectorAll('#sidebar .node-request')].find((n) => !open.has(n.textContent.trim()));
  if (!node) return 'no-unopened-request';
  node.click(); await sleep(700);
  return 'empty';
})()
"""

# the shortcut chips moved out of the empty state into the ? drawer, so the
# drawer has to be opened for them to be measurable at all
SHORTCUTS_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tools = await import('/js/tools.js');
  tools.openShortcuts(); await sleep(600);
  return document.querySelector('.modal-right') ? 'shortcuts' : 'drawer-missing';
})()
"""

PICK_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const s = await import('/js/state.js');
  s.state.pane = 'collections'; s.emit('pane'); await sleep(300);
  let col = s.state.collections.find((c) => c.name === '对比度夹具');
  if (!col) {
    col = s.newCollection('对比度夹具');
    col.children = [];
    for (let i = 1; i <= 3; i++) {
      const n = s.newRequestNode('夹具 ' + i);
      n.request.url = 'http://127.0.0.1:8899/hello';
      col.children.push(n);
    }
    s.state.collections.push(col);
    s.state.expanded[col.id] = true;
    s.touch('collections'); s.emit('tree'); await sleep(300);
  }
  const rows = [...document.querySelectorAll('#sidebar .node')].filter((r) => col.children.some((c) => c.id === r.dataset.node));
  const pick = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  pick(rows[0]); await sleep(160); pick(rows[1]); await sleep(360);
  return document.querySelector('.sidebar-head .btn.danger') ? 'picking' : 'no-pick-bar';
})()
"""

UNDO_NAV = r"""
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await sleep(500);
  const ok = document.querySelector('.modal-foot .btn.primary');
  if (ok) ok.click();
  await sleep(500);
  const s = await import('/js/state.js');
  const found = document.querySelector('.toast-act');
  const verdict = found ? 'undo' : 'no-undo-button';
  const i = s.state.collections.findIndex((c) => c.name === '对比度夹具');
  if (i >= 0) { s.state.collections.splice(i, 1); s.touch('collections'); s.emit('tree'); }
  return verdict;
})()
"""

PASSES = [
    ("HTTP 响应 + 侧栏", None, [
        ["正文 text", ".sidebar-body .node .name"],
        ["次级文字 dim", ".sidebar-title"],
        ["弱化文字 faint", ".hint"],
        ["输入框文字", ".url-input"],
        ["输入框占位符底", ".url-field"],
        ["标签页 active", ".tab.active .label"],
        ["响应状态 pill", ".pill"],
        ["响应 meta", ".meta"],
        ["按钮 primary", ".btn.primary"],
        ["按钮 default", ".btn"],
        ["方法色 GET", ".method-get"],
        ["子标签 active", ".subtab.on"],
        ["顶栏", ".topbar"],
        ["代码 pre", ".response-body pre"],
        ["KV 表格键", ".kv-row .mono"],
        ["KV 表头底纹", ".kv-head"],
    ]),
    ("空状态", EMPTY_NAV, [
        ["空状态标题", ".empty h3"],
        ["空状态说明", ".empty p"],
        ["已保存按钮", ".btn.success"],
        ["子标签 active", ".subtab.on"],
    ]),
    ("快捷键抽屉", SHORTCUTS_NAV, [
        ["抽屉底", ".modal-right"],
        ["抽屉标题", ".modal-right .modal-head h2"],
        ["分组标题", ".modal-right .group-head"],
        ["行名称", ".modal-right .row-label"],
        ["按键 kbd", ".kbd"],
    ]),
    ("SSE 事件流", SSE_NAV, [
        ["事件标签 tag", ".tag"],
        ["事件标签 msg", ".tag.msg"],
        ["事件标签 err", ".tag.err"],
        ["事件标签 out", ".tag.out"],
        ["事件时间", ".event-head .faint"],
        ["响应状态 pill", ".pill"],
    ]),
    ("SSE 原始流", RAW_NAV, [
        ["原始流段标题", ".raw-meta"],
        ["原始流正文", ".raw-text"],
        ["原始流工具条", ".raw-bar"],
    ]),
    ("环境设置", ENV_NAV, [
        ["chip 变量", ".chip"],
        ["分组行标题", ".row-label"],
        ["分组行取值", ".row-value"],
        ["KV ghost 加号", ".kv-plus"],
    ]),
    ("文件上传行", UPLOAD_NAV, [
        ["选择按钮 chip", ".kv-pick"],
        ["文件大小标注", ".kv-file-meta"],
        ["文件缺失标注", ".kv-file-meta.bad"],
    ]),
    # the tree's picking state and the undo affordance only exist mid-flow, so
    # they get their own two passes — the second one continues where the first left off
    ("树多选态", PICK_NAV, [
        ["已选计数", ".sidebar-head .sidebar-title"],
        ["删除按钮", ".sidebar-head .btn.danger"],
        ["取消按钮", ".sidebar-head .btn:not(.danger)"],
        ["勾选圆盘(已选)", ".pick-box.on"],
        ["已选行名", ".node.picked .name"],
        ["未选行名", ".node:not(.picked) .name"],
    ]),
    ("撤销提示条", UNDO_NAV, [
        ["提示条正文", ".toast.ok"],
        ["撤销按钮", ".toast-act"],
    ]),
    # error states only exist after a failure, so they have to be provoked —
    # without this pass the red-on-tint chips go unaudited
    ("告警态(4xx)", WARN_NAV, [
        ["状态 pill warn", ".pill.warn"],
        ["告警 pill 底", ".response-head .pill"],
    ]),
    ("失败态(HTTP)", ERR_HTTP_NAV, [        ["状态 pill err", ".pill.err"],
        ["错误正文", ".response .pane p"],
        ["错误提示行", ".response .pane .hint"],
        ["toast err", ".toast.err"],
    ]),
    ("失败态(SSE)", ERR_NAV, [
        ["事件标签 err", ".tag.err"],
    ]),
]

if len(sys.argv) > 2 and sys.argv[2] == "dark":
    js("(async () => { document.documentElement.dataset.theme = 'dark'; return 'dark'; })()")
js(WARMUP)

report = None
rows = []
for name, nav, targets in PASSES:
    if nav:
        jumped = js(nav)
        if isinstance(jumped, dict) or (isinstance(jumped, str) and jumped.startswith('{"')):
            print(f"导航到「{name}」失败：{jumped}")
            sys.exit(1)
    sample = json.loads(js(SAMPLE.replace("/*TARGETS*/[]", json.dumps(targets))))
    if "error" in sample:
        print("FAILED:", name, sample)
        sys.exit(1)
    report = report or sample
    for row in sample["rows"]:
        rows.append(dict(row, view=name))
    # a pass that leaves a sheet or drawer up would blind every pass after it,
    # because the overlay eats the next nav click
    js("(async () => { const o = document.querySelector('.overlay:not(.closing)');"
       " if (o) { const b = o.querySelector('.modal-head button'); if (b) b.click(); } return 1; })()")
    time.sleep(0.5)
js(BACK_NAV)
# leave the window on the theme it started with, or the next suite sees dark
if len(sys.argv) > 2 and sys.argv[2] == "dark":
    js("(async () => { document.documentElement.dataset.theme = 'light'; return 'light'; })()")

if report is None:
    print("FAILED: no pass ran")
    sys.exit(1)

print(f"主题 {report['theme']}  页面底 {report['page']['bg']}  正文 {report['page']['text']}  主色 {report['page']['accent']}")
print(f"正文/页面底 对比度 = {report['bodyRatio']}:1  (AA 需 >= 4.5)\n")
worst = []
seen = set()
for row in rows:
    if row.get("missing"):
        print(f"  --   {row['label']}（{row['view']} 视图无此元素）")
        continue
    key = (row["label"], row["view"])
    if key in seen:
        continue
    seen.add(key)
    flag = "ok " if row["ratio"] >= 4.5 else ("低 " if row["ratio"] >= 3 else "差 ")
    print(f"  {flag}{row['ratio']:>5}:1  {row['view']:<14} {row['label']:<18} {row['color']:<20} on {row['bg']}")
    if row["ratio"] < 4.5:
        worst.append(row)
print()
print("低于 AA 的元素：" + (", ".join(f"{w['view']}/{w['label']}" for w in worst) if worst else "无"))
sys.exit(1 if worst else 0)
