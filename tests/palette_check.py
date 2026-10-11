"""Check the design tokens against WCAG AA before they ever reach the screen.

tests/contrast_audit.py measures the live rendered UI; this checks the token table
itself, so a bad colour is caught while it is still just two lines of CSS. It also
enforces the flatness rule — the glow/blur system deleted on 2026-09-29 must not
creep back in under a token name that no longer exists.
"""
import re
import sys
from pathlib import Path

CSS = Path(__file__).resolve().parent.parent / "web" / "css" / "app.css"
AA_SMALL = 4.5
AA_LARGE = 3.0

try:  # 控制台默认 GBK，中文标签会变乱码
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def rgb(hexstr):
    h = hexstr.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def lum(color):
    out = []
    for channel in color:
        c = channel / 255
        out.append(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]


def ratio(fg, bg):
    a, b = lum(rgb(fg)), lum(rgb(bg))
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def theme(name):
    text = CSS.read_text(encoding="utf-8")
    block = re.search(r':root\[data-theme="%s"\]\s*\{(.*?)\n\}' % name, text, re.S)
    if not block:
        sys.exit(f"theme {name} not found")
    return dict(
        (k.strip(), v.strip())
        for k, v in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", block.group(1))
    )


def is_hex(value):
    return bool(re.fullmatch(r"#[0-9a-fA-F]{3,8}", value))


# what each token is allowed to sit on, and the floor it must clear
PAIRS = {
    "--text": (["--bg", "--bg-panel", "--bg-hover"], AA_SMALL),
    "--text-dim": (["--bg", "--bg-panel"], AA_SMALL),
    "--text-faint": (["--bg", "--bg-panel"], AA_SMALL),
    "--accent-ink": (["--bg", "--bg-panel"], AA_SMALL),
    "--ok": (["--bg", "--bg-panel"], AA_SMALL),
    "--ok-ink": (["--bg", "--bg-panel"], AA_SMALL),
    "--warn": (["--bg", "--bg-panel"], AA_SMALL),
    "--warn-ink": (["--bg", "--bg-panel"], AA_SMALL),
    "--err-ink": (["--bg", "--bg-panel"], AA_SMALL),
    "--m-get": (["--bg", "--bg-panel"], AA_SMALL),
    "--m-post": (["--bg", "--bg-panel"], AA_SMALL),
    "--m-put": (["--bg", "--bg-panel"], AA_SMALL),
    "--m-patch": (["--bg", "--bg-panel"], AA_SMALL),
    "--m-delete": (["--bg", "--bg-panel"], AA_SMALL),
    "--m-other": (["--bg", "--bg-panel"], AA_SMALL),
    "--tok-key": (["--bg-panel"], AA_SMALL),
    "--tok-str": (["--bg-panel"], AA_SMALL),
    "--tok-bool": (["--bg-panel"], AA_SMALL),
    "--tok-num": (["--bg-panel"], AA_SMALL),
    "--on-accent": (["--accent"], AA_SMALL),
}

fails = 0

# --------------------------------------------------------------- flatness
# The 2026-09-29 restyle deleted the glow system outright: no ambient bloom, no
# top sheen, no catch-light on cards, no frosted chrome. Those four token names
# and backdrop-filter are therefore banned — a token that no longer exists cannot
# be "appended to a shadow list", which is how `box-shadow: var(--card-shadow),
# var(--card-top)` silently became an invalid declaration and dropped the whole
# shadow. Written as a pure function over text so the check can prove it sees the
# bad case before it gets to report 0 good ones.
BANNED_TOKENS = ("--ambient", "--sheen", "--card-top", "--blur")


def flatness(text):
    """Return a list of flatness violations in this CSS text."""
    hits = []
    stripped = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    for token in BANNED_TOKENS:
        defined = re.findall(r"^\s*%s[\w-]*\s*:" % token, stripped, re.M)
        used = re.findall(r"%s[\w-]*\s*\)" % token, stripped)
        if defined:
            hits.append(f"{token} 又被定义了 {len(defined)} 次（这个令牌已删除）")
        elif used:
            hits.append(f"{token} 被引用了 {len(used)} 次，但令牌表里没有它")
    blur = re.findall(r"backdrop-filter\s*:", stripped)
    if blur:
        hits.append(f"backdrop-filter 出现 {len(blur)} 次：磨砂材质已全部改回不透明白")
    return hits


print("\n== 平坦度（渐变/光晕/磨砂）==")
violations = flatness(CSS.read_text(encoding="utf-8"))
for v in violations:
    print(f"  BAD  {v}")
    fails += 1
if not violations:
    print("  ok   无 --ambient/--sheen/--card-top/--blur，无 backdrop-filter")

# A scanner that cannot see the thing it bans reports a false green, so prove it
# can before trusting the 0 above.
probe = flatness(":root{--card-top: inset 0 1px 0 #fff;}\n.a{background: var(--card-top)"
                 ";\n backdrop-filter: blur(8px);}")
if len(probe) != 2:
    print(f"  BAD  平坦度扫描器自测失败：样例里 2 处违规，它只看见 {len(probe)} 处")
    fails += 1
else:
    print("  ok   扫描器自测：坏样例 2 处全部抓到")

for name in ("light", "dark"):
    tokens = {k: v for k, v in theme(name).items() if is_hex(v)}
    print(f"\n== {name} ==")
    for token, (backgrounds, floor) in PAIRS.items():
        if token not in tokens:
            print(f"  MISSING {token}")
            fails += 1
            continue
        for bg in backgrounds:
            if bg not in tokens:
                continue
            got = ratio(tokens[token], tokens[bg])
            mark = "ok " if got >= floor else "BAD"
            if got < floor:
                fails += 1
            print(f"  {mark} {token:14s} on {bg:12s} {got:5.2f} (floor {floor})")

print("\n低于 AA 的令牌：%d" % fails)
sys.exit(1 if fails else 0)
