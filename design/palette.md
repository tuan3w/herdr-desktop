# The command palette

One palette (`components/palette.tsx`, principle 6): the search over everything the person can go to or do. `mod+p` opens it and `mod+shift+p` opens it on the files of the project (the owner's choice; `mod+k` is not bound), `mod+e` is the Switcher (`design/context.md`, a smaller list of the places visited last). Entry points go through `openPalette` and `paletteKey` in `lib/palette/controller.ts`; a second `mod+p` while it is open opens the actions of the highlighted row, and `Escape` closes.

## What it looks like

A card 640 pt wide near the top of the window (`PaletteDialog`: a dialog with no title bar, because the search field is its header), `rounded-xl`, one hairline under the field and one above the footer; the rows are inset 4 pt so the highlight does not touch the card, and the field, the chips and the footer share the rows' text edge. Opening fades and scales from 0.98 in `DURATION.context` (120 ms, `EASE_OUT`; `paletteEnter`), closing is instant, nothing moves under reduced motion; results appear at once.

- **Field** (height and text size from `lib/layout.ts`, which the type-scale cutover changes), with the scopes at its end as a radio group (`ScopeChips`): `All` and one character each. Above the field, only inside a layer, a row of chips names where the person is (`Actions › payments api`, `New agent session in › payments`, `ArgChips`).
- **Rows** (`Row` in `components/palette-row.tsx`, height from `lib/layout.ts`), one line, at most 30 of them and then `N more, keep typing to narrow them` (every listed row is mounted, so what is listed is what costs): a glyph (an agent's shape, as on a sidebar row: glyph and title first, the rest muted, a project's tile, or a muted icon), the name in medium weight with the matched letters in bold, the muted line (project, checkout, machine, or a command's group), `needs you` in words for a waiting agent, the age, then the key or a check. The signal colour is never used here: the palette is where the person goes to something, not where the app calls them. A row that cannot run is dimmed, passed over by the arrow keys, and says why in its muted line. The card is `bg-popover` (in the dark appearance `bg-card` is the page's own shade), the field's ink is `text-foreground` (without it nsh draws dark text on the dark card).
- **Row**: the age, `needs you`, a check and a shortcut (`Keys`, `quiet` tone) sit at the right edge, one cap per key, the same x on every row. nsh's command list wraps a custom item in a node as wide as its content, so `Row` is given the dialog's width less padding (`w-[608px] max-w-full`) and a spacer takes the slack.
- **Footer**, one reserved line, so moving the highlight never moves the list: the preview of the highlighted row on the left (an agent: its folder and its last words, or the question it waits on; a project: its agents and folder; a file: its full path) and the keys that work now on the right.
- **Empty query** (`Catalog`, frozen at open): `Needs you` (at most 3, longest waiting first), `Pinned`, `Recent` (6 agents by visit, the one in front left out unless it needs you; `Agents` by urgency when nothing was visited yet), `Projects` (3 recent), `Suggested` (3 commands: the one for what waits, then the most used, then the defaults).
- **Nothing found** is a heading `No match for “q”` over rows the keyboard reaches: search messages, search files (when a project is in front), start an agent session, open it as a path when it looks like one.

## Where it sits among the regions

The palette is a transient search, not a fourth list of agents: it closes on use and holds no state. That is why it may say `needs you` in words beside a waiting agent and group `Needs you` in its empty state, while no other surface may (`design/attention.md`). `mod+j` (jump to the next waiting agent) is the keyboard route for the same need without opening anything. Settings, files and themes found here open in the main region or the inspector, never in a modal over the sidebar (decided, not built yet).

## Scopes and prefixes

| Scope | Prefix | Finds |
|---|---|---|
| All | none | agents, projects, commands, machines, settings, themes, at most 3 message lines |
| Agents | `@` | chats and terminal agents by name, project, checkout, folder, machine, kind, last message |
| Projects | `#` | by name, checkout, machine |
| Commands | `>` | every command of `lib/actions.ts`, the switches of Settings, themes, machines |
| Files | `/` | files of the project in front (`Files.search`) |
| Messages | `"` | the last message and the last rows of a pane, as lines (it says so: titles and recent output, not transcripts) |
| help | `?` | lists the modes as rows |

A prefix typed at the start of an `All` query picks the scope and is not part of the text (`readQuery`); `Tab` and `Shift+Tab` cycle the chips; `Escape` on an empty query takes a scope back before it closes. Words `on:<machine>`, `in:<project>` and `is:needs|review|working|idle|chat|terminal|pinned` narrow a query (they stay text in the field; they are not chips).

## Ranking

Rust, `native/core/src/search`, behind `Search.open`, `query` and `close` (`native/app/src/search`). `open` freezes the board, the machines, the commands TSX registers (`paletteCommands`) and the recents; every `query` ranks against that copy, so a row is where the eyes left it while the palette is open and only what it says about itself (shape, age) is read live from the board.

- Text is folded one character at a time (lower case, no diacritics, no invisible characters, `đ` is `d`), so `dinh` finds `Định` and the matched letters map back to the original title (`fold`).
- Match: `nucleo-matcher` subsequence on names of up to 28 characters; a longer name (a command's sentence) and long text (a message) only by the start of a word or a substring, so `pay` does not find `Back to the place you came from`. Every word of the query must match some field; the score is the sum of each word's best field times its weight (name 1, project 0.6, checkout 0.5, folder 0.4, machine 0.4, kind 0.3, last message 0.2, a synonym 0.7).
- Typo tolerance only when fewer than 3 items match strictly, for words of 4 letters or more, one edit (`within_one`). Synonyms are the `verbs` and `keywords` of a command, shown as `Title (alias)` when one won.
- Frecency (`frecency`, from `recents.json`; half-life 7 days for agents and projects, 21 for commands) multiplies the score by at most 1.6, so a good match beats a frequent bad one; the focused project is ×1.2, its machine ×1.05; typing a name in full puts that name first; a disabled command lists last. The same query always gives the same order (golden tests in `native/core/tests/search.rs`).
- A longer query starts from the matches of the last one: a keystroke at 2,000 candidates costs about 0.25 ms, at 5,000 about 0.6 ms (`cargo bench --bench search`).

## Layers

Three share the one list; `Escape` steps back one layer, then clears the query, then closes.

1. **Results.** `Enter` opens (an agent where it lives: its project's context), `Shift+Enter` opens beside the tab in front, `mod+Enter` opens the other view (chat or terminal).
2. **Actions** (`actionsFor`, `fileActions`): for an agent Open, Open to the side, Open here (`{ here: true }`), Show terminal or chat, Reply…, Mark reviewed (with `Undo`), Stop, Rename…, Copy pane id, Copy folder, Close pane in herdr…, Kill session…; for a project Switch, New agent session here…, Pin, Browse files, Copy folder; a file Open, Show in its folder, Copy path; a machine Reconnect; a command Run and Reset ranking. What cannot be undone asks first (`confirmDestructive`) and says so in the row (`asks first`); what cannot run stays listed with its reason.
3. **Steps** (`phraseOf`, `runWith`): `New agent session in…` (project, then the agent the machine can run), `Browse files in…`, `Open file…`. The choices stay as chips; a phrase (`new session pay`) opens step one already filtered to `pay`.

## Accessibility

`Command` announces only a row's label, so the label is the whole sentence (`PaletteRow.spoken`: `chat, payments review, claude, needs you, payments, This computer, 3 min`). The field's label names the scope or the layer (`Search agents, projects and commands`, `Actions for auth`, `Choose a project`); the list is `Results`; the scopes are a radio group named `Search in` whose chips are never focus stops. The number of results is said once, 400 ms after typing stops; layers and scope changes are announced. Focus returns to where it was when the palette closes.

nsh 0.4.0 facts that shaped it:

- **`searchPrefix` removes the field's accessibility label** (any value, even plain text): the layer chips are the list's `header` instead.
- A key bound with `when: "always"` is consumed. `Right` is not bound (it would stop the caret) and `Backspace` is bound only inside a layer, where it takes the last chip off an empty field and otherwise deletes the last character itself (a short filter is edited at its end); on the results it stays the field's. Escape also steps back, and the actions are `mod+k`.
- `Tab`, `Shift+Tab`, `Shift+Enter` and `mod+Enter` are bound only while it is open (`keymap.bind` in `Palette`).
- A query the palette rewrites (a prefix, a phrase) is set to the typed text first and to its meaning on the next tick, because the field follows only a change of its value.

## Not built

Query affinity (a learned boost for the words that led to a pick), the tip after three runs, `mod+1..6` to pick a row (those keys are the app's), attribute filters as removable chips, `is:unread` and pinned agents (the board has neither), a branch field (the board does not carry it), transcript search (`docs/specs/context-switching.md`, open question 6).
