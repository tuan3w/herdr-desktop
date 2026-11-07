import { computed, type JSX, signal, View } from "nsh";
import { DataTable, type DataTableSort } from "nsh/base";

import { fold } from "#lib/text";

import { Clipped } from "./hint";

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
const ROW_HEIGHT = 36;

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
  empty?: JSX.Element;
}) {
  const width = signal(0);
  // Computed once per change, not per call: every drawn cell asks for them.
  const ordered = computed(() => sortedRows(props.rows, props.columns, props.sort));
  const shown = computed(() => fittingColumns(props.columns, width() - 2));
  const data = computed(() => ordered().map((row) => Object.fromEntries(shown().map((c) => [c.key, c.text(row)]))));
  const columns = computed(() => {
    const base = shown().reduce((sum, c) => sum + c.width, 0);
    const spare = Math.max(0, width() - base - 2);
    const shares = shown().reduce((sum, c) => sum + (c.grow ?? 0), 0);
    return shown().map((c) => ({
      key: c.key,
      title: c.title,
      width: c.width + (shares && c.grow ? Math.floor((spare * c.grow) / shares) : 0),
      align: c.align,
      sortable: c.sortable !== false,
      resizable: false,
      movable: false,
      cellClass: c.mono ? "font-mono text-xs" : undefined,
    }));
  });
  const drawn = () => shown().some((c) => c.cell);
  const selectedRow = () => ordered().findIndex((r) => props.rowKey(r) === props.selected);
  return (
    <View class="flex-1" onLayout={({ bounds }) => width.set(bounds.size.width)}>
      <DataTable
        class="flex-1"
        accessibilityLabel={props.label}
        columns={columns()}
        data={data()}
        rowHeight={ROW_HEIGHT}
        headerHeight={ROW_HEIGHT}
        sort={props.sort}
        onSortChange={({ sort }) => props.onSort(sort)}
        selection={selectedRow() >= 0 ? { row: selectedRow() } : null}
        onRowPress={(e) => {
          const row = ordered()[e.row];
          if (row) props.onOpen(row);
        }}
        columnSelectable={false}
        classes={CLASSES}
        renderCell={
          drawn()
            ? (cell) => {
                const column = shown()[cell.column];
                const row = ordered()[cell.row];
                return column?.cell && row ? (
                  column.cell(row)
                ) : (
                  <Clipped class={`text-sm text-foreground ${column?.mono ? "font-mono text-xs" : ""}`}>
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
