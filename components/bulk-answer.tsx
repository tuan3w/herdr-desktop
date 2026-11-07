import { Code, CodeView } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, keymap, Scroll, signal, Text, token, untracked, View } from "nsh";

import type { ScrollRef } from "nsh/types";

import { Btn, FOCUS_RING, Icon, notify } from "#kit";
import { fromPrompt } from "#lib/ask";
import {
  allowLabel,
  answerEntries,
  answerViewOpen,
  ARM_MS,
  declineOption,
  GUARD_MS,
  pressAllow,
  reconcile,
  resultText,
  seenKey,
  stillArmed,
  tickBlock,
} from "#lib/bulk-answer";
import type { Armed, Entry, Result, Tick, Ticks } from "#lib/bulk-answer";
import { allRows, board } from "#lib/herdr";
import { codeLabel, lineCount } from "#lib/highlight";
import { hoverTransition } from "#lib/motion";
import { restartable } from "#lib/timer";
import { rowsOf, visibleText } from "#lib/visible-text";

/** Rows of a command's box before it needs `Show all`, and the line height and padding in points (as the dock's). */
const BOX_ROWS = 8;
const LINE = 20;
const PAD = 8;
/** Characters a row of the box holds, for guessing how tall a command is before it has been laid out. */
const COLUMNS = 96;
/** The view's own height, in points, before its rows scroll: the table below must stay in sight. */
const VIEW_MAX = 420;

/**
 * What the view tells a row's own box and `Show all` about the answer in flight: which tick to take, and the notes.
 */
interface Ctx {
  ticks: () => Ticks;
  /** A row ignores a tick inside its guard: false once `GUARD_MS` passed since this question appeared. */
  guarded: (key: string, digest: string) => boolean;
  note: (key: string) => string;
  busy: () => boolean;
  toggle: (entry: Entry, block: ReturnType<typeof tickBlock>) => void;
  say: (key: string, text: string) => void;
}

/**
 * The bulk answer view: every agent that needs you, with the question and THE COMMAND IN FULL, and a box that starts
 * unticked, always. One gesture can answer several agents, so every safety of the one dock applies per row and more:
 * - nothing is ticked by the view, by a chip or by a shortcut; there is no `Select all`, no `Allow all` and no key that
 *   answers here (the keys of the dock work only on the dock);
 * - a row ignores a tick for 400 ms after it appears or its question changes, and a command taller than its box must be
 *   shown whole (`Show all N lines`) before its box can be ticked;
 * - a risky row, one without a plain allow, one with no command to read and a chat are listed without a working box;
 * - `Allow N commands` arms for 4 s, shows what the second press does, and disarms when the ticked set changes, when a
 *   ticked question changes or when a new question appears anywhere; the second press sends;
 * - each send is `fromPrompt(...).send` with the question as it was DISPLAYED when ticked: the pane is read again and a
 *   changed question sends nothing, unticks that row and says so on it;
 * - nothing can be taken back, so the result stays on screen naming every agent (a lasting toast) and each failure
 *   stays on its row.
 * The answer is always the allow-once option found by its flags, never by its place in the menu.
 */
