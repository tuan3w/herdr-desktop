#!/usr/bin/env python3
"""Synthetic data for the README's screenshots (`scripts/readme-shots/build.sh` runs it). Nothing here is read from a
real pane, a real `~/.claude` or a real project: every repository, log line and file below is made up.

  gen.py setup OUT        the scripted herdr (OUT/fixtures/showcase.json, a copy of fixtures/herdr/showcase.json whose
                          folders are git repositories under OUT/root, made here) and the agents' code changes
  gen.py logs OUT HOME    the Claude Code session logs of the showcase's agents, under HOME/.claude/projects, with times
                          counted back from now

Why two steps: the app under the test seam reads a log only through its keeper, whose home is
`<data dir>/session-home`, and the keeper follows only a file under that home. The data directory is made when the app
starts (`$TMPDIR/herdr-desktop-<pid>-<n>`), so the fixture names each log through OUT/home, a link build.sh points at
that home once it exists, and the logs are written into it then (so their times are counted from the run, not from
an earlier build).
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SHOWCASE = os.path.join(REPO, "fixtures", "herdr", "showcase.json")
FAKE_HOME = "/home/dev"


def claude_folder(cwd):
    """The folder Claude keeps a working directory's sessions in (`project_folder` in observed/locate.rs)."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


# ---- the code the agents changed ------------------------------------------------------------------------------------
# Each changed file: its committed text and the edits (old, new) the agent made, in order; applying them gives the
# working tree's text. The same edits are the agent's `Edit` calls in its log, so the chat and the Changes review agree.

PAYMENTS_CREATE = """import { db } from "../db";
import type { Refund, RefundRequest } from "./types";

export async function createRefund(req: RefundRequest): Promise<Refund> {
  const payment = await db.payments.get(req.paymentId);
  if (!payment) throw new Error("no such payment");
  return db.refunds.insert({ paymentId: payment.id, amount: req.amount });
}
"""
PAYMENTS_CREATE_EDITS = [
    (
        "export async function createRefund(req: RefundRequest): Promise<Refund> {\n",
        "export async function createRefund(req: RefundRequest, key: string): Promise<Refund> {\n"
        "  const earlier = await db.refunds.byKey(key);\n"
        "  if (earlier) return earlier;\n",
    ),
    (
        "  return db.refunds.insert({ paymentId: payment.id, amount: req.amount });\n",
        "  return db.refunds.insert({ paymentId: payment.id, amount: req.amount, idempotencyKey: key });\n",
    ),
]
PAYMENTS_ROUTES = """import { router } from "../http";
import { createRefund } from "./create";

router.post("/refunds", async (req, res) => {
  const refund = await createRefund(req.body);
  res.status(201).json(refund);
});
"""
PAYMENTS_ROUTES_EDITS = [
    (
        "  const refund = await createRefund(req.body);\n",
        '  const key = req.header("Idempotency-Key");\n'
        '  if (!key) return res.status(400).json({ error: "Idempotency-Key is required" });\n'
        "  const refund = await createRefund(req.body, key);\n",
    ),
]
PAYMENTS_TEST = """import { describe, expect, it } from "vitest";

import { post } from "./http";

describe("POST /refunds", () => {
  it("refunds a payment", async () => {
    expect((await post("/refunds", { paymentId: "pay_1", amount: 500 })).status).toBe(201);
  });
});
"""
PAYMENTS_TEST_EDITS = [
    (
        "});\n});\n",
        "});\n\n"
        '  it("answers a repeat with the first refund", async () => {\n'
        '    const body = { paymentId: "pay_1", amount: 500 };\n'
        '    const first = await post("/refunds", body, { "Idempotency-Key": "k1" });\n'
        '    const again = await post("/refunds", body, { "Idempotency-Key": "k1" });\n'
        "    expect(again.body.id).toBe(first.body.id);\n"
        "  });\n"
        "});\n",
    ),
]
PAYMENTS_MIGRATION = """-- One refund per idempotency key: a client that retries gets the first refund back.
ALTER TABLE refunds ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX refunds_idempotency_key ON refunds (idempotency_key);
"""

