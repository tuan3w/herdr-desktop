import { Files as MachineFiles, Sessions } from "herdr-desktop/native";
import { cleanup, host, keymap, mount, signal, Text, View } from "nsh";

import type {
  AcpView,
  ActionResult,
  DiffItem,
  PlanStepView,
  QueuedView,
  SessionItem,
  SessionRef,
  SessionView,
  ToolItem,
} from "herdr-desktop/native";

import { SessionChat, SessionTab } from "#components/session-tab";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { startHerdr } from "#lib/herdr";
import { warmCode } from "#lib/highlight";
import { attachFiles, copyCode, copyReply } from "#lib/pane-input";
import { createSessionModel, type SessionPort } from "#lib/session";
import { pictureSource } from "#lib/session-pictures";
import { loadSettings } from "#lib/settings";
import { GLOBAL, keysOf } from "#lib/shortcuts";

/**
 * The entry of `session-tab.test.tsx` and the screenshots. Two modes, chosen by the launch parameter `mode`:
 *
 * - `keeper` (default): a real keeper driving herdr-mobile's scripted ACP agent, as `sessions-lab.tsx` does, with a
 *   `SessionTab` on the session it starts. The test types into the message box; what comes back is the agent's.
 * - `scripted`: a `SessionChat` over a port of this file (`scripted`), so a scene the scripted agent cannot make (a plan,
 *   a diff, a subagent, a kind the app does not know, 400 rows) is on screen exactly as written. Buttons under the
 *   header change it the way a stream would; `Log` lists what the chat asked of the port.
 *
 * - `model`: no screen, only `createSessionModel` over a scripted port, and what it told its hooks, so a test can tell that
 *   an answer is announced once when a turn ends and not for every streamed word.
 *
 * `quiet: true` leaves out the lab's own buttons and lines, for a screenshot of the chat alone. Not part of the app.
 */
const params = host.params as {
  mode?: "keeper" | "scripted" | "model";
  scene?: string;
  quiet?: boolean;
  rows?: number;
  only?: "user" | "agent";
  autostream?: number;
  upTo?: number;
  instant?: boolean;
  fences?: boolean;
  lines?: number;
};
startHerdr("", "empty");
void loadSettings();
warmCode();
/** The synthetic folder the test seam copied (`fixtures/files/project`): the session's folder, so `@` lists real files. */
const tree = MachineFiles.testTree();

/** A 24 by 24 PNG made for the lab; the `pictures` scene is the chat of a terminal, whose pictures are fetched from the log. */
const LAB_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAQElEQVR42u3MoREAMAgEQQpLEakETTlfTvRXFM95FDOrN069JkFgiI1GIzUJAsNGs1E1CQLDRrPRbRIEho0Gow+BQHjuK4CvmgAAAABJRU5ErkJggg==";
pictureSource.fetch = async (_machine, _id, source) => {
  if (source === "keeper:0:gone") throw new Error("That picture is not in the log any more.");
  return LAB_PNG;
};

/** What ACP says besides the rows, with nothing to say. */
const ACP: AcpView = {
  canResume: false,
  canList: false,
  canClose: false,
  canLogout: false,
  acceptsAudio: false,
  acceptsEmbedded: false,
  auth: [],
};

let next = 1;
const say = (role: "user" | "agent" | "thought", text: string): SessionItem => ({
  id: next++,
  rev: 1,
  kind: "message",
  role,
  text,
  images: [],
  parts: [],
});
const done = (text: string, ok = true): SessionItem => ({
  id: next++,
  rev: 1,
  kind: "done",
  text,
  ok,
  images: [],
  parts: [],
});
const call = (title: string, over: Partial<ToolItem> = {}): SessionItem => ({
  id: next++,
  rev: 1,
  kind: "tool",
  images: [],
  parts: [],
  tool: {
    id: `t${next}`,
    title,
    toolKind: "execute",
    status: "completed",
    head: [],
    tail: [],
    omitted: 0,
    diffs: [],
    locations: [],
    parts: [],
    terminal: false,
    ...over,
  },
});

