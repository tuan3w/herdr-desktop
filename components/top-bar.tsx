import { View } from "nsh";

import type { JSX } from "nsh";

import { headerOnBand, mainInset } from "#lib/chrome";
import { BAR } from "#lib/layout";

/**
 * Text 20 pt in from the bar's ends: the first control's own 4 pt of padding (a title button's `px-1`, an icon button's
 * inset) brings what it shows to 24, the conversation column's edge (`CHAT_COLUMN`).
 */
const END = 20;

/**
 * A pane's header: one line, `BAR` high (a minimum: large text grows it), a hairline under it. While no tab strip is drawn
 * it is the window's top band (`headerOnBand`): pressing its empty part drags the window, and its ends keep clear of the
 * window controls (`mainInset`). Under a strip it is the second line and drags nothing.
 */
export function TopBar(props: { children: JSX.Element; label?: string }) {
  const band = () => headerOnBand();
  return (
    <View
      accessibilityLabel={props.label}
      desktop={{ windowDrag: band() }}
      style={{
        minHeight: BAR,
        paddingLeft: END + (band() ? mainInset().left : 0),
        paddingRight: END + (band() ? mainInset().right : 0),
      }}
      class="shrink-0 flex-row items-center gap-2 border-b border-border"
    >
      {props.children}
    </View>
  );
}
