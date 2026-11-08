import { host, mount, Text, View } from "nsh";

import { Sidebar } from "#components/sidebar";
import { StatusGlyph } from "#components/status-glyph";
import { Btn, compact, Icon, IconButton, PopupRoot, snug, TabBar, TabItem, ThemeRoot, ToastHost } from "#kit";
import type { IconName } from "#kit";
import { startHerdr } from "#lib/herdr";
import { RAIL_WIDTH, SIDEBAR_WIDTH } from "#lib/layout";
import { boardFront } from "#lib/settings";
import { loadSidebar } from "#lib/sidebar";
import type { AgentStatus } from "#lib/status";

/**
 * THROWAWAY prototype lab (not the app), rung 1: where does a second region live in a wide window? Stand-ins from the kit,
 * the REAL `Sidebar` over the fake herdr (`mixed`), every pane's content INVENTED and synthetic. The variant is the launch
 * parameter `fixture` (the data is always `mixed`):
 *
 *   baseline          today: one chat, the tab strip hidden (design/tabs.md)
 *   baseline-changes  today: Changes opened as a tab, which replaces the chat (and the waiting question with it)
 *   s                 smallest change: the existing split made visible, chat beside Changes in two columns
 *   i                 inspector: chat at its measure + a right panel (Changes open)
 *   i-subagents       the same panel with Subagents open
 *   w                 wall: a grid of live agent cards (the sidebar is the rail, as the Board does)
 *   c                 combination: two chats side by side + the inspector following the focused one
 *
 * INVENTED: the answer dock, every conversation line, the diff, subagent roster, durations and tool counts, the cards'
 * last six pane rows (herdr gives rows, but never a time of last output), the icons for split and inspector (the kit has
 * no `panel-right` or `columns` icon: `list` and `panel-left` stand in).
 */
const params = host.params as { fixture?: string };
const variant = typeof params.fixture === "string" ? params.fixture : "baseline";
startHerdr("", "mixed");
void loadSidebar();
if (variant === "w") boardFront.set(true);

/** The default theme of a lab has no `success` token: a stand-in green. */
const GREEN = "#2fa35f";
const NUM: { fontVariant: "tabular-nums"[] } = { fontVariant: ["tabular-nums"] };
const sideWidth = () =>
  compact() || variant === "w" ? RAIL_WIDTH : snug() ? SIDEBAR_WIDTH.narrow : SIDEBAR_WIDTH.default;
const noop = () => {};
/** The inspector docks only in a wide window; at 960 it overlays, under 900 it is the one region (see `Main`). */
const docked = () => !snug();
const INSPECTOR = 380;

/** One header line of a region: 40 pt, a hairline under it. */
function Header(props: { title: string; sub?: string; focus?: boolean; children?: unknown }) {
  return (
    <View
      class={`h-10 flex-row items-center gap-2 border-b border-border px-3 ${props.focus ? "border-t-2 border-t-primary" : ""}`}
    >
      <Text class="shrink text-sm font-medium text-foreground">{props.title}</Text>
      <Text class="flex-1 text-xs text-muted-foreground">{props.sub ?? ""}</Text>
      {props.children as never}
    </View>
  );
}

function Fold(props: { text: string; count?: string; bad?: string }) {
  return (
    <View class="flex-row items-center gap-2 py-1">
      <Text class="text-sm text-muted-foreground">{props.text}</Text>
      <If when={props.count}>
        <Text style={{ color: GREEN }} class="text-sm">
          {props.count}
        </Text>
      </If>
      <If when={props.bad}>
        <Text class="text-sm text-destructive">{props.bad}</Text>
      </If>
      <Icon name="chevron-right" size={12} tone="muted-foreground" />
    </View>
  );
}

/** The conversation, ranked by consequence: prose, folded lines, one effect outside the tree, then the question. */
function Conversation(props: { tight?: boolean; working?: string }) {
  const gap = props.tight ? "gap-2" : "gap-3";
  return (
    <View class={`flex-1 overflow-hidden ${props.tight ? "px-3 pt-3" : "px-6 pt-6"} ${gap}`}>
      <View class="self-end rounded-lg bg-muted px-3 py-2">
        <Text class="text-base text-foreground">
          Ledger totals are off by a cent after a refund. Find out why and fix it.
        </Text>
      </View>
      <Text class="text-base text-foreground">
        I'll start with how the refund path rounds, then check the totals it feeds.
      </Text>
      <Fold text="Read 6 files, searched 3 times" />
      <Text class="text-base text-foreground">
        Refunds round half-up per line, the ledger rounds half-even per total: that is the cent. One rule everywhere
        fixes it.
      </Text>
      <Fold text="Edited post.rs" count="+14" bad={"−3"} />
      <Fold text="Ran 2 commands, 1 failed" />
      <If when={!props.tight}>
        <Text class="text-base text-foreground">
          One test still fails on a fixture that expected the old cent. I need to run it again.
        </Text>
      </If>
      <If when={props.working}>
        <Text class="text-sm text-muted-foreground">{props.working}</Text>
      </If>
    </View>
  );
}

