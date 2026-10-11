"""Sweep every surface for form controls that no stylesheet rule touches.

A control matched by zero CSS rules renders with the user-agent default, which is
what reads as "cheap" at the edges of the UI. The check is objective: walk the
live stylesheets and ask each rule whether it matches the element.

Also lints app.css for the two ways a hairline ends up "sometimes there": a
pseudo-element selector declared twice (the earlier block is silently dead) and a
separator hidden by a state selector.

    python tests/style_audit.py [cdp-port]
"""

import collections
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import BASE, Harness  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def css_lint():
    """Return (duplicate_pseudo_selectors, conditionally_hidden_separators)."""
    src = io.open(os.path.join(ROOT, "web", "css", "app.css"), encoding="utf-8").read()
    body = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    counts = collections.Counter()
    hidden = []
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", body):
        head = " ".join(match.group(1).split())
        inner = " ".join(match.group(2).split())
        if head.startswith("@") or not head:
            continue
        for part in [p.strip() for p in head.split(",")]:
            if "::before" in part or "::after" in part:
                counts[part] += 1
            if ("::before" in part or "::after" in part) and re.search(r"\bopacity:\s*0(?:\s|;|$)", inner):
                if any(k in part for k in (":hover", ".on", ".active", ":has", ":checked")):
                    hidden.append(part)
    dupes = [sel for sel, n in counts.items() if n > 1]
    return dupes, sorted(set(hidden))


DUPES, HIDDEN = css_lint()
print(f"css lint: {len(DUPES)} 个重复的伪元素选择器, {len(HIDDEN)} 条按状态隐藏分隔线")
for d in DUPES:
    print("   重复:", d)
for hrule in HIDDEN:
    print("   条件隐藏:", hrule)

h = Harness(label="style")
OFFENDERS = {}
h.check("app.css 里没有重复声明的伪元素选择器（后者会静默让前者变成死代码）", not DUPES, DUPES)
h.check("没有按 hover/选中状态隐藏的分隔线（会让间隔看起来随机）", not HIDDEN, HIDDEN)

h = Harness(label="style")
OFFENDERS = {}


def sweep(where, js_open=None, collect=True):
    if js_open:
        h.js(js_open)
    rows = h.sweep_controls()
    if not isinstance(rows, list):
        print("  sweep failed at", where, rows)
        return None
    if collect:
        for row in rows:
            OFFENDERS.setdefault(f"{where} :: {row['kind']} {row['cls']}", (where, row))
    print(f"{where:26s} {len(rows)}")
    return rows


# The sweep has to prove it can see the things it claims to catch: an earlier
# version reported a clean bill because CSS nesting gave every style rule an empty
# `cssRules`, so no selector was ever collected.
probe = sweep("自检：故意放三个原生控件", """(() => {
  const host = document.createElement('div');
  host.id = 'style-probe';
  host.innerHTML = '<input type="file"><select><option>a</option></select><button class="zzz-none">x</button>';
  document.body.appendChild(host);
  return 1;
})()""", collect=False)
caught = [p["kind"] for p in probe] if isinstance(probe, list) else []
h.check("样式扫描器自己能看见原生 file 框 / 裸 select / 无样式按钮",
        all(k in caught for k in ("input[file]", "select[select-one]", "button[submit]")), caught)
h.js("document.getElementById('style-probe') && document.getElementById('style-probe').remove()")


fresh = """(() => {
  document.querySelectorAll('.overlay').forEach((o) => o.remove());
  document.body.classList.remove('has-sheet'); delete document.body.dataset.sheets;
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  return 1;
})()"""

sweep("初始界面")
sweep("Params 子标签", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(300);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('HTTP')).click(); await s(400);
  [...document.querySelectorAll('#request-host .subtab')].find(b=>b.textContent.trim().startsWith('Params')).click(); await s(400);
})()""" % fresh)
for mode in ["JSON", "URL 编码", "表单", "二进制"]:
    sweep(f"Body/{mode}", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms));
      [...document.querySelectorAll('#request-host .subtab')].find(b=>b.textContent.trim().startsWith('Body')).click();await s(250);
      const row=[...document.querySelectorAll('#request-host .body-formats button')].find(r=>r.textContent.trim()==='%s');
      if (!row) throw new Error('Missing body format: %s');
      row.click(); await s(500);
    })()""" % (mode,mode))
