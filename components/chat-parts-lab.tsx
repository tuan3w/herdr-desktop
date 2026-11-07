import { computed, host, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Sessions } from "herdr-desktop/native";
import type { DiffItem, QuestionFieldView, SessionRef, SessionView, WaitingView } from "herdr-desktop/native";
import { revision, startHerdr } from "../lib/herdr";
import { endSessions } from "./chat-parts-seam";
import { NewSession } from "./new-session";
import { PastSessions } from "./past-sessions";
import { PermissionDiff } from "./permission-diff";
import { PermissionDock } from "./permission-dock";
import { SessionModeChip, SessionModelPicker } from "./session-config";
import { SessionOverview } from "./session-overview";
import { SessionQuestion } from "./session-question";
import { Field, ThemeRoot, ToastHost } from "./kit";

/**
 * The entry of the chat parts' tests (`permission-dock.test.tsx`, `session-question.test.tsx`, `new-session.test.tsx`,
 * `session-overview.test.tsx`) and of their screenshots: `part` (a launch parameter) picks what is on the page.
 * - `live`: a real keeper driving the scripted ACP agent; the dock and the form show what the agent asks.
 * - `synthetic`: a made-up `SessionView` of a session that does not exist, to drive the dock through states the
 *   scripted agent cannot reach (a risky command, a standing grant, a queue); answering reaches no agent and is
 *   refused by the engine, which is exactly what the tests look for.
 * - `new-session`, `past`, `ghost` (the details of a session that is not this app's): the dialogs. Not part of the app.
 * `endAfter` ends the live session that many milliseconds after it started, for runs that end the process early.
 */
const params = host.params as { part?: string; variant?: string; project?: { machine: string; folder: string }; agent?: string; bare?: boolean; quiet?: boolean; endAfter?: number };
startHerdr("", "empty");
const MACHINE = "local";

/** A command that does not fit the box: a hundred steps of one pipeline. */
const LONG_COMMAND = Array.from({ length: 120 }, (_, i) => `echo step${i}`).join(" && ");

const permission = (over: Partial<WaitingView> = {}): WaitingView => ({
  requestId: "r1",
  digest: "d1",
  ask: "permission",
  arrivedMs: 0,
  title: "Bash",
  toolKind: "execute",
  subject: "git push origin main",
  choices: [
    { id: "allow", name: "Allow once", kind: "allow_once", standing: false },
    { id: "always", name: "Always allow", kind: "allow_always", standing: true },
    { id: "reject", name: "Reject", kind: "reject_once", standing: false },
  ],
  fields: [],
  ...over,
});

const field = (over: Partial<QuestionFieldView>): QuestionFieldView => ({
  name: "f",
  label: "Field",
  required: false,
  secret: false,
  kind: "text",
  integer: false,
  choices: [],
  text: "",
  ticked: [],
  ...over,
});
const titled = (...names: string[]) => names.map((title) => ({ value: title.toLowerCase(), title }));

/** A form with one field of every kind the app draws, and one it cannot. */
const QUESTION = permission({
  requestId: "q1",
  digest: "dq1",
  ask: "question",
  message: "Set up the project",
  description: "The agent needs a few answers before it continues.",
  choices: [],
  fields: [
    field({ name: "name", label: "Project name", required: true, text: "demo" }),
    field({ name: "count", label: "How many", kind: "number", integer: true, text: "3" }),
    field({ name: "colour", label: "Colour", kind: "choice", choices: titled("Red", "Green", "Blue"), choice: 0 }),
    field({ name: "city", label: "City", kind: "choice", choices: titled("Hanoi", "Hue", "Da Nang", "Saigon", "Can Tho", "Hai Phong", "Nha Trang") }),
    field({ name: "extras", label: "Extras", kind: "multi", choices: titled("Tests", "Docs", "CI"), ticked: [0] }),
    field({ name: "go", label: "Proceed", kind: "bool" }),
    field({ name: "blob", label: "Attachment", kind: "unsupported" }),
    field({ name: "key", label: "Token", secret: true, description: "Used once." }),
  ],
});

