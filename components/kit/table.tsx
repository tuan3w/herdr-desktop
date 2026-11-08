import { computed, type JSX, signal, Text, View } from "nsh";
import { DataTable, type DataTableRef, type DataTableSort } from "nsh/base";

import { fold } from "#lib/text";

import { FOCUS_RING_INSET } from "./core";
import { Clipped } from "./hint";
import { Icon } from "./icon";

export interface Column<T> {
  /** Unique among the columns. */
  key: string;
  title: string;
  /** Points. The table is as wide as its columns; a window wider than that is shared by the columns with `grow`. */
  width: number;
  /** This column's share of the spare width, relative to the other `grow` values. */
  grow?: number;
  align?: "start" | "end";
  /** The cell's text, also what the column sorts by unless `sortBy` says otherwise. */
  text: (row: T) => string;
  /** What to sort by when that is not the text (a number, an ISO date). Empty values sort last in both directions. */
  sortBy?: (row: T) => string | number;
  /** Default true. */
  sortable?: boolean;
  /** Draws the cell (a `Pill`, a `Badge`) instead of its text. */
  cell?: (row: T) => JSX.Element;
  /** Identifiers (refs, pane ids) in the monospaced face. */
  mono?: boolean;
  /**
   * Leaves the table when it is too narrow for all its columns: the lowest `drop` goes first. Columns without it stay.
   * The table's own width decides, not the window's: a wider sidebar takes room from the table.
   */
  drop?: number;
}

/** The columns that fit `available` points: those with a `drop` leave, lowest first, until the rest fit. Unknown width (0) shows all. */
export function fittingColumns<T>(columns: Column<T>[], available: number): Column<T>[] {
  if (available <= 0) return columns;
  let total = columns.reduce((sum, c) => sum + c.width, 0);
  const leaving = columns.filter((c) => c.drop !== undefined).sort((a, b) => a.drop! - b.drop!);
  const gone = new Set<Column<T>>();
  for (const c of leaving) {
    if (total <= available) break;
    gone.add(c);
    total -= c.width;
  }
  return gone.size === 0 ? columns : columns.filter((c) => !gone.has(c));
}

/** Equals `ROW.table.height` in lib/layout.ts; a copy because the kit may not import lib/layout (one-way rule in AGENTS.md). */
export const ROW_HEIGHT = 32;

const CLASSES = {
  root: "rounded-lg border border-border bg-card",
  header: "border-b border-border bg-muted/50",
  headerCell: "px-3 text-xs font-medium text-muted-foreground",
  headerCellSorted: "text-foreground",
  row: "border-b border-border",
  rowHover: "bg-accent/50",
  rowSelected: "bg-accent",
  cell: "px-3 text-sm text-foreground",
  empty: "items-center justify-center p-8",
} as const;

/** The sort a press on `key`'s title asks for: ascending first, then descending, then none (the caller's own order). */
export function nextSort(current: DataTableSort | null, key: string): DataTableSort | null {
  if (current?.key !== key || !current.direction) return { key, direction: "ascending" };
  return current.direction === "ascending" ? { key, direction: "descending" } : null;
}

/**
 * The sort the table's titles show: none when it names a column that is not shown (a narrow table dropped it), so no
 * title claims an order the person cannot see the reason for.
 */
export function shownSort<T>(sort: DataTableSort | null, shown: readonly Column<T>[]): DataTableSort | null {
  return sort && sort.direction && shown.some((c) => c.key === sort.key && c.sortable !== false) ? sort : null;
}

/** What a screen reader hears on a title: its name, and the order it holds or that pressing it sorts. */
export function titleLabel(title: string, sortable: boolean, direction: DataTableSort["direction"] | null): string {
  if (!sortable) return title;
  if (direction) return `${title}, sorted ${direction}`;
  return `Sort by ${title}`;
}

/** Rows in the order `sort` asks. Empty values go last whichever way it runs, so a missing date never leads the column. */
export function sortedRows<T>(rows: T[], columns: Column<T>[], sort: DataTableSort | null): T[] {
  const column = sort && columns.find((c) => c.key === sort.key);
  if (!sort || !column || !sort.direction) return rows;
  const by = column.sortBy ?? column.text;
  const sign = sort.direction === "ascending" ? 1 : -1;
  const missing = (v: string | number) => v === "" || Number.isNaN(v);
  // A key is worked out once per row, not once per comparison: `sortBy` may count or search, and a sort compares n·log n times.
  const keyed = rows.map((row) => {
    const key = by(row);
    return { row, key: typeof key === "string" ? fold(key) : key };
  });
  keyed.sort((a, b) => {
    const [x, y] = [a.key, b.key];
    if (missing(x) || missing(y)) return missing(x) === missing(y) ? 0 : missing(x) ? 1 : -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * sign;
    const [sx, sy] = [String(x), String(y)];
    return (sx < sy ? -1 : sx > sy ? 1 : 0) * sign;
  });
  return keyed.map((k) => k.row);
}

/**
 * Many records at once, to scan and sort: columns of text, a pill or a badge, a sort button on each title, rows that
 * press. Only the rows in view are built, so hundreds are fine. The caller owns the sort (`sort`, `onSort`) so it
 * survives leaving the screen. Pressing a row opens it (`onOpen`); there is no other action in a row.
 * For a handful of records to work through, a list of rows is the better surface (`Sessions.Row`).
 */
