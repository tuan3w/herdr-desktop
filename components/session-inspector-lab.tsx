import { host, mount, signal, View } from "nsh";

import type {
  AcpView,
  ActionResult,
  BackgroundRow,
  ObservedView,
  SessionItem,
  SessionView,
  SubagentRow,
} from "herdr-desktop/native";

import { SessionChat } from "#components/session-tab";
import { Btn, PopupRoot, ThemeRoot, ToastHost } from "#kit";
import { startHerdr } from "#lib/herdr";
import type { SessionPort, SubagentPort } from "#lib/session";
import { inspectorOpen, showSubagent } from "#lib/session-inspector";
import { loadSettings } from "#lib/settings";

/**
 * The entry of `session-inspector.test.tsx` and the `inspector-*` screenshots: a chat read from a Claude Code pane whose log
 * (synthetic) names three subagents (one running in the background, one finished, one that fails) and five background
 * tasks, over a port of this file, so no herdr and no log are needed. Launch parameters, because a screenshot on a Mac
 * cannot press:
 * - `open`: the inspector starts open; `fails`: the failing subagent fails after the chat opened (a `Needs you`);
 * - `drill`: the inspector opens on the running subagent's conversation; `notimes`: the log gives no start or end times.
 * - `quiet`: no lab buttons.
 * Buttons: `Subagent fails`, `Log`. Not part of the app.
 */
const params = host.params as { open?: boolean; fails?: boolean; drill?: boolean; notimes?: boolean; quiet?: boolean };
startHerdr("", "empty");
void loadSettings();

const ACP: AcpView = {
  canResume: false,
  canList: false,
  canClose: false,
  canLogout: false,
  acceptsAudio: false,
  acceptsEmbedded: false,
  auth: [],
};
const MIN = 60_000;
const NOW = Date.now();
const at = (minutesAgo: number): number | undefined => (params.notimes ? undefined : NOW - minutesAgo * MIN);

let next = 1;
const say = (role: "user" | "agent", text: string): SessionItem => ({
  id: next++,
  rev: 1,
  kind: "message",
  role,
  text,
  images: [],
  parts: [],
});

// Markdown, as a lead agent writes an assignment: its conversation shows it formatted in the first bubble.
const AUDIT_PROMPT = [
  "Audit the auth module for session fixation.",
  "",
  "1. Read `src/auth/*.ts` and the middleware.",
  "2. List every place a session id is issued or rotated.",
  "3. Say which of them keep the old id after login.",
  "",
  "Do **not** change any file. Report in a table: file, line, what happens, risk.",
].join("\n");

function subagents(failed: boolean): SubagentRow[] {
  return [
    {
      name: "Audit auth module",
      agent: "general-purpose",
      status: "running",
      assignment: AUDIT_PROMPT,
      toolCount: 0,
      recentTools: [],
      startedMs: at(4),
      task: "0/a7d0c1",
    },
    {
      name: "List migrations",
      agent: "Explore",
      status: "completed",
      assignment: "List every migration under db/migrations with its date and what it changes. Keep it short.",
      toolCount: 6,
      recentTools: [],
      startedMs: at(41),
      endedMs: at(35),
    },
    {
      name: "Check schema drift",
      agent: "general-purpose",
      status: failed ? "failed" : "running",
      assignment: "Compare db/schema.sql with the live models and say where they drift. Then propose a migration.",
      toolCount: 3,
      recentTools: [],
      startedMs: at(9),
      endedMs: failed ? at(0) : undefined,
    },
  ];
}

const BACKGROUND: BackgroundRow[] = [
  {
    key: "0/a7d0c1",
    kind: "agent",
    status: "running",
    title: "Audit auth module",
    active: true,
    startedMs: at(4),
    stoppable: true,
  },
  {
    key: "0/b1",
    kind: "shell",
    status: "running",
    title: "cd /home/dev/payments && pnpm test --watch",
    detail: "cd /home/dev/payments && pnpm test --watch",
    active: true,
    startedMs: at(14),
    stoppable: true,
  },
  {
    key: "0/b2",
    kind: "monitor",
    status: "running",
    title: "Watch build.log for errors",
    active: true,
    startedMs: params.notimes ? undefined : NOW - 20_000,
    stoppable: true,
  },
  {
    key: "0/b3",
    kind: "shell",
    status: "finished",
    title: "pnpm build",
    detail: "pnpm build",
    active: false,
    startedMs: at(52),
    endedMs: at(50),
    stoppable: false,
  },
  {
    key: "0/b4",
    kind: "shell",
    status: "finished",
    title: "pnpm build",
    detail: "pnpm build",
    active: false,
    startedMs: at(130),
    endedMs: at(128),
    stoppable: false,
  },
  {
    key: "0/b5",
    kind: "shell",
    status: "stopped",
    title: "npm run dev",
    detail: "npm run dev -- --port 5173",
    active: false,
    startedMs: at(200),
    endedMs: at(180),
    stoppable: false,
  },
];

