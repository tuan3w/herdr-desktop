import { Text, View } from "nsh";

import { Monogram } from "#components/project-parts";
import { StatusGlyph } from "#components/status-glyph";
import { Clipped, Icon, Keys } from "#kit";
import type { PaletteRow } from "#lib/palette/rows";
import { runsOf } from "#lib/palette/rows";

/**
 * One row of the palette, drawn from `row()` each time it is read: the list keeps a row's view while the highlight moves
 * and while the board changes, so everything here is an accessor and the view holds no state.
 *
 * Calm (`design/palette.md`): a glyph (an agent's shape, a project's tile, a muted icon), the name in medium weight with
 * the matched letters in bold, one muted line (project, folder, machine) after it, the age, and on the right the key or a
 * check. A waiting agent says so in words; the signal colour is never used here.
 */
export function Row(props: { row: () => PaletteRow | undefined }) {
  const row = () => props.row();
  const dim = () => (row()?.disabled === undefined ? "" : "opacity-60");
  const detail = () => row()?.parts.join(" · ") ?? "";
  return (
    // nsh's command list wraps a custom item in a node that is as wide as its content, so `flex-1` has nothing to fill:
    // the row is the dialog's width (640, `kit/palette-dialog.tsx`) less the list's and the item's padding (32).
    <View class={`w-[608px] max-w-full min-w-0 flex-row items-center gap-3 ${dim()}`}>
      <View class="w-6 items-center">
        <If when={row()?.glyph === "status"}>
          <StatusGlyph status={row()?.state ?? "unknown"} id={row()?.hit?.target} size={14} />
        </If>
        <If when={row()?.glyph === "monogram"}>
          <Monogram name={row()?.title ?? ""} size={24} />
        </If>
        <If when={row() !== undefined && row()?.glyph !== "status" && row()?.glyph !== "monogram"}>
          <Icon name={iconOf(row())} size={16} tone="muted-foreground" />
        </If>
      </View>
      <View class="min-w-0 shrink flex-row items-baseline gap-2">
        <Clipped label={row()?.title ?? ""} class="min-w-0 shrink text-sm font-medium text-foreground">
          <Each of={runsOf(row()?.title ?? "", row()?.marks ?? [])} key="index">
            {(run) => <Text class={run().marked ? "font-bold" : ""}>{run().text}</Text>}
          </Each>
        </Clipped>
        <If when={row()?.alias}>
          <Text class="shrink-0 text-xs text-muted-foreground">{`(${row()?.alias})`}</Text>
        </If>
        <If when={detail() !== ""}>
          <Clipped class="min-w-0 shrink text-xs text-muted-foreground">{detail()}</Clipped>
        </If>
      </View>
      {/* The spacer, not the label group, takes the slack (as in a menu row): the age, check and keycaps end on the row's right edge. */}
      <View class="min-w-0 flex-1" />
      <If when={row()?.waiting}>
        <Text class="shrink-0 text-xs text-muted-foreground">needs you</Text>
      </If>
      <If when={(row()?.age ?? "") !== ""}>
        <Text class="shrink-0 text-xs text-muted-foreground">{row()?.age}</Text>
      </If>
      <If when={row()?.checked}>
        <Icon name="check" size={16} tone="muted-foreground" />
      </If>
      <If when={row()?.keys !== undefined}>
        <Keys keys={row()?.keys ?? ""} tone="quiet" />
      </If>
    </View>
  );
}

/** The icon of a row that has one (the status shape and the monogram are drawn by their own parts). */
function iconOf(row: PaletteRow | undefined): Parameters<typeof Icon>[0]["name"] {
  const glyph = row?.glyph;
  return glyph === undefined || glyph === "status" || glyph === "monogram" ? "arrow-right" : glyph;
}
