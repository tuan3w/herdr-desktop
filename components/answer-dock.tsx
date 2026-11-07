import { announce, cleanup, computed, effect, keymap, signal, Text, View } from "nsh";
import { Herdr } from "herdr-desktop/native";
import type { PromptOption, PromptView } from "herdr-desktop/native";
import { hoverTransition } from "#lib/motion";
import { largeTargets } from "#lib/settings";
import { Btn, FOCUS_RING, Icon, Modal, Spinner } from "#kit";

/**
 * How long an answer that just appeared or changed takes no press. A keystroke or click aimed at the question that was
 * there a moment ago must not land on the one that slid under it.
 */
const GUARD_MS = 400;
/** How long a risky answer stays armed after its first press. */
const ARM_MS = 4000;
/** How long `The question changed` shows on the chip that was pressed. */
const FLASH_MS = 1500;
/** Chips on one dock; with more options the last chip is `N more…`. */
const MAX_CHIPS = 5;

/** A timer that is gone with its owner: restarting it replaces the pending call. */
function timer() {
  let id: number | undefined;
  cleanup(() => clearTimeout(id));
  return {
    after(ms: number, run: () => void) {
      clearTimeout(id);
      id = setTimeout(run, ms);
    },
    stop() {
      clearTimeout(id);
      id = undefined;
    },
  };
}

const isRisky = (o: PromptOption) => !!o.riskReason || o.standingGrant;
/** Why a second press is asked: the option's own reason, else that the permission outlives this answer. */
const riskText = (o: PromptOption) => o.riskReason ?? "grants standing permission";

/**
 * The one place an agent's question is answered: the board card, the pane tab and the triage dialog all show this.
 *
 * Nothing is ever sent by itself. The safety rules, each with a test in `answer-dock.test.tsx`:
 * - no timer or default sends: only a press on an answer does;
 * - an answer pressed within 400 ms of appearing or of the question changing is ignored, and dimmed until then;
 * - the press goes through `Herdr.answer`, which reads the pane again and sends only if it still shows this question:
 *   otherwise nothing is sent and the chip says `The question changed`;
 * - a risky answer (a risk reason, or a permission that outlives the answer) is two-step, not a timed hold: the first
 *   press arms it for 4 s and shows why, the second sends; it disarms by itself or when the question changes;
 * - the keys 1 to 9 pick the nth answer only while the focus is on an answer (two-step and the guard still apply);
 * - the dock never takes the focus.
 * The command or path being approved (`subject`) is always shown whole, wrapped, never cut.
 */
