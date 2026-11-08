import { Text, View } from "nsh";

import type { JSX } from "nsh";

import { Clipped, Icon, NUM } from "#kit";
import { FILE_COLUMN } from "#lib/file-table";
import { fileGlyph, modifiedText, sizeText } from "#lib/files";

/**
 * The one way a file or folder is drawn in a list (`design/files.md`): the Files tab's table, the attach list, quick open
 * and the `@` list all use these parts, so a file looks the same wherever it is listed.
 *
 * `FileName` is the glyph (one set, by kind: `fileGlyph`) and the whole name, cut only past the row's end, with the folder
 * after it in muted text only where names can repeat (a search, never one folder's own listing). `FileSize` and
 * `FileModified` are the fixed columns: right-aligned, tabular figures, the same width in every row, so digits start at
 * the same x whatever the names are. `FileRow` is a 32 pt row of them for the lists that are not tables; the table draws the
 * same parts in its cells. A row's fill (hover, highlight, selected) belongs to the list that holds it: one fill for all three.
 */

/** The glyph and the name. `children` draws the name itself when it carries match marks; `hint` is the muted folder. */
export function FileName(props: {
  name: string;
  folder?: boolean;
  hint?: string;
  /** Medium weight, for lists that bold the matched letters. */
  strong?: boolean;
  /** The row cannot be opened: dimmed, the reason is in its label. */
  dim?: boolean;
  /** The colour the name takes (a popup's text is not the page's). */
  tone?: string;
  /** Fades the hint into this fill instead of a cut. */
  fade?: string[];
  /** Draws the hint itself when it carries match marks. */
  hintChildren?: JSX.Element;
  children?: JSX.Element;
}) {
  const weight = () => (props.strong ? "font-medium" : "");
  return (
    <View class={`min-w-0 flex-1 flex-row items-center gap-2 ${props.dim ? "opacity-50" : ""}`}>
      <Icon name={fileGlyph(props.name, props.folder === true)} size={16} tone="muted-foreground" />
      <If
        when={props.hint}
        else={
          <Clipped label={props.name} class={`min-w-0 flex-1 text-sm ${weight()} ${props.tone ?? "text-foreground"}`}>
            {props.children ?? props.name}
          </Clipped>
        }
      >
        {() => (
          <View class="min-w-0 flex-1 flex-row items-baseline gap-2">
            {/* The folder after a name gives way first (it shrinks a thousand times faster), then the name fades. */}
            <Clipped
              label={props.folder ? `${props.name}/` : props.name}
              boxClass="min-w-0 shrink"
              class={`text-sm ${weight()} ${props.tone ?? "text-foreground"}`}
            >
              <>
                {props.children ?? props.name}
                {props.folder ? "/" : ""}
              </>
            </Clipped>
            <Clipped
              tip={false}
              fade={props.fade}
              boxClass="min-w-0 shrink-[1000]"
              class="text-xs text-muted-foreground"
              label={props.hint}
            >
              {props.hintChildren ?? props.hint}
            </Clipped>
          </View>
        )}
      </If>
    </View>
  );
}

/** A size in bytes in its fixed, right-aligned column; a folder (`null`) leaves the column empty. */
export function FileSize(props: { bytes: number | null; note?: string }) {
  return (
    <View style={{ width: FILE_COLUMN.size - 24 }} class="shrink-0 flex-row justify-end">
      {/* One line whatever the width: `1023 bytes` wrapped in the 64-pt column; a longer figure spills left into the gap. */}
      <Text class="shrink-0 text-xs text-muted-foreground" style={[NUM, { numberOfLines: 1 }]}>
        {props.bytes === null ? (props.note ?? "") : sizeText(props.bytes)}
      </Text>
    </View>
  );
}

/** When a file changed (`modifiedText`), in its fixed, right-aligned column. */
export function FileModified(props: { modified: number | null | undefined; now: number }) {
  return (
    <View style={{ width: FILE_COLUMN.modified - 24 }} class="shrink-0 flex-row justify-end">
      <Text class="shrink-0 text-xs text-muted-foreground" style={[NUM, { numberOfLines: 1 }]}>
        {modifiedText(props.modified, props.now)}
      </Text>
    </View>
  );
}

/** One 32 pt row of a list that is not a table: the name, then the columns it is given, then a trailing mark (a tick). */
export function FileRow(props: {
  name: string;
  folder?: boolean;
  hint?: string;
  strong?: boolean;
  dim?: boolean;
  /** Bytes for the size column, `null` for a folder, `undefined` for a list with no size column. */
  size?: number | null;
  modified?: { at: number | null | undefined; now: number };
  trailing?: JSX.Element;
  label?: string;
}) {
  return (
    <View accessibilityLabel={props.label} class="h-8 w-full min-w-0 flex-row items-center gap-3">
      <FileName name={props.name} folder={props.folder} hint={props.hint} strong={props.strong} dim={props.dim} />
      <If when={props.size !== undefined}>
        <FileSize bytes={props.size ?? null} />
      </If>
      <If when={props.modified}>{(m) => <FileModified modified={m().at} now={m().now} />}</If>
      {props.trailing}
    </View>
  );
}
