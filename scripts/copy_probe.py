#!/usr/bin/env python3
"""Real-GTK probe of copy: real pointer and key events (XTEST) go into the app, the clipboard is read back from the X server.

Run it under a session bus and a display: `dbus-run-session -- xvfb-run -a python3 scripts/copy_probe.py` (`make copy` does).
For each case it starts `nsh test .copy/hold.test.tsx --target linux` (a real GTK window, cairo renderer) on a scenario of
`.shots/scenarios.ts`, finds the text it must select over AT-SPI (the accessible's extents), drags / double-clicks /
triple-clicks / presses Ctrl+C with XTEST, and compares what `xclip -o -selection clipboard` returns with what a person
would expect. It stops only the run it started (its process group). `--only a,b` limits the cases, `--list` names them,
`--shots` keeps a PNG of the window per case in `.scratch/copy/`.

Why not the headless harness: `nsh test` (headless) simulates a drag in the engine and `app.clipboard()` reads a seam; neither
shows what GTK's focus, shortcut and selection controllers do with a real Ctrl+C. This does.
"""

import argparse
import ctypes
import ctypes.util
import os
import signal
import struct
import subprocess
import sys
import time
import zlib

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".scratch/copy")

SHIFT, CTRL = 0xFFE1, 0xFFE3
KEYS = {"tab": 0xFF09, "escape": 0xFF1B, "return": 0xFF0D, "left": 0xFF51, "right": 0xFF53, "up": 0xFF52, "down": 0xFF54, "end": 0xFF57, "backspace": 0xFF08, "home": 0xFF50}


