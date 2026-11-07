"""herdr-desktop file helper, run on a remote machine as `python3 -c <this script> <command> <args>...`.

Every answer is JSON on stdout. A command that cannot do what it was asked prints
`{"error": <kind>, "message": <text>}` and exits 3; kinds are notfound, denied, notdir, isdir, exists,
invalid, other. Exit 0 is success. The caller (ssh, which joins nothing into shell syntax) passes every
word as its own argument, so a path is never parsed by a shell.

  ls DIR                       entries of a folder (at most 5000)
  stat PATH                    kind, size, modified, readable
  read PATH START LEN          one JSON header line, then the LEN bytes it says it read
  put PATH OFFSET              append stdin to the upload part file next to PATH (OFFSET 0 starts it)
  commit PATH REPLACE          move the part file to PATH; REPLACE is 1 to overwrite, else it must not exist
  discard PATH                 remove the part file
"""
import errno
import json
import os
import stat as st
import sys

LIST_MAX = 5000
READ_MAX = 8 * 1024 * 1024


def fail(kind, message):
    sys.stdout.write(json.dumps({"error": kind, "message": message}) + "\n")
    sys.stdout.flush()
    sys.exit(3)


def oserror(e, path):
    code = e.errno
    if code == errno.ENOENT:
        fail("notfound", "%s does not exist" % path)
    if code in (errno.EACCES, errno.EPERM):
        fail("denied", "no permission for %s" % path)
    if code == errno.ENOTDIR:
        fail("notdir", "%s is not a folder" % path)
    if code == errno.EISDIR:
        fail("isdir", "%s is a folder" % path)
    if code == errno.EEXIST:
        fail("exists", "%s already exists" % path)
    fail("other", "%s: %s" % (path, e.strerror or str(e)))


def resolve(path):
    # Only a leading ~ is the home folder; the caller has already checked the path is absolute or ~/.
    if path == "~" or path.startswith("~/"):
        path = os.path.expanduser(path)
    if not os.path.isabs(path) or "\0" in path:
        fail("invalid", "the path must be absolute")
    return path


def kind_of(mode):
    if st.S_ISDIR(mode):
        return "d"
    if st.S_ISREG(mode):
        return "f"
    return "o"


def readable(path, mode):
    return os.access(path, os.R_OK | (os.X_OK if st.S_ISDIR(mode) else 0))


def part_of(path):
    folder, name = os.path.split(path)
    return os.path.join(folder, "." + name + ".herdr-part")


def ls(path):
    folder = os.fsencode(resolve(path))
    entries = []
    skipped = 0
    truncated = False
    try:
        scan = os.scandir(folder)
    except OSError as e:
        oserror(e, path)
    with scan:
        for entry in scan:
            if len(entries) >= LIST_MAX:
                truncated = True
                break
            try:
                name = entry.name.decode("utf-8")
            except UnicodeDecodeError:
                # A name that is not text cannot be shown or opened by name again.
                skipped += 1
                continue
            try:
                lst = entry.stat(follow_symlinks=False)
            except OSError:
                entries.append({"n": name, "k": "o", "s": 0, "m": None, "r": False, "l": False})
                continue
            link = st.S_ISLNK(lst.st_mode)
            real = lst
            if link:
                try:
                    real = entry.stat()
                except OSError:
                    real = None
            if real is None:
                entries.append({"n": name, "k": "o", "s": 0, "m": int(lst.st_mtime), "r": False, "l": True})
                continue
            entries.append(
                {
                    "n": name,
                    "k": kind_of(real.st_mode),
                    "s": real.st_size if st.S_ISREG(real.st_mode) else 0,
                    "m": int(real.st_mtime),
                    "r": readable(entry.path, real.st_mode),
                    "l": link,
                }
            )
    out = {"path": os.fsdecode(folder), "entries": entries, "skipped": skipped, "truncated": truncated}
    sys.stdout.write(json.dumps(out) + "\n")


