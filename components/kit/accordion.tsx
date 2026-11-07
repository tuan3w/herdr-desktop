import { context, type JSX, signal, View } from "nsh";
import { Disclosure, type DisclosureScope } from "./collapsible";
import { createOpenState, type OpenChange } from "./popup";

/**
 * The open items after item `item` is asked to open or close. One at a time (`multiple` false): opening an item closes
 * the others, and the open one can be closed, leaving none (Base UI's default). `multiple`: each item is its own switch.
 */
export function accordionValue(value: readonly string[], item: string, open: boolean, multiple: boolean): string[] {
  if (!open) return value.filter((v) => v !== item);
  return multiple ? [...value.filter((v) => v !== item), item] : [item];
}

interface AccordionScope {
  has: (item: string) => boolean;
  commit: (next: string[], change: OpenChange) => void;
  value: () => readonly string[];
  multiple: () => boolean;
  disabled: () => boolean;
  keepMounted: () => boolean;
}

const Items = context<AccordionScope | undefined>(undefined);

/**
 * Stacked sections of which one (or, with `multiple`, any number) is open: `AccordionItem`s holding a
 * `CollapsibleTrigger` and a `CollapsiblePanel`. `value` (the open items) makes it controlled, else it holds its own from
 * `defaultValue`; `onValueChange` may `cancel()` (the change's `reason` is the trigger press). Every trigger is its own
 * stop of Tab: this host cannot move the focus between them, so Base UI's arrow-key navigation has no equivalent.
 */
export function Accordion(props: {
  value?: readonly string[];
  defaultValue?: readonly string[];
  onValueChange?: (value: string[], change: OpenChange) => void;
  multiple?: boolean;
  disabled?: boolean;
  keepMounted?: boolean;
  class?: string;
  children?: JSX.Element;
}) {
  const own = signal<readonly string[]>(props.defaultValue ?? []);
  const value = () => props.value ?? own();
  const scope: AccordionScope = {
    has: (item) => value().includes(item),
    value,
    commit(next, change) {
      props.onValueChange?.(next, change);
      if (!change.canceled && props.value === undefined) own.set(next);
    },
    multiple: () => props.multiple === true,
    disabled: () => props.disabled === true,
    keepMounted: () => props.keepMounted === true,
  };
  return (
    <Items.Provider value={scope}>
      <View class={props.class}>{props.children}</View>
    </Items.Provider>
  );
}

/** One section: `value` names it in the accordion's `value`; `disabled` stops its trigger. */
export function AccordionItem(props: { value: string; disabled?: boolean; class?: string; children?: JSX.Element }) {
  const accordion = Items();
  if (!accordion) throw new Error("AccordionItem must be inside an Accordion");
  const state = createOpenState({
    open: () => accordion.has(props.value),
    onOpenChange: (open, change) => accordion.commit(accordionValue(accordion.value(), props.value, open, accordion.multiple()), change),
  });
  const disabled = () => accordion.disabled() || props.disabled === true;
  const scope: DisclosureScope = {
    open: state.open,
    toggle: () => {
      if (!disabled()) state.set(!state.open(), "trigger-press");
    },
    disabled,
    keepMounted: accordion.keepMounted,
  };
  return (
    <Disclosure.Provider value={scope}>
      <View class={props.class}>{props.children}</View>
    </Disclosure.Provider>
  );
}
