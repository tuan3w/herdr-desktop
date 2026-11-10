#!/usr/bin/env python3
"""Real keys and a real clipboard against the chat's message box (`docs/ACCESSIBILITY.md`, `design/composer.md`).

Under `dbus-run-session -- xvfb-run -a` it starts the session lab (scenarios `composer-live` and `composer-live-blind` of
`.shots/scenarios.ts`), clicks into the box with XTEST, types, and reads the answers back over AT-SPI: the picker (`Files`),
the chips (`File ...`, `Image n of m`), the box's text (the entry's Text interface) and the lab's log of what was sent.
A PNG goes on the X clipboard with `xclip` (a process this script starts and ends by its PID) and is pasted with Ctrl+V.

  dbus-run-session -- xvfb-run -a python3 scripts/composer_keys.py

Exit code 1 when a check fails. Not part of `make a11y`: it needs xclip and takes about a minute.
"""
import ctypes
import ctypes.util
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import atspi_audit as A  # noqa: E402
from gi.repository import Atspi  # noqa: E402

ROOT = A.ROOT
PNG = os.path.join(ROOT, "fixtures/files/project/assets/shot-1.png")
X11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
XTST = ctypes.CDLL(ctypes.util.find_library("Xtst") or "libXtst.so.6")
X11.XOpenDisplay.restype = ctypes.c_void_p
X11.XOpenDisplay.argtypes = [ctypes.c_char_p]
X11.XKeysymToKeycode.restype = ctypes.c_ubyte
X11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
X11.XKeycodeToKeysym.restype = ctypes.c_ulong
X11.XKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int]
XTST.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
XTST.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
XTST.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
X11.XFlush.argtypes = [ctypes.c_void_p]

SHIFT, CTRL = 0xFFE1, 0xFFE3
KEYS = {"enter": 0xFF0D, "backspace": 0xFF08, "escape": 0xFF1B, "up": 0xFF52, "down": 0xFF54, "tab": 0xFF09}


class Keys:
    def __init__(self):
        self.d = ctypes.c_void_p(X11.XOpenDisplay(None))
        if not self.d:
            raise SystemExit("no X display: run under xvfb-run")

    def _code(self, ks):
        return X11.XKeysymToKeycode(self.d, ks)

    def _event(self, ks, down):
        XTST.XTestFakeKeyEvent(self.d, self._code(ks), 1 if down else 0, 0)

    def chord(self, key, *mods):
        for m in mods:
            self._event(m, True)
        self._event(key, True)
        self._event(key, False)
        for m in reversed(mods):
            self._event(m, False)
        X11.XFlush(self.d)
        time.sleep(0.25)

    def char(self, ch):
        ks = ord(ch)
        code = self._code(ks)
        shifted = X11.XKeycodeToKeysym(self.d, code, 0) != ks
        self.chord(ks, *([SHIFT] if shifted else []))

    def type(self, text):
        for ch in text:
            self.char(ch)

    def click(self, x, y):
        XTST.XTestFakeMotionEvent(self.d, -1, x, y, 0)
        XTST.XTestFakeButtonEvent(self.d, 1, 1, 0)
        XTST.XTestFakeButtonEvent(self.d, 1, 0, 0)
        X11.XFlush(self.d)
        time.sleep(0.4)

    def focus_app_window(self):
        press = A.x_keys()  # focuses the biggest viewable window as the audit does
        return press is not None


def nodes():
    return A.snapshot() or []


def labels():
    return [r[2] for r in nodes()]


def has(prefix):
    return any(l.startswith(prefix) for l in labels())


def wait_for(cond, what, seconds=6):
    end = time.time() + seconds
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.2)
    print(f"  never happened: {what}")
    if os.environ.get("COMPOSER_DEBUG"):
        print("   on screen:", [l for l in labels() if l][-40:])
    return False


def box_text():
    app = A.find_app()

    def find(node):
        try:
            if node.get_role_name() in ("entry", "text") and node.get_name() == "Message" or (
                node.get_role_name() in ("entry", "text") and "Text" in node.get_interfaces() and node.get_name() in ("", "Message") and node.get_state_set().contains(Atspi.StateType.EDITABLE)
            ):
                return Atspi.Text.get_text(node, 0, -1)
            for i in range(node.get_child_count()):
                got = find(node.get_child_at_index(i))
                if got is not None:
                    return got
        except Exception:
            return None
        return None

    return find(app) if app is not None else None


def shot(name):
    """A picture of the whole X screen for a person to look at (`.scratch/composer/live-<name>.png`)."""
    from PIL import ImageGrab

    os.makedirs(os.path.join(ROOT, ".scratch/composer"), exist_ok=True)
    ImageGrab.grab(xdisplay=os.environ.get("DISPLAY")).save(os.path.join(ROOT, f".scratch/composer/live-{name}.png"))


