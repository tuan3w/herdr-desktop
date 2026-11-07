import { host, mount, signal, Text, View } from "nsh";
import { Files as MachineFiles, Sessions } from "herdr-desktop/native";
import type { AcpView, ActionResult, DiffItem, PlanStepView, QueuedView, SessionItem, SessionRef, SessionView, ToolItem } from "herdr-desktop/native";
import { startHerdr } from "#lib/herdr";
import { createSessionModel, type SessionPort } from "#lib/session";
import { loadSettings } from "#lib/settings";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { SessionChat, SessionTab } from "#components/session-tab";

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
const params = host.params as { mode?: "keeper" | "scripted" | "model"; scene?: string; quiet?: boolean; rows?: number; only?: "user" | "agent" };
startHerdr("", "empty");
void loadSettings();
/** The synthetic folder the test seam copied (`fixtures/files/project`): the session's folder, so `@` lists real files. */
const tree = MachineFiles.testTree();

/** What ACP says besides the rows, with nothing to say. */
const ACP: AcpView = { canResume: false, canList: false, canClose: false, canLogout: false, acceptsAudio: false, acceptsEmbedded: false, auth: [] };

let next = 1;
const say = (role: "user" | "agent" | "thought", text: string): SessionItem => ({ id: next++, rev: 1, kind: "message", role, text, images: [], parts: [] });
const note = (text: string): SessionItem => ({ id: next++, rev: 1, kind: "note", text, images: [], parts: [] });
const done = (text: string, ok = true): SessionItem => ({ id: next++, rev: 1, kind: "done", text, ok, images: [], parts: [] });
const call = (title: string, over: Partial<ToolItem> = {}): SessionItem => ({
  id: next++,
  rev: 1,
  kind: "tool",
  images: [],
  parts: [],
  tool: { id: `t${next}`, title, toolKind: "execute", status: "completed", head: [], tail: [], omitted: 0, diffs: [], locations: [], parts: [], terminal: false, ...over },
});

/** `item` with the agent's own times, in milliseconds since the session was attached. */
const timed = (item: SessionItem, startedMs: number, endedMs?: number): SessionItem => ({ ...item, startedMs, endedMs });

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
          say("user", "Fix ACME-412: EU promo codes skip regional tax at checkout. Split the tests off and report back."),
          say("thought", "The tax rules live in src/tax; the promo code path never calls them."),
          call("Read src/tax/rules.ts", { toolKind: "read", subject: `${tree}/src/tax/rules.ts` }),
          call("Edit src/auth.ts", { toolKind: "edit", subject: `${tree}/src/auth.ts`, diffs: [EDIT] }),
          call("Run: pnpm test", { toolKind: "execute", subject: "pnpm test", status: "failed", head: OUTPUT.slice(0, 6), tail: ["FAIL src/case-9.test.ts", "1 failed, 39 passed", "", "Ran all test suites."], omitted: 20 }),
          call("tax-rules", { toolKind: "task", subject: "tax-rules", status: "completed", head: ["Fixed. Promo discounts now apply after VAT for EU regions, and 11 tax tests pass."] }),
          call("Running pnpm test promo-eu", { toolKind: "execute", subject: "pnpm test promo-eu", status: "inProgress" }),
        ],
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
            { id: 1, text: "Also add a regression test for the callback", files: [] },
            { id: 2, text: "Then update the changelog", files: [`${tree}/README.md`] },
          ],
          commands: [
            { name: "compact", description: "Summarise the conversation to free context" },
            { name: "review", description: "Review the changes on this branch", hint: "<branch>" },
          ],
        },
        items: [say("user", "Fix the login redirect loop."), call("Read src/auth.ts", { toolKind: "read", subject: `${tree}/src/auth.ts` }), say("agent", "Found it: `login` always redirects to `/callback`.")],
      };
    case "long":
      return {
        view: { running: false, phase: "idle", earlierNotice: "Earlier messages are no longer kept" },
        items: Array.from({ length: params.rows ?? 400 }, (_, i) =>
          params.only === "agent" || (params.only !== "user" && i % 2 === 1)
            ? say("agent", `Answer ${(i - 1) / 2 + 1}: here is what the code does at that point.`)
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
    case "signin":
      return {
        view: {
          phase: "authRequired",
          acp: {
            ...ACP,
            auth: [
              { id: "login", name: "Use existing local credentials", description: "Sign in with the login this machine already has." },
              { id: "account", name: "Sign in with an account", description: "Opens the agent's own sign-in." },
              { id: "term", name: "Log in in a terminal", description: "The agent signs in in a terminal.", terminalArgs: ["--login", "--provider", "my cloud"] },
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
          timed(call("Run: grep -rn callback src", { toolKind: "execute", subject: "grep -rn callback src", head: ["src/auth.ts:12: redirect('/callback')", "src/routes.ts:4: route('/callback', handler)"] }), 3600, 7200),
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
    send: async (text, files) => {
      told(`send ${text}${files.length > 0 ? ` +${files.join(",")}` : ""}`);
      if (view.running) {
        queued = [...queued, { id: 100 + queued.length, text, files }];
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
      return { text: q.text, files: q.files };
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

function Scripted() {
  const lab = scripted(scene(params.scene ?? "chat"));
  return (
    <View class="min-h-0 flex-1">
      <If when={!params.quiet}>
        <View class="flex-row flex-wrap items-center gap-2 border-b border-border p-2">
          <Btn small label="Agent says more" onPress={() => lab.stream(" And more text arrives.")} />
          <Btn small label="Agent starts a message" onPress={() => lab.message("A new answer, started while you were reading.")} />
          <Btn small label="Add unknown kind" onPress={() => lab.add({ id: next++, rev: 1, kind: "hologram", text: "Something new", images: [], parts: [] } as unknown as SessionItem)} />
          <Btn small label="Start a call" onPress={() => lab.add(call("Running pnpm lint", { toolKind: "execute", subject: "pnpm lint", status: "inProgress" }))} />
          <Btn small label="Advance plan" onPress={() => lab.plan([{ content: "Reproduce the redirect loop", status: "completed" }, { content: "Make login honour the requested page", status: "completed" }, { content: "Run the tests", status: "inProgress" }])} />
          <Btn small label="Request waits" onPress={() => lab.set({ phase: "blockedOnPermission", waiting: [{ requestId: "r1", digest: "d1", ask: "permission", arrivedMs: 0, title: "Run: git push", subject: "git push origin main", choices: [], fields: [] }] })} />
          <Btn small label="Finish the turn" onPress={() => lab.finish()} />
          <Btn small label="Lose the connection" onPress={() => lab.set({ connectionLost: true })} />
          <Btn small label="Agent answers" onPress={() => lab.answer()} />
          <Btn small label="I signed in elsewhere" onPress={() => lab.signedInElsewhere()} />
        </View>
        <Text class="px-3 text-xs text-muted-foreground">{`Tree: ${tree}`}</Text>
        <Text class="px-3 py-1 text-xs text-muted-foreground">{`Log: ${lab.log().join(" | ") || "nothing yet"}`}</Text>
      </If>
      <SessionChat machine="local" id="scripted" active port={lab.port} open={false} />
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
        <Btn small label="Person asks" onPress={() => void lab.port.send("go", [])} />
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