/** A deploy script of a dozen lines: it fills the command box without overflowing it much. */
const SCRIPT = ["set -e", "cd /srv/app", "git fetch origin", "git checkout main", "git pull --ff-only", "npm ci", "npm run build", "npm test -- --run", "rsync -a dist/ deploy@prod:/srv/app/dist/", "ssh deploy@prod 'systemctl restart app'", "curl -fsS https://app.example.com/health", "git tag release-$(date +%F)", "git push origin main --tags"].join("\n");

const VARIANTS: Record<string, WaitingView> = {
  question: QUESTION,
  full: permission({ subject: SCRIPT, risk: "pushes to a remote", title: "Deploy the app" }),
  plain: permission({ subject: "ls -la", title: "Bash", choices: permission().choices.filter((c) => c.id !== "always") }),
  risky: permission({ risk: "pushes to a remote" }),
  long: permission({ subject: LONG_COMMAND, title: "Bash" }),
  longRisky: permission({ subject: LONG_COMMAND, risk: "pushes to a remote" }),
};

const base = (waiting: WaitingView[], withPlan: boolean): SessionView => ({
  revision: 1,
  phase: "blockedOnPermission",
  connectionLost: false,
  acp: { canResume: false, canList: false, canClose: false, canLogout: false, acceptsAudio: false, acceptsEmbedded: false, auth: [] },
  agent: "omp",
  cwd: "/work/app",
  title: "Fix the build",
  itemCount: 0,
  droppedItems: 0,
  waiting,
  queue: [],
  commands: [],
  options: [],
  plan: withPlan
    ? [
        { content: "Read the failing test", status: "completed" },
        { content: "Fix the import", status: "inProgress" },
        { content: "Run the suite", status: "pending" },
      ]
    : [],
  running: true,
  acceptsPictures: false,
});

const DIFFS: DiffItem[] = [{ path: "src/main.ts", old: "const a = 1;\nconst b = 2;\n", new: "const a = 1;\nconst b = 3;\nconst c = 4;\n", added: 2, removed: 1 }];

function Synthetic() {
  const first = VARIANTS[params.variant ?? "plain"] ?? VARIANTS.plain!;
  const waiting = signal<WaitingView[]>([first]);
  const view = computed(() => base(waiting(), !params.bare));
  return (
    <View class="gap-2">
      <If when={!params.bare && !params.quiet}>
        <View class="gap-2">
          <Button onPress={() => waiting.set([{ ...waiting()[0]!, requestId: "r2", digest: "d2", subject: "git push --force origin main" }])}>
            <Text>Another request</Text>
          </Button>
          <Button onPress={() => waiting.set([...waiting(), permission({ requestId: "r3", digest: "d3" })])}>
            <Text>Queue one more</Text>
          </Button>
          <Button onPress={() => waiting.set([])}>
            <Text>Answered elsewhere</Text>
          </Button>
          <Button onPress={() => waiting.set([permission({ requestId: "p9", digest: "dp9" }), ...waiting()])}>
            <Text>A permission takes the dock</Text>
          </Button>
          <Button onPress={() => waiting.set(waiting().slice(1))}>
            <Text>The first request is answered</Text>
          </Button>
        </View>
      </If>
      <Text class="text-xs text-muted-foreground">{`Waiting: ${waiting().length}`}</Text>
      <PermissionDock machine={MACHINE} id="ghost" view={view()} />
      <SessionQuestion machine={MACHINE} id="ghost" view={view()} />
      <If when={params.variant === "diff" || params.variant === "full"}>
        <PermissionDiff diffs={DIFFS} />
      </If>
    </View>
  );
}