export function AnswerDock(props: { machine: string; pane: string; prompt: PromptView; onSent?: () => void }) {
  // The pane is part of the identity: a recycled list cell may show another agent with an identical question, and
  // nothing armed or pending for the first may carry over to the second.
  const identity = computed(() => `${props.machine}/${props.pane}/${props.prompt.digest}`);
  const guarded = signal(true);
  const armed = signal<number | null>(null);
  const sending = signal<number | null>(null);
  const flash = signal<number | null>(null);
  const note = signal("");
  const more = signal(false);
  const focused = signal(0);
  const guard = timer();
  const arming = timer();
  const flashing = timer();

  // A new question (or the first one) is what the person has not seen yet: nothing it had armed carries over.
  effect(() => {
    identity();
    guarded.set(true);
    more.set(false);
    guard.after(GUARD_MS, () => guarded.set(false));
    arming.stop();
    flashing.stop();
    armed.set(null);
    flash.set(null);
    note.set("");
  });

  const chips = computed(() => (props.prompt.options.length > MAX_CHIPS ? props.prompt.options.slice(0, MAX_CHIPS - 1) : props.prompt.options));
  const hidden = () => props.prompt.options.length - chips().length;
  const frozen = () => guarded() || sending() !== null || flash() !== null;

  async function activate(option: PromptOption) {
    if (guarded()) {
      announce("The answers just changed. Press again.");
      return;
    }
    if (sending() !== null || flash() !== null) return;
    if (isRisky(option) && armed() !== option.index) {
      armed.set(option.index);
      arming.after(ARM_MS, () => armed.set(null));
      announce(`Press again to send. ${riskText(option)}`);
      return;
    }
    arming.stop();
    armed.set(null);
    more.set(false);
    sending.set(option.index);
    note.set("");
    // The digest of the question on screen now: the guard keeps a press from reaching a question that changed a moment ago.
    const seen = props.prompt.digest;
    const result = await Herdr.answer(props.machine, props.pane, seen, option.index).catch((e: unknown) => ({
      kind: "failed" as const,
      message: e instanceof Error ? e.message : String(e),
    }));
    sending.set(null);
    switch (result.kind) {
      case "sent":
        note.set(`Sent: ${option.label}`);
        announce(`Sent: ${option.label}`);
        props.onSent?.();
        break;
      case "changed":
        flash.set(option.index);
        flashing.after(FLASH_MS, () => flash.set(null));
        announce("The question changed");
        break;
      case "notBlocked":
        note.set("Not waiting for an answer any more. Nothing was sent.");
        announce(note());
        break;
      case "failed":
        note.set(`Not sent: ${result.message ?? "the answer could not be delivered"}`);
        announce(note());
        break;
    }
  }

  // Digits answer only while an answer has the focus: bound then, released with the focus, so typing elsewhere is untouched.
  effect(() => {
    if (focused() === 0) return;
    const keys: Record<string, () => void> = {};
    chips().forEach((option, i) => {
      if (i < 9) keys[String(i + 1)] = () => void activate(option);
    });
    return keymap.bind(keys);
  });

  const chip = (option: () => PromptOption) => (
    <Chip
      option={option()}
      armed={armed() === option().index}
      busy={sending() === option().index}
      flashed={flash() === option().index}
      dim={frozen()}
      onPress={() => void activate(option())}
      onFocus={() => focused.update((n) => n + 1)}
      onBlur={() => focused.update((n) => Math.max(0, n - 1))}
    />
  );

  return (
    <View role="group" accessibilityLabel="Answer" class="gap-2">
      <Text class="text-sm text-foreground">{props.prompt.question}</Text>
      <If when={props.prompt.subject}>
        {(subject) => (
          <Text style={{ userSelect: "text" }} class="font-mono text-sm text-foreground">
            {subject()}
          </Text>
        )}
      </If>
      <View class="flex-row flex-wrap items-start gap-2">
        <Each of={chips()} key={(o) => o.index}>
          {chip}
        </Each>
        <If when={hidden() > 0}>
          <Btn
            label={`${hidden()} more…`}
            onPress={() => {
              guarded.set(true);
              guard.after(GUARD_MS, () => guarded.set(false));
              more.set(true);
            }}
          />
        </If>
      </View>
      <Text class="min-h-4 text-xs text-muted-foreground">{note()}</Text>
      <If when={hidden() > 0}>
        <Modal open={more()} title="All answers" description={props.prompt.question} onClose={() => more.set(false)}>
          <If when={more()}>
            <View class="gap-2">
              <If when={props.prompt.subject}>
                {(subject) => (
                  <Text style={{ userSelect: "text" }} class="font-mono text-sm text-foreground">
                    {subject()}
                  </Text>
                )}
              </If>
              <Each of={props.prompt.options} key={(o) => o.index}>
                {chip}
              </Each>
            </View>
          </If>
        </Modal>
      </If>
    </View>
  );
}

/** One answer. Its name is the agent's own words; armed, it says what to do next and why. */
function Chip(props: {
  option: PromptOption;
  armed: boolean;
  busy: boolean;
  flashed: boolean;
  dim: boolean;
  onPress: () => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const name = () => {
    if (props.armed) return `${props.option.label}. Press again to send, ${riskText(props.option)}`;
    if (props.flashed) return `${props.option.label}. The question changed`;
    if (props.busy) return `${props.option.label}, sending`;
    return props.option.label;
  };
  return (
    <View
      role="button"
      accessibilityLabel={name()}
      accessibilityState={{ selected: props.armed, busy: props.busy }}
      onPress={props.onPress}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      style={hoverTransition()}
      class={`max-w-full flex-row items-center gap-2 rounded-md border px-3 py-2 hover:bg-accent ${largeTargets() ? "min-h-11" : "min-h-9"} ${
        props.dim ? "opacity-50" : ""
      } ${props.armed ? "border-warning bg-warning/20 dark:bg-warning/12" : "border-input bg-card"} ${FOCUS_RING}`}
    >
      <If when={isRisky(props.option)}>
        <Icon name="alert" size={14} tone="muted-foreground" />
      </If>
      <View class="shrink gap-0.5">
        <Text class="text-sm font-medium text-foreground">{props.flashed ? "The question changed" : props.option.label}</Text>
        <If when={props.armed}>
          <Text class="text-xs text-foreground">{`Press again to send · ${riskText(props.option)}`}</Text>
        </If>
      </View>
      <If when={props.busy}>
        <Spinner size={14} tone="muted-foreground" />
      </If>
    </View>
  );
}