LOGIN_FORM = """import { navigate } from "../router";
import { DEFAULT_PATH } from "./redirect";
import { session } from "./session";

/** Called once the password or the passkey was accepted. */
export async function onSignedIn(params: URLSearchParams) {
  await session.refresh();
  const user = session.current();
  if (!user) return navigate("/sign-in");
  if (user.mustChangePassword) return navigate("/account/password");
  navigate(params.get("next") ?? DEFAULT_PATH);
}

export function onSignedOut() {
  session.clear();
  navigate("/sign-in");
}
"""
LOGIN_FORM_EDITS = [
    ('import { DEFAULT_PATH } from "./redirect";\n', 'import { afterLogin } from "./redirect";\n'),
    (
        '  navigate(params.get("next") ?? DEFAULT_PATH);\n',
        '  navigate(afterLogin(params.get("next")));\n',
    ),
]
REDIRECT = """export const DEFAULT_PATH = "/";

export function isSignInPage(path: string): boolean {
  return path === "/sign-in" || path.startsWith("/sign-in?");
}
"""
REDIRECT_FIRST = (
    'export const DEFAULT_PATH = "/";\n',
    'const DEFAULT_PATH = "/";\n'
    "\n"
    "/** Where to go after sign-in: `next` only when it is a path on this site. */\n"
    "export function afterLogin(next: string | null): string {\n"
    '  if (!next || !next.startsWith("/")) return DEFAULT_PATH;\n'
    "  return next;\n"
    "}\n",
)
REDIRECT_FIX = (
    '  if (!next || !next.startsWith("/")) return DEFAULT_PATH;\n',
    '  if (!next || !next.startsWith("/") || next.startsWith("//")) return DEFAULT_PATH;\n',
)
REDIRECT_TEST = """import { describe, expect, it } from "vitest";

import { isSignInPage } from "./redirect";

describe("isSignInPage", () => {
  it("knows the sign-in page", () => {
    expect(isSignInPage("/sign-in")).toBe(true);
  });
});
"""
REDIRECT_TEST_EDITS = [
    ('import { isSignInPage } from "./redirect";\n', 'import { afterLogin, isSignInPage } from "./redirect";\n'),
    (
        "});\n});\n",
        "});\n});\n\n"
        'describe("afterLogin", () => {\n'
        '  it("follows a path on this site", () => {\n'
        '    expect(afterLogin("/billing")).toBe("/billing");\n'
        "  });\n"
        '  it("never leaves the site", () => {\n'
        '    expect(afterLogin("https://evil.example")).toBe("/");\n'
        '    expect(afterLogin("//evil.example")).toBe("/");\n'
        "  });\n"
        "});\n",
    ),
]

FORMS = ["TextField", "TextArea", "Select", "Checkbox", "Radio", "DatePicker", "Combobox"]
FORMS_LATER = ["NumberField", "Slider", "Switch", "FileDrop"]
FORMS_ELEMENT = {"TextArea": "HTMLTextAreaElement", "Select": "HTMLSelectElement"}


def form_component(name):
    element = FORMS_ELEMENT.get(name, "HTMLInputElement")
    tag = {"TextArea": "textarea", "Select": "select"}.get(name, "input")
    before = (
        'import { forwardRef } from "react";\n\n'
        f'import type {{ {name}Props }} from "./types";\n\n'
        f"export const {name} = forwardRef<{element}, {name}Props>(function {name}(props, ref) {{\n"
        f"  return <{tag} ref={{ref}} {{...props}} />;\n"
        "});\n"
    )
    edits = [
        ('import { forwardRef } from "react";\n', 'import type { Ref } from "react";\n'),
        (
            f"export const {name} = forwardRef<{element}, {name}Props>(function {name}(props, ref) {{\n",
            f"export function {name}({{ ref, ...props }}: {name}Props & {{ ref?: Ref<{element}> }}) {{\n",
        ),
        (f"  return <{tag} ref={{ref}} {{...props}} />;\n}});\n", f"  return <{tag} ref={{ref}} {{...props}} />;\n}}\n"),
    ]
    return before, edits


