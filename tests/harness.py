"""Shared CDP harness for the Relay E2E suites.

Every suite used to re-implement its own socket plumbing, which meant three
incompatible `js()` helpers, no console-error capture, and — the reason this file
exists — no way to measure how long an interaction takes. Import `Harness`.

Two things to know before writing a check:

* **Synthetic `.click()` is not enough.** It sets `isTrusted = false`, so
  `morph()` skips the view transition and the clipboard/file APIs get no user
  activation. Anything that must behave like a user gets `h.click()` / `h.key()`,
  which are real `Input.dispatch*` events.
* **`.subtab` is ambiguous.** Request subtabs (`Body`, `Headers`, `Params`,
  `Settings`) and response subtabs (`Body`, `Headers (n)`, `Cookies (n)`) share
  class names, and `#request-host` precedes `#response-host` in the DOM, so an
  unscoped `querySelectorAll('.subtab')` always silently picks the request one.
  Use `h.subtab(scope, name)`.
"""

import json
import sys
import time
import urllib.request

import websocket

# the Windows console defaults to GBK and turns every Chinese check name into
# mojibake, which makes a failing run unreadable
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DEFAULT_PORT = int(sys.argv[1]) if len(sys.argv)>1 and sys.argv[1].isdigit() else 9223
BASE = "http://127.0.0.1:8899"

# rAF heartbeat + longtask observer + two measurement primitives.
PROBE = r"""(() => {
  if (window.__probe) return 'already installed';
  const probe = { long: [], frames: 0, worstGap: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) probe.long.push(Math.round(entry.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch (error) { /* no longtask support; frame timing still works */ }
  let last = performance.now();
  const tick = (now) => {
    probe.frames += 1;
    const gap = now - last;
    last = now;
    if (gap > probe.worstGap) probe.worstGap = Math.round(gap);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  /// Run `action`, then wait two frames — by then the browser has committed a
  /// paint for whatever the action changed. Returns handler cost, frames that
  /// elapsed, and any exception the handler threw.
  probe.measure = (action) => new Promise((resolve) => {
    const t0 = performance.now();
    const before = probe.frames;
    let thrown = null;
    try { action(); } catch (error) { thrown = String((error && error.message) || error); }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve({
      ms: +(performance.now() - t0).toFixed(1),
      frames: probe.frames - before,
      error: thrown,
    })));
  });

  /// Poll `predicate` until it holds. `ok: false` means the UI never caught up,
  /// which is the "点了切换不过来" failure this exists to catch.
  probe.settle = async (predicate, limit = 3000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < limit) {
      let done = false;
      try { done = !!predicate(); } catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
      if (done) return { ok: true, ms: +(performance.now() - t0).toFixed(1) };
      await new Promise((r) => setTimeout(r, 16));
    }
    return { ok: false, ms: +(performance.now() - t0).toFixed(1), timeout: true };
  };

  window.__probe = probe;
  return 'installed';
})()"""

# CDP's modifier bit field, in its own order: Alt 1, Ctrl 2, Meta/Command 4,
# Shift 8. Getting this wrong is silent — a "shift-click" arrives as Meta+click
# and the page behaves differently with no error anywhere.
MODS = {"alt": 1, "ctrl": 2, "meta": 4, "shift": 8}
CODES = {
    "Enter": "Enter", "Tab": "Tab", "Escape": "Escape", "F6": "F6", "Delete": "Delete",
    " ": "Space", "?": "Slash",
}
# virtual-key codes Chromium expects for the named keys the app binds. The arrow
# codes are not optional: without a real VK Chromium discards the keydown, and an
# Alt+Arrow assertion would then be testing nothing at all.
NAMED_VK = {
    "Enter": 13,
    "Tab": 9,
    "Escape": 27,
    "F6": 117,
    "Delete": 46,
    " ": 32,
    "?": 191,
    "ArrowUp": 38,
    "ArrowDown": 40,
    "ArrowLeft": 37,
    "ArrowRight": 39,
}