/** The one answer dock, replacing the composer: the exact command, two choices. A stand-in, no guard. */
function Dock(props: { tight?: boolean }) {
  return (
    <View class={`gap-2 ${props.tight ? "p-3" : "px-6 pb-4"}`}>
      <View class="gap-2 rounded-xl border border-border p-3">
        <Text class="text-xs text-muted-foreground">Wants to run</Text>
        <Text class="font-mono text-xs text-foreground">cargo test -p ledger refund_rounding</Text>
        <View class="flex-row gap-2">
          <Btn label="Allow once" onPress={noop} />
          <Btn label="Deny" variant="outline" onPress={noop} />
        </View>
      </View>
    </View>
  );
}

function Composer(props: { tight?: boolean }) {
  return (
    <View class={props.tight ? "p-3" : "px-6 pb-4"}>
      <View class="h-10 justify-center rounded-xl border border-border px-3">
        <Text class="text-sm text-muted-foreground">Message auth</Text>
      </View>
    </View>
  );
}

function ChatPane(props: {
  title: string;
  sub: string;
  actions?: unknown;
  tight?: boolean;
  dock?: boolean;
  focus?: boolean;
  working?: string;
}) {
  return (
    <View class="min-w-0 flex-1">
      <Header title={props.title} sub={props.sub} focus={props.focus}>
        {props.actions}
      </Header>
      <View class="min-h-0 flex-1 items-center">
        <View class="w-full flex-1" style={{ maxWidth: 768 }}>
          <Conversation tight={props.tight} working={props.working} />
          <If when={props.dock} else={<Composer tight={props.tight} />}>
            <Dock tight={props.tight} />
          </If>
        </View>
      </View>
    </View>
  );
}

const FILES: Array<[string, string, string, string, string]> = [
  ["M", "post.rs", "src/ledger/", "+14", "−3"],
  ["M", "refund.rs", "src/ledger/", "+9", "−2"],
  ["M", "rounding.rs", "src/money/", "+6", "−1"],
  ["A", "half_even.rs", "src/money/", "+22", ""],
  ["M", "post_test.rs", "tests/", "+8", "−2"],
  ["U", "notes.md", "docs/", "+4", ""],
];

function FileRow(props: { f: [string, string, string, string, string]; on?: boolean; bare?: boolean }) {
  return (
    <View class={`min-h-8 flex-row items-center gap-2 rounded-md px-3 ${props.on ? "bg-accent" : ""}`}>
      <Text class="w-4 text-center text-xs font-medium text-muted-foreground">{props.f[0]}</Text>
      <Text class="text-sm text-foreground">{props.f[1]}</Text>
      <Text class="flex-1 text-xs text-muted-foreground">{props.bare ? "" : props.f[2]}</Text>
      <Text style={{ color: GREEN }} class="text-xs">
        {props.f[3]}
      </Text>
      <Text style={NUM} class="w-6 text-right text-xs text-destructive">
        {props.f[4]}
      </Text>
    </View>
  );
}

type Dl = [string, string, "add" | "del" | "ctx"];
const DIFF: Dl[] = [
  ["41", "fn post(line: &Line) -> Cents {", "ctx"],
  ["42", "    let raw = line.amount * line.rate;", "ctx"],
  ["43", "    round_half_up(raw)", "del"],
  ["43", "    round_half_even(raw)", "add"],
  ["44", "}", "ctx"],
  ["45", "", "ctx"],
  ["46", "fn refund(line: &Line) -> Cents {", "ctx"],
  ["47", "    -round_half_up(line.amount)", "del"],
  ["47", "    -round_half_even(line.amount)", "add"],
  ["48", "}", "ctx"],
];

