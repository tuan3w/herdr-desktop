import { announce, computed, effect, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import type { ScrollRef } from "nsh/types";
import { Sessions } from "herdr-desktop/native";
import type { ActionResult, DiffItem, PermissionChoiceView, SessionView, WaitingView } from "herdr-desktop/native";
import { restartable } from "#lib/timer";
import { rowsOf, visibleText } from "#lib/visible-text";
import { AskChip } from "#components/ask-chip";
import { Btn, Clipped, Icon, Modal } from "#kit";
import { PermissionDiff } from "#components/permission-diff";
import { PlanSteps } from "#components/plan-steps";

/** How long an answer that just appeared or changed takes no press: a click aimed at the request before it must not land on this one. */
const GUARD_MS = 400;
/** How long a risky answer stays armed after its first press. */
const ARM_MS = 4000;
/** How long `The request changed` stays on the button that was pressed. */
const FLASH_MS = 1500;
/** Rows of the command box before it scrolls; the line height and the padding around them, in points. */
const BOX_ROWS = 8;
const LINE = 20;
const PAD = 8;
/** Characters a row of the command box holds, for guessing how tall a command is before it has been laid out. */
const COLUMNS = 96;
/** Rows of the transcript looked at for what the agent said and did just before asking. */
const WINDOW = 12;

/** What an `ActionResult` of an answer that did not go through says on the dock; `changed` has its own treatment. */
const REFUSAL_NOTE: Partial<Record<ActionResult["kind"], string>> = {
  tooSoon: "That came too soon after the request appeared. Press again.",
  nothingWaiting: "Nothing is waiting for an answer any more. Nothing was sent.",
};

/** Words for what the agent asks to do, by the kind it names. */
const KIND_WORDS: Record<string, string> = {
  execute: "Run a command",
  edit: "Edit a file",
  read: "Read a file",
  delete: "Delete a file",
  move: "Move a file",
  fetch: "Fetch a page",
  search: "Search",
  think: "Think",
};

const isAllow = (c: PermissionChoiceView) => !c.kind?.startsWith("reject");

/** Whether pressing `choice` takes two presses: a standing grant, or an allow of a command the rules say deserves a second look. */
const isRisky = (w: WaitingView, c: PermissionChoiceView) => c.standing || (w.risk !== undefined && w.risk !== null && isAllow(c));

/** Why a second press is asked: what the command does, and that the answer outlives this call when it does. */
function riskText(w: WaitingView, c: PermissionChoiceView): string {
  const parts: string[] = [];
  if (w.risk && isAllow(c)) parts.push(w.risk);
  if (c.standing) parts.push(isAllow(c) ? "grants this permanently" : "rejects this permanently");
  return parts.join(" · ");
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
  const open = [...rows].reverse().filter((r) => r.kind === "tool" && r.tool && (r.tool.status === "pending" || r.tool.status === "inProgress") && r.tool.diffs.length > 0);
  const call = open.find((r) => r.tool?.title === title) ?? open[0];
  return { said, diffs: call?.tool?.diffs ?? [] };
}

/**
 * The request of an agent session that waits for the person, above the composer: what the agent wants to do, in full,
 * and the agent's own answers to it. The first request of `view.waiting` shows if it is a permission (a question is
 * `SessionQuestion`'s); more behind it are counted. The safety rules, each with a test in `permission-dock.test.tsx`:
 * - nothing is sent by itself or on a timer: only a press does;
 * - a press within 400 ms of a request appearing or changing is ignored, and the answers are dimmed meanwhile;
 * - every answer goes through `Sessions.answerPermission` with the request and digest that were on screen; a refusal
 *   (the request changed, or was answered elsewhere) says `The request changed` and sends nothing;
 * - a risky answer (the rules found a reason, or it is a standing grant) is two presses: the first arms it for 4 s
 *   and says why, the second sends; focus stays on the button;
 * - the command is shown whole, wrapped; one too long for its box says `More below` and offers `Read all`, and the
 *   first press of an allow before the end was reached scrolls to the end instead of sending;
 * - the dock never takes the focus; the digits 1 to 9 answer only while an answer has it.
 * What the agent said before asking, the edits it would make and its plan show with the request.
 */
export function PermissionDock(props: { machine: string; id: string; view: SessionView }) {
  const request = computed(() => {
    const first = props.view.waiting[0];
    return first?.ask === "permission" ? first : undefined;
  });
  // The session is part of the identity: a dock reused for another session must not keep the first one's armed answer.
  const identity = computed(() => {
    const r = request();
    return r ? `${props.machine}/${props.id}/${r.requestId}/${r.digest}` : "";
  });
  const guarded = signal(true);
  const armed = signal<string | null>(null);
  const sending = signal<string | null>(null);
  const refused = signal<string | null>(null);
  const note = signal("");
  const readAll = signal(false);
  const reading = signal(false);
  const focused = signal(0);
  const contentHeight = signal(0);
  const viewport = signal(0);
  const offset = signal(0);
  const guard = restartable();
  const arming = restartable();
  const flashing = restartable();
  let scroll: ScrollRef | undefined;

  // A new request (or the first) is what the person has not seen: nothing armed, read or refused carries over.
  effect(() => {
    const now = identity();
    guarded.set(true);
    guard.after(GUARD_MS, () => guarded.set(false));
    arming.stop();
    flashing.stop();
    armed.set(null);
    refused.set(null);
    sending.set(null);
    note.set("");
    readAll.set(false);
    reading.set(false);
    contentHeight.set(0);
    viewport.set(0);
    offset.set(0);
    const w = untracked(request);
    if (now !== "" && w) announce(`The agent asks: ${visibleText(w.subject ?? w.title ?? "to continue").split("\n")[0]!.slice(0, 200)}`);
  });

  const text = computed(() => visibleText(request()?.subject ?? request()?.title ?? ""));
  const measured = () => contentHeight() > 0 && viewport() > 0;
  const overflow = () => (measured() ? contentHeight() > viewport() + 2 : rowsOf(text(), COLUMNS) > BOX_ROWS);
  const atEnd = () => readAll() || !overflow() || (measured() && offset() + viewport() >= contentHeight() - 2);
  const below = () => (measured() ? Math.max(1, Math.ceil((contentHeight() - viewport() - offset()) / LINE)) : Math.max(1, rowsOf(text(), COLUMNS) - BOX_ROWS));

  const around = computed(() => {
    void props.view.revision;
    const w = request();
    return w ? lead(props.machine, props.id, props.view, w.title ?? "") : { diffs: [] };
  });
  const more = () => props.view.waiting.length - 1;
  const busy = () => sending() !== null || refused() !== null;

  const settle = (result: ActionResult, done: string) => {
    const pressed = sending();
    sending.set(null);
    switch (result.kind) {
      case "done":
        note.set(done);
        announce(done);
        return;
      case "changed":
        refused.set(pressed ?? "");
        flashing.after(FLASH_MS, () => refused.set(null));
        note.set("The request changed. Nothing was sent.");
        announce("The request changed");
        return;
      default:
        note.set(REFUSAL_NOTE[result.kind] ?? `Not sent: ${result.message}`);
        announce(note());
    }
  };
  const failed = (e: unknown): ActionResult => ({ kind: "stopped", message: e instanceof Error ? e.message : String(e) });

  async function activate(choice: PermissionChoiceView) {
    const w = request();
    if (!w) return;
    if (guarded()) {
      announce("The request just changed. Press again.");
      return;
    }
    if (busy()) return;
    const risky = isRisky(w, choice);
    const arm = () => {
      armed.set(choice.id);
      arming.after(ARM_MS, () => armed.set(null));
    };
    if (isAllow(choice) && overflow() && !atEnd()) {
      // The person has not seen the end of what they would allow: show it first, and this press counts as reading it.
      readAll.set(true);
      scroll?.scrollTo({ y: contentHeight(), animated: false });
      if (risky) arm();
      note.set("Read it all, then press again.");
      announce(`Read it all, then press again.${risky ? ` ${riskText(w, choice)}` : ""}`);
      return;
    }
    if (risky && armed() !== choice.id) {
      arm();
      announce(`Press again to send. ${riskText(w, choice)}`);
      return;
    }
    arming.stop();
    armed.set(null);
    sending.set(choice.id);
    note.set("");
    const result = await Sessions.answerPermission(props.machine, props.id, w.requestId, w.digest, choice.id).catch(failed);
    settle(result, `Sent: ${choice.name}`);
  }

  async function cancel() {
    const w = request();
    if (!w || busy()) return;
    if (guarded()) {
      announce("The request just changed. Press again.");
      return;
    }
    sending.set("cancel");
    note.set("");
    const result = await Sessions.dismiss(props.machine, props.id, w.requestId, w.digest).catch(failed);
    settle(result, "Request cancelled");
  }

  // Digits answer only while an answer has the focus: bound then, released with the focus, so typing elsewhere is untouched.
  effect(() => {
    if (focused() === 0) return;
    const keys: Record<string, () => void> = {};
    (request()?.choices ?? []).forEach((choice, i) => {
      if (i < 9) keys[String(i + 1)] = () => void activate(choice);
    });
    return keymap.bind(keys);
  });

  return (
    <If when={request()}>
      {(w) => (
        <View role="group" accessibilityLabel="Permission request" class="gap-3 border-t border-border bg-background px-4 py-3">
          <View class="gap-1">
            <Text role="header" class="text-sm font-medium text-foreground">
              {KIND_WORDS[w().toolKind ?? ""] ?? "Permission request"}
            </Text>
            <If when={w().subject && w().title && w().title !== w().subject}>
              <Text class="text-xs text-muted-foreground">{visibleText(w().title ?? "")}</Text>
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
          <View role="group" accessibilityLabel="What the agent asks to do" class="gap-1">
            <Scroll
              ref={(node: ScrollRef) => {
                scroll = node;
              }}
              onLayout={({ bounds }) => viewport.set(bounds.size.height)}
              onScroll={(e) => offset.set(e.offset.y)}
              style={{ maxHeight: BOX_ROWS * LINE + PAD * 2 }}
              class="rounded-md border border-border bg-muted"
            >
              <View onLayout={({ bounds }) => contentHeight.set(bounds.size.height)} style={{ padding: PAD }}>
                <Text style={{ userSelect: "text", lineHeight: LINE }} class="font-mono text-sm text-foreground">
                  {text()}
                </Text>
              </View>
            </Scroll>
            <If when={overflow()}>
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-xs text-muted-foreground">{atEnd() ? "End of the command" : `More below · ${below()} lines`}</Text>
                <Btn
                  small
                  variant="ghost"
                  label="Read all"
                  onPress={() => {
                    readAll.set(true);
                    reading.set(true);
                  }}
                />
              </View>
            </If>
          </View>
          <If when={w().risk}>
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
          <PlanSteps plan={props.view.plan} />
          <View role="group" accessibilityLabel="Answers" class="flex-row flex-wrap items-start gap-2">
            <Each of={w().choices} key={(c: PermissionChoiceView) => c.id}>
              {(choice) => (
                <AskChip
                  label={choice().name}
                  risky={isRisky(w(), choice())}
                  armed={armed() === choice().id ? riskText(w(), choice()) || "this answer cannot be taken back" : undefined}
                  busy={sending() === choice().id}
                  refused={refused() === choice().id ? "The request changed" : undefined}
                  dim={guarded() || busy()}
                  onPress={() => void activate(choice())}
                  onFocus={() => focused.update((n) => n + 1)}
                  onBlur={() => focused.update((n) => Math.max(0, n - 1))}
                />
              )}
            </Each>
            <Btn variant="ghost" label="Cancel request" loading={sending() === "cancel"} onPress={() => void cancel()} />
          </View>
          <View class="min-h-4 flex-row items-center justify-between gap-3">
            <Text class="min-w-0 flex-1 text-xs text-muted-foreground">{note()}</Text>
            <If when={more() > 0}>
              <Text class="text-xs text-muted-foreground">{`${more()} more waiting`}</Text>
            </If>
          </View>
          <Modal
            open={reading()}
            wide
            title="The whole command"
            description="Exactly what the agent asks to do."
            onClose={() => reading.set(false)}
            actions={<Btn variant="ghost" label="Close" onPress={() => reading.set(false)} />}
          >
            <If when={reading()}>
              <Text style={{ userSelect: "text" }} class="font-mono text-sm text-foreground">
                {text()}
              </Text>
            </If>
          </Modal>
        </View>
      )}
    </If>
  );
}