export function BulkAnswer() {
  const data = computed(() => answerEntries(allRows(board())));
  const ticks = signal<Ticks>({});
  /** `key@digest` of each question that has been on screen `GUARD_MS`. */
  const calm = signal<Readonly<Record<string, true>>>({});
  /** What a row says about its last answer or refusal, until it is ticked again. */
  const notes = signal<Readonly<Record<string, string>>>({});
  const armed = signal<Armed | undefined>(undefined);
  const busy = signal(false);
  const arming = restartable();
  const timers = new Map<string, number>();
  cleanup(() => {
    for (const id of timers.values()) clearTimeout(id);
  });

  const say = (key: string, text: string) =>
    notes.update(({ [key]: _old, ...rest }) => (text === "" ? rest : { ...rest, [key]: text }));

  // Each question starts its own guard when it first shows, and again when it changes.
  effect(() => {
    for (const e of data().entries) {
      const seen = seenKey(e.row.key, e.prompt?.digest ?? "");
      untracked(() => {
        if (timers.has(seen)) return;
        timers.set(
          seen,
          setTimeout(() => calm.update((all) => ({ ...all, [seen]: true })), GUARD_MS) as unknown as number,
        );
      });
    }
  });

  // A tick stands only for the question it was made on: a row that left or asks something else is unticked, and the
  // second says so. (Nothing is re-aimed at the new question.)
  effect(() => {
    const { entries } = data();
    const now = untracked(ticks);
    const { kept, changed } = reconcile(now, entries);
    if (Object.keys(kept).length === Object.keys(now).length) return;
    ticks.set(kept);
    for (const key of changed) say(key, "The question changed");
    if (changed.length > 0)
      announce(`${changed.length} ${changed.length === 1 ? "question" : "questions"} changed. Nothing was sent.`);
  });

  // Armed holds for these ticks on this screen and for 4 s, nothing else.
  effect(() => {
    const a = armed();
    if (a && !stillArmed(a, ticks(), data().entries, Date.now())) {
      arming.stop();
      armed.set(undefined);
    }
  });

  const ticked = () => Object.entries(ticks());
  const count = () => ticked().length;
  const declines = () => ticked().filter(([, t]) => declineOption(t.prompt)).length;

  const ctx: Ctx = {
    ticks,
    guarded: (key, digest) => !calm()[seenKey(key, digest)],
    note: (key) => notes()[key] ?? "",
    busy,
    say,
    toggle(entry, block) {
      const key = entry.row.key;
      if (busy()) return;
      if (block === "guard") {
        announce("This question just appeared. Tick it again.");
        return;
      }
      if (block === "unread") {
        announce("Show all of the command first.");
        say(key, "Show all of the command before ticking");
        return;
      }
      if (block || !entry.prompt || !entry.allow) return;
      say(key, "");
      if (ticks()[key]) {
        ticks.update(({ [key]: _off, ...rest }) => rest);
        return;
      }
      const tick: Tick = {
        prompt: entry.prompt,
        allow: entry.allow,
        machine: entry.row.machine,
        pane: entry.row.paneId,
        name: entry.row.name,
      };
      ticks.update((all) => ({ ...all, [key]: tick }));
    },
  };

  /** Sends one row at a time through the dock's checked path; the question it checks against is the one that was displayed. */
  async function run(verb: "Allowed" | "Declined") {
    const picked = ticked();
    if (picked.length === 0 || busy()) return;
    busy.set(true);
    arming.stop();
    armed.set(undefined);
    const results: Result[] = [];
    for (const [key, tick] of picked) {
      const option = verb === "Allowed" ? tick.allow : declineOption(tick.prompt);
      const result = (kind: Result["kind"], note: string): Result => ({ name: tick.name, kind, note });
      if (!option) {
        results.push(result("stopped", "no decline option"));
        continue;
      }
      const ask = fromPrompt(tick.prompt, { machine: tick.machine, pane: tick.pane });
      const asked = ask.options.find((o) => o.id === String(option.index));
      const out = asked ? await ask.send(asked) : { kind: "stopped" as const, note: "the option is gone" };
      results.push(result(out.kind, out.note));
      if (out.kind !== "sent") say(key, out.kind === "changed" ? "The question changed" : out.note);
    }
    // A sent row is done; a refused one is unticked too, so a second press cannot send what was refused.
    ticks.update((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !picked.some(([p]) => p === k))));
    busy.set(false);
    const text = resultText(verb, results);
    notify(text, { lasting: true, type: results.every((r) => r.kind === "sent") ? "success" : "warning" });
  }

  function allow() {
    const next = pressAllow(armed(), ticks(), data().entries, Date.now());
    if (next.action === "none" || busy()) return;
    if (next.action === "arm") {
      armed.set(next.armed);
      arming.after(ARM_MS, () => armed.set(undefined));
      announce(allowLabel(count(), true));
      return;
    }
    void run("Allowed");
  }

  const isArmed = () => armed() !== undefined;
  answerViewOpen.set(true);
  cleanup(() => answerViewOpen.set(false));

  return (
    <View role="group" accessibilityLabel="Answer the agents that need you" class="gap-2">
      <View class="flex-row flex-wrap items-center gap-2">
        <Text class="mr-2 min-w-0 flex-1 text-sm text-muted-foreground">
          {count() === 0 ? "Tick each command you have read. Nothing is ticked for you." : `${count()} ticked`}
        </Text>
        <Btn
          small
          variant={isArmed() ? "primary" : "outline"}
          label={allowLabel(count(), isArmed())}
          disabled={count() === 0 || busy()}
          loading={busy()}
          onPress={allow}
        />
        <Btn
          small
          label={`Decline ${declines()}`}
          disabled={declines() === 0 || busy()}
          onPress={() => void run("Declined")}
        />
      </View>
      <Scroll accessibilityLabel="Questions" class="min-h-0" style={{ maxHeight: VIEW_MAX }}>
        <View class="gap-2">
          <Each of={data().entries} key={(e: Entry) => e.row.key}>
            {(entry) => <Line entry={entry} ctx={ctx} />}
          </Each>
          <If when={data().more > 0}>
            <Text class="px-3 text-sm text-muted-foreground">{`${data().more} more: answer these first`}</Text>
          </If>
        </View>
      </Scroll>
    </View>
  );
}

/** Why a row has no working box: the risk the agent's own menu names, or that there is no command to read. */
function riskWords(entry: Entry): string {
  if (!entry.prompt) return "The question cannot be shown here";
  if (!entry.prompt.subject?.trim()) return "No command to read";
  return entry.prompt.options.find((o) => o.riskReason)?.riskReason ?? "Grants a standing permission";
}