export function Table<T>(props: {
  label: string;
  rows: T[];
  rowKey: (row: T) => string;
  columns: Column<T>[];
  sort: DataTableSort | null;
  onSort: (sort: DataTableSort | null) => void;
  onOpen: (row: T) => void;
  selected?: string;
  /** The rows already come in the order of `sort`, which the caller applied (folders first, say): the table only shows it on the title. */
  arranged?: boolean;
  /** The keys moved the selection to this row (a press selects too, and opens through `onOpen`). */
  onSelect?: (row: T) => void;
  /** The table's handle, for a screen that takes the keyboard to it (`focus`) or moves its selection (`select`). */
  onRef?: (ref: DataTableRef) => void;
  empty?: JSX.Element;
}) {
  const width = signal(0);
  // Computed once per change, not per call: every drawn cell asks for them.
  const ordered = computed(() => (props.arranged ? props.rows : sortedRows(props.rows, props.columns, props.sort)));
  const shown = computed(() => fittingColumns(props.columns, width() - 2));
  const visible = computed(() => new Set(shown().map((c) => c.key)));
  // nsh's DataTable builds a title once per column index and keeps that build's sort button and alignment (`title` in
  // nsh-base `data_table/view.rs`, keyed by index): when a narrow table removed a column, the next one slid into its
  // index under the dropped one's chevron (seen at 760 pt: a chevron over the row's `…`). So the native table always has
  // every column, at the same index: one that leaves is 0 wide and draws nothing (its title is still read by a screen
  // reader: unverified with one). Rebuilding the table instead lost the
  // keyboard focus whenever a preview narrowed the list (`viewers.test.tsx`).
  const data = computed(() =>
    ordered().map((row) =>
      Object.fromEntries(props.columns.map((c) => [c.key, visible().has(c.key) ? c.text(row) : ""])),
    ),
  );
  const columns = computed(() => {
    const base = shown().reduce((sum, c) => sum + c.width, 0);
    const spare = Math.max(0, width() - base - 2);
    const shares = shown().reduce((sum, c) => sum + (c.grow ?? 0), 0);
    return props.columns.map((c) => ({
      key: c.key,
      title: c.title,
      width: visible().has(c.key) ? c.width + (shares && c.grow ? Math.floor((spare * c.grow) / shares) : 0) : 0,
      minWidth: 0,
      align: c.align,
      // The kit draws the titles (`renderHeaderCell`) with the chevron beside the name and the whole title pressable;
      // nsh's own button sits at the far edge of the column and is the only part of its title that sorts.
      sortable: false,
      resizable: false,
      movable: false,
      cellClass: c.mono ? "font-mono text-xs" : undefined,
    }));
  });
  const drawn = () => shown().some((c) => c.cell);
  const selectedRow = () => ordered().findIndex((r) => props.rowKey(r) === props.selected);
  const sort = computed(() => shownSort(props.sort, shown()));
  const at = (index: number) => {
    const column = props.columns[index];
    return column && visible().has(column.key) ? column : undefined;
  };
  const title = (head: { column: number; title: string; sort?: DataTableSort["direction"] | null }) => {
    // Not `at`: nsh renders a title again only when its own sort or selection changes, so a title must not depend on
    // which columns fit (one that came back stayed blank). A dropped column's title is clipped to its 0 width.
    const column = props.columns[head.column];
    if (!column) return <View />;
    const sortable = column.sortable !== false && column.title !== "";
    const end = column.align === "end";
    const direction = head.sort ?? null;
    // Beside the title, as Linear and Finder draw it, on the side away from the column's edge: the title never moves
    // when the chevron appears, and an end-aligned title keeps its right edge over the digits.
    const chevron = (
      <View class={`size-3 items-center justify-center ${direction === "ascending" ? "rotate-180" : ""}`}>
        <If when={direction}>
          <Icon name="chevron-down" size={12} tone="foreground" />
        </If>
      </View>
    );
    return (
      <View
        role={sortable ? "button" : undefined}
        accessibilityLabel={titleLabel(head.title, sortable, direction)}
        onPress={sortable ? () => props.onSort(nextSort(props.sort, column.key)) : undefined}
        class={`h-full min-w-0 flex-1 flex-row items-center gap-1 rounded-md ${end ? "justify-end" : ""} ${sortable ? FOCUS_RING_INSET : ""}`}
      >
        <If when={end && sortable}>{chevron}</If>
        <Text
          class={`min-w-0 shrink text-xs font-medium ${direction ? "text-foreground" : "text-muted-foreground"}`}
          style={{ numberOfLines: 1 }}
        >
          {head.title}
        </Text>
        <If when={!end && sortable}>{chevron}</If>
      </View>
    );
  };
  return (
    <View class="flex-1" onLayout={({ bounds }) => width.set(bounds.size.width)}>
      <DataTable
        class="flex-1"
        ref={(ref: DataTableRef) => props.onRef?.(ref)}
        accessibilityLabel={props.label}
        columns={columns()}
        data={data()}
        rowHeight={ROW_HEIGHT}
        headerHeight={ROW_HEIGHT}
        sort={sort()}
        selection={selectedRow() >= 0 ? { row: selectedRow() } : null}
        onSelectionChange={({ selection }) => {
          const row = selection?.row == null ? undefined : ordered()[selection.row];
          if (row) props.onSelect?.(row);
        }}
        onRowPress={(e) => {
          const row = ordered()[e.row];
          if (row) props.onOpen(row);
        }}
        columnSelectable={false}
        classes={CLASSES}
        renderHeaderCell={title}
        renderCell={
          drawn()
            ? (cell) => {
                const column = at(cell.column);
                const row = ordered()[cell.row];
                if (!column) return <View />;
                return column.cell && row ? (
                  column.cell(row)
                ) : (
                  <Clipped class={`text-sm text-foreground ${column.mono ? "font-mono text-xs" : ""}`}>
                    {cell.text}
                  </Clipped>
                );
              }
            : undefined
        }
        empty={props.empty}
      />
    </View>
  );
}