/** `item` with the agent's own times, in milliseconds since the session was attached. */
const timed = (item: SessionItem, startedMs: number, endedMs?: number): SessionItem => ({
  ...item,
  startedMs,
  endedMs,
});

const EDIT: DiffItem = {
  path: `${tree}/src/auth.ts`,
  old: 'export function login(user) {\n  redirect("/callback");\n}\n',
  new: 'export function login(user) {\n  const next = safeNext(user.next);\n  redirect(next ?? "/");\n}\n',
  added: 3,
  removed: 1,
};

const ANSWER = [
  "The loop came from `login` always redirecting to `/callback`, which signs the person in again. Two changes fix it:",
  "",
  "1. `login` now redirects to the page the person asked for (`safeNext`), and only to paths on this site.",
  "2. The callback no longer sets the cookie twice.",
  "",
  "```ts",
  "export function login(user: User) {",
  "  const next = safeNext(user.next);",
  '  redirect(next ?? "/");',
  "}",
  "```",
  "",
  "| Check | Result |",
  "|---|---|",
  "| unit tests | 42 passed |",
  "| type check | clean |",
].join("\n");

/** One long synthetic function: a block past the fold of 16 lines, for the look of `Show all 304 lines`. */
const LONG_FUNCTION = [
  "fn replay(ledger: &mut Ledger) {",
  ...Array.from({ length: 300 }, (_, i) => `    ledger.record(${i}, "entry-${i}", ${(i * 7) % 100});`),
  "}",
].join("\n");

/** What an agent writes when it explains code: prose, inline code and a fence of every kind the chat meets. */
const CODE_ANSWER = [
  "The retry loop lives in `Client::send` (see `src/client.ts:42`). Here is the shape of it in the three places that matter.",
  "",
  "```ts",
  "export async function send(req: Request, attempts = 3): Promise<Response> {",
  "  for (let i = 0; i < attempts; i++) {",
  "    const res = await fetch(req.url, { method: req.method, signal: AbortSignal.timeout(2_500) });",
  "    if (res.ok || res.status < 500) return res;",
  "    await sleep(2 ** i * 100); // back off",
  "  }",
  "  throw new Error(`gave up after ${attempts} tries`);",
  "}",
  "```",
  "",
  "The Rust side does the same with a bounded loop:",
  "",
  "```rust",
  "pub fn send(req: &Request, attempts: u32) -> Result<Response, Error> {",
  "    for i in 0..attempts {",
  "        match transport::call(req) {",
  "            Ok(res) if res.status() < 500 => return Ok(res),",
  "            Err(e) if !e.retryable() => return Err(e),",
  "            _ => std::thread::sleep(Duration::from_millis(100 << i)),",
  "        }",
  "    }",
  "    Err(Error::GaveUp(attempts))",
  "}",
  "```",
  "",
  "```python",
  "def send(req, attempts=3):",
  "    for i in range(attempts):",
  "        res = transport.call(req, timeout=2.5)",
  "        if res.ok or res.status < 500:",
  "            return res",
  "        time.sleep(0.1 * 2**i)",
  '    raise GaveUp(f"after {attempts} tries")',
  "```",
  "",
  "To try it and look at the log:",
  "",
  "```sh",
  "$ pnpm test --filter client && tail -n 20 logs/client.log | grep -i retry",
  "```",
  "",
  "A response that does not retry carries this body, which is no language in particular:",
  "",
  "```",
  "{",
  '  "status": 400,',
  '  "retryable": false,',
  '  "message": "bad request"',
  "}",
  "```",
  "",
  "A language nobody has a grammar for is drawn plain:",
  "",
  "```frobnicate",
  "wibble the wobble",
  "wobble the wibble",
  "```",
  "",
  "```json",
  '{ "attempts": 3, "backoff": { "base_ms": 100, "factor": 2 }, "retry_on": [500, 502, 503] }',
  "```",
  "",
  "This is the change to the loop:",
  "",
  "```diff",
  "--- a/src/client.ts",
  "+++ b/src/client.ts",
  "@@ -10,7 +10,7 @@ export async function send(req: Request) {",
  "   for (let i = 0; i < attempts; i++) {",
  "-    await sleep(100);",
  "+    await sleep(2 ** i * 100);",
  "   }",
  "```",
  "",
  "A very long line, as a minified file or a log line has:",
  "",
  "```text",
  `${"GET /api/v2/ledger/entries?cursor=eyJpZCI6MTIzNDU2Nzg5fQ&limit=500&include=merchant,currency,fees&sort=-created_at ".repeat(4)}`,
  "```",
  "",
  "And the whole replay, for reference:",
  "",
  "```rust",
  LONG_FUNCTION,
  "```",
  "",
  "- a fence inside a list item is drawn by the text view's hook:",
  "  ```sh",
  "  echo inside a list",
  "  ```",
  "",
  "That is all of it.",
].join("\n");

