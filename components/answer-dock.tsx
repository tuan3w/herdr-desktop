import { Code, CodeView, Sessions } from "herdr-desktop/native";
import { announce, cleanup, computed, effect, keymap, Scroll, signal, Text, token, untracked, View } from "nsh";
import { Input } from "nsh/base";

import type { DiffItem, SessionView } from "herdr-desktop/native";
import type { ScrollRef, ViewRef } from "nsh/types";

import { PermissionDiff } from "#components/permission-diff";
import { PlanSteps } from "#components/plan-steps";
import { Btn, Clipped, FOCUS_RING, Icon, IconButton, INPUT_CLASS, Keys, Spinner } from "#kit";
import { replyTarget } from "#lib/ask";
import type { Ask, AskOption, AskOutcome } from "#lib/ask";
import { codeLabel, lineCount } from "#lib/highlight";
import { animateLayout, arrived, hoverTransition } from "#lib/motion";
import { largeTargets } from "#lib/settings";
import { restartable } from "#lib/timer";
import { rowsOf, visibleText } from "#lib/visible-text";

/**
 * How long an answer that just appeared or changed takes no press. A keystroke or click aimed at the question that was
 * there a moment ago must not land on the one that slid under it.
 */
const GUARD_MS = 400;
/** How long a risky answer stays armed after its first press. */
const ARM_MS = 4000;
/** How long `The question changed` shows on the row that was pressed. */
const FLASH_MS = 1500;
/** Answer rows on one dock; with more options than this the list shows one fewer and `N more…`. */
const MAX_ROWS = 6;
/** Rows of the subject box before it scrolls, and after `Show all`; the line height and the padding, in points. */
const BOX_ROWS = 8;
const OPEN_ROWS = 24;
const LINE = 20;
const PAD = 8;
/** Characters a row of the subject box holds, for guessing how tall a command is before it has been laid out. */
const COLUMNS = 96;
/** Rows of the transcript looked at for what the agent said and did just before asking. */
const WINDOW = 12;
/** The digits that answer: the 1st to the 9th row. */
const DIGITS = 9;

/** The dock that is the one place to answer (not a card's), for `focusAnswers`. */
let answering: (() => boolean) | undefined;

/**
 * `mod+2` while a question stands: the keyboard goes to the first answer. Focusing sends nothing and arms nothing; the
 * digits then answer, as they do for any focused answer, past the guard. A host where a view cannot take the focus from
 * code (the Linux one) says where the answers are instead.
 */
export function focusAnswers(): void {
  const where = "Answer the question first. Tab moves to the answers.";
  if (!answering?.()) announce(where);
}

/** What the agent said and was about to change when it asked: the last thing it wrote since the person spoke, and the edits of the call that waits. */
function lead(machine: string, id: string, view: SessionView, title: string): { said?: string; diffs: DiffItem[] } {
  const rows = Sessions.items(machine, id, Math.max(0, view.itemCount - WINDOW), WINDOW);
  let said: string | undefined;
  for (const row of [...rows].reverse()) {
    if (row.kind === "message" && row.role === "user") break;
    if (row.kind === "message" && row.role === "agent" && row.text?.trim()) {
      said = row.text.trim();
      break;
    }
  }
  const open = [...rows]
    .reverse()
    .filter(
      (r) =>
        r.kind === "tool" &&
        r.tool &&
        (r.tool.status === "pending" || r.tool.status === "inProgress") &&
        r.tool.diffs.length > 0,
    );
  const call = open.find((r) => r.tool?.title === title) ?? open[0];
  return { said, diffs: call?.tool?.diffs ?? [] };
}

