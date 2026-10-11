"""Every segmented control and every switch, cycled both ways with real clicks.

This suite exists because three shipped bugs shared one shape — a control whose
click means something different depending on which option is live, never driven
with a real pointer. The worst of them made the *initially selected* segment of a
segmented control permanently unclickable, and no existing check noticed, because
they all clicked away from the default and never back.

So the rule here is: click every option, then click the one that started lit.

    python tests/e2e_controls.py [cdp-port]
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import BASE, Harness  # noqa: E402
from ui_js import end_stub_save, stub_save  # noqa: E402

h = Harness(label="controls")

# A control is addressed by the text of its buttons, never by index: the env tab
# re-groups its rows as its body mode changes, so a positional selector would
# silently start driving a different control.
TAG = """(() => {
  const want = %s;
  const segs = [...document.querySelectorAll('.seg')];
  const hit = segs.find((s) => JSON.stringify(
    [...s.querySelectorAll('button')].map((b) => b.textContent.trim())) === JSON.stringify(want));
  segs.forEach((s) => s.removeAttribute('data-probe'));
  if (!hit) return JSON.stringify({ found: false, present: segs.map((s) =>
    [...s.querySelectorAll('button')].map((b) => b.textContent.trim())) });
  hit.setAttribute('data-probe', '1');
  return JSON.stringify({ found: true });
})()"""


def tag_seg(labels):
    return h.eval_json(TAG % json.dumps(labels, ensure_ascii=False))


def seg_state(labels):
    """Always re-tag by button text: several of these controls rebuild their own
    subtree on change (Body 类型 remounts 语言), which would strip a tag applied
    once at the start and leave the reader looking at a detached node."""
    found = tag_seg(labels)
    if not found.get("found"):
        return {"missing": True, "why": found}
    return h.eval_json("""(() => {
      const seg = document.querySelector('.seg[data-probe]');
      const btns = [...seg.querySelectorAll('button')];
      const on = btns.findIndex((b) => b.classList.contains('on'));
      const thumb = seg.querySelector('.seg-thumb').getBoundingClientRect();
      const lit = on >= 0 ? btns[on].getBoundingClientRect() : null;
      return JSON.stringify({
        labels: btns.map((b) => b.textContent.trim()),
        on,
        checked: btns.map((b) => b.getAttribute('aria-checked')),
        thumbX: Math.round(thumb.x), thumbW: Math.round(thumb.width),
        litX: lit ? Math.round(lit.x) : null, litW: lit ? Math.round(lit.width) : null,
      });
    })()""")


def click_seg(labels, index):
    if not tag_seg(labels).get("found"):
        return {"missing": True}
    return h.click_seg_button("document.querySelector('.seg[data-probe]')", index)


def cycle(name, labels, read_state=None):
    """Click every segment, then the one that started lit. A control is only
    correct if the lit index, the thumb geometry and `aria-checked` all agree at
    every stop — and if the thumb actually sits on the label it claims to mark."""
    if not tag_seg(labels).get("found"):
        present = h.js("""(() => JSON.stringify([...document.querySelectorAll('.seg')]
          .map((s) => [...s.querySelectorAll('button')].map((b) => b.textContent.trim()))))()""")
        h.check(name, False, {"control not found": present, "wanted": labels})
        return
    start = seg_state(labels)["on"]
    steps = list(range(len(labels))) + [start]
    problems = []
    for target in steps:
        landed = click_seg(labels, target)
        if landed.get("clickDidNotLand") or landed.get("missing"):
            problems.append({"step": target, "click did not land": landed.get("clickDidNotLand") or landed})
            break
        st = seg_state(labels)
        if st.get("missing"):
            problems.append({"step": target, "state": st.get("why")})
            break
        if st["on"] != target:
            problems.append({"step": target, "on": st["on"], "labels": st["labels"]})
        if st["checked"].count("true") != 1 or st["checked"][target] != "true":
            problems.append({"step": target, "aria": st["checked"]})
        if abs(st["thumbX"] - st["litX"]) > 2 or abs(st["thumbW"] - st["litW"]) > 2:
            problems.append({"step": target, "thumb": [st["thumbX"], st["thumbW"]],
                             "lit": [st["litX"], st["litW"]]})
        if read_state:
            extra = read_state(target)
            if extra:
                problems.append({"step": target, "effect": extra})
    detail = {"clicked": steps, "startedOn": start}
    if problems:
        detail["problems"] = problems[:6]
    h.check(name, not problems, detail)


def open_env_tab():
    h.js("document.querySelector('button[data-rail=environments]').click()")
    time.sleep(0.4)
    h.js("document.querySelectorAll('#sidebar .node')[0].click()")
    time.sleep(0.7)


def open_settings():
    h.js("""(() => {
      const b = [...document.querySelectorAll('.topbar button')].find((x) => x.title === '设置');
      b.click();
    })()""")
    time.sleep(0.8)


def close_modal():
    h.js("""(() => { const b = document.querySelector('.overlay:not(.closing) .modal-head button'); if (b) b.click(); })()""")
    time.sleep(0.5)


def select_seg(labels, wanted_text):
    """Put a control on a specific option, so the next check starts from a known
    place instead of wherever the previous cycle happened to end."""
    state = seg_state(labels)
    if state.get("missing"):
        return False
    index = state["labels"].index(wanted_text)
    click_seg(labels, index)
    return seg_state(labels).get("on") == index


# ---------------- composer: protocol ----------------
h.js("""(() => {
  document.querySelectorAll('.overlay').forEach(o => o.remove());
  document.body.classList.remove('has-sheet'); delete document.body.dataset.sheets;
})()""")
h.js("document.querySelectorAll('.tabstrip .tab-new')[0].click()")
time.sleep(0.3)
h.js("[...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click()")
time.sleep(0.5)


def protocol_effect(index):
    got = h.eval_json("""(() => {
      const bar = document.querySelector('.urlbar');
      return JSON.stringify({
        segs: [...bar.querySelectorAll('.seg button')].map(b => b.classList.contains('on')),
        label: [...bar.querySelectorAll('button')].map(b => b.textContent.trim()).join('|'),
      });
    })()""")
    if got.get("segs") and sum(1 for x in got["segs"] if x) != 1:
        return got
    return None


cycle("协议分段控件 HTTP/SSE/WS 正反都点得动，滑块贴合当前项", ["HTTP", "SSE", "WS"], protocol_effect)

# ---------------- response: Pretty / 树 / Raw ----------------
# the cycle above leaves the tab on WS, so put it back before sending
select_seg(["HTTP", "SSE", "WS"], "HTTP")
h.js("""(async () => {
  const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const u=document.querySelector('.url-input');
  u.value='%s/list'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('发送')).click();
  await s(1800);
  return 1;
})()""" % BASE)
cycle("响应视图 Pretty/树/Raw 正反都点得动", ["Pretty", "树", "Raw"])

# ---------------- settings: theme + zoom ----------------
open_settings()
cycle("设置「外观」深浅色正反都点得动（2 段控件）", ["深色", "浅色"])
cycle("设置「界面字号」所有档位正反都点得动", ["紧凑", "标准", "偏大", "大字", "125%", "150%", "200%"])
close_modal()

# ---------------- env tab: prefix policy, body type, raw language ----------------
open_env_tab()
cycle("环境「前缀策略」三档正反都点得动", ["预填前缀", "自动拼接", "手动"])


def body_type_effect(index):
    """Body 类型 is the one control whose onChange remounts its own siblings:
    leaving raw destroys the 语言 control and coming back rebuilds it."""
    labels = ["不预填", "raw", "URL 编码", "表单"][index]
    raw_lang_present = h.js("(() => { const segs=[...document.querySelectorAll('#request-host .seg')];"
                            " return JSON.stringify(segs.map(s=>[...s.querySelectorAll('button')].map(b=>b.textContent.trim()))); })()")
    present = json.loads(raw_lang_present)
    has_lang = any("JSON" in row for row in present)
    if labels == "raw" and not has_lang:
        return {"raw selected but 语言 control missing": present}
    if labels != "raw" and has_lang:
        return {"raw not selected but 语言 control still mounted": present}
    return None


cycle("环境「Body 类型」四档正反都点得动，raw 才挂出语言选择", ["不预填", "raw", "URL 编码", "表单"], body_type_effect)
# the cycle above ends back on 不预填, which correctly unmounts 语言 — put it back
# on raw or there is nothing left to click
select_seg(["不预填", "raw", "URL 编码", "表单"], "raw")
cycle("环境「raw 语言」四档正反都点得动（条件挂载的那个）", ["JSON", "Text", "XML", "HTML"])

# ---------------- every switch: flip twice, land where you started ----------------
SWITCHES = [
    ("启用此环境", "state.settings.activeEnvironmentId"),
    ("每次发送都附加这些请求头", "envAlwaysOn"),
    ("新建请求带上 Body", "envPrefillBody"),
]
names = h.js("""(() => JSON.stringify([...document.querySelectorAll('#request-host .switch')]
  .map(s => s.getAttribute('aria-label'))) )()""")
switch_labels = json.loads(names) if isinstance(names, str) else names
h.check("环境页的开关都带 aria-label，可被非位置方式定位",
        bool(switch_labels) and all(l for l in switch_labels), {"labels": switch_labels})


def flip_switch(label, scope="#request-host"):
    """Flip a switch, assert class + aria-checked agree, flip back, assert the
    original state returned. A switch that only moves one way is a dead control."""
    named = h.switch_named(label, scope)

    def state():
        return h.eval_json("""(() => {
          const s = %s;
          if (!s) return JSON.stringify({ missing: true });
          return JSON.stringify({ on: s.classList.contains('on'), aria: s.getAttribute('aria-checked') });
        })()""" % named)

    before = state()
    if before.get("missing") or before.get("jsError"):
        return {"label": label, "problems": ["switch not found"]}
    original = dict(before)
    problems = []
    for expect_flip in (True, False):
        point = h.point(named)
        if point.get("blocked") or not point.get("onScreen"):
            return {"label": label, "problems": [f"click could not land: {point}"]}
        h.mouse_at(point["x"], point["y"])
        time.sleep(0.7)
        now = state()
        if now.get("missing"):
            return {"label": label, "problems": ["switch vanished after a flip"]}
        # the restore check must compare against the *original* state, not against
        # the flipped one — re-baselining makes a correct restore look like a failure
        want = not original["on"] if expect_flip else original["on"]
        if now["on"] != want:
            problems.append("first flip did nothing" if expect_flip else "second flip did not restore")
        if now["aria"] != ("true" if now["on"] else "false"):
            problems.append("aria-checked disagrees with .on class")
    return {"label": label, "problems": problems, "original": original} if problems else None


switch_problems = [r for r in (flip_switch(l) for l in switch_labels if l) if r]
h.check("环境页每个开关都能开也能关，且 aria-checked 与 .on 始终一致",
        bool(switch_labels) and not switch_problems, switch_problems[:4])

# settings-modal switches — they live under the 请求 section now, so open it first
open_settings()
h.js("""(() => {
  const nav = [...document.querySelectorAll('.settings-nav button')].find(b => b.textContent.trim() === '请求');
  nav.click();
})()""")
time.sleep(0.4)
settings_switches = json.loads(h.js("""(() => JSON.stringify([...document.querySelectorAll('.overlay .switch')]
  .map(s => s.getAttribute('aria-label'))) )()"""))
sp = [r for r in (flip_switch(l, scope=".overlay") for l in settings_switches if l) if r]
nav_labels = json.loads(h.js("""JSON.stringify([...document.querySelectorAll('.settings-nav button')].map(b=>b.textContent.trim()))"""))
h.check("设置分区包含AI连接，当前内容按分区显示",
        nav_labels == ["通用", "请求", "数据", "AI 连接", "快捷键"], {"nav": nav_labels})
h.check("设置弹窗三个开关（SSL/重定向/Cookie）都有可访问名字且能来回翻",
        len([l for l in settings_switches if l]) == 3 and not sp,
        {"labels": settings_switches, "problems": sp[:3]})
close_modal()

# ---------------- dead-control sweep ----------------
# Click everything reachable on the composer and response head. The invariant is
# not "something visibly changed" (a few controls are legitimately idempotent) but
# that no handler throws, no overlay is left stuck over the app, and no placeholder
# text leaks into the page.
before_errors = len(h.console_errors())
sweep = h.eval_json("""(async () => {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const targets = [...document.querySelectorAll('#request-host button, #response-host button')]
    .filter((b) => !b.disabled && b.offsetParent !== null);
  const threw = [];
  for (const b of targets) {
    const label = (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 18) || b.className;
    try { b.click(); } catch (error) { threw.push(label + ': ' + error.message); }
    await s(40);
    document.querySelectorAll('.overlay .modal-head button').forEach((x) => { try { x.click(); } catch (e) {} });
    document.querySelectorAll('.menu').forEach((m) => m.remove());
  }
  await s(400);
  const stray = [...document.querySelectorAll('body *')].filter((e) => [...e.childNodes]
    .some((n) => n.nodeType === 3 && /^(null|undefined|\\[object Object\\])$/.test((n.nodeValue || '').trim())))
    .map((e) => e.className + ':' + e.textContent.trim().slice(0, 16));
  return JSON.stringify({ count: targets.length, threw, stray,
    stuckOverlay: !!document.querySelector('.overlay:not(.closing)'),
    sheets: document.body.dataset.sheets || null,
    workspaceAlive: !!document.querySelector('.workspace .urlbar') });
})()""")
h.check("扫一遍所有可见按钮：无异常抛出、无残留遮罩、无 null 文本",
        not sweep.get("jsError") and not sweep.get("threw") and not sweep.get("stray")
        and not sweep.get("stuckOverlay") and not sweep.get("sheets") and sweep.get("workspaceAlive"),
        {"clicked": sweep.get("count"), "threw": (sweep.get("threw") or [])[:4],
         "stray": sweep.get("stray"), "stuckOverlay": sweep.get("stuckOverlay"),
         "sheets": sweep.get("sheets")})
h.check("整轮控件扫描没有产生 JS 报错", len(h.console_errors()) == before_errors, h.console_errors()[:3])

# ---- 自绘 listbox 取代原生 select ----
pick = h.eval_json(r"""(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mod = await import('/js/state.js');
  const req = await import('/js/request.js');
  const proto = await import('/js/protocol.js');
  const state = mod.state;
  // Text payloads retain the language picker; JSON is chosen directly once.
  // Pin HTTP and choose text before testing the custom picker.
  const tab = state.tabs.find((t) => t.kind === 'request' && (t.protocol || 'http') === 'http')
    || state.tabs.find((t) => t.kind === 'request');
  if (!tab) return JSON.stringify({ noTab: true, kinds: state.tabs.map((t) => t.kind) });
  state.activeTabId = tab.id;
  if (tab.protocol !== 'http') proto.setProtocol(tab, 'http');
  tab.view = 'body';
  req.renderInto(document.getElementById('request-host'));
  await sleep(500);
  [...document.querySelectorAll('#request-host .body-formats button')].find(b=>b.textContent.trim()==='文本').click();await sleep(250);
  const field = document.querySelector('#request-host .editor-bar .select-field');
  if (!field) {
    return JSON.stringify({
      noField: true,
      protocol: tab.protocol,
      fields: [...document.querySelectorAll('.select-field')].map((f) => f.className + '=' + f.textContent.trim()),
    });
  }
  const before = document.querySelectorAll('select').length;
  const widthBefore = field.getBoundingClientRect().width;
  field.click();
  await sleep(250);
  const m = document.querySelector('.menu');
  const rows = m ? [...m.querySelectorAll('.menu-item')] : [];
  const marked = rows.filter((r) => r.classList.contains('on'));
  const ring = m ? getComputedStyle(m).outlineStyle : null;
  const target = rows.find((r) => !r.classList.contains('on'));
  const wanted = target ? target.textContent.trim() : null;
  if (target) target.click();
  await sleep(250);
  return JSON.stringify({
    nativeSelects: before,
    openedMenu: !!m,
    menuThemed: m ? !/rgb\(255, 255, 255\)/.test(getComputedStyle(m).backgroundColor) : false,
    markedCount: marked.length,
    hasCheck: !!(m && m.querySelector('.menu-mark svg')),
    containerRing: ring,
    labelAfter: field.textContent.trim(),
    wanted,
    widthStable: Math.abs(field.getBoundingClientRect().width - widthBefore) < 160,
    menuGone: !document.querySelector('.menu'),
  });
})()""")
h.check("下拉框是应用自己的弹层：无原生 select、当前项唯一且有勾、选完即生效并收起",
        pick.get("nativeSelects") == 0 and pick.get("openedMenu") and pick.get("menuThemed")
        and pick.get("markedCount") == 1 and pick.get("hasCheck") and pick.get("menuGone")
        and pick.get("labelAfter") == pick.get("wanted"), pick)
h.check("菜单容器不再叠一圈全局 focus 环（行高亮才是键盘指示器）",
        pick.get("containerRing") in (None, "none"), pick)

# ---- 同一层的请求名称必须左对齐 ----
align = h.eval_json(r"""(() => {
  const rows = [...document.querySelectorAll('#sidebar .node')].filter((r) => {
    const n = r.querySelector('.name');
    return n && r.getBoundingClientRect().height > 0;
  });
  const byIndent = {};
  for (const r of rows) {
    const depth = r.closest('.children') ? 1 : 0;
    const name = r.querySelector('.name').getBoundingClientRect();
    (byIndent[depth] = byIndent[depth] || []).push({
      x: Math.round(name.left * 10) / 10,
      label: r.querySelector('.name').textContent.trim().slice(0, 14),
      badge: !!r.querySelector('.badge'),
    });
  }
  const bad = [];
  for (const [depth, list] of Object.entries(byIndent)) {
    const withBadge = list.filter((i) => i.badge);
    if (withBadge.length < 2) continue;
    const xs = withBadge.map((i) => i.x);
    if (Math.max(...xs) - Math.min(...xs) > 0.6) bad.push({ depth, xs, list: withBadge });
  }
  return JSON.stringify({ groups: Object.keys(byIndent).length, bad });
})()""")
h.check("集合树里同一层的方法徽章等宽，请求名称左对齐", not align.get("bad"), align)

# ---- 导出全部走 saveAs，界面上不再有任何 blob 下载 ----
# Asserted against the shipped source rather than by triggering an export: calling
# `saveAs` for real opens a modal OS sheet, which blocks the webview and made the
# whole suite time out. e2e_features owns the "a file really lands on disk" case.
sources = h.eval_json("""(async () => {
  const files = ['ui.js','response.js','doc.js','sse.js','tools.js','env.js','tree.js','app.js','ws.js','kv.js'];
  const bad = [];
  let saveAsSites = 0;
  for (const f of files) {
    const src = await (await fetch('/js/' + f)).text();
    for (const line of src.split('\\n')) {
      if (/[^a-zA-Z]download\\s*\\(/.test(line) && !/function download/.test(line)
          && !/saveAs/.test(line) && f !== 'ui.js') bad.push(f + ': ' + line.trim().slice(0, 60));
      if (/await saveAs\\(|return saveAs\\(|saveAs\\(\\{/.test(line)) saveAsSites += 1;
    }
  }
  return JSON.stringify({ bad, saveAsSites });
})()""")
h.check("所有导出路径都改走 saveAs，源码里不再残留 blob 下载调用",
        not sources.get("bad") and sources.get("saveAsSites", 0) >= 8, sources)

# 顶栏的「全局变量」按钮：改值不该等到按「完成」才对其它请求生效。
h.js("""(() => {
  window.__envEmits = 0;
  import('/js/state.js').then((s) => s.on('environment', () => { window.__envEmits += 1; }));
  return 1;
})()""")
time.sleep(0.3)

bar = h.eval_json("""(() => {
  const buttons = [...document.querySelectorAll('.topbar > button, .topbar .btn')];
  const globals = buttons.find((b) => (b.title || '').includes('全局变量'));
  const settings = buttons.find((b) => (b.title || '').includes('设置'));
  if (!globals || !settings) return JSON.stringify({ missing: { globals: !!globals, settings: !!settings } });
  return JSON.stringify({
    adjacent: buttons.indexOf(settings) - buttons.indexOf(globals) === 1,
    svg: !!globals.querySelector('svg'),
    painted: globals.getBoundingClientRect().width > 8,
  });
})()""")
h.check("顶栏「设置」左边有全局变量按钮，且真的画得出来",
        bar.get("adjacent") and bar.get("svg") and bar.get("painted"), bar)

h.js("""(() => {
  [...document.querySelectorAll('.topbar > button, .topbar .btn')]
    .find((b) => (b.title || '').includes('全局变量')).click();
  return 1;
})()""")
time.sleep(0.6)
opened = h.eval_json("""(() => JSON.stringify({
  title: (document.querySelector('.modal h2') || {}).textContent,
  rows: document.querySelectorAll('.modal .kv input').length,
}))()""")
h.check("点它就打开全局变量编辑器", str(opened.get("title", "")).startswith("全局变量") and opened.get("rows", 0) >= 1, opened)

h.type_into(".modal .kv input", "gTop")
time.sleep(0.7)
live = h.eval_json("""(async () => {
  const s = await import('/js/state.js');
  return JSON.stringify({ first: (s.state.globals[0] || {}).key, emits: window.__envEmits || 0 });
})()""")
h.check("在编辑器里打字即刻生效，不用先按「完成」",
        live.get("first") == "gTop" and live.get("emits", 0) > 0, live)

h.js("""(() => {
  const ok = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '完成');
  if (ok) ok.click();
  return 1;
})()""")
time.sleep(0.5)
h.js("""(async () => {
  const s = await import('/js/state.js');
  s.state.globals = [];
  await s.flushDomain('settings');
  return 1;
})()""")
time.sleep(0.4)

# ---- 下载文件名：服务器说了就算 ----
h.js("""(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  const st = await import('/js/state.js');
  st.newTab('http'); await s(300);
  const u = document.querySelector('.url-input');
  u.value = '%s/file'; u.dispatchEvent(new Event('input', { bubbles: true })); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b => /发送/.test(b.textContent)).click();
  await s(1200);
  return 1;
})()""" % BASE)
cd = h.eval_json("""(() => {
  const card = document.querySelector('.binary-card');
  return JSON.stringify({ has: !!card, meta: card ? card.querySelector('.binary-meta').textContent : '' });
})()""")
h.check("带 Content-Disposition 的下载沿用服务器给的文件名",
        cd.get("has") and "quarterly-report.xlsx" in cd.get("meta", "") and "服务器给的文件名" in cd.get("meta", ""), cd)

names = h.eval_json("""(async () => {
  const { serverFileName } = await import('/js/response.js');
  const mk = (v) => ({ headers: [{ name: 'Content-Disposition', value: v }] });
  return JSON.stringify({
    spaced: serverFileName(mk('attachment; filename="a b.xlsx"')),
    star: serverFileName(mk("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.xlsx")),
    prefersStar: serverFileName(mk("attachment; filename=\\"fallback.txt\\"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt")),
    traversal: serverFileName(mk('attachment; filename="../../windows/system32.exe"')),
    none: serverFileName({ headers: [] }),
  });
})()""")
h.check("filename 带空格、filename* 的 UTF-8 形式、两种同时存在时取后者",
        names.get("spaced") == "a b.xlsx" and names.get("star") == "报告.xlsx"
        and names.get("prefersStar") == "报告.txt", names)
h.check("头里的路径不能带着另存为对话框跑出文件名本身",
        names.get("traversal") == "system32.exe" and names.get("none") == "", names)

# ---- 大响应：只画预算内的字符，并且明说 ----
h.js("""(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  const st = await import('/js/state.js');
  st.newTab('http'); await s(300);
  const u = document.querySelector('.url-input');
  u.value = '%s/huge'; u.dispatchEvent(new Event('input', { bubbles: true })); await s(150);
  [...document.querySelectorAll('.urlbar button')].find(b => /发送/.test(b.textContent)).click();
  await s(2500);
  return 1;
})()""" % BASE)
big = h.eval_json("""(async () => {
  const st = await import('/js/state.js');
  const tab = st.activeTab();
  const note = document.querySelector('.render-note');
  const pre = document.querySelector('#response-host pre.code');
  return JSON.stringify({
    bodyChars: (tab.response && tab.response.bodyText || '').length,
    note: note ? note.textContent : null,
    noteShown: note ? getComputedStyle(note).display !== 'none' : false,
    painted: pre ? pre.textContent.length : 0,
    head: pre ? pre.textContent.slice(0, 40) : '',
  });
})()""")
h.check("超过渲染预算时只画前 20 万字符并给出说明条",
        big.get("bodyChars", 0) > 200000 and big.get("noteShown") and "显示前" in (big.get("note") or "")
        and 0 < big.get("painted", 0) <= 210000, big)
# clipping must happen *after* formatting, or a big JSON quietly loses its
# indentation and Pretty becomes a second Raw view
h.check("被截断的大 JSON 仍然是缩进过的 Pretty 而不是挤成一行", "\n  " in big.get("head", ""), big)

# …and the other way round: Raw must stay the bytes that arrived, not Pretty's output
raw = h.eval_json("""(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  [...document.querySelectorAll('#response-host .seg button')].find((b) => b.textContent.trim() === 'Raw').click();
  await s(600);
  const pre = document.querySelector('#response-host pre.code');
  return JSON.stringify({ head: pre ? pre.textContent.slice(0, 24) : '', note: !!document.querySelector('.render-note') });
})()""")
h.check("Raw 视图仍然是原样字节，不被 Pretty 的格式化串台",
        raw.get("head", "").startswith('{"items"') and raw.get("note"), raw)

# ---- 标签条溢出：看得见、滚得动、当前标签不会被留在视野外 ----
strip = h.eval_json("""(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  const st = await import('/js/state.js');
  const app = await import('/js/app.js');
  for (let i = 0; i < 24; i++) st.newTab('http');
  app.renderTabs(); await s(250);
  const el = document.getElementById('tabstrip');
  const overflowing = el.classList.contains('overflowing');
  el.scrollLeft = el.scrollWidth;
  el.dispatchEvent(new Event('scroll')); await s(150);
  const faded = el.classList.contains('fade-left');
  // switch to the first tab: the strip has to bring it back into view by itself
  const first = el.querySelector('.tab');
  first.click(); await s(350);
  const active = el.querySelector('.tab.active').getBoundingClientRect();
  const box = el.getBoundingClientRect();
  return JSON.stringify({ overflowing, faded, inside: active.left >= box.left - 1 && active.right <= box.right + 1,
    width: Math.round(active.width) });
})()""")
h.check("标签溢出时出现出口，滚到最右端时左边缘给出淡出提示",
        strip.get("overflowing") and strip.get("faded"), strip)
h.check("切到看不见的标签会把它滚回视野，而不是留个半截",
        strip.get("inside"), strip)
h.js("""(async () => {
  const st = await import('/js/state.js');
  const app = await import('/js/app.js');
  const keep = st.state.tabs.slice(0, 1);
  st.state.tabs = keep;
  st.state.activeTabId = keep.length ? keep[0].id : null;
  app.renderTabs(); app.renderPanes();
  return 1;
})()""")
time.sleep(0.5)

# ---- 审计扫出来的六条：主链路按钮不能是死的 ----
h.js("window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message))); "
     "window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + String((e.reason && e.reason.message) || e.reason))); 1")

lit = h.eval_json("""(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
  const segs = [...document.querySelectorAll('.url-field .seg button')].map((b) => b.textContent.trim() + (b.classList.contains('on') ? '*' : ''));
  const http = [...document.querySelectorAll('.url-field .seg button')].find((b) => b.textContent.trim() === 'HTTP');
  http.click();
  return JSON.stringify({ segs, after: [...document.querySelectorAll('.url-field .seg button')].map((b) => b.textContent.trim() + (b.classList.contains('on') ? '*' : '')) });
})()""")
h.check("Ctrl+N 新建的请求，协议分段控件有点亮而且点得动",
        any(s.endswith("*") for s in lit.get("segs", [])) and any(s.endswith("*") for s in lit.get("after", [])), lit)

tmp = os.path.join(os.environ.get("TEMP", "/tmp"), "relay-e2e-export.json").replace("\\", "/")
if os.path.exists(tmp):
    os.remove(tmp)
h.js("(() => { const u = document.querySelector('.url-input'); u.value = '%s/list'; u.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()" % BASE)
h.js("[...document.querySelectorAll('.urlbar button')].find(b => /发送/.test(b.textContent)).click(); 1")
time.sleep(1.4)
h.js(stub_save(tmp))
h.js("(() => { const b = [...document.querySelectorAll('.response-head button')].find(x => x.textContent.includes('导出')); b.click(); return 1; })()")
time.sleep(0.4)
h.js("(() => { const item = [...document.querySelectorAll('.menu-item')].find(m => m.textContent.includes('.json')); if (item) item.click(); return 1; })()")
time.sleep(1.0)
h.js(end_stub_save())
exported = h.eval_json("JSON.stringify({ suggested: window.__relaySuggested || null, errs: window.__errs || [] })")
wrote = os.path.exists(tmp)
body = ""
if wrote:
    with open(tmp, encoding="utf-8") as fh:
        body = fh.read()
h.check("响应的「导出 .json」真的落盘（曾经 saveAs 未导入，点完只剩一个关闭的菜单）",
        wrote and '"data"' in body and bool(exported.get("suggested")) and not exported.get("errs"),
        {**exported, "wrote": wrote, "bytes": len(body)})

# 下载建议名要来自 Content-Disposition，走的是同一条落盘路径
tmp2 = os.path.join(os.environ.get("TEMP", "/tmp"), "relay-e2e-download.bin").replace("\\", "/")
if os.path.exists(tmp2):
    os.remove(tmp2)
h.js("(() => { const u = document.querySelector('.url-input'); return 1; })()")
h.js("""(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  const st = await import('/js/state.js');
  st.newTab('http'); await s(300);
  const u = document.querySelector('.url-input');
  u.value = '%s/file'; u.dispatchEvent(new Event('input', { bubbles: true })); await s(150);
  [...document.querySelectorAll('.urlbar button')].find((b) => /发送/.test(b.textContent)).click();
  await s(1200);
  return 1;
})()""" % BASE)
h.js(stub_save(tmp2))
h.js("(() => { const b = [...document.querySelectorAll('.binary-card button')].find(x => x.textContent.includes('下载文件')); if (b) b.click(); return 1; })()")
time.sleep(1.0)
h.js(end_stub_save())
dl = h.eval_json("JSON.stringify({ suggested: window.__relaySuggested || null, errs: window.__errs || [] })")
h.check("二进制下载把服务器给的文件名交给另存为对话框",
        dl.get("suggested") == "quarterly-report.xlsx" and not dl.get("errs"), dl)

ws_saved = h.eval_json("""(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  const st = await import('/js/state.js');
  st.newTab('ws'); await s(350);
  const u = document.querySelector('.url-input');
  u.value = 'ws://127.0.0.1:8900'; u.dispatchEvent(new Event('input', { bubbles: true })); await s(200);
  [...document.querySelectorAll('.urlbar button')].find((b) => b.textContent.trim() === '保存').click(); await s(600);
  const refId = st.activeTab().refId;
  u.value = 'ws://127.0.0.1:8900/v2'; u.dispatchEvent(new Event('input', { bubbles: true })); await s(200);
  [...document.querySelectorAll('.urlbar button')].find((b) => /保存|已保存/.test(b.textContent)).click(); await s(600);
  return JSON.stringify({ refId, nodeUrl: st.findNode(refId).node.request.url });
})()""")
h.check("改过的 WS 连接再保存，改动要写回集合里那个节点",
        ws_saved.get("nodeUrl") == "ws://127.0.0.1:8900/v2", ws_saved)

# 消息流必须自己滚、卡片不能被压扁、发送框要留在屏内
ws_layout = h.eval_json("""(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  const st = await import('/js/state.js');
  st.newTab('ws'); await s(350);
  const u = document.querySelector('.url-input');
  u.value = 'ws://127.0.0.1:8900'; u.dispatchEvent(new Event('input', { bubbles: true })); await s(200);
  [...document.querySelectorAll('.urlbar button')].find((b) => b.textContent.trim() === '连接').click();
  await s(1000);
  const area = document.querySelector('.ws-send textarea');
  for (let i = 0; i < 16; i++) {
    area.value = 'ping-' + i;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.ws-send-row button')].find((b) => b.textContent.includes('发送')).click();
    await s(70);
  }
  await s(700);
  const list = document.querySelector('.events');
  const card = list.querySelector('.event');
  const send = document.querySelector('.ws-send').getBoundingClientRect();
  return JSON.stringify({
    rows: list.querySelectorAll('.event').length,
    cardH: card ? Math.round(card.getBoundingClientRect().height) : 0,
    scrollable: list.scrollHeight - list.clientHeight,
    atBottom: list.scrollHeight - list.clientHeight - Math.round(list.scrollTop),
    sendVisible: send.bottom <= window.innerHeight + 1,
  });
})()""")
h.check("WS 消息流自己滚动、卡片不被压扁、发送框留在屏内",
        ws_layout.get("rows", 0) >= 20 and ws_layout.get("cardH", 0) >= 40
        and ws_layout.get("scrollable", 0) > 200 and abs(ws_layout.get("atBottom", 999)) <= 2
        and ws_layout.get("sendVisible"), ws_layout)

sse_dead = h.eval_json("""(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  const st = await import('/js/state.js');
  st.newTab('http'); await s(300);
  [...document.querySelectorAll('.url-field .seg button')].find((b) => b.textContent.trim() === 'SSE').click(); await s(400);
  const u = document.querySelector('.url-input');
  u.value = 'http://127.0.0.1:59999/nope'; u.dispatchEvent(new Event('input', { bubbles: true })); await s(150);
  [...document.querySelectorAll('.urlbar button')].find((b) => /连接/.test(b.textContent)).click();
  await s(2600);
  const head = document.querySelector('.response-head');
  return JSON.stringify({ text: head ? head.textContent.slice(0, 24) : '', live: !!(head && head.querySelector('.status-dot.live')), running: !!st.activeTab().running });
})()""")
h.check("SSE 连不上时不再谎称已连接、也不再累加时长",
        not sse_dead.get("live") and not sse_dead.get("running") and "连接失败" in sse_dead.get("text", ""), sse_dead)

nl = h.eval_json("""(() => {
  const u = document.querySelector('.url-input');
  u.value = 'http://127.0.0.1:8899/list\\r\\n';
  u.dispatchEvent(new Event('input', { bubbles: true }));
  return JSON.stringify({ value: u.value });
})()""")
h.check("粘进 URL 的换行被吃掉，不会拼出一条坏请求行", "\r" not in nl.get("value", "") and "\n" not in nl.get("value", ""), nl)

h.check("这一段的交互没有留下 JS 报错", not h.eval_json("JSON.stringify(window.__errs || [])"), h.eval_json("JSON.stringify((window.__errs || []).slice(0, 3))"))

h.finish()
