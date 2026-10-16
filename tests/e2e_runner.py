"""排序 → 跨集合串行 → 定时，三件事作为一条链来测。

之所以要串起来测：这一类产品的真实缺陷就是这个形状 —— 树里改了顺序，计划还按老
顺序跑；下拉换了口径，倒计时还显示旧锚点。分开测每一段都过得去，连起来才露馅。

约定：harness 的 js()/eval_json() 已经把 JSON 解析成 Python 对象，所以这里绝不再
套一层 json.loads。

    python tests/e2e_runner.py [cdp-port]

需要先起着 tests/local_server.py（HTTP 8899）。
"""

import json
import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import BASE, Harness  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("RELAY_DATA", os.path.join(ROOT, ".design-qa", "suite-data"))
DEAD = "http://127.0.0.1:59999/refused"

h = Harness(label="runner")
runner_id = None


def js(expression):
    return h.guard(h.eval_json(expression))


def sleep(ms):
    time.sleep(ms / 1000.0)


def runner_js(runner_id):
    """把当前那个测试计划取回来，并且等它跑完 —— 返回最新一条运行记录。"""
    return js("""(async () => {
      const s = await import('/js/state.js');
      return JSON.stringify(s.state.runners.find((x) => x.id === %s) ? s.state.runners.find((x) => x.id === %s) : null);
    })()""" % (json.dumps(runner_id), json.dumps(runner_id)))


def latest_run():
    return js("(async () => { const s = await import('/js/state.js'); return JSON.stringify(s.state.runs[0] || null); })()")


