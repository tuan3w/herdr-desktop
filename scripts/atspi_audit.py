#!/usr/bin/env python3
"""Reads the accessibility tree of every screen over AT-SPI and fails on a control with no name.

Run it under a session bus and a display: `dbus-run-session -- xvfb-run -a python3 scripts/atspi_audit.py`
(`make a11y` does). For each scenario of `.shots/scenarios.ts` it starts `nsh test .a11y/audit.test.tsx --target linux`
(a real GTK window, cairo renderer), waits for the app to appear on the AT-SPI bus, dumps the tree to
`.scratch/a11y/<scenario>.txt`, checks it, and stops the run it started (only that PID).

Rules (docs/ACCESSIBILITY.md): these roles must have a non-empty name: push button, toggle button, check box,
radio button, menu item, page tab, entry, combo box, slider, list item; a screen must have a focusable element.
`--only a,b` limits the scenarios. Exit code 1 when any rule fails.
"""
import argparse
import os
import re
import signal
import subprocess
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAMED = {"text", "button", "push button", "toggle button", "check box", "radio button", "menu item", "page tab", "entry", "combo box", "slider", "list item"}
APP = "nsh"

# Unnamed controls that nsh 0.4.0 draws itself and the app cannot name, by scenario and role, with the exact count allowed
# (a new unnamed control still fails). `docs/ACCESSIBILITY.md` says what each one is.
HOST_UNNAMED = {
    "file-markdown": {"check box": 1},  # `TextView` draws an unchecked task-list box without a name (a checked one is named `✓`)
    "files-archive": {"button": 2},  # `DataTable` draws two buttons of its scroll corner and header without a name
}


def scenarios():
    text = open(os.path.join(ROOT, ".shots/scenarios.ts"), encoding="utf8").read()
    body = text[text.index("export const SCENARIOS"):]
    return [a or b for a, b in re.findall(r'^\s{2}(?:"([a-z-]+)"|([a-z]+)):\s*\{', body, re.M)]


def find_app():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if app is not None and APP in (app.get_name() or ""):
            return app
    return None


def walk(node, depth, rows, group=""):
    try:
        role = node.get_role_name()
        name = node.get_name() or ""
        states = node.get_state_set()
        focusable = states.contains(Atspi.StateType.FOCUSABLE)
        showing = states.contains(Atspi.StateType.SHOWING)
    except Exception:
        return
    # GTK 4.14 says `push button` where 4.22 says `button`: one name, so the allowances below fit both.
    rows.append((depth, "button" if role == "push button" else role, name, focusable, showing, group))
    # GTK names a text input through the labelled group around it (`grouping 'Search agents'` > `text ''`). GTK 4.14
    # (Ubuntu 24.04, the CI runner) calls that group a `panel`, 4.22 a `grouping`.
    inner = name if role in ("grouping", "panel") and name else group
    for i in range(node.get_child_count()):
        child = node.get_child_at_index(i)
        if child is not None:
            walk(child, depth + 1, rows, inner)


def snapshot():
    app = find_app()
    if app is None:
        return None
    rows = []
    walk(app, 0, rows)
    return rows


def focused_node(node, depth=0):
    """The accessible that has keyboard focus, or None."""
    try:
        if node.get_state_set().contains(Atspi.StateType.FOCUSED):
            return node
        for i in range(node.get_child_count()):
            child = node.get_child_at_index(i)
            if child is not None:
                found = focused_node(child, depth + 1)
                if found is not None:
                    return found
    except Exception:
        return None
    return None


