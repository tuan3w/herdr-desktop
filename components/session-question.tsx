import { announce, computed, effect, Scroll, signal, Text, untracked, View } from "nsh";
import { Sessions } from "herdr-desktop/native";
import type { ActionResult, QuestionFieldView, SessionView } from "herdr-desktop/native";
import { answerOf, type FieldState, placeRefusal, startState } from "#lib/session-answers";
import { restartable } from "#lib/timer";
import { Btn, CheckRow, Field, Labeled, RadioGroup, RadioItem, SelectField } from "#kit";

/** How long the form takes no answer after it appears or changes: a keystroke aimed at what was there before must not submit it. */
const GUARD_MS = 400;
/** Choices up to this many are radio buttons; more are a select (a long list of radios is a wall). */
const RADIOS = 5;
/** The tallest the form grows before it scrolls inside itself, in points. */
const MAX_HEIGHT = 340;

/**
 * What was typed into each question, kept outside the component per session and request: a permission that arrives
 * while a question is open takes the dock, and the form comes back as it was left, not blank. Dropped once the
 * session no longer waits on the question (answered, declined or withdrawn).
 */
const drafts = new Map<string, FieldState[]>();

/**
 * The form of an agent's question (an elicitation): choices, free text, numbers, several-of-many, yes or no, then
 * `Accept` or `Decline`. The first request of `view.waiting` shows if it is a question (a permission is
 * `PermissionDock`'s). Validation is Rust's (`Sessions.answerQuestion`): a field that does not pass gives its reason
 * under that field and the form stays as typed. Rules, each with a test in `session-question.test.tsx`:
 * - nothing is sent by itself; Enter submits only from inside a text field, never from anywhere else;
 * - a press within 400 ms of the form appearing or changing is ignored, and the buttons are dimmed meanwhile;
 * - `Accept` and `Decline` go with the request and digest on screen: a refusal says `The request changed`;
 * - what was typed survives another request taking the dock, and is dropped once the question is gone;
 * - the dock never takes the focus.
 * A field the app cannot draw says so and keeps the agent's default.
 */
