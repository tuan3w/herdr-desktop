import { announce, effect, type JSX, keymap, signal, View } from "nsh";
import { Input } from "nsh/base";
import type { InputRef, PasteEvent } from "nsh/types";
import { hoverTransition } from "#lib/motion";
import { IconButton } from "./button";
import { FieldDescription, FieldError, FieldLabel, type FieldRules, FieldRoot } from "./field-parts";
import { FieldScope, useFieldControl, type Violation } from "./field";
import { Icon } from "./icon";

/** Text input look: hover darkens the edge, focus draws the ring color. Errors add `border-destructive`. */
export const INPUT_CLASS =
  "h-9 rounded-md border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground hover:border-muted-foreground/50 focus:border-ring focus:outline-2 focus:outline-offset-0 focus:outline-ring/30";
export const INPUT_ERROR = "border-destructive hover:border-destructive focus:border-destructive focus:outline-destructive/30";

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
export function Labeled(props: FieldRules & {
  label: string;
  error?: string;
  hint?: string;
  reserve?: boolean;
  errorInLabel?: boolean;
  children?: JSX.Element;
}) {
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

const lengthViolations = (text: string, p: { minLength?: number; maxLength?: number; pattern?: RegExp }): Violation[] => {
  if (text === "") return [];
  const out: Violation[] = [];
  if (p.minLength !== undefined && text.length < p.minLength) out.push({ key: "tooShort", message: `Enter at least ${p.minLength} characters.` });
  if (p.maxLength !== undefined && text.length > p.maxLength) out.push({ key: "tooLong", message: `Enter at most ${p.maxLength} characters.` });
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
  const control = useFieldControl({
    value: () => p.value,
    required: () => p.required,
    empty: (v) => String(v).trim() === "",
    violations: (v) => lengthViolations(String(v), p),
    focus: () => input?.focus(),
    disabled: () => p.disabled,
  });
  return (
    <Input
      ref={(node: InputRef) => {
        input = node;
      }}
      value={p.value}
      onChange={({ value }) => p.onChange(value)}
      placeholder={p.placeholder}
      accessibilityLabel={control.label() ?? (p.label || p.placeholder)}
      accessibilityHint={control.hint()}
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
      onFocus={control.focused}
      onBlur={() => {
        control.blurred();
        p.onBlur?.();
      }}
      style={hoverTransition()}
      class={`${INPUT_CLASS} ${p.mono ? "font-mono" : ""} ${p.multiline ? (p.tall ? "h-72 py-2" : "h-24 py-2") : ""} ${control.invalid() ? INPUT_ERROR : ""}`}
    />
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
export function SearchField(props: { value: string; onChange: (v: string) => void; placeholder: string; onSubmit?: () => void; /** The field's ref, for a shortcut that takes the focus to it (a view cannot take the focus from code, an input can). */ inputRef?: (ref: InputRef) => void }) {
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
        class={`${INPUT_CLASS} pl-8 pr-8`}
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
