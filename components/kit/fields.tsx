import { announce, effect, type JSX, keymap, signal, View } from "nsh";
import { Input } from "nsh/base";

import type { InputRef, PasteEvent } from "nsh/types";

import { hoverTransition } from "#lib/motion";
import { largeTargets } from "#lib/settings";

import { IconButton } from "./button";
import { spoken } from "./check";
import { drawsOwnValue } from "./combo-rules";
import { FieldScope, useFieldControl, type Violation } from "./field";
import { FieldDescription, FieldError, FieldLabel, type FieldRules, FieldRoot, OneLine } from "./field-parts";
import { Icon } from "./icon";

/** What a text input is doing, for its look. */
export interface InputState {
  invalid?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  /** The dense 28 pt tier (`CONTROL.small`); 44 under Large hit targets like every control. */
  small?: boolean;
  /** Replaces the one-line height: a multiline box's own. */
  height?: string;
}

/** The input's height: 32, and 44 under Large hit targets like `Btn` and `SelectField`, so no input is the small target. A `min-h`, so large text grows the box instead of cutting it. */
export const inputHeight = (small?: boolean) => (largeTargets() ? "min-h-11" : small ? "min-h-7" : "min-h-8");

/**
 * THE look of a one-line text input (`Field`, `NumberField`, `Combobox`, `Autocomplete`): hover darkens the edge; focus
 * turns the border `ring` and adds a 0.5 pt outline at offset 0 (the one ring, `RING_BORDERED`). Invalid keeps the
 * `destructive` edge, focused or not. Disabled fades to 50% (as `Btn`, `Switch`, `CheckRow` and `SelectField`: the label
 * alone fading read as an enabled box); read-only drops the hover and sits on a recessed fill, so a box that cannot be
 * typed into does not look like one that can. Classes never conflict (one fill, one edge, one height), so no state
 * depends on the class engine's order.
 */
export function inputLook(state: InputState = {}): string {
  const fill = state.readOnly ? "bg-muted/50" : "bg-card";
  const edge = state.invalid
    ? "border-destructive focus:outline-destructive"
    : `border-input focus:border-ring focus:outline-ring ${state.readOnly || state.disabled ? "" : "hover:border-muted-foreground/50"}`;
  return `${state.height ?? inputHeight(state.small)} rounded-md border px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-[0.5px] focus:outline-offset-0 ${fill} ${edge} ${state.disabled ? "opacity-50" : ""}`;
}

/** The look with a fixed 32 height, for bare inputs placed by other screens (an add-row, a find bar). */
export const INPUT_CLASS = inputLook({ height: "h-8" });
/** A filter inside a list: a recessed fill with no edge until it is hovered or focused (28, 44 under Large hit targets). */
const INPUT_QUIET =
  "rounded-md border border-transparent bg-muted/60 px-3 text-sm text-foreground placeholder:text-muted-foreground hover:bg-muted focus:border-ring focus:outline-[0.5px] focus:outline-offset-0 focus:outline-ring";

/** The line under a control: the field's error, or the hint while there is none. `reserve` keeps the room of one line. */
function Footer(props: { hint?: string; reserve?: boolean; errorInLabel?: boolean }) {
  const field = FieldScope();
  const wrong = () => (field?.errors().length ?? 0) > 0;
  return (
    <If when={props.reserve || (!props.errorInLabel && wrong()) || props.hint}>
      <View class={props.reserve ? "min-h-4" : undefined}>
        <If when={!props.errorInLabel}>
          <FieldError />
        </If>
        <If when={!wrong() && props.hint}>
          <FieldDescription>{props.hint ?? ""}</FieldDescription>
        </If>
      </View>
    </If>
  );
}

/**
 * Label above, control, then an error (red border + icon + text: color is never the only signal) or a hint. It is a
 * `FieldRoot`: a control inside it (`useFieldControl`) gets its name from the label, its hint from the error or the
 * description, and validates by `validationMode` (and a surrounding `Form`'s). `error` is the owner's own message and wins
 * over the field's rules and the form's.
 * Validate on blur or submit, never on the first keystroke; once an error shows, clear it as soon as it is fixed.
 * `reserve` keeps the message line's height when empty, so a required field in a modal does not shift it.
 * `errorInLabel` shows the error on the label line instead of below: for fields in a row of bottom-aligned
 * siblings, where an extra line would push the input out of line.
 */
