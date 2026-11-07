#!/usr/bin/env python3
"""A stand-in for the desktop's notification service, for `tests/notify_dbus.rs`.

Owns `org.freedesktop.Notifications` on the session bus it is started under, prints one JSON line per call
it receives (`ready` once it owns the name), and takes commands on stdin: `action <id> <key>` emits
`ActionInvoked`, `dismiss <id>` emits `NotificationClosed` with reason 2 (dismissed by the person).
The one argument is the capabilities to advertise, comma separated (`actions,body-markup`).
"""
import json
import sys
import threading
import warnings

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

# PyGObject deprecates register_object in favour of an API that needs a newer GLib; the old one works.
warnings.filterwarnings("ignore", category=DeprecationWarning)

INTERFACE = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"
XML = """
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg type="as" direction="out"/></method>
    <method name="Notify">
      <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
      <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
      <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
    </method>
    <method name="CloseNotification"><arg type="u" direction="in"/></method>
    <method name="GetServerInformation">
      <arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/>
    </method>
    <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
    <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
  </interface>
</node>
"""

capabilities = [c for c in (sys.argv[1] if len(sys.argv) > 1 else "").split(",") if c]
connection = None
next_id = 0


def say(**fields):
    sys.stdout.write(json.dumps(fields) + "\n")
    sys.stdout.flush()


def emit(name, signature, *args):
    connection.emit_signal(None, PATH, INTERFACE, name, GLib.Variant(signature, args))
    return False


def on_call(conn, sender, path, interface, method, params, invocation):
    global next_id
    if method == "GetCapabilities":
        invocation.return_value(GLib.Variant("(as)", (capabilities,)))
    elif method == "Notify":
        app, replaces, icon, summary, body, actions, hints, timeout = params.unpack()
        if replaces:
            ident = replaces
        else:
            next_id += 1
            ident = next_id
        say(call="Notify", id=ident, replaces=replaces, app=app, icon=icon, summary=summary, body=body,
            actions=list(actions), hints={k: v for k, v in hints.items()}, timeout=timeout)
        invocation.return_value(GLib.Variant("(u)", (ident,)))
    elif method == "CloseNotification":
        (ident,) = params.unpack()
        say(call="Close", id=ident)
        invocation.return_value(None)
        GLib.idle_add(emit, "NotificationClosed", "(uu)", ident, 3)
    elif method == "GetServerInformation":
        invocation.return_value(GLib.Variant("(ssss)", ("mock", "herdr-desktop-tests", "1", "1.2")))


def on_bus(conn, name):
    global connection
    connection = conn
    node = Gio.DBusNodeInfo.new_for_xml(XML)
    conn.register_object(PATH, node.interfaces[0], on_call, None, None)


def on_name(conn, name):
    say(call="ready")


def read_commands():
    for line in sys.stdin:
        parts = line.split()
        if parts[:1] == ["action"] and len(parts) == 3:
            GLib.idle_add(emit, "ActionInvoked", "(us)", int(parts[1]), parts[2])
        elif parts[:1] == ["dismiss"] and len(parts) == 2:
            GLib.idle_add(emit, "NotificationClosed", "(uu)", int(parts[1]), 2)
    GLib.idle_add(loop.quit)


loop = GLib.MainLoop()
Gio.bus_own_name(Gio.BusType.SESSION, INTERFACE, Gio.BusNameOwnerFlags.NONE, on_bus, on_name, None)
threading.Thread(target=read_commands, daemon=True).start()
loop.run()
