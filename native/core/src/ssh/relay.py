"""herdr-desktop relay: many requests, one process, over ssh's stdin/stdout.

herdr's socket takes ONE request per connection, so a client that pipelines requests over a single
ssh channel needs this go-between. It runs on the machine that runs herdr:

    python3 -c <this script> /path/to/herdr.sock

Protocol, one JSON object per line on stdin; answers on stdout, possibly out of order (the caller
matches them by `id`). The first line out is `herdr-desktop-relay-v1`. An answer longer than 512
bytes is written as `Z<n>`, a newline and exactly n bytes of zlib data holding the JSON (no newline
after them); a shorter one is a plain line. A request whose method is `events.subscribe` keeps its
connection open: herdr's acknowledgement, then every event line, framed the same way, until herdr
hangs up (the relay then exits so the caller notices). Exit 78 means "cannot serve" (no herdr socket
at that path) so the caller can try another bridge; 64 is a usage error.
"""
import json
import os
import socket
import stat
import sys
import threading
import zlib

READY = b"herdr-desktop-relay-v1"
COMPRESS_MIN = 512
CONNECT_TIMEOUT = 30

out_lock = threading.Lock()


def emit(payload):
    if len(payload) > COMPRESS_MIN:
        z = zlib.compress(payload, 6)
        frame = b"Z%d\n" % len(z) + z
    else:
        frame = payload + b"\n"
    try:
        with out_lock:
            sys.stdout.buffer.write(frame)
            sys.stdout.buffer.flush()
    except OSError:
        os._exit(1)


def fail(req_id, message):
    emit(json.dumps({"id": req_id, "error": {"code": "bridge_error", "message": message}}).encode())


def with_id(answer, req_id):
    # herdr cannot correlate a request it fails to parse (an unknown method) and answers with id "":
    # give it the id the request had, or the caller would wait for a reply that is never matched.
    if req_id is not None and answer.startswith(b'{"id":"",'):
        return json.dumps(dict(json.loads(answer), id=req_id)).encode()
    return answer


def serve(line, req, path, streaming):
    req_id = req.get("id") if isinstance(req, dict) else None
    code = 0
    try:
        s = socket.socket(socket.AF_UNIX)
        try:
            s.settimeout(CONNECT_TIMEOUT)
            s.connect(path)
            s.sendall(line + b"\n")
            f = s.makefile("rb")
            first = f.readline()
            if not first:
                fail(req_id, "herdr closed the connection without answering")
                code = 1
            else:
                emit(with_id(first.rstrip(b"\n"), req_id))
                if streaming:
                    s.settimeout(None)
                    for event in f:
                        emit(event.rstrip(b"\n"))
        finally:
            s.close()
    except Exception as e:
        fail(req_id, str(e) or e.__class__.__name__)
        code = 1
    if streaming:
        os._exit(code)


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: relay.py SOCKET\n")
        return 64
    path = sys.argv[1]
    try:
        is_socket = stat.S_ISSOCK(os.stat(path).st_mode)
    except OSError:
        is_socket = False
    if not is_socket:
        sys.stderr.write("herdr-desktop: no herdr socket at %s\n" % path)
        return 78
    emit(READY)
    workers = []
    for raw in iter(sys.stdin.buffer.readline, b""):
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            fail(None, "request is not JSON")
            continue
        streaming = isinstance(req, dict) and req.get("method") == "events.subscribe"
        worker = threading.Thread(target=serve, args=(line, req, path, streaming), daemon=True)
        worker.start()
        if not streaming:
            workers.append(worker)
    # stdin closed: let the requests already sent finish, then stop (streams are daemons).
    for worker in workers:
        worker.join()
    return 0


code = main()
sys.stdout.flush()
os._exit(code)
