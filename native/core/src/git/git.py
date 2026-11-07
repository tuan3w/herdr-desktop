"""herdr-desktop git helper, run on a remote machine as `python3 -c <this script> <command> <args>...`.

It exists so that the output of a big diff is cut ON the remote machine (a 20 MB patch never crosses the wire) and
so that a command is killed there when it has said enough or takes too long. Every word arrives as its own argument
of one ssh command: nothing here is parsed by a shell, and git is started with an argument list.

  run CWD CAP TIMEOUT [NAME=VALUE ...] -- GITARG...
        runs `git GITARG...` in CWD with the given environment on top of this one; stdin is fed to git. Answers one JSON
        line {"code": N, "len": L, "truncated": bool, "stderr": "<tail>"} and then the first L bytes (at most CAP) of
        git's standard output. Exit 0 whenever git ran, whatever its own status was.
  probe ROOT
        reads relative paths separated by NUL from stdin and answers a JSON list with, for each, [lines, binary, size]
        or null when it is not a readable file; lines is null for a file over 64 MB. A path that is absolute or climbs out of ROOT is an error.

A request that cannot be served prints {"error": <kind>, "message": <text>} and exits 3; kinds are nogit, notfound,
invalid, other.
"""
import json
import os
import subprocess
import sys
import threading

SNIFF = 8000
COUNT_CAP = 64 * 1024 * 1024
STDERR_KEEP = 2048


def fail(kind, message):
    sys.stdout.write(json.dumps({"error": kind, "message": message}) + "\n")
    sys.stdout.flush()
    sys.exit(3)


def expand(path):
    if path == "~" or path.startswith("~/"):
        path = os.path.expanduser(path)
    if not os.path.isabs(path) or "\0" in path:
        fail("invalid", "the folder must be an absolute path")
    return path


def run(argv):
    try:
        sep = argv.index("--")
    except ValueError:
        fail("invalid", "no git arguments")
    head, args = argv[:sep], argv[sep + 1:]
    if len(head) < 3 or not args:
        fail("invalid", "run needs a folder, a cap, a timeout and a command")
    cwd, cap, timeout = expand(head[0]), int(head[1]), float(head[2])
    env = dict(os.environ)
    for word in head[3:]:
        name, _, value = word.partition("=")
        env[name] = value
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF"):
        env.pop(name, None)
    if not os.path.isdir(cwd):
        fail("notfound", "%s is not a folder" % cwd)
    stdin = sys.stdin.buffer.read()
    try:
        proc = subprocess.Popen(
            ["git"] + args, cwd=cwd, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except FileNotFoundError:
        fail("nogit", "git is not installed")
    except OSError as e:
        fail("other", "cannot start git: %s" % (e.strerror or e))

    def feed():
        try:
            proc.stdin.write(stdin)
            proc.stdin.close()
        except OSError:
            pass

    errors = []

    def drain():
        data = proc.stderr.read()
        errors.append(data[-STDERR_KEEP:])

    timed_out = []

    def expire():
        timed_out.append(True)
        proc.kill()

    timer = threading.Timer(timeout, expire)
    timer.start()
    threading.Thread(target=feed, daemon=True).start()
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    out = proc.stdout.read(cap + 1)
    truncated = len(out) > cap
    if truncated:
        out = out[:cap]
        proc.kill()
    proc.wait()
    timer.cancel()
    reader.join(2)
    if timed_out and not truncated:
        fail("other", "git took longer than %d s" % int(timeout))
    stderr = errors[0].decode("utf-8", "replace") if errors else ""
    code = 0 if truncated else proc.returncode
    header = {"code": code, "len": len(out), "truncated": truncated, "stderr": stderr}
    sys.stdout.write(json.dumps(header) + "\n")
    sys.stdout.flush()
    sys.stdout.buffer.write(out)
    sys.stdout.buffer.flush()


def probe(argv):
    if len(argv) != 1:
        fail("invalid", "probe needs a folder")
    root = expand(argv[0])
    paths = [p for p in sys.stdin.buffer.read().split(b"\0") if p]
    answers = []
    for raw in paths:
        rel = raw.decode("utf-8", "surrogateescape")
        parts = rel.split("/")
        if rel.startswith("/") or ".." in parts:
            fail("invalid", "a file must be inside its checkout")
        path = os.path.join(root, rel)
        try:
            meta = os.lstat(path)
            if os.path.islink(path):
                answers.append([1, False, len(os.readlink(path))])
                continue
            if not os.path.isfile(path):
                answers.append(None)
                continue
            with open(path, "rb") as f:
                head = f.read(SNIFF)
                if b"\0" in head:
                    answers.append([0, True, meta.st_size])
                    continue
                if meta.st_size > COUNT_CAP:
                    answers.append([None, False, meta.st_size])
                    continue
                lines, last = head.count(b"\n"), head[-1:]
                while True:
                    chunk = f.read(1 << 16)
                    if not chunk:
                        break
                    lines += chunk.count(b"\n")
                    last = chunk[-1:]
        except OSError:
            answers.append(None)
            continue
        answers.append([lines + (1 if last and last != b"\n" else 0), False, meta.st_size])
    sys.stdout.write(json.dumps(answers) + "\n")


def main():
    if len(sys.argv) < 2:
        fail("invalid", "no command")
    command, rest = sys.argv[1], sys.argv[2:]
    if command == "run":
        run(rest)
    elif command == "probe":
        probe(rest)
    else:
        fail("invalid", "unknown command %s" % command)


main()
