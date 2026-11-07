#!/usr/bin/env python3
"""Copies a curated set of the `make shots` screenshots into docs/screenshots/ (palette-quantized PNGs, about 40 KB each) and
writes docs/screenshots/README.md, the gallery GitHub shows. The shots come from the scripted fixtures only: never a real
pane or chat. Run `make shots` first, then `python3 scripts/publish-screenshots.py`."""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, ".scratch/shots")
DST = os.path.join(ROOT, "docs/screenshots")

# (scenario, widths, caption)
SET = [
    ("projects", [1280, 960, 760], "Home: projects, a `Needs you` inbox, state chips; at 760 px the sidebar is a rail of project tiles"),
    ("storm", [1280], "Twenty agents waiting at once, in several projects"),
    ("agent-chat", [1280], "A terminal agent (Claude Code) opened as chat, read from its log"),
    ("pane", [1280], "The terminal mirror of the same agent (`Show terminal`)"),
    ("chat", [1280], "Native chat: markdown, code, tables"),
    ("chat-tools", [1280], "Tool rows, a diff, command output, a subagent, queued message while working"),
    ("chat-plan", [1280], "A plan strip that updates in place"),
    ("chat-signin", [1280], "An agent that needs the person to sign in"),
    ("permission", [1280], "A permission request: the whole command, `Read all`, two-step risky answers"),
    ("question", [1280], "A question form"),
    ("new-session", [1280], "New agent session"),
    ("session-overview", [1280], "Session details"),
    ("triage", [1280], "Answer one by one"),
    ("palette", [1280], "Command palette"),
    ("settings", [1280], "Settings"),
    ("settings-notifications", [1280], "Notification settings"),
    ("machines-attention", [1280], "Machines, one needs attention"),
    ("files", [1280], "File browser"),
    ("file-code", [1280], "Code viewer"),
    ("file-diagram", [1280], "A rendered diagram with its text alternative"),
    ("dev-panel", [1280], "Developer panel"),
]

os.makedirs(DST, exist_ok=True)
for f in os.listdir(DST):
    if f.endswith(".png"):
        os.remove(os.path.join(DST, f))
lines = [
    "# Screenshots",
    "",
    "The real GTK window under Xvfb (cairo renderer), against the scripted herdr and a scripted ACP agent: no real pane or chat is shown.",
    "Regenerate with `make shots` then `python3 scripts/publish-screenshots.py`. Light on the left, dark on the right.",
    "",
]
for name, widths, caption in SET:
    lines += [f"## {caption}", ""]
    for w in widths:
        pair = []
        for scheme in ("light", "dark"):
            src = os.path.join(SRC, f"{name}-{scheme}-{w}.png")
            if not os.path.exists(src):
                continue
            out = f"{name}-{scheme}-{w}.png"
            Image.open(src).convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(os.path.join(DST, out), optimize=True)
            pair.append(f'<img src="{out}" alt="{caption}, {scheme}, {w} px" width="{ 480 if w == 1280 else 360 }">')
        if pair:
            lines += [f"<p>{' '.join(pair)}</p>", ""]
open(os.path.join(DST, "README.md"), "w", encoding="utf8").write("\n".join(lines))
total = sum(os.path.getsize(os.path.join(DST, f)) for f in os.listdir(DST))
print(f"{DST}: {len(os.listdir(DST)) - 1} images, {total / 1048576:.1f} MB")
