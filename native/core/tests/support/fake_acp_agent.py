#!/usr/bin/env python3
"""A scripted ACP agent for the keeper tests (python 3, standard library).

Speaks JSON-RPC lines on stdio like the real adapters: `initialize`,
`session/new`, `session/prompt` (behaviour chosen by the prompt text),
`session/cancel`, and `session/load`, which it refuses ("unsupported while
live"). Exits on EOF like claude-agent-acp, codex-acp and pi-acp.

Every message it receives is appended to the file in $FAKE_ACP_LOG as one JSON
line `{"recv": {...}}`, so a test can count what reached the agent.

Prompt texts:
  plain         two message chunks, end_turn
  ask           title, a chunk, a permission (id 7001), then a question (id
                "elic-1"), then a chunk saying what was answered, end_turn
  perm:<title>  one permission whose tool title is <title>, then end_turn
  permdiff      a permission for an edit: `rawInput` {file_path, command}, a diff in the tool call's content and
                four options (allow once, allow always, reject once, reject always), then end_turn
  slow          a chunk, then waits for session/cancel and ends `cancelled`
  noise         garbage lines on stdout, then a chunk, end_turn
  die           a permission request, then exits with code 3 (stderr: boom)
  sleep:<s>     a chunk, then ends the turn after <s> seconds
  exit:<n>      exits with code <n> at once
  long:<n>      <n> chunks with distinct message ids, end_turn
  heavy:<tools>:<min KB>:<max KB>:<label>
                a thought, <tools> tool calls with <min>..<max> KB outputs (start,
                progress, finish; a big rawInput each; every fifth an edit with a
                diff), then `answer <label>`, end_turn. `heavyhold:` is the same
                without the answer: the turn stays open until session/cancel.
  big:<n>       a tool call update, then a chunk, each with <n> bytes of output, end_turn
  reply:<text>  one chunk "re: <text>" with its own message id, end_turn
  quiet         says nothing and waits for session/cancel, which ends the turn `cancelled`
  task:<id>     an `async_task_spawned` (shell, canStop) for <id>, a chunk, end_turn
  sdktask:<id>  Claude's raw `_claude/sdkMessage` `background_tasks_changed` naming <id>
                (a `local_bash`), a chunk, end_turn
  sdkend:<id>   `background_tasks_changed` with no tasks, end_turn
`_session/async_task/stop {asyncTaskId}` answers {stopped: true} and sends an
`async_task_state_update` `stopped` for a task spawned with `task:`, else {stopped: false}.
Busy guard (omp's `AgentBusyError`, `-32003 sessionBusy`): while the file named
by $FAKE_ACP_BUSY_FILE exists, the agent is busy with an autonomous turn of its
own: a prompt gets one chunk of that turn's output and then the error, and is
not taken (nothing of it is "said" afterwards). A file that says "quiet" makes
the agent refuse without that chunk.
Environment: FAKE_ACP_IGNORE_TERM=1 ignores SIGTERM; FAKE_ACP_FAIL_INIT=1
exits with code 5 before answering initialize; FAKE_ACP_INIT_DELAY=<s> waits
that long before answering initialize (a cold `npx -y`); FAKE_ACP_PID_FILE=<file>
gets a line `<pid>\t<cwd>` appended when it answers initialize.
The agent's own store (what survives the process, like omp's session folder):
FAKE_ACP_STORE=<json file> {"sessions": [{sessionId, cwd, title?, updatedAt?,
messageCount?, updates: [session/update payloads]}]}. With it set, initialize
advertises loadSession, sessionCapabilities.list and .resume (FAKE_ACP_CAPS=
list,load,resume narrows it to the listed ones), `session/list` answers from
the file (`cwd` filter, FAKE_ACP_PAGE sessions per page with a `nextCursor`;
FAKE_ACP_LIST_FAIL=1 answers an error, FAKE_ACP_LIST_DELAY=<s> waits first,
FAKE_ACP_LIST_NOISE=1 first sends a garbage line, a notification and a request
(`elicitation/create`, id noise-1) and waits for its answer), `session/load` of a stored id replays
its updates and answers `{}`, and `session/new` records the session (id: the
first free `sess-N`) with every update it sends, so a NEW agent process can
load it later. Without FAKE_ACP_STORE the agent is as before (no list/load).

herdr-desktop extensions (this copy is ours; herdr-mobile's stays as it is):
  The agent is capability-aware: what the client said in `initialize` (`clientCapabilities`) is
  appended to $FAKE_ACP_LOG as {"client_caps": {...}}, and it sends `notice` and `compaction_update`
  only to a client that asked (`session.notices`, `session.compaction`), as the spec requires.
  FAKE_ACP_EXTRA_CAPS=<json>  merged into `agentCapabilities` (e.g. {"promptCapabilities": {"audio": true}}).
  FAKE_ACP_OPTIONS=config     `session/new` answers `configOptions` too (a mode select, a model select, a
                              boolean `flag`, a `thought_level` select) and `session/set_config_option` works;
                              without it only the older `modes` shape is reported. `session/set_mode` always
                              works and answers with a `current_mode_update`.
  FAKE_ACP_AUTH=agent|terminal  `session/new` and `session/load` fail with -32000 (auth_required) until
                              `authenticate` names `login` (agent) ; `terminal` offers only a terminal method
                              that this agent never accepts: the person signs in elsewhere and a file named by
                              $FAKE_ACP_AUTH_FILE appears.
  Prompt texts:
  terminal:<n>   a terminal tool call (content `terminal`, output only in `_meta` deltas, `terminal_exit` 0)
                 printing the numbers 1..<n>, then a chunk `ok`
  termfail       the same with output `boom` and `terminal_exit` 2, status failed
  rawout         a `fetch` call with a name, locations, an object rawInput and its result only in rawOutput
                 ({stdout, stderr}), plus an image and a resource_link in its content
  blocks         one chunk `blocks:<type>[:<mime>],...` listing the content blocks of the prompt it got
  parts          an image, a resource_link, an embedded resource and a sound as message chunks, then `end`
  usage          a `usage_update` with a cost, a `session_info_update` with `updatedAt`, and `usage` in
                 the prompt's answer
  notice         a `notice` (only when the client said `session.notices`, else a chunk `no-notice-cap`)
  compact        a `compaction_update` running then completed (only when asked, else `no-compaction-cap`)
  cancelerr      waits for session/cancel and then answers the prompt with an ERROR, not `cancelled`
  fsask|termask  asks the client for `fs/read_text_file` / `terminal/create` and says the error code it got
                 back as a chunk `fs:<code>` / `terminal:<code>`
  plan           a `plan` of two steps; `commands` a command list with a hint; `mode:<id>` a mode change;
                 `config` a `config_option_update` that turns `flag` on
  FAKE_ACP_SEED=<json>        a list of past sessions (the `sessions` of FAKE_ACP_STORE) the agent starts with,
                              kept in $HOME/.fake-acp-store.json (written once): a test that cannot make a file
                              gets a store of its own, as the keeper's agent and `history` share $HOME.
"""
import json
import os
import signal
import sys
import time

