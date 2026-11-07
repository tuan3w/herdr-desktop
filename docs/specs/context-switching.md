# Context switching and the command palette

Design spec, not code. Status: proposal for the owner; nothing here exists yet except where a path or symbol is cited. Sources are linked inline; anything not run or not read on a primary source is marked **unverified**. Facts about this repo were read from the files named; facts about nsh 0.4.0 from `.scratch/nsh-0.4.0` (the installed runtime), not from the online docs.

Owner direction (binding): desktop context switching may differ from mobile; a person may change habits; the command palette must be great, this is a productivity app.

Scope note: `docs/specs/agent-orchestration-landscape.md` (sibling research) arrived after the first draft; its relevant findings are folded in at the end of section 8 and in open question 6. The agent apps in section 1 (Orca, Superset/Paradev, Conductor, Cursor, Claude Squad) were read from their own docs for navigation and palettes only.

## 0. Decision summary

| # | Decision | Chosen | Rejected (why) |
|---|---|---|---|
| D1 | What a context is | A **project** (`BoardProject.key`, per machine) plus its remembered working set; **Home** (the board) is the one context outside any project. Agents are destinations *inside* contexts | Context = agent (that is a tab, no layout); = herdr workspace (herdr's word, not the person's); = user-named layouts (bookkeeping); = today's one global layout (a 15-tab soup, closes and reopens to change task) |
| D2 | What restores | Layout (groups, splits, sizes, active tab per group), focused tab, composer drafts, chat scroll anchor. Not window size, not sidebar folds (global) | Restoring pane screens (they are live), restoring selections or find queries (noise) |
| D3 | Where it lives | Layouts and view state in TSX `Storage` (UI-only): `herdr.dock.v2`, `herdr.views.v1`. Visits, frecency, pins in Rust (`recents.json`): whoever ranks owns the data | Everything in Rust (layout is UI state and `DockArea` is TSX); everything in TSX (ranking runs in QuickJS) |
| D4 | Navigation | Global MRU of agents and projects; back/forward `mod+[` `mod+]`; `ctrl+tab` previous agent, `ctrl+shift+tab` previous project (taps, no list); `mod+e` Switcher (MRU list, press again to cycle); `mod+shift+[` `mod+shift+]` previous/next project | Hold-Ctrl-to-cycle now (nsh 0.4.0 cannot report a key release, section 2.3); alt-based keys (AltGr) |
| D5 | Palette entry points | `mod+k` and `mod+shift+p` palette (all scopes); `mod+p` files of the project; `mod+e` Switcher. One palette, scopes by prefix and chips | Separate palettes per job (Superhuman rule 2: one place for everything) |
| D6 | Capture mode | Pane wins every plain `mod+letter` and `mod+/ \ [ ]`; the app keeps only keys a terminal cannot send (`mod+shift+*`, `ctrl+tab`, `mod+,`, digits, F-keys) | Today's rule (app steals Ctrl+K N Z F J B W from the pane) |
| D7 | Ranking | Rust index and matcher (`Herdr.search`), fzf-style fuzzy with fold, frecency, context boosts; order frozen at open so rows never jump while typing | Ranking in TSX (QuickJS, 2,000 candidates per keystroke is not safe); nsh `Command`'s own filter (lowercase substring only) |
| D8 | Acting on a result | Action panel for the highlighted row (`mod+k` again, or Right at the end of the query); `Enter` default, `Shift+Enter` to the side, `mod+Enter` the other view | Inline hover buttons (not keyboard-first; `Command` rows have no inner controls) |
| D9 | Commands with arguments | Two-step with a chip per chosen step; natural phrases (`new session in pay`) pre-fill step 2 | One giant flat list of every project x command |
| D10 | Files / messages | `Files.search` (Rust: `ignore` locally, `git ls-files` remotely) for `mod+p`; messages = title + last message + 8-row preview now; **transcript content search is a known competitive gap, kept as open question 6, not a silent deferral** | Walking files from TSX; storing transcripts on disk by default (privacy) |
| D11 | Motion | One new motion: incoming-only 120 ms opacity entrance on a project switch (amends `design/motion.md`); palette open reuses `enterScale()` | Cross-fading the outgoing workspace (a delay); animating the live mirror |
| D12 | Unread / pins | Quiet unread = bold name + count in the spoken label (chats only; terminals keep state); pins for projects (exist) and agents; `Recent` is a palette/switcher group, never a sidebar list | Unread dots and counters (a wall of marks) |

Phases (section 8): P0 spikes, P1 switcher + MRU + history, P2 project contexts, P3 palette v2, P4 action panel + two-step, P5 file quick open, P6 unread, pins, message search.

## 1. Research: what the best tools do