function Diff(props: { lines?: number }) {
  return (
    <View class="min-h-0 flex-1 overflow-hidden">
      {DIFF.slice(0, props.lines ?? DIFF.length).map((l) => (
        <View
          style={l[2] === "add" ? { backgroundColor: "rgba(47,163,95,0.12)" } : undefined}
          class={`min-h-5 flex-row gap-2 px-3 ${l[2] === "del" ? "bg-destructive/10" : ""}`}
        >
          <Text style={NUM} class="w-5 text-right font-mono text-xs text-muted-foreground">
            {l[0]}
          </Text>
          <Text class="w-3 font-mono text-xs text-muted-foreground">
            {l[2] === "add" ? "+" : l[2] === "del" ? "−" : " "}
          </Text>
          <Text class="font-mono text-xs text-foreground">{l[1]}</Text>
        </View>
      ))}
    </View>
  );
}

/** Context line of the Changes view, as `design/changes.md`: project, branch, who; then the totals. */
function ChangesContext() {
  return (
    <View class="min-h-8 flex-row items-center gap-2 px-3">
      <Text class="flex-1 text-xs text-muted-foreground">payments-api · fix-rounding · by claude</Text>
      <Text style={NUM} class="text-xs text-muted-foreground">
        6 files
      </Text>
      <Text style={{ color: GREEN }} class="text-xs">
        +63
      </Text>
      <Text style={NUM} class="text-xs text-destructive">
        {"−8"}
      </Text>
    </View>
  );
}

/** Changes as the main-region tab does it today (and variant S): the list left, the change right. */
function ChangesTwoPane(props: { listWidth: number }) {
  return (
    <View class="min-h-0 flex-1">
      <ChangesContext />
      <View class="min-h-0 flex-1 flex-row border-t border-border">
        <View class="gap-1 border-r border-border p-1" style={{ width: props.listWidth }}>
          {FILES.map((f, i) => (
            <FileRow f={f} on={i === 0} bare={props.listWidth < 240} />
          ))}
        </View>
        <View class="min-w-0 flex-1 pt-2">
          <Text class="px-3 pb-2 text-sm font-medium text-foreground">src/ledger/post.rs</Text>
          <Diff />
        </View>
      </View>
    </View>
  );
}

const SUBS: Array<[AgentStatus, string, string, string]> = [
  ["working", "tax-rules", "12 tools", "running 4m"],
  ["done", "ledger-audit", "31 tools", "9m"],
  ["done", "migration-check", "8 tools", "3m"],
  ["done", "test-writer", "17 tools", "6m"],
];

function SubagentsTab() {
  return (
    <View class="min-h-0 flex-1 gap-1 p-1">
      {SUBS.map((s, i) => (
        <View class={`min-h-8 flex-row items-center gap-2 rounded-md px-3 ${i === 0 ? "bg-accent" : ""}`}>
          <StatusGlyph status={s[0]} />
          <Text class="flex-1 text-sm text-foreground">{s[1]}</Text>
          <Text style={NUM} class="text-xs text-muted-foreground">
            {s[2]}
          </Text>
          <Text style={NUM} class="w-20 text-right text-xs text-muted-foreground">
            {s[3]}
          </Text>
        </View>
      ))}
      <View class="mt-2 gap-1 px-3">
        <Text class="text-xs text-muted-foreground">Assignment</Text>
        <Text class="text-sm text-foreground">
          Check the rounding rules in src/tax and report where they differ from the ledger. Report only.
        </Text>
        <Text class="pt-2 text-xs text-muted-foreground">Read-only: open its conversation</Text>
      </View>
      <View class="mt-4 gap-1 px-3">
        <Text class="text-xs text-muted-foreground">Background</Text>
        <Text class="text-sm text-foreground">cargo watch -x test · running 14m</Text>
      </View>
    </View>
  );
}

function OverviewTab() {
  const rows: Array<[string, string]> = [
    ["Runs on", "This computer"],
    ["Folder", "~/dev/payments-api"],
    ["Branch", "fix-rounding"],
    ["Context", "11% used"],
    ["Mode", "Auto"],
  ];
  return (
    <View class="gap-2 p-3">
      {rows.map((r) => (
        <View class="min-h-8 flex-row items-center justify-between">
          <Text class="text-sm text-muted-foreground">{r[0]}</Text>
          <Text class="text-sm text-foreground">{r[1]}</Text>
        </View>
      ))}
    </View>
  );
}

type Tab = "Overview" | "Changes" | "Files" | "Terminal" | "Subagents";

