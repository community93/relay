"""One-shot memory probe: what inside the webview is actually heavy?"""
import sys

sys.path.insert(0, "tests")
sys.stdout.reconfigure(encoding="utf-8")

from harness import Harness  # noqa: E402

h = Harness(label="mem")

# CDP Performance domain via the harness raw sender
h._send("Performance.enable")
raw = h._call("Performance.getMetrics")
m = {d["name"]: d["value"] for d in raw["metrics"]}

page = h.eval_json("""(() => {
  const all = document.getElementsByTagName('*').length;
  const layers = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const why = [];
    if (cs.backdropFilter && cs.backdropFilter !== 'none') why.push('backdrop-filter');
    if (cs.willChange && cs.willChange !== 'auto') why.push('will-change');
    if (cs.transform && cs.transform !== 'none' && el.offsetWidth * el.offsetHeight > 40000) why.push('transform-big');
    if (cs.animationName && cs.animationName !== 'none') why.push('animation');
    if (cs.filter && cs.filter !== 'none') why.push('filter');
    if (why.length) layers.push({ tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().split(/\\s+/).slice(0,2).join('.'),
      w: el.offsetWidth, h: el.offsetHeight, area: el.offsetWidth * el.offsetHeight, why });
  }
  layers.sort((a, b) => b.area - a.area);
  const perf = performance.memory || {};
  return {
    domNodes: all,
    jsHeapMB: +(perf.usedJSHeapSize / 1048576).toFixed(1),
    jsHeapTotalMB: +(perf.totalJSHeapSize / 1048576).toFixed(1),
    jsHeapLimitMB: +(perf.jsHeapSizeLimit / 1048576).toFixed(1),
    listeners: (window.getEventListeners ? Object.keys(window.getEventListeners(window)).length : -1),
    bigLayers: layers.slice(0, 12),
    layerCount: layers.length,
    stylesheets: document.styleSheets.length,
    cssRules: (() => { let n = 0; for (const s of document.styleSheets) { try { n += s.cssRules.length } catch (e) {} } return n })(),
    modules: performance.getEntriesByType('resource').filter(r => r.initiatorType === 'script' || r.name.endsWith('.js')).length,
  };
})()""")

print("=== CDP Performance.getMetrics ===")
for k in ("JSHeapAllocatedSize", "JSHeapUsedSize", "Nodes", "DocumentCount", "JSEventListeners",
          "LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration",
          "TaskDuration", "ScriptDuration", "ResourceCount"):
    if k in m:
        v = m[k]
        if "Heap" in k or "Duration" in k:
            print(f"  {k:22} {v/1048576:>9.1f} MB" if "Heap" in k else f"  {k:22} {v*1000:>9.1f} ms")
        else:
            print(f"  {k:22} {v:>9.0f}")

print("\n=== page self-report ===")
for k, v in page.items():
    if k != "bigLayers":
        print(f"  {k:16} {v}")

print("\n=== biggest paint-composited surfaces (area px^2) ===")
for g in page["bigLayers"]:
    print(f"  {g['why']} {g['tag']}.{g['cls']} {g['w']}x{g['h']} area={g['area']:,}")

h.finish(keep=True)
