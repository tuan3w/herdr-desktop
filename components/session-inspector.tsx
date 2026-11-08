import { announce, cleanup, computed, effect, keymap, lifecycle, List, signal, Text, untracked, View } from "nsh";

import type { ObservedView } from "herdr-desktop/native";

import { SubagentChat } from "#components/subagent-chat";
import { Btn, Clipped, FOCUS_RING, FOCUS_RING_INSET, Icon, IconButton, NUM, notify, snug, Tipped } from "#kit";
import { hoverTransition } from "#lib/motion";
import { latest, type SessionPort } from "#lib/session";
import {
  CONFIRM_AFTER_MS,
  CONFIRM_MS,
  type Entry,
  INSPECTOR_READING_WIDTH,
  INSPECTOR_WIDTH,
  agoText,
  elapsedText,
  entriesOf,
  entryLabel,
  type FinishedGroup,
  finishedLine,
  inspectorOpen,
  pendingSubagent,
  runningLine,
  type Sections,
  sectionsOf,
  seedAcknowledged,
} from "#lib/session-inspector";
import { INSPECTOR_KEY, keyText } from "#lib/shortcuts";

/** What a terminal agent runs beside its chat, as the chat and its inspector share it. */
export interface Activity {
  entries: () => Entry[];
  sections: () => Sections;
  /** The clock rows are measured against: it moves once a minute while a row with a start time runs, else never. */
  now: () => number;
  /** The person has seen this failure: it leaves `Needs you` for `Finished`. */
  acknowledge(key: string): void;
  /** Every failure shown is seen. */
  clear(): void;
  /** Anything to show at all. */
  any: () => boolean;
}

/**
 * The activity of one chat. A failure that is already over when the chat first shows it is history; one that arrives
 * while the chat is open goes to `Needs you`, opens the inspector (once per failure) and is said aloud. `active`: the
 * tab is in front, which is when the clock may tick.
 */