/** `n` lines of Rust in pieces of 20, as a long fence is written: the stress of `lines` (`.perf/scenarios.test.tsx`). */
const bigPieces = (n: number): string[] => [
  "Writing it out in full:\n\n",
  "```rust\n",
  ...Array.from({ length: Math.ceil(n / 20) }, (_, p) =>
    Array.from(
      { length: Math.min(20, n - p * 20) },
      (_, i) => `    let value_${p * 20 + i} = ledger.get(${p * 20 + i}).unwrap_or_default();\n`,
    ).join(""),
  ),
  "```\n\n",
  "That is all of it.",
];

/** The text a streaming reply writes in `code-stream`, in the pieces the lab cuts it into. */
const SMALL_STREAM = [
  "Here is the loop, as it is being written:\n\n",
  "```ts\n",
  "export async function send(req: Request) {\n",
  "  for (let i = 0; i < 3; i++) {\n",
  "    const res = await fetch(req.url);\n",
  "    if (res.ok) return res;\n",
  "  }\n",
  '  throw new Error("gave up");\n',
  "}\n",
  "```\n\n",
  "It tries three times and then gives up.",
];

/** A short and a middling block for the long scene (`fences`): a conversation of code is what the 5,000-row measurement is about. */
const SMALL_FENCE = [
  "```ts",
  "export function total(rows: number[]): number {",
  "  let sum = 0;",
  "  for (const r of rows) sum += r;",
  "  return sum;",
  "}",
  "```",
].join("\n");
const MIDDLING_FENCE = [
  "```rust",
  ...Array.from({ length: 60 }, (_, i) => `    let value_${i} = ledger.get(${i}).unwrap_or_default();`),
  "```",
].join("\n");

const OUTPUT = Array.from({ length: 40 }, (_, i) => `PASS src/case-${i + 1}.test.ts (${12 + i} ms)`);

interface Scene {
  view: Partial<SessionView>;
  items: SessionItem[];
}