function Live() {
  const ref = signal<SessionRef | undefined>(undefined);
  const stale = signal(false);
  const details = signal(false);
  const failure = signal("no error");
  const pulled = computed(() => {
    revision();
    const r = ref();
    return r ? (Sessions.view(r.machine, r.id) ?? undefined) : undefined;
  });
  // A view whose request carries a fingerprint the session no longer has: what a window that missed an update would show.
  const shown = computed(() => {
    const v = pulled();
    if (!v || !stale()) return v;
    return { ...v, waiting: v.waiting.map((w) => ({ ...w, digest: "0000000000000000" })) };
  });
  const said = computed(() => {
    revision();
    const r = ref();
    if (!r) return "";
    return Sessions.items(r.machine, r.id, 0, 200)
      .filter((i) => i.kind === "message" && i.role === "agent")
      .map((i) => i.text)
      .join(" | ");
  });
  const say = (text: string) => async () => {
    const r = ref();
    if (!r) return;
    const result = await Sessions.send(r.machine, r.id, text, []);
    if (result.kind !== "done" && result.kind !== "queued") failure.set(result.message);
  };
  return (
    <View class="gap-2">
      <Text>{`Phase: ${pulled()?.phase ?? "none"}`}</Text>
      <Text>{`Waiting: ${pulled()?.waiting.length ?? 0}`}</Text>
      <Text>{`Agent said: ${said() || "nothing"}`}</Text>
      <Text>{failure()}</Text>
      <View class="flex-row flex-wrap gap-2">
        <Button
          onPress={async () => {
            try {
              const routes = await Sessions.probe(MACHINE);
              ref.set(await Sessions.start(MACHINE, { agent: routes[0]!.id, cwd: "/" }));
              // A keeper outlives its app, and a screenshot or audit run ends the process before anything can clean up.
              if (params.endAfter) setTimeout(() => void endSessions(), params.endAfter);
            } catch (e) {
              failure.set((e as Error).message);
            }
          }}
        >
          <Text>Start a session</Text>
        </Button>
        <Button onPress={say("plain")}>
          <Text>Say plain</Text>
        </Button>
        <Button onPress={say("ask")}>
          <Text>Say ask</Text>
        </Button>
        <Button onPress={say(`perm:${LONG_COMMAND}`)}>
          <Text>Say long</Text>
        </Button>
        <Button onPress={() => stale.set(true)}>
          <Text>Show a stale request</Text>
        </Button>
        <Button onPress={() => details.set(true)}>
          <Text>Open details</Text>
        </Button>
        <Button onPress={() => void endSessions()}>
          <Text>End all sessions</Text>
        </Button>
      </View>
      <If when={shown()}>
        {(view) => (
          <>
            <PermissionDock machine={MACHINE} id={ref()!.id} view={view()} />
            <SessionQuestion machine={MACHINE} id={ref()!.id} view={view()} />
            <View class="flex-row items-center gap-2">
              <SessionModeChip machine={MACHINE} id={ref()!.id} />
              <SessionModelPicker machine={MACHINE} id={ref()!.id} />
            </View>
          </>
        )}
      </If>
      <If when={ref()}>{(r) => <SessionOverview open={details()} onClose={() => details.set(false)} machine={r().machine} id={r().id} />}</If>
    </View>
  );
}

function Dialogs() {
  const open = signal(true);
  const opened = signal("nothing opened");
  const part = params.part;
  return (
    <View class="gap-2">
      <Text class="text-xs text-muted-foreground">{opened()}</Text>
      <Button onPress={() => open.set(true)}>
        <Text>Open the dialog</Text>
      </Button>
      <If when={part === "new-session"}>
        <NewSession open={open()} project={params.project} onClose={() => open.set(false)} onStarted={(m, id) => opened.set(`Opened ${m}/${id}`)} />
      </If>
      <If when={part === "past"}>
        <PastSessions open={open()} machine={MACHINE} agent={params.agent} onClose={() => open.set(false)} onResumed={(m, id) => opened.set(`Opened ${m}/${id}`)} />
      </If>
      <If when={part === "ghost"}>
        <SessionOverview open={open()} onClose={() => open.set(false)} machine={MACHINE} id="ghost" />
      </If>
    </View>
  );
}

function Lab() {
  const draft = signal("");
  return (
    <ThemeRoot>
      <View class="flex-1 gap-3 bg-background p-4">
        <If when={params.part === "live"}>
          <Live />
        </If>
        <If when={params.part === "synthetic"}>
          <Synthetic />
        </If>
        <If when={params.part !== "live" && params.part !== "synthetic"}>
          <Dialogs />
        </If>
        {/* The chat's message box, so a screen of only buttons has the one focusable thing the real tab always has. */}
        <If when={!params.bare}>
          <Field multiline label="" placeholder="Message the agent" value={draft()} onChange={(v) => draft.set(v)} />
        </If>
      </View>
      <ToastHost />
    </ThemeRoot>
  );
}

mount(Lab);