| Tool | What matters for us | Source |
|---|---|---|
| **Orca** (closest cousin: worktree-per-agent, tabs per worktree) | `Cmd-J` jump palette across worktrees and tabs; empty query = up to 6 recent agent/terminal sessions ranked needs-you, done, idle, current idle tab omitted; **membership and order freeze when the palette opens so rows do not shuffle**; digit shortcuts to the first rows; `Tab` opens host/project filter chips, cleared on close; `Shift-Enter` opens in a split; no match offers **Create worktree**; `Cmd-P` file search, filename-first rows, gitignored files as a second pass; sidebar grouped by project, "unread worktrees are bolded rather than badged"; everything in a worktree (agents, editors, browser) is scoped to it | [quick-open](https://www.onorca.dev/docs/model/quick-open), [worktrees](https://www.onorca.dev/docs/model/worktrees) |
| **Superhuman** | Five rules: palette everywhere, **toggles** on its own key, one place for all commands, forgiving (fuzzy plus synonyms, shown as `Title (alias)`), contextual (hide only the irrelevant, boost the rest, per-command `scale`, `follow` ordering); teaches the shortcut in the row; 100 ms rule (aim < 50 ms) | [palette](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette), [speed](https://blog.superhuman.com/superhuman-is-built-for-speed) |
| **VS Code** | `Ctrl+P` quick open; repeating it cycles recent files; `?` lists the prefix modes; Right arrow opens in the background; hold `Ctrl` + `Tab` then release to commit; `navigateBack/Forward`; reopens exactly as left (folder, layout, files) | [editing](https://code.visualstudio.com/docs/editing/editingevolved), [tips](https://code.visualstudio.com/docs/getstarted/tips-and-tricks), [UI](https://code.visualstudio.com/docs/editing/getting-started/userinterface) |
| **Zed** | `ctrl-tab` Tab Switcher sorted by recent use, stays open while `ctrl` is held, release commits, `escape` returns to the original tab; selection previews live | [tab switcher](https://zed.dev/docs/tab-switcher), [navigating](https://zed.dev/docs/finding-navigating) |
| **JetBrains Search Everywhere** | Empty query shows recent files; `Tab` switches the scope (classes, files, symbols, actions); direct keys open a scope; synonyms ("toggle presentation mode" finds the action) | [docs](https://www.jetbrains.com/help/idea/searching-everywhere.html) |
| **Raycast** | `Enter` = primary action, `Cmd+K` = **action panel** for the item with a shortcut on every action, sub-menus, destructive in red, `Reset Ranking` clears learned frecency, aliases and hotkeys set from the panel | [action panel](https://manual.raycast.com/action-panel) |
| **Linear** | `Cmd+K` for pages and actions, `/` searches content, an identifier (`LIN-123`) is a query, `G then I` go-to chords, `?` lists keys | [navigating](https://linear.app/enablement/guide/navigating-linear) |
| **Slack** | `Ctrl+K` jump to a conversation, `Alt+Shift+Up/Down` previous/next unread, `Alt+Up/Down` sidebar order | [shortcuts](https://slack.com/help/articles/201374536-slack-keyboard-shortcuts) |
| **Warp** | Palette filters by prefix (`sessions:`, `files:`, `actions:`) **and** filter buttons; `sessions:` searches by running command and status ("Running…") and orders by recency; `Ctrl+Tab` configurable to most-recent-session cycling | [palette](https://docs.warp.dev/terminal/command-palette), [sessions](https://docs.warp.dev/terminal/sessions/session-navigation/) |
| **Arc / browsers** | Control-Tab shows the 5 most recent tabs (Arc help center, snippet only); Chrome `Ctrl+Shift+A` searches tabs, Firefox needs the `%` token and users ask for the Chrome shortcut | [Arc](https://resources.arc.net/hc/en-us/articles/25619402657303), [Mozilla Connect](https://connect.mozilla.org/t5/ideas/keyboard-shortcut-for-quot-search-tabs-quot/idi-p/9134) |
| **tmux / herdr** | tmux `l` last-window, `L` last client (`key-bindings.c`); herdr: prefix `ctrl+b`, `prefix+g` session navigator, indexed jumps `prefix+1..9` (tab), `prefix+shift+1..9` (workspace), `prefix+alt+1..9` (agent) (`.scratch/herdr-llms.txt`) | [tmux source](https://github.com/tmux/tmux/blob/master/key-bindings.c) |
| **Agent apps** | Superset/Paradev: `⌘1-9` workspace n, `⌘⌥↑/↓` previous/next in sidebar order (wraps), `⌘P` quick open, `⌘⇧K` palette, `⌘Z` undoes closing a chat tab ([docs](https://docs.superset.sh/keyboard-shortcuts)). Conductor: `⌘⇧H` Home, clicking the selected workspace jumps to its oldest unread chat ([changelog](https://www.conductor.build/changelog)). Cursor Agents Window: multi-workspace, `Cmd+P` files inside it ([docs](https://cursor.com/docs/agent/agents-window.md)). Claude Squad: `n`/`N` new session in a TUI list ([repo](https://github.com/smtg-ai/claude-squad)). The sibling `agent-orchestration-landscape.md` has the product comparison | |

**Research that backs the model.** Resumption is expensive: in 10,000 recorded sessions of 85 programmers only 10% resumed editing within a minute and only 7% did so without first navigating elsewhere ([Parnin and Rugaber, ICPC 2009](https://chrisparnin.me/pdf/parnin-icpc09.pdf)); so a context must come back with its tabs, position and unsent text, not only its name. Fragmented work is the norm ([Mark et al., CHI 2005](https://ics.uci.edu/~gmark/CHI2005.pdf), title only, numbers not read). 0.1 s is the "instantaneous" limit ([NN/g](https://www.nngroup.com/articles/response-times-3-important-limits)). **Ranking:** Firefox's frecency is a double exponential decay over a sample of recent visits with a type bonus ([docs](https://firefox-source-docs.mozilla.org/browser/urlbar/ranking.html)); fzf scores with a modified Smith-Waterman (boundary, camelCase and consecutive bonuses, [algo.go](https://github.com/junegunn/fzf/blob/master/src/algo/algo.go)); `nucleo` uses the same scoring, is much faster on low-selectivity patterns, handles non-ASCII and graphemes properly, MPL-2.0 ([README](https://github.com/helix-editor/nucleo)); Bitap tolerates typos and transpositions ([Fuse.js](https://www.fusejs.io/fuzzy-search.html)); Superhuman's `command-score` forgives `lnik` for `link`. **Accessibility:** the APG combobox keeps focus in the input and moves a virtual focus in the popup ([APG](https://www.w3.org/WAI/ARIA/apg/patterns/combobox)); screen readers differ in what they re-announce, React Aria cleared the virtual focus on input changes for NVDA ([React Spectrum](https://reactspectrum.blob.core.windows.net/reactspectrum/2a786cfffcfe1abb117aee764a068058af87d99a/docs/blog/building-a-combobox.html)); GTK's `announce` is polite and does not interrupt ([GTK 4.14](https://docs.gtk.org/gtk4/method.Accessible.announce.html)). What Orca (the screen reader) says on our Linux tree is **unverified**: no display in agent sessions.

**What the repo already gives (read):** `BoardData.projects[].rows[]` with `key, machine, project, checkout, cwd, name, agent, status, sinceSecs, lastMessage` (sessions only), `preview` (last 8 pane rows, terminals), `reviewed, prompt`; `BoardProject.{key,name,machine,machineName,pinned,checkouts,needsYou,toReview,working}`; `Herdr.pinProject`, `Herdr.setting/setSetting`; `Sessions.list/items`; `Files.find(machine, cwd, target)` (resolves a **given** path; it is not a search) and `Files.open`; `lib/text.ts` `fold` (diacritics, `đ`, invisible characters); `lib/dock.ts` (`focused`, `lastPane`, `openPanel`, `moveFocused`, one layout in `herdr.dock.v1`); `lib/open-agent.ts` (`openAgent`: chat or terminal); `lib/actions.ts` (`actions()`: every command with `keywords`, `disabled`, `checked`; `runAction(id)`); `Palette` = `Command` in `Modal` with the native filter and a count announcement. No branch name exists (`ARCHITECTURE.md` section 7: `worktree.list` is not read; the checkout folder name stands in).

## 2. The model

### 2.1 Context, Home, and what restores

A person supervising 20 agents thinks "the payments API", then "the infra repo", then "what needs me". Three levels, three gestures:

| Level | Is | Gesture | Restores |
|---|---|---|---|
| Home | the board (all projects, `Needs you` inbox) | `mod+1` (exists) | its layout (board plus anything left there) |
| Project context | one `BoardProject` + its tab groups | switcher, palette `#`, sidebar project name, `mod+shift+[ ]` | layout, focused tab, drafts, scroll |
| Agent | a chat or terminal tab | switcher `@`, sidebar row, `mod+j`, `ctrl+tab` | focus, the tab's own state |

Rules (each tested): (1) **a tab belongs to its agent's project context**; opening an agent from anywhere (palette, notification, inbox, `mod+j`) switches to that context and shows the tab in it; an agent already open somewhere is focused where it is. (2) `Open here` (action panel) puts a foreign tab into the current context on purpose (comparing two agents of different projects): the only way a tab leaves its home. (3) An empty project context shows `renderEmpty`: the project's own card (the board's project card component: agents, state, `New session in <project>`), so a context is never blank. (4) Closing the last tab of a context does not delete the context. (5) Pane screens are never restored from storage (they are live); a restored pane tab is a fresh `PaneScreen` on the same pane.

Home stays a context because the supervisor's first question is "does anything need me" and one key (`mod+1`) must always answer it, then return. Back/forward make that round trip free.

### 2.2 Navigation history and MRU

- **MRU** (persisted, Rust): `noteVisit(kind: "agent"|"project", key)` on every deliberate arrival (tab becomes focused for >= 1 s, or any command-driven open). `Herdr.recent(kind, limit)` returns keys newest first, skipping gone rows. Two lists: agents (global) and projects.
- **History** (session-only, TSX `lib/nav.ts`): a stack of locations `(context, tab)`, capped at 50, consecutive duplicates collapsed, a location whose agent vanished is skipped. `mod+[` back, `mod+]` forward; a new deliberate navigation truncates forward. Clicking between tabs of one group does not push; commands, palette picks and context switches do. Browser semantics, as VS Code's `navigateBack` ([docs](https://code.visualstudio.com/docs/editing/editingevolved)).
- **Previous** (the Alt-Tab / `Ctrl-^` / tmux `l` reflex): `ctrl+tab` swaps the two most recent *agents* (crossing contexts), `ctrl+shift+tab` the two most recent *projects*. A tap, no list; repeating returns. With one project they coincide.
- **Switcher** (`mod+e`): an overlay of the MRU list (agents and projects interleaved) with row 2 highlighted; `mod+e` again moves down, `mod+shift+e` up, `Enter` commits, `Escape` returns to where you were (Zed's contract, [docs](https://zed.dev/docs/tab-switcher)). It is the palette's empty-state `Recent` list at a smaller footprint, the same component, not a second one.
- **Unread** (D12): `BoardRow.unread?: number` (new, Rust): agent-authored items (`message` role agent, `notice`) since the tab was last in front with the window active; chats only (terminal agents' marker is their state and `reviewed`). Rendered as the name in `font-medium` (bold-equivalent, Orca's choice) in the sidebar row, tab face, palette and switcher row; spoken as `, 3 new messages`; no dot, no colour. `Herdr.markSeen(rowKey)` on focus; persisted in `recents.json` so a restart does not re-mark everything.
- **Pins**: projects (exists: `pinProject`) and agents (`Herdr.pinAgent(rowKey, bool)`, settings `agents.pinned`, pruned when the pane/session is gone; a terminal agent's pane id dies with the pane, said in the action's hint). Pinned agents sort first inside their project and under `Pinned` in the empty palette.

### 2.3 Keyboard model

Rules unchanged: global keys carry `mod`, never `alt`; `Escape` is never global; no `mod+q`, `F11`. One new exception, to extend in `lib/shortcuts.ts` and `shortcuts.test.ts`: `ctrl+tab` and `ctrl+shift+tab` are written explicitly with `ctrl` (not `mod`): no layout types them, and on Apple platforms `cmd+tab` belongs to the OS.

New and changed entries of `GLOBAL` (ids in the table are the new `GlobalShortcut` members):

| id | keys | Does | In capture mode |
|---|---|---|---|
| `palette` | `mod+k`, **`mod+shift+p`** (new second key) | palette, all scopes; on its own key again closes (Superhuman rule 1) | `mod+shift+p` only |
| `quickOpen` | `mod+p` | palette in `Files` scope (project root, section 5) | pane |
| `switcher` | `mod+e`, `mod+shift+e` | Switcher forward / backward | pane (`mod+e`); `mod+shift+e` app |
| `previousAgent` | `ctrl+tab` | swap with the previous agent | app |
| `previousProject` | `ctrl+shift+tab` | swap with the previous project | app |
| `back`, `forward` | `mod+[`, `mod+]` | history | pane |
| `prevProject`, `nextProject` | `mod+shift+[`, `mod+shift+]` | previous/next project in sidebar order, wrapping (Superset's model) | app |
| `board` | `mod+1` (exists) | Home | app |

Inside the palette (bound only while it is open, `when: "always"`, the way `CaptureBar` binds keys): `Tab`/`Shift+Tab` next/previous scope chip; `Enter` default action; `Shift+Enter` open to the side; `mod+Enter` open the other view (chat or terminal); `mod+k` or `Right` at the end of the query: action panel; `mod+1..6`: pick row n when the query is empty (Orca, Codex); `Backspace` on an empty query removes the last argument chip; `Escape` steps back one layer (action panel, argument step, query, close).

**Terminals vs our keys.** In capture mode the app today forwards only keys that are not in `GLOBAL` (`captureKeystrokes()` in `lib/pane-input.ts`), so on Linux these Ctrl keys never reach the pane: `K` kill-to-end, `N` next history, `Z` suspend, `F` forward char, `J` newline, `B` back char (also tmux's prefix inside the pane), `W` kill word. Adding `P` previous history, `E` end of line, `[` (**is Escape**), `]`, `\` (SIGQUIT), `/` (0x1f, undo) would make it worse. Decision D6: a `GLOBAL` entry carries `capture: "app" | "pane"`, derived by rule and overridable: **pane** for `mod+<letter|punctuation>` without Shift (a terminal can send those), **app** for everything a terminal cannot encode: any `shift` chord (Ctrl+Shift+P is indistinguishable from Ctrl+P on the wire), `ctrl+tab`, `mod+,`, `mod+1/2/0`, F-keys. `captureKeystrokes()` then adds the released keys to its candidates when `PaneKeys.herdrKey` can name them (`ctrl+[` and friends: check the schema; those it cannot name stay the app's). The hint bar says `Typing into <agent> · Ctrl+Shift+K leaves · Ctrl+Shift+P palette`. Cost: inside capture mode `mod+j` and `mod+n` no longer work; the palette and `mod+shift+j` do. Apple platforms are unchanged (`mod` is Cmd, every `ctrl+letter` already belongs to the pane). Test: `pane-input.test.ts` asserts the exact released set.

**Can nsh deliver `ctrl+tab`?** Evidence: `nsh-core` accepts `tab` as a key and `Keystroke::reserved` lists only `ctrl+q`, `alt+f4`, `f11` on Linux (`crates/nsh-core/src/keymap.rs:429-449`); the Linux backend installs a **global-scope, capture-phase** `gtk::ShortcutController` on the root and maps `tab` to `<Control>Tab`, with `shift+tab` to `<Shift>ISO_Left_Tab` (`crates/nsh-platform-linux/src/keymap.rs:57-102`, test at `:299`), so the focused input does not see the key first; a binding fires in a text field only with `when: "always"` (`edits_text` treats `Tab` as an editing key). GTK's own `Ctrl+Tab` lives in `GtkNotebook`, which nsh does not use. **Not deliverable: key release.** `Keymap.bind` has `when` and `repeat` only; the backend listens to releases solely to re-arm a held key (`watch_releases`, `keymap.rs:159-177`) and no TSX API exposes them, so "hold Ctrl, tap Tab, release to commit" (VS Code, Zed) is not buildable in TSX. Hence taps for `ctrl+tab`, an explicit `Enter` for the Switcher, and spike S1 (real delivery on a display; `nsh test --target linux` presses synthesise bindings without GTK, `keymap.rs:120-144`) plus an upstream request for a modifier-release event. If a Rust-side hook proves possible, `ctrl+tab` upgrades to hold-to-cycle with no key change. All of this is read from source, **not run**: no display here.

## 3. The palette

### 3.1 Scopes, prefixes, chips

| Scope (chip) | Prefix | Searches | Notes |
|---|---|---|---|
| All | none | agents, projects, commands, machines, settings, themes, up to 3 message hits | one ranked list, **no group headers while typing**; kind shown by the row glyph |
| Agents | `@` | chats and terminal agents: name, project, checkout, cwd, machine, agent kind | |
| Projects | `#` | name, folder, machine | Enter switches context |
| Commands | `>` | every action of `lib/actions.ts` plus settings and themes | |
| Files | `/` | files of the current project (section 5) | also `mod+p` |
| Messages | `"` | title, last message (chats), last 8 pane rows (terminals) | caption: `Searches titles and recent output` (honest scope) |
| help | `?` | lists the modes above as rows | VS Code's `?` |

Chips are a `radiogroup` in the search bar (`searchPrefix`), `Tab` cycles them, typing a prefix selects the chip and removes the character, `Backspace` on an empty query clears the scope. Attribute filters as tokens, completed from data and shown as removable chips like Orca's host/project chips: `on:<machine>`, `in:<project>`, `is:needs|review|working|idle|chat|terminal|pinned|unread`. Chips clear when the palette closes (Orca).

### 3.2 Ranking (Rust, `native/core/src/search`)

1. **Match.** `nucleo-matcher` (fzf v2 scoring, Unicode-aware) on text folded by one shared `fold` (NFD, strip marks, `đ`, invisible characters, lowercase; same rules as `lib/text.ts`, ported with its test cases so `dinh` finds `Định`). Fields and weights per agent: name 1.0, project 0.6, checkout 0.5, cwd basename 0.4, machine 0.4, agent kind 0.3, last message and preview 0.2 (word-prefix or substring only, never subsequence: long text matches everything by subsequence). Multi-token queries: every token must match some field (AND), the score is the sum.
2. **Typo tolerance.** Only if strict matching returns fewer than 3 hits and the token has >= 4 characters: Damerau-Levenshtein distance <= 1 on word tokens of names and aliases (`lnik`, `paymnets`); the row says nothing, no "did you mean".
3. **Synonyms.** `keywords` (exist) plus `verbs`: natural phrases per command (`new session`, `start agent`, `split`, `review`, `mark done`, `pin`). Shown as `Title (alias)` when the alias won, so our wording is taught (Superhuman).
4. **Frecency** per `(kind, id)`: samples of the last 10 visits; `frec = (visits / samples) * sum(2^(-age_days / H))`, H = 7 d for agents and projects, 14 d files, 21 d commands (Firefox's shape, [docs](https://firefox-source-docs.mozilla.org/browser/urlbar/ranking.html)); `boost = 1 + 0.6 * tanh(frec / 3)` so a good match always beats a frequent bad one. Plus a learned query affinity: when a prefix of the query led to a pick, that id gets `+0.2` for it (Raycast learns search terms); `Reset ranking` is an action-panel entry. All constants are starting values, tuned by golden tests, not measured.
5. **Context.** Focused tab's project `x1.2`, same machine `x1.05`, exact name prefix as a tiebreak, `disabled` commands rank last but stay visible with the reason in the footer (existing behaviour: the person learns they exist).
6. **No jumping.** `Herdr.searchOpen` captures an immutable board snapshot, a frecency copy and the command list; every `search` of that session ranks against them. Live changes (an agent turns `Needs you`) update row *content* in place (the glyph, the age) through the revision tick, never the order or membership while the palette is open (Orca freezes the same way). On the **empty query** the order is state-aware: this is where needs-you comes first.

### 3.3 Empty state, row, footer

Empty query (the Switcher is this list, smaller): `Needs you` (at most 3 rows, the same rows as the inbox, omitted when none), `Pinned`, `Recent` (6 agents by MRU, the current one omitted unless it needs you or has unread), `Projects` (3 recent), `Suggested` (3 commands from context and frecency; `Next agent that needs you` whenever something does), then one quiet `Tip` row (3.6). Digits `1-6` are keycaps on the first rows.

Row anatomy, calm (principle 1, "said once per agent per view"): `[StatusGlyph | Monogram | file icon] Name  project · checkout · machine ... age  [keycap]`. Name `font-medium`; the rest `muted-foreground`, joined by ` · `; machine omitted with one machine, project omitted inside `in:` scope or when it equals the focused one; the state word appears once, as the glyph plus a muted word, in `signal` colour only for `Needs you`. Chat or terminal is a word only when it is not the default view. The keycap is the command's shortcut, the row index, or `↵` on the highlighted row.

`label` (what screen readers say) is the whole sentence, because `Command` announces only `item.label` (`command.rs:742-756`): `payments api, Claude chat, needs you, payments, gpu-box, 4 minutes ago, 3 new messages`. The drawn row comes from `renderItem`, which gets only `CommandEntry` (id, label, group, shortcut, state flags) and "is made once per item": row content is read from a TSX `Map<id, SearchHit>` through accessors, so a live state change repaints in place.

**Footer = preview** (`footer` slot, one reserved line, no layout shift, updated on `onHighlightChange`): agent: last line of the pane or `lastMessage`; project: `3 agents · 1 needs you · /path`; file: full path; message: the matched line with the match; disabled command: why. A side preview pane was rejected: `Command` is one list, and a second pane is the opposite of "quiet".

### 3.4 Two-step commands, verbs, destructive

A command may declare `args: ArgKind[]` (`project`, `agent`, `machine`, `agentKind`, `file`, `text`). Choosing it moves to step 2 over that kind's candidates; the choice stays visible as a chip in the search bar (`New agent session › payments`), `Backspace` on an empty query removes it, `Escape` goes back one step. Natural phrases: the longest command phrase at the start of the query wins and the rest becomes the step-2 query (`new session pay` opens step 2 filtered to `pay`). Examples: `New agent session in…` (project, then agent kind from `Sessions.probe`), `Start a terminal agent in…`, `Move to project…`, `Open file…`. Destructive commands are never one keystroke: reversible ones (review, pin, close a tab set, forget a layout) run and show a `notify(..., { undo })` toast; irreversible ones (close pane or workspace in herdr, kill session, remove machine) go through `confirmDestructive` exactly as today. Nothing in the palette answers a permission or question: that stays in the answer dock (principle 2).

### 3.5 Action panel

`Command` has no per-row controls, so the panel is a second `Command` that replaces the results (title `Actions for <name>`, `Escape` returns with the same row highlighted). Actions per kind, each with its shortcut shown:

| Kind | Actions (first is `Enter`) |
|---|---|
| Agent | Open · Open to the side (`Shift+Enter`) · Open here (this context) · Show terminal / Show chat (`mod+Enter`) · Reply… (focus composer) · Mark reviewed (done only, undo) · Stop (sends `esc`, confirm) · Pin / Unpin · Rename… · Copy pane id / session id · Copy folder · Close pane in herdr… (confirm) · Kill session (owned only, confirm) |
| Project | Switch · New session here… · Pin / Unpin · Browse files · Copy folder · Close its tabs · Forget its saved layout |
| File | Open · Copy path · Insert path in the composer (`@path`) · Reveal |
| Message | Open at this message (chat tab scrolled to the item) · Copy |
| Machine | Reconnect · Edit… · Test connection |
| Command | Run · Reset ranking |

Disabled actions stay listed with a reason (the existing rule). Hover buttons and a right-click menu on rows stay as the pointer's route to the same list.

### 3.6 Teaching, no-result, privacy

- **Teach:** right keycaps (exist); after a command with a shortcut was run from the palette three times, the footer shows one `Tip: Ctrl+Shift+] goes to the next project` on later opens, at most 2 showings per shortcut, never announced, off in Settings. Mistyped prefixes get the `?` list.
- **No result:** `No match for “zzz”` plus rows (keyboard-reachable): `Search messages for “zzz”` (switch scope), `Search files for “zzz”` when a project is in focus, `New agent session…` with the text pre-filled (never sent), `Open path…` when the query looks like a path (`Files.find`). Mirrors Orca's Create row.
- **Privacy:** history is local (`<dataDir>/recents.json`, 0600, atomic): ids, counts, timestamps, and typed query prefixes that led to a pick (40 characters, last 200). Never pane contents, last messages or previews: those exist in memory only while the palette is open. Settings > Privacy: `Clear palette history` (everything but pins), `Remember searches` off (no query prefixes). Drafts: section 4.

## 4. Per-project layouts: persistence and swap

| Data | Where | Shape | Size and limits |
|---|---|---|---|
| Layouts | TSX `Storage` `herdr.dock.v2` | `{ v: 2, current: "home" or projectKey, home: Layout, contexts: { [projectKey]: { layout, focused, savedAt } } }` (center only, as `readLayout` does) | ~0.5 KB per context, cap 60 (LRU), pruned when the project is gone 30 days; written after the 500 ms quiet period like today |
| View state | `herdr.views.v1` | `{ [panelKey]: { scroll?: { atEnd: boolean, item?: number, offset?: number } } }`, and drafts only if the setting is on | scroll only a few bytes; drafts cap 32 x 64 KB |
| Drafts | memory always; disk only with `Remember unsent messages` (off: drafts can hold pasted secrets) | `{ text, caret }` | survives context switches, not restarts by default |
| MRU, frecency, pins, seen counters | Rust `recents.json` | arrays of `{ kind, id, visits[10], count }` | ~100 B per item, 2,000 items cap 200 KB |

**Why the swap needs a store.** `DockArea` keeps a panel's signals, input text and scroll while its key stays in the layout, and drops it (`Unrender`) when "a layout that no longer lists it" is set (`.scratch/nsh-0.4.0/docs/dev/dock.md:66-77`). Swapping `layout` to another project's tabs therefore unmounts the old project's composers: drafts and scroll must live in `lib/view-state.ts`, which composers (`composer.tsx`, `session-composer.tsx`, today a local `signal("")`) and lists read and write. Rejected alternative: one `DockArea` per project, all mounted, the others `display: none`: exact state for free, but every hidden `PaneScreen` keeps watching at 20 Hz and every hidden chat holds one of the four keeper attachments per machine (`ARCHITECTURE.md` section 5); it would need pause and detach logic anyway, and it cannot restore after a restart.

**Swap mechanics (`lib/dock.ts`).** `contexts` replaces the single layout: `setLayout(next)` writes into `contexts[current]`; `switchContext(key)` saves the outgoing state, sets `layout` and `focused`, calls `area.selectPanel`, calls `chosen(focused)` (the 150 ms `pin` race of `activated` applies), announces `payments api, 3 tabs, 1 needs you`, and starts the entrance (section 7). Panels of the outgoing context unmount and stop their `watchPane` (`onPanelRemove`); the incoming ones read the cached screen first (`Herdr.readPane` fills the cache), so the first row paints from cache. Chat tabs reattach from the keeper's replay.

**Migration v1 to v2 (clean cutover).** On first run after the board is non-empty: bucket every panel of `herdr.dock.v1` by `rowOf(rowKeyOf(panel))?.project`; known ones form that project's context, unknown ones (offline machine, vanished agent) stay in Home and are adopted when their row resolves (`adopt()` runs on each context switch); the old key is deleted after the v2 write succeeds. `readLayout` stays the parser for each layout (it already drops unknown and repeated panels).

## 5. Data and performance

**Where the index lives (D7).** Rust, in `native/core/src/search` behind `Herdr.search*` in `native/app/src/search.rs`. Reasons, in order: the JS engine is QuickJS (`docs/dev/architecture.md:6`), an interpreter, so 2,000 candidates x fold x fuzzy per keystroke has no safe 16 ms margin **(unmeasured; S5 measures the TSX baseline)**; the data (board, previews, transcripts) is already in Rust; frecency and pins are Rust-owned; sync module calls are allowed for pure reads (`ARCHITECTURE.md`: TSX pulls). Commands stay TSX-owned (they call TSX functions) and are *registered* at open.

Budgets (inputs: 200 agents, 50 projects, 150 commands, 8 machines, 60 settings, 2,500 text blobs; a 5,000-item stress set):

| Measure | Budget | How measured |
|---|---|---|
| keystroke to rows committed | < 16 ms p95 for 2,000 candidates (Rust < 4 ms, marshal < 4 ms, commit < 8 ms) | `cargo bench` for Rust; `.perf` scenario `palette typing 2000` for the rest |
| palette open to first paint | < 50 ms | `lib/perf.ts` `timing("palette open")` |
| project switch to first painted row | < 120 ms (swap commit < 50 ms) | `.perf` scenario `switch project x20` |
| `mod+p` first results | < 150 ms warm, < 1.5 s cold index of 100,000 paths | S6 |
| idle | 0 frames, ~0% CPU with the palette closed | `scripts/cpu.mjs` |

**API (TS, generated into `native.d.ts`):**

```ts
type Scope = "all" | "agents" | "projects" | "commands" | "files" | "messages";
interface CommandSpec { id: string; label: string; group: string; keywords: string[]; verbs: string[]; shortcut?: string; disabled?: string | boolean; checked?: boolean; args?: ArgKind[] }
interface SearchRequest { query: string; scope: Scope; limit: number; focus?: { rowKey?: string; project?: string; machine?: string } }
interface SearchHit { id: string; kind: "agent"|"project"|"command"|"machine"|"setting"|"theme"|"file"|"message";
  title: string; spoken: string; parts: string[]; marks: [number, number][]; state?: AgentState; unread?: number; view?: "chat"|"terminal"; shortcut?: string; disabled?: string }
interface SearchPage { hits: SearchHit[]; total: number; chips: { on?: string; in?: string; is?: string[] }; scope: Scope; tookUs: number }
Herdr.searchOpen(commands: CommandSpec[]): number            // freezes board, frecency, commands
Herdr.search(session: number, req: SearchRequest): SearchPage // sync, no signals touched
Herdr.searchClose(session: number): void
Herdr.noteVisit(kind: "agent" | "project", key: string): void
Herdr.noteRun(id: string, queryPrefix: string): void
Herdr.recent(kind: "agent" | "project", limit: number): string[]
Herdr.markSeen(rowKey: string): void; Herdr.pinAgent(rowKey: string, pinned: boolean): void
Herdr.resetRanking(id: string): void; Herdr.clearPaletteHistory(): void
Files.search(machine: string, root: string, query: string, limit: number): Promise<FileHit[]>   // async, cancellable
Files.cancelSearch(token: number): void
```

Rows beyond `limit` (default 50; 200 in single-scope browsing) show `N more: keep typing`; `Command` stays virtualized and with `filterable={false}` it indexes only what we pass (<= 200 labels), so its own O(n) lower-casing (`command.rs:221-255`) is negligible. nsh's own filter is **lowercase substring over label and keywords only** (`command.rs:237-286`): no folding, no fuzzy, so it is switched off.

**Files (D10).** `Files.find` already means "resolve this path", so the new call is `Files.search`. Rust `native/core/src/files/quick.rs`: *local*: the `ignore` crate (`.gitignore`, `.git/info/exclude`, global ignore, hidden files skipped except a short allow-list), walker on a worker thread, per-root index kept in memory, refreshed when the root is next asked after 60 s or after the focused pane's `pane_updated` bursts end; *remote*: one command added to `fs.py`, `tree ROOT LIMIT`, running `git -C ROOT ls-files -z --cached --others --exclude-standard` on the ControlMaster (non-git folder: bounded `os.walk` skipping `.git node_modules target dist .venv`), quoted with `shq`, with an injection test. Limits: 100,000 paths, 5 s walk, 8 MB of paths per root, 3 roots cached, results <= 50, index never persisted. Ranking: filename-first, path segments as tokens (`ui/pal` matches `components/palette.tsx`), recent files by frecency, gitignored files only as a second pass (Orca). The root is the focused tab's `checkout` or `cwd`; from Home, the `in:` chip or the most recent project; a file result opens through `viewFile` (the existing read-only viewer).

**Messages.** Cheap now: `title`, `lastMessage` (sessions), and the 8 `preview` rows (terminals), all already in Rust, matched by substring. Later (P6+): an in-memory inverted index over transcripts of attached sessions (`Sessions.items`, at most 4 per machine) and observed logs, built per revision; no on-disk transcript store without an explicit privacy decision.

**Tests.** Rust: matcher golden cases (fold, `dinh` and `Định`, transposition, camelCase, path segments), ranking goldens on `fixtures/herdr/{mixed,big,storm}.json`, frecency with an injected clock, `benches/search.rs`. TSX: `palette.test.tsx` (prefix selects chip, `Tab` cycles, frozen order while a fixture pushes a state change, action panel, two-step with chip and `Backspace`, empty and no-result states, stale files result discarded), `dock.test.ts` (v1 to v2 migration, LRU cap, corrupt file), `App.test.tsx` presses every new shortcut as macOS, Windows, Linux, `shortcuts.test.ts` for the `ctrl+tab` exception, `pane-input.test.ts` for the released set. Perf scenarios as in the budget table.

## 6. Accessibility

- **Roles** (`Command`, `command.rs:1095-1215`): the list is a `listbox` labelled `Results`, rows `option` with the full sentence, group headers `header`, the search field labelled `Search agents, projects and commands`; focus stays in the field and the highlighted option is announced by `announce_for_accessibility(label)`, polite, **only when a screen reader is on and only the label**: hence the sentence label.
- **Announcements** (`announce`, polite on Linux, no assertive; `docs/ACCESSIBILITY.md`): count `12 results` 400 ms after the last keystroke (not per keystroke: the highlight announcement already follows each change), `No results. Tab searches messages`, `Scope: Agents, 14 results` on chip change, `Actions for payments api` on the panel, `Payments api, 3 tabs, 1 needs you` on a context switch. Never announce live state changes of rows while the palette is open.
- **Focus:** the palette returns focus to the opener on close (assert in `palette.test.tsx`); after a context switch focus goes to the restored focused tab, not the sidebar; `Escape` always leaves (no trap; `Tab` is scoped to chips inside the modal, as nsh's modal dialogs already trap Tab within themselves, `nsh-platform-linux/src/system.rs:967-1011`).
- **Reduced motion, large text:** all motion through `lib/motion.ts` with `reducedMotion()`; rows use `min-h`, never fixed height, so `fontScale()` 2.0 grows them; the keycap column drops first; width `min(640, window - 48)`; the 760 px layout shows the palette full width.
- **Chips and filters** have `accessibilityState.selected` and names without role words; kinds are never colour-only.
- **Verified by `make a11y`** (new scenario `palette`: open, type, chip, action panel): roles listbox and option exist, every option and chip has a name, a focusable element exists. **Not verifiable by AT-SPI dumps:** what is spoken, ordering, interruptions. **Manual Orca checklist** (`docs/ACCESSIBILITY.md`, to add): open with `mod+k`, hear the field and scope; type `pay`, hear the count once and the first option; arrows read one option each, state included; `Tab` names the scope; `mod+k` on a row names the actions; `Escape` x2 returns to the previous tab; the Switcher reads position (`2 of 7`); a context switch announces the summary; with `fontScale` 2.0 nothing is clipped. Unverified until run.

## 7. Motion

Existing law: `design/motion.md` says screen and tab switches never animate (keyboard repeated all day). This spec keeps it for tabs and adds one deliberate exception, because a project switch changes the whole working set and orientation is worth 120 ms:

| Thing | Motion | Rule |
|---|---|---|
| Palette and Switcher open/close | `enterScale()` (0.97 to 1, 220 ms, `EASE_OUT`); closing is instant | nothing with `reducedMotion()` |
| Results appearing | none (rows appear at once; typing is the interaction) | |
| Chip change | selected fill eases 150 ms (`hoverTransition()`) | |
| Action panel / argument step | none (it replaces the list; the title changes) | focus order explains it |
| Project switch | incoming workspace area opacity 0.88 to 1, 120 ms, `EASE_OUT`; **no fade-out** (never a delay); skipped when a second switch comes within 400 ms (key held) and under `reducedMotion()` | never touches `PaneScreen` rows; only the area's wrapper (S3 checks it costs no extra relayout) |
| Tab switch inside a context | none (unchanged) | |

`design/motion.md` and its table change in the same change (a new `contextEnter` value in `lib/motion.ts`, one row under "What animates", the exception named under "What never animates"). DesignPass owns that file today: coordinate before editing.

## 8. Phased plan

| Phase | Size | Builds | Files | Acceptance |
|---|---|---|---|---|
| **P0 spikes** | S, 1 d | S1 real `ctrl+tab` delivery on a display and whether any release hook exists; S2 `Command` with `filterable={false}`, `renderItem` reading accessors, chips in `searchPrefix`, `footer`; S3 layout swap cost, hidden-tab unmount, wrapper opacity; S4 `Tab`, `Shift+Enter`, `Right` bound `when: "always"` inside the kit `Modal`; S5 QuickJS time of fold+fuzzy over 2,000 strings (decides D7 with a number) and marshalling 50 `SearchHit`s; S6 `ignore` walk of 100k paths | `docs/ARCHITECTURE.md` (results), throwaway labs | each spike yields a recorded number or a fallback; D7 confirmed or reversed |
| **P1 switcher, MRU, history** | M, 3-4 d | `recents.json` store, `noteVisit/recent`, `lib/nav.ts`, `ctrl+tab` pair, `mod+e` Switcher (palette in `Recent` scope), `mod+[ ]`, capture release rule | `native/core/src/store/recents.rs`, `native/app/src/search.rs` (recent only), `lib/shortcuts.ts`, `lib/actions.ts`, `lib/pane-input.ts`, `components/capture-bar.tsx`, `components/palette.tsx`, `App.test.tsx`, `shortcuts.test.ts` | `ctrl+tab` swaps two agents across projects in a test; history survives agent removal; capture mode forwards `ctrl+n/z/j/f/b/w/p/e` and still honours `mod+shift+k`, `mod+shift+p`; Switcher cycles with `mod+e`, commits with `Enter`, `Escape` returns |
| **P2 project contexts** | L, 6-8 d | dock v2 store and migration, `switchContext`, `lib/view-state.ts` (drafts, scroll anchor), sidebar project name switches, notification and inbox routing, project `renderEmpty`, entrance motion | `lib/dock.ts`, `lib/view-state.ts`, `components/workspace.tsx`, `components/sidebar.tsx`, `components/composer.tsx`, `components/session-composer.tsx`, `lib/open-agent.ts`, `App.tsx`, `lib/motion.ts`, `design/motion.md`, `design/board.md` | switch A to B to A returns identical layout, focused tab, draft text and chat scroll anchor; v1 migrates (fixture); project switch to first row < 120 ms in `.perf`; 20 switches leave RSS and watcher count flat (`Herdr.metrics()`) |
| **P3 palette v2** | L, 6-8 d | Rust search (`searchOpen/search/searchClose`), scopes, prefixes, chips, ranking, frecency, rows, footer preview, empty and no-result states, a11y wiring, new kit icons (`file`, `terminal`, `message`, `folder`) | `native/core/src/search/*`, `native/app/src/search.rs`, `components/palette.tsx`, `lib/palette/{state,rows,scopes}.ts`, `lib/actions.ts` (`CommandSpec`), `components/kit/icons`, `DESIGN.md` closed list, `.perf/scenarios.test.tsx` | keystroke budget met on the 2,000 and 5,000 sets; order does not change when a fixture flips a state while open; `dinh` finds `Định`; count announced once; `make a11y` `palette` scenario green |
| **P4 actions and two-step** | M, 3-4 d | action panel, `args`, verbs, undo and confirm wiring, tips | `lib/palette/hit-actions.ts`, `lib/actions.ts`, `components/palette.tsx`, `components/name-dialog.tsx` reuse | `new session pay` reaches step 2 filtered; `Backspace` removes the chip; destructive actions confirm, reversible show `Undo`; every action's shortcut is its `GLOBAL` key |
| **P5 file quick open** | M, 4-5 d | `Files.search`, local `ignore` index, remote `fs.py tree`, `mod+p` | `native/core/src/files/quick.rs`, `native/core/src/ssh/fs.py`, `native/app/src/files.rs`, `lib/files.ts`, `components/palette.tsx`, `native/core/tests/files.rs` | `ui/pal` finds `components/palette.tsx` locally and over the `localhost` ssh test; gitignored files only second; injection test passes; 100k-path budget measured |
| **P6 unread, pins, messages** | M, 3 d | `BoardRow.unread`, `markSeen`, `pinAgent`, message scope over title, last message, preview | `native/core/src/board/*`, `components/sidebar.tsx`, `components/workspace.tsx` (`TabFace`), `lib/herdr.ts` | an agent message while another tab is in front bolds name and tab, clears on focus; pin survives restart; message hit opens the tab |
| **Later** | L | transcript index (attached sessions), settings deep links, chip-addressable `is:unread` history | | needs the privacy decision |

Order by value: P1 is cheap and used all day; P2 is the architectural change and every later open-action depends on it, so it precedes the palette; P3 is large but purely additive; P4 follows because actions need rows; P5 and P6 are independent. **Risks:** P2 (hidden state we did not list: a tab with local signals other than composer and scroll loses them on swap: audit `PaneTab`, `SessionTab`, find bars; keeper attach churn on switch), P3 (QuickJS marshalling and `Command` row measurement with a footer, S2/S5), key delivery (S1), capture-mode change surprising current users (documented in the hint bar). **Measure:** keystroke latency p95, switch-to-first-row, RSS and watcher count after 20 switches, frecency hit rate (share of picks in the top 3 rows, local only, for tuning goldens, never sent anywhere).

**Implementation notes.** S4 also decides Escape layering: `Command` itself clears the query on the first Escape and reports `onCancel` on the next (`Command` doc in `nsh/base`), so stepping back out of the action panel or an argument step is bound by the app while that layer is open and must win over the field's own clearing. Every new TS file imports project code through the repository's subpath imports (`#lib/<file>`, `#components/<file>`, `#kit`), never `../`. `lib/shortcuts.ts` stays the one place for keys, `components/palette.tsx` stays the one palette (principle 6): the Switcher, `mod+p` and the action panel are views of it, never new components.

**Folded in from the landscape research** (`agent-orchestration-landscape.md`, read after the first draft): (1) Competitors converge on `Next chat needing attention` (Codex `Cmd/Ctrl+Alt+A`, Conductor next-workspace; Orca still asks for it, #12577): `mod+j` is ahead, and `Next agent that needs you` / `Previous…` are also palette rows under `Suggested` whenever something needs the person. (2) Empty-query order is frozen at open (Orca; cmux users complain when order follows the latest notification and breaks position shortcuts, HN 47091352): already D7. Needs-you first on the empty query matches Codex Pet and Orca. (3) Default scope with an empty query is the Switcher list (Xum opens as a workspace switcher, `>` for commands; Warp uses prefixes): already the empty state. (4) Digit keys: `mod+1..6` pick a row only while the palette is open and the query is empty (Orca and Codex use 1-6); the dock's `mod+shift+1..9` tab keys and the answer dock's `1..9` are never touched, and the palette never answers an approval (Enter and Esc belong to the answer dock). (5) No-result `Create` row: besides `New agent session…`, offer `New worktree…` once worktree create exists (landscape recommendation 4; herdr has `worktree.create/list/open/remove`). (6) Upstream `herdr-app` commands take named arguments and its palette shows every key: supports D9. Candidate later verbs, none in P1-P6: `Peek` (open over the tab, keep or discard) and `Put away` (leave lists until it needs you; an app-side mark like `Reviewed`, since `tab.settle` is not in protocol 22). (7) If the palette ever sends text (`Send now` versus `Queue`), name them literally and show the key; Cursor and Devin have opposite defaults, so no default is implied. (8) The index is built from the Rust `Snapshot` model, not from protocol-22 JSON, so a second `herdr-core` backend (landscape open question 1) would feed the same index. Conductor's `⌘⇧H` Home in section 1 comes from a changelog snippet and is not re-checked.

**P0 results (run on nsh 0.4.0, GTK 4.22, Xvfb + cairo; real X key events through XTEST, the pattern of `scripts/atspi_audit.py`).** Owner decisions applied before the spikes: D6 releases plain Ctrl chords to the pane while capturing, drafts live in memory only, build order P0, P1, P2, then P3.

| Spike | Result | What held, what changed |
|---|---|---|
| S1 `ctrl+tab` | **Delivered and bindable.** A lab binding `ctrl+tab`, `ctrl+shift+tab`, `ctrl+e`, `ctrl+[`, `ctrl+]`, `ctrl+shift+[`, `ctrl+shift+]`, `ctrl+\`, `ctrl+/`, `ctrl+p` with `when: "always"` counted all ten key presses with a text field focused; in the whole app `ctrl+tab` swapped two agent tabs with the message box focused. No key-release hook exists (as read). | Held. Changed: `ctrl+tab` and `ctrl+shift+tab` carry `always` in `GLOBAL` (the keymap counts Tab among the keys a text field uses, `edits_text`), so the spec's fallback `mod+e` / `mod+[` was not needed. |
| S3 swap cost | Headless `nsh test --trace`, a `DockArea` with 6 panels (an `Input` and a 300-row `List` each) whose `layout` signal is replaced by another 6 keys: **one commit of 6.4-6.7 ms (1,152 ops, 1,204 mount items) plus 5 follow-up commits of 0.8-1.1 ms** (list rows), about 12 ms in all; the first mount of the same area was 7.4 ms. Draft typed into panel `a1`: **kept across tab switches in its group, lost after A to B to A (empty)**. | Held: unmounting loses drafts and scroll, so `lib/view-state.ts` is needed. The real app's swap is measured in P2 (section "P2 results" below). |
| S4 bindings in the modal | With the kit `Modal` open, `ctrl+e`, `ctrl+shift+e`, `tab`, `shift+enter`, `ctrl+shift+tab` bound `when: "always"` inside it all fired under real GTK and headless; `Escape` closes it, also with a chat tab behind it. A key bound by the component that mounted (`<If when={open}>`) is released with it. | Held. Found: a `Command` with `searchable={false}` is one tab stop that did **not** take the keyboard (`Enter` picked nothing), so the Switcher keeps the search field (a filter) and `filterable={false}`; `Enter` picks under real GTK, but the **headless harness delivers neither `Enter` nor `Escape` to a dialog opened over a focused tab** until a field is focused (tests focus the filter first, as the person's first keystroke does). |
| S2, S5, S6 | Not run: they belong to P3 (palette v2). | |


## 9. Mockups (80 columns)

Glyphs: `(!)` needs you, `(~)` working, `(v)` done, `(o)` idle, `[P]` project monogram, `"` message hit. Real rows use `StatusGlyph` shapes, not these letters.

**Default, empty query**
```
+------------------------------------------------------------------------+
| Search agents, projects and commands          [All][@][#][>][/]["]    |
|------------------------------------------------------------------------|
| NEEDS YOU                                                              |
| (!) payments api         payments · gpu-box                    3m   1  |
| Recent                                                                 |
| (~) refactor ledger      payments · gpu-box                    now  2  |
| (v) upgrade deps         infra · this computer                 12m  3  |
| (o) docs pass            site                                  2h   4  |
| Projects                                                               |
| [P] payments             1 needs you                                   |
| Suggested                                                              |
|     New agent session in…                                  Ctrl+N      |
|------------------------------------------------------------------------|
| Last: "Which migration should I run first?"       Tip: Ctrl+E switches |
+------------------------------------------------------------------------+
```
**Typing `pay` (All): one ranked list, no headers**
```
| pay                                            [All][@][#][>][/]["]    |
| (!) payments api         payments · gpu-box                    3m      |
| [P] payments             3 agents                                      |
| (v) pay-gateway tests    infra · this computer                 12m     |
| [P] pay-sdk              infra · gpu-box (pinned)                              |
| "  …retry the payments job…   refactor ledger · message                |
|------------------------------------------------------------------------|
| payments api · /srv/payments/api · "Which migration should I run first?"|
```
**Action panel (`mod+k` on a row)**
```
| Actions for payments api                                      Esc back |
| Open                                                              ↵   |
| Open to the side                                              Shift+↵ |
| Open here (Infra)                                                      |
| Show terminal                                                 Ctrl+↵  |
| Reply…                                                                 |
| Pin                                                                    |
| Copy folder                                                            |
| Close pane in herdr…                                    asks to confirm|
```
**Two-step command (`new session pay`)**
```
| [New agent session ›] [payments ›] pick an agent         Backspace undo |
| omp                      on gpu-box                                    |
| Claude Code              on gpu-box                                    |
| Codex                    not installed on gpu-box          (disabled)  |
|------------------------------------------------------------------------|
| Starts a chat in /srv/payments, nothing is sent until you type.        |
```
**Switcher (`mod+e`)**
```
|  Switch to…                                      Enter open · Esc back |
|  (~) refactor ledger      payments                   now    1  (here)  |
| >(!) payments api         payments                   3m     2          |
|  (v) upgrade deps         infra                      12m    3          |
|  [P] infra                project                    1h     4          |
```

## 10. Open questions for the owner

1. **Can a tab live outside its agent's project?** Recommended: only through the explicit `Open here` action; default routing sends every open to the agent's project context (keeps "return exactly as left" true). Alternative: free mixing, simpler code, weaker guarantee.
2. **May a project switch animate (incoming opacity, 120 ms) although `design/motion.md` forbids tab and screen switch animation?** Recommended: yes, as the single documented exception; the reduced-motion and repeat guards apply.
3. **Capture mode: release plain `Ctrl+letter` shortcuts to the pane (palette moves to `mod+shift+p` while capturing)?** Recommended: yes; it fixes today's theft of Ctrl+K N Z F J B W and keeps the escape hatches.
4. **Persist unsent drafts across restarts?** Recommended: no by default (a draft can hold a pasted secret), kept in memory across switches always, one Settings switch to remember them.
5. **`ctrl+tab` as a tap (previous agent) now, and ask nsh upstream for a key-release event so it can become hold-to-cycle later?** Recommended: yes; the Switcher on `mod+e` covers deep cycling meanwhile.
6. **Transcript content search: titles, last message and 8 pane rows only (v1), or an index of conversation content?** Per [agent-orchestration-landscape.md](agent-orchestration-landscape.md) (its sources, not re-fetched here) Cursor (`Cmd+K`, local index), Devin Desktop (`Cmd+K`), JetBrains Air (`Ctrl+F`, archived sessions too) and cmux (`⌘⌥F`) search content; users will expect it. Recommended: ship the cheap scope now with the UI saying exactly what it searches, then an **in-memory** index of attached sessions and observed logs (no disk); an on-disk index only after the owner accepts storing transcript text (opt-in setting, 0600 file, one `Clear` button, never synced).
