# Context switching and the command palette: what is not built

Design spec, trimmed to what does not exist yet. What was built left this file: the project contexts, the Switcher, MRU, history and capture rules are `design/context.md`; the palette (scopes, ranking in Rust, rows, actions, steps, files) is `design/palette.md`. Where a number or a rule below is not run, it is marked **unverified**. Facts about nsh 0.4.0 were read from `.scratch/nsh-0.4.0` (the installed runtime), not from the online docs.

Owner direction (binding): desktop context switching may differ from mobile; a person may change habits; the command palette must be great, this is a productivity app.

## 1. Unread and pins (D12, phase P6)

- **Unread**, quiet: the name in `font-medium` (Orca's choice: "unread worktrees are bolded rather than badged") plus `, 3 new messages` in the spoken label. Chats only; terminal agents keep their state and `reviewed`. `BoardRow.unread?: number` (Rust) counts agent-authored items (`message` role agent, `notice`) since the tab was last in front with the window active. `Herdr.markSeen(rowKey)` on focus; persisted in `recents.json` so a restart does not re-mark everything. No dot, no colour, no counter. The palette then gets `is:unread` (the filter word exists; the tag does not).
- **Pinned agents**: `Herdr.pinAgent(rowKey, bool)`, setting `agents.pinned`, pruned when the pane or session is gone (a terminal agent's pane id dies with the pane, said in the action's hint). Pinned agents sort first inside their project and show under `Pinned` on the empty palette (projects already do, `pinProject`). The `Pin` action of an agent in `lib/palette/hit-actions.ts` is then enabled.
- Files: `native/core/src/board/*`, `components/sidebar.tsx`, `components/workspace.tsx` (`TabFace`), `lib/herdr.ts`. Acceptance: an agent message while another tab is in front bolds the name and the tab and clears on focus; a pin survives a restart.

## 2. Palette gaps

| Gap | Design | Why it is not built |
|---|---|---|
| Messages beyond the last message and 8 pane rows | An **in-memory** inverted index over the transcripts of attached sessions (`Sessions.items`, at most 4 per machine) and observed logs, built per revision and dropped with the palette. No on-disk transcript store without the owner accepting it (opt-in setting, 0600 file, one `Clear`, never synced). Competitors that search content: Cursor, Devin Desktop, JetBrains Air, cmux | needs the privacy decision (open question 2) |
| Query affinity | When a prefix of the query led to a pick, that id gets `+0.2` for it (Raycast learns search terms); `Reset ranking` clears it. Query prefixes (40 characters, last 200) live in `recents.json`; Settings > Privacy has `Remember searches` and `Clear palette history` | needs a `recents.json` change and the privacy settings |
| Teaching | After a command with a shortcut was run from the palette three times, the footer shows one `Tip: Ctrl+Shift+] goes to the next project` on later opens, at most twice per shortcut, never announced, off in Settings | small, after affinity (same counters) |
| Attribute filters as chips | `on:`, `in:` and `is:` words work as typed text (`native/core/src/search/query.rs`); Orca shows them as removable chips, cleared when the palette closes | needs a chip row that does not use `searchPrefix` (it removes the field's accessibility label, `design/palette.md`) |
| A branch field | An agent's branch searched at weight 0.3 and shown in its muted line | the board rows carry no branch; `native/core/src/git` knows it per checkout |
| `mod+1..6` picks a row on the empty palette | Orca and Codex do it | the keys are the app's (`board`, `focusPane`, tabs); needs another chord |
| Row actions: `Insert path in the composer`, `Reveal`, `Close its tabs`, `Forget its saved layout` | Raycast-style entries on file and project rows | each needs an API (`lib/pane-input.ts` insert, `reveal_path`, `lib/dock.ts` forget) |
| Message hit opens at the line | A chat tab scrolled to the item | `Sessions.items` has ids; the transcript has no scroll-to-item |
| The Switcher as the palette's `Recent` view | One component (principle 6) | the Switcher shipped first as its own component (`components/switcher.tsx`) |

## 3. Hold to cycle (D4 follow-up)

`ctrl+tab` is a tap (previous agent) because nsh 0.4.0 cannot report a key release: `Keymap.bind` has `when` and `repeat` only and the backends listen to presses (`crates/nsh-core/src/keymap.rs`, `nsh-platform-linux/src/keymap.rs`). Zed's and VS Code's "hold `ctrl`, press `Tab` to move, release to commit" needs an upstream release event: ask nsh for one, then the Switcher can commit on release. **Unverified:** whether GTK's `EventControllerKey` release can be forwarded without a new nsh API; `mod+e` covers deep cycling meanwhile.

## 4. Measures still to take

- Palette keystroke to rows committed, p95 < 16 ms on 2,000 and 5,000 candidates: Rust is 0.25 ms and 0.6 ms (`cargo bench --bench search`); the TSX side is the `.perf` rows `palette typing, N candidates` (`docs/PERFORMANCE.md`).
- Frecency hit rate (share of picks in the top 3 rows, local counters), project switch to first painted row, RSS and watcher count after 20 switches.

## 5. Open questions for the owner

1. **`ctrl+tab` as a tap now, and ask nsh upstream for a key-release event** so it can become hold-to-cycle? Recommended: yes.
2. **Transcript content search: titles, last message and 8 pane rows only (as built), or an in-memory index of conversation content, or an on-disk one?** Recommended: the in-memory index of attached sessions and observed logs next; an on-disk index only after the owner accepts storing transcript text.
3. **May a person pin an agent, given that a terminal agent's pane id dies with the pane?** Recommended: yes, with the hint on the action and pruning.
