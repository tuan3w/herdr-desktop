"""One herdr connection over stdin/stdout, for machines where relay.py cannot run.

Used last in the fallback chain (after `herdr remote-api-bridge` and `socat`): copies bytes between
this process's stdin/stdout and herdr's unix socket, whose path is argv[1]. One request per
connection, so the caller starts one of these per request.
"""
import os
import select
import socket
import sys

s = socket.socket(socket.AF_UNIX)
try:
    s.connect(sys.argv[1])
except OSError as e:
    sys.stderr.write("herdr-desktop: cannot connect to herdr at %s: %s\n" % (sys.argv[1], e))
    sys.exit(1)
i = sys.stdin.fileno()
o = sys.stdout.fileno()
live = True
while True:
    r, _, _ = select.select([s] + ([i] if live else []), [], [])
    if s in r:
        d = s.recv(65536)
        if not d:
            break
        while d:
            d = d[os.write(o, d):]
    if i in r:
        d = os.read(i, 65536)
        if not d:
            live = False
            s.shutdown(socket.SHUT_WR)
        else:
            s.sendall(d)
