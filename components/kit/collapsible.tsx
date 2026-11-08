import { context, effect, type JSX, untracked, View } from "nsh";

import { animateLayout, hoverTransition, moveTransition } from "#lib/motion";

import { FOCUS_RING } from "./core";
import { Icon } from "./icon";
import { createOpenState, type OpenChange } from "./popup";

/** What a `CollapsibleTrigger` and `CollapsiblePanel` read: from a `Collapsible`, or from an `AccordionItem`. */
export interface DisclosureScope {
  open: () => boolean;
  toggle: () => void;
  disabled: () => boolean;
  keepMounted: () => boolean;
}

export const Disclosure = context<DisclosureScope | undefined>(undefined);

function scopeOf(): DisclosureScope {
  const scope = Disclosure();
  if (!scope)
    throw new Error("CollapsibleTrigger and CollapsiblePanel must be inside a Collapsible or an AccordionItem");
  return scope;
}

/**
 * A region that opens and closes (Base UI's Collapsible): a `CollapsibleTrigger` and a `CollapsiblePanel` inside it.
 * `open` makes it controlled (the owner decides in `onOpenChange`, which may `cancel()`), else it holds its own state
 * from `defaultOpen`. `disabled` stops the trigger. The panel opens and closes through a layout animation of the commit
 * (`animateLayout`: what is inserted fades in, what moves glides, what is removed fades out), never a height tween
 * (`design/motion.md`), and the chevron turns.
 */
export function Collapsible(props: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
  disabled?: boolean;
  class?: string;
  children?: JSX.Element;
}) {
  const state = createOpenState({
    open: () => props.open,
    defaultOpen: props.defaultOpen,
    onOpenChange: props.onOpenChange,
  });
  const scope: DisclosureScope = {
    open: state.open,
    toggle: () => {
      if (!props.disabled) state.set(!state.open(), "trigger-press");
    },
    disabled: () => props.disabled === true,
    keepMounted: () => false,
  };
  return (
    <Disclosure.Provider value={scope}>
      <View class={props.class}>{props.children}</View>
    </Disclosure.Provider>
  );
}

/**
 * The control that opens and closes: a button that says `expanded` to screen readers. `label` is its accessible name
 * (the text it draws when omitted). `chevron` draws the turning arrow before `children`; without it `class` is the whole look.
 * With the chevron the trigger is 32 pt at least (the control ladder; it grows with large text) and its text starts 24 pt
 * in (a 16 pt slot and 8 of gap), so a panel with `pl-6` lines its body up under the text.
 */
export function CollapsibleTrigger(props: {
  label?: string;
  chevron?: boolean;
  class?: string;
  children?: JSX.Element;
}) {
  const scope = scopeOf();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ expanded: scope.open(), disabled: scope.disabled() }}
      disabled={scope.disabled()}
      onPress={scope.toggle}
      style={hoverTransition()}
      class={`${props.chevron ? "min-h-8 flex-row items-center gap-2 rounded-md" : ""} disabled:opacity-50 ${FOCUS_RING} ${props.class ?? ""}`}
    >
      <If when={props.chevron}>
        <View
          style={moveTransition()}
          class={`size-4 shrink-0 items-center justify-center ${scope.open() ? "rotate-90" : ""}`}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Icon name="chevron-right" size={14} tone="muted-foreground" />
        </View>
      </If>
      {props.children}
    </View>
  );
}

/**
 * What the trigger shows and hides. Not built while closed, so a closed panel costs nothing (a log body, a list); `keepMounted`
 * keeps it built and hidden, for content with state to keep (a half-typed field) that is cheap to hold.
 */
export function CollapsiblePanel(props: { keepMounted?: boolean; class?: string; children?: JSX.Element }) {
  const scope = scopeOf();
  const kept = () => props.keepMounted ?? scope.keepMounted();
  // Here and not in the trigger: an owner that sets `open` (a controlled one, an accordion) folds the same way.
  let was = untracked(scope.open);
  effect(() => {
    const now = scope.open();
    if (now !== was) animateLayout();
    was = now;
  });
  return (
    <If when={scope.open() || kept()}>
      <View
        class={`${scope.open() ? "" : "hidden"} ${props.class ?? ""}`}
        importantForAccessibility={scope.open() ? "auto" : "no-hide-descendants"}
      >
        {props.children}
      </View>
    </If>
  );
}