class Harness:
    def __init__(self, port=DEFAULT_PORT, timeout=90, label="e2e"):
        self.timeout = timeout
        self.label = label
        self.counter = 0
        self.results = []
        self.events = []
        self.errors = []
        pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=5))
        candidates = [p for p in pages if p.get("type") == "page" and "tauri" in (p.get("url") or "")] or \
                     [p for p in pages if p.get("type") == "page"]
        if not candidates:
            raise SystemExit(f"no page on port {port} — is dist\\Relay.exe running with --remote-debugging-port?")
        self.sock = websocket.create_connection(candidates[0]["webSocketDebuggerUrl"], timeout=timeout)
        self._call("Runtime.enable")
        self._call("Page.enable")
        self._call("Log.enable")
        self.js(PROBE)
        # Neutralise the OS dialogs. Once `dialog:allow-save` was granted, a suite
        # that sweeps every visible button clicks 导出 and opens a real modal
        # Save-As sheet — which blocks the webview and the whole run dies on a CDP
        # timeout that looks like a product hang. Tests that actually want to write
        # a file install their own answer afterwards with ui_js.stub_save().
        # The `<input type=file>` guard is the same hazard from the other plugin:
        # filePicker() calls input.click(), and Windows opens its own picker, which
        # no Tauri stub can intercept because it never leaves the DOM.
        self.js("""(() => {
          if (!window.__fileClickGuarded) {
            const real = HTMLInputElement.prototype.click;
            HTMLInputElement.prototype.click = function () {
              if (this.type === 'file') {
                window.__fileCalls = (window.__fileCalls || 0) + 1;
                return undefined;
              }
              return real.apply(this, arguments);
            };
            window.__fileClickGuarded = true;
          }
          const core = window.__TAURI__ && window.__TAURI__.core;
          if (!core) return 'no-tauri';
          if (core.__dialogStubbed) return 'already';
          const real = core.invoke.bind(core);
          window.__dialogCalls = [];
          core.invoke = async (cmd, args) => {
            if (String(cmd).indexOf('plugin:dialog|') === 0) {
              window.__dialogCalls.push(cmd);
              return null;
            }
            return real(cmd, args);
          };
          core.__dialogStubbed = true;
          return 'stubbed';
        })()""")
        # A suite that leaves thirty tabs and a dark theme behind makes the *next*
        # suite fail for reasons that have nothing to do with it — the tab strip
        # overflows and pushes controls off screen. Snapshot on entry so
        # `finish()` can hand the app back as it found it.
        self._baseline = self.eval_json("""(async () => {
          const s = await import('/js/state.js');
          return JSON.stringify({
            tabs: s.state.tabs.map((t) => t.id),
            theme: document.documentElement.dataset.theme,
            collectionAuth: s.state.collections.map((c) => JSON.stringify(c.auth || null)),
          });
        })()""")

    def restore(self):
        """Undo whatever this suite left in the shared app state.

        Tabs collapse to a single one rather than back to the entry snapshot: each
        suite's entry state already contains the previous suite's leftovers, so
        "restore to how it found me" ratchets the strip upward until it overflows
        and pushes later suites' controls off screen.
        """
        base = self._baseline if isinstance(self._baseline, dict) else {}
        self.js("""(async () => {
          const s = await import('/js/state.js');
          for (const t of [...s.state.tabs.slice(1)]) s.closeTab(t.id);
          if (s.state.tabs.length) s.state.activeTabId = s.state.tabs[0].id;
          s.state.settings.theme = %s;
          document.documentElement.dataset.theme = %s;
          s.touch('settings');
          s.emit('tabs');
          s.emit('rerender');
          return s.state.tabs.length;
        })()""" % (json.dumps(base.get("theme", "light")), json.dumps(base.get("theme", "light"))))
        auths = base.get("collectionAuth") or []
        if auths:
            self.js("""(async () => {
              const s = await import('/js/state.js');
              const raw = %s;
              s.state.collections.forEach((c, i) => {
                if (raw[i] === undefined) return;
                c.auth = raw[i] === 'null' ? undefined : JSON.parse(raw[i]);
              });
              s.touch('collections');
              return 1;
            })()""" % json.dumps(auths))
        time.sleep(0.4)

    # ---------------- plumbing ----------------

    def _send(self, method, params=None):
        self.counter += 1
        self.sock.send(json.dumps({"id": self.counter, "method": method, "params": params or {}}))
        return self.counter

    def _call(self, method, params=None, timeout=None):
        marker = self._send(method, params)
        deadline = time.time() + (timeout or self.timeout)
        while time.time() < deadline:
            payload = json.loads(self.sock.recv())
            if "id" not in payload:
                self._record_event(payload)
                continue
            if payload["id"] == marker:
                if "error" in payload:
                    raise SystemExit(f"CDP {method}: {json.dumps(payload['error'])[:200]}")
                return payload.get("result", {})
        raise SystemExit(f"CDP {method} timed out")

    def _record_event(self, payload):
        """Keep page errors and console errors so a suite can assert the UI never
        threw while being clicked. Unread events would otherwise vanish."""
        name = payload.get("method", "?")
        self.events.append(name)
        params = payload.get("params") or {}
        if name == "Runtime.exceptionThrown":
            detail = params.get("exceptionDetails") or {}
            text = (detail.get("exception") or {}).get("description") or detail.get("text")
            self.errors.append(f"exception: {str(text)[:200]}")
        elif name == "Runtime.consoleAPICalled" and params.get("type") == "error":
            parts = " ".join(str(a.get("value", a.get("description", ""))) for a in params.get("args") or [])
            self.errors.append(f"console: {parts[:200]}")
        elif name == "Log.entryAdded":
            entry = params.get("entry") or {}
            if entry.get("level") == "error":
                self.errors.append(f"{entry.get('source')}: {str(entry.get('text'))[:200]}")

    def js(self, expression, timeout=None):
        """Evaluate and hand back the value; a JS crash comes back as a dict so a
        silently-empty probe never masquerades as a passing check."""
        result = self._call("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
        }, timeout)
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            message = detail.get("exception", {}).get("description") or detail.get("text")
            return {"jsError": str(message)[:400]}
        value = result.get("result", {}).get("value")
        return value if isinstance(value, (dict, list)) else (value if isinstance(value, str) else json.dumps(value))

    def eval_json(self, expression, timeout=None):
        """`js()` for expressions that return a JSON string."""
        value = self.js(expression, timeout)
        if isinstance(value, dict) and value.get("jsError"):
            return value
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value)
        except (TypeError, json.JSONDecodeError):
            return {"jsError": f"not JSON: {str(value)[:160]}"}

    # ---------------- real input ----------------

    def mouse_at(self, x, y, button="left", kinds=("mousePressed", "mouseReleased"), modifiers=0):
        for kind in kinds:
            self._call("Input.dispatchMouseEvent", {
                "type": kind, "x": x, "y": y, "button": button, "clickCount": 1,
                "buttons": 1 if kind == "mousePressed" else 0, "modifiers": modifiers,
            })
            time.sleep(0.04)

    def hover_at(self, x, y):
        self._call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        time.sleep(0.15)

    def drag(self, x1, y1, x2, y2, steps=8):
        self._call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x1, "y": y1,
                                                "button": "left", "clickCount": 1, "buttons": 1})
        for i in range(1, steps + 1):
            self._call("Input.dispatchMouseEvent", {
                "type": "mouseMoved", "x": x1 + (x2 - x1) * i / steps, "y": y1 + (y2 - y1) * i / steps,
                "button": "left", "buttons": 1,
            })
            time.sleep(0.02)
        self._call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x2, "y": y2,
                                                "button": "left", "clickCount": 1, "buttons": 0})
        time.sleep(0.25)

    def key(self, char, ctrl=False, shift=False, alt=False, meta=False):
        modifiers = (MODS["ctrl"] * ctrl) + (MODS["shift"] * shift) + (MODS["alt"] * alt) + (MODS["meta"] * meta)
        named = len(char) != 1
        common = {
            "key": char,
            "code": CODES.get(char, f"Key{char.upper()}"),
            "windowsVirtualKeyCode": NAMED_VK.get(char, ord(char.upper()) if not named else 0),
            "nativeVirtualKeyCode": NAMED_VK.get(char, ord(char.upper()) if not named else 0),
            "modifiers": modifiers,
        }
        # CDP rejects `text` for non-printable keys ("Invalid 'text' parameter"),
        # so named keys go out as bare keyDown/keyUp and rely on `key` alone.
        down = {"type": "keyDown", **common}
        if not named:
            down["text"] = char
        self._call("Input.dispatchKeyEvent", down)
        self._call("Input.dispatchKeyEvent", {"type": "keyUp", **common})
        time.sleep(0.2)

    def scroll(self, x, y, dy):
        self._call("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y,
                                                "deltaX": 0, "deltaY": dy})
        time.sleep(0.2)

    # ---------------- locating ----------------

    def point(self, element_expr):
        """Centre of whatever `element_expr` (a JS expression yielding an Element),
        scrolled into view first.

        This is the reason to click through the harness rather than by hand: a
        control below the fold reports a perfectly good `getBoundingClientRect()`
        and a real mouse event at those coordinates hits nothing at all, so the
        check fails and looks like a dead control. `blocked` / `onScreen` make
        that loud instead of mysterious.
        """
        return self.eval_json("""(() => {
          const n = (%s);
          if (!n) return JSON.stringify({ missing: true });
          n.scrollIntoView({ block: 'center', inline: 'nearest' });
          const r = n.getBoundingClientRect();
          const x = r.x + r.width / 2, y = r.y + r.height / 2;
          const top = document.elementFromPoint(x, y);
          return JSON.stringify({
            x, y, w: Math.round(r.width), h: Math.round(r.height),
            text: (n.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
            onScreen: y >= 0 && y <= innerHeight && x >= 0 && x <= innerWidth,
            blocked: !(top === n || n.contains(top) || (top && top.contains(n))),
            topEl: top ? top.tagName.toLowerCase() + '.' + String(top.className).split(' ')[0] : null,
          });
        })()""" % element_expr)

    def box(self, selector):
        out = self.point("document.querySelector(%s)" % json.dumps(selector))
        if not out.get("missing") and not out.get("jsError"):
            out["left"] = out["x"] - out["w"] / 2
            out["top"] = out["y"] - out["h"] / 2
        return out

    def click(self, selector, timeout=2.0, strict=True, modifiers=0):
        """Trusted click on an element's centre, scrolled into view first. With
        `strict`, a point that is off-screen or covered returns an error dict so
        the caller fails on "the click could not land", not on a mystery state."""
        target = self.box(selector)
        if target.get("missing") or target.get("jsError"):
            return target
        if strict and (target.get("blocked") or not target.get("onScreen")):
            return {"clickDidNotLand": target}
        self.mouse_at(target["x"], target["y"], modifiers=modifiers)
        time.sleep(timeout)
        return target

    def ctrl_click(self, selector, timeout=0.45):
        return self.click(selector, timeout=timeout, modifiers=MODS["ctrl"])

    def shift_click(self, selector, timeout=0.45):
        return self.click(selector, timeout=timeout, modifiers=MODS["shift"])

    def double_click(self, selector, timeout=0.6):
        """A real double-click (down/up with clickCount 1, then the same pair with
        2) — `dblclick` only fires for trusted events with a plausible sequence."""
        target = self.box(selector)
        if target.get("missing") or target.get("jsError"):
            return target
        if target.get("blocked") or not target.get("onScreen"):
            return {"clickDidNotLand": target}
        for count in (1, 2):
            for kind in ("mousePressed", "mouseReleased"):
                self._call("Input.dispatchMouseEvent", {
                    "type": kind, "x": target["x"], "y": target["y"], "button": "left",
                    "clickCount": count, "buttons": 1 if kind == "mousePressed" else 0,
                })
                time.sleep(0.03)
        time.sleep(timeout)
        return target

    def type_into(self, selector, text):
        """Set a field's value the way an IME/paste would (value + `input`), which
        is what the app's live-refresh handlers listen for."""
        return self.js("""(() => {
          const n = document.querySelector(%s);
          if (!n) return 'missing';
          n.focus();
          n.value = %s;
          n.dispatchEvent(new Event('input', { bubbles: true }));
          return document.activeElement === n ? 'ok' : 'focus-lost';
        })()""" % (json.dumps(selector), json.dumps(text)))

    def pick_option(self, selector, value, settle=0.4):
        """Choose an option in a selectField the way a user does: open it, click a row.

        Tests used to assign `.value` on a native <select> and dispatch `change`.
        The replacement is a button plus an app-drawn list, so it takes two clicks,
        and rows are matched by data-value so a test never breaks when wording or
        option order changes.
        """
        out = self.eval_json("""(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const field = document.querySelector(%s);
          if (!field) return JSON.stringify({ missing: true });
          field.click();
          await sleep(220);
          const row = [...document.querySelectorAll('.menu .menu-item')]
            .find((r) => r.getAttribute('data-value') === %s);
          if (!row) return JSON.stringify({ noOption: true, menuOpen: !!document.querySelector('.menu') });
          row.click();
          await sleep(360);
          return JSON.stringify({ value: field.dataset.value, menuGone: !document.querySelector('.menu') });
        })()""" % (json.dumps(selector), json.dumps(value)))
        if isinstance(out, dict) and out.get("value") == value:
            time.sleep(settle)
        return out

    def _mouse(self, kind, x, y, button="left", click_count=1):
        self._call("Input.dispatchMouseEvent", {
            "type": kind, "x": x, "y": y, "button": button,
            "clickCount": click_count, "buttons": 1 if kind != "mouseReleased" else 0,
        })

    def _pump(self, timeout=0.25):
        """Read whatever the page has already sent without blocking the run."""
        import select

        out = []
        deadline = time.time() + timeout
        while time.time() < deadline:
            ready, _, _ = select.select([self.sock], [], [], 0.05)
            if not ready:
                continue
            try:
                out.append(json.loads(self.sock.recv()))
            except Exception:
                break
        return out

    def html_drag(self, src, dst, settle=0.6):
        """Drag the way a mouse does it, not with a synthetic DragEvent.

        With `Input.setInterceptDrags` on, Chromium runs its own drag machinery
        from the real mousedown/mousemove, then reports the drag data store to us
        and lets us feed back dragEnter/dragOver/drop.

        Kept for hand-checking a drag gesture, but e2e_runner deliberately does
        NOT assert through it: whether Chromium arms a drag from synthetic mouse
        events is Chromium's business and it does so only intermittently here, so
        a suite built on it goes red for reasons that have nothing to do with the
        product. The product contract that *is* deterministic — dragstart must
        populate the data transfer, or Chromium abandons the drag — is asserted
        directly instead.

        Returns the reported drag data, or None when the browser never started a
        drag (which is a failure, not an empty result).
        """
        x1, y1 = src
        x2, y2 = dst
        # Chromium does not always arm the drag on the first synthetic gesture, and
        # a silent no-op here is what would make this check flaky instead of useful.
        data = None
        for _ in range(3):
            data = self._drag_once(x1, y1, x2, y2)
            if data:
                break
        time.sleep(settle)
        return data

    def _drag_once(self, x1, y1, x2, y2):
        self._call("Input.setInterceptDrags", {"enabled": True})
        data = None
        try:
            self._mouse("mouseMoved", x1, y1)
            self._mouse("mousePressed", x1, y1)
            for step in range(1, 17):
                self._mouse("mouseMoved", x1 + (x2 - x1) * step / 16, y1 + (y2 - y1) * step / 16)
                for message in self._pump(0.3):
                    if message.get("method") == "Input.dragIntercepted":
                        data = message["params"]["data"]
                        break
                if data:
                    break
            if data:
                # this WebView2's CDP only accepts dragEnter / dragOver / drop
                for kind in ("dragEnter", "dragOver", "dragOver", "drop"):
                    self._call("Input.dispatchDragEvent", {"type": kind, "x": x2, "y": y2, "data": data})
                    time.sleep(0.04)
            self._mouse("mouseReleased", x2, y2)
        finally:
            self._call("Input.setInterceptDrags", {"enabled": False})
        if data:
            self._absorb_stuck_click()
        return data

    def _absorb_stuck_click(self):
        """After an intercepted drag Chromium eats the next real click — there is no
        dragEnd event to close the session — so spend it on a point with no handler
        instead of losing the following assertion."""
        blank = self.eval_json("""(() => {
          const body = document.querySelector('.sidebar-body') || document.body;
          const b = body.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.bottom - 12) });
        })()""")
        if isinstance(blank, dict) and "x" in blank:
            self.mouse_at(blank["x"], blank["y"])
            time.sleep(0.15)

    def click_where(self, selector, text, scope=None, exact=True, timeout=0.6):
        """Trusted click on the first `selector` whose text matches — text beats
        positional selectors, which break the moment a group is reordered.

        The returned dict is the evidence, not decoration: it says `jsError`,
        `clickDidNotLand` or `missing` when nothing was actually clicked, so a
        caller that ignores it can watch a no-op "pass". Check it.
        """
        root = json.dumps(scope or "")
        find = "(%s ? document.querySelector(%s) : document)" % (root, root)
        target = self.point("""[...%s.querySelectorAll(%s)].find((n) => {
              const t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
              return %s ? t === %s : t.startsWith(%s);
            })""" % (find, json.dumps(selector), "true" if exact else "false",
                     json.dumps(text, ensure_ascii=False), json.dumps(text, ensure_ascii=False)))
        if target.get("missing") or target.get("jsError"):
            return target
        if target.get("blocked") or not target.get("onScreen"):
            return {"clickDidNotLand": target}
        self.mouse_at(target["x"], target["y"])
        time.sleep(timeout)
        return target

    def click_seg_button(self, seg_expr, index, timeout=0.5):
        """Trusted click on the nth button of a segmented control found by `seg_expr`."""
        target = self.point("(%s) ? [...(%s).querySelectorAll('button')][%d] : null" % (seg_expr, seg_expr, index))
        if target.get("missing") or target.get("jsError"):
            return target
        if target.get("blocked") or not target.get("onScreen"):
            return {"clickDidNotLand": target}
        self.mouse_at(target["x"], target["y"])
        time.sleep(timeout)
        return target

    def switch_named(self, label, scope=".overlay"):
        """JS expression locating a switch by its accessible name."""
        return ("[...(document.querySelectorAll(%s + ' .switch'))]"
                ".find((x) => x.getAttribute('aria-label') === %s)" % (json.dumps(scope), json.dumps(label, ensure_ascii=False)))

    @staticmethod
    def subtab(scope, name):
        """A subtab selector scoped to one pane, so request and response tabs of
        the same name stop colliding."""
        return f"{scope} .subtab"

    def click_subtab(self, scope, name):
        """Click the subtab in `scope` whose label starts with `name`."""
        target = self.eval_json("""(() => {
          const hit = [...document.querySelectorAll(%s + ' .subtab')]
            .find((b) => (b.textContent || '').trim().startsWith(%s));
          if (!hit) return JSON.stringify({ missing: true, seen: [...document.querySelectorAll(%s + ' .subtab')]
            .map((b) => b.textContent.trim().slice(0, 16)) });
          const r = hit.getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()""" % (json.dumps(scope), json.dumps(name), json.dumps(scope)))
        if target.get("missing") or target.get("jsError"):
            return target
        self.mouse_at(target["x"], target["y"])
        time.sleep(0.5)
        return target

    # ---------------- measuring ----------------

    def measure(self, action_js):
        """Milliseconds until the second frame after `action_js` ran, plus any
        exception it threw. `action_js` is a JS expression body."""
        return self.eval_json("""(async () => {
          window.__probe.long.length = 0;
          const out = await window.__probe.measure(() => { %s });
          out.long = window.__probe.long.slice(0, 6);
          return JSON.stringify(out);
        })()""" % action_js)

    def settle(self, predicate_expr, limit=3000):
        """`predicate_expr` must be a JS *expression* (no `return`). Wrapping it in
        a block would turn `() => { expr }` into a function that always returns
        undefined and times out against an already-satisfied UI."""
        return self.eval_json("""(async () => JSON.stringify(
          await window.__probe.settle(() => (%s), %d)
        ))()""" % (predicate_expr, limit))

    def worst_gap(self):
        return self.js("String(window.__probe.worstGap)")

    def reset_probe(self):
        self.js("(() => { window.__probe.worstGap = 0; window.__probe.long.length = 0; return 1; })()")

    # ---------------- asserting ----------------

    def guard(self, out):
        if isinstance(out, dict) and out.get("jsError"):
            print(f"    !! js 崩了：{out['jsError']}", flush=True)
        return out

    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok)))
        flag = "PASS" if ok else "FAIL"
        print(f"[{flag}] {name}{(' — ' + str(detail)[:240]) if detail else ''}", flush=True)

    def sweep_controls(self):
        """List form controls that the design system does not actually style.

        A control matched only by `*` and the tag reset renders with the user-agent
        default, which is what reads as "cheap at the edges". A visible
        `input[type=file]` is an OS widget too.

        Any <select> is an offender outright, even a `appearance: none` one: styling
        the closed box leaves the opened list to Windows, and that white popup over
        a dark app is exactly what selectField in menu.js exists to prevent. The
        rule is absolute now so nobody can reintroduce one by accident.
        """
        return self.eval_json(r"""(() => {
          const rules = [];
          for (const sheet of document.styleSheets) {
            let list;
            try { list = sheet.cssRules; } catch (e) { continue; }
            const walk = (rs) => {
              for (const r of rs) {
                // selectorText first: since CSS nesting landed every style rule also
                // has an (usually empty) `cssRules`, so testing that swallows them all
                if (r.selectorText) rules.push(r.selectorText);
                else if (r.cssRules && r.cssRules.length) walk(r.cssRules);
              }
            };
            walk(list);
          }
          const uniq = [...new Set(rules)];
          const out = [];
          const seen = new Set();
          for (const el of document.querySelectorAll('button, input, select, textarea')) {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            const cs = getComputedStyle(el);
            const hits = uniq.filter((sel) => {
              for (const part of sel.split(',')) {
                try { if (el.matches(part.trim())) return true; } catch (e) { /* :hover etc. */ }
              }
              return false;
            });
            const styled = hits.filter((sel) => /[.\[#]/.test(sel));
            const tag = el.tagName.toLowerCase();
            const type = String(el.type || '').toLowerCase();
            const painted = r.width > 8 && r.height > 8 && cs.opacity !== '0' && cs.visibility === 'visible';
            const suspect = styled.length === 0
              || tag === 'select'
              || (type === 'file' && painted);
            if (!suspect) continue;
            const label = (el.textContent || el.title || el.placeholder || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 26);
            const kind = tag + (type ? '[' + type + ']' : '');
            const sig = kind + '|' + el.className + '|' + label.slice(0, 12);
            if (seen.has(sig)) continue;
            seen.add(sig);
            out.push({ kind, cls: String(el.className).slice(0, 40), label, rules: styled.length, appearance: cs.appearance });
          }
          return JSON.stringify(out);
        })()""")

    def console_errors(self, kinds=("exception", "console")):
        """Page errors and console errors collected so far. Network failures are
        excluded by default: a suite that deliberately points a request at a dead
        port would otherwise "fail" on its own fixture, and CORS noise from the
        probe itself is not an app defect."""
        self.js("1")
        wanted = tuple(f"{k}:" for k in kinds)
        return [e for e in self.errors if e.startswith(wanted)]

    def report(self):
        failed = [name for name, ok in self.results if not ok]
        print(f"\n{len(self.results) - len(failed)}/{len(self.results)} 通过")
        if failed:
            print("失败项：" + "、".join(failed))
        return 1 if failed else 0

    def finish(self, keep=False):
        if not keep:
            self.restore()
        sys.exit(self.report())