LOG = os.environ.get("FAKE_ACP_LOG")
backlog = []
cancelled = False
replies = 0
spawned = set()
client_caps = {}
authed = False
# What the client's config choices left behind: option id -> current value.
state = {"mode": "default", "model": "fast", "flag": False, "thought_level": "low"}


def note(obj):
    if LOG:
        with open(LOG, "a") as f:
            f.write(json.dumps(obj) + "\n")


# The agent's own store (FAKE_ACP_STORE): what survives the agent process, like
# omp's ~/.omp/agent/sessions. A JSON file {"sessions": [{sessionId, cwd, title?,
# updatedAt?, messageCount?, updates: [session/update payloads]}]}.
STORE = os.environ.get("FAKE_ACP_STORE")
SEED = os.environ.get("FAKE_ACP_SEED")
if SEED and not STORE:
    STORE = os.path.join(os.environ.get("HOME") or ".", ".fake-acp-store.json")
    if not os.path.exists(STORE):
        with open(STORE, "w") as f:
            json.dump({"sessions": json.loads(SEED)}, f)
PAGE = int(os.environ.get("FAKE_ACP_PAGE") or 50)
PID_FILE = os.environ.get("FAKE_ACP_PID_FILE")


def store_read():
    try:
        with open(STORE) as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data.get("sessions"), list):
        data["sessions"] = []
    return data