function scene(name: string): Scene {
  switch (name) {
    case "tools":
      return {
        view: { running: true, phase: "working" },
        items: [
          say(
            "user",
            "Fix ACME-412: EU promo codes skip regional tax at checkout. Split the tests off and report back.",
          ),
          say("thought", "The tax rules live in src/tax; the promo code path never calls them."),
          call("Read src/tax/rules.ts", { toolKind: "read", subject: `${tree}/src/tax/rules.ts` }),
          call("Edit src/auth.ts", { toolKind: "edit", subject: `${tree}/src/auth.ts`, diffs: [EDIT] }),
          call("Run: pnpm test", {
            toolKind: "execute",
            subject: "pnpm test",
            status: "failed",
            head: OUTPUT.slice(0, 6),
            tail: ["FAIL src/case-9.test.ts", "1 failed, 39 passed", "", "Ran all test suites."],
            omitted: 20,
          }),
          call("tax-rules", {
            toolKind: "task",
            subject: "tax-rules",
            status: "completed",
            head: ["Fixed. Promo discounts now apply after VAT for EU regions, and 11 tax tests pass."],
          }),
          call("Running pnpm test promo-eu", {
            toolKind: "execute",
            subject: "pnpm test promo-eu",
            status: "inProgress",
          }),
        ],
      };
    case "calls-narration": {
      // Three turns of a Claude Code session as a person sees it opened: narration between runs of calls, a heredoc
      // command, a long search, a sized edit, a failed call, and a turn still running with nothing open (`Thinking`).
      const py = `python3 - <<'E' p='components/session-lab.tsx'\nimport re\ns=open(p).read()\nopen(p,'w').write(s)\nE`;
      const turn = (n: number): SessionItem[] => [
        say("user", `Step ${n}: add a test for the menu pass and report back.`),
        call("Run: python3", { toolKind: "execute", subject: py }),
        call("Run: grep", {
          toolKind: "execute",
          subject:
            "grep -n 'export.*\\(popup\\|picker\\)' components/composer-picker.tsx lib/composer-popup.ts lib/menus.ts",
        }),
        say("agent", "I'm adding a test for the menu pass, then checking the sizes of the popups."),
        call("Edit src/auth.ts", { toolKind: "edit", subject: `${tree}/src/auth.ts`, diffs: [EDIT] }),
        call("Run: sed", { toolKind: "execute", subject: "sed -n 108,118p components/composer-picker.tsx" }),
        call("Run: pnpm test", {
          toolKind: "execute",
          subject: "pnpm test --filter @acme/checkout-service --coverage --reporter=verbose promo-eu regional-tax",
          status: "failed",
          tail: ["FAIL src/case-9.test.ts", "1 failed, 39 passed"],
        }),
        say("agent", "Menus pass 17 of 17; the one failure is in the old tax test."),
        ...(n === 3 ? [] : [call("Read src/tax/rules.ts", { toolKind: "read", subject: `${tree}/src/tax/rules.ts` })]),
        ...(n === 2 ? [] : [call("Run: python3", { toolKind: "execute", subject: py })]),
      ];
      return {
        view: { running: true, phase: "working" },
        items: [...turn(1), ...turn(2), ...turn(3)],
      };
    }
    case "ranked":
      // A finished turn ranked by consequence: reads, edits and narration fold into one line; the failed run, the push
      // and the edits stay in view under the answer.
      return {
        view: { running: false, phase: "idle" },
        items: [
          say("user", "Fix the login loop, run the tests and push it."),
          call("Read src/auth.ts", { toolKind: "read", subject: `${tree}/src/auth.ts` }),
          call("Read src/routes.ts", { toolKind: "read", subject: `${tree}/src/routes.ts` }),
          say("agent", "Found it. Changing `login` and running the tests."),
          call("Edit src/auth.ts", { toolKind: "edit", subject: `${tree}/src/auth.ts`, diffs: [EDIT] }),
          call("Run: pnpm test", {
            toolKind: "execute",
            subject: "pnpm test",
            status: "failed",
            tail: ["FAIL src/case-9.test.ts", "1 failed, 39 passed"],
          }),
          call("Run: pnpm test", { toolKind: "execute", subject: "pnpm test" }),
          call("Run: git push", {
            toolKind: "execute",
            subject: "git push origin main",
            effect: { kind: "push", text: "Pushed to origin/main" },
          }),
          say(
            "agent",
            "Fixed in `src/auth.ts`: `login` goes back to the page that was asked for. The tests pass and it is pushed.",
          ),
        ],
      };
    case "code":
      return {
        view: { running: false, phase: "idle" },
        items: [
          say("user", "How does the client retry? Show me the three implementations."),
          say("agent", CODE_ANSWER),
        ],
      };
    case "code-stream":
      return {
        view: { running: true, phase: "working" },
        items: [say("user", "Show me the retry loop."), say("agent", "")],
      };
    case "plan":
      return {
        view: {
          running: true,
          phase: "working",
          plan: [
            { content: "Reproduce the redirect loop", status: "completed" },
            { content: "Make login honour the requested page", status: "inProgress" },
            { content: "Run the tests", status: "pending" },
          ],
          queue: [
            { id: 1, text: "Also add a regression test for the callback", files: [], pictures: [] },
            { id: 2, text: "Then update the changelog", files: [`${tree}/README.md`], pictures: [] },
          ],
          commands: [
            { name: "compact", description: "Summarise the conversation to free context", kind: "command" },
            { name: "review", description: "Review the changes on this branch", hint: "<branch>", kind: "command" },
          ],
        },
        items: [
          say("user", "Fix the login redirect loop."),
          call("Read src/auth.ts", { toolKind: "read", subject: `${tree}/src/auth.ts` }),
          say("agent", "Found it: `login` always redirects to `/callback`."),
        ],
      };
    case "pictures": {
      const shot = (n: number, bytes: number | undefined = 164) => ({
        key: `log-${n}`,
        mime: "image/png",
        bytes,
        source: `keeper:${n}:00000000000000${n}${n}`,
      });
      return {
        view: { running: false, phase: "idle" },
        items: [
          { ...say("user", "[Image #55] not nice."), images: [shot(1)] },
          { ...say("agent", "I see: the corners are cut off. I will round them."), images: [] },
          { ...say("user", "[Image #56] and [Image #57] compare these"), images: [shot(2), shot(3, 20 * 1024 * 1024)] },
          { ...say("user", "[Image #58]"), images: [{ ...shot(4), source: "keeper:0:gone" }] },
        ],
      };
    }
    case "long":
      return {
        view: { running: false, phase: "idle", earlierNotice: "Earlier messages are no longer kept" },
        items: Array.from({ length: params.rows ?? 400 }, (_, i) =>
          params.only === "agent" || (params.only !== "user" && i % 2 === 1)
            ? say(
                "agent",
                `Answer ${(i - 1) / 2 + 1}: here is what the code does at that point.${params.fences && i % 8 === 1 ? `\n\n${i % 40 === 1 ? MIDDLING_FENCE : SMALL_FENCE}\n\nThat is the whole of it.` : ""}`,
              )
            : say("user", `Question ${i / 2 + 1}`),
        ),
      };
    case "earlier":
      return {
        view: { phase: "idle", earlierNotice: "Earlier messages are no longer kept" },
        items: [say("user", "Where were we?"), say("agent", "Mid-way through the migration.")],
      };
    case "ended":
      return {
        view: { phase: "ended", endedReason: "the agent exited with code 3" },
        items: [say("user", "run it"), say("agent", "Starting."), done("Turn ended: the agent exited", false)],
      };
    case "blank":
      return { view: { phase: "idle" }, items: [] };
    case "blind":
      return { view: { phase: "idle", acceptsPictures: false }, items: [] };
    case "commands":
      return {
        view: {
          phase: "idle",
          commands: [
            { name: "compact", description: "Summarise the conversation to free context", kind: "command" },
            { name: "review", description: "Review the changes on this branch", hint: "<branch>", kind: "command" },
            { name: "init", description: "Write an AGENTS.md for this project", kind: "command" },
            { name: "cost", description: "Show what this session has used", kind: "command" },
            { name: "review-pr", description: "Review a pull request by its number", hint: "<number>", kind: "skill" },
            { name: "release-notes", description: "Write the notes for the next release", kind: "skill" },
          ],
        },
        items: [],
      };
    case "many-commands":
      // Fourteen commands, some with long descriptions: the list scrolls past ten rows and the bubble wraps.
      return {
        view: {
          phase: "idle",
          commands: [
            ["compact", "Summarise the conversation to free context"],
            ["review", "Review the changes on this branch for bugs, style and missing tests"],
            ["init", "Write an AGENTS.md for this project"],
            ["cost", "Show what this session has used"],
            ["model", "Choose the model for the rest of the session"],
            ["effort", "How hard the agent thinks before it answers"],
            ["fast", "Toggle fast mode"],
            ["plan", "Plan, run, inspect, import, and compare native security scans of the whole repository"],
            ["permissions", "Change what the agent may do without asking"],
            ["rewind", "Go back to an earlier message"],
            ["fork", "Branch the conversation from here"],
            ["mcp", "Manage the servers the agent can reach"],
            ["plugin", "Install or remove plugins"],
            ["prewalk", "Walk the codebase before planning"],
          ].map(([name, description]) => ({ name, description, kind: "command" as const })),
        },
        items: [],
      };
    case "signin":
      return {
        view: {
          phase: "authRequired",
          acp: {
            ...ACP,
            auth: [
              {
                id: "login",
                name: "Use existing local credentials",
                description: "Sign in with the login this machine already has.",
              },
              { id: "account", name: "Sign in with an account", description: "Opens the agent's own sign-in." },
              {
                id: "term",
                name: "Log in in a terminal",
                description: "The agent signs in in a terminal.",
                terminalArgs: ["--login", "--provider", "my cloud"],
              },
            ],
          },
        },
        items: [],
      };
    default:
      return {
        view: { running: false, phase: "idle" },
        items: [
          say("user", "Fix the login redirect after sign-in; it loops on /callback."),
          timed(say("thought", "Looking at the auth middleware."), 1000, 3000),
          timed(call("Read src/auth.ts", { toolKind: "read", subject: `${tree}/src/auth.ts` }), 3000, 3600),
          timed(
            call("Run: grep -rn callback src", {
              toolKind: "execute",
              subject: "grep -rn callback src",
              head: ["src/auth.ts:12: redirect('/callback')", "src/routes.ts:4: route('/callback', handler)"],
            }),
            3600,
            7200,
          ),
          timed(say("agent", ANSWER), 7200, 12_000),
          done("Done in 41s · 1 file +3 −1 · 2 tools"),
        ],
      };
  }
}

