import { context, type JSX, View } from "nsh";
import { hoverTransition, moveTransition } from "#lib/motion";
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
  if (!scope) throw new Error("CollapsibleTrigger and CollapsiblePanel must be inside a Collapsible or an AccordionItem");
  return scope;
}

/**
 * A region that opens and closes (Base UI's Collapsible): a `CollapsibleTrigger` and a `CollapsiblePanel` inside it.
 * `open` makes it controlled (the owner decides in `onOpenChange`, which may `cancel()`), else it holds its own state
 * from `defaultOpen`. `disabled` stops the trigger. The panel appears and disappears at once: animating its height is
 * layout (`design/motion.md`), so the only motion is the chevron turning.
 */
export function Collapsible(props: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean, change: OpenChange) => void;
  disabled?: boolean;
  class?: string;
  children?: JSX.Element;
}) {
  const state = createOpenState({ open: () => props.open, defaultOpen: props.defaultOpen, onOpenChange: props.onOpenChange });
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
 */
export function CollapsibleTrigger(props: { label?: string; chevron?: boolean; class?: string; children?: JSX.Element }) {
  const scope = scopeOf();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ expanded: scope.open(), disabled: scope.disabled() }}
      disabled={scope.disabled()}
      onPress={scope.toggle}
      style={hoverTransition()}
      class={`${props.chevron ? "h-9 flex-row items-center gap-2 rounded-md" : ""} disabled:opacity-50 ${FOCUS_RING} ${props.class ?? ""}`}
    >
      <If when={props.chevron}>
        <View style={moveTransition()} class={scope.open() ? "rotate-90" : ""} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
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
  return (
    <If when={scope.open() || kept()}>
      <View class={`${scope.open() ? "" : "hidden"} ${props.class ?? ""}`} importantForAccessibility={scope.open() ? "auto" : "no-hide-descendants"}>
        {props.children}
      </View>
    </If>
  );
}