def store_write(data):
    tmp = "%s.tmp%d" % (STORE, os.getpid())
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, STORE)


def store_find(data, sid):
    for s in data["sessions"]:
        if s.get("sessionId") == sid:
            return s
    return None


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_session_id(counter, cwd):
    """`sess-N` as always; with a store, the first N it does not hold yet, and
    the session is recorded there with the folder it was made for."""
    if not STORE:
        return "sess-%d" % counter
    data = store_read()
    n = 1
    while store_find(data, "sess-%d" % n):
        n += 1
    sid = "sess-%d" % n
    data["sessions"].append({
        "sessionId": sid, "cwd": cwd or os.getcwd(), "updatedAt": now_iso(),
        "messageCount": 0, "updates": [], "own": True,
    })
    store_write(data)
    return sid


def store_record(sid, upd):
    """Remembers an update of a session this agent made, in the store."""
    if not STORE:
        return
    data = store_read()
    s = store_find(data, sid)
    if s is None or not s.get("own"):
        return
    s.setdefault("updates", []).append(upd)
    s["updatedAt"] = now_iso()
    s["messageCount"] = sum(
        1 for u in s["updates"] if u.get("sessionUpdate") in ("user_message_chunk", "agent_message_chunk")
    )
    store_write(data)


def capabilities():
    caps = {"loadSession": False, "promptCapabilities": {"image": True}}
    if STORE:
        wanted = (os.environ.get("FAKE_ACP_CAPS") or "list,load,resume").split(",")
        caps["loadSession"] = "load" in wanted
        sc = {}
        if "list" in wanted:
            sc["list"] = {}
        if "resume" in wanted:
            sc["resume"] = {}
        if sc:
            caps["sessionCapabilities"] = sc
    extra = json.loads(os.environ.get("FAKE_ACP_EXTRA_CAPS") or "{}")
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(caps.get(key), dict):
            caps[key].update(value)
        else:
            caps[key] = value
    return caps


def auth_methods():
    mode = os.environ.get("FAKE_ACP_AUTH")
    if mode == "agent":
        return [{"id": "login", "name": "Log in", "description": "Use the stored login"}]
    if mode == "terminal":
        return [{"id": "term", "name": "Log in in a terminal", "type": "terminal", "args": ["--login"]}]
    return []


def auth_ok():
    """Whether `session/new` and `session/load` may proceed: no sign-in wanted, `authenticate` done, or
    (the terminal method) the file the person's terminal login would leave behind exists."""
    mode = os.environ.get("FAKE_ACP_AUTH")
    if not mode or authed:
        return True
    marker = os.environ.get("FAKE_ACP_AUTH_FILE")
    return bool(marker and os.path.exists(marker))


def config_options():
    return [
        {"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": state["mode"],
         "options": [{"value": "default", "name": "Default"}, {"value": "plan", "name": "Plan"}]},
        {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": state["model"],
         "options": [{"value": "fast", "name": "Fast"}, {"value": "deep", "name": "Deep"}]},
        {"id": "flag", "name": "Web search", "description": "Let the agent search the web", "type": "boolean",
         "currentValue": state["flag"]},
        {"id": "thought_level", "name": "Thinking", "category": "thought_level", "type": "select",
         "currentValue": state["thought_level"],
         "options": [{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}]},
    ]


