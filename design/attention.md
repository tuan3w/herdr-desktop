# Attention

Attention is what the app exists for, and the way to protect it is to spend it rarely. An agent that waits is said once per view, on its own row, loudly; everywhere else the same fact is a quiet shape and a word. A screen where ten agents wait must read as calm: the person sees where to go, not ten alarms.

The one hot colour is `signal` (`design/colors.md`). Everything below is about where it may appear.

## The rules

1. **Once per agent per view.** In one window an agent that needs the person has at most one signal-coloured mark, and it is on its row in the sidebar (the Board, when it is the main view, replaces the sidebar with a rail and carries the mark on its own row). There is no separate Needs you list: a second list says the same fact twice and makes the project groups lie about where an agent is. The header of the open pane or chat, the tab, the status bar and the title bar do not repeat it (see rule 4).
2. **A project header shows a waiting count only while it is collapsed.** A hidden question is never silent; an open project already shows the mark on the row. Why: ten waiting agents in three projects must be ten row marks at most, not ten marks plus three counts plus a list.
3. **Order does not chase attention.** Rows keep a stable order (last activity), so a mark never makes a row move under the pointer. The cost is that with 25 or more agents a marked row can sit below the fold; the answers are `mod+j` (jump to the next agent that waits in any project; only agents that wait are on the walk, a finished one is not; it never answers, never advances by itself and puts the focus nowhere, since the answer dock stands where the box was; with nobody waiting it says `Nothing needs you` as a toast and to assistive technology; after an answer the dock offers the same jump as `Next`) and the collapsed count. A setting to sort waiting first is the thing that would flip this (unverified: not asked for yet).
4. **Shape first, thin and muted.** The five shapes (needs you = filled with a bar, working = half ring, done = check, idle = ring, unknown = dashed ring) are small and in `muted-foreground`; idle and unknown at 60% opacity; a needs-you row takes the signal colour on its shape alone. Colour was never the signal: the shape and the words are. A sidebar row is a glyph and a title; only an exception adds a word (`quiet 41m`) or a dashed glyph (stale machine). The glyph for a connected machine is a dot, never the check that means done: one glyph, one meaning.
5. **The question is shown once, in the agent's conversation**, in the one answer dock in place of the composer (`design/board.md`). Answering many agents at once is the Board's filtered view, not a second list.
6. **Orange text is rare.** No text is `text-signal`: not a status line, not a heading, not the status bar. A count is a number in `foreground` or `muted-foreground`. The exception is the chat's `New output` pill while the agent waits (the single mark of that agent in a chat scrolled away from its dock).
7. **Risk is a shape, not a colour.** The `alert` icon on a risky answer row is muted; the amber `warning` colour appears only when the row is armed (`Press again to send`), the one moment the colour is an instruction.
8. **The window title and the tray count stay.** `Window.setTitle` shows `(N) Herdr Desktop`; it is the one count seen from another window.
9. **A stale machine is said once** as an amber machine name, dashed glyphs on its rows and one footer line, never as a banner.

## What each surface shows

| Surface | The agent that waits | The project / total |
|---|---|---|
| sidebar row | the signal mark on the glyph, the title | the project header: nothing while open, a count while collapsed |
| Board row | the same mark in its state column | the filter chips are the counts |
| rail tile | nothing of the agent | one dot in the corner of the tile |
| main-region tab | quiet shape beside the name | none |
| status bar | none | none (connection truth only) |
| pane or chat header | none: no state word, no mark; the dock says it in the chat | none |

Decided; built in the sidebar: a row is a glyph and a title (the state word `waiting for you` is in its tooltip), a project header says nothing while open and one count of what waits while folded, a project names its machine in muted text (amber when stale, none for this computer) and a stale machine's rows carry the dashed glyph with no word. Built on the Board (a table, `design/board.md`): rows are a quiet glyph and a title with `Last` and `Age`, the `Needs you` inbox and the project cards are gone, the chips are the only place it says how many, and a project header names its machine (amber when stale). Not yet built: the `quiet 41m` word and the rail while the Board is open. The chat header no longer carries the word (built).

## Why

On the old `storm` screen (twenty waiting in five projects) the first view held about 31 signal marks: a disc per row, a disc and capsule per project in both the sidebar and the cards, the inbox and two counts. Counting marks per fact, not per screen, is how to catch it in review.

## How the code enforces it

- `StatusGlyph` is quiet unless `loud` is passed.
- `ProjectMark` is the only component that draws a project's aggregate.
- `text-signal` is used by nothing but the chat pill (`session-transcript.tsx`); a new use is a design change (edit this file).
- `components/board.test.tsx` pins that the Board states a count only in its chips and has no row-by-row answer buttons.

## Accessibility

States are exposed as words and roles, never colour alone: every row's accessible name says `needs you` (`rowLabel`), a project's group says `2 need you, 1 working` (`projectLabel`), the sidebar announces changes of the count politely (`announceNeedsYou`), and a request that arrives is announced by the chat itself (`Needs you: …`) and by the dock (`The agent asks: …`). The shapes are decorative and hidden from assistive technology; the words beside them carry the state.