/** The right panel: a tab strip, then one view. Changes stacks the list over the diff because 380 pt is too narrow for two columns. */
function Inspector(props: { tab: Tab; width?: number; overlay?: boolean; follow?: string }) {
  return (
    <View
      class={`border-l border-border bg-background ${props.overlay ? "absolute bottom-0 right-0 top-0 shadow-md" : ""}`}
      style={{ width: props.width ?? INSPECTOR }}
    >
      <View class="h-10 flex-row items-center justify-between border-b border-border px-2">
        <TabBar label="Inspector">
          {(["Changes", "Files", "Terminal", "Subagents"] as Tab[]).map((t) => (
            <TabItem
              label={t}
              selected={t === props.tab}
              onSelect={noop}
              count={t === "Changes" ? 6 : t === "Subagents" ? 4 : undefined}
            />
          ))}
        </TabBar>
        <IconButton icon="x" label="Hide inspector" onPress={noop} />
      </View>
      <If when={props.follow}>
        <Text class="px-3 pt-2 text-xs text-muted-foreground">{props.follow}</Text>
      </If>
      <If when={props.tab !== "Changes"}>
        <View class="min-h-8 justify-center border-b border-border px-3">
          <Text class="text-xs text-muted-foreground">This computer · fix-rounding · 11% of context</Text>
        </View>
      </If>
      <If when={props.tab === "Changes"}>
        <ChangesContext />
        <View class="gap-1 border-b border-t border-border p-1">
          {FILES.slice(0, 5).map((f, i) => (
            <FileRow f={f} on={i === 0} />
          ))}
        </View>
        <View class="min-h-0 flex-1 pt-2">
          <Text class="px-3 pb-2 text-sm font-medium text-foreground">src/ledger/post.rs</Text>
          <Diff />
        </View>
      </If>
      <If when={props.tab === "Subagents"}>
        <SubagentsTab />
      </If>
      <If when={props.tab === "Overview"}>
        <OverviewTab />
      </If>
    </View>
  );
}

const header = (children: unknown) => <>{children as never}</>;
const NAV: IconName = "list";

/** Sidebar (real) + hairline + main. Everything else is a variant of what goes in main. */
function Shell(props: { children?: unknown }) {
  return (
    <View class="flex-1 flex-row bg-background">
      <View style={{ width: sideWidth() }}>
        <Sidebar />
      </View>
      <View class="w-px bg-sidebar-border" />
      <View class="relative min-w-0 flex-1">{props.children as never}</View>
    </View>
  );
}

function Baseline() {
  return (
    <ChatPane
      title="payments-api · fix ledger rounding"
      sub=""
      dock
      actions={header(<IconButton icon="ellipsis" label="More" onPress={noop} />)}
    />
  );
}

function BaselineChanges() {
  return (
    <View class="min-w-0 flex-1">
      <Header title="Changes" sub="a dock tab of the project: it replaces the chat" />
      <ChangesTwoPane listWidth={248} />
    </View>
  );
}

function SplitS() {
  return (
    <View class="min-w-0 flex-1 flex-row">
      <ChatPane
        title="payments-api · fix ledger rounding"
        sub=""
        tight
        dock
        focus
        actions={header(
          <>
            <IconButton icon="panel-left" label="Open to the side" selected onPress={noop} />
            <IconButton icon="ellipsis" label="More" onPress={noop} />
          </>,
        )}
      />
      <View class="w-px bg-border" />
      <View class="min-w-0 flex-1">
        <Header title="Changes" sub="beside the chat">
          <IconButton icon="x" label="Close side" onPress={noop} />
        </Header>
        <ChangesTwoPane listWidth={216} />
      </View>
    </View>
  );
}

/** I: the chat keeps its measure, the inspector takes the surplus. At 960 it overlays; under 900 it is the one region. */
function InspectorI(props: { tab: Tab }) {
  const toggle = header(
    <>
      <IconButton icon={NAV} label="Hide inspector" selected onPress={noop} />
      <IconButton icon="ellipsis" label="More" onPress={noop} />
    </>,
  );
  return (
    <View class="min-w-0 flex-1 flex-row">
      <If when={!(compact() && true)} else={<Inspector tab={props.tab} width={9999} />}>
        <ChatPane title="payments-api · fix ledger rounding" sub="" dock actions={toggle} />
        <If when={docked()} else={<Inspector tab={props.tab} overlay />}>
          <Inspector tab={props.tab} />
        </If>
      </If>
    </View>
  );
}

function ComboC() {
  return (
    <View class="min-w-0 flex-1 flex-row">
      <ChatPane
        title="payments-api"
        sub="fix rounding"
        tight
        dock
        focus
        actions={header(<IconButton icon="x" label="Close side" onPress={noop} />)}
      />
      <View class="w-px bg-border" />
      <ChatPane
        title="auth"
        sub="session refresh"
        tight
        working="Editing src/auth/session.ts"
        actions={header(<IconButton icon="x" label="Close side" onPress={noop} />)}
      />
      <Inspector tab="Changes" width={304} follow="Following payments-api" />
    </View>
  );
}

