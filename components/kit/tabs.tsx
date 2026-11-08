import { context, type JSX, Text, View } from "nsh";

import { hoverTransition } from "#lib/motion";

import { Badge } from "./badge";
import { RING_INSET } from "./core";
import { createRoving, type Roving } from "./roving";

const Strip = context<Roving | undefined>(undefined);

/**
 * Tab list for views of the same record (transcript, files, details). One stop of Tab; screen readers hear one
 * list of tabs. Keys while it has the focus (Base UI's Tabs): Left and Right (Up and Down when `vertical`) move the
 * highlight, Home and End jump, past the ends it wraps unless `loop` is false; Space or Return chooses the highlighted
 * tab. With `activateOnFocus` the arrows choose as they go: only where showing a view is cheap, since each step builds
 * it. Disabled tabs can be reached (a screen reader finds them) but never chosen. The focus stays on the list and the
 * ring moves (this host cannot move it to a tab: `roving.ts`).
 */
export function TabBar(props: {
  activateOnFocus?: boolean;
  vertical?: boolean;
  loop?: boolean;
  label?: string;
  children?: JSX.Element;
}) {
  const roving = createRoving({
    orientation: props.vertical ? "vertical" : "horizontal",
    loop: props.loop,
    homeEnd: true,
    skipDisabled: false,
    activateOnMove: () => props.activateOnFocus === true,
    activateKeys: ["space", "enter"],
  });
  return (
    <Strip.Provider value={roving}>
      <View
        role="tablist"
        accessibilityLabel={props.label}
        {...roving.focus}
        class={`gap-1 ${props.vertical ? "" : "flex-row"}`}
      >
        {props.children}
      </View>
    </Strip.Provider>
  );
}

/**
 * One tab. Selected is a soft fill and full-strength text: weight and width never change. `count` is a plain grey number;
 * it is hidden from screen readers like every `Badge`, so the tab's name carries it (`spoken` says what it counts).
 */
export function TabItem(props: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  count?: number;
  spoken?: string;
  disabled?: boolean;
}) {
  const roving = Strip();
  if (!roving) throw new Error("TabItem must be inside a TabBar");
  const name = () => (props.count ? `${props.label}, ${props.spoken ?? props.count}` : props.label);
  const mark = roving.add({
    label: name,
    disabled: () => props.disabled === true,
    current: () => props.selected,
    activate: () => props.onSelect(),
  });
  return (
    <View
      role="tab"
      focusable={false}
      accessibilityLabel={name()}
      accessibilityState={{ selected: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onSelect}
      style={hoverTransition()}
      class={`h-8 flex-row items-center gap-2 rounded-md px-3 hover:bg-accent/60 selected:bg-accent disabled:opacity-50 ${mark.lit() ? "bg-accent/60" : ""} ${mark.ring() ? RING_INSET : ""}`}
    >
      <Text class={`text-sm font-medium ${props.selected ? "text-foreground" : "text-muted-foreground"}`}>
        {props.label}
      </Text>
      <Badge count={props.count} />
    </View>
  );
}

/**
 * What a tab shows. Unmounted while it is not selected, so a hidden view costs nothing; `keepMounted` keeps it built and
 * hidden instead, for a view whose state must survive a switch (a half-typed field) and that is cheap to hold.
 */
export function TabPanel(props: {
  selected: boolean;
  keepMounted?: boolean;
  /** The tab it belongs to: with it the panel is a `region` that screen readers list by that name (nsh has no way to link a panel to its tab). */
  label?: string;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <If when={props.selected || props.keepMounted}>
      <View
        role={props.label ? "region" : undefined}
        accessibilityLabel={props.label}
        class={`${props.selected ? "" : "hidden"} ${props.class ?? ""}`}
        importantForAccessibility={props.selected ? "auto" : "no-hide-descendants"}
      >
        {props.children}
      </View>
    </If>
  );
}