const log = signal<string[]>([]);
const told = (line: string) => log.update((all) => [...all, line]);
const ok = (): ActionResult => ({ kind: "done", message: "" });

/** A port over a fixed view: `change` makes a new revision. */
function viewPort(initial: SessionView, items: SessionItem[], extra: Partial<SessionPort> = {}) {
  const tick = signal(0);
  let view = initial;
  const port: SessionPort = {
    revision: tick,
    view: () => view,
    items: (start, count) => items.slice(start, start + count),
    itemIds: () => items.map((i) => i.id),
    send: async (text) => {
      told(`send ${text}`);
      return { kind: "blocked", message: "A subagent is steered through its parent agent." };
    },
    unqueue: async () => null,
    releaseQueue: async () => ok(),
    cancel: async () => ok(),
    reconnect: async () => {},
    authenticate: async () => ok(),
    reopen: async () => ok(),
    loadEarlier: async () => false,
    ...extra,
  };
  return {
    port,
    change: (over: Partial<SessionView>) => {
      view = { ...view, ...over, revision: view.revision + 1 };
      tick.update((n) => n + 1);
    },
    view: () => view,
  };
}

const base = (over: Partial<SessionView>): SessionView => ({
  revision: 1,
  phase: "working",
  connectionLost: false,
  agent: "claude",
  cwd: "/home/dev/payments",
  title: "Harden the session handling",
  itemCount: 0,
  droppedItems: 0,
  waiting: [],
  queue: [],
  commands: [],
  options: [],
  plan: [],
  running: true,
  acceptsPictures: false,
  acp: ACP,
  ...over,
});

const observed = (failed: boolean): ObservedView => ({
  paneId: "w1:p1",
  kind: "claude",
  label: "Claude Code",
  link: "following",
  turnEnded: false,
  subagents: subagents(failed),
  background: BACKGROUND,
  earlier: "none",
  answersQuestions: true,
});

/** A subagent's transcript: its assignment as its first message, then its work. */
function subagentPort(name: string): SubagentPort {
  const prompt = subagents(false).find((s) => s.name === name)?.assignment ?? "";
  const items = [
    say("user", prompt),
    say(
      "agent",
      name === "Audit auth module"
        ? "Reading `src/auth/session.ts` and `src/middleware/login.ts`. Two places issue a session id; one rotates it."
        : "Done.",
    ),
  ];
  const sub = viewPort(
    base({
      title: name,
      phase: "working",
      itemCount: items.length,
      observed: { ...observed(false), subagents: [], background: [] },
    }),
    items,
  );
  return {
    id: `sub:w1:p1#${name}`,
    port: sub.port,
    open: async () => told(`open ${name}`),
    close: () => told(`close ${name}`),
  };
}

const parentItems = [
  say("user", "Harden the session handling: find fixation bugs and fix them, with tests."),
  say(
    "agent",
    "I started three subagents: one audits the auth module, one lists the migrations, one checks the schema for drift. The test watcher runs in the background.",
  ),
];
const parent = viewPort(base({ itemCount: parentItems.length, observed: observed(false) }), parentItems, {
  stopBackground: async (key) => {
    told(`stop ${key}`);
    return ok();
  },
  subagent: subagentPort,
});
const fail = () => parent.change({ observed: observed(true) });

if (params.open || params.drill) inspectorOpen.set(true);
if (params.drill) showSubagent("Audit auth module");
// After the chat has shown its first view: a failure that arrives now is news, not history.
if (params.fails) setTimeout(fail, 300);

function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <View class="min-h-0 flex-1">
          <If when={!params.quiet}>
            <View class="flex-row flex-wrap items-center gap-2 border-b border-border p-2">
              <Btn small label="Subagent fails" onPress={fail} />
              <Btn small label={`Log: ${log().join(" | ") || "nothing yet"}`} onPress={() => {}} />
            </View>
          </If>
          <SessionChat machine="local" id="scripted" active port={parent.port} open={false} />
        </View>
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