/** The wall: nine live cards. INVENTED rows, in the way `PaneScreen` would give the last six. */
type Card = { status: AgentStatus; title: string; project: string; rows: string[]; ask?: string };
const CARDS: Card[] = [
  {
    status: "blocked",
    title: "fix ledger rounding",
    project: "payments-api",
    rows: [
      "running 14 tests",
      "test refund_rounding ... FAILED",
      "left: 1204",
      "right: 1203",
      "1 failed; 13 passed",
      "",
    ],
    ask: "Run cargo test -p ledger refund_rounding?",
  },
  {
    status: "blocked",
    title: "refresh tokens",
    project: "auth",
    rows: [
      "Reading src/auth/session.ts",
      "The refresh path never rotates",
      "the token, so a stolen one lives",
      "for 30 days.",
      "",
      "",
    ],
    ask: "Delete .cache/tokens.db?",
  },
  {
    status: "working",
    title: "table virtualisation",
    project: "web",
    rows: [
      "Editing src/table/rows.tsx",
      "+ const visible = slice(rows, top)",
      "+ const pad = top * ROW",
      "Running bun test",
      "PASS rows.test.tsx",
      "PASS scroll.test.tsx",
    ],
  },
  {
    status: "done",
    title: "docs pass",
    project: "auth",
    rows: ["Updated 4 files.", "README now says how to rotate", "a key. No code changed.", "", "Done.", ""],
  },
  {
    status: "working",
    title: "migration check",
    project: "payments-api",
    rows: [
      "Reading migrations/0042.sql",
      "Reading migrations/0043.sql",
      "Comparing schema.sql",
      "2 columns differ",
      "Writing the report",
      "",
    ],
  },
  { status: "idle", title: "meeting notes", project: "notes", rows: ["Waiting for input", "", "", "", "", ""] },
  { status: "idle", title: "backup script", project: "scripts", rows: ["Waiting for input", "", "", "", "", ""] },
  {
    status: "working",
    title: "dark theme tokens",
    project: "web",
    rows: [
      "Reading theme/dark.ts",
      "Editing theme/dark.ts",
      "+ muted: step(6)",
      "Running bun run check",
      "No errors.",
      "",
    ],
  },
  { status: "idle", title: "release notes", project: "web", rows: ["Waiting for input", "", "", "", "", ""] },
];

function WallCard(props: { c: Card; on?: boolean }) {
  return (
    <View
      class={`min-w-0 flex-1 gap-2 rounded-lg border p-3 ${props.on ? "border-primary bg-accent/40" : "border-border"}`}
    >
      <View class="flex-row items-center gap-2">
        <StatusGlyph status={props.c.status} />
        <Text class="flex-1 text-sm font-medium text-foreground">{props.c.title}</Text>
        <Text class="text-xs text-muted-foreground">{props.c.project}</Text>
      </View>
      <View>
        {props.c.rows.slice(0, props.c.ask ? 4 : 6).map((r) => (
          <Text class="min-h-4 font-mono text-xs text-muted-foreground">{r}</Text>
        ))}
      </View>
      <If when={props.c.ask}>
        <View class="gap-2">
          <Text class="text-xs text-foreground">{props.c.ask}</Text>
          <View class="flex-row gap-2">
            <Btn label="Allow once" small onPress={noop} />
            <Btn label="Deny" small variant="outline" onPress={noop} />
          </View>
        </View>
      </If>
    </View>
  );
}

function Wall() {
  return (
    <View class="min-w-0 flex-1">
      <Header title="Wall" sub="9 agents on this computer" />
      <View class="min-h-0 flex-1 gap-3 p-3">
        {[0, 1, 2].map((r) => (
          <View class="flex-1 flex-row gap-3">
            {CARDS.slice(r * 3, r * 3 + 3).map((c, i) => (
              <WallCard c={c} on={r === 0 && i === 0} />
            ))}
          </View>
        ))}
      </View>
    </View>
  );
}

function Pick() {
  switch (variant) {
    case "baseline-changes":
      return <BaselineChanges />;
    case "s":
      return <SplitS />;
    case "i":
      return <InspectorI tab="Changes" />;
    case "i-subagents":
      return <InspectorI tab="Subagents" />;
    case "w":
      return <Wall />;
    case "c":
      return <ComboC />;
    default:
      return <Baseline />;
  }
}

function Lab() {
  return (
    <ThemeRoot>
      <PopupRoot class="flex-1 bg-background">
        <Shell>
          <Pick />
        </Shell>
        <ToastHost />
      </PopupRoot>
    </ThemeRoot>
  );
}

mount(Lab);
