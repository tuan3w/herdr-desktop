import { computed, effect, keymap, signal, View, windowSize } from "nsh";

import type { ViewRef } from "nsh/types";

import { hoverTransition } from "#lib/motion";
import { largeTargets } from "#lib/settings";
import { fold } from "#lib/text";

import { openOnDown, RING_BORDERED, RING_INVALID, touchedJustNow } from "./core";
import { useFieldControl } from "./field";
import { Labeled, type Option } from "./fields";
import { Clipped } from "./hint";
import { Icon } from "./icon";
import { closeOnBlur, createSession, type MenuRow, openMenu, pressTrigger, Surface } from "./menu";
import { type Typing, typeahead, TYPING_KEYS } from "./navigation";
import { createOpenState, type OpenChange } from "./popup";

/** An option that cannot be chosen is still listed, and the keys and pointer still reach it (as Base UI's `disabled` item). */
export interface SelectOption<T extends string> extends Option<T> {
  disabled?: boolean;
}

/** Options under a heading. */
export interface SelectGroup<T extends string> {
  label: string;
  items: SelectOption<T>[];
}

/** An option, a heading with options, or a divider. */
export type SelectItem<T extends string> = SelectOption<T> | SelectGroup<T> | "separator";

/** What choosing `value` does to what is chosen: a single select takes it, a multiple one adds it or takes it out. */
export function toggled<T>(chosen: readonly T[], value: T, equal: (a: T, b: T) => boolean): T[] {
  return chosen.some((c) => equal(value, c)) ? chosen.filter((c) => !equal(value, c)) : [...chosen, value];
}

/**
 * The rows of a select's list. A single select closes when one is chosen, a multiple one stays open and ticks; `readOnly`
 * lets the list be opened and browsed but chooses nothing and stays open (Base UI's `readOnly`).
 */
export function selectRows<T extends string>(
  items: readonly SelectItem<T>[],
  options: {
    chosen: readonly T[];
    equal: (a: T, b: T) => boolean;
    multiple: boolean;
    readOnly: boolean;
    pick: (value: T) => void;
  },
): MenuRow[] {
  const rows: MenuRow[] = [];
  const add = (option: SelectOption<T>) =>
    rows.push({
      kind: options.multiple ? "check" : "radio",
      label: option.title,
      danger: false,
      disabled: !!option.disabled,
      checked: options.chosen.some((c) => options.equal(option.value, c)),
      closeOnClick: !options.multiple && !options.readOnly,
      select: () => {
        if (!options.readOnly) options.pick(option.value);
      },
    });
  for (const item of items) {
    if (item === "separator") {
      if (rows.length > 0 && rows[rows.length - 1].kind !== "separator") rows.push({ kind: "separator" });
    } else if ("items" in item) {
      rows.push({ kind: "label", label: item.label });
      for (const option of item.items) add(option);
    } else add(item);
  }
  if (rows.length > 0 && rows[rows.length - 1].kind === "separator") rows.pop();
  return rows;
}

/**
 * What a select shows for what is chosen: each value's title in the order of the options, then any chosen value that no
 * option has, as itself. A value the list no longer offers (a machine removed, an agent from an older version) used to show
 * the placeholder, as if nothing were chosen, while the form still held and submitted it.
 */
export function chosenTitle<T extends string>(
  options: readonly Option<T>[],
  chosen: readonly T[],
  equal: (a: T, b: T) => boolean,
): string {
  const found = options.filter((o) => chosen.some((c) => equal(o.value, c)));
  const missing = chosen.filter((c) => !options.some((o) => equal(o.value, c)));
  return [...found.map((o) => o.title), ...missing].join(", ");
}

/** The least a choice list is wide (a shorter trigger still gets a list that reads). */
const LIST_MIN = 176;
/** The most a choice list grows to fit its longest option; past it the option is cut with an ellipsis. */
const LIST_MAX = 480;
/** What a list is wider than its text: the popup's border and padding (10), a row's padding (16), the tick and the gap before it (26). */
const LIST_CHROME = 52;
/** An average glyph of the 14pt body face; a wide (CJK, emoji) character counts twice. */
const GLYPH = 7.5;

const glyphs = (text: string) => [...text].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0);