def wait_for_run(prev_id, timeout=60):
    """轮询到出现新的运行记录为止。串行跑本身就慢，用固定 sleep 会在慢机器上假失败。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        run = latest_run()
        if run and run.get("id") != prev_id and run.get("finishedAt"):
            return run
        sleep(0.4)
    return latest_run()


def must_click(selector, text, scope=None):
    """click_where 的返回值是证据不是装饰：ReferenceError、被挡住、找不到都会静悄悄地
    什么都不点。断言它，否则一个坏掉的辅助函数能把整条链"测成全绿"。"""
    out = h.click_where(selector, text, scope=scope)
    h.check("点击真的落在了「%s」上" % text,
            isinstance(out, dict) and not out.get("jsError") and not out.get("clickDidNotLand") and not out.get("missing"),
            out)
    return out


def reopen_runner():
    """在树里点一行会打开那个请求的标签页，工作区就不再是计划页了。要再点一次左侧
    那一行才回到计划 —— 这不是测试的怪癖，用户同样是这么回来的。"""
    h.js("document.querySelector('.rail-btn[data-rail=runner]').click(); 1")
    time.sleep(0.35)
    h.js("document.querySelector('.node[data-runner=%s]').click(); 1" % json.dumps(runner_id))
    time.sleep(0.45)


def fire_and_wait():
    prev = (latest_run() or {}).get("id")
    reopen_runner()
    must_click(".runner-head .btn.primary", "立即运行")
    return wait_for_run(prev)


# --------------------------------------------------------------------------
# fixtures：甲（A1、A2、一个 SSE、一个装着 A4 的文件夹）和乙（B1、一个 WS）
# --------------------------------------------------------------------------

js("""(async () => {
  const s = await import('/js/state.js');
  const { state } = s;
  const req = (id, name, url) => ({
    id, kind: 'request', name, protocol: 'http', auth: { kind: 'inherit' },
    request: { name, method: 'GET', url, params: [], headers: [], body: { mode: 'none' }, settings: {} },
  });
  state.collections = [
    { id: 'colA', kind: 'collection', name: '甲集合', expanded: true, variables: [], auth: { kind: 'inherit' }, children: [
      req('A1', 'A1', '%(base)s/hello?tag=a1'),
      req('A2', 'A2', '%(base)s/hello?tag=a2'),
      { id: 'sseA', kind: 'request', name: 'A3 流', protocol: 'sse', auth: { kind: 'inherit' },
        request: { name: 'A3 流', method: 'GET', url: '%(base)s/sse', params: [], headers: [], body: { mode: 'none' }, settings: {} } },
      { id: 'fldA', kind: 'folder', name: '文件夹甲', expanded: true, children: [req('A4', 'A4', '%(base)s/hello?tag=a4')] },
    ] },
    { id: 'colB', kind: 'collection', name: '乙集合', expanded: true, variables: [], auth: { kind: 'inherit' }, children: [
      req('B1', 'B1', '%(base)s/hello?tag=b1'),
      { id: 'wsB', kind: 'ws', name: 'B2 连接', protocol: 'ws', auth: { kind: 'inherit' },
        request: { name: 'B2 连接', method: 'GET', url: 'ws://127.0.0.1:8900/', params: [], headers: [], body: { mode: 'none' }, settings: {} } },
    ] },
  ];
  state.runners = [];
  state.runs = [];
  state.history = [];
  s.touch('collections');
  s.flushDomain('runners');
  s.flushDomain('runs');
  s.emit('tree');
  return JSON.stringify('ok');
})()""" % {"base": BASE})
sleep(0.7)

h.js("document.querySelector('.rail-btn[data-rail=collections]').click(); 1")
sleep(0.4)

# --------------------------------------------------------------------------
# 1) 集合内部排序
# --------------------------------------------------------------------------

rail = js("JSON.stringify([...document.querySelectorAll('.rail-btn')].map((b) => b.dataset.rail))")
h.check("导轨出现「运行」入口", isinstance(rail, list) and "runner" in rail, rail)

names = lambda: js("(async () => { const s = await import('/js/state.js'); return JSON.stringify(s.state.collections[0].children.map((c) => c.name)); })()")
base_order = names()
h.check("集合内顺序就是数组顺序", base_order == ["A1", "A2", "A3 流", "文件夹甲"], base_order)

dom = js("""(() => {
  const rows = [...document.querySelectorAll('.node[data-node]')];
  const kids = [];
  for (const row of rows) {
    const id = row.dataset.node;
    if (id === 'colA') continue;
    if (['colB'].includes(id)) break;
    if (['A1', 'A2', 'sseA', 'fldA', 'A4'].includes(id)) kids.push([row.querySelector('.name').textContent, id]);
  }
  return JSON.stringify(kids);
})()""")
h.check("画出来的行顺序与数组一致（改一处就刷全处）",
        [d[0] for d in dom] == ["A1", "A2", "A3 流", "文件夹甲", "A4"], dom)

h.js("document.querySelector('.node[data-node=A1]').click(); 1")
sleep(0.25)
h.key("ArrowDown", alt=True)
sleep(0.5)
moved = names()
h.check("Alt+↓ 把选中行下移一格", moved[:2] == ["A2", "A1"], moved)

h.key("ArrowUp", alt=True)
sleep(0.5)
h.check("Alt+↑ 原路退回", names() == base_order, names())
h.js("document.querySelector('.node[data-node=A1]').click(); 1")
h.key("ArrowUp", alt=True)
sleep(0.4)
h.check("第一行按 Alt+↑ 停在原地而不是绕到末尾", names() == base_order, names())

h.js("document.querySelector('.node[data-node=A1] [title=更多]').click(); 1")
sleep(0.35)
menu_state = js("""(() => {
  const up = [...document.querySelectorAll('.menu .menu-item')].find((i) => i.textContent.includes('上移'));
  return JSON.stringify({ found: !!up, disabled: up ? up.getAttribute('aria-disabled') : null });
})()""")
h.check("首行的「上移」是禁用态而不是点了没反应", menu_state.get("found") and menu_state.get("disabled") == "true", menu_state)
h.key("Escape")
sleep(0.3)


def drag(from_id, to_id, after):
    """用真实 DragEvent 驱动：处理函数读的是 currentTarget 矩形和 clientY，与真拖拽
    走的是同一条代码路径。CDP 的鼠标事件不会触发 HTML5 拖拽，这一段只能这样测。

    全部用 %(name)s 具名替换：这条模板里 from/to 各出现两次，位置参数一旦错位就会
    把 `after` 塞进别处，而一个非空字符串永远为真 —— 上半段那条分支就再也没被走过，
    测试却照样"通过"。
    """
    return js("""(() => {
      const a = document.querySelector('.node[data-node=%(from)s]');
      const b = document.querySelector('.node[data-node=%(to)s]');
      if (!a || !b) return JSON.stringify({ missing: true, from: %(from)s, to: %(to)s });
      const dt = new DataTransfer();
      a.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      const box = b.getBoundingClientRect();
      const y = %(after)s ? box.bottom - 2 : box.top + 2;
      b.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y }));
      const mark = [...b.classList].find((c) => c === 'drop-before' || c === 'drop-after');
      b.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y }));
      a.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
      return JSON.stringify({ mark: mark || null, box: [Math.round(box.top), Math.round(box.height)],
        y: Math.round(y), wantAfter: %(after)s });
    })()""" % {"from": json.dumps(from_id), "to": json.dumps(to_id), "after": "true" if after else "false"})


d1 = drag("A1", "A2", True)
sleep(0.5)
h.check("拖拽时目标行画出插入线", d1.get("mark") == "drop-after", d1)
h.check("拖拽把 A1 放到 A2 之后", names()[:2] == ["A2", "A1"], (d1, names()))

d2 = drag("A1", "A2", False)
sleep(0.5)
h.check("拖到上一行的上半段是插到它前面", names() == base_order, (d2, names()))

before_cross = names()
cross = js("""(() => {
  const a = document.querySelector('.node[data-node=A1]');
  const b = document.querySelector('.node[data-node=colB]');
  const dt = new DataTransfer();
  a.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  b.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: b.getBoundingClientRect().top + 2 }));
  const marked = [...b.classList].some((c) => c === 'drop-before' || c === 'drop-after');
  b.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: b.getBoundingClientRect().top + 2 }));
  a.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  return JSON.stringify({ marked, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' ') });
})()""")
sleep(0.4)
h.check("跨层拖拽不会偷偷重排结构", names() == before_cross, (before_cross, names()))
h.check("跨层拖拽不会画出落点线", not cross.get("marked"), cross)
h.check("跨层拖拽会说明为什么没动", "同一层" in cross.get("toast", ""), cross)

# ---- 行与行之外也要接得住 drop ----
# 真拖拽时指针有一半时间不在任何一行上：列表下方的空白、行间的缝。行上的 ondragover
# 接不到这些地方，松手就"没反应"——用户报的"拖不动"正是这个手感。宿主层兜底之后，
# 落在空白处等于落到最近一行的那一侧；这两条断言守的就是这条兜底路径。
h.js("document.querySelector('.node[data-node=fldA]').click(); 1")
sleep(0.4)
gap = js("""(() => {
  const a = document.querySelector('.node[data-node=A1]');
  const host = document.querySelector('.sidebar-body');
  const last = document.querySelector('.node[data-node=fldA]');
  if (!a || !host || !last) return JSON.stringify({ missing: true });
  const dt = new DataTransfer();
  a.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  const y = host.getBoundingClientRect().bottom - 8;
  host.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y }));
  const mark = [...document.querySelectorAll('.drop-after, .drop-before')].map((n) => n.dataset.node);
  host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y }));
  a.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  return JSON.stringify({ mark: mark });
})()""")
sleep(0.5)
h.check("落在列表下方的空白处 = 放到同层末尾（画出落点线并真的移动）",
        gap.get("mark") == ["fldA"] and names() == ["A2", "A3 流", "文件夹甲", "A1"], (gap, names()))

onto_container = js("""(() => {
  const a = document.querySelector('.node[data-node=A2]');
  const box = document.querySelector('.node[data-node=colA]');
  if (!a || !box) return JSON.stringify({ missing: true });
  const dt = new DataTransfer();
  a.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  const y = box.getBoundingClientRect().top + 2;
  const probe = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y });
  box.dispatchEvent(probe);
  const dead = probe.defaultPrevented;
  box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y }));
  a.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  return JSON.stringify({ dead: dead });
})()""")
sleep(0.5)
h.check("拖到自己的集合行上 = 移到该集合末尾，而不是报跨层错误",
        onto_container.get("dead") is True and names() == ["A3 流", "文件夹甲", "A1", "A2"], (onto_container, names()))

# 拖到列表上方（搜索框/头部那块）= 移到本组最前面。以前那里没有任何处理函数，
# 而"拖到最上面"恰好是排到第一位的手势
above = js("""(() => {
  const head = document.querySelector('.sidebar-head');
  const rows = [...document.querySelectorAll('#sidebar .node[data-node]')];
  const first = rows[1];                       // rows[0] is the collection itself
  const src = document.querySelector('.node[data-node=A2]');
  if (!head || !first || !src) return JSON.stringify({ missing: true });
  const firstId = first.dataset.node;
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  const y = head.getBoundingClientRect().top + 12;
  const probe = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y, clientX: 120 });
  head.dispatchEvent(probe);
  const mark = [...document.querySelectorAll('.drop-before, .drop-after')].map((n) => n.dataset.node);
  head.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientY: y, clientX: 120 }));
  src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  return JSON.stringify({ mark, firstId, prevented: probe.defaultPrevented });
})()""")
sleep(0.5)
h.check("拖到列表上方 = 移到本组最前面（头部区域接得住 drop）",
        above.get("prevented") and above.get("mark") == [above.get("firstId")] and names()[0] == "A2",
        (above, names()))

# 把顺序与展开状态还原，后面的段落仍从基线出发
js("""(async () => {
  const s = await import('/js/state.js');
  const kids = s.state.collections[0].children;
  const by = {};
  kids.forEach((c) => { by[c.name] = c; });
  s.state.collections[0].children = ['A1', 'A2', 'A3 流', '文件夹甲'].map((n) => by[n]);
  const fld = by['文件夹甲'];
  if (fld && fld.expanded === false) fld.expanded = true;
  s.touch('collections');
  s.emit('tree');
  return JSON.stringify('restored');
})()""")
sleep(0.4)
h.check("还原基线顺序供后续段落使用", names() == base_order, names())

js("""(async () => {
  const s = await import('/js/state.js');
  const kids = s.state.collections[0].children;
  kids.push({ id: 'req10', kind: 'request', name: 'req10', protocol: 'http', auth: { kind: 'inherit' },
    request: { name: 'req10', method: 'GET', url: '%s/hello', params: [], headers: [], body: { mode: 'none' }, settings: {} } });
  kids.push({ id: 'req2', kind: 'request', name: 'req2', protocol: 'http', auth: { kind: 'inherit' },
    request: { name: 'req2', method: 'GET', url: '%s/hello', params: [], headers: [], body: { mode: 'none' }, settings: {} } });
  s.touch('collections');
  s.emit('tree');
  return JSON.stringify('ok');
})()""" % (BASE, BASE))
sleep(0.5)


def open_node_menu(node_id):
    """用真实右键打开某个节点的菜单，并确认开的是它。

    不能用 `.node-actions [title=更多]` 的合成 .click()：那个按钮平时是
    `display:none`，锚点矩形全 0，菜单就被摆到屏幕左上角压在树上 —— 坐标看着"落在
    了文字完全一样的项上"，实际打的是别的东西。用户的手势本来就是右键。
    """
    for _ in range(3):
        if not js("JSON.stringify(document.querySelectorAll('.menu').length)"):
            break
        h.key("Escape")
        sleep(0.2)
    row = h.box(f".node[data-node={node_id}]")
    if not isinstance(row, dict) or row.get("missing"):
        return {"n": 0, "items": [], "missing": True}
    h.mouse_at(row["x"] - row["w"] / 2 + 20, row["y"], button="right")
    sleep(0.4)
    return js("""(() => {
      const menus = [...document.querySelectorAll('.menu')];
      const box = menus.length ? menus[menus.length - 1].getBoundingClientRect() : null;
      return JSON.stringify({
        n: menus.length,
        at: box ? [Math.round(box.left), Math.round(box.top)] : null,
        items: menus.length ? [...menus[menus.length - 1].querySelectorAll('.menu-item')].map((i) => i.textContent.trim()) : [],
      });
    })()""")


def menu_pick(label):
    """用键盘在当前菜单里选中某一项 —— 这也是产品支持的手势（↑↓ + Enter）。

    不用真实鼠标点：菜单项的 mouseenter 会走 paint() 里的 scrollIntoView，鼠标按下
    之后那一项可能已经挪走，click 就不成立了 —— 表现为同一句断言时好时坏。
    """
    plan = js("""(() => {
      const menus = [...document.querySelectorAll('.menu')];
      if (!menus.length) return JSON.stringify({ noMenu: true });
      const rows = [...menus[menus.length - 1].querySelectorAll('.menu-item')];
      const enabled = rows.filter((r) => !r.classList.contains('disabled'));
      const at = enabled.findIndex((r) => r.textContent.trim().startsWith(%s));
      return JSON.stringify({ at, labels: enabled.map((r) => r.textContent.trim()) });
    })()""" % json.dumps(label))
    if not isinstance(plan, dict) or plan.get("at", -1) < 0:
        h.check("菜单里找得到「%s」" % label, False, plan)
        return False
    for _ in range(plan["at"]):
        h.js("document.querySelector('.menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); 1")
    sleep(0.2)
    marked = js("""(() => {
      const row = [...document.querySelectorAll('.menu .menu-item.cursor')][0];
      return JSON.stringify(row ? row.textContent.trim() : null);
    })()""")
    h.js("document.querySelector('.menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); 1")
    sleep(0.5)
    h.check("键盘停在「%s」上" % label, str(marked).startswith(label), marked)
    return True


menu_of_colA = open_node_menu("colA")
h.check("打开的是集合自己的菜单（有「集合信息 / 变量」这一项）",
        menu_of_colA.get("n") == 1 and any("集合信息" in t for t in menu_of_colA.get("items", [])), menu_of_colA)
menu_pick("按名称排序子项")
sleep(0.6)
sorted_names = names()
h.check("「按名称排序子项」把文件夹留在最前", sorted_names[0] == "文件夹甲", sorted_names)
h.check("数字名按自然序：req2 排在 req10 前面", sorted_names.index("req2") < sorted_names.index("req10"), sorted_names)

# 必须 await：flushDomain 是异步的，不 await 就是"以为写完了"，读盘拿到的是上一版
js("(async () => { const s = await import('/js/state.js'); await s.flushDomain('collections'); return JSON.stringify('ok'); })()")
sleep(0.9)
disk = json.load(open(os.path.join(DATA, "collections.json"), encoding="utf-8"))
disk_names = [child["name"] for child in disk[0]["children"]]
h.check("排完序真的写进 collections.json", disk_names == sorted_names, (disk_names, sorted_names))

# ---- 真拖拽：让 Chromium 自己走一遍 draggable → dragstart → drop ----
# 上面那些都是合成 DragEvent，绕过了"浏览器肯不肯开始这次拖拽"。而恰恰是这一步有坑：
# dragstart 里不往 dataTransfer 写东西，Chromium 会直接放弃拖拽 —— 合成事件全绿、
# 真鼠标一动不动，用户报的就是这个。
# 放在排序段最后做：一次拦截式拖拽之后浏览器会吃掉下一发真实点击（这个 CDP 没有
# dragEnd 可发），那是工具的时序，不该污染后面的断言。
# ---- dragstart 必须往 dataTransfer 里写东西 ----
# 这是用户报的那个 bug 的真正契约：Chromium 在拖拽数据为空时会直接放弃这次拖拽
# （dragstart 触发了，但之后一个 dragover 都不会有）。所以只要 dragstart 不写
# dataTransfer，界面就"测试全绿、鼠标拖不动"。Chromium 会不会武装一次拖拽不是我们
# 的代码，h.html_drag() 试过真手势但在 CDP 下时灵时不灵，故这里断言的是自己的契约。
payload = js("""(() => {
  const a = document.querySelector('.node[data-node=A1]');
  const dt = new DataTransfer();
  a.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
  const types = [...dt.types];
  const id = dt.getData('text/relay-node');
  a.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
  return JSON.stringify({ types, id });
})()""")
h.check("dragstart 写入了非空拖拽数据（否则 Chromium 根本不开始拖）",
        "text/relay-node" in payload.get("types", []) and payload.get("id") == "A1", payload)
h.check("拖拽数据带上了可读的 text/plain，拖到别的窗口也有内容",
        "text/plain" in payload.get("types", []) and bool(payload.get("types")), payload)

h.js("document.querySelector('.node[data-node=A1]').click(); 1")
h.key("ArrowUp", alt=True)
sleep(0.4)
moved_up = names()
h.check("拖完之后键盘照样能改序（拖拽没有把输入卡住）",
        moved_up[0] == "A1" and moved_up != sorted_names, moved_up)
h.key("ArrowDown", alt=True)
sleep(0.4)
h.check("改回去也照样生效", names() == sorted_names, names())

# --------------------------------------------------------------------------
# 2) 跨集合串行
# --------------------------------------------------------------------------

pane = js("""(() => {
  document.querySelector('.rail-btn[data-rail=runner]').click();
  return JSON.stringify({ title: document.querySelector('.sidebar-title').textContent, native: document.querySelectorAll('#sidebar select').length });
})()""")
sleep(0.4)
h.check("侧栏切到运行计划页", pane.get("title") == "运行计划", pane)
h.check("运行计划列表里没有原生 select", pane.get("native") == 0, pane)

h.js("document.querySelector('.sidebar-head .btn.primary').click(); 1")
sleep(0.7)
runner_id = js("(async () => { const s = await import('/js/state.js'); return JSON.stringify(s.state.runners.length ? s.state.runners[0].id : 'none'); })()")
h.check("新建计划写进 state.runners", isinstance(runner_id, str) and runner_id.startswith("run"), runner_id)

tab_kind = js("(async () => { const s = await import('/js/state.js'); const t = s.state.tabs.find((x) => x.id === s.state.activeTabId); return JSON.stringify(t ? t.kind : 'none'); })()")
h.check("新建后打开的是 runner 类型标签页", tab_kind == "runner", tab_kind)

structure = js("""(() => {
  const groups = [...document.querySelectorAll('.runner-pane .group')];
  return JSON.stringify({
    groups: groups.length,
    headed: groups.filter((g) => g.querySelector('.group-head') && g.querySelector('.group-body')).length,
    hasRun: !!document.querySelector('.runner-head .btn.primary'),
    runLabel: document.querySelector('.runner-head .btn.primary') ? document.querySelector('.runner-head .btn.primary').textContent : null,
  });
})()""")
h.check("计划页每一块都装在统一的卡片框里", structure.get("groups", 0) >= 3 and structure["headed"] == structure["groups"], structure)
h.check("「立即运行」就在标题行上", structure.get("hasRun") and "立即运行" in structure.get("runLabel", ""), structure)

js("""(async () => {
  const s = await import('/js/state.js');
  const r = s.state.runners.find((x) => x.id === %s);
  r.sources = ['colA', 'colB'];
  s.touch('runners');
  s.emit('rerender');
  return JSON.stringify('ok');
})()""" % json.dumps(runner_id))
sleep(0.5)
plan = js("""(async () => {
  const m = await import('/js/runner.js');
  const s = await import('/js/state.js');
  const r = s.state.runners.find((x) => x.id === %s);
  const list = m.stepsOf(r);
  const rows = [...document.querySelectorAll('.plan-step')].map((x) => x.querySelector('.name').textContent);
  return JSON.stringify({
    total: list.length,
    runnable: list.filter((x) => !x.skip).length,
    skips: list.filter((x) => x.skip).map((x) => x.skip),
    names: list.map((x) => x.node.name),
    cols: list.map((x) => x.collectionName),
    rows,
    summary: m.planSummary(r),
  });
})()""" % json.dumps(runner_id))
h.check("步骤数 = 两个集合展开后的全部节点", plan["total"] == 8 and plan["runnable"] == 8, plan)
h.check("SSE 与 WS 也进串行队列而不是被跳过", plan["skips"] == [], plan["skips"])
h.check("没有步骤被默默丢掉（总数与队列一致）", plan["summary"]["runnable"] == plan["total"], plan["summary"])
h.check("文件夹里的请求也在队列里（深度优先）", "A4" in plan["names"], plan["names"])
h.check("集合顺序就是计划里点的顺序", plan["cols"][0] == "甲集合" and plan["cols"][-1] == "乙集合", plan["cols"])
h.check("执行顺序卡片按 sources 顺序列出两个集合", plan["rows"] == ["甲集合", "乙集合"], plan["rows"])

# 只跑一条请求，不该被迫把整个集合拖进来
SLEEP = "const nap=(ms)=>new Promise((r)=>setTimeout(r,ms));"

only = js("""(async () => {
  %s
  const s = await import('/js/state.js');
  const m = await import('/js/runner.js');
  const r = s.state.runners.find((x) => x.id === %s);
  r.sources = ['A1'];
  s.touch('runners');
  s.emit('rerender');
  await nap(250);
  return JSON.stringify({
    steps: m.stepsOf(r).map((x) => x.node.name),
    rows: [...document.querySelectorAll('.plan-step .name')].map((x) => x.textContent),
    methods: [...document.querySelectorAll('.plan-step > .badge')].map((x) => x.textContent),
    addresses: [...document.querySelectorAll('.plan-step .plan-path')].map((x) => x.textContent),
    addressTitles: [...document.querySelectorAll('.plan-step .plan-path')].map((x) => x.title),
    expectedMethod: s.findNode('A1').node.request.method,
    expectedUrl: s.findNode('A1').node.request.url,
    folder: m.stepsForSource('fldA').map((x) => x.node.name),
  });
})()""" % (SLEEP, json.dumps(runner_id)))
sleep(0.4)
h.check("一个步骤可以就是单条请求", only.get("steps") == ["A1"], only)
h.check("计划行标出实际请求方法与完整地址", only.get("methods") == [only.get("expectedMethod")]
        and only.get("addresses") == [only.get("expectedUrl")]
        and only.get("addressTitles") == [only.get("expectedUrl")], only)
h.check("文件夹能单独作为一步（只跑它里面的）", only.get("folder") == ["A4"], only)

# 添加选择器要看得见请求，而且永不禁用
picker = js("""(async () => {
  %s
  const s = await import('/js/state.js');
  const r = s.state.runners.find((x) => x.id === %s);
  r.sources = ['colA'];
  s.touch('runners');
  s.emit('rerender');
  await nap(300);
  const field = document.querySelector('.select.runner-add');
  if (!field) return JSON.stringify({ missing: true });
  field.click();
  await nap(300);
  const rows = [...document.querySelectorAll('.menu .menu-item')].map((i) => ({
    // Read the label separately from the path hint.
    label: (i.querySelector('.menu-label')?.textContent || '').trim(),
    hint: (i.querySelector('.menu-hint') || { textContent: '' }).textContent.trim(),
  }));
  const menuEl = document.querySelector('.menu');
  if (menuEl) menuEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return JSON.stringify({ disabled: field.hasAttribute('disabled'), rows });
})()""" % (SLEEP, json.dumps(runner_id)))
sleep(0.4)
h.check("添加选择器不会灰掉，灰了就等于「没法加」", not picker.get("disabled"), picker.get("disabled"))
labels = [row["label"] for row in picker.get("rows", [])]
hints = {row["label"]: row["hint"] for row in picker.get("rows", [])}
h.check("选择器列出集合、文件夹和单个请求", {"甲集合", "文件夹甲", "A1", "A3 流"} <= set(labels), labels)
h.check("每一项都带路径，同名请求不会挑错", "甲集合" in hints.get("A1", "") and "文件夹甲" in hints.get("A4", ""), hints)

# 从树里就地加入，而不是先建计划再去右边挑
js("""(async () => {
  const s = await import('/js/state.js');
  const r = s.state.runners.find((x) => x.id === %s);
  r.sources = [];
  s.touch('runners');
  document.querySelector('.rail-btn[data-rail=collections]').click();
  return JSON.stringify('ok');
})()""" % json.dumps(runner_id))
sleep(0.5)
h.js("document.querySelector('.node[data-node=A2]').click(); 1")
h.js("document.querySelector('.node[data-node=A2] [title=更多]').click(); 1")
sleep(0.35)
join = js("""(() => {
  const hit = [...document.querySelectorAll('.menu .menu-item')].find((i) => i.textContent.includes('加入运行计划'));
  if (!hit) return JSON.stringify({ missing: true, items: [...document.querySelectorAll('.menu .menu-item')].map((i) => i.textContent) });
  hit.click();
  return JSON.stringify({ missing: false });
})()""")
sleep(0.4)
h.check("集合 / 文件夹 / 请求的右键里都有「加入运行计划」", not join.get("missing"), join)
picked = js("""(() => {
  const rows = [...document.querySelectorAll('.menu .menu-item')];
  const hit = rows.find((i) => i.textContent.includes('新建运行计划'));
  if (!hit) return JSON.stringify({ missing: true, items: rows.map((i) => i.textContent) });
  hit.click();
  return JSON.stringify({ missing: false });
})()""")
sleep(0.7)
after_join = js("(async () => { const s = await import('/js/state.js'); return JSON.stringify(s.state.runners.map((r) => ({ name: r.name, sources: r.sources || [] }))); })()")
h.check("树里右键就能把这一项加进一个计划", any("A2" in (r.get("sources") or []) for r in after_join), (picked, after_join))
h.check("加完把你带到计划跟前而不是只弹一句 toast",
        js("(async () => { const s = await import('/js/state.js'); const t = s.state.tabs.find((x) => x.id === s.state.activeTabId); return JSON.stringify({ kind: t && t.kind, pane: s.state.pane }); })()"),
        after_join)

# 计划被清空后回到初始形状，后面的串行断言才成立
js("""(async () => {
  const s = await import('/js/state.js');
  const r = s.state.runners.find((x) => x.id === %s);
  r.sources = ['colA', 'colB'];
  s.touch('runners');
  s.emit('rerender');
  return JSON.stringify('ok');
})()""" % json.dumps(runner_id))
sleep(0.4)

run1 = fire_and_wait()
h.check("跑完留下一条运行记录", bool(run1.get("finishedAt")), run1.get("id"))
h.check("八个步骤（含 SSE/WS）全部通过", run1["totals"]["passed"] == 8 and run1["totals"]["failed"] == 0, run1["totals"])
h.check("长连接步骤也进了队列，没有任何跳过", run1["totals"]["skipped"] == 0 and run1["totals"]["ran"] == 8, run1["totals"])
h.check("运行顺序 = 当前步骤表顺序", [e["name"] for e in run1["entries"]] == plan["names"], [e["name"] for e in run1["entries"]])
h.check("每一步都真的上了线（HTTP 200 / WS 101）",
        all(e["status"] in (200, 101) for e in run1["entries"] if not e.get("skipped")),
        [(e["name"], e["status"], e.get("error")) for e in run1["entries"]][:4])
h.check("串行跑过的请求进历史并带上计划名",
        js("(async () => { const s = await import('/js/state.js'); return JSON.stringify(s.state.history.slice(0, 6).every((e) => e.name.includes('新建运行计划 · '))); })()"),
        js("(async () => { const s = await import('/js/state.js'); return JSON.stringify(s.state.history.slice(0, 2).map((e) => e.name)); })()"))

# 这条是整场检查的重点：改树 -> 下一次运行的顺序跟着改
h.js("document.querySelector('.rail-btn[data-rail=collections]').click(); 1")
sleep(0.35)
h.js("document.querySelector('.node[data-node=A1]').click(); 1")
h.key("ArrowDown", alt=True)
sleep(0.5)
h.js("document.querySelector('.rail-btn[data-rail=runner]').click(); 1")
sleep(0.45)
run2 = fire_and_wait()
seq = [e["name"] for e in run2["entries"]]
h.check("在树里改过顺序之后，下一次运行立刻按新顺序跑", seq.index("A2") < seq.index("A1") and run1 and plan["names"].index("A1") < plan["names"].index("A2"),
        (plan["names"], seq))

# 变量与继承鉴权：计划必须和手点走同一条渲染管线
js("""(async () => {
  const s = await import('/js/state.js');
  const col = s.state.collections.find((c) => c.id === 'colA');
  col.variables = [{ id: s.uid('kv'), key: 'smokeHost', value: '%s', enabled: true, description: '' }];
  col.auth = { kind: 'basic', username: '', password: '', basic: { username: 'relay', password: 'pw' }, bearer: { token: '' }, apikey: { key: '', value: '', addTo: 'header' } };
  col.children.find((c) => c.id === 'A1').request.url = '{{smokeHost}}/echo?tag=var';
  s.touch('collections');
  return JSON.stringify('ok');
})()""" % BASE)
sleep(0.5)
parity = js("""(async () => {
  const s = await import('/js/state.js');
  const node = s.findNode('A1').node;
  const built = s.buildSendDraft({ draft: JSON.parse(JSON.stringify(node.request)), refId: node.id, auth: JSON.parse(JSON.stringify(node.auth)) });
  return JSON.stringify({ url: built.draft.url, authed: (built.draft.headers || []).some((h) => h.key.toLowerCase() === 'authorization') });
})()""")
h.check("集合变量在计划里解析成真实主机名", str(parity.get("url", "")).startswith(BASE), parity)
h.check("集合级鉴权在计划里真的带上了", parity.get("authed"), parity)

run3 = fire_and_wait()
a1 = [e for e in run3["entries"] if e["nodeId"] == "A1"][0]
h.check("计划跑出去的那条 URL 与编辑器算出来的一致", a1["url"].startswith(BASE) and "echo" in a1["url"], a1)

# 失败与中断策略
js("""(async () => {
  const s = await import('/js/state.js');
  s.state.collections.find((c) => c.id === 'colB').children.unshift({
    id: 'badB', kind: 'request', name: '打不通的', protocol: 'http', auth: { kind: 'inherit' },
    request: { name: '打不通的', method: 'GET', url: '%s', params: [], headers: [], body: { mode: 'none' }, settings: {} } });
  s.touch('collections');
  s.emit('tree');
  return JSON.stringify('ok');
})()""" % DEAD)
sleep(0.5)
js("""(async () => {
  const s = await import('/js/state.js');
  const r = s.state.runners.find((x) => x.id === %s);
  r.stopOnError = true;
  s.touch('runners');
  s.emit('rerender');
  return JSON.stringify('ok');
})()""" % json.dumps(runner_id))
sleep(0.5)
sw = js("""(() => {
  const hit = [...document.querySelectorAll('.row')].find((x) => x.textContent.includes('遇到失败就停下'));
  return JSON.stringify({ found: !!hit, on: hit ? hit.querySelector('.switch').classList.contains('on') : null });
})()""")
h.check("「遇到失败就停下」开关与 stopOnError 一致", sw.get("found") and sw.get("on") is True, sw)

run4 = fire_and_wait()
names4 = [e["name"] for e in run4["entries"]]
h.check("开了 stopOnError 就在失败处停下", bool(run4.get("stoppedAfter")) and run4["totals"]["failed"] == 1, run4["totals"])
h.check("停下之后后面的请求确实没跑", "B1" not in names4 and len(run4["entries"]) < 10, (names4, len(run4["entries"])))
h.check("失败那行留下原因", any((not e.get("skipped")) and e.get("error") for e in run4["entries"]),
        [e.get("error") for e in run4["entries"] if not e.get("skipped")])

js("""(async () => {
  const s = await import('/js/state.js');
  const r = s.state.runners.find((x) => x.id === %s);
  r.stopOnError = false;
  r.delayMs = 500;
  s.touch('runners');
  s.emit('rerender');
  return JSON.stringify('ok');
})()""" % json.dumps(runner_id))
sleep(0.4)
run5 = fire_and_wait()
h.check("没开 stopOnError 就一路跑完", run5["totals"]["ran"] == 9 and run5["totals"]["failed"] == 1, run5["totals"])
h.check("设了请求间隔就真的等过", run5["finishedAt"] - run5["startedAt"] >= 2500,
        run5["finishedAt"] - run5["startedAt"])

js("""(async () => {
  const s = await import('/js/state.js');
  const r = s.state.runners.find((x) => x.id === %s);
  r.delayMs = 0;
  s.touch('runners');
  return JSON.stringify('ok');
})()""" % json.dumps(runner_id))
sleep(0.3)

# 展开一次运行记录，点其中一行查看执行详情
missing_head = js("""(() => {
  const head = document.querySelector('.run-block .run-head');
  if (!head) return JSON.stringify({ missing: true });
  if (head.getAttribute('aria-expanded') !== 'true') head.click();
  return JSON.stringify({ missing: false });
})()""")
sleep(0.5)
h.check("运行记录逐步列出每个请求", not missing_head.get("missing") and js("JSON.stringify(document.querySelectorAll('.run-entry').length)") > 0, missing_head)
rows = js("""(() => {
  const list = [...document.querySelectorAll('.run-entry')];
  return JSON.stringify({
    tones: [...new Set(list.map((r) => r.className.replace('run-entry', '').trim()))],
    dots: list.slice(0, 3).map((r) => getComputedStyle(r.querySelector('.run-dot')).backgroundColor),
    hasTime: list.some((r) => /\\d+\\s*(ms|s|秒)/.test(r.textContent)),
  });
})()""")
h.check("过/败/跳用三种不同的行色", len(rows.get("tones", [])) >= 2, rows)
h.check("每行前面有个真画出来的状态点", len(set(rows.get("dots", []))) >= 1 and rows["dots"][0] != "rgba(0, 0, 0, 0)", rows)

h.js("""(() => {
  const row = [...document.querySelectorAll('.run-entry')].find((r) => r.textContent.includes('A1'));
  if (row) row.click();
  return 1;
})()""")
sleep(0.6)
opened = js("(async () => { const s = await import('/js/state.js'); const t = s.state.tabs.find((x) => x.id === s.state.activeTabId); return JSON.stringify({ refId: t && t.refId, kind: t && t.kind }); })()")
h.check("点结果行打开当次执行详情且留在计划", opened.get("kind") == "runner" and js("JSON.stringify(!!document.querySelector('.run-detail-dialog'))"), opened)
h.js("document.querySelector('.run-detail-dialog .modal-head button').click(); 1")
sleep(0.25)

# 计划里引用的集合被删掉
reopen_runner()
h.js("""(async () => {
  const s = await import('/js/state.js');
  s.state.collections = s.state.collections.filter((c) => c.id !== 'colB');
  s.flushDomain('collections');
  s.touch('collections');
  s.emit('tree');
  s.emit('rerender');
  return JSON.stringify('ok');
})()""")
sleep(0.6)
dangling = js("""(() => JSON.stringify({
  inPlan: [...document.querySelectorAll('.plan-step')].map((r) => r.querySelector('.name').textContent),
  inSidebar: document.querySelectorAll('.sidebar-body .warn-text').length,
  counts: (document.querySelector('.runner-title .hint') || {}).textContent,
}))()""")
h.check("被删除的集合在计划里明说而不是静默少跑", any("删除" in t for t in dangling.get("inPlan", [])), dangling)
h.check("侧栏那一行也标出计划已经指空了", dangling.get("inSidebar", 0) >= 1, dangling)

capped = js("""(async () => {
  const s = await import('/js/state.js');
  const m = await import('/js/runner.js');
  for (let i = 0; i < 45; i += 1) s.state.runs.unshift({ id: 'pad' + i, runnerId: s.state.runners[0].id, runnerName: '垫',
    startedAt: Date.now(), finishedAt: Date.now(), entries: [], totals: { ran: 0, passed: 0, failed: 0, skipped: 0 } });
  const r = s.state.runners[0];
  r.sources = ['colA'];
  r.stopOnError = false;
  s.touch('runners');
  await m.runRunner(r);
  return JSON.stringify({ n: s.state.runs.length });
})()""")
sleep(0.6)
h.check("运行记录封顶在几十条而不是无限增长", capped.get("n", 999) <= 30, capped)

# --------------------------------------------------------------------------
# 3) 定时
# --------------------------------------------------------------------------

# 界面和测试跑在同一个本地时区，所以可以直接用 Python 的时间戳当期望值。
def ms(hour, minute, second=0, day=29):
    return int(datetime(2026, 9, day, hour, minute, second).timestamp() * 1000)


NOW = ms(14, 37, 12)
math = js("""(async () => {
  const m = await import('/js/runner.js');
  const now = %d;
  return JSON.stringify({
    aligned: m.nextFire({ kind: 'interval', everyMinutes: 30, anchorAt: now - 45 * 60000 }, now),
    naive: now + 30 * 60000,
    first: m.nextFire({ kind: 'interval', everyMinutes: 5, anchorAt: now }, now),
    ahead: m.nextFire({ kind: 'daily', at: '23:50' }, now),
    past: m.nextFire({ kind: 'daily', at: '09:00' }, now),
    junk: m.nextFire({ kind: 'daily', at: '不是时间' }, now),
    label: m.nextLabel({ enabled: true, kind: 'daily', at: '23:50', anchorAt: now }, now),
  });
})()""" % NOW)
# 锚点 13:52:12、间隔 30 分钟 => 下一个时点是 14:52:12。要是代码偷懒地"从现在再加
# 30 分钟"，答案会是 15:07:12。这两个值必须不同才能证明真的按锚点对齐了。
h.check("固定间隔按锚点对齐而不是从「现在」起算", math["aligned"] == ms(14, 52, 12) and math["aligned"] != math["naive"], math["aligned"])
h.check("刚设好定时时不会立刻触发一次", math["first"] == ms(14, 42, 12), math["first"])
h.check("每天定点：还没到就排今天", math["ahead"] == ms(23, 50), math["ahead"])
h.check("每天定点：过了就排明天", math["past"] == ms(9, 0, day=30), math["past"])
h.check("时间写坏了退回 09:00 而不是崩掉", math["junk"] == ms(9, 0, day=30), math["junk"])
h.check("下次时间写成「今天 23:50 · 9 小时后」这种可判断的话",
        "23:50" in math["label"] and "小时后" in math["label"], math["label"])

fired = js("""(async () => {
  const s = await import('/js/state.js');
  const m = await import('/js/runner.js');
  const r = s.state.runners[0];
  r.sources = ['colA'];
  r.schedule = { enabled: true, kind: 'interval', everyMinutes: 5, at: '09:00', anchorAt: Date.now() - 6 * 60000, lastFiredAt: Date.now() - 6 * 60000 };
  const before = s.state.runs[0] ? s.state.runs[0].id : null;
  await m.catchUp();
  // SSE 步骤要驻留 3 秒才落记录，轮询而不是赌固定延时
  for (let i = 0; i < 20; i += 1) {
    const now = s.state.runs[0];
    if (now && now.id !== before && now.finishedAt) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  const now = s.state.runs[0];
  return JSON.stringify({ fresh: (now && now.id) !== before, trigger: now && now.trigger });
})()""")
sleep(1.2)
h.check("到点时心跳真的跑了一轮", fired.get("fresh"), fired)
h.check("定时跑出来的记录标成 timer 而不是 manual", fired.get("trigger") == "timer", fired)

missed = js("""(async () => {
  const s = await import('/js/state.js');
  const m = await import('/js/runner.js');
  const r = s.state.runners[0];
  // 上一轮定时跑带着 SSE 驻留要 3 秒多；等它退场，否则 catchUp 会因"正在运行"跳过
  for (let i = 0; i < 20 && m.sessionOf(r.id); i += 1) await new Promise((res) => setTimeout(res, 500));
  r.schedule = { enabled: true, kind: 'interval', everyMinutes: 5, anchorAt: Date.now() - 4 * 3600000, lastFiredAt: Date.now() - 4 * 3600000 };
  const before = s.state.runs.length;
  await m.catchUp();
  await m.catchUp();
  await new Promise((res) => setTimeout(res, 300));
  return JSON.stringify({ same: s.state.runs.length === before, moved: r.schedule.lastFiredAt > Date.now() - 4 * 3600000 });
})()""")
h.check("错过太久不补跑，不会一睁眼灌几十次", missed.get("same"), missed)
h.check("错过太久会把时间轴推到下一个时点", missed.get("moved"), missed)

quiet = js("""(async () => {
  const s = await import('/js/state.js');
  const m = await import('/js/runner.js');
  const r = s.state.runners[0];
  r.schedule = { enabled: false, kind: 'interval', everyMinutes: 5, anchorAt: Date.now() - 3600000, lastFiredAt: Date.now() - 3600000 };
  const before = s.state.runs.length;
  await m.catchUp();
  return JSON.stringify({ same: s.state.runs.length === before });
})()""")
h.check("关掉定时就一次都不跑", quiet.get("same"), quiet)

js("""(async () => {
  const s = await import('/js/state.js');
  const r = s.state.runners[0];
  r.schedule = { enabled: true, kind: 'interval', everyMinutes: 30, at: '09:00', anchorAt: Date.now() };
  s.touch('runners');
  s.emit('rerender');
  return JSON.stringify('ok');
})()""")
sleep(0.6)
copy = js("""(() => {
  const next = document.querySelector('.runner-next');
  const sw = [...document.querySelectorAll('.row')].find((x) => x.textContent.includes('按计划自动运行'));
  return JSON.stringify({
    copy: next ? next.textContent : null,
    switchOn: sw ? sw.querySelector('.switch').classList.contains('on') : null,
    clock: document.querySelectorAll('.select.runner-clock').length,
    every: document.querySelectorAll('.select.runner-every').length,
    native: document.querySelectorAll('.runner-pane select, .runner-pane input[type=time]').length,
  });
})()""")
h.check("定时开着时界面写出下次时间", copy.get("copy") and "下次" in copy["copy"], copy)
h.check("界面如实写明 Relay 没开着不会跑也不补跑", copy.get("copy") and ("没开着" in copy["copy"] or "补跑" in copy["copy"]), copy)
h.check("固定间隔时露出的是间隔选择器", copy.get("every") == 1 and copy.get("clock") == 0, copy)
h.check("定点时间用自绘列表框而不是原生 time 控件", copy.get("native") == 0, copy)

js("""(() => {
  const seg = [...document.querySelectorAll('.runner-pane .seg')].find((x) => x.textContent.includes('每天定点'));
  if (seg) seg.querySelectorAll('button')[1].click();
  return 1;
})()""")
sleep(0.6)
daily_ui = js("""(() => JSON.stringify({
  clock: document.querySelectorAll('.select.runner-clock').length,
  every: document.querySelectorAll('.select.runner-every').length,
  on: [...document.querySelectorAll('.runner-pane .seg button')].filter((b) => b.classList.contains('on')).map((b) => b.textContent),
}))()""")
h.check("切到「每天定点」露出时和分两个自绘选择器", daily_ui["clock"] == 2 and daily_ui["every"] == 0, daily_ui)
h.check("分段控件的选中态跟着切过去", "每天定点" in daily_ui.get("on", []), daily_ui)

# 计划不该只有靠侧栏才能找到
h.key("k", ctrl=True)
sleep(0.5)
palette = js("""(() => {
  const input = document.querySelector('.palette input');
  if (!input) return JSON.stringify({ missing: true });
  input.value = '新建运行';
  input.dispatchEvent(new Event('input'));
  return JSON.stringify({ items: [...document.querySelectorAll('.palette-item')].map((i) => i.textContent).slice(0, 3) });
})()""")
h.check("命令面板里能找到新建运行计划", any("新建运行计划" in t for t in palette.get("items", [])), palette)
h.key("Escape")
sleep(0.3)

native = h.sweep_controls()
h.check("运行页所有控件都在设计系统里", not native, native)
errs = h.console_errors()
h.check("整条链跑下来没有页面异常", not errs, errs[:3])

js("""(async () => {
  const s = await import('/js/state.js');
  s.state.runners = [];
  s.state.runs = [];
  s.flushDomain('runners');
  s.flushDomain('runs');
  return JSON.stringify('ok');
})()""")
sleep(0.8)

h.finish()