export function createActivity(observed: () => ObservedView | undefined, active: () => boolean): Activity {
  const seen = signal<ReadonlySet<string>>(new Set());
  let seeded = false;
  const entries = computed(() => {
    const o = observed();
    return o ? entriesOf(o) : [];
  });
  effect(() => {
    const all = entries();
    if (seeded || !observed()) return;
    seeded = true;
    untracked(() => seen.set(seedAcknowledged(all)));
  });
  const sections = computed(() => sectionsOf(entries(), seen()));
  const now = signal(Date.now());
  // A minute is the smallest step a row shows: no timer at all while nothing with a start time runs or the tab is away.
  effect(() => {
    const ticking =
      active() && lifecycle() !== "background" && sections().running.some((e) => e.startedMs !== undefined);
    if (!ticking) return;
    untracked(() => now.set(Date.now()));
    const timer = setInterval(() => now.set(Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  const told = new Set<string>();
  effect(() => {
    const needs = sections().needs;
    const fresh = needs.filter((e) => !told.has(e.key));
    if (fresh.length === 0) return;
    for (const e of fresh) told.add(e.key);
    untracked(() => {
      inspectorOpen.set(true);
      announce(`Needs you: ${fresh.map((e) => `${e.name} failed`).join(", ")}`);
    });
  });
  return {
    entries,
    sections,
    now,
    acknowledge: (key) =>
      seen.update((s) => {
        if (s.has(key)) return s;
        const next = new Set(s);
        next.add(key);
        return next;
      }),
    clear: () => seen.update((s) => new Set([...s, ...sections().needs.map((e) => e.key)])),
    any: () => entries().length > 0,
  };
}

/**
 * The chat's one quiet line while the inspector is closed and something runs: `3 subagents running · Show`. It goes when
 * the inspector opens (the inspector says it there) and when nothing runs.
 */
export function ActivityLine(props: { activity: Activity }) {
  const line = () => runningLine(props.activity.sections().running);
  return (
    <If when={!inspectorOpen() && line()}>
      <View class="min-h-8 flex-row items-center gap-1 border-b border-border px-6">
        <Text class="text-xs text-muted-foreground">{`${line()} ·`}</Text>
        <View
          role="button"
          accessibilityLabel={`${line()}, show activity`}
          onPress={() => inspectorOpen.set(true)}
          style={hoverTransition()}
          class={`rounded-sm px-1 hover:bg-accent ${FOCUS_RING}`}
        >
          <Text class="text-xs font-medium text-foreground">Show</Text>
        </View>
      </View>
    </If>
  );
}

/** The time at a row's end: how long a running one has run, when a finished one ended; nothing the log does not give. */
function timeOf(e: Entry, now: number): string {
  if (e.state === "running") return e.startedMs !== undefined ? elapsedText(now - e.startedMs) : "";
  return e.endedMs !== undefined ? agoText(now - e.endedMs) : "";
}

/**
 * Stop for a background task, as a small square (the Claude desktop app's stop). A task that has run a minute or more takes
 * two presses within 4 s (principle 2); the first one turns the square red and the row says what the second does.
 */
function StopButton(props: { entry: Entry; now: number; armed: boolean; onPress: () => void }) {
  return (
    <Tipped label={props.armed ? "Press again to stop" : "Stop"} side="top">
      <View
        role="button"
        accessibilityLabel={props.armed ? `Press again to stop ${props.entry.name}` : `Stop ${props.entry.name}`}
        onPress={props.onPress}
        style={hoverTransition()}
        class={`size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent ${FOCUS_RING}`}
      >
        <View class={`size-2.5 rounded-xs ${props.armed ? "bg-destructive" : "bg-muted-foreground"}`} />
      </View>
    </Tipped>
  );
}

function EntryRow(props: {
  entry: Entry;
  now: number;
  armed: boolean;
  /** A slot for the stop square is reserved in this section, so names and times line up. */
  stopSlot: boolean;
  /** The section can hold a failure mark: a slot for it is reserved (`Running` holds none, so its names start at the heading's edge). */
  mark: boolean;
  onOpen?: () => void;
  onStop: () => void;
}) {
  const e = () => props.entry;
  const line = () => (props.armed ? "Press stop again to stop it" : e().line);
  const body = () => (
    <>
      <If when={props.mark}>
        <View class="size-3 shrink-0 items-center justify-center">
          <If when={e().state === "failed"}>
            <Icon name="x" size={12} tone="destructive" />
          </If>
        </View>
      </If>
      <View class="min-w-0 flex-1">
        <Clipped label={e().kind === "task" ? e().assignment : undefined} class="text-sm text-foreground">
          {e().name}
        </Clipped>
        <If when={line()}>
          <Clipped tip={false} class={`text-xs ${props.armed ? "text-foreground" : "text-muted-foreground"}`}>
            {line()}
          </Clipped>
        </If>
      </View>
      <If when={e().state === "stopped"}>
        <Text class="shrink-0 text-xs text-muted-foreground">Stopped</Text>
      </If>
      <Text style={NUM} class="shrink-0 text-xs text-muted-foreground">
        {timeOf(e(), props.now)}
      </Text>
    </>
  );
  return (
    <View class="min-h-11 flex-row items-center gap-1 pr-2">
      <If
        when={props.onOpen}
        else={
          <View
            accessibilityLabel={entryLabel(e(), props.now)}
            class="min-h-11 min-w-0 flex-1 flex-row items-center gap-2 py-1 pl-3 pr-2"
          >
            {body()}
          </View>
        }
      >
        <Tipped label={e().agent ? `Open · ${e().agent}` : "Open"} class="min-w-0 flex-1" side="top">
          <View
            role="button"
            accessibilityLabel={`${entryLabel(e(), props.now)}. Open its conversation`}
            onPress={() => props.onOpen?.()}
            style={hoverTransition()}
            class={`min-h-11 flex-row items-center gap-2 rounded-md py-1 pl-3 pr-2 hover:bg-accent ${FOCUS_RING_INSET}`}
          >
            {body()}
          </View>
        </Tipped>
      </If>
      <If
        when={e().stop}
        else={
          <If when={props.stopSlot}>
            <View class="size-7 shrink-0" />
          </If>
        }
      >
        <StopButton entry={e()} now={props.now} armed={props.armed} onPress={props.onStop} />
      </If>
    </View>
  );
}

/** A section's heading: its state, said once for every row under it, and how many. */
function Heading(props: {
  title: string;
  count: number;
  action?: { label: string; name: string; onPress: () => void };
}) {
  return (
    <View
      role="header"
      accessibilityLabel={`${props.title}, ${props.count}`}
      class="min-h-8 flex-row items-center gap-2 px-3 pt-2"
    >
      <Text class="text-xs font-medium text-foreground">{props.title}</Text>
      <Text style={NUM} class="flex-1 text-xs text-muted-foreground">
        {String(props.count)}
      </Text>
      <If when={props.action}>
        {(a) => <Btn small variant="ghost" label={a().label} name={a().name} onPress={a().onPress} />}
      </If>
    </View>
  );
}

/** A finished name that ran more than once: one row, `×3`, the newest end. */
function GroupRow(props: { group: FinishedGroup; now: number; onOpen?: () => void }) {
  const g = () => props.group;
  const label = () =>
    [
      g().name,
      g().failed ? "one failed" : "",
      `${g().entries.length} times`,
      g().lastMs !== undefined ? `last ${agoText(props.now - g().lastMs!)}` : "",
    ]
      .filter(Boolean)
      .join(", ");
  const body = () => (
    <>
      <View class="size-3 shrink-0 items-center justify-center">
        <If when={g().failed}>
          <Icon name="x" size={12} tone="destructive" />
        </If>
      </View>
      <Clipped boxClass="min-w-0 flex-1" class="text-sm text-foreground">
        {g().name}
      </Clipped>
      <If when={g().entries.length > 1}>
        <Text style={NUM} class="shrink-0 text-xs text-muted-foreground">{`×${g().entries.length}`}</Text>
      </If>
      <Text style={NUM} class="shrink-0 text-xs text-muted-foreground">
        {g().lastMs !== undefined ? agoText(props.now - g().lastMs!) : ""}
      </Text>
    </>
  );
  return (
    <If
      when={props.onOpen}
      else={
        <View accessibilityLabel={label()} class="min-h-8 flex-row items-center gap-2 pl-3 pr-4">
          {body()}
        </View>
      }
    >
      <View
        role="button"
        accessibilityLabel={`${label()}. Open its conversation`}
        onPress={() => props.onOpen?.()}
        style={hoverTransition()}
        class={`mr-2 min-h-8 flex-row items-center gap-2 rounded-md pl-3 pr-2 hover:bg-accent ${FOCUS_RING_INSET}`}
      >
        {body()}
      </View>
    </If>
  );
}

type Item =
  | { kind: "heading"; key: string; title: string; count: number; clear?: boolean }
  | { kind: "entry"; key: string; entry: Entry; stopSlot: boolean; mark: boolean }
  | { kind: "fold"; key: string }
  | { kind: "group"; key: string; group: FinishedGroup };

/** The list, top to bottom: `Needs you` (only when something does), `Running`, then `Finished` folded to one line. */
function itemsOf(s: Sections, finishedOpen: boolean): Item[] {
  const out: Item[] = [];
  const section = (title: string, rows: readonly Entry[], clear?: boolean) => {
    if (rows.length === 0) return;
    out.push({ kind: "heading", key: `h:${title}`, title, count: rows.length, clear });
    const stopSlot = rows.some((e) => e.stop);
    const mark = rows.some((e) => e.state !== "running");
    for (const e of rows) out.push({ kind: "entry", key: e.key, entry: e, stopSlot, mark });
  };
  section("Needs you", s.needs, true);
  section("Running", s.running);
  if (s.finishedCount > 0) {
    out.push({ kind: "fold", key: "fold" });
    if (finishedOpen) for (const g of s.finished) out.push({ kind: "group", key: `g:${g.name}`, group: g });
  }
  return out;
}

/** One cell of the list. Every prop is read where it is drawn, so a recycled cell that is handed another item redraws. */
function Cell(props: {
  item: Item;
  activity: Activity;
  armed: string | null;
  finishedOpen: boolean;
  canOpen: boolean;
  onFold: () => void;
  onOpen: (e: Entry) => void;
  onStop: (e: Entry) => void;
}) {
  const heading = () => (props.item.kind === "heading" ? props.item : null);
  const entry = () => (props.item.kind === "entry" ? props.item : null);
  const group = () => (props.item.kind === "group" ? props.item.group : null);
  const line = () => finishedLine(props.activity.sections(), props.activity.now());
  return (
    <>
      <If when={heading()}>
        {(at) => {
          // The cell may be taken down after its item changed kind: the last item it drew is read then.
          const h = latest(at);
          return (
            <Heading
              title={h().title}
              count={h().count}
              action={
                h().clear
                  ? {
                      label: "Clear",
                      name: `Clear, move ${h().count} to Finished`,
                      onPress: () => props.activity.clear(),
                    }
                  : undefined
              }
            />
          );
        }}
      </If>
      <If when={entry()}>
        {(at) => {
          // The cell may be taken down after its item changed kind: the last item it drew is read then.
          const e = latest(at);
          return (
            <EntryRow
              entry={e().entry}
              now={props.activity.now()}
              armed={props.armed === e().entry.key}
              stopSlot={e().stopSlot}
              mark={e().mark}
              onOpen={e().entry.subagent && props.canOpen ? () => props.onOpen(e().entry) : undefined}
              onStop={() => props.onStop(e().entry)}
            />
          );
        }}
      </If>
      <If when={props.item.kind === "fold"}>
        <View
          role="button"
          accessibilityLabel={line()}
          accessibilityState={{ expanded: props.finishedOpen }}
          onPress={props.onFold}
          style={hoverTransition()}
          class={`mx-2 mt-2 min-h-8 flex-row items-center gap-2 rounded-md px-1 hover:bg-accent ${FOCUS_RING_INSET}`}
        >
          <View class="size-3 items-center justify-center">
            <Icon name={props.finishedOpen ? "chevron-down" : "chevron-right"} size={12} tone="muted-foreground" />
          </View>
          <Text class="text-xs text-muted-foreground">{line()}</Text>
        </View>
      </If>
      <If when={group()}>
        {(at) => {
          // The cell may be taken down after its item changed kind: the last item it drew is read then.
          const g = latest(at);
          return (
            <GroupRow
              group={g()}
              now={props.activity.now()}
              onOpen={
                props.canOpen && g().entries[g().entries.length - 1]!.subagent
                  ? () => props.onOpen(g().entries[g().entries.length - 1]!)
                  : undefined
              }
            />
          );
        }}
      </If>
    </>
  );
}

/**
 * The inspector of a chat read from a terminal agent: a right region that holds what the agent runs beside its
 * conversation, to consult and not to read (`design/chat.md`, "The inspector"). Beside the chat at 320 pt; under `snug()`
 * it lies over the chat's right edge instead of squeezing it. A subagent opens its own conversation here, read-only, with
 * `Back` (`SubagentChat`).
 */
export function SessionInspector(props: {
  activity: Activity;
  port: SessionPort;
  machine: string;
  parentTitle: string;
  active: boolean;
  /** The chat's panel key: the subagent conversation keeps its place under a key of its own. */
  panel: string;
}) {
  const finishedOpen = signal(false);
  /** The subagent whose conversation is open (by its log name), or `null` for the list. */
  const opened = signal<string | null>(null);
  /** The stop that waits for its second press, and until when. */
  const armed = signal<{ key: string; until: number } | null>(null);
  let disarm: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(disarm));

  const items = computed(() => itemsOf(props.activity.sections(), finishedOpen()));
  const openedEntry = () => props.activity.entries().find((e) => e.subagent !== undefined && e.subagent === opened());

  const open = (e: Entry) => {
    if (!e.subagent || !props.port.subagent) return;
    if (e.state === "failed") props.activity.acknowledge(e.key);
    opened.set(e.subagent);
  };

  const stop = async (e: Entry) => {
    if (!e.stop || !props.port.stopBackground) return;
    const now = Date.now();
    const long = e.startedMs === undefined || now - e.startedMs >= CONFIRM_AFTER_MS;
    const a = armed();
    if (long && !(a && a.key === e.key && a.until > now)) {
      armed.set({ key: e.key, until: now + CONFIRM_MS });
      clearTimeout(disarm);
      disarm = setTimeout(() => armed.set(null), CONFIRM_MS);
      announce(`Press again to stop ${e.name}`);
      return;
    }
    armed.set(null);
    const result = await props.port.stopBackground(e.stop);
    if (result.kind === "done") notify(`Asked the agent to stop ${e.name}`);
    else notify(result.message || `Could not stop ${e.name}`);
  };

  // `showSubagent` from elsewhere (the chat in front only): the subagent's conversation opens here.
  effect(() => {
    const name = pendingSubagent();
    if (!props.active || name === null) return;
    const e = props.activity.entries().find((x) => x.subagent === name);
    if (!e) return;
    untracked(() => {
      pendingSubagent.set(null);
      open(e);
    });
  });

  // Escape goes back from a subagent's conversation to the list, while no text field has the keyboard.
  effect(() => {
    if (!props.active || opened() === null) return;
    return keymap.bind("escape", () => opened.set(null), { when: "notEditing" });
  });

  const overlay = () => snug();
  return (
    <View
      accessibilityLabel="Activity"
      style={{ width: opened() !== null && !overlay() ? INSPECTOR_READING_WIDTH : INSPECTOR_WIDTH }}
      class={`min-h-0 border-l border-border bg-background ${overlay() ? "absolute bottom-0 right-0 top-0 shadow-lg dark:shadow-none" : "shrink-0"}`}
    >
      <If
        when={opened() !== null && props.port.subagent ? opened() : null}
        else={
          <>
            <View class="min-h-12 flex-row items-center gap-2 border-b border-border pl-4 pr-2">
              <Text role="header" class="flex-1 text-sm font-medium text-foreground">
                Activity
              </Text>
              <IconButton
                icon="x"
                label="Close activity"
                shortcut={keyText(INSPECTOR_KEY)}
                onPress={() => inspectorOpen.set(false)}
              />
            </View>
            <If
              when={props.activity.any()}
              else={<Text class="px-4 py-3 text-xs text-muted-foreground">Nothing runs beside this agent.</Text>}
            >
              <List
                each={items()}
                keyExtractor={(i: Item) => i.key}
                estimatedItemSize={44}
                class="min-h-0 flex-1"
                contentClass="pb-3"
                accessibilityLabel="Subagents and background tasks"
              >
                {(item) => (
                  <Cell
                    item={item()}
                    activity={props.activity}
                    armed={armed()?.key ?? null}
                    finishedOpen={finishedOpen()}
                    canOpen={props.port.subagent !== undefined}
                    onFold={() => finishedOpen.update((o) => !o)}
                    onOpen={open}
                    onStop={(e) => void stop(e)}
                  />
                )}
              </List>
            </If>
          </>
        }
      >
        {(name) => (
          <SubagentChat
            name={name()}
            entry={openedEntry()}
            sub={props.port.subagent!(name())}
            parentTitle={props.parentTitle}
            machine={props.machine}
            active={props.active}
            panel={`${props.panel}#${name()}`}
            now={props.activity.now()}
            onBack={() => opened.set(null)}
          />
        )}
      </If>
    </View>
  );
}