/**
 * How wide a choice list is: at least its trigger and `LIST_MIN`, as wide as its longest option needs up to `LIST_MAX` and the
 * window (Base UI sizes the popup `min-width: var(--anchor-width)` and lets it grow to its content; shadcn the same). A label like
 * "4.5 (recommended)" is read whole, not cut to the trigger's width. The text is estimated, not measured: the list is
 * built after it is sized, and the estimate errs wide.
 */
export function listWidth(titles: readonly string[], trigger: number, windowWidth: number): number {
  const longest = titles.reduce((n, t) => Math.max(n, glyphs(t)), 0);
  const wanted = Math.min(LIST_MAX, Math.ceil(longest * GLYPH) + LIST_CHROME, Math.max(LIST_MIN, windowWidth - 16));
  return Math.max(trigger, LIST_MIN, wanted);
}

interface SelectBase<T extends string> {
  label?: string;
  /** The accessible name when there is no visible `label` (make it specific where the same select repeats). */
  name?: string;
  items: SelectItem<T>[];
  placeholder?: string;
  small?: boolean;
  disabled?: boolean;
  /** The list opens and can be browsed, nothing can be chosen. */
  readOnly?: boolean;
  required?: boolean;
  invalid?: boolean;
  /** The message under the select (red edge, icon, words); the select is invalid while it is set. */
  error?: string;
  /** What the select is for, under it while there is no error. */
  hint?: string;
  /** Keep the room of the message line (see `Labeled`). */
  reserve?: boolean;
  /** How a value of `items` is found in the chosen value: `===` unless the values need more. */
  isItemEqualToValue?: (item: T, value: T) => boolean;
  /** Lay the list over the trigger with the chosen option on it, as a macOS pop-up button; falls back to under the trigger when there is no room. Default true. */
  alignItemWithTrigger?: boolean;
  /** Whether the pointer moves the highlight. Default true. */
  highlightItemOnHover?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
}

export type SelectFieldProps<T extends string> = SelectBase<T> &
  (
    | { multiple?: false; value: T | ""; onChange: (value: T) => void }
    | { multiple: true; value: readonly T[]; onChange: (value: T[]) => void }
  );

/**
 * A fixed set of options, one or (with `multiple`) several. The trigger keeps the keyboard focus while the list is open,
 * so choosing leaves the focus ring on it: Return, Space or Down open the list on the current value, Up and Down move,
 * letters find an option (on a closed select they choose it, as a native one does), Return chooses, Escape closes. A list of
 * hundreds opens at once: only the rows in view are built. `small` is the 28pt size of a dense row (as on `Btn`; the default is 32, Large hit
 * targets makes both 44): every control in one row has one height, and the label is body size at both. For a set that is searched by typing, use a `Combobox`.
 */
export function SelectField<T extends string>(props: SelectFieldProps<T>) {
  // A select without a visible label still shows its error and hint: they were dropped with the label.
  return props.label || props.error || props.hint || props.reserve ? (
    <Labeled
      label={props.label ?? ""}
      disabled={props.disabled}
      invalid={props.invalid}
      error={props.error}
      hint={props.hint}
      reserve={props.reserve}
    >
      <SelectControl p={props} />
    </Labeled>
  ) : (
    <SelectControl p={props} />
  );
}

