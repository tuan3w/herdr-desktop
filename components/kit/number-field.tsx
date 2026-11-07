import { cleanup, effect, keymap, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";
import type { PressEvent, ViewRef } from "nsh/types";
import { hoverTransition } from "#lib/motion";
import { NUM } from "./core";
import { useFieldControl } from "./field";
import type { FieldRules } from "./field-parts";
import { INPUT_CLASS, INPUT_ERROR, Labeled } from "./fields";
import {
  canBeNumber,
  commitText,
  createHold,
  formatNumber,
  type NumberFormat,
  NUMBER_KEYS,
  type StepSize,
  stepBy,
} from "./number";

export interface NumberFieldProps extends FieldRules {
  label: string;
  /** The number, `null` when the field is empty (0 is a value; empty is not). Controlled when given. */
  value?: number | null;
  defaultValue?: number | null;
  /** The number changed: a keystroke that reads as a number, a step, a clear. Not called for a text that is not a number yet. */
  onChange?: (value: number | null) => void;
  /** An edit is finished: the field was left or Return pressed after typing, a key or a press stepped it, a hold ended. */
  onCommit?: (value: number | null) => void;
  min?: number;
  max?: number;
  /** The arrow keys and the buttons. Default 1. */
  step?: number;
  /** With `mod` held (Command on a Mac, Ctrl elsewhere). Default 0.1. */
  smallStep?: number;
  /** With Shift held, and the Page keys. Default 10. */
  largeStep?: number;
  /** A step lands on the grid of its amount from `min` (from 0 without one). */
  snapOnStep?: boolean;
  /** Typed values may be outside `min` and `max` and then break `rangeUnderflow` / `rangeOverflow`; steps still clamp. */
  allowOutOfRange?: boolean;
  /** `Intl.NumberFormat` options: `maximumFractionDigits`, `style: "percent"`, `currency`, `unit`. English separators. */
  format?: NumberFormat;
  required?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  /** Written after the field, outside its box: `kg`, `s`, `lines`. For a unit Intl knows, use `format` instead. */
  unit?: string;
  /** The `−` and `+` buttons, shown while the pointer is over the field or it has the focus (default). `false` leaves them out. */
  steppers?: boolean;
  hint?: string;
  error?: string;
  reserve?: boolean;
  autoFocus?: boolean;
  onSubmit?: () => void;
  onBlur?: () => void;
}

const BAR = "rounded-full bg-muted-foreground";

function Stepper(props: {
  dir: 1 | -1;
  label: string;
  disabled: boolean;
  onDown: (e?: PressEvent) => void;
  onUp: () => void;
  onActivate: () => void;
}) {
  return (
    <View
      role="button"
      focusable={false}
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPressDown={props.onDown}
      onPressUp={props.onUp}
      onMouseLeave={props.onUp}
      onPress={props.onActivate}
      style={hoverTransition()}
      class="size-6 items-center justify-center rounded hover:bg-accent"
    >
      <View class="items-center justify-center">
        <View class={`h-0.5 w-2.5 ${BAR}`} />
        <If when={props.dir === 1}>
          <View class={`absolute h-2.5 w-0.5 ${BAR}`} />
        </If>
      </View>
    </View>
  );
}

function NumberControl(props: { p: NumberFieldProps; value: () => number | null; set: (v: number | null) => void }) {
  const p = props.p;
  let input: ViewRef | undefined;
  const draft = signal<string | undefined>(undefined);
  const focused = signal(false);
  const composing = signal(false);
  // A refused text must be put back, but the host sends the input only a value that differs from the one it was last given,
  // and the same text again does not. So the field is given an invisible character for one turn.
  const nudged = signal(false);
  const bounds = () => ({ min: p.min, max: p.max, allowOutOfRange: !!p.allowOutOfRange, format: p.format });
  // What the field held when the current typing began, which Escape goes back to.
  let beforeEdit: number | null = null;
  const typing = (text: string) => {
    if (untracked(draft) === undefined) beforeEdit = untracked(props.value);
    draft.set(text);
  };
  const text = () => draft() ?? formatNumber(props.value(), p.format);
  const badText = () => {
    const d = draft();
    return d !== undefined && commitText(d, bounds()).kind === "bad";
  };
  const locked = () => !!p.readOnly;

  const control = useFieldControl({
    value: props.value,
    required: () => p.required,
    empty: (v) => v === null,
    violations: (v) => {
      const out: { key: "badInput" | "rangeUnderflow" | "rangeOverflow"; message: string }[] = [];
      if (badText()) out.push({ key: "badInput", message: "Enter a number, for example 1,234.5." });
      if (typeof v === "number" && p.min !== undefined && v < p.min) out.push({ key: "rangeUnderflow", message: `Enter ${formatNumber(p.min, p.format)} or more.` });
      if (typeof v === "number" && p.max !== undefined && v > p.max) out.push({ key: "rangeOverflow", message: `Enter ${formatNumber(p.max, p.format)} or less.` });
      return out;
    },
    focus: () => input?.focus(),
    disabled: () => p.disabled,
  });

  const unavailable = () => control.disabled() || locked();
  const set = (next: number | null) => {
    if (!Object.is(next, untracked(props.value))) {
      props.set(next);
      p.onChange?.(next);
    }
  };
  /** The typed text becomes the value (or is refused and stays as typed). Returns the value the field holds now. */
  const commitDraft = (): number | null => {
    const d = untracked(draft);
    if (d === undefined) return untracked(props.value);
    const result = commitText(d, bounds());
    if (result.kind === "bad") return untracked(props.value);
    const next = result.kind === "empty" ? null : result.value;
    set(next);
    draft.set(undefined);
    return next;
  };

  const amountOf = (size: StepSize) => (size === "large" ? (p.largeStep ?? 10) : size === "small" ? (p.smallStep ?? 0.1) : (p.step ?? 1));
  /** One step from what the field holds (a text still being typed counts first). Whether it changed anything. */
  const stepNow = (dir: 1 | -1, size: StepSize): boolean => {
    if (unavailable()) return false;
    const from = commitDraft();
    draft.set(undefined);
    const next = stepBy(from, dir, amountOf(size), { min: p.min, max: p.max, snap: !!p.snapOnStep, nearest: size === "small" });
    if (Object.is(next, from)) return false;
    set(next);
    return true;
  };
  const notifyCommit = () => p.onCommit?.(untracked(props.value));

  // Keys while the field has the focus. Only then: a bare Up or Down belongs to whatever else is on screen.
  effect(() => {
    if (!focused() || unavailable()) return;
    const bounded = p.min !== undefined && p.max !== undefined;
    const bindings: Record<string, () => void> = {};
    for (const [stroke, action] of Object.entries(NUMBER_KEYS)) {
      if ("bound" in action) {
        if (!bounded) continue;
        bindings[stroke] = () => {
          commitDraft();
          const to = action.bound === "min" ? p.min : p.max;
          if (to !== undefined && to !== untracked(props.value)) {
            set(to);
            commitDraft();
            notifyCommit();
          }
        };
      } else {
        bindings[stroke] = () => {
          if (stepNow(action.dir, action.size)) notifyCommit();
        };
      }
    }
    return keymap.bind(bindings, { when: "always", repeat: true });
  });
  // Escape takes back what was typed since the last commit.
  effect(() => {
    if (!focused() || draft() === undefined) return;
    return keymap.bind(
      "escape",
      () => {
        draft.set(undefined);
        set(beforeEdit);
      },
      { when: "always" },
    );
  });

  let heldSize: StepSize = "step";
  let heldDown = false;
  const holds = { 1: createHold(() => stepNow(1, heldSize)), "-1": createHold(() => stepNow(-1, heldSize)) } as const;
  cleanup(() => {
    holds[1].stop();
    holds["-1"].stop();
  });
  const pressDown = (dir: 1 | -1, e?: PressEvent) => {
    if (unavailable()) return;
    heldDown = true;
    const m = e?.modifiers;
    heldSize = m?.shift ? "large" : m?.platform || m?.control ? "small" : "step";
    // The keyboard goes on working from the field after the press.
    input?.focus();
    const before = untracked(props.value);
    holds[dir === 1 ? 1 : "-1"].start();
    changedByHold = !Object.is(before, untracked(props.value));
  };
  let changedByHold = false;
  const pressUp = (dir: 1 | -1) => {
    const hold = holds[dir === 1 ? 1 : "-1"];
    if (!hold.running && !changedByHold) return;
    hold.stop();
    changedByHold = false;
    notifyCommit();
  };
  const atMax = () => {
    const v = props.value();
    return p.max !== undefined && v !== null && v >= p.max;
  };
  const atMin = () => {
    const v = props.value();
    return p.min !== undefined && v !== null && v <= p.min;
  };
  const now = () => props.value() ?? undefined;

  const evaluate = (value: string) => {
    if (!canBeNumber(value, p.format, p.min === undefined || p.min < 0 || !!p.allowOutOfRange)) {
      nudged.set(true);
      queueMicrotask(() => nudged.set(false));
      return;
    }
    typing(value);
    const result = commitText(value, bounds());
    if (result.kind === "empty") set(null);
    else if (result.kind === "value") set(result.value);
  };

  const field = (
    <View class="group relative min-w-0 flex-1">
      <Input
        ref={(node: ViewRef) => {
          input = node;
        }}
        value={nudged() ? `${text()}\u200b` : text()}
        placeholder={p.placeholder}
        role="spinbutton"
        accessibilityLabel={control.label() ?? (p.label || p.placeholder)}
        accessibilityHint={control.hint()}
        accessibilityValue={{ min: p.min, max: p.max, now: now(), text: formatNumber(props.value(), p.format) || undefined }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => {
          if (stepNow(e.actionName === "increment" ? 1 : -1, "step")) notifyCommit();
        }}
        disabled={control.disabled()}
        readonly={locked()}
        keyboardType={p.min !== undefined && p.min >= 0 ? "decimal-pad" : "numbers-and-punctuation"}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        autoFocus={p.autoFocus}
        submitBehavior={p.onSubmit || control.inForm ? "submit" : undefined}
        onSubmit={() => {
          if (untracked(draft) !== undefined) {
            commitDraft();
            notifyCommit();
          }
          p.onSubmit?.();
          control.submit();
        }}
        onChange={({ value }) => {
          if (locked()) return;
          // Half-composed text (Telex, VNI) is not final: keep it, read it once the composition ends.
          if (composing()) typing(value);
          else evaluate(value);
        }}
        onCompositionChange={(e) => {
          composing.set(e.composing);
          if (!e.composing) {
            const d = untracked(draft);
            if (d !== undefined) evaluate(d);
          }
        }}
        onFocus={() => {
          focused.set(true);
          control.focused();
        }}
        onBlur={() => {
          focused.set(false);
          if (untracked(draft) !== undefined) {
            const hadText = commitDraft();
            if (untracked(draft) === undefined) p.onCommit?.(hadText);
          }
          control.blurred();
          p.onBlur?.();
        }}
        style={{ ...hoverTransition(), ...NUM }}
        class={`${INPUT_CLASS} ${p.steppers === false ? "" : "pr-14"} ${control.invalid() ? INPUT_ERROR : ""}`}
      />
      <If when={p.steppers !== false && !locked() && !control.disabled()}>
        <View class="absolute bottom-0 right-1 top-0 flex-row items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <Stepper
            dir={-1}
            label={p.label ? `Decrease: ${p.label}` : "Decrease"}
            disabled={atMin()}
            onDown={(e) => pressDown(-1, e)}
            onUp={() => pressUp(-1)}
            onActivate={() => {
              if (heldDown) heldDown = false;
              else if (stepNow(-1, "step")) notifyCommit();
            }}
          />
          <Stepper
            dir={1}
            label={p.label ? `Increase: ${p.label}` : "Increase"}
            disabled={atMax()}
            onDown={(e) => pressDown(1, e)}
            onUp={() => pressUp(1)}
            onActivate={() => {
              if (heldDown) heldDown = false;
              else if (stepNow(1, "step")) notifyCommit();
            }}
          />
        </View>
      </If>
    </View>
  );
  return (
    <If when={p.unit} else={field}>
      <View class="flex-row items-center gap-2">
        {field}
        <Text class="text-sm text-muted-foreground">{p.unit}</Text>
      </View>
    </If>
  );
}

/**
 * A number: a delay, a count, a size. Written the English way (`1,234.5`), read in either convention, stepped by
 * Up and Down (`step`), Shift or the Page keys (`largeStep`), `mod` (`smallStep`) and by the buttons, with press and hold.
 * Empty is `null`, not 0. A typed value is clamped to `min` and `max` when the field is left (not at all with
 * `allowOutOfRange`, which then reports it as a broken constraint). It is a form field like `Field` (`design/inputs.md`).
 */
export function NumberField(props: NumberFieldProps) {
  const own = signal<number | null>(props.defaultValue ?? null);
  const value = () => (props.value !== undefined ? props.value : own());
  return (
    <Labeled
      label={props.label}
      error={props.error}
      hint={props.hint}
      reserve={props.reserve}
      name={props.name}
      disabled={props.disabled}
      invalid={props.invalid}
      validate={props.validate}
      validationMode={props.validationMode}
      validationDebounceTime={props.validationDebounceTime}
    >
      <NumberControl
        p={props}
        value={value}
        set={(next) => {
          if (props.value === undefined) own.set(next);
        }}
      />
    </Labeled>
  );
}