def list_sessions(rid, params):
    """`session/list` from the store: the `cwd` filter, FAKE_ACP_PAGE per page,
    the cursor is the offset of the next page. FAKE_ACP_LIST_FAIL=1 answers an
    error; FAKE_ACP_LIST_DELAY=<s> waits first; FAKE_ACP_LIST_NOISE=1 first
    prints a garbage line, a notification and a request of its own
    (elicitation/create, id noise-1) and waits for the answer to that request."""
    time.sleep(float(os.environ.get("FAKE_ACP_LIST_DELAY") or 0))
    if os.environ.get("FAKE_ACP_LIST_NOISE"):
        sys.stdout.write("this is not json\n")
        sys.stdout.flush()
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "x", "update": {"sessionUpdate": "current_mode_update"}}})
        send({"jsonrpc": "2.0", "id": "noise-1", "method": "elicitation/create", "params": {"mode": "form", "message": "?"}})
        wait_response("noise-1")
    if os.environ.get("FAKE_ACP_LIST_FAIL"):
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "store unreadable"}})
        return
    rows = store_read()["sessions"] if STORE else []
    cwd = params.get("cwd")
    if cwd is not None:
        rows = [s for s in rows if s.get("cwd") == cwd]
    try:
        start = int(params.get("cursor") or 0)
    except ValueError:
        start = 0
    out = []
    for s in rows[start:start + PAGE]:
        row = {"sessionId": s.get("sessionId"), "cwd": s.get("cwd")}
        for k in ("title", "updatedAt"):
            if s.get(k) is not None:
                row[k] = s[k]
        if s.get("messageCount") is not None:
            row["_meta"] = {"messageCount": s["messageCount"], "size": 1}
        out.append(row)
    result = {"sessions": out}
    if start + PAGE < len(rows):
        result["nextCursor"] = str(start + PAGE)
    send({"jsonrpc": "2.0", "id": rid, "result": result})


def load_session(rid, params):
    """`session/load` of a session in the store: its updates are replayed, then
    the answer. Anything else is refused like a live session."""
    if STORE and "load" not in (os.environ.get("FAKE_ACP_CAPS") or "list,load,resume").split(","):
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "session/load is not supported"}})
        return
    s = store_find(store_read(), params.get("sessionId")) if STORE else None
    if s is None:
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "session/load is unsupported for a live session"}})
        return
    for upd in s.get("updates") or []:
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": s["sessionId"], "update": upd}})
    send({"jsonrpc": "2.0", "id": rid, "result": {}})


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read():
    global cancelled
    if backlog:
        return backlog.pop(0)
    while True:
        line = sys.stdin.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        note({"recv": msg})
        if msg.get("method") == "session/cancel":
            cancelled = True
        return msg


def wait_response(rid):
    """Reads until the answer to our request `rid`; other requests wait."""
    skipped = []
    try:
        while True:
            msg = read()
            if msg is None:
                sys.exit(0)
            if "method" not in msg and msg.get("id") == rid:
                return msg
            if msg.get("method") != "session/cancel":
                skipped.append(msg)
    finally:
        backlog[:0] = skipped


def update(sid, upd):
    store_record(sid, upd)
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": sid, "update": upd}})


def sdk_level(sid, tasks):
    send({"jsonrpc": "2.0", "method": "_claude/sdkMessage", "params": {"sessionId": sid, "message": {
        "type": "system", "subtype": "background_tasks_changed", "tasks": tasks, "uuid": "u", "session_id": sid}}})



def chunk(sid, text, mid=None):
    u = {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}
    if mid:
        u["messageId"] = mid
    update(sid, u)


def prompt_text(params):
    for b in params.get("prompt") or []:
        if isinstance(b, dict) and b.get("type") == "text":
            return b.get("text", "")
    return ""