sweep("Headers/Auth/Settings", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  for (const name of ['Headers','Auth','Settings']) {
    [...document.querySelectorAll('#request-host .subtab')].find(b=>b.textContent.trim().startsWith(name)).click(); await s(420);
  }
})()""")
sweep("cURL 导入弹窗", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const t=await import('/js/tools.js');
  t.importCurlDialog(null, "curl -X POST 'https://api.demo.com/v1/orders?tab=paid' -H 'A: 1' -d 'x=1'");
  await s(1200);
})()""" % fresh)
sweep("集合导出弹窗", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const st=await import('/js/state.js'); st.state.pane='collections'; st.emit('pane'); await s(400);
  const row=document.querySelector('#sidebar .node');
  row.querySelector('.node-actions button').click(); await s(500);
  const item=[...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('导出集合'));
  if (item) { item.click(); await s(900); }
})()""" % fresh)
sweep("设置窗", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const t=await import('/js/tools.js'); t.openSettingsDialog(); await s(800);
})()""" % fresh)
sweep("快捷键抽屉", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const t=await import('/js/tools.js'); t.openShortcuts(); await s(700);
})()""" % fresh)
sweep("命令面板", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await s(700);
})()""" % fresh)
sweep("环境面板+环境页", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const st=await import('/js/state.js'); st.state.pane='environments'; st.emit('pane'); await s(400);
  document.querySelector('#sidebar .node').click(); await s(800);
})()""" % fresh)
sweep("文档面板+文档页", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const st=await import('/js/state.js'); st.state.pane='docs'; st.emit('pane'); await s(400);
  const d=await import('/js/doc.js'); d.createDoc('样式扫描文档'); await s(900);
})()""" % fresh)
sweep("历史记录", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const st=await import('/js/state.js'); st.state.pane='history'; st.emit('pane'); await s(600);
})()""" % fresh)
sweep("SSE 页+原始流", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  st=await import('/js/state.js'); st.state.pane='collections'; st.emit('pane');
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(300);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('SSE')).click(); await s(400);
  const u=document.querySelector('.url-input'); u.value='%s/sse'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(200);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('连接')).click(); await s(2200);
  [...document.querySelectorAll('#response-host .subtab')].find(b=>b.textContent.trim().startsWith('原始流')).click(); await s(500);
})()""" % (fresh, BASE))
sweep("WS 页", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  document.querySelectorAll('.tabstrip .tab-new')[0].click(); await s(300);
  [...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('WebSocket')).click(); await s(500);
  const u=document.querySelector('.url-input'); u.value='ws://127.0.0.1:8900'; u.dispatchEvent(new Event('input',{bubbles:true})); await s(300);
  [...document.querySelectorAll('.urlbar button')].find(b=>b.textContent.includes('连接')).click(); await s(1500);
})()""" % fresh)
sweep("树右键菜单", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const st=await import('/js/state.js'); st.state.pane='collections'; st.emit('pane'); await s(400);
  const row=document.querySelector('#sidebar .node');
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); await s(600);
})()""" % fresh)
sweep("集合信息弹窗", """(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms)); %s
  const st=await import('/js/state.js');
  const t=await import('/js/tree.js');
  const row=document.querySelector('#sidebar .node');
  row.querySelector('.node-actions button').click(); await s(500);
  const item=[...document.querySelectorAll('.menu-item')].find(m=>m.textContent.includes('集合信息'));
  if (item) { item.click(); await s(900); }
})()""" % fresh)

print("\n=== 汇总 ===")
for key, (where, row) in OFFENDERS.items():
    print(f"{row['kind']:18s} {row['cls'][:34]:34s} 规则数={row['rules']}  {row['appearance']:12s} "
          f"{row['h']}x{row['w']}  {row['label']!r}   @ {where}")
print(f"\n{len(OFFENDERS)} 个未被样式覆盖或仍是原生控件的元素")
rc = h.report()
h.finish(keep=True)
sys.exit(1 if OFFENDERS or rc else 0)