export function Labeled(
  props: FieldRules & {
    label: string;
    error?: string;
    hint?: string;
    reserve?: boolean;
    errorInLabel?: boolean;
    children?: JSX.Element;
  },
) {
  return (
    <FieldRoot
      name={props.name}
      disabled={props.disabled}
      invalid={props.invalid}
      error={props.error}
      validate={props.validate}
      validationMode={props.validationMode}
      validationDebounceTime={props.validationDebounceTime}
    >
      <If when={props.label}>
        <FieldLabel errorInLabel={props.errorInLabel}>{props.label}</FieldLabel>
      </If>
      {props.children}
      <Footer hint={props.hint} reserve={props.reserve} errorInLabel={props.errorInLabel} />
    </FieldRoot>
  );
}

/**
 * Where form fields sit, even a row of one. `Labeled` grows with `flex-1` to share a row's width; in a column that has to
 * scroll, the same `flex-1` shrinks the field to nothing and lets its input paint over the next one. A row gives it its
 * width and leaves its height alone.
 */
export function FieldRow(props: { children?: JSX.Element }) {
  return <View class="flex-row items-start gap-3">{props.children}</View>;
}

const lengthViolations = (
  text: string,
  p: { minLength?: number; maxLength?: number; pattern?: RegExp },
): Violation[] => {
  if (text === "") return [];
  const out: Violation[] = [];
  if (p.minLength !== undefined && text.length < p.minLength)
    out.push({ key: "tooShort", message: `Enter at least ${p.minLength} characters.` });
  if (p.maxLength !== undefined && text.length > p.maxLength)
    out.push({ key: "tooLong", message: `Enter at most ${p.maxLength} characters.` });
  if (p.pattern && !p.pattern.test(text)) out.push({ key: "patternMismatch" });
  return out;
};

interface TextProps extends FieldRules {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  error?: string;
  hint?: string;
  /** Identifiers (pane ids, paths, commands): a monospaced face so characters line up and 0/O, 1/I differ. */
  mono?: boolean;
  /** The user pasted: its text (which the field inserts as usual), images as `File`s, local files' `file:` URLs. For a field that takes attachments. */
  onPaste?: (e: PasteEvent) => void;
  /** Keep room for the error line (see `Labeled`). */
  reserve?: boolean;
  autoFocus?: boolean;
  onSubmit?: () => void;
  onBlur?: () => void;
  masked?: boolean;
  address?: boolean;
  tall?: boolean;
  /** An empty value (or only spaces) is `valueMissing` once the field was changed or a form was submitted. */
  required?: boolean;
  /** The user can select and copy it, not change it. */
  readOnly?: boolean;
  minLength?: number;
  /** The most characters that can be typed; a longer pasted value is `tooLong`. */
  maxLength?: number;
  /** The whole text must match it (no `g` flag), else `patternMismatch`. */
  pattern?: RegExp;
}