def permission(sid, rid, title):
    send({
        "jsonrpc": "2.0", "id": rid, "method": "session/request_permission",
        "params": {
            "sessionId": sid,
            "toolCall": {"toolCallId": "tc-%s" % rid, "title": title, "kind": "execute", "status": "pending"},
            "options": [
                {"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
                {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
            ],
        },
    })
    return wait_response(rid)


def hold_until_cancel():
    global cancelled
    later = []
    while not cancelled:
        m = read()
        if m is None:
            sys.exit(0)
        if m.get("method") != "session/cancel":
            later.append(m)
    backlog[:0] = later


def heavy(sid, text):
    """heavy:<tools>:<min KB>:<max KB>:<label>: a thought, <tools> tool calls
    (start, progress, finish with 'output of min..max KB', half of them in
    `rawOutput`, half in `content`, each with a big `rawInput`, an edit now and
    then with a diff), then the answer `answer <label>`. `heavyhold:` is the
    same without the answer: the turn stays open until session/cancel."""
    _, tools, lo, hi, label = text.split(":")
    lo, hi = int(lo), int(hi)
    chunk_kind = {"sessionUpdate": "agent_thought_chunk", "messageId": "think-" + label}
    update(sid, dict(chunk_kind, content={"type": "text", "text": "thinking about turn " + label}))
    for i in range(int(tools)):
        tid = "t%s-%d" % (label, i)
        size = (lo + (i * 7919) % (hi - lo + 1)) * 1024
        output = "output of %s: " % tid + "x" * size
        edit = i % 5 == 4
        update(sid, {
            "sessionUpdate": "tool_call", "toolCallId": tid, "title": "Run: step %d of turn %s" % (i, label),
            "kind": "edit" if edit else "execute", "status": "pending",
            "rawInput": {"command": "step %d" % i, "script": "s" * 3000},
            "locations": [{"path": "/work/f%d.txt" % i, "line": 1}],
        })
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": tid, "status": "in_progress"})
        done = {"sessionUpdate": "tool_call_update", "toolCallId": tid, "status": "completed"}
        if i % 2:
            done["rawOutput"] = output
        else:
            done["content"] = [{"type": "content", "content": {"type": "text", "text": output}}]
        if edit:
            done["content"] = done.get("content", []) + [
                {"type": "diff", "path": "/work/f%d.txt" % i, "oldText": "a\n" * 500, "newText": "b\n" * 500},
            ]
        update(sid, done)
    if text.startswith("heavy:"):
        chunk(sid, "answer " + label, "answer-" + label)


def prompt(msg):
    global replies
    sid = msg["params"]["sessionId"]
    # What goes into the prompt's answer besides the stop reason, and an error in its place.
    extra = {}
    err = None
    busy = os.environ.get("FAKE_ACP_BUSY_FILE")
    if busy and os.path.exists(busy):
        with open(busy) as f:
            if f.read().strip() != "quiet":
                chunk(sid, "subagent progress", "own-turn")
        send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32003, "message": "Session is busy"}})
        return
    text = prompt_text(msg["params"])
    store_record(sid, {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": text}})
    stop = "end_turn"
    if text == "plain":
        chunk(sid, "Hel")
        chunk(sid, "lo")
    elif text == "ask":
        update(sid, {"sessionUpdate": "session_info_update", "title": "Fake title"})
        chunk(sid, "thinking")
        p = permission(sid, 7001, "Run: ls -la")
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "tc-7001", "status": "completed"})
        send({
            "jsonrpc": "2.0", "id": "elic-1", "method": "elicitation/create",
            "params": {
                "sessionId": sid, "mode": "form", "message": "Pick one?\nsecond line",
                "requestedSchema": {"type": "object", "properties": {"value": {"type": "string", "enum": ["a", "b"]}}},
            },
        })
        e = wait_response("elic-1")
        chunk(sid, "answered:%s/%s" % (
            (p.get("result") or {}).get("outcome", {}).get("optionId"),
            (e.get("result") or {}).get("action"),
        ))
    elif text.startswith("perm:"):
        permission(sid, 7002, text[5:])
    elif text == "permdiff":
        send({
            "jsonrpc": "2.0", "id": 7004, "method": "session/request_permission",
            "params": {
                "sessionId": sid,
                "toolCall": {
                    "toolCallId": "tc-7004", "title": "Edit config.toml", "kind": "edit", "status": "pending",
                    "rawInput": {"file_path": "/work/config.toml", "command": "sed -i s/a/b/ /work/config.toml"},
                    "content": [{"type": "diff", "path": "/work/config.toml", "oldText": "a = 1\n", "newText": "a = 2\n"}],
                },
                "options": [
                    {"optionId": "allow", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "always", "name": "Always allow edits", "kind": "allow_always"},
                    {"optionId": "reject", "name": "Reject", "kind": "reject_once"},
                    {"optionId": "never", "name": "Never allow edits", "kind": "reject_always"},
                ],
            },
        })
        wait_response(7004)
    elif text == "slow":
        chunk(sid, "working")
        hold_until_cancel()
        stop = "cancelled"
    elif text == "noise":
        sys.stdout.write("this is not json\n[1,2,3]\n\n")
        sys.stdout.flush()
        chunk(sid, "after noise")
    elif text == "die":
        send({
            "jsonrpc": "2.0", "id": 7003, "method": "session/request_permission",
            "params": {"sessionId": sid, "toolCall": {"toolCallId": "tc-7003", "title": "Doomed"}, "options": []},
        })
        sys.stderr.write("boom\n")
        sys.stderr.flush()
        os._exit(3)
    elif text.startswith("sleep:"):
        chunk(sid, "sleeping")
        time.sleep(float(text[6:]))
    elif text.startswith("exit:"):
        os._exit(int(text[5:]))
    elif text.startswith("terminal:") or text == "termfail":
        fail = text == "termfail"
        n = 3 if fail else int(text[9:])
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "term-1", "title": "Run: seq %d" % n, "kind": "execute",
                     "status": "pending", "rawInput": {"command": "seq %d" % n},
                     "content": [{"type": "terminal", "terminalId": "term-1"}],
                     "_meta": {"terminal_info": {"terminal_id": "term-1", "cwd": "/work"}}})
        data = ["boom\n"] if fail else ["%d\n" % i for i in range(1, n + 1)]
        for piece in data:
            update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "term-1", "status": "in_progress",
                         "_meta": {"terminal_output_delta": {"terminal_id": "term-1", "data": piece}}})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "term-1",
                     "status": "failed" if fail else "completed",
                     "_meta": {"terminal_exit": {"terminal_id": "term-1", "exit_code": 2 if fail else 0, "signal": None}}})
        chunk(sid, "ok")
    elif text == "rawout":
        update(sid, {"sessionUpdate": "tool_call", "toolCallId": "raw-1", "title": "Fetch page", "name": "WebFetch",
                     "kind": "fetch", "status": "in_progress", "rawInput": {"url": "https://example.com", "n": 2},
                     "locations": [{"path": "/work/page.html", "line": 7}]})
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "raw-1", "status": "completed",
                     "rawOutput": {"stdout": "first", "stderr": "second"},
                     "content": [{"type": "content", "content": {"type": "image", "mimeType": "image/png", "data": "QUJD"}},
                                 {"type": "content", "content": {"type": "resource_link", "name": "page.html", "uri": "file:///work/page.html"}}]})
    elif text == "blocks":
        seen = []
        for b in msg["params"].get("prompt") or []:
            seen.append(b.get("type", "?") + (":" + b["mimeType"] if b.get("mimeType") else ""))
        chunk(sid, "blocks:" + ",".join(seen))
    elif text == "parts":
        update(sid, {"sessionUpdate": "agent_message_chunk", "messageId": "p1",
                     "content": {"type": "image", "mimeType": "image/png", "data": "QUJD"}})
        update(sid, {"sessionUpdate": "agent_message_chunk", "messageId": "p1",
                     "content": {"type": "resource_link", "name": "notes.md", "uri": "file:///work/notes.md", "mimeType": "text/markdown", "size": 12}})
        update(sid, {"sessionUpdate": "agent_message_chunk", "messageId": "p1",
                     "content": {"type": "resource", "resource": {"uri": "file:///work/a.txt", "mimeType": "text/plain", "text": "hi"}}})
        update(sid, {"sessionUpdate": "agent_message_chunk", "messageId": "p1",
                     "content": {"type": "audio", "mimeType": "audio/wav", "data": "QUJDRA=="}})
        chunk(sid, "end", "p2")
    elif text == "usage":
        update(sid, {"sessionUpdate": "usage_update", "used": 25000, "size": 100000, "cost": {"amount": 0.5, "currency": "USD"}})
        update(sid, {"sessionUpdate": "session_info_update", "title": "Usage title", "updatedAt": "2026-01-01T00:00:00Z"})
        chunk(sid, "counted")
        extra["usage"] = {"inputTokens": 120, "outputTokens": 30, "totalTokens": 150, "cachedReadTokens": 100}
    elif text == "notice":
        if (client_caps.get("session") or {}).get("notices") is not None:
            update(sid, {"sessionUpdate": "notice", "severity": "warning", "title": "MCP server unavailable",
                         "description": "Continuing without it."})
        else:
            chunk(sid, "no-notice-cap")
    elif text == "compact":
        if (client_caps.get("session") or {}).get("compaction") is not None:
            update(sid, {"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "running"})
            update(sid, {"sessionUpdate": "compaction_update", "compactionId": "c1", "status": "completed", "summary": "shorter"})
        else:
            chunk(sid, "no-compaction-cap")
    elif text == "cancelerr":
        chunk(sid, "working")
        hold_until_cancel()
        err = {"code": -32603, "message": "aborted by the client"}
    elif text in ("fsask", "termask"):
        method = "fs/read_text_file" if text == "fsask" else "terminal/create"
        params = {"sessionId": sid, "path": "/etc/hostname"} if text == "fsask" else {"sessionId": sid, "command": "ls"}
        send({"jsonrpc": "2.0", "id": "ask-1", "method": method, "params": params})
        answer = wait_response("ask-1")
        chunk(sid, "%s:%s" % ("fs" if text == "fsask" else "terminal", (answer.get("error") or {}).get("code")))
    elif text == "plan":
        update(sid, {"sessionUpdate": "plan", "entries": [
            {"content": "Read the code", "priority": "high", "status": "completed"},
            {"content": "Write the fix", "priority": "medium", "status": "in_progress"}]})
    elif text == "commands":
        update(sid, {"sessionUpdate": "available_commands_update", "availableCommands": [
            {"name": "review", "description": "Review a change", "input": {"hint": "a branch"}},
            {"name": "compact", "description": "Shrink the context"}]})
    elif text.startswith("mode:"):
        state["mode"] = text[5:]
        update(sid, {"sessionUpdate": "current_mode_update", "currentModeId": text[5:]})
    elif text == "config":
        state["flag"] = True
        update(sid, {"sessionUpdate": "config_option_update", "configOptions": config_options()})
    elif text.startswith("big:"):
        n = int(text[4:])
        update(sid, {"sessionUpdate": "tool_call_update", "toolCallId": "big-1", "status": "completed", "title": "Big output",
                     "content": [{"type": "content", "content": {"type": "text", "text": "y" * n}}]})
        chunk(sid, "z" * n, "mbig")
        chunk(sid, "tail", "mtail")
    elif text == "quiet":
        hold_until_cancel()
        stop = "cancelled"
    elif text.startswith("picture:"):
        # picture:<chars>: the agent shows a picture of that many base64 characters.
        n = int(text[8:])
        update(sid, {"sessionUpdate": "agent_message_chunk", "messageId": "pic-1",
                     "content": {"type": "image", "mimeType": "image/png", "data": ("QUJD" * (n // 4 + 1))[:n]}})
        chunk(sid, "that was the picture", "after-pic")
    elif text.startswith("reply:"):
        replies += 1
        chunk(sid, "re: " + text[6:], "reply-%d" % replies)
    elif text.startswith("task:"):
        tid = text[5:]
        spawned.add(tid)
        update(sid, {"sessionUpdate": "async_task_spawned", "asyncTaskId": tid, "name": "sleep 600", "taskType": "shell",
                     "description": "sleep 600", "showInTranscript": False, "canStop": True, "toolCallId": "tc-" + tid})
        chunk(sid, "started " + tid)
    elif text.startswith("sdktask:"):
        sdk_level(sid, [{"task_id": text[8:], "task_type": "local_bash", "description": "sleep 600"}])
        chunk(sid, "started " + text[8:])
    elif text.startswith("sdkend:"):
        sdk_level(sid, [])
    elif text.startswith("long:"):
        for i in range(int(text[5:])):
            chunk(sid, "line %d " % i, "m%d" % i)
    elif text.startswith("heavy:") or text.startswith("heavyhold:"):
        heavy(sid, text)
        if text.startswith("heavyhold:"):
            hold_until_cancel()
            stop = "cancelled"
    if err is not None:
        send({"jsonrpc": "2.0", "id": msg["id"], "error": err})
        return
    send({"jsonrpc": "2.0", "id": msg["id"], "result": dict({"stopReason": stop}, **extra)})


def main():
    global cancelled, client_caps, authed
    if os.environ.get("FAKE_ACP_IGNORE_TERM"):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    sessions = 0
    sys.stderr.write("fake agent up\n")
    sys.stderr.flush()
    while True:
        msg = read()
        if msg is None:
            return
        method = msg.get("method")
        if "id" not in msg or method is None:
            continue
        rid = msg["id"]
        if method == "initialize":
            if PID_FILE:
                with open(PID_FILE, "a") as f:
                    f.write("%d\t%s\n" % (os.getpid(), os.getcwd()))
            if os.environ.get("FAKE_ACP_FAIL_INIT"):
                sys.stderr.write("cannot start: no login\n")
                sys.stderr.flush()
                sys.exit(5)
            time.sleep(float(os.environ.get("FAKE_ACP_INIT_DELAY") or 0))
            client_caps = (msg.get("params") or {}).get("clientCapabilities") or {}
            note({"client_caps": client_caps})
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": 1,
                "agentInfo": {"name": "fake-acp", "title": "Fake ACP", "version": "1"},
                "agentCapabilities": capabilities(),
                "authMethods": auth_methods(),
            }})
        elif method == "authenticate":
            known = [m["id"] for m in auth_methods()]
            if (msg.get("params") or {}).get("methodId") in known and os.environ.get("FAKE_ACP_AUTH") == "agent":
                authed = True
                send({"jsonrpc": "2.0", "id": rid, "result": {}})
            else:
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": "unknown or unsupported auth method"}})
        elif method == "session/new":
            if not auth_ok():
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "Authentication required"}})
                continue
            sessions += 1
            sid = new_session_id(sessions, (msg.get("params") or {}).get("cwd"))
            result = {
                "sessionId": sid,
                "modes": {"currentModeId": state["mode"], "availableModes": [{"id": "default", "name": "Default"}, {"id": "plan", "name": "Plan"}]},
            }
            if os.environ.get("FAKE_ACP_OPTIONS") == "config":
                result["configOptions"] = config_options()
            send({"jsonrpc": "2.0", "id": rid, "result": result})
        elif method == "session/set_mode":
            state["mode"] = (msg.get("params") or {}).get("modeId")
            send({"jsonrpc": "2.0", "id": rid, "result": {}})
            update((msg.get("params") or {}).get("sessionId"), {"sessionUpdate": "current_mode_update", "currentModeId": state["mode"]})
        elif method == "session/set_config_option":
            p = msg.get("params") or {}
            if os.environ.get("FAKE_ACP_OPTIONS") != "config" or p.get("configId") not in state:
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32602, "message": "no such option"}})
            else:
                state[p["configId"]] = p.get("value")
                send({"jsonrpc": "2.0", "id": rid, "result": {"configOptions": config_options()}})
        elif method == "session/load":
            if not auth_ok():
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "Authentication required"}})
                continue
            load_session(rid, msg.get("params") or {})
        elif method == "session/resume":
            # Opens an old session without replaying it.
            s = store_find(store_read(), (msg.get("params") or {}).get("sessionId")) if STORE else None
            if s is None:
                send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32002, "message": "session not found"}})
            else:
                send({"jsonrpc": "2.0", "id": rid, "result": {}})
        elif method == "session/close":
            send({"jsonrpc": "2.0", "id": rid, "result": {}})
        elif method == "session/prompt":
            cancelled = False
            prompt(msg)
        elif method == "session/list":
            list_sessions(rid, msg.get("params") or {})
        elif method == "_session/async_task/stop":
            tid = (msg.get("params") or {}).get("asyncTaskId")
            stopped = tid in spawned
            if stopped:
                spawned.discard(tid)
                update(msg["params"]["sessionId"], {"sessionUpdate": "async_task_state_update", "asyncTaskId": tid, "state": "stopped"})
            send({"jsonrpc": "2.0", "id": rid, "result": {"stopped": stopped}})
        else:
            send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "unknown method " + method}})


main()
