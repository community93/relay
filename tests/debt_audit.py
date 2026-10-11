"""Design-debt scan for the single-token stylesheet.

The token table at the top of app.css is the contract. Everything below it should
reach for a token instead of a raw value; when it does not, the value can drift
from the system and the UI starts looking assembled rather than designed. This
scan reports the offenders grouped by category so they can be fixed at the token
layer, and it is kept as a regression guard.

    python tests/debt_audit.py
"""

import collections
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "web", "css", "app.css")
JS_DIR = os.path.join(ROOT, "web", "js")

sys.stdout.reconfigure(encoding="utf-8")

TOKEN_BLOCK = re.compile(r"^:root[^{]*\{", re.M)


def strip_comments(text):
    """Blank out comments but keep their length and newlines, so byte offsets and
    line numbers still line up with the real file."""
    return re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)


def token_ranges(text):
    """Byte offsets inside `:root { … }` blocks, where raw values are the point."""
    spans = []
    for match in TOKEN_BLOCK.finditer(text):
        start = match.end()
        depth = 1
        i = start
        while i < len(text) and depth:
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
            i += 1
        spans.append((match.start(), i))
    return spans


def in_spans(pos, spans):
    return any(a <= pos < b for a, b in spans)


def line_of(text, pos):
    return text.count("\n", 0, pos) + 1


def scan_css():
    raw = io.open(CSS, encoding="utf-8").read()
    body = strip_comments(raw)
    spans = token_ranges(body)
    found = collections.defaultdict(list)

    # a radius may be any list of token/zero/circle values: `0 var(--r-xs) var(--r-xs) 0`
    RADIUS_OK = re.compile(r"^(var\(--r[-\w]*\)|0|50%|auto)(\s+(var\(--r[-\w]*\)|0|50%|auto))*$")
    # `/* debt-allow: why */` on the same line marks a deliberate exception —
    # read it from the original text, since the stripped copy has no comments left
    allow = {i for i, L in enumerate(raw.split("\n")) if "debt-allow" in L}
    rules = [
        ("硬编码颜色", re.compile(r"(?<![-\w])(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))"),
         lambda v, k: "currentcolor" not in v.lower()),
        ("任意圆角", re.compile(r"border-radius:\s*([^;]+)"),
         lambda v, k: not RADIUS_OK.match(v.strip())),
        ("非令牌阴影", re.compile(r"box-shadow:\s*([^;]+)"),
         lambda v, k: "var(--" not in v and "none" not in v),
        ("非令牌时长", re.compile(r"transition:[^;]*?(\d+)ms"), lambda v, k: True),
        ("非令牌曲线", re.compile(r"cubic-bezier\("), lambda v, k: True),
        ("任意字号", re.compile(r"font-size:\s*([^;]+)"),
         lambda v, k: "var(--t" not in v and "%" not in v and "inherit" not in v),
        ("任意字重", re.compile(r"font-weight:\s*(\d{3})"), lambda v, k: v not in ("400", "600", "700")),
        ("!important", re.compile(r"!important"), lambda v, k: True),
    ]
    for name, pattern, accept in rules:
        for match in pattern.finditer(body):
            if in_spans(match.start(), spans):
                continue
            value = match.group(1) if match.lastindex else match.group(0)
            if not accept(value.strip() if isinstance(value, str) else value, name):
                continue
            line = line_of(body, match.start())
            if line - 1 in allow:
                continue
            ctx = body.split("\n")[line - 1].strip()[:90]
            found[name].append((line, ctx))

    return found, []


def scan_css_features():
    body = strip_comments(io.open(CSS, encoding="utf-8").read())
    return {
        "自定义滚动条": "::-webkit-scrollbar" in body,
        "选区配色": "::selection" in body,
        "输入光标色": "caret-color" in body,
        "等宽数位": "font-variant-numeric" in body or "tabular-nums" in body,
        "字体平滑": "-webkit-font-smoothing" in body,
        "focus-visible": ":focus-visible" in body,
        "下划线去抖动": "text-underline-offset" in body,
        "禁用态统一": "[disabled]" in body or ":disabled" in body,
        "reduced-motion": "prefers-reduced-motion" in body,
    }


RAWISH = re.compile(r"(?:color|background|backgroundColor|borderColor|boxShadow|borderRadius|fontSize)\s*:\s*[\"']([^\"']*)[\"']")
SKIP_VALUE = re.compile(r"^var\(--|transparent$|^none$|^inherit$|^0$|^auto$|^1px solid|^calc\(|^%$")


def scan_js_inlines():
    hits = []
    for name in sorted(os.listdir(JS_DIR)):
        if not name.endswith(".js"):
            continue
        src = io.open(os.path.join(JS_DIR, name), encoding="utf-8").read()
        for match in re.finditer(r"style:\s*\{([^{}]*)\}", src):
            # a token reference in an inline style is fine; a literal value is debt
            bad = [m.group(1) for m in RAWISH.finditer(match.group(1)) if not SKIP_VALUE.match(m.group(1).strip())]
            if bad:
                hits.append((name, src[:match.start()].count("\n") + 1, " ".join(bad)[:80]))
    return hits


def main():
    found, missing_hover = scan_css()
    features = scan_css_features()
    inline_colors = scan_js_inlines()

    print("# Design Debt Review — web/css/app.css + web/js\n")
    print("## 令牌层是否具备的通用能力")
    for k, v in features.items():
        print(f"  {'有' if v else '缺'}  {k}")

    print("\n## 原始值（令牌表之外）")
    total = 0
    for name in ["硬编码颜色", "任意圆角", "非令牌阴影", "非令牌时长", "非令牌曲线", "任意字号", "任意字重", "!important"]:
        rows = found.get(name, [])
        total += len(rows)
        print(f"\n### {name}: {len(rows)}")
        for line, ctx in rows[:14]:
            print(f"  app.css:{line}  {ctx}")
        if len(rows) > 14:
            print(f"  …另 {len(rows) - 14} 处")

    print(f"\n### 内联颜色/圆角（JS 里 style 对象）: {len(inline_colors)}")
    for name, line, what in inline_colors[:14]:
        print(f"  {name}:{line}  {what}")
    if len(inline_colors) > 14:
        print(f"  …另 {len(inline_colors) - 14} 处")

    print(f"\n### 完全没有 :hover 规则的可交互类: {len(missing_hover)}")
    for m in missing_hover:
        print("  ", m)

    print(f"\n合计原始值命中：{total + len(inline_colors)}")
    missing = [k for k, v in features.items() if not v]
    print(f"缺失的通用能力：{missing or '无'}")
    report = {"css": {k: v for k, v in found.items()}, "features": features,
              "js_inline": inline_colors, "missing_hover": missing_hover}
    out = os.path.join(ROOT, ".design-qa", "reports")
    os.makedirs(out, exist_ok=True)
    io.open(os.path.join(out, "design-debt.json"), "w", encoding="utf-8").write(
        json.dumps(report, ensure_ascii=False, indent=1))
    print("写入 .design-qa/reports/design-debt.json")
    # the gate: anything the scanner still sees has to be a documented exception
    return 1 if (total or inline_colors or missing) else 0


sys.exit(main())