/** The select itself, made under its `Labeled` so that it takes part in the field around it and in a `Form`'s validation. */
function SelectControl<T extends string>(args: { p: SelectFieldProps<T> }) {
  const props = args.p;
  const state = createOpenState({
    open: () => props.open,
    defaultOpen: props.defaultOpen,
    onOpenChange: (o, c) => props.onOpenChange?.(o, c),
  });
  const width = signal(0);
  const focused = signal(false);
  const viaPointer = signal(false);
  const session = createSession(state);
  let trigger: ViewRef | undefined;
  const equal = (a: T, b: T) => (props.isItemEqualToValue ? props.isItemEqualToValue(a, b) : a === b);
  const chosen = (): T[] => (props.multiple ? [...props.value] : props.value === "" ? [] : [props.value]);
  const options = computed(() =>
    props.items.flatMap((item): SelectOption<T>[] =>
      item === "separator" ? [] : "items" in item ? item.items : [item],
    ),
  );
  const title = computed(() => chosenTitle(options(), chosen(), equal));
  // A required select left empty stops a form's submit and its message is announced (a select cannot take the focus from
  // code, so `Form` announces instead). It has no form name: `name` is its accessible name, so its value is not in `values`.
  const control = useFieldControl({
    value: () => props.value,
    required: () => props.required,
    disabled: () => props.disabled,
  });
  const invalid = () => !!props.invalid || !!props.error || control.invalid();
  const name = () => control.label() ?? props.label ?? props.name ?? props.placeholder ?? "Select";
  const pick = (value: T) => {
    if (props.multiple) props.onChange(toggled(chosen(), value, equal));
    else props.onChange(value);
  };
  const openList = () => openMenu(state, session, "list-navigation");
  openOnDown(() => focused() && !state.open() && !props.disabled, openList);
  effect(() => {
    if (props.disabled && state.open()) state.set(false, "disabled");
  });

  // A closed single select is typed into as a native one is: the letters choose the option they find.
  const folded = computed(() => options().map((o) => fold(o.title)));
  let typing: Typing | undefined;
  const typeValue = (key: string) => {
    const list = options();
    const found = typeahead(
      typing,
      key,
      folded(),
      list.map((o) => !!o.disabled),
      list.findIndex((o) => chosen().some((c) => equal(o.value, c))),
      Date.now(),
    );
    typing = found.typing;
    if (found.index >= 0) pick(list[found.index].value);
  };
  effect(() => {
    if (!focused() || state.open() || props.disabled || props.readOnly || props.multiple) return;
    typing = undefined;
    return keymap.bind(Object.fromEntries(TYPING_KEYS.map((k) => [k, () => typeValue(k)])));
  });

  const select = (
    <View
      ref={(node: ViewRef) => {
        trigger = node;
      }}
      role="combobox"
      focusable={props.disabled ? false : undefined}
      accessibilityLabel={`${name()}: ${title() || "not selected"}${props.required ? ", required" : ""}${invalid() ? ", invalid" : ""}${props.readOnly ? ", read only" : ""}`}
      accessibilityHint={control.hint()}
      accessibilityState={{ expanded: state.open(), disabled: props.disabled || undefined }}
      onPress={() => {
        // The list needs the focus to stay on the trigger (keys move its highlight), so a pointer press cannot hand it back:
        // the ring is withheld instead, until the focus leaves.
        if (touchedJustNow()) viaPointer.set(true);
        if (!props.disabled) pressTrigger(state, session);
      }}
      onFocus={() => {
        focused.set(true);
        control.focused();
      }}
      onBlur={() => {
        focused.set(false);
        viaPointer.set(false);
        control.blurred();
        closeOnBlur(state, session);
      }}
      onLayout={({ bounds }) => width.set(bounds.size.width)}
      style={hoverTransition()}
      class={`flex-row items-center justify-between gap-2 rounded-md border px-3 ${focused() && !viaPointer() ? (invalid() ? RING_INVALID : RING_BORDERED) : invalid() ? "border-destructive" : "border-input"} ${props.disabled ? "opacity-50" : props.readOnly ? "" : "hover:bg-accent"} ${props.readOnly ? "bg-muted/50" : "bg-card"} ${largeTargets() ? "min-h-11" : props.small ? "min-h-7" : "min-h-8"}`}
    >
      <View class="min-w-0 flex-1">
        <Clipped class={`text-sm ${title() ? "text-foreground" : "text-muted-foreground"}`}>
          {title() || props.placeholder || "Select…"}
        </Clipped>
      </View>
      <Icon name="chevron-down" size={14} tone="muted-foreground" />
    </View>
  );
  const body = (
    <View>
      {select}
      <If when={state.open()}>
        <Surface
          rows={() =>
            selectRows(props.items, {
              chosen: chosen(),
              equal,
              multiple: !!props.multiple,
              readOnly: !!props.readOnly,
              pick,
            })
          }
          session={session}
          anchor={trigger!}
          over={props.alignItemWithTrigger === false ? undefined : trigger}
          offset={4}
          start="selected"
          choice
          minWidth={listWidth(
            options().map((o) => o.title),
            width(),
            windowSize().width,
          )}
          highlightItemOnHover={props.highlightItemOnHover}
        />
      </If>
    </View>
  );
  return body;
}