/**
 * The one place an agent's question is answered, for a terminal agent's menu and for an ACP session's permission alike
 * (`Ask`, `lib/ask.ts`). It sits where the message box would: a flat block with a hairline above it (`inline` drops that
 * for a card that already frames it). It shows what is asked, whole, the agent's own answers, and the line `Nothing is
 * sent until you choose`.
 *
 * Nothing is ever sent by itself. The safety rules, each with a test in `answer-dock.test.tsx`:
 * - no timer or default sends: only a press on an answer does;
 * - an answer pressed within 400 ms of appearing or of the question changing is ignored, and dimmed until then;
 * - the press goes through `ask.send`, which reads the pane or request again and sends only if it still shows this
 *   question: otherwise nothing is sent and the row says `The question changed`;
 * - a risky answer (a risk reason, or a permission that outlives the answer) is two-step, not a timed hold: the first
 *   press arms it for 4 s and shows why, the second sends; it disarms by itself or when the question changes;
 * - an allow of a command too long for its box is read first: the first press scrolls to the end instead of sending,
 *   and `Show all N lines` counts as reading;
 * - the keys 1 to 9 pick the nth answer only while the focus is on an answer (two-step and the guard still apply);
 * - the reply field means `decline and say this`: it presses the decline through the same checked path and types the
 *   words only after that reports `sent`, never into the menu; with no decline to press it is not there;
 * - the dock never takes the focus, and never moves on by itself: `Next` (after an answer) is the person's press.
 * The command or path being approved (`subject`) is always shown whole, wrapped, never cut.
 */