class X:
    """The X server of this session: key and pointer events through XTEST, window pixels through XGetImage."""

    def __init__(self):
        self.x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
        self.xtst = ctypes.CDLL(ctypes.util.find_library("Xtst") or "libXtst.so.6")
        x11 = self.x11
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.d = ctypes.c_void_p(x11.XOpenDisplay(None))
        if not self.d:
            raise SystemExit("no X display: run under xvfb-run")
        x11.XDefaultRootWindow.restype = ctypes.c_ulong
        x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        self.root = x11.XDefaultRootWindow(self.d)
        x11.XKeysymToKeycode.restype = ctypes.c_ubyte
        x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XStringToKeysym.restype = ctypes.c_ulong
        x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
        x11.XFlush.argtypes = [ctypes.c_void_p]
        x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        self.xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.window = None

    def focus_app(self):
        """Gives the app's window the input focus: Xvfb has no window manager to do it, and GTK ignores keys otherwise."""
        x11 = self.x11
        root_r, parent_r = ctypes.c_ulong(), ctypes.c_ulong()
        children, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
        x11.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
        x11.XQueryTree(self.d, self.root, ctypes.byref(root_r), ctypes.byref(parent_r), ctypes.byref(children), ctypes.byref(count))
        x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
        best, target = 0, None
        for i in range(count.value):
            attrs = ctypes.create_string_buffer(256)
            if not x11.XGetWindowAttributes(self.d, children[i], attrs):
                continue
            w, h = ctypes.c_int.from_buffer(attrs, 8).value, ctypes.c_int.from_buffer(attrs, 12).value
            if ctypes.c_int.from_buffer(attrs, 92).value == 2 and w * h > best:  # map_state 2 = IsViewable
                best, target = w * h, children[i]
        self.window = target
        if target:
            x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
            x11.XSetInputFocus(self.d, target, 1, 0)
            x11.XFlush(self.d)
        return target

    def _code(self, key):
        sym = KEYS[key] if key in KEYS else (key if isinstance(key, int) else self.x11.XStringToKeysym(key.encode()))
        return self.x11.XKeysymToKeycode(self.d, sym)

    def key(self, key, ctrl=False, shift=False, pause=0.25):
        if ctrl:
            self.xtst.XTestFakeKeyEvent(self.d, self._code(CTRL), 1, 0)
        if shift:
            self.xtst.XTestFakeKeyEvent(self.d, self._code(SHIFT), 1, 0)
        self.xtst.XTestFakeKeyEvent(self.d, self._code(key), 1, 0)
        self.xtst.XTestFakeKeyEvent(self.d, self._code(key), 0, 0)
        if shift:
            self.xtst.XTestFakeKeyEvent(self.d, self._code(SHIFT), 0, 0)
        if ctrl:
            self.xtst.XTestFakeKeyEvent(self.d, self._code(CTRL), 0, 0)
        self.x11.XFlush(self.d)
        time.sleep(pause)

    def type(self, text):
        for ch in text:
            self.key({" ": "space"}.get(ch, ch), pause=0.04)
        time.sleep(0.2)

    def move(self, x, y, pause=0.05):
        self.xtst.XTestFakeMotionEvent(self.d, -1, int(x), int(y), 0)
        self.x11.XFlush(self.d)
        time.sleep(pause)

    def button(self, n, down):
        self.xtst.XTestFakeButtonEvent(self.d, n, 1 if down else 0, 0)
        self.x11.XFlush(self.d)

    def click(self, x, y, n=1, button=1, pause=0.3):
        """`n` quick presses at one point: 2 selects a word, 3 a paragraph."""
        self.move(x, y, 0.1)
        for _ in range(n):
            self.button(button, True)
            time.sleep(0.03)
            self.button(button, False)
            time.sleep(0.06)
        time.sleep(pause)

    def drag(self, x1, y1, x2, y2, pause=0.3):
        self.move(x1, y1, 0.1)
        self.button(1, True)
        time.sleep(0.1)
        steps = 12
        for i in range(1, steps + 1):
            self.move(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, 0.03)
        time.sleep(0.1)
        self.button(1, False)
        time.sleep(pause)

    def screenshot(self, path):
        """The window as a PNG (XGetImage of the root: Xvfb's screen is 24-bit)."""
        x11 = self.x11
        x11.XGetImage.restype = ctypes.c_void_p
        x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
        w, h = 1280, 800
        img = x11.XGetImage(self.d, self.root, 0, 0, w, h, 0xFFFFFFFF, 2)
        if not img:
            return
        # XImage: width, height, xoffset, format, data* ... bytes_per_line at offset 48 on x86-64.
        data_ptr = ctypes.c_void_p.from_address(img + 16).value
        bpl = ctypes.c_int.from_address(img + 44).value
        raw = ctypes.string_at(data_ptr, bpl * h)
        rows = []
        for y in range(h):
            line = raw[y * bpl : y * bpl + w * 4]
            rgb = bytearray(w * 3)
            rgb[0::3], rgb[1::3], rgb[2::3] = line[2::4], line[1::4], line[0::4]
            rows.append(b"\x00" + bytes(rgb))
        body = zlib.compress(b"".join(rows), 3)

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        with open(path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", body) + chunk(b"IEND", b""))
        x11.XDestroyImage = getattr(x11, "XDestroyImage", None)


def clipboard(which="clipboard"):
    """What the clipboard (or the primary selection) holds right now, or None when nothing offers text."""
    r = subprocess.run(["xclip", "-o", "-selection", which], capture_output=True, timeout=10)
    return r.stdout.decode("utf8", "replace") if r.returncode == 0 else None


def clear_clipboard():
    """Puts a sentinel on both selections so a case that copies nothing is told apart from one that copies an empty string."""
    for which in ("clipboard", "primary"):
        p = subprocess.Popen(["xclip", "-selection", which, "-i"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        p.communicate(b"<<sentinel>>")


# ---------------------------------------------------------------- AT-SPI


def find_app():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is not None and "nsh" in (app.get_name() or ""):
            return app
    return None


def nodes(root=None):
    """Every accessible under the app: (role, name, (x, y, w, h), showing)."""
    out = []

    def walk(node, depth):
        if depth > 60:
            return
        try:
            role = node.get_role_name()
            name = node.get_name() or ""
            showing = node.get_state_set().contains(Atspi.StateType.SHOWING)
            box = None
            try:
                e = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
                box = (e.x, e.y, e.width, e.height)
            except Exception:
                pass
            out.append((role, name, box, showing))
            for i in range(node.get_child_count()):
                child = node.get_child_at_index(i)
                if child is not None:
                    walk(child, depth + 1)
        except Exception:
            return

    app = root or find_app()
    if app is not None:
        walk(app, 0)
    return out


def find(role=None, prefix=None, contains=None, nth=0):
    """The nth showing accessible with this role and a name that starts with / contains the text: its centre-left point."""
    hits = [n for n in nodes() if n[3] and n[2] and n[2][2] > 0 and (role is None or n[0] == role)
            and (prefix is None or n[1].startswith(prefix)) and (contains is None or contains in n[1])]
    return hits[nth] if len(hits) > nth else None


class Run:
    """One `nsh test` window on a scenario, until `close`."""

    def __init__(self, scenario, timeout=600):
        env = dict(os.environ, GTK_A11Y="atspi", GSK_RENDERER="cairo", HERDR_DESKTOP_TEST="1")
        env["PATH"] = os.path.expanduser("~/.local/bin") + os.pathsep + env["PATH"]
        sysroot = os.path.join(ROOT, ".scratch/sysroot/env.sh")
        cmd = f'nsh test .copy/hold.test.tsx --target linux --filter "copy[{scenario}]"'
        cmd = f". {sysroot} && exec {cmd}" if os.path.exists(sysroot) else f"exec {cmd}"
        os.makedirs(OUT, exist_ok=True)
        self.log = os.path.join(OUT, f"{scenario}.log")
        with open(self.log, "wb") as log:
            self.child = subprocess.Popen(["sh", "-c", cmd], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.x = X()
        last, stable, deadline = 0, 0, time.time() + timeout
        while time.time() < deadline and self.child.poll() is None:
            time.sleep(1.0)
            rows = nodes()
            if len(rows) < 4:
                continue
            stable = stable + 1 if len(rows) == last else 0
            last = len(rows)
            if stable >= 2:
                break
        else:
            self.close()
            raise RuntimeError(f"{scenario}: the app never showed up on the AT-SPI bus (see {self.log})")
        self.x.focus_app()
        time.sleep(0.5)

    def close(self):
        if self.child.poll() is None:
            try:
                os.killpg(self.child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            self.child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(self.child.pid, signal.SIGKILL)

    def copy_after(self, action, which="clipboard"):
        """Clears the clipboard, runs `action`, then Ctrl+C is the caller's: returns what the clipboard holds."""
        clear_clipboard()
        action()
        time.sleep(0.4)
        text = clipboard(which)
        return None if text == "<<sentinel>>" else text


# ---------------------------------------------------------------- cases


class Case:
    """One scene and what a person does there: `do(x)` acts, the clipboard (or primary) is read, `check(text)` returns a problem or None."""

    def __init__(self, name, scenario, do, expect=None, absent=(), exact=None, nothing=False, which="clipboard"):
        self.name, self.scenario, self.do = name, scenario, do
        self.expect, self.absent, self.exact, self.nothing, self.which = expect or [], absent, exact, nothing, which

    def verdict(self, text):
        if self.nothing:
            return None if text is None else f"expected nothing on the clipboard, got {text!r}"
        if text is None:
            return "nothing was copied"
        if self.exact is not None and text != self.exact:
            return f"expected exactly {self.exact!r}, got {text!r}"
        for part in self.expect:
            if part not in text:
                return f"missing {part!r} in {text!r}"
        for part in self.absent:
            if part in text:
                return f"{part!r} must not be copied: {text!r}"
        if "\u200b" in text or any(0xE000 <= ord(c) <= 0xF8FF for c in text):
            return f"zero-width or private-use character in {text!r}"
        return None


def drag_copy(a, b, c, d):
    def do(x):
        x.drag(a, b, c, d)
        x.key("c", ctrl=True)
    return do


def drag_wait_copy(a, b, c, d, seconds):
    """Selects, lets the screen change underneath for `seconds`, then copies."""

    def do(x):
        x.drag(a, b, c, d)
        time.sleep(seconds)
        x.key("c", ctrl=True)

    return do


def type_then(text, *keys):
    """Types `text` into the field at the end of the chat, then presses each (key, ctrl) of `keys`."""

    def do(x):
        x.click(640, 693)
        x.key("a", ctrl=True)
        x.key("backspace")
        x.type(text)
        for key, ctrl in keys:
            x.key(key, ctrl=ctrl)

    return do


def click_copy(px, py, n, select_all=False):
    def do(x):
        x.click(px, py, n)
        if select_all:
            x.key("a", ctrl=True)
        x.key("c", ctrl=True)
    return do


def cases():
    chat = "chat"
    return [
        Case("chat: drag across paragraphs", chat, drag_copy(282, 183, 700, 247), expect=["The loop came from login", "login now redirects"]),
        Case("chat: double click selects a word", chat, click_copy(300, 183, 2), exact="The"),
        Case("chat: triple click selects the paragraph", chat, click_copy(300, 183, 3), expect=["The loop came from login always redirecting to /callback", "Two changes fix it:"], absent=["login now redirects"]),
        Case("chat: Ctrl+A copies the whole message with its code and table", chat, click_copy(400, 183, 1, select_all=True), expect=["The loop came from login", "export function login(user: User) {\n  const next = safeNext(user.next);", "unit tests\t42 passed"]),
        Case("chat: Ctrl+C with nothing selected copies nothing", chat, click_copy(640, 600, 1), nothing=True),
        Case("chat: a drag in a code block copies its lines with their indentation", chat, drag_copy(293, 345, 500, 405), expect=["export function login(user: User) {\n  const next = safeNext(user.next);\n  redirect(next ?? \"/\");\n}"]),
        Case("chat: a drag in a table copies cells", chat, drag_copy(293, 497, 700, 536), expect=["unit tests", "42 passed"]),
        Case("tool output: a drag across lines copies every line", "chat-tools", drag_copy(322, 251, 480, 331), expect=["PASS src/case-3.test.ts (14 ms)\nPASS src/case-4.test.ts (15 ms)", "FAIL src/case-9.test.ts"]),
        Case("permission dock: a drag across the command copies every line", "permission", drag_copy(52, 124, 150, 204), expect=["set -e\ncd /srv/app\ngit fetch origin\ngit checkout main"]),
        Case("permission diff: a drag across lines copies the code and no numbers or signs", "permission", drag_copy(111, 538, 200, 598), expect=["const a = 1;\nconst b = 2;"], absent=["+", "\u2212", "1\n"]),
        Case("terminal mirror: a drag copies rows", "pane", drag_copy(310, 155, 680, 177), expect=["Creating empty file x.txt in /tmp/hm-capture-claude", "$ touch /tmp/hm-capture-claude/x.txt"]),
        Case("terminal mirror: a selection survives the output of a working agent", "copy-stream", drag_wait_copy(5, 124, 400, 196, 3.0), expect=["row 00 stays where it is", "row 02 stays"]),
        Case("code: a tab is copied as a tab, not as spaces", "code-one-go", drag_copy(95, 138, 300, 218), expect=["context\"\n\t\"errors\"\n\t\"fmt\""], absent=["    "]),
        Case("message box: Ctrl+A, Ctrl+C copies what was typed", "chat", type_then("hello world", ("a", True), ("c", True)), exact="hello world"),
        Case("message box: Ctrl+X cuts and Ctrl+V pastes it back", "chat", type_then("alpha beta", ("a", True), ("x", True), ("v", True), ("v", True), ("a", True), ("c", True)), exact="alpha betaalpha beta"),
        Case("answer dock: the command can be selected", "pane", drag_copy(316, 610, 600, 610), expect=["touch /tmp/hm-capture-claude/x.t"]),
        Case("file viewer: a drag across code lines copies them without line numbers", "file-code", drag_copy(230, 333, 560, 373), expect=["*totals.entry(p.merchant.as_str()).or_insert(0) += p.cents;\n    }\n    totals"], absent=["13", "14"]),
        Case("markdown viewer: a drag copies a paragraph", "file-markdown", drag_copy(186, 297, 650, 297), expect=["A small service that records payments"]),
        Case("markdown viewer: a drag across table cells", "file-markdown", drag_copy(200, 440, 700, 480), expect=["src/", "docs/"]),
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="comma list of substrings of case names")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--shots", action="store_true", help="keep a PNG per case in .scratch/copy/")
    args = parser.parse_args()
    chosen = [c for c in cases() if not args.only or any(o in c.name for o in args.only.split(","))]
    if args.list:
        print("\n".join(c.name for c in chosen))
        return
    os.makedirs(OUT, exist_ok=True)
    failed = 0
    for scenario in dict.fromkeys(c.scenario for c in chosen):
        try:
            run = Run(scenario)
        except RuntimeError as e:
            print(f"FAIL {scenario}: {e}")
            failed += 1
            continue
        try:
            for case in [c for c in chosen if c.scenario == scenario]:
                problem = None
                try:
                    text = run.copy_after(lambda: case.do(run.x), case.which)
                    problem = case.verdict(text)
                except Exception as e:  # a probe step that failed is a failed case
                    problem = f"probe error: {e}"
                if args.shots or problem:
                    run.x.screenshot(os.path.join(OUT, case.name.replace(" ", "-").replace(":", "")[:60] + ".png"))
                print(f"{'FAIL' if problem else 'ok  '} {case.name}" + (f"\n       {problem}" if problem else ""), flush=True)
                failed += bool(problem)
                run.x.key("escape", pause=0.1)
        finally:
            run.close()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
