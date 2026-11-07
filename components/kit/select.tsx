import { computed, effect, keymap, signal, Text, View } from "nsh";
import type { ViewRef } from "nsh/types";
import { fold } from "../../lib/text";
import { hoverTransition } from "../../lib/motion";
import { FOCUS_RING, openOnDown } from "./core";
import { Labeled, type Option } from "./fields";
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
  options: { chosen: readonly T[]; equal: (a: T, b: T) => boolean; multiple: boolean; readOnly: boolean; pick: (value: T) => void },
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
 * hundreds opens at once: only the rows in view are built. `small` is the 28pt size of a dense row (as on `Btn`): every
 * control in one row has one height. For a set that is searched by typing, use a `Combobox`.
 */
export function SelectField<T extends string>(props: SelectFieldProps<T>) {
  const state = createOpenState({ open: () => props.open, defaultOpen: props.defaultOpen, onOpenChange: (o, c) => props.onOpenChange?.(o, c) });
  const width = signal(0);
  const focused = signal(false);
  const session = createSession(state);
  let trigger: ViewRef | undefined;
  const equal = (a: T, b: T) => (props.isItemEqualToValue ? props.isItemEqualToValue(a, b) : a === b);
  const chosen = (): T[] => (props.multiple ? [...props.value] : props.value === "" ? [] : [props.value]);
  const options = computed(() => props.items.flatMap((item): SelectOption<T>[] => (item === "separator" ? [] : "items" in item ? item.items : [item])));
  const title = computed(() =>
    options()
      .filter((o) => chosen().some((c) => equal(o.value, c)))
      .map((o) => o.title)
      .join(", "),
  );
  const name = () => props.label ?? props.name ?? props.placeholder ?? "Select";
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
      accessibilityLabel={`${name()}: ${title() || "not selected"}${props.required ? ", required" : ""}${props.invalid ? ", invalid" : ""}${props.readOnly ? ", read only" : ""}`}
      accessibilityState={{ expanded: state.open(), disabled: props.disabled || undefined }}
      onPress={() => {
        if (!props.disabled) pressTrigger(state, session);
      }}
      onFocus={() => focused.set(true)}
      onBlur={() => {
        focused.set(false);
        closeOnBlur(state, session);
      }}
      onLayout={({ bounds }) => width.set(bounds.size.width)}
      style={hoverTransition()}
      class={`flex-row items-center justify-between gap-2 rounded-md border bg-card px-2.5 ${props.invalid ? "border-destructive" : "border-input"} ${props.disabled ? "opacity-50" : "hover:bg-accent"} ${FOCUS_RING} ${props.small ? "h-7" : "h-8"}`}
    >
      <Text class={`line-clamp-1 min-w-0 flex-1 ${props.small ? "text-xs" : "text-sm"} ${title() ? "text-foreground" : "text-muted-foreground"}`}>
        {title() || props.placeholder || "Select…"}
      </Text>
      <Icon name="chevron-down" size={14} tone="muted-foreground" />
    </View>
  );
  const body = (
    <View>
      {select}
      <If when={state.open()}>
        <Surface
          rows={() => selectRows(props.items, { chosen: chosen(), equal, multiple: !!props.multiple, readOnly: !!props.readOnly, pick })}
          session={session}
          anchor={trigger!}
          over={props.alignItemWithTrigger === false ? undefined : trigger}
          offset={4}
          start="selected"
          choice
          minWidth={Math.max(width(), 176)}
          highlightItemOnHover={props.highlightItemOnHover}
        />
      </If>
    </View>
  );
  return props.label ? <Labeled label={props.label}>{body}</Labeled> : body;
}