export function AnswerDock(props: {
  /** The question; without one the dock is gone, except the `Sent` line of an answer given while it showed. */
  ask: Ask | undefined;
  /** Drops the hairline and padding, for a card around it. */
  inline?: boolean;
  /** An answer went through. */
  onSent?: () => void;
  /** Visits the next agent that waits (`mod+j`'s own function): offered after an answer while others wait. */
  onNext?: () => void;
}) {
  const identity = computed(() => props.ask?.identity ?? "");
  const guarded = signal(true);
  const armed = signal<string | null>(null);
  const sending = signal<string | null>(null);
  const flash = signal<string | null>(null);
  const note = signal("");
  const more = signal(false);
  const readAll = signal(false);
  const words = signal("");
  /** Set by an answer that went through; carries how many others waited then, for `Next` once the question is gone. */
  const settled = signal<{ others: number } | null>(null);
  const focused = signal(0);
  const contentHeight = signal(0);
  const viewport = signal(0);
  const offset = signal(0);
  const guard = restartable();
  const arming = restartable();
  const flashing = restartable();
  let scroll: ScrollRef | undefined;

  // A new question (or the first one) is what the person has not seen yet: nothing it had armed, read or typed carries over.
  effect(() => {
    const now = identity();
    // The dock changes the layout around it: the commit that brings a question is animated (what is below glides, the
    // dock fades in), once per question and never after a shortcut, at start or when the same question is built again.
    // Nothing waits for it: the answers are in place from the first frame and the guard below is its own timer.
    if (now !== "" && arrived(now)) animateLayout();
    guarded.set(true);
    guard.after(GUARD_MS, () => guarded.set(false));
    arming.stop();
    flashing.stop();
    armed.set(null);
    flash.set(null);
    sending.set(null);
    note.set("");
    more.set(false);
    readAll.set(false);
    words.set("");
    contentHeight.set(0);
    viewport.set(0);
    offset.set(0);
    if (now === "") return;
    settled.set(null);
    const a = untracked(() => props.ask);
    // A card on the board shows many questions at once: only a dock that is the one place to answer speaks.
    if (a && !props.inline)
      announce(
        `The agent asks: ${visibleText(a.subject ?? a.heading)
          .split("\n")[0]!
          .slice(0, 200)}`,
      );
  });

  const options = () => props.ask?.options ?? [];
  const rows = computed(() => (!more() && options().length > MAX_ROWS ? options().slice(0, MAX_ROWS - 1) : options()));
  const hidden = () => options().length - rows().length;
  let first: ViewRef | undefined;
  if (!props.inline) {
    const mine = () => {
      if (!props.ask || !first || rows().length === 0) return false;
      first.focus();
      // Where a view cannot take the focus from code nothing happens: say where the answers are then.
      setTimeout(() => {
        if (focused() === 0) announce("Answer the question first. Tab moves to the answers.");
      }, 50);
      return true;
    };
    answering = mine;
    cleanup(() => {
      if (answering === mine) answering = undefined;
    });
  }
  const busy = () => sending() !== null || flash() !== null;
  const frozen = () => guarded() || busy();

  const text = computed(() => visibleText(props.ask?.subject ?? ""));
  const label = computed(() =>
    codeLabel(Code.describe(text(), props.ask?.language ?? null, null).language, lineCount(text())),
  );
  const measured = () => contentHeight() > 0 && viewport() > 0;
  const total = () =>
    measured() ? Math.max(1, Math.round((contentHeight() - PAD * 2) / LINE)) : rowsOf(text(), COLUMNS);
  const overflow = () =>
    measured() ? contentHeight() > BOX_ROWS * LINE + PAD * 2 + 2 : rowsOf(text(), COLUMNS) > BOX_ROWS;
  const atEnd = () => readAll() || !overflow() || (measured() && offset() + viewport() >= contentHeight() - 2);
  const below = () =>
    measured()
      ? Math.max(1, Math.ceil((contentHeight() - viewport() - offset()) / LINE))
      : Math.max(1, rowsOf(text(), COLUMNS) - BOX_ROWS);

  const around = computed(() => {
    const s = props.ask?.session;
    if (!s) return { diffs: [] as DiffItem[] };
    void s.view.revision;
    return lead(s.machine, s.id, s.view, s.view.waiting[0]?.title ?? "");
  });
  const target = computed(() => (props.ask ? replyTarget(props.ask) : undefined));

  /** What an answer's end says on the dock; the one place all three ways of answering (a row, a digit, the reply) end. */
  function settle(ask: Ask, pressed: string, out: AskOutcome, others: number) {
    sending.set(null);
    switch (out.kind) {
      case "sent":
        note.set(out.note);
        settled.set({ others });
        announce(out.note);
        props.onSent?.();
        return;
      case "changed":
        flash.set(pressed);
        flashing.after(FLASH_MS, () => flash.set(null));
        note.set("Nothing was sent.");
        announce(`The ${ask.noun} changed`);
        return;
      default:
        note.set(out.note);
        announce(out.note);
    }
  }

  async function activate(option: AskOption) {
    const ask = props.ask;
    if (!ask) return;
    if (guarded()) {
      announce(`The ${ask.noun} just changed. Press again.`);
      return;
    }
    if (busy()) return;
    const arm = () => {
      armed.set(option.id);
      arming.after(ARM_MS, () => armed.set(null));
    };
    if (!option.reject && overflow() && !atEnd()) {
      // The person has not seen the end of what they would allow: show it first, and this press counts as reading it.
      readAll.set(true);
      scroll?.scrollTo({ y: contentHeight(), animated: false });
      if (option.risky) arm();
      note.set("Read it all, then press again.");
      announce(`Read it all, then press again.${option.risky ? ` ${option.reason}` : ""}`);
      return;
    }
    if (option.risky && armed() !== option.id) {
      arm();
      announce(`Press again to send. ${option.reason}`);
      return;
    }
    arming.stop();
    armed.set(null);
    more.set(false);
    sending.set(option.id);
    note.set("");
    const others = ask.waitingElsewhere;
    settle(ask, option.id, await ask.send(option), others);
  }

  /** Declines through the checked path, and only when that reports `sent` types the words: never into a menu that may have changed. */
  async function reply() {
    const ask = props.ask;
    const decline = target();
    const said = words().trim();
    if (!ask || !decline || said === "") return;
    if (guarded()) {
      announce(`The ${ask.noun} just changed. Press again.`);
      return;
    }
    if (busy()) return;
    arming.stop();
    armed.set(null);
    sending.set(decline.id);
    note.set("");
    const others = ask.waitingElsewhere;
    const out = await ask.send(decline);
    if (out.kind !== "sent") {
      settle(ask, decline.id, out, others);
      return;
    }
    const spoken = await ask.say(said);
    words.set("");
    settle(
      ask,
      decline.id,
      spoken.kind === "sent" ? { kind: "sent", note: `Declined and sent: ${said}` } : spoken,
      others,
    );
  }

  async function cancel() {
    const ask = props.ask;
    if (!ask?.cancel || busy()) return;
    if (guarded()) {
      announce(`The ${ask.noun} just changed. Press again.`);
      return;
    }
    sending.set("cancel");
    note.set("");
    const others = ask.waitingElsewhere;
    settle(ask, "cancel", await ask.cancel(), others);
  }

  // Digits answer only while an answer has the focus: bound then, released with the focus, so typing elsewhere is untouched.
  effect(() => {
    if (focused() === 0) return;
    const keys: Record<string, () => void> = {};
    rows().forEach((option, i) => {
      if (i < DIGITS) keys[String(i + 1)] = () => void activate(option);
    });
    return keymap.bind(keys);
  });

  const others = () => props.ask?.waitingElsewhere ?? settled()?.others ?? 0;
  const next = () => (settled() && others() > 0 && props.onNext ? props.onNext : undefined);
  const footer = (
    <View class="min-h-4 flex-row items-center justify-between gap-3">
      <Text class="min-w-0 flex-1 text-xs text-muted-foreground">{note() || "Nothing is sent until you choose"}</Text>
      <If when={others() > 0}>
        <Text class="text-xs text-muted-foreground">{`${others()} more waiting`}</Text>
      </If>
      <If when={next()}>{(go) => <Btn small variant="ghost" label="Next" onPress={go()} />}</If>
    </View>
  );

  // 24 pt in, the conversation column's and the header's edge.
  const frame = () => (props.inline ? "gap-2" : "gap-2 border-t border-border bg-background px-6 py-3");

  return (
    <If
      when={props.ask}
      else={
        <If when={settled()}>
          <View role="group" accessibilityLabel="Answer sent" class={frame()}>
            {footer}
          </View>
        </If>
      }
    >
      {(ask) => (
        <View role="group" accessibilityLabel={ask().label} class={frame()}>
          <View class="gap-1">
            <Text role="header" class="text-sm font-medium text-foreground">
              {ask().heading}
            </Text>
            <If when={ask().detail}>
              {(detail) => <Text class="text-xs text-muted-foreground">{visibleText(detail())}</Text>}
            </If>
          </View>
          <If when={around().said}>
            {(said) => (
              <View class="gap-1">
                <Text class="text-xs text-muted-foreground">The agent said before asking</Text>
                <Clipped lines={3} class="text-sm text-foreground">
                  {visibleText(said())}
                </Clipped>
              </View>
            )}
          </If>
          <If when={ask().subject}>
            <View role="group" accessibilityLabel="What the agent asks to do" class="gap-1">
              <Scroll
                ref={(node: ScrollRef) => {
                  scroll = node;
                }}
                onLayout={({ bounds }) => viewport.set(bounds.size.height)}
                onScroll={(e) => offset.set(e.offset.y)}
                class="rounded-md"
                style={{
                  backgroundColor: token("code-bg"),
                  maxHeight: (readAll() ? OPEN_ROWS : BOX_ROWS) * LINE + PAD * 2,
                }}
              >
                <View onLayout={({ bounds }) => contentHeight.set(bounds.size.height)} style={{ padding: PAD }}>
                  <CodeView code={text()} language={ask().language} wrap label={label()} />
                </View>
              </Scroll>
              <If when={overflow()}>
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-xs text-muted-foreground">
                    {atEnd() ? "End of the command" : `More below · ${below()} lines`}
                  </Text>
                  <If
                    when={!readAll()}
                    else={<Btn small variant="ghost" label="Show fewer lines" onPress={() => readAll.set(false)} />}
                  >
                    <Btn small variant="ghost" label={`Show all ${total()} lines`} onPress={() => readAll.set(true)} />
                  </If>
                </View>
              </If>
            </View>
          </If>
          <If when={ask().risk}>
            {(risk) => (
              <View class="flex-row items-start gap-2">
                <Icon name="alert" size={16} tone="warning" />
                <Text class="min-w-0 flex-1 text-sm text-foreground">{`Take a second look: ${risk()}`}</Text>
              </View>
            )}
          </If>
          <If when={around().diffs.length > 0}>
            <PermissionDiff diffs={around().diffs} />
          </If>
          <If when={ask().session}>{(s) => <PlanSteps plan={s().view.plan} />}</If>
          <View role="group" accessibilityLabel="Answers" class="gap-0.5">
            <Each of={rows()} key={(o: AskOption) => o.id}>
              {(option) => (
                <Row
                  option={option()}
                  hint={String(rows().indexOf(option()) + 1)}
                  numbered={option().label.startsWith(`${rows().indexOf(option()) + 1}.`)}
                  noun={ask().noun}
                  armed={armed() === option().id}
                  busy={sending() === option().id}
                  flashed={flash() === option().id}
                  dim={frozen()}
                  onRef={(node) => {
                    if (option().id === rows()[0]?.id) first = node;
                  }}
                  onPress={() => void activate(option())}
                  onFocus={() => focused.update((n) => n + 1)}
                  onBlur={() => focused.update((n) => Math.max(0, n - 1))}
                />
              )}
            </Each>
            <If when={hidden() > 0 || ask().cancel}>
              <View class="flex-row flex-wrap items-center gap-2">
                <If when={hidden() > 0}>
                  <Btn
                    small
                    label={`${hidden()} more…`}
                    onPress={() => {
                      // The list is new to the eye: what is pressed in the moment it opens is ignored.
                      guarded.set(true);
                      guard.after(GUARD_MS, () => guarded.set(false));
                      more.set(true);
                    }}
                  />
                </If>
                <If when={ask().cancel}>
                  <Btn
                    small
                    variant="ghost"
                    label="Cancel request"
                    loading={sending() === "cancel"}
                    onPress={() => void cancel()}
                  />
                </If>
              </View>
            </If>
          </View>
          <If when={target()}>
            <View>
              <Input
                value={words()}
                onChange={({ value }) => words.set(value)}
                placeholder="Decline and tell the agent what to do instead"
                accessibilityLabel="Decline and say this"
                submitBehavior="submit"
                onSubmit={() => void reply()}
                autoCorrect={false}
                autoComplete="off"
                style={{ minHeight: largeTargets() ? 44 : 32, ...hoverTransition() }}
                class={`${INPUT_CLASS} pr-10`}
              />
              <If when={words().trim() !== ""}>
                <View class="absolute bottom-0 right-1 top-0 justify-center">
                  <IconButton icon="send" label="Decline and send" onPress={() => void reply()} />
                </View>
              </If>
            </View>
          </If>
          {footer}
        </View>
      )}
    </If>
  );
}