REACT_PACKAGE = """{
  "name": "frontend",
  "private": true,
  "scripts": { "dev": "vite", "test": "vitest run", "build": "tsc && vite build" },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0",
    "react-beautiful-dnd": "^13.1.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vitest": "^2.1.5"
  }
}
"""
REACT_PACKAGE_EDITS = [
    ('    "react": "^18.3.1",\n    "react-dom": "^18.3.1",\n', '    "react": "^19.0.0",\n    "react-dom": "^19.0.0",\n'),
    (
        '    "@types/react": "^18.3.12",\n    "@types/react-dom": "^18.3.1",\n',
        '    "@types/react": "^19.0.1",\n    "@types/react-dom": "^19.0.1",\n',
    ),
]
TABLE = """import type { TableProps } from "./types";

export function Table({ rows, dense, empty }: TableProps) {
  if (rows.length === 0) return <p className="empty">{empty}</p>;
  return <table className={dense ? "dense" : undefined}>{rows.map((r) => <Row key={r.id} row={r} />)}</table>;
}

Table.defaultProps = { dense: false, empty: "Nothing yet" };
"""
TABLE_EDITS = [
    ("export function Table({ rows, dense, empty }: TableProps) {\n",
     'export function Table({ rows, dense = false, empty = "Nothing yet" }: TableProps) {\n'),
    ('\nTable.defaultProps = { dense: false, empty: "Nothing yet" };\n', ""),
]
BUTTON = """import type { ButtonProps } from "./types";

export function Button({ kind, children, ...rest }: ButtonProps) {
  return <button className={`button ${kind}`} {...rest}>{children}</button>;
}

Button.defaultProps = { kind: "plain" };
"""
BUTTON_EDITS = [
    ("export function Button({ kind, children, ...rest }: ButtonProps) {\n",
     'export function Button({ kind = "plain", children, ...rest }: ButtonProps) {\n'),
    ('\nButton.defaultProps = { kind: "plain" };\n', ""),
]
AVATAR = """import type { AvatarProps } from "./types";

export function Avatar({ name, size }: AvatarProps) {
  return <span className="avatar" style={{ width: size, height: size }}>{name.slice(0, 1)}</span>;
}

Avatar.defaultProps = { size: 24 };
"""
AVATAR_EDITS = [
    ("export function Avatar({ name, size }: AvatarProps) {\n", "export function Avatar({ name, size = 24 }: AvatarProps) {\n"),
    ("\nAvatar.defaultProps = { size: 24 };\n", ""),
]


def applied(text, edits):
    for old, new in edits:
        if text.count(old) != 1:
            raise SystemExit(f"gen.py: an edit does not match its file once: {old!r}")
        text = text.replace(old, new)
    return text


# ---- the folders the agents run in -----------------------------------------------------------------------------------


def git(cwd, *args):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_AUTHOR_DATE="2026-11-02T09:00:00Z",
               GIT_COMMITTER_DATE="2026-11-02T09:00:00Z")
    subprocess.run(["git", "-c", "user.name=Dev", "-c", "user.email=dev@example.com", "-c", "init.defaultBranch=main",
                    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
                   cwd=cwd, env=env, check=True, stdout=subprocess.DEVNULL)


def repo(path, files):
    for rel, text in files.items():
        write(os.path.join(path, rel), text)
    git(path, "init", "-q")
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "Initial commit")


def make_repos(root):
    home = root + FAKE_HOME
    payments = os.path.join(home, "payments-api")
    repo(payments, {
        "README.md": "# payments-api\n\nPayments and refunds over HTTP.\n",
        "src/refunds/create.ts": PAYMENTS_CREATE,
        "src/refunds/routes.ts": PAYMENTS_ROUTES,
        "src/refunds/split.ts": "export function splitRefund() {}\n",
        "src/money/round.ts": "export const toMinor = (amount: number) => Math.round(amount * 100);\n",
        "src/db/schema.ts": "export const refunds = { id: 'text', payment_id: 'text', amount: 'integer' };\n",
        "test/refunds.test.ts": PAYMENTS_TEST,
        "db/migrations/0041_refund_reason.sql": "ALTER TABLE refunds ADD COLUMN reason text;\n",
    })
    git(payments, "worktree", "add", "-q", "-b", "split", os.path.join(home, "payments-split"))
    write(os.path.join(payments, "src/refunds/create.ts"), applied(PAYMENTS_CREATE, PAYMENTS_CREATE_EDITS))
    write(os.path.join(payments, "src/refunds/routes.ts"), applied(PAYMENTS_ROUTES, PAYMENTS_ROUTES_EDITS))
    write(os.path.join(payments, "test/refunds.test.ts"), applied(PAYMENTS_TEST, PAYMENTS_TEST_EDITS))
    write(os.path.join(payments, "db/migrations/0042_refund_idempotency.sql"), PAYMENTS_MIGRATION)

    frontend = os.path.join(home, "frontend")
    forms = {f"src/components/forms/{n}.tsx": form_component(n)[0] for n in FORMS + FORMS_LATER}
    repo(frontend, {
        "README.md": "# frontend\n\nThe web app.\n",
        "package.json": REACT_PACKAGE,
        "src/router.ts": "export function navigate(path: string) {\n  window.history.pushState(null, \"\", path);\n}\n",
        "src/auth/login-form.tsx": LOGIN_FORM,
        "src/auth/redirect.ts": REDIRECT,
        "src/auth/redirect.test.ts": REDIRECT_TEST,
        "src/auth/session.ts": "export const session = { current: () => null, refresh: async () => {}, clear() {} };\n",
        "src/components/Table.tsx": TABLE,
        "src/components/Button.tsx": BUTTON,
        "src/components/Avatar.tsx": AVATAR,
        **forms,
    })
    react = os.path.join(home, "frontend-react-19")
    git(frontend, "worktree", "add", "-q", "-b", "react-19", react)
    write(os.path.join(frontend, "src/auth/login-form.tsx"), applied(LOGIN_FORM, LOGIN_FORM_EDITS))
    write(os.path.join(frontend, "src/auth/redirect.ts"), applied(REDIRECT, [REDIRECT_FIRST, REDIRECT_FIX]))
    write(os.path.join(frontend, "src/auth/redirect.test.ts"), applied(REDIRECT_TEST, REDIRECT_TEST_EDITS))
    for rel, text, edits in [("package.json", REACT_PACKAGE, REACT_PACKAGE_EDITS),
                             ("src/components/Table.tsx", TABLE, TABLE_EDITS),
                             ("src/components/Button.tsx", BUTTON, BUTTON_EDITS),
                             ("src/components/Avatar.tsx", AVATAR, AVATAR_EDITS)]:
        write(os.path.join(react, rel), applied(text, edits))
    for n in FORMS:
        before, edits = form_component(n)
        write(os.path.join(react, f"src/components/forms/{n}.tsx"), applied(before, edits))

    repo(os.path.join(home, "infra"), {
        "README.md": "# infra\n\nTerraform for staging and production.\n",
        "main.tf": 'module "certs" {\n  source = "./modules/certs"\n  env    = "staging"\n}\n',
        "modules/certs/main.tf": 'variable "env" {}\n',
    })
    write(os.path.join(home, "docs", "quickstart.md"), "# Quickstart\n\nCreate a payment, then refund it.\n")


