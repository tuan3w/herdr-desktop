import { signal, View } from "nsh";

import type { DockTab } from "nsh/base";

import { StatusGlyph } from "#components/status-glyph";
import { Clipped, copyMenu, copyText, Icon, Tipped } from "#kit";
import { checkoutName } from "#lib/changes";
import { BOARD, closeTab, groupOf, layout, parseChangesKey, parsePaneKey, parseSessionKey, rowKeyOf } from "#lib/dock";
import { meta, rowOf } from "#lib/herdr";
import { appear, hoverTransition } from "#lib/motion";
import { keyLabel } from "#lib/shortcuts";
import { statusText } from "#lib/status";
import { tabLabel } from "#lib/tabs";

/**
 * A tab's face (`design/tabs.md`): the shape of the agent's state, its title cut with an ellipsis, and a slot at the
 * right for the cross that closes the view. The slot is always there, so the cross appears on hover or in the front tab
 * without moving the title. A terminal tab reads its pane's header facts and says `(view)`: it shows the pane, it is not
 * a terminal; a chat tab reads its row of the board (a chat that is not on the board, one that ended, says `Chat`).
 * The front tab has a 2-pt underline as well as the surface step: its place is not told by colour alone.
 */
export function TabFace(props: { tab: DockTab }) {
  const hovered = signal(false);
  const at = parsePaneKey(props.tab.panel);
  const info = at ? meta(at.machine, at.pane) : () => null;
  const chat = parseSessionKey(props.tab.panel) !== null;
  const changes = parseChangesKey(props.tab.panel);
  const row = () => {
    const key = chat ? rowKeyOf(props.tab.panel) : null;
    return key === null ? undefined : rowOf(key);
  };
  const gone = () => at !== null && (info() === null || info()!.feedState === "gone");
  const plain = props.tab.panel === BOARD || changes !== null;
  const title = () =>
    props.tab.panel === BOARD
      ? "Board"
      : changes
        ? `Changes \u00b7 ${checkoutName(changes.machine, changes.cwd)}`
        : chat
          ? (row()?.name ?? "Chat")
          : gone()
            ? "Agent gone"
            : `${info()?.name ?? at?.pane ?? ""} (view)`;
  const status = () => (chat ? (row()?.status ?? "unknown") : gone() ? "unknown" : (info()?.status ?? "unknown"));
  /** The folder the tab's agent works in (a Changes tab's checkout), when known. */
  const folder = () => changes?.cwd ?? (chat ? row()?.cwd : info()?.cwd);
  const count = () => groupOf(layout(), props.tab.panel)?.panels.length ?? props.tab.index + 1;
  const label = () => tabLabel(title(), plain ? "" : statusText(status(), row()?.reviewed), props.tab.index, count());
  return (
    <View
      style={appear(props.tab.panel, "fade")}
      accessibilityLabel={label()}
      onContextMenu={copyMenu(() => [
        { label: "Copy title", onSelect: () => void copyText(title(), "Title") },
        ...(folder() ? [{ label: "Copy path", onSelect: () => void copyText(folder()!, "Path") }] : []),
      ])}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class="relative h-8 w-full flex-row items-center gap-2 pl-3 pr-1"
    >
      <If when={plain} else={<StatusGlyph status={status()} size={12} />}>
        <Icon name={changes ? "pencil" : "list"} size={14} tone="muted-foreground" />
      </If>
      <Clipped
        label={title()}
        class={`min-w-0 flex-1 text-sm ${props.tab.active ? "text-foreground" : "text-muted-foreground"}`}
      >
        {title()}
      </Clipped>
      <View class="size-6 shrink-0 items-center justify-center">
        <If when={props.tab.closable && (props.tab.active || hovered())}>
          {/* Closing is mod+w and the palette for the keyboard and screen readers: a button inside a tab would be a control within a control. */}
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Tipped label={`Close tab ${title()}`} shortcut={keyLabel("closeTab")}>
              <View
                role="button"
                focusable={false}
                accessibilityLabel={`Close tab ${title()}`}
                onPress={() => closeTab(props.tab.panel)}
                style={hoverTransition()}
                class="size-6 items-center justify-center rounded-sm hover:bg-accent active:bg-accent"
              >
                <Icon name="x" size={14} tone="muted-foreground" />
              </View>
            </Tipped>
          </View>
        </If>
      </View>
      <If when={props.tab.active}>
        <View class="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
      </If>
    </View>
  );
}