export function SessionQuestion(props: { machine: string; id: string; view: SessionView }) {
  const request = computed(() => {
    const first = props.view.waiting[0];
    return first?.ask === "question" ? first : undefined;
  });
  const identity = computed(() => {
    const r = request();
    return r ? `${props.machine}/${props.id}/${r.requestId}/${r.digest}` : "";
  });
  const values = signal<FieldState[]>([]);
  const errors = signal<Record<number, string>>({});
  const note = signal("");
  const sending = signal<"accept" | "decline" | null>(null);
  const guarded = signal(true);
  const guard = restartable();

  // A question that is not the one on screen: its form starts from what the person left (or from the agent's defaults).
  effect(() => {
    const now = identity();
    const w = untracked(request);
    guarded.set(true);
    guard.after(GUARD_MS, () => guarded.set(false));
    errors.set({});
    note.set("");
    sending.set(null);
    if (now === "" || !w) return;
    const key = `${props.machine}/${props.id}/${w.requestId}`;
    values.set(drafts.get(key) ?? w.fields.map(startState));
    announce(`The agent asks: ${w.message ?? "a question"}`);
  });

  // Drafts of this session's questions that are no longer waiting are dropped.
  effect(() => {
    const live = new Set(props.view.waiting.filter((x) => x.ask === "question").map((x) => `${props.machine}/${props.id}/${x.requestId}`));
    const mine = `${props.machine}/${props.id}/`;
    for (const key of [...drafts.keys()]) if (key.startsWith(mine) && !live.has(key)) drafts.delete(key);
  });

  const change = (index: number, patch: Partial<FieldState>) => {
    const w = request();
    if (!w) return;
    const next = values().map((v, i) => (i === index ? { ...v, ...patch } : v));
    values.set(next);
    drafts.set(`${props.machine}/${props.id}/${w.requestId}`, next);
    if (errors()[index]) errors.update((e) => ({ ...e, [index]: "" }));
  };
  const state = (index: number): FieldState => values()[index] ?? { text: "", choice: null, ticked: [] };
  const more = () => props.view.waiting.length - 1;
  const busy = () => sending() !== null;

  /** Puts a refusal where the person looks: under the field it names, else in the line under the buttons. */
  const refuse = (result: ActionResult, fields: readonly QuestionFieldView[]) => {
    if (result.kind === "changed") {
      note.set("The request changed. Nothing was sent.");
      announce("The request changed");
      return;
    }
    if (result.kind === "invalid") {
      const placed = placeRefusal(result.message, fields.map((f) => f.label));
      if (placed.field !== null) errors.update((e) => ({ ...e, [placed.field]: placed.why }));
      else note.set(`Not sent: ${placed.why}`);
      announce(result.message);
      return;
    }
    note.set(`Not sent: ${result.message}`);
    announce(note());
  };
  const failed = (e: unknown): ActionResult => ({ kind: "stopped", message: e instanceof Error ? e.message : String(e) });

  async function send(how: "accept" | "decline") {
    const w = request();
    if (!w) return;
    if (guarded()) {
      announce("The question just changed. Try again.");
      return;
    }
    if (busy()) return;
    sending.set(how);
    errors.set({});
    note.set("");
    const result =
      how === "accept"
        ? await Sessions.answerQuestion(props.machine, props.id, w.requestId, w.digest, w.fields.map((f, i) => answerOf(f, state(i)))).catch(failed)
        : await Sessions.dismiss(props.machine, props.id, w.requestId, w.digest).catch(failed);
    sending.set(null);
    if (result.kind === "done") {
      const done = how === "accept" ? "Answered" : "Declined";
      note.set(done);
      announce(done);
      return;
    }
    refuse(result, w.fields);
  }

  /** One field, drawn for what it takes. */
  const field = (f: () => QuestionFieldView, index: () => number) => {
    const label = () => `${f().label}${f().required ? " *" : ""}`;
    const hint = () => [f().description, f().secret ? "The agent marked this secret. A form is not a safe place for one." : undefined].filter(Boolean).join(" ") || undefined;
    const error = () => errors()[index()] || undefined;
    const titles = () => f().choices.map((c, i) => ({ value: String(i), title: c.title }));
    // One wrapper without a gap: the `If`s that are not this kind draw nothing, but they still count as children of a gapped parent.
    return (
      <View>
        <If when={f().kind === "text" || f().kind === "number"}>
          <Field
            label={label()}
            hint={hint()}
            error={error()}
            reserve
            mono={f().kind === "number"}
            value={state(index()).text}
            onChange={(text) => change(index(), { text })}
            onSubmit={() => void send("accept")}
          />
        </If>
        <If when={f().kind === "choice" && f().choices.length > RADIOS}>
          <Labeled label={label()} hint={hint()} error={error()} reserve>
            <SelectField
              name={f().label}
              items={titles()}
              value={state(index()).choice === null ? "" : String(state(index()).choice)}
              onChange={(v) => change(index(), { choice: Number(v) })}
            />
          </Labeled>
        </If>
        <If when={(f().kind === "choice" && f().choices.length <= RADIOS) || f().kind === "bool"}>
          <Labeled label={label()} hint={hint()} error={error()} reserve>
            <RadioGroup
              label={f().label}
              orientation="vertical"
              value={state(index()).choice === null ? undefined : String(state(index()).choice)}
              onChange={(v) => change(index(), { choice: Number(v) })}
            >
              <Each of={f().kind === "bool" ? [{ value: "0", title: "Yes" }, { value: "1", title: "No" }] : titles()} key="index">
                {(c) => (
                  <RadioItem value={c().value} label={c().title} class="h-9 flex-row items-center gap-2 rounded-md px-1 hover:bg-accent">
                    <View class="size-4 items-center justify-center rounded-full border border-input group-checked:border-primary">
                      <View class="size-2 rounded-full bg-transparent group-checked:bg-primary" />
                    </View>
                    <Text class="text-sm text-foreground">{c().title}</Text>
                  </RadioItem>
                )}
              </Each>
            </RadioGroup>
          </Labeled>
        </If>
        <If when={f().kind === "multi"}>
          <Labeled label={label()} hint={hint()} error={error()} reserve>
            <View role="group" accessibilityLabel={f().label} class="gap-1">
              <Each of={f().choices} key="index">
                {(c, i) => (
                  <CheckRow
                    label={c().title}
                    checked={state(index()).ticked.includes(i())}
                    onChange={(on) => change(index(), { ticked: on ? [...state(index()).ticked, i()].sort((a, b) => a - b) : state(index()).ticked.filter((t) => t !== i()) })}
                  >
                    <Text class="text-sm text-foreground">{c().title}</Text>
                  </CheckRow>
                )}
              </Each>
            </View>
          </Labeled>
        </If>
        <If when={f().kind === "unsupported"}>
          <Text class="text-sm text-muted-foreground">{`${f().label}: this app cannot show this field, so the agent's default is used.`}</Text>
        </If>
      </View>
    );
  };

  return (
    <If when={request()}>
      {(w) => (
        <View role="group" accessibilityLabel="Question from the agent" class="gap-3 border-t border-border bg-background px-4 py-3">
          <View class="gap-1">
            <Text role="header" class="text-sm font-medium text-foreground">
              The agent asks
            </Text>
            <Text style={{ userSelect: "text" }} class="text-sm text-foreground">
              {w().message ?? ""}
            </Text>
            <If when={w().description}>
              <Text class="text-xs text-muted-foreground">{w().description ?? ""}</Text>
            </If>
          </View>
          <If when={w().fields.length > 0}>
            <Scroll style={{ maxHeight: MAX_HEIGHT }}>
              <View class="gap-2">
                <Each of={w().fields} key="index">
                  {(f, i) => field(f, i)}
                </Each>
              </View>
            </Scroll>
          </If>
          <View class="flex-row flex-wrap items-center gap-2">
            <Btn variant="primary" label="Accept" disabled={guarded()} loading={sending() === "accept"} onPress={() => void send("accept")} />
            <Btn label="Decline" disabled={guarded()} loading={sending() === "decline"} onPress={() => void send("decline")} />
          </View>
          <View class="min-h-4 flex-row items-center justify-between gap-3">
            <Text class="min-w-0 flex-1 text-xs text-muted-foreground">{note()}</Text>
            <If when={more() > 0}>
              <Text class="text-xs text-muted-foreground">{`${more()} more waiting`}</Text>
            </If>
          </View>
        </View>
      )}
    </If>
  );
}