# ---- the scripted herdr ----------------------------------------------------------------------------------------------

# The Claude Code agents of the showcase and their session ids (the log file names).
SESSIONS = {
    "w1:p1": "5a1d0000-0000-4000-8000-000000000101",
    "w1:p3": "5a1d0000-0000-4000-8000-000000000103",
    "w2:p1": "5a1d0000-0000-4000-8000-000000000201",
    "w3:p1": "5a1d0000-0000-4000-8000-000000000301",
    "w4:p1": "5a1d0000-0000-4000-8000-000000000401",
    "w6:p1": "5a1d0000-0000-4000-8000-000000000601",
    "w7:p1": "5a1d0000-0000-4000-8000-000000000701",
}


def moved(path, root):
    return root + path if isinstance(path, str) and path.startswith(FAKE_HOME) else path


def log_path(home, cwd, pane):
    return os.path.join(home, ".claude", "projects", claude_folder(cwd), SESSIONS[pane] + ".jsonl")


def make_fixture(out, root):
    with open(SHOWCASE, encoding="utf-8") as f:
        fixture = json.load(f)
    snap = fixture["snapshot"]
    for ws in snap["workspaces"]:
        wt = ws.get("worktree")
        if wt:
            for k in ("repo_root", "checkout_path"):
                wt[k] = moved(wt[k], root)
    for row in snap["panes"] + snap["agents"]:
        row["cwd"] = moved(row["cwd"], root)
        if row["pane_id"] in SESSIONS:
            row["agent_session"] = {"source": "herdr", "agent": "claude", "kind": "path",
                                    "value": log_path(os.path.join(out, "home"), row["cwd"], row["pane_id"])}
    trees = fixture["worktrees"]
    for r in trees["repos"]:
        r["root"] = moved(r["root"], root)
        for linked in r.get("linked", []):
            linked["path"] = moved(linked["path"], root)
    trees["create_at"] = moved(trees["create_at"], root)
    write(os.path.join(out, "fixtures", "showcase.json"), json.dumps(fixture, indent=1, ensure_ascii=False) + "\n")


# ---- Claude Code session logs ----------------------------------------------------------------------------------------
# The format `native/core/src/observed/claude/` reads (Claude Code 2.1): one JSON object per line, in file order; a tool
# call is an `assistant` line, its result a `user` line paired by `tool_use_id`; a subagent's transcript is a file of its
# own with `isSidechain: true` on every line.


