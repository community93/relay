"""JS snippets for driving Relay's own widgets from a test.

They live in one file because the widgets are app-drawn, not native: a selectField
takes two clicks and its rows are matched by data-value rather than by wording,
and an export opens a real OS dialog that would hang a suite until it timed out.
Pasting that into eleven suites is how the suites drift apart from the app.
"""
import json

# Self-contained on purpose: suites define `sleep` differently, so this never
# assumes one exists.
PICK = """
  const pick = async (sel, val, root) => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const field = (root || document).querySelector(sel);
    if (!field) return { missing: sel };
    field.click();
    await nap(240);
    const rows = [...document.querySelectorAll('.menu .menu-item')];
    const row = rows.find((r) => r.getAttribute('data-value') === String(val));
    if (!row) return { noOption: String(val), options: rows.map((r) => r.getAttribute('data-value')) };
    row.click();
    await nap(360);
    return { value: field.dataset.value, options: rows.length };
  };
"""


def pick(selector, value, expect=None):
    """JS that chooses `value` in the listbox at `selector` and reports the result.

    Returns a self-contained async IIFE, so it can go straight into
    `eval_json()`; `PICK` on its own is a statement sequence and only works when
    pasted into a script that is already inside one.
    """
    guard = (
        "  if (!__pick || __pick.value !== %s) return JSON.stringify({ pickFailed: __pick });\n"
        % json.dumps(str(value))
        if expect is not False
        else "  return JSON.stringify(__pick);\n"
    )
    return "(async () => {\n%s  const __pick = await pick(%s, %s);\n%s})()" % (
        PICK,
        json.dumps(selector),
        json.dumps(str(value)),
        guard,
    )


# Suites that do not build on harness.py need the same protection: a real OS
# Save-As or file sheet blocks the webview, and the symptom is a CDP timeout that
# looks like the product hung. Idempotent, so it is safe to install more than once.
NEUTRALISE = """
  {
    if (!window.__fileClickGuarded) {
      const realClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') return undefined;
        return realClick.apply(this, arguments);
      };
      window.__fileClickGuarded = true;
    }
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (core && !core.__dialogStubbed) {
      const realInvoke = core.invoke.bind(core);
      core.invoke = async (cmd, args) => {
        if (String(cmd).indexOf('plugin:dialog|') === 0) return null;
        return realInvoke(cmd, args);
      };
      core.__dialogStubbed = true;
    }
  }
"""


def stub_save(path):
    """Answer Save-As with `path` without opening the native sheet.

    The sheet blocks the webview, so an automated run cannot answer it. The first
    version of this helper overwrote `window.__TAURI__.core.invoke` — but that
    object is frozen, the assignment did nothing, and every "the export really
    wrote a file" assertion built on it proved nothing at all. It now uses the
    documented seam in `ui.js::saveAs` (`window.__relaySaveTo`) and refuses to
    continue when the seam is missing, so a future refactor that drops it turns
    these tests red instead of quietly vacuous.
    """
    return """
  (() => {
    const probe = {};
    try { window.__relaySaveTo = probe; } catch (e) { /* window is not writable */ }
    if (window.__relaySaveTo !== probe) throw new Error('saveAs 的测试接口 __relaySaveTo 不再生效，导出类断言会失去意义');
    window.__relaySuggested = null;
    window.__relaySaveTo = %s;
    return 1;
  })()
""" % json.dumps(path)


def end_stub_save():
    """Stop answering Save-As, so a later real export still opens the sheet."""
    return "window.__relaySaveTo = null; 1"