/** A port over a scene the lab can change; every action the chat takes is told in `log`. */
function scripted(initial: Scene) {
  const tick = signal(0);
  const log = signal<string[]>([]);
  let items = initial.items;
  let view: SessionView = {
    revision: 1,
    phase: "idle",
    connectionLost: false,
    agent: "claude",
    cwd: tree,
    title: "Fix the login redirect",
    itemCount: items.length,
    droppedItems: 0,
    waiting: [],
    queue: [],
    commands: [],
    options: [],
    plan: [],
    running: false,
    acceptsPictures: true,
    acp: ACP,
    ...initial.view,
  };
  const told = (line: string) => log.update((all) => [...all, line]);
  const change = (over: Partial<SessionView> = {}) => {
    view = { ...view, ...over, revision: view.revision + 1, itemCount: items.length };
    tick.update((n) => n + 1);
  };
  const ok = (kind: ActionResult["kind"] = "done"): ActionResult => ({ kind, message: "" });
  let queued = view.queue as QueuedView[];

  let release: (() => void) | undefined;
  let signedIn = false;
  const port: SessionPort = {
    revision: tick,
    view: () => view,
    items: (start, count) => items.slice(start, start + count),
    itemIds: () => items.map((i) => i.id),
    send: async (text, files, pictures) => {
      told(
        `send ${text.length > 200 ? `${text.slice(0, 80)}… (${text.length} characters, ends ${text.slice(-12)})` : text}${files.length > 0 ? ` +${files.join(",")}` : ""}${pictures.length > 0 ? ` +pictures ${pictures.map((p) => p.number).join(",")}` : ""}`,
      );
      if (view.running) {
        queued = [...queued, { id: 100 + queued.length, text, files, pictures }];
        change({ queue: queued });
        return ok("queued");
      }
      items = [...items, say("user", text)];
      change({ running: true, phase: "working" });
      return ok();
    },
    unqueue: async (id) => {
      const q = queued.find((x) => x.id === id);
      told(`unqueue ${id}`);
      if (!q) return null;
      queued = queued.filter((x) => x.id !== id);
      change({ queue: queued });
      return { text: q.text, files: q.files, pictures: q.pictures };
    },
    releaseQueue: async () => {
      told("release");
      return ok();
    },
    cancel: async () => {
      told("cancel");
      change({ running: false, phase: "idle" });
      return ok();
    },
    reconnect: async () => {
      told("reconnect");
      change({ connectionLost: false });
    },
    authenticate: async (methodId) => {
      told(`authenticate ${methodId}`);
      if (methodId === "login") {
        change({ phase: "idle", acp: { ...view.acp, auth: [] } });
        return ok();
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { kind: "invalid", message: "The agent refused: this account has no seat." };
    },
    loadEarlier: async () => {
      told("loadEarlier");
      return false;
    },
    reopen: async () => {
      told("reopen");
      if (signedIn) change({ phase: "idle", acp: { ...view.acp, auth: [] } });
      return ok();
    },
  };

  const edit = (index: number, make: (item: SessionItem) => SessionItem) => {
    items = items.map((item, i) => (i === index ? { ...make(item), rev: item.rev + 1 } : item));
    change();
  };
  return {
    port,
    log,
    /** The agent says more in its last message. */
    stream: (more: string) => edit(items.length - 1, (i) => ({ ...i, text: `${i.text ?? ""}${more}` })),
    /** The agent starts a new message. */
    message: (text: string) => {
      items = [...items, say("agent", text)];
      change();
    },
    add: (item: SessionItem) => {
      items = [...items, item];
      change();
    },
    set: change,
    finish: () => change({ running: false, phase: "idle" }),
    plan: (plan: PlanStepView[]) => change({ plan }),
    /** The agent answers the sign-in the person is waiting on (with a refusal: the scene's other method never works). */
    answer: () => release?.(),
    /** The person signed in on the machine: the next `reopen` opens the session. */
    signedInElsewhere: () => {
      signedIn = true;
    },
  };
}

const STREAMED = params.lines ? bigPieces(params.lines) : SMALL_STREAM;

function Scripted() {
  // The app binds its global shortcuts in `App.tsx`; the two a chat answers are bound here the same way.
  keymap.bind(
    {
      [keysOf(GLOBAL.copyCode)[0]]: copyCode,
      [keysOf(GLOBAL.copyReply)[0]]: copyReply,
      [keysOf(GLOBAL.attachFiles)[0]]: attachFiles,
    },
    { when: "always" },
  );
  const lab = scripted(scene(params.scene ?? "chat"));
  // A reply that writes itself: `Stream a piece` by hand (tests), or `autostream` pieces every N ms up to `upTo` of them (screenshots).
  let piece = 0;
  const writeMore = () => {
    if (piece < STREAMED.length) lab.stream(STREAMED[piece++]!);
  };
  if (params.instant) while (piece < STREAMED.length) writeMore();
  if (typeof params.autostream === "number") {
    const upTo = params.upTo ?? STREAMED.length;
    const timer = setInterval(() => (piece < upTo ? writeMore() : clearInterval(timer)), params.autostream);
    cleanup(() => clearInterval(timer));
  }
  // The chat unmounted and mounted again, as a project switch does: where it was left comes back (`lib/view-state.ts`).
  const away = signal(false);
  return (
    <View class="min-h-0 flex-1">
      <If when={!params.quiet}>
        <View class="flex-row flex-wrap items-center gap-2 border-b border-border p-2">
          <Btn small label={away() ? "Come back" : "Go away"} onPress={() => away.update((a) => !a)} />
          <Btn small label="Agent says more" onPress={() => lab.stream(" And more text arrives.")} />
          <Btn small label="Stream a piece" onPress={writeMore} />
          <Btn
            small
            label="Agent starts a message"
            onPress={() => lab.message("A new answer, started while you were reading.")}
          />
          <Btn
            small
            label="Add unknown kind"
            onPress={() =>
              lab.add({
                id: next++,
                rev: 1,
                kind: "hologram",
                text: "Something new",
                images: [],
                parts: [],
              } as unknown as SessionItem)
            }
          />
          <Btn
            small
            label="Start a call"
            onPress={() =>
              lab.add(call("Running pnpm lint", { toolKind: "execute", subject: "pnpm lint", status: "inProgress" }))
            }
          />
          <Btn
            small
            label="Advance plan"
            onPress={() =>
              lab.plan([
                { content: "Reproduce the redirect loop", status: "completed" },
                { content: "Make login honour the requested page", status: "completed" },
                { content: "Run the tests", status: "inProgress" },
              ])
            }
          />
          <Btn
            small
            label="Request waits"
            onPress={() =>
              lab.set({
                phase: "blockedOnPermission",
                waiting: [
                  {
                    requestId: "r1",
                    digest: "d1",
                    ask: "permission",
                    arrivedMs: 0,
                    title: "Run: git push",
                    subject: "git push origin main",
                    choices: [],
                    fields: [],
                  },
                ],
              })
            }
          />
          <Btn small label="Finish the turn" onPress={() => lab.finish()} />
          <Btn small label="Lose the connection" onPress={() => lab.set({ connectionLost: true })} />
          <Btn small label="Agent answers" onPress={() => lab.answer()} />
          <Btn small label="I signed in elsewhere" onPress={() => lab.signedInElsewhere()} />
        </View>
        <Text class="px-3 text-xs text-muted-foreground">{`Tree: ${tree}`}</Text>
        <Text class="px-3 py-1 text-xs text-muted-foreground">{`Log: ${lab.log().join(" | ") || "nothing yet"}`}</Text>
      </If>
      <If when={!away()}>
        <SessionChat machine="local" id="scripted" active port={lab.port} open={false} />
      </If>
    </View>
  );
}

function ModelProbe() {
  // The two rows it starts with are the replay of an earlier conversation: history, not news.
  const lab = scripted({ view: { phase: "connecting" }, items: [say("user", "earlier"), say("agent", "history")] });
  const told = signal<string[]>([]);
  const say2 = (line: string) => told.update((all) => [...all, line]);
  const model = createSessionModel(lab.port, {
    answered: (text) => say2(`answered ${text}`),
    streamed: (text) => say2(`streamed ${text}`),
    arrived: (n) => say2(`arrived ${n}`),
  });
  return (
    <View class="min-h-0 flex-1 gap-2 p-3">
      <Text>{`Told: ${told().join(" | ") || "nothing"}`}</Text>
      <Text>{`Rows: ${model.rows().length}`}</Text>
      <Text>{`Working: ${model.working() ? "yes" : "no"}`}</Text>
      <View class="flex-row flex-wrap gap-2">
        <Btn small label="Replay is over" onPress={() => lab.set({ phase: "idle" })} />
        <Btn small label="Person asks" onPress={() => void lab.port.send("go", [], [])} />
        <Btn small label="Agent starts" onPress={() => lab.message("One")} />
        <Btn small label="Agent streams" onPress={() => lab.stream(" two")} />
        <Btn small label="Turn ends" onPress={() => lab.finish()} />
      </View>
    </View>
  );
}

function Keeper() {
  const ref = signal<SessionRef | undefined>(undefined);
  const failure = signal("");
  void (async () => {
    try {
      const routes = await Sessions.probe("local");
      ref.set(await Sessions.start("local", { agent: routes[0]!.id, cwd: tree }));
    } catch (e) {
      failure.set(e instanceof Error ? e.message : String(e));
    }
  })();
  return (
    <View class="min-h-0 flex-1">
      <If when={failure()}>
        <Text role="alert" class="text-sm text-destructive">{`Could not start: ${failure()}`}</Text>
      </If>
      <If when={ref()}>{(r) => <SessionTab machine={r().machine} id={r().id} active />}</If>
    </View>
  );
}

function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <If when={params.mode === "scripted"} else={params.mode === "model" ? <ModelProbe /> : <Keeper />}>
          <Scripted />
        </If>
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