/** One blocked agent: its title, its question, the command whole, why it cannot be ticked or how it went, and its box. */
function Line(props: { entry: () => Entry; ctx: Ctx }) {
  const entry = props.entry;
  const digest = () => entry().prompt?.digest ?? "";
  const key = () => entry().row.key;
  const open = signal(false);
  const contentHeight = signal(0);
  let scroll: ScrollRef | undefined;

  // A changed question is a new one: what was read of the old is not read of this.
  effect(() => {
    void digest();
    open.set(false);
    contentHeight.set(0);
  });

  const text = computed(() => visibleText(entry().prompt?.subject ?? ""));
  const label = computed(() => codeLabel(Code.describe(text(), null, null).language, lineCount(text())));
  const measured = () => contentHeight() > 0;
  const overflow = () =>
    measured() ? contentHeight() > BOX_ROWS * LINE + PAD * 2 + 2 : rowsOf(text(), COLUMNS) > BOX_ROWS;
  const total = () =>
    measured() ? Math.max(1, Math.round((contentHeight() - PAD * 2) / LINE)) : rowsOf(text(), COLUMNS);
  const checked = () => !!props.ctx.ticks()[key()];
  const block = () =>
    tickBlock(entry(), { guarded: props.ctx.guarded(key(), digest()), overflow: overflow(), read: open() });
  const note = () => props.ctx.note(key());
  const eligible = () => !!entry().allow;
  const press = () => props.ctx.toggle(entry(), block());

  // Space toggles the focused box; bound only while it has the focus and released with it, like the table's boxes.
  const focus = signal(false);
  effect(() => {
    if (!focus() || !eligible()) return;
    return keymap.bind({ space: press, enter: () => {} });
  });

  return (
    <View
      role="group"
      accessibilityLabel={`${entry().row.name}, needs you`}
      class={`gap-2 rounded-md border bg-card px-3 py-2 ${checked() ? "border-primary" : "border-border"}`}
    >
      <View class="flex-row items-start gap-2">
        <View
          role="checkbox"
          accessibilityLabel={`Include ${entry().row.name}`}
          accessibilityState={{ checked: checked(), disabled: !eligible() }}
          onPress={eligible() ? press : undefined}
          onFocus={() => focus.set(true)}
          onBlur={() => focus.set(false)}
          style={hoverTransition()}
          class={`size-7 items-center justify-center rounded-md ${eligible() ? "" : "opacity-40"} ${FOCUS_RING}`}
        >
          <View
            class={`size-5 items-center justify-center rounded border ${checked() ? "border-primary bg-primary" : "border-input bg-card"}`}
          >
            <If when={checked()}>
              <Icon name="check" size={12} tone="primary-foreground" />
            </If>
          </View>
        </View>
        <View class="min-w-0 flex-1 gap-1">
          <View class="flex-row flex-wrap items-baseline gap-x-2">
            <Text class="text-sm font-medium text-foreground">{entry().row.name}</Text>
            <Text class="text-xs text-muted-foreground">{entry().row.machineName}</Text>
          </View>
          <If when={entry().prompt}>
            {(prompt) => <Text class="text-sm text-foreground">{visibleText(prompt().question)}</Text>}
          </If>
        </View>
      </View>
      <If when={text() !== ""}>
        <View role="group" accessibilityLabel="What the agent asks to do" class="gap-1">
          <Scroll
            ref={(node: ScrollRef) => {
              scroll = node;
            }}
            class="rounded-md"
            style={{
              backgroundColor: token("code-bg"),
              ...(open() ? {} : { maxHeight: BOX_ROWS * LINE + PAD * 2 }),
            }}
          >
            <View onLayout={({ bounds }) => contentHeight.set(bounds.size.height)} style={{ padding: PAD }}>
              <CodeView code={text()} wrap label={label()} />
            </View>
          </Scroll>
          <If when={overflow()}>
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-xs text-muted-foreground">
                {open() ? "The whole command is shown" : "The command goes on: show it all before ticking"}
              </Text>
              <If
                when={!open()}
                else={
                  <Btn
                    small
                    variant="ghost"
                    label="Show fewer lines"
                    onPress={() => {
                      scroll?.scrollTo({ y: 0, animated: false });
                      open.set(false);
                    }}
                  />
                }
              >
                <Btn
                  small
                  variant="ghost"
                  label={`Show all ${total()} lines`}
                  onPress={() => {
                    open.set(true);
                    props.ctx.say(key(), "");
                  }}
                />
              </If>
            </View>
          </If>
        </View>
      </If>
      <If when={entry().why === "risky" || entry().why === "unknown"}>
        <View class="flex-row items-start gap-2">
          <Icon name="alert" size={16} tone="warning" />
          <Text class="min-w-0 flex-1 text-sm text-foreground">{`${riskWords(entry())} · ${entry().say}`}</Text>
        </View>
      </If>
      <If when={entry().why === "session"}>
        <Text class="text-sm text-muted-foreground">{entry().say}</Text>
      </If>
      <If when={note()}>
        <Text role="alert" class="text-sm font-medium text-foreground">
          {note()}
        </Text>
      </If>
    </View>
  );
}