def start(scenario):
    env = dict(os.environ, GDK_BACKEND="x11", GTK_A11Y="atspi", GSK_RENDERER="cairo", HERDR_DESKTOP_TEST="1")
    env["PATH"] = os.path.expanduser("~/.local/bin") + os.pathsep + env["PATH"]
    cmd = f'. {ROOT}/.scratch/sysroot/env.sh && exec nsh test .a11y/audit.test.tsx --target linux --filter "audit {scenario}"'
    child = subprocess.Popen(["sh", "-c", cmd], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    end = time.time() + 300
    while time.time() < end and child.poll() is None:
        time.sleep(1)
        if len(nodes()) >= 8:
            time.sleep(2)
            return child
    raise SystemExit("the app never showed up")


def stop(child):
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)


def clipboard_png():
    """Puts the PNG on the X clipboard; the returned process owns it (this script ends it)."""
    return subprocess.Popen(["xclip", "-selection", "clipboard", "-t", "image/png", "-i", PNG], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


RESULTS = []


def check(name, ok):
    RESULTS.append((name, ok))
    print(("ok   " if ok else "FAIL ") + name)


def sent():
    return next((l for l in labels() if l.startswith("Log: ")), "")


def sighted():
    child = start("composer-live")
    keys = Keys()
    keys.focus_app_window()
    try:
        keys.click(640, 690)
        keys.char("@")
        check("@ opens the file picker", wait_for(lambda: "Files" in labels(), "the Files list"))
        keys.chord(KEYS["down"])
        keys.chord(KEYS["enter"])
        check("Down Enter adds a chip", wait_for(lambda: has("File ") or has("Folder "), "a chip"))
        text = box_text() or ""
        check("the words keep @path", text.startswith("@"))
        keys.chord(KEYS["backspace"])
        keys.chord(KEYS["backspace"])
        check("Backspace takes the whole token and its chip", wait_for(lambda: not (has("File ") or has("Folder ")), "the chip to go"))
        keys.type("abc")
        keys.chord(KEYS["escape"])
        check("Escape keeps what was typed", (box_text() or "").endswith("abc"))
        # nsh takes Escape in an idle box as "leave the field": the person clicks back in (or presses mod+2).
        keys.click(640, 690)
        keys.chord(0xFF57, CTRL)  # Ctrl+End: the caret goes to the end of the words
        shot("typed")
        keys.chord(KEYS["enter"], SHIFT)
        keys.type("def")
        shot("shift-enter")
        check("Shift+Enter is a new line", "\n" in (box_text() or ""))
        keys.chord(KEYS["enter"])
        shot("sent")
        check("Enter sends", wait_for(lambda: "send abc" in sent() and "def" in sent(), "the log"))
        keys.chord(KEYS["up"])
        check("Up recalls the last message", wait_for(lambda: "abc" in (box_text() or ""), "the recalled text"))
        keys.chord(KEYS["down"])
        keys.chord(KEYS["o"] if "o" in KEYS else ord("o"), CTRL, SHIFT)
        time.sleep(1.5)
        shot("dialog")
        windows = subprocess.run(["sh", "-c", "xwininfo -root -tree 2>/dev/null | grep -i 'attach files'"], capture_output=True, text=True).stdout
        check("Ctrl+Shift+O opens the system file dialog", "Attach files" in windows)
        keys.chord(KEYS["escape"])
        owner = clipboard_png()
        time.sleep(0.6)
        keys.click(640, 690)
        keys.chord(ord("v"), CTRL)
        time.sleep(1.0)
        shot("pasted")
        check("Ctrl+V with a PNG on the clipboard shows a thumbnail", wait_for(lambda: has("Image 1 of 1, PNG"), "the thumbnail"))
        keys.type("look")
        keys.chord(KEYS["enter"])
        check("the picture goes with the message", wait_for(lambda: "+pictures 1" in sent(), "the log of the send"))
        owner.terminate()
    finally:
        time.sleep(0.3)
        stop(child)


def blind():
    child = start("composer-live-blind")
    keys = Keys()
    keys.focus_app_window()
    try:
        owner = clipboard_png()
        time.sleep(0.6)
        keys.click(640, 690)
        keys.chord(ord("v"), CTRL)
        check("a picture for an agent that cannot see is pasted", wait_for(lambda: has("Image 1 of 1, PNG"), "the thumbnail"))
        check("and says so", wait_for(lambda: any("cannot see images" in l for l in labels()), "the warning"))
        owner.terminate()
    finally:
        time.sleep(0.3)
        stop(child)


if __name__ == "__main__":
    sighted()
    blind()
    sys.exit(0 if all(ok for _, ok in RESULTS) else 1)