class Log:
    def __init__(self, now, cwd, session, title=None, agent_id=None):
        self.now, self.cwd, self.session, self.agent_id = now, cwd, session, agent_id
        self.lines, self.n = [], 0
        if title:
            self.lines.append({"type": "ai-title", "aiTitle": title, "sessionId": session})

    def _id(self, prefix):
        self.n += 1
        tag = self.agent_id or self.session[-4:]
        return f"{prefix}-{tag}-{self.n:03d}"

    def _line(self, kind, ago, **fields):
        stamp = (self.now - timedelta(minutes=ago)).strftime("%Y-%m-%dT%H:%M:%S.") + "000Z"
        line = {"type": kind, "uuid": self._id("u"), "timestamp": stamp, "sessionId": self.session, "cwd": self.cwd,
                "isSidechain": self.agent_id is not None, "userType": "external", "version": "2.1.30"}
        if self.agent_id:
            line["agentId"] = self.agent_id
        line.update(fields)
        self.lines.append(line)
        return line

    def abs(self, rel):
        return os.path.join(self.cwd, rel)

    def prompt(self, ago, text):
        self._line("user", ago, message={"role": "user", "content": text})

    def say(self, ago, text, stop="end_turn"):
        self._line("assistant", ago, apiBlockIndex=0, message={
            "id": self._id("msg"), "role": "assistant", "model": "claude-sonnet-4-5", "stop_reason": stop,
            "content": [{"type": "text", "text": text}]})

    def call(self, ago, name, tool_input):
        call_id = self._id("toolu")
        self._line("assistant", ago, apiBlockIndex=0, message={
            "id": self._id("msg"), "role": "assistant", "model": "claude-sonnet-4-5", "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": call_id, "name": name, "input": tool_input}]})
        return call_id

    def result(self, ago, call_id, text, error=False, extra=None):
        fields = {"message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call_id, "content": text, "is_error": error}]}}
        if extra is not None:
            fields["toolUseResult"] = extra
        self._line("user", ago, **fields)

    def tool(self, ago, name, tool_input, text="", error=False, extra=None):
        call_id = self.call(ago, name, tool_input)
        self.result(ago - 0.05, call_id, text, error, extra)
        return call_id

    def read(self, ago, rel, text="(file contents)"):
        self.tool(ago, "Read", {"file_path": self.abs(rel)}, text)

    def grep(self, ago, pattern, found):
        self.tool(ago, "Grep", {"pattern": pattern, "output_mode": "files_with_matches"},
                  f"Found {len(found)} files\n" + "\n".join(found))

    def bash(self, ago, command, out="", error=False, description=None):
        tool_input = {"command": command}
        if description:
            tool_input["description"] = description
        self.tool(ago, "Bash", tool_input, out, error, {"stdout": out, "stderr": "", "interrupted": False})

    def edits(self, ago, rel, edits):
        for old, new in edits:
            self.tool(ago, "Edit", {"file_path": self.abs(rel), "old_string": old, "new_string": new},
                      f"The file {self.abs(rel)} has been updated.",
                      extra={"filePath": self.abs(rel), "oldString": old, "newString": new})
            ago -= 0.1

    def background(self, ago, command, task):
        self.tool(ago, "Bash", {"command": command, "run_in_background": True},
                  f"Command running in background with ID: {task}", extra={"backgroundTaskId": task})

    def subagent(self, ago, description, kind, prompt, agent):
        call_id = self.call(ago, "Agent", {"description": description, "subagent_type": kind, "prompt": prompt})
        self.result(ago - 0.05, call_id, f"Async agent launched successfully. agentId: {agent}",
                    extra={"isAsync": True, "status": "async_launched", "agentId": agent, "description": description,
                           "prompt": prompt})
        return call_id

    def notice(self, ago, task, status, summary):
        self._line("user", ago, origin={"kind": "task-notification"}, message={"role": "user", "content": (
            f"<task-notification>\n<task-id>{task}</task-id>\n<status>{status}</status>\n"
            f"<summary>{summary}</summary>\n</task-notification>")})

    def end(self, ago, seconds):
        self._line("system", ago, subtype="turn_duration", durationMs=int(seconds * 1000), isMeta=False)

    def save(self, path):
        write(path, "".join(json.dumps(line, ensure_ascii=False) + "\n" for line in self.lines))


def subagent_file(parent_path, agent, call_id, kind, description):
    stem = parent_path[: -len(".jsonl")]
    path = os.path.join(stem, "subagents", f"agent-{agent}.jsonl")
    write(path[: -len(".jsonl")] + ".meta.json",
          json.dumps({"agentType": kind, "description": description, "toolUseId": call_id}) + "\n")
    return path


AUDIT_PROMPT = ("Find every caller of createRefund in src/ and say which of them can be retried by a client: HTTP "
                "handlers, queue consumers, the admin tool. Report file, line and whether a retry can refund twice. "
                "Do not change any file.")
MOBILE_PROMPT = ("Look at how the mobile client calls POST /refunds in clients/mobile: its timeout, whether it retries, "
                 "and what it sends again. Do not change any file.")
FORMS_PROMPT = ("In src/components/forms, replace every forwardRef wrapper with ref as a plain prop (React 19). Keep "
                "the exported names and types. Run the forms tests when done.")


def glance(now, cwd, path):
    """Waits for permission to run a migration; one subagent and a test watcher run, two jobs finished."""
    log = Log(now, cwd, SESSIONS["w1:p1"], "Add idempotency keys to refunds")
    log.prompt(58, "14 refunds were paid twice last week, all from the mobile app, 10 s apart. Why?")
    log.say(57.5, "A retry: the mobile client gives up on `POST /refunds` after 10 s and sends it again, although the "
                  "first request succeeded. An idempotency key stops it.")
    log.end(56.4, 74)
    log.prompt(50, "Add idempotency keys to POST /refunds: store the key with the refund, answer a repeat with the first "
                   "response, and cover it with tests.")
    log.say(49.6, "I'll start with how a refund is created and where a retry can reach it twice.")
    log.read(49.2, "src/refunds/create.ts", PAYMENTS_CREATE)
    log.grep(48.8, "createRefund", ["src/refunds/create.ts", "src/refunds/routes.ts", "src/admin/refund-tool.ts"])
    log.read(48.4, "src/db/schema.ts")
    mobile = log.subagent(47, "Check retries in the mobile client", "Explore", MOBILE_PROMPT, "a7c2e41b90d3f5a01")
    log.background(45, "npm run build", "b3k9q2")
    log.edits(42, "src/refunds/create.ts", PAYMENTS_CREATE_EDITS)
    log.edits(41, "src/refunds/routes.ts", PAYMENTS_ROUTES_EDITS)
    log.notice(40, "b3k9q2", "completed", 'Background command "npm run build" completed (exit code 0)')
    log.read(38, "test/refunds.test.ts", PAYMENTS_TEST)
    log.edits(37.5, "test/refunds.test.ts", PAYMENTS_TEST_EDITS)
    audit = log.subagent(35, "Audit refund call sites", "general-purpose", AUDIT_PROMPT, "a5f81d07c3b6e2a94")
    log.tool(30, "Write", {"file_path": log.abs("db/migrations/0042_refund_idempotency.sql"), "content": PAYMENTS_MIGRATION},
             "File created successfully.", extra={"type": "create"})
    log.background(22, "npm test -- --watch refunds", "b8w1m5")
    log.bash(21, "npm run lint", "No problems found.")
    log.notice(19, "a7c2e41b90d3f5a01", "completed", 'Agent "Check retries in the mobile client" completed')
    log.say(18, "The code and the tests are in place. The new column needs migration 0042 on the local database "
                "before the tests can pass.", stop="tool_use")
    log.call(1.5, "Bash", {"command": "npm run migrate -- --to 0042",
                           "description": "Apply migration 0042 to the local database"})
    log.save(path)

    side = Log(now, cwd, SESSIONS["w1:p1"], agent_id="a7c2e41b90d3f5a01")
    side.prompt(47, MOBILE_PROMPT)
    side.grep(46.5, "/refunds", ["clients/mobile/src/api/refunds.ts"])
    side.read(46, "clients/mobile/src/api/refunds.ts")
    side.say(20, "The mobile client gives up after 10 s and retries once with the same body and no key: "
                 "`clients/mobile/src/api/refunds.ts`, line 31.")
    side.save(subagent_file(path, "a7c2e41b90d3f5a01", mobile, "Explore", "Check retries in the mobile client"))

    side = Log(now, cwd, SESSIONS["w1:p1"], agent_id="a5f81d07c3b6e2a94")
    side.prompt(35, AUDIT_PROMPT)
    side.grep(34.5, "createRefund\\(", ["src/refunds/routes.ts", "src/admin/refund-tool.ts", "src/queue/chargebacks.ts"])
    side.read(34, "src/admin/refund-tool.ts")
    side.read(33, "src/queue/chargebacks.ts")
    side.say(32, "Three callers. The HTTP handler and the chargeback consumer can both be retried; the admin tool "
                 "cannot. Checking whether the consumer acknowledges before or after the refund is written.")
    side.read(10, "src/queue/consumer.ts")
    side.save(subagent_file(path, "a5f81d07c3b6e2a94", audit, "general-purpose", "Audit refund call sites"))


def review(now, cwd, path):
    """A finished turn: tools folded, the answer, a failed test run kept in view; three files changed."""
    log = Log(now, cwd, SESSIONS["w3:p1"], "Fix the login redirect")
    log.prompt(41, "After signing in, ?next= can send people to another site. Only allow paths on our own origin, and add "
                   "tests.")
    log.say(40.7, "Looking at where the redirect is read after sign-in.")
    log.read(40.5, "src/auth/login-form.tsx", LOGIN_FORM)
    log.grep(40.3, "params.get\\(\"next\"\\)", ["src/auth/login-form.tsx"])
    log.read(40.1, "src/auth/redirect.ts", REDIRECT)
    log.read(39.9, "src/auth/redirect.test.ts", REDIRECT_TEST)
    log.edits(39, "src/auth/redirect.ts", [REDIRECT_FIRST])
    log.edits(38.6, "src/auth/login-form.tsx", LOGIN_FORM_EDITS)
    log.edits(38.2, "src/auth/redirect.test.ts", REDIRECT_TEST_EDITS)
    log.bash(37.5, "npm test -- auth",
             " FAIL  src/auth/redirect.test.ts > afterLogin > never leaves the site\n"
             "AssertionError: expected '//evil.example' to be '/'\n\n"
             " Test Files  1 failed | 3 passed (4)\n"
             "      Tests  1 failed | 15 passed (16)\n\n"
             "Tests: 1 failed, 15 passed, 16 total",
             error=True)
    log.edits(36.8, "src/auth/redirect.ts", [REDIRECT_FIX])
    log.bash(36.2, "npm test -- auth", " Test Files  4 passed (4)\n      Tests  16 passed (16)")
    log.bash(35.8, "npx tsc --noEmit", "")
    log.bash(35.5, "git diff --stat",
             " src/auth/login-form.tsx   |  4 ++--\n src/auth/redirect.test.ts | 12 +++++++++++-\n"
             " src/auth/redirect.ts      |  8 +++++++-\n 3 files changed, 20 insertions(+), 4 deletions(-)")
    log.say(35, "Fixed. After sign-in, `?next=` is followed only when it is a path on this site (`/billing`); "
                "`//evil.example` and full URLs go to `/` instead.\n\n"
                "- `src/auth/redirect.ts`: the one check, `afterLogin()`\n"
                "- `src/auth/login-form.tsx`: uses it instead of reading `next` itself\n"
                "- `src/auth/redirect.test.ts`: two tests. The first run failed (`//evil.example` got through); after "
                "the fix, 16 of 16 pass.\n\n"
                "Nothing was pushed.")
    log.end(34.9, 372)
    log.save(path)


def night(now, cwd, path):
    """Still working; its subagent moves the form components off forwardRef and has run for about 37 minutes."""
    log = Log(now, cwd, SESSIONS["w4:p1"], "Upgrade to React 19")
    log.prompt(80, "We want React 19. Before touching anything, tell me what will break.")
    log.read(79.6, "package.json", REACT_PACKAGE)
    log.grep(79.3, "forwardRef|defaultProps|react-beautiful-dnd",
             [f"src/components/forms/{n}.tsx" for n in FORMS + FORMS_LATER])
    log.say(78.5, "Three things will break, in order of size:\n\n"
                  "1. `forwardRef` in 23 components: still works, but `ref` is now a plain prop, so the wrappers can go.\n"
                  "2. `defaultProps` on 6 function components: removed in 19, the defaults move into the parameters.\n"
                  "3. `react-beautiful-dnd`: unmaintained and pinned to React 18; `@hello-pangea/dnd` is a drop-in fork.\n\n"
                  "The test setup and the router are already compatible.")
    log.end(78.4, 96)
    log.prompt(66, "Go ahead. Keep the tests green, and don't upgrade anything else.")
    log.say(65.6, "Upgrading react and react-dom first, then the components one folder at a time.")
    log.edits(65, "package.json", REACT_PACKAGE_EDITS)
    log.bash(64, "npm install", "added 2 packages, changed 4 packages in 6s")
    log.bash(62, "npm test", " Test Files  41 passed (41)\n      Tests  212 passed (212)")
    log.read(60, "src/components/Table.tsx", TABLE)
    log.edits(59, "src/components/Table.tsx", TABLE_EDITS)
    log.edits(57, "src/components/Button.tsx", BUTTON_EDITS)
    log.edits(55, "src/components/Avatar.tsx", AVATAR_EDITS)
    log.bash(52, "npx tsc --noEmit", "")
    forms = log.subagent(37, "Move refs to plain props in components/forms", "general-purpose", FORMS_PROMPT,
                         "a3e9b17f20c4d8e65")
    log.bash(30, "npm test -- components/table", " Test Files  3 passed (3)\n      Tests  18 passed (18)")
    log.read(4, "src/components/Table.tsx")
    log.save(path)

    side = Log(now, cwd, SESSIONS["w4:p1"], agent_id="a3e9b17f20c4d8e65")
    side.prompt(37, FORMS_PROMPT)
    side.grep(36.6, "forwardRef", [f"src/components/forms/{n}.tsx" for n in FORMS + FORMS_LATER])
    side.say(36, "Eleven components in src/components/forms use forwardRef. Starting with the inputs, which the others "
                 "wrap.")
    ago = 34
    for n in FORMS:
        side.edits(ago, f"src/components/forms/{n}.tsx", form_component(n)[1])
        ago -= 2.5
    side.say(16, "Seven of eleven done. `DatePicker` passed its ref to a portal, so it now takes `ref` and hands it to "
                 "`Popover` explicitly; its type is `Ref<HTMLInputElement>` as before, so callers do not change.")
    side.bash(12, "npm test -- components/forms", " Test Files  11 passed (11)\n      Tests  64 passed (64)")
    side.say(10, "The 64 forms tests pass with seven components moved. Doing `NumberField`, `Slider`, `Switch` and "
                 "`FileDrop` now.")
    side.read(2, "src/components/forms/NumberField.tsx", form_component("NumberField")[0])
    side.save(subagent_file(path, "a3e9b17f20c4d8e65", forms, "general-purpose",
                            "Move refs to plain props in components/forms"))


def others(now, cwds, paths):
    """The rest of the showcase's Claude Code agents: a few lines each, so every chat opens with something."""
    log = Log(now, cwds["w1:p3"], SESSIONS["w1:p3"], "Fix currency rounding")
    log.prompt(95, "Refund totals are off by a cent on some multi-currency orders. Round once, at the end, in minor units.")
    log.read(94.5, "src/money/round.ts")
    log.bash(93, "npm test -- money", " Test Files  5 passed (5)\n      Tests  38 passed (38)")
    log.bash(92.5, "git commit -am 'Round refunds once, in minor units'", "[main 3f2a91c] Round refunds once, in minor units")
    log.say(92, "Done: amounts are rounded once, in minor units. 38 tests pass.")
    log.end(91.9, 188)
    log.save(paths["w1:p3"])

    log = Log(now, cwds["w2:p1"], SESSIONS["w2:p1"], "Partial refunds for split payments")
    log.prompt(14, "Support partial refunds on a payment split across two cards: refund the newest card first.")
    log.say(13.6, "Reading how a split payment is recorded.")
    log.read(13.2, "src/refunds/split.ts")
    log.call(0.5, "Edit", {"file_path": os.path.join(cwds["w2:p1"], "src/refunds/split.ts"),
                           "old_string": "export function splitRefund() {}\n",
                           "new_string": "export function splitRefund(payment: Payment, amount: number) {\n"})
    log.save(paths["w2:p1"])

    log = Log(now, cwds["w6:p1"], SESSIONS["w6:p1"], "Rotate the staging certificates")
    log.prompt(9, "The staging certificates expire on Friday. Rotate them; plan the certs module only, do not apply.")
    log.say(8.7, "Planning the certs module only.")
    log.read(8.4, "main.tf")
    log.call(1, "Bash", {"command": "terraform plan -target=module.certs", "description": "Plan the certs module"})
    log.save(paths["w6:p1"])

    log = Log(now, cwds["w7:p1"], SESSIONS["w7:p1"], "Rewrite the API quickstart")
    log.prompt(130, "Rewrite the API quickstart around one request a reader can run in a minute.")
    log.read(129.5, "quickstart.md")
    log.tool(128, "Write", {"file_path": os.path.join(cwds["w7:p1"], "quickstart.md"),
                            "content": "# Quickstart\n\nCreate a payment, then refund it.\n"}, "File written.")
    log.say(127, "Rewrote the quickstart around one request: create a payment, then refund it. Every sample runs "
                 "against the sandbox as written.")
    log.end(126.9, 240)
    log.save(paths["w7:p1"])


def make_logs(out, home):
    root = os.path.join(out, "root")
    with open(SHOWCASE, encoding="utf-8") as f:
        agents = json.load(f)["snapshot"]["agents"]
    cwds = {a["pane_id"]: moved(a["cwd"], root) for a in agents if a["pane_id"] in SESSIONS}
    paths = {p: log_path(home, cwd, p) for p, cwd in cwds.items()}
    now = datetime.now(timezone.utc)
    glance(now, cwds["w1:p1"], paths["w1:p1"])
    review(now, cwds["w3:p1"], paths["w3:p1"])
    night(now, cwds["w4:p1"], paths["w4:p1"])
    others(now, cwds, paths)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "setup":
        out = os.path.abspath(sys.argv[2])
        root = os.path.join(out, "root")
        make_repos(root)
        make_fixture(out, root)
    elif len(sys.argv) == 4 and sys.argv[1] == "logs":
        make_logs(os.path.abspath(sys.argv[2]), os.path.abspath(sys.argv[3]))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