def stat(path):
    real = resolve(path)
    try:
        info = os.stat(real)
    except OSError as e:
        oserror(e, path)
    out = {
        "k": kind_of(info.st_mode),
        "s": info.st_size if st.S_ISREG(info.st_mode) else 0,
        "m": int(info.st_mtime),
        "r": readable(real, info.st_mode),
    }
    sys.stdout.write(json.dumps(out) + "\n")


def read(path, start, length):
    real = resolve(path)
    length = max(0, min(length, READ_MAX))
    try:
        fd = os.open(real, os.O_RDONLY)
    except OSError as e:
        oserror(e, path)
    try:
        info = os.fstat(fd)
        if st.S_ISDIR(info.st_mode):
            fail("isdir", "%s is a folder" % path)
        os.lseek(fd, start, os.SEEK_SET)
        chunks = []
        left = length
        while left > 0:
            data = os.read(fd, left)
            if not data:
                break
            chunks.append(data)
            left -= len(data)
    except OSError as e:
        oserror(e, path)
    finally:
        os.close(fd)
    body = b"".join(chunks)
    header = {"size": info.st_size, "m": int(info.st_mtime), "len": len(body)}
    out = sys.stdout.buffer
    out.write((json.dumps(header) + "\n").encode("ascii"))
    out.write(body)
    out.flush()


def put(path, offset):
    real = resolve(path)
    part = part_of(real)
    flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    if offset == 0:
        flags |= os.O_TRUNC
    try:
        fd = os.open(part, flags, 0o666)
    except OSError as e:
        oserror(e, os.path.dirname(real))
    try:
        # A chunk that does not continue where the last one ended means a lost or repeated chunk: stop
        # rather than assemble a corrupt file.
        if os.fstat(fd).st_size != offset:
            fail("other", "the upload is out of order")
        os.lseek(fd, 0, os.SEEK_END)
        data = sys.stdin.buffer.read()
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
    except OSError as e:
        oserror(e, os.path.dirname(real))
    finally:
        os.close(fd)
    sys.stdout.write(json.dumps({"size": offset + len(data)}) + "\n")


def commit(path, replace):
    real = resolve(path)
    part = part_of(real)
    try:
        if replace:
            os.replace(part, real)
        else:
            try:
                # link fails when the name exists, atomically: no window between the check and the move.
                os.link(part, real)
            except OSError as e:
                if e.errno == errno.EEXIST:
                    raise
                # A file system without hard links: check, then rename (a small window remains there).
                if os.path.lexists(real):
                    fail("exists", "%s already exists" % path)
                os.rename(part, real)
                part = None
            if part:
                os.unlink(part)
    except OSError as e:
        oserror(e, path)
    sys.stdout.write(json.dumps({"ok": True}) + "\n")


def discard(path):
    try:
        os.unlink(part_of(resolve(path)))
    except OSError as e:
        if e.errno != errno.ENOENT:
            oserror(e, path)
    sys.stdout.write(json.dumps({"ok": True}) + "\n")


def number(text):
    try:
        value = int(text)
    except ValueError:
        fail("invalid", "%r is not a number" % text)
    if value < 0:
        fail("invalid", "%r is negative" % text)
    return value


def main(argv):
    if not argv:
        fail("invalid", "no command")
    command, args = argv[0], argv[1:]
    table = {
        "ls": (1, lambda a: ls(a[0])),
        "stat": (1, lambda a: stat(a[0])),
        "read": (3, lambda a: read(a[0], number(a[1]), number(a[2]))),
        "put": (2, lambda a: put(a[0], number(a[1]))),
        "commit": (2, lambda a: commit(a[0], a[1] == "1")),
        "discard": (1, lambda a: discard(a[0])),
    }
    entry = table.get(command)
    if entry is None or len(args) != entry[0]:
        fail("invalid", "bad command %r" % command)
    entry[1](args)


main(sys.argv[1:])