def x_keys():
    """Opens the display for real key events (XTEST) and focuses the app's window.

    Xvfb runs without a window manager, which would otherwise give the window the input focus, and GTK ignores keys (and
    draws no focus) in a window that is not active. Returns a `press(keysym)` function, or None without a display."""
    import ctypes
    import ctypes.util

    x11 = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
    xtst = ctypes.CDLL(ctypes.util.find_library("Xtst") or "libXtst.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    display = x11.XOpenDisplay(None)
    if not display:
        return None
    d = ctypes.c_void_p(display)
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    root = x11.XDefaultRootWindow(d)
    root_return, parent_return = ctypes.c_ulong(), ctypes.c_ulong()
    children, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
    x11.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
    x11.XQueryTree(d, root, ctypes.byref(root_return), ctypes.byref(parent_return), ctypes.byref(children), ctypes.byref(count))
    # The app's window is the biggest viewable top-level window (GDK also makes small unmapped helper windows).
    target, best = None, 0
    x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
    for i in range(count.value):
        attrs = ctypes.create_string_buffer(256)
        if not x11.XGetWindowAttributes(d, children[i], attrs):
            continue
        width, height = ctypes.c_int.from_buffer(attrs, 8).value, ctypes.c_int.from_buffer(attrs, 12).value
        map_state = ctypes.c_int.from_buffer(attrs, 92).value  # XWindowAttributes.map_state, 2 = IsViewable
        if map_state == 2 and width * height > best:
            target, best = children[i], width * height
    if not target:
        return None
    x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    x11.XSetInputFocus(d, target, 1, 0)  # RevertToPointerRoot, CurrentTime
    x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

    def press(keysym):
        code = x11.XKeysymToKeycode(d, keysym)
        xtst.XTestFakeKeyEvent(d, code, 1, 0)
        xtst.XTestFakeKeyEvent(d, code, 0, 0)
        x11.XFlush(d)

    return press


def tab_walk(steps):
    """Presses Tab `steps` times and returns what had the focus after each press: [(role, name)]."""
    seen = []
    press = x_keys()
    if press is None:
        return [(None, "")] * steps
    time.sleep(0.4)
    for _ in range(steps):
        press(0xFF09)  # Tab
        time.sleep(0.35)
        app = find_app()
        node = focused_node(app) if app is not None else None
        seen.append((node.get_role_name(), node.get_name() or "") if node is not None else (None, ""))
    return seen


def run_scenario(name, timeout, tabs, keep=False):
    env = dict(os.environ, GTK_A11Y="atspi", GSK_RENDERER="cairo", HERDR_DESKTOP_TEST="1")
    env_sh = os.path.join(ROOT, ".scratch/sysroot/env.sh")
    cmd = f'nsh test .a11y/audit.test.tsx --target linux --filter "audit {name}"'
    if os.path.exists(env_sh):  # GTK dev files from the user-space sysroot when the system has none
        cmd = f". {env_sh} && exec {cmd}"
    else:
        cmd = f"exec {cmd}"
    env["PATH"] = os.path.expanduser("~/.local/bin") + os.pathsep + env["PATH"]
    child = subprocess.Popen(["sh", "-c", cmd], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    rows, stable, last, walked = None, 0, 0, []
    deadline = time.time() + timeout
    try:
        while time.time() < deadline and child.poll() is None:
            time.sleep(1.0)
            now = snapshot()
            if not now or len(now) < 8:
                continue
            # The window is ready when the tree stopped growing for two reads in a row.
            stable = stable + 1 if len(now) == last else 0
            last = len(now)
            rows = now
            if stable >= 2:
                walked = tab_walk(tabs) if tabs else []
                break
    finally:
        # Only the process group this script started.
        if keep:
            child.wait()
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
    return rows, walked


def check(rows, walked, tabs, name=""):
    problems = []
    allowed = dict(HOST_UNNAMED.get(name, {}))
    for depth, role, label, focusable, showing, group in rows:
        if role in NAMED and not label.strip() and showing:
            if role in ("text", "entry") and group:
                continue
            if allowed.get(role, 0) > 0:
                allowed[role] -= 1
                continue
            problems.append(f"{role} has no name")
    # nsh's buttons are Tab stops in GTK but carry no FOCUSABLE state (see the Tab-walk note below), so a showing push or
    # toggle button counts as a way in for the keyboard: a card made of buttons (the sign-in card) has no input.
    if not any(s and (f or role in ("button", "push button", "toggle button")) for _, role, _, f, s, _ in rows):
        problems.append("no focusable element")
    # nsh 0.4.0 on GTK reports no FOCUSED state for its own controls (only the menu bar's), so an empty Tab walk is
    # a host limit, not a finding: `--keep` photographs the window after the walk to see the focus ring move.
    reached = [w for w in walked if w[0] is not None]
    if reached:
        if len({w for w in reached}) < 2:
            problems.append("Tab never moved the focus (a keyboard trap)")
        for role, name in reached:
            if role in NAMED and not name.strip():
                problems.append(f"the focused {role} has no name")
    return problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--keep", action="store_true", help="let the app run to its end (its test takes a screenshot after the walk)")
    parser.add_argument("--tabs", type=int, default=0, help="Tab presses per screen over real X key events; reads the focus over AT-SPI, which nsh does not report (see the module docstring)")
    args = parser.parse_args()
    names = [n for n in scenarios() if not args.only or n in args.only.split(",")]
    outdir = os.path.join(ROOT, ".scratch/a11y")
    os.makedirs(outdir, exist_ok=True)
    failed = False
    for index, name in enumerate(names):
        # The first window of a cold machine (CI) also builds the Linux host and the bundle: it gets the time that takes.
        rows, walked = run_scenario(name, max(args.timeout, 300) if index == 0 else args.timeout, args.tabs, args.keep)
        if rows is None:
            print(f"FAIL {name}: the app never showed up on the AT-SPI bus")
            failed = True
            continue
        with open(os.path.join(outdir, f"{name}.txt"), "w", encoding="utf8") as f:
            for depth, role, label, focusable, showing, group in rows:
                flags = ("F" if focusable else "-") + ("S" if showing else "-")
                f.write(f"{'  ' * depth}{role} {label!r} [{flags}]\n")
            if walked:
                f.write("\nTab order (empty when the host does not report focus over AT-SPI):\n")
                for i, (role, label) in enumerate(walked, 1):
                    f.write(f"  {i:2}. {role} {label!r}\n")
        problems = check(rows, walked, args.tabs, name)
        print(f"{'FAIL' if problems else 'ok  '} {name}: {len(rows)} nodes" + ("".join(f"\n       {p}" for p in sorted(set(problems))) if problems else ""))
        if problems:
            failed = True
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
