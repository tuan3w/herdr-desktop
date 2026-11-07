# nsh 0.4.0 (Linux/GTK): heap failure when a selectable `TextView` sits in a recycled `List` cell that changes kind

Draft for `longbridge/nsh`. Written by the herdr-desktop maintainers; nothing here has been sent. What was observed and what is only a reading of the source are marked.

## Summary

A chat transcript is one virtual `List`. Its cells are recycled, and one cell can hold a user bubble, then an agent message (`TextView` with `markdown` and `selectable`), then a work-summary row, as it is reused for other rows. With `selectable` on the `TextView`, the app was taken down with

```
memory allocation of 5 bytes failed
```

in `selectable_view::Area::install` (`crates/nsh-platform-linux/src/selectable_view.rs`). The text is the Rust allocator's abort message, so the heap was already corrupted or exhausted when `install` ran: the allocation of 5 bytes is the victim, not the cause. Seen with a chat of 40 rows in a real GTK window (the note in `components/markdown.tsx`). No further stack was kept, and what the person did just before it happened was not recorded; dev builds here have no debug info (`profile.dev debug = 0`).

## Environment

| | |
|---|---|
| nsh | 0.4.0 (tag `v0.4.0`, commit 06771ff), `nsh run --target linux` |
| Host | Ubuntu 26.04, glibc 2.43, GTK 4.22 (`libgtk-4.so.1.2200.4`), Xvfb, `GSK_RENDERER=cairo` for the test windows |
| Rust | 1.99.1 |

## App structure that triggered it

```tsx
<List each={rows()} keyExtractor={(r) => r.key} estimatedItemSize={72}
      maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 64 }}>
  {(row) => <SessionRow row={row} />}   // reads row() and switches on row().kind; no state in the cell
</List>

// agent message cell:
<TextView markdown={text} selectable styles={...} extensions={[{ name: "mermaid", language: "mermaid" }]}
          renderCustom={...} renderImage={...} onLinkPress={...} options={{ streaming }} />
```

Rows are user messages, agent messages (Markdown with lists, tables, fenced code), collapsed work groups and notes. Rows are added at the end while the last one streams (`options.streaming`) and the list is bottom aligned.

## Reproduction

1. Real app: a chat of about 40 rows as above with `selectable` on every agent message's `TextView`, in a GTK window. This is the only case that failed, and the exact gesture that did it is not known.
2. Not reproduced: a stripped lab of 60 keyed rows (user bubble, a plain button row, an agent `TextView` with `markdown` + `selectable` + `renderImage` + `renderCustom` + `onLinkPress` carrying a list, a fenced block and a table), scrolled 10 screens up and 10 down under Xvfb with `GSK_RENDERER=cairo` and `GTK_A11Y=atspi`. So the trigger needs something the lab lacks: [INFERENCE] streaming updates of the last row, or the list's `maintainVisibleContentPosition`, or Mermaid custom nodes, or a row that is removed while selected.

A minimal repro was not found. If the report is to be actionable, the first step is a debug build of the app with `MALLOC_CHECK_=3` or valgrind and the stack of the first invalid write.

## What the source suggests ([INFERENCE], not verified)

`props_changed` installs an `Area` when a view becomes `selectable_view`, and uninstalls it when it stops (`areas.insert(id, area)` returns the old area, which is uninstalled). `Area` keeps `glib::WeakRef<NshView>` handles, `controllers` added with `view.add_controller`, and closures holding `Rc<Surface>` weak references. When a recycled cell changes kind the `TextView`'s node is unmounted and a node with the same `NodeId` can come back; `uninstall` then runs on a view that GTK may already have disposed, and `highlighted` text views and `KeptRows` (the virtual-list rows an area keeps rendered) refer to cells that were recycled meanwhile. Any use-after-free in that chain would show up later as an allocator abort.

## Workaround in herdr-desktop and what it costs

`MarkdownText` (`components/markdown.tsx`) takes `inList`. In a list cell it leaves `selectable` off and sets `userSelect: "text"` on the root text style instead (`styles={{ root: { userSelect: "text" } }}`), so each block selects on its own.

- A selection cannot cross a paragraph, a list item, a code block or a table cell: selecting a whole answer by dragging is impossible. A drag that leaves a block stops at its edge.
- No selection survives the cell being recycled (same as before).
- To keep the whole answer reachable, every finished agent message has a `Copy message` button (`components/session-item.tsx`, visible with the pointer or the keyboard focus) that puts its Markdown source on the clipboard.
- Pages that are not in a list (`Markdown` in the file viewer) keep one `selectable` area for the whole document.

When nsh fixes the crash, `inList` and its `styles` go and agent messages use `selectable` again.