function TextControl(props: { p: TextProps }) {
  const p = props.p;
  let input: InputRef | undefined;
  const focused = signal(false);
  // A one-line value rests as one line ending in an ellipsis (`OneLine`), as in `SelectField`, `Combobox` and
  // `Autocomplete`: the host's editor cut a 300-character path mid-glyph. Not a secret (its dots are the point) or a box of lines.
  const oneLine = () => !p.multiline && !p.masked;
  const control = useFieldControl({
    value: () => p.value,
    required: () => p.required,
    empty: (v) => String(v).trim() === "",
    violations: (v) => lengthViolations(String(v), p),
    focus: () => input?.focus(),
    disabled: () => p.disabled,
  });
  const box = (
    <Input
      ref={(node: InputRef) => {
        input = node;
      }}
      value={p.value}
      onChange={({ value }) => p.onChange(value)}
      placeholder={p.placeholder}
      accessibilityLabel={control.label() ?? (p.label || p.placeholder)}
      accessibilityHint={spoken({ required: p.required, readOnly: p.readOnly }, control.hint())}
      disabled={control.disabled()}
      readonly={p.readOnly}
      maxLength={p.maxLength}
      multiline={p.multiline}
      onPaste={p.onPaste}
      masked={p.masked}
      keyboardType={p.address ? "email-address" : undefined}
      autoCapitalize={p.address || p.mono ? "none" : undefined}
      autoCorrect={p.address || p.mono || p.masked ? false : undefined}
      autoComplete={p.masked ? "password" : p.address ? "email" : "off"}
      autoFocus={p.autoFocus}
      submitBehavior={p.onSubmit || control.inForm ? "submit" : undefined}
      onSubmit={() => {
        p.onSubmit?.();
        control.submit();
      }}
      onFocus={() => {
        focused.set(true);
        control.focused();
      }}
      onBlur={() => {
        focused.set(false);
        control.blurred();
        p.onBlur?.();
      }}
      style={hoverTransition()}
      class={`${inputLook({
        invalid: control.invalid(),
        disabled: control.disabled(),
        readOnly: p.readOnly,
        height: p.multiline ? (p.tall ? "h-72 py-2" : "h-24 py-2") : undefined,
      })} ${p.mono ? "font-mono" : ""} ${oneLine() && drawsOwnValue({ text: p.value, focused: focused() }) ? "text-transparent" : ""}`}
    />
  );
  return (
    <If when={oneLine()} else={box}>
      <OneLine text={p.value} focused={focused()} padRight="pr-3" mono={p.mono} faded={control.disabled()}>
        {box}
      </OneLine>
    </If>
  );
}

/**
 * Single- or multi-line text. `onSubmit` fires on Enter (single line); `autoFocus` for the first field of a modal.
 * `masked` hides what is typed (a password); `address` is for email addresses (the address keyboard, no capital, no
 * autocorrect); `tall` makes a multiline field a writing area (a letter), not a note; `mono` is an identifier (no
 * autocorrect either). In a `Form`, Enter submits the form after `onSubmit`, and `name`, `required`, `minLength`,
 * `maxLength`, `pattern` and `validate` take part in its validation (`design/inputs.md`).
 */
export function Field(props: TextProps) {
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
      <TextControl p={props} />
    </Labeled>
  );
}

/**
 * Search box with a leading icon and a clear button once something is typed. `onSubmit` fires on Enter: a deeper search
 * than the live one. Escape clears what was typed while the box has the focus (and does nothing, so the screen's own Escape
 * works, when it is empty).
 */
export function SearchField(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** A quiet 28 pt filter for a list's head: no border at rest. Still 44 under Large hit targets. */
  dense?: boolean;
  onSubmit?: () => void;
  /** The field's ref, for a shortcut that takes the focus to it (a view cannot take the focus from code, an input can). */ inputRef?: (
    ref: InputRef,
  ) => void;
}) {
  let field: InputRef | undefined;
  const focused = signal(false);
  const clear = () => {
    props.onChange("");
    announce("Search cleared");
  };
  effect(() => {
    if (!focused() || !props.value) return;
    return keymap.bind("escape", clear, { when: "always" });
  });
  return (
    <View>
      <Input
        ref={(node: InputRef) => {
          field = node;
          props.inputRef?.(node);
        }}
        value={props.value}
        onChange={({ value }) => props.onChange(value)}
        placeholder={props.placeholder}
        accessibilityLabel={props.placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        autoComplete="off"
        submitBehavior={props.onSubmit ? "submit" : undefined}
        onSubmit={props.onSubmit}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        style={hoverTransition()}
        class={`${props.dense ? `${INPUT_QUIET} ${inputHeight(true)}` : inputLook()} pl-8 pr-8`}
      />
      <View class="pointer-events-none absolute bottom-0 left-2.5 top-0 justify-center">
        <Icon name="search" size={14} tone="muted-foreground" />
      </View>
      <If when={props.value}>
        <View class="absolute bottom-0 right-1 top-0 justify-center">
          {/* The button goes away when it clears, taking the keyboard focus with it: the field gets it back. */}
          <IconButton
            icon="x"
            label="Clear search"
            onPress={() => {
              clear();
              field?.focus();
            }}
          />
        </View>
      </If>
    </View>
  );
}

export interface Option<T extends string> {
  value: T;
  title: string;
}
