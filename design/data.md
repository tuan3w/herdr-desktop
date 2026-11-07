# Tables and lists

Two surfaces show many records. Choose by the job, not by taste.

| | List rows | `Table` |
|---|---|---|
| job | work through records one by one | scan, compare, sort many at once |
| shows | 2 or 3 lines of what matters now, pills, a context menu | one value per column, a sort button on each |
| next to it | the open record, side by side | nothing: a press opens the record full width |
| fits | 5 to about 1,500 | thousands (only the rows in view are built) |

A screen may offer both for the same filtered records. The choice is a setting (a signal in `lib/settings.ts`) and a toggle (`Segmented iconOnly`) beside the filter in both views. Below the narrow width (`narrow()`) the list is the only view and the toggle is hidden.

## Table

`Table<T>` in `components/kit/table.tsx` wraps nsh's `DataTable`: themed, typed by row, sorted by the caller's state.

```tsx
// Correct
<Table label="Agents" rows={list()} rowKey={(a) => a.id} columns={COLUMNS}
  sort={tableSort()} onSort={(next) => tableSort.set(next)} onOpen={(a) => selectedId.set(a.id)} empty={<NothingToShow />} />
```

- A `Column` has `key`, `title`, `width` (points), optional `grow`, `align`, `mono`, `text(row)`, optional `sortBy(row)` (a number or ISO time that sorts differently from its text) and `cell(row)` (a `Pill` or `Badge` instead of text).
- The table is as wide as its columns. A wider table is shared by the columns with `grow`. A narrower one drops its optional columns before it scrolls sideways: a `Column` with `drop` leaves when the table's own width (not the window's: the sidebar is resizable) cannot hold them all, lowest `drop` first (`fittingColumns`, unit-tested).
- Sorting lives in the caller (`sort`, `onSort`) so it survives leaving the screen. Order: ascending, descending, none. Empty values (an agent with no recorded activity) sort last in both directions, so a blank never leads a column; text sorts without regard to accents (`sortedRows`, unit-tested).
- Pressing a row opens it (`onOpen`); a row has no other action.
- The cells take no pointer: `DataTable` draws them in a body that receives no pointer events, over the layer that hears presses and hover, so a button, a `Tipped` or a `Clipped` hover inside a cell cannot fire (only the row's hover fill and its press work). Whatever must be pressable per row lives in the list view; a cell says what it can in text, on a second line (a pane name over `Idle 4m`).
- Headers are `text-xs font-medium` in `muted-foreground`, never uppercase; the sorted column is `foreground`. Rows and the header are `ROW.table` of `lib/layout.ts` (36: a table is read, not scanned by pointer); the hover and selected fills are `accent` (configured, not seen: a press opens the record, so nothing stays selected). Identifiers use `mono`; counts use `Badge`; states use `Pill`.
- The empty state is a slot (`empty`, the same one the list uses): first run offers to create, a filter only explains.

## What nsh's `DataTable` needs (found while building it)

- Give it a height: `class="flex-1"` inside a flex parent. Without it the table is a 2pt line.
- Passing `renderCell` draws every cell through it, so the wrapper renders the plain text cells itself.
- Columns have fixed point widths, not flex: the wrapper measures its own width (`onLayout`) and distributes the spare.
- Resizing and moving columns are off (`resizable`, `movable` false): saved widths would be one more setting to explain.

## Many rows

- Cut cells are `Clipped`: hover shows the whole text. A path or name longer than its column is the normal case, not an error.
- `Table` works the order, the cell texts and the column widths out once per change (`computed`), not once per drawn cell, and a sort works out each row's key once, not once per comparison (`sortedRows`, unit-tested). A column that counts reads an index built once per change, never scans the records per row. A row of the list view does the same: look a record up in a `Map`, never scan the collection per row.
- A `List` tells which rows are new **by object identity** (`keyExtractor` only names them for viewability), so a `computed` that builds its items anew on every read replaces every row at every tick: the list drops what it measured and, when rows are taller or shorter than `estimatedItemSize`, the person's place slides towards the top (seen in the sidebar, 600 pt to 284 pt in six ticks). Hand the list the object it already had for a row that did not change (`keepItems` in `lib/sidebar.ts`; a transcript's `buildRows` does it by `sig`). A time that the engine measures anew at each read (`sinceSecs`) counts as unchanged while it reads the same. Headless `nsh test` does not drift, only a real window does: `nsh test components/sidebar-scroll.test.tsx --target linux` is the check that fails without it.
- A move the person makes (another tab, `mod+j`, the switcher) brings the open row into view when it is out of it; a tick never moves the list.
- A pick list (`Combobox`) builds a bounded number of rows and says typing narrows it (`design/forms.md`, `design/combobox.md`).
- A long list (a transcript, the Board's table, a board of hundreds) is a `List` (`design/components.md`): mounting every row makes memory and frame time grow with the data, and a scroll through thousands of mounted rows stalls the host.
- Search folds each record's text once (`fold` in `lib/text.ts`, cached per record object, which the store replaces when it edits one), and the filtered list is one `computed` that the count, the list, the table and the announcement share. Typing then costs a few milliseconds of JS per keystroke.
- Read CPU from the operating system, not from the `--fps` panel: the panel redraws twice a second and on a screen that otherwise idles it costs a large share of a core itself. Scrolling a long table costs the same with the kit's drawn cells as with plain native cells, so that cost is what the host spends per frame, not something the kit adds.

## Verified, and not

The headless test harness does not list a `DataTable`'s cells and cannot press its sort button, so the tests cover the sorting and the column fit as pure functions (`table.test.ts`). A real press on a header was not exercised, and nor was pressing a table row to open it: the list and the table call the same `open`. The cell rule above is read from `DataTable`'s source (its body receives no pointer events), not tried on a pressed cell.