/**
 * One answer, a full-width row: its key, the agent's own words in as many lines as they need (never cut: what an answer
 * grants is read in full), after the key a glyph when it needs a second press, then the words, and after them why, wrapping under them when the line is full. Armed, it says what to do next
 * in words, with the border and fill as the second signal. A numbered menu's own `1. ` is dropped from the words: the key
 * at the left says it once, the accessible name keeps the whole label.
 */
function Row(props: {
  option: AskOption;
  hint: string;
  numbered: boolean;
  noun: string;
  armed: boolean;
  busy: boolean;
  flashed: boolean;
  dim: boolean;
  onRef: (node: ViewRef) => void;
  onPress: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const name = () => {
    if (props.armed) return `${props.option.label}. Press again to send, ${props.option.reason}`;
    if (props.flashed) return `${props.option.label}. The ${props.noun} changed`;
    if (props.busy) return `${props.option.label}, sending`;
    return props.option.label;
  };
  const words = () => (props.numbered ? props.option.label.replace(/^\d+\.\s*/, "") : props.option.label);
  const second = () =>
    props.armed ? `Press again to send · ${props.option.reason}` : props.option.risky ? props.option.reason : "";
  return (
    <View
      ref={props.onRef}
      role="button"
      accessibilityLabel={name()}
      accessibilityHint={props.option.risky && !props.armed ? "Needs a second press" : undefined}
      accessibilityState={{ selected: props.armed, busy: props.busy }}
      onPress={props.onPress}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      style={hoverTransition()}
      class={`w-full flex-row items-start gap-2 rounded-md border px-3 py-1 hover:bg-accent ${largeTargets() ? "min-h-11" : "min-h-7"} ${
        props.dim ? "opacity-50" : ""
      } ${props.armed ? "border-warning bg-warning/20 dark:bg-warning/12" : "border-input bg-card"} ${FOCUS_RING}`}
    >
      <Keys keys={props.hint} />
      <If when={props.option.risky}>
        <View class="pt-0.5">
          <Icon name="alert" size={14} tone={props.armed ? "warning" : "muted-foreground"} />
        </View>
      </If>
      <View class="min-w-0 flex-1 flex-row flex-wrap items-baseline gap-x-2">
        <Text class="text-sm font-medium text-foreground">{props.flashed ? `The ${props.noun} changed` : words()}</Text>
        <If when={second()}>
          <Text class={`text-xs ${props.armed ? "font-medium text-foreground" : "text-muted-foreground"}`}>
            {second()}
          </Text>
        </If>
      </View>
      <If when={props.busy}>
        <Spinner size={14} tone="muted-foreground" />
      </If>
    </View>
  );
}
