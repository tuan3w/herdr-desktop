# Chat craft: code that reads well, and a chat worth living in

Status: decision-ready spec, written 2026-11-07 by the ChatCraft task. Nothing here is wired into the chat yet (`components/session-*.tsx`, `markdown.tsx`, `lib/session*.ts` are untouched).

**Not finished, so nobody assumes it is:** (a) `CodeBlock` takes `open` as an initial value only (needs `open`/`onOpenChange` for the model-held fold state, 1.7); (b) no `lib/markdown-fences.ts` yet; (c) the code options live in `lib/highlight.ts`, not `lib/settings.ts`, and have no Settings rows; (d) no `design/code.md` (draft in 3.3), no `NOTICE` lines for tree-sitter/syntect/two-face; (e) `Code.warm()` exists but nothing calls it; (f) no `.perf/chat.test.tsx`; (g) 760 and 960 px screenshots of the code labs were not taken (1280 only, light and dark); (h) split-diff hunk rows of a patch are drawn in unified form only; (i) every Part 2 item is a decision, none is built. Part 1 (code) is built and proven in labs, tests and screenshots; Part 2 (chat) is research plus decisions with acceptance tests, to be built after the owner's GO. Sources carry their access date (all 2026-11-07); `[unverified]` marks what no primary source or run confirmed. Raw research notes (not committed): `.scratch/chatcraft/research-*.md`, `chat-inventory.md`.

The owner's direction: the chat tab is where people spend their time; it should be mindful and polished, in the spirit of Linear. Our reading of that is one sentence: **a chat that is fast before it is pretty, quiet before it is clever, and never makes the person wonder what the agent is doing.**

## 0. Decisions at a glance

| # | Decision | Section |
|---|---|---|
| D1 | One code renderer in Rust (`CodeView`, `CodeDiff`) behind TSX `CodeBlock`/`DiffBlock`; nsh's `TextView` code block, `Editor` and `DiffView` stay for the file viewer and a future review pane | 1.2, 1.5 |
| D2 | Highlighting: tree-sitter with our queries for 25 languages, syntect (TextMate, already in the binary) for the long tail, plain for the rest; 39 token roles, closed list | 1.2 |
| D3 | Code colours are first-class theme tokens (`code-*`), OKLCH, every role at least 4.5:1 on every surface it can sit on (punctuation 3:1), tested | 1.3 |
| D4 | IBM Plex Mono stays; ligatures stay off (JetBrains Mono and Geist Mono turn `=>` into `⇒` here) | 1.4 |
| D5 | Fences are split out of the Markdown by us (stable keyed `CodeBlock` per fence, `streaming` only on the open one), not routed through `renderCodeBlock` | 1.7 |
| D6 | The chat keeps one reading lane (`COLUMN.chat`), turns anchor at the person's message while a long reply streams, three scroll states | 2.3 |
| D7 | Message actions: copy, copy as Markdown, retry, edit and resend as an explicit fork; no bookmarks yet | 2.4 |
| D8 | Keyboard: ten chat commands, every one with `mod`, none with `alt`, all in the shortcut list | 2.5 |
| D9 | The composer remembers: per-session draft, per-folder history, Up recalls, paste image through a file | 2.6 |
| D10 | Review is read-only in the transcript (`DiffBlock`); accept/reject per hunk is a separate pane, later, on nsh `DiffView` | 2.7 |
| D11 | No sound, no streaming animation; motion only where it explains a change, 150 ms out | 2.12 |

# Part 1: Code

## 1.1 What the host does today, and why it looks poor

Read from `.scratch/nsh-0.4.0/crates/nsh-base/src/{syntax.rs,text_view/highlight.rs,editor/highlight.rs}` and seen in screenshots of the same Rust and TypeScript samples in `TextView`, `Editor` and `DiffView`, light and dark (`code-compare-*`, `code-host-diff`):

- **Engine:** syntect 5 with pure-Rust regexes (`regex-fancy`, not Oniguruma, so `Send` is no problem) and two-face's bat grammars. Good coverage, and slow: nsh's own docs measure 139 ms for a fresh 500-line TSX block; here two-face costs 274 ms (TSX), 519 ms (TS), 176 ms (Python) for 2,000 lines.
- **Eight colours.** TextMate scopes map to a `Token` enum of eight kinds (comment, keyword, string, number, title, attr, built, deletion) plus bold/italic (`syntax.rs:20-50`), in one fixed "Allsum" palette, not the theme's.
- **No semantic distinctions:** function definition, call and method all `title`; parameters, properties, keys and `self` all `attr`; numbers, booleans, `null`, constants all `number`; escapes and regexps are `string`; template-substitution braces, decorators, JSX tags (`built`, the same colour as builtin types), doc comments and `TODO` do not exist; punctuation and operators are never dimmed.
- **Contrast:** the palette's dark comment `#7d7a72` is 3.98:1 on `#1c1c1c` and 4.4:1 on our code surface; the light comment `#6e7781` is 4.2:1 on our surface. A comment is the one thing people must read.
- **First paint plain:** a block is highlighted on a blocking thread unless it is cheap, so a TS or Rust block shows uncoloured for a frame to a second (screenshot at 0.9 s: `TextView` TS block still plain).
- **No gutter, no marks, no folding, no fade, no word marks in `TextView`;** `DiffView` has word marks, folds and hunk accept/revert (good, kept for later) but uses the same eight colours.
- The route that exists for an app's own colours is a Rust `CodeHighlighter` for `TextView` (`text_view/view.rs:320`) and `EditorHighlighter` for the editor: both stay on the eight `Token` kinds or on per-decoration styles. Not enough for 39 roles on every surface.

## 1.2 The pipeline, and why

```
fence word / path / shebang / sniff ──> Syntax::resolve ──> Tree(Lang) | Text(name) | Plain
                                                            │            │
                                  tree-sitter + our query ──┘            └── syntect (two-face)
                                  parse reuse + changed ranges               checkpoints every 8 lines
                                          └──> spans of Role (39) ──> lines (tabs, marks) ──> CodeView rows
```

Code: `native/app/src/highlight/engine/` (no widget in it) and `.../view/` (the components). `Highlighter::update(text)` takes a growing or edited text and returns all spans plus the dirty byte range; spans before it are the same values as before.

**Bake-off** (24 synthetic samples, one per language, 2,000-line blocks made by repeating each, release build, this machine; `cargo test --release engines|bake_off -- --ignored --nocapture` in `highlight/engine/tests.rs`):

| | tree-sitter + our queries | TextMate (two-face) |
|---|---|---|
| Semantic distinctions found (22 roles that matter, sum over 24 languages) | **313** | 234 |
| 2,000 lines: median / worst | 11 ms / 29 ms (Swift; Kotlin 26) | 80 ms / 519 ms (TS) |
| TSX, TS, Python, Rust, Swift, Kotlin | 11, 15, 15, 9, 29, 42 ms | 274, 519, 176, 94, 95, 52 ms |
| Swift distinctions | 17 / 22 | 6 / 22 |
| Append one line to 2,000 | 0.1 to 2.3 ms (YAML 6, HTML 7, Markdown 22: whole-text repaint for injections) | whole block from last checkpoint |
| First block of a language (grammar + query compile) | 0 to 66 ms, Cpp 94, Ruby 91, Swift 261 | 25 ms load once + 1 to 5 ms |
| Size added to the binary, 26 grammars | **+27.7 MB raw, +3.0 MB gzip** (core 0.05 MB; the 9 grammars of web work 6.3 MB) | 3.2 MB, already linked by nsh-base (same `two-face =0.4.5`: one copy) |
| Build | 0.2 to 3.8 s per grammar, about 33 s serial, about 5 s on 20 cores, cached after | none |

Decision (hybrid, option c): tree-sitter for the 25 languages in `Lang` (TypeScript, TSX, JavaScript, Rust, Python, Go, Java, Kotlin, C, C++, Swift, Ruby, PHP, bash, SQL, JSON, YAML, TOML, HTML, CSS, Markdown, Lua, Zig, Dart, diff), TextMate for the rest (Dockerfile, Elixir, Haskell, C#, Scala, R, Terraform, ...: `Syntax::Text`), plain for unknown words and `text`. Dockerfile is TextMate because the only grammar crate is built on tree-sitter 0.20 and cannot share our core. Cost to revisit: dropping Swift, Kotlin, C++ saves 11 MB and moves those three to TextMate (Swift loses 11 of 17 distinctions).

Queries are ours, per language, in `highlight/engine/queries/*.scm`, over the grammar crate's stock query or replacing it (`;; replace`). They distinguish: function definition, call and method call; types and builtin types; constants, numbers; properties, parameters, `self`; namespaces; decorators and annotations whole (`#[derive(..)]`, `@Injectable(..)`); control flow, keywords, modifiers as three roles; template and interpolation delimiters; JSX tags, components and attributes; regex literals. Comments, doc comments, `TODO` markers and string escapes are found in Rust from the text of the captured node (`post.rs`), so every language gets them. Markdown injects fenced code (the language of its info string) and parses inline emphasis, links and code per paragraph; HTML injects `<script>` and `<style>`.

**Language detection** (`Lang::detect`): the fence's first word (`rust,no_run`, `{.python .numberLines}`, `language-go`, `ts title="a.ts"`), else the file name or extension (`Dockerfile`, `Cargo.lock`), else a shebang, else a cheap sniff that only fires on near-certain shapes (diff header, JSON document, `<?php`, `<!doctype html>`, `$ ` prompt, `FROM`+`RUN`, a Rust `fn main`, a Go `package`+`func`, `def x():`), because a wrong guess colours prose. `text`, `plain`, `output`, `log` mean "do not colour".

**Streaming** (the open fence of a reply): `Highlighter` keeps the last tree and edits it from the common prefix and suffix of the old and new text, reparses incrementally, and repaints only the changed ranges widened to whole lines. Proven by tests: streaming every sample in steps of 1, 7, 61 and 400 bytes ends with exactly the spans of one full pass; an edit in the middle (a removed line, then restored) does too. Stability: of 1,300 appends of 23 bytes over all samples, 93 (7%) recolour something above the last three lines (a closing brace that turns an error-recovered declaration into a real one); the test bounds it at 8%. In the view, a text that grew keeps the spans of what it grew from (valid for the shared prefix, up to the last whole line), so new text is plain for at most one frame and old text never flashes. Small blocks with a loaded grammar (under 24 KB) are highlighted on the engine thread in under a millisecond; everything else on a blocking thread, results applied only if no newer text arrived. `Code.warm()` (call once when the first chat opens) compiles the thirteen most common grammars and loads the TextMate set on a background thread.

## 1.3 The colour system (`lib/theme/code.ts`, tokens `code-*`)

Research (`.scratch/chatcraft/research-code-themes.md`: GitHub Primer, Catppuccin, Rosé Pine, One, Zed One, Solarized, Tokyo Night, Xcode, Geist; WCAG computed on each theme's own code background) found: comments are the most failed role (One 2.3 to 2.5, Solarized 2.5 to 2.8, Tokyo Night 2.4, Zed One 2.3); light ports of Catppuccin Latte, Rosé Dawn, One Light, Solarized and Tokyo Night Day fail 4.5:1 on 12 to 21 of about 22 roles; GitHub light, Xcode and Geist have none. Tonsky (2025-10-15), Healey (1996: five to seven colours search in parallel) and the diff study (GitHub's add and delete tints are near-isoluminant, luminance ratio 1.03 to 1.17) give the rules we adopted:

1. **Ink budget.** Seven hue families (violet, blue, teal, green, orange, red, plus the theme's ink), not a rainbow. Identifiers stay in the text colour; a role that is not rare gets a tone of its family (lightness and chroma, which survive colour blindness), not a hue.
2. **Colour what is rare:** strings, numbers, types, definitions, tags. Keywords are quiet violet; control flow is a deeper violet (the loudest of the three); modifiers a greyer one. Function definitions are blue and medium weight (a second channel next to colour); calls are a quieter blue; method calls a quieter blue turned toward violet.
3. **Contrast is a gate, not a goal:** `legible()` moves a role's lightness until it reaches 4.7:1 on every surface it can sit on (block, marked line, added and removed lines, hunk row, changed word over its line); `code-theme.test.ts` fails under 4.5 (punctuation 3), lists the pair and the ratio.
4. **Never recolour token text on a diff row;** tints are light (dark: a mid colour at 14 to 27%, so the surface does not lift and cost every role its ratio) and the `+`/`−` column and a 2 pt bar carry the meaning (green and red tints are near-isoluminant).
5. **Weight is the second channel, italics off** (only Markdown emphasis): `function-def`, `heading`, `strong`, `todo` use the real Plex Mono Medium.

Per theme, hue shift and chroma scale: Harbor 0 and 1, Container −12 and 0.95, Chart +8 and 1.05, Graphite 0 and 0.5 (nearly monochrome). Light and dark per theme; surfaces are `code-bg` (a shade off the page: L 0.972 light, 0.175 dark), `code-line-bg`, `code-add-bg`, `code-add-word`, `code-remove-bg`, `code-remove-word`, `code-hunk-bg`, plus `code-gutter`, `code-whitespace`, `code-border`.

Harbor, hex and the lowest contrast over all seven surfaces (generated: `.scratch/chatcraft/pal.ts`):

| role | light | min | dark | min | role | light | min | dark | min |
|---|---|---|---|---|---|---|---|---|---|
| plain | #2f2e29 | 9.7 | #e6e4df | 8.2 | string | #196632 | 5.1 | #8fd89e | 6.2 |
| comment | #5f5c55 | 4.8 | #b3b0a7 | 4.8 | escape | #8f2e00 | 5.9 | #ffab6c | 5.6 |
| doc | #325454 | 5.9 | #bae0e0 | 7.3 | regexp | #88375f | 5.5 | #f99dc6 | 5.3 |
| keyword | #724a9b | 4.7 | #c79ef6 | 4.7 | number | #884300 | 5.3 | #feb073 | 5.8 |
| control | #413299 | 7.0 | #c3c2ff | 6.2 | constant | #8f382d | 5.4 | #ffa08f | 5.3 |
| modifier | #6e527a | 4.7 | #c2a4d0 | 4.7 | property | #344f6d | 6.0 | #a2c1e4 | 5.6 |
| punctuation | #767471 | 3.3 | #91908c | 3.2 | parameter | #38495d | 6.6 | #b8cde5 | 6.4 |
| function-def | #005099 | 5.8 | #77c2ff | 5.4 | tag | #005e8d | 5.1 | #66caff | 5.7 |
| function | #3a5a7e | 5.1 | #a4c8f1 | 6.0 | decorator | #745914 | 4.7 | #d1b473 | 5.2 |
| type | #006768 | 4.8 | #57d4d4 | 5.8 | diff-add | #03642b | 5.3 | #8fe1a1 | 6.6 |
| type-builtin | #1f6761 | 4.7 | #82c6bf | 5.3 | diff-remove | #9a282f | 5.5 | #ff9a98 | 5.1 |

Files touched: new `lib/theme/code.ts`, `lib/theme/code-theme.test.ts` (33 tests: every role on every surface in 4 themes and 2 appearances, line numbers, whitespace, ten pairs that must differ by ΔOKLab at least 0.03 (0.025 in Graphite), block never equal to the page); `lib/theme/build.ts` (import and two spreads of `codeTokens`); `theme.json` regenerated with `bun scripts/gen-theme.mjs` (that run also picked up a pending `term-15` change from `terminal.ts`). `nsh` classes cannot name custom tokens (`bg-code-bg` is an unknown class), so TSX uses `token("code-bg")` in `style`; Rust reads `theme().color("code-…")` as both-appearance colours, so a theme or appearance switch restyles without highlighting again.

## 1.4 Font: IBM Plex Mono stays, ligatures stay off

Screenshot of one block in three fonts (candidates downloaded from the OFL repos, temporary, deleted): **JetBrains Mono and Geist Mono ligate by default under nsh/GTK** (`=>` → `⇒`, `!==` → `≢`, `->` → `→`, `<=` → `⩽`, `|>` → `▷`), and Geist Mono also breaks the monospace grid (`0n≢= 0n` collides). Agents print `!=`, `=>`, `->` that a reviewer must read as typed. IBM Plex Mono shows every operator as the characters it is, has distinct `0O`, `1lI`, is OFL, already ships (135 KB TTF; a Latin subset is 41 KB, worth doing when the font files are next touched). Sizes of the others (regular, TTF): JetBrains 270 KB (Fontsource Latin subset 58 KB, an NL no-ligature build exists), Geist Mono 149 KB, Commit Mono 275 KB, Lilex 55 KB subset; Berkeley Mono is commercial and cannot be bundled. Code is 13 pt (`text-xs`) in 20 pt lines (ratio 1.55 rounded), tab size 4, ligatures off, `Code font` offered in Settings later.

## 1.5 Rendering: why native, what it does

`TextView` code blocks, `Editor` and `DiffView` cannot reach the quality (1.1), and `Text` spans built in TSX would mean one mounted row per line and every streamed chunk crossing the JS boundary. So (modelled on `PaneScreen`): rows are Rust values with shared identity; a block that fits is a plain column, one that does not (or that follows its end) is a virtual list; a row binds to its position, not its index (found by the perf run: a recycled cell captured its first index and the list stopped at 85 of 3,000 rows; `components/code-block.test.tsx` now scrolls the whole block).

`CodeBlock` (TSX, `components/code-block.tsx`) around native `CodeView`:

- Quiet surface one shade off the page (`code-bg`), 8 pt radius, language in the corner (`TypeScript`, or `title`: a file name); on hover or keyboard focus, three 28 pt text tools appear over the corner: `Wrap`, `Lines`, `Copy` (they stay in the accessibility tree and pressable; `Copy` becomes `Copied` with a check for 1.6 s and announces politely).
- Line numbers optional (muted gutter, not selectable), `file:line` marks (`marks="12"`, `3,7-9`: a faint tint of the line), tabs expanded to columns, `→` and `·` for tabs and trailing spaces on request, soft wrap or sideways scroll with 28 pt fades at the edges that appear only when there is more.
- Folds at 16 lines with a 48 pt fade and `Show all N lines` (open: scrolls inside itself at 560 pt, virtual above 150 rows); a streaming block never folds and follows its end; the finished block is a fresh view that starts at the top.
- Selection works across lines (nsh `select_text`); gutters and signs are `select_none`.
- Accessibility: the view is a group named `Code, TypeScript, 41 lines` (`codeLabel`) whose children are the text of each line; the tools are named by what they do (`Wrap lines`, `Line numbers`, `Copy code`, `Show all 41 lines`).
- `InlineCode` / `inlineCodeClasses`: a neutral chip (`bg-muted`, mono, `text-foreground`), never a colour.

`DiffBlock` (`components/diff-block.tsx`) around native `CodeDiff`: file in the corner with `+5 −10` as words, unified or side by side (`Split`), syntax-highlighted on both sides, a `+`/`−` column, a tint and a 2 pt bar on every changed line (three signals), changed words on a stronger tint (lines that changed almost entirely get none, as in `DiffView`), unchanged stretches folded (`7 unchanged lines`, a button), a `@@` row per hunk for patches, `Previous change`/`Next change` buttons (Tab, Enter) that step through change groups, wrapping, and say `Change 2 of 5`. Group label `Diff of src/reader.ts, 5 added, 10 removed`. Host `DiffView` is better at what we do not need yet (histogram diff, multi-file patches, hunk accept/revert, annotations): kept for the review pane (2.7).

Lab: `components/code-lab.tsx` through `code-lab-app.tsx` (an entry finds fonts only under its own folder). Scenarios `code-*` in `.shots/scenarios.ts` (21: every language sample one at a time, languages page, stream, diff, split, patch, long, compare with the host views, host diff, inline).

## 1.6 Measured, and not

| What | Result |
|---|---|
| Rust unit tests (`cargo test --lib highlight`, 22) | pass in debug and release: per-language sample coloured and well formed, 2,000 lines under budget, streamed = one pass in 4 step sizes, mid-edit = one pass, open constructs, escapes/TODO/doc, detection, TextMate fallback, diff rows, patch, split |
| Component tests (`components/code-block.test.tsx`, 9) | label, fold, copy, toggles, streaming never folds, diff counts and steps, fold opens, patch, 3,000 lines scroll past their first rows with fewer than 150 rows mounted |
| `bun scripts/perf.mjs .perf/code.test.tsx` (Xvfb, cairo, CPU-drawn, debug Rust) | 3,000-line block scrolled: frame p95 18.5 ms, js p95 1.1 ms, core p95 11 ms, 285 MB; at rest: 0 s drawn; stream at 20 updates/s: frame p95 6.9 ms, js 0.4 ms; split diff: frame p95 15 ms. The 8.3 ms frame budget is **not met under software rendering with an unoptimised build**; a GPU and release run is **unverified** |
| Screenshots looked at (light and dark) | TS, TSX, Rust, Python, Go, bash, SQL, YAML, HTML, CSS, Markdown, diff unified, split, patch, stream, long, compare with `TextView`/`Editor`/`DiffView` |
| Found by the work, fixed | a recycled list cell captured its first row index (the block stopped at 85 of 3,000 rows); `tree-sitter-kotlin-ng` loops for over a minute, deaf to a progress callback, on a property followed by a final line that is a lone `@` or `@Foo`: `session.rs` keeps that unfinished last line from Kotlin's parser (test `an_unfinished_annotation_does_not_hang_the_kotlin_grammar`); a slow parse is otherwise cut off after 400 ms (the view reads on the spot only within 8 ms) |
| Unverified | colour-blind simulation of the palette; screen-reader reading of a block under Orca; a real GPU frame time; the `make a11y` audit with the new group names; 760 and 960 px widths of the lab; Kotlin and Swift 2,000-line times are 26 and 29 ms on a quiet machine and over 40 ms under load (their guard budget is 45 ms); whether other grammars hang on unfinished text (only Kotlin was found by streaming every sample in four step sizes) |

## 1.7 Integration into the chat (for the GO step)

Call sites (from `.scratch/chatcraft/chat-inventory.md`, lines as of today; `session-item.tsx` is moving under DesignPass):

| Call site | Today | Change |
|---|---|---|
| `components/markdown.tsx:51-60` | `TextView` with nsh's default fence, no `renderCodeBlock`, no `classes` | Split the source by a top-level fence scanner (`lib/markdown-fences.ts`, new, tested): prose segments to `TextView`, each fence to `<CodeBlock code language streaming={open fence}>` keyed by fence index (stable identity: no remount per chunk, the native view follows the growing `code`). Fences nested in lists or quotes stay in `TextView` (nsh's block). Pass `classes={{ code: inlineCodeClasses }}`. Call `loadCodeSettings()` and `Code.warm()` once at chat open |
| `markdown.tsx` via `renderCodeBlock` (rejected) | the render function re-runs on every streamed chunk, builds a new holder, disposes the old: fold state, `Copied` and the native view reset per chunk; it gets `{language, meta, code}` with no closed flag | not used |
| `session-tool.tsx:97-108` `Mono` (command `:269`, input `:280`, output `:285`) | `bg-muted` box, `font-mono` `Text`, own copy button | `CodeBlock code language="bash" (command) / path-derived (input) / none (output) collapsedLines={0}`; keep `visibleText`; keep the `…N lines not kept…` splice; the model's `moreKey` fold stays outside (`open` becomes controlled: add `open`/`onOpenChange` props to `CodeBlock`) |
| `session-tool.tsx:111-148` `Edit` | `DiffView` in a fixed-height `border` box, label `Changes to <path>` | `DiffBlock path oldText newText`; labels in tests change to `Diff of <path>, …` |
| `permission-diff.tsx:36-47` | `DiffView` in `rows*20` box | `DiffBlock maxHeight={10*20}`, `context={2}` |
| `permission-dock.tsx:251-265` command box | `Scroll` + `onLayout`/`onScroll` gate the allow press ("read to the end first") | **keep**: the safety rule needs scroll and layout events `CodeView` does not expose |
| `permission-dock.tsx:325-329` `Read all` | mono `Text` in a `Modal` | `CodeBlock language="bash" collapsedLines={0}` |
| `session-signin.tsx:114-118` | `bg-muted` box with `shellLine` | `CodeBlock language="bash"` (drop the extra `Copy command`, keep one) |
| `file-viewer.tsx:69-83`, `mermaid-block.tsx`, one-line mono `Text`s, `PaneScreen` | `Editor`, web view, labels | unchanged |

Rules the integration must keep: command shown whole and `visibleText`-cleaned before it reaches a block (agent Markdown today never goes through `visibleText`, `session-item.tsx:103`: clean fence text too); pinned accessible names (`Copy command` becomes `Copy code`: update `session-tab.test.tsx:155,160`); nothing in a recycled list cell keeps state in a signal (fold state to `model.choices`); `autoscrollToBottomThreshold: 64` unsticks when a block appears 560 pt tall at once: raise it to 640 or re-anchor after a row grows; `chat-swap` and `chat-long` scenarios are the guards for native views created and destroyed in recycled cells.

Settings (`lib/settings.ts` is the rule, today `lib/highlight.ts` holds `codeWrap`, `codeLineNumbers`, `codeWhitespace`, `diffSplit` under its own key `herdr.code.v1`): move them beside `paneFit` at integration, add rows in Settings > Look (`Wrap code`, `Line numbers in code`, `Show tabs and spaces`, `Diffs side by side`). Docs to add with it: `design/code.md` (draft below in 3.3), a line in `design/chat.md` for fences, `NOTICE` for tree-sitter (MIT), syntect and two-face (MIT/Apache-2.0).

# Part 2: The chat

## 2.1 What the best do (digest; evidence in the research notes)

- **Linear** ([a design reset](https://linear.app/now/a-design-reset), [how we redesigned the UI](https://linear.app/now/how-we-redesigned-the-linear-ui), [Quality Wednesdays](https://linear.app/now/quality-wednesdays), [agent docs](https://linear.app/developers/agent-interaction)): quality is a habit (one small polish fix per engineer per week; the founding bug was a button that darkened instantly instead of fading over 150 ms); theme from three inputs in LCH; measured on the marketing CSS: highlights in at 0 s, out at 150 ms, hovers .16 s with `cubic-bezier(.25,.46,.45,.94)`, sheets .5 s with `(.32,.72,0,1)`, 12/13/14/15 px type with tracking −0.01 to −0.013 em, weights 510/590; agent sessions have six states, activities typed (thought, action, response, error, elicitation), actions collapsed with a tense flip (`Searching` → `Searched`), thinking indicator stays below the message you sent, `Worked for X` excludes waiting.
- **Superhuman** ([speed](https://blog.superhuman.com/superhuman-is-built-for-speed/), [metrics](https://blog.superhuman.com/performance-metrics-for-blazingly-fast-web-apps/)): 100 ms is the ceiling, target under 50; report the share of events under each bucket, not an average; one `Z` undoes anything for 10 s; the palette teaches the shortcut.
- **Raycast** ([AI chat manual](https://manual.raycast.com/ai/ai-chat), [technical deep dive](https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast)): queue by default, send button flips `Queue message`/`Steer message`, queued items individually promotable, Up on an empty composer edits the last message, Esc restores the draft, long messages collapse past 10 lines and open when find hits them, background notification off by default; "would someone think it is a regular Mac app?" is the test; no animation on a thing used hundreds of times a day.
- **Claude** ([Code](https://code.claude.com/docs/en/interactive-mode.md), [fullscreen](https://code.claude.com/docs/en/fullscreen.md), [checkpoints](https://code.claude.com/docs/en/checkpointing.md), [Desktop changelog](https://claude.com/docs/cowork/changelog.md)): Enter queues; Esc interrupts and keeps the queue; Esc Esc rewinds with a visible menu (code, conversation, both, summarise from here); a jump button counts `3 new messages`; permission prompts always scroll into view; since 2026-11-05 a long reply no longer drags the view: it stays at the sent message and a round button follows; a line says `Nothing new from Claude for 2 minutes`.
- **Zed** ([agent panel](https://zed.dev/docs/ai/agent-panel.md); source `crates/agent_ui`): content capped at 850 px; the whole message re-parsed on a background task, one parse in flight, later appends only set a flag; rows are not measured while their parse is pending (no layout jump); per-thread scroll restored; per-message steer only where turn boundaries are known (not for external ACP agents, which is us); keep/reject per hunk, `Review Changes` multibuffer.
- **T3 Code** ([source](https://github.com/pingdotgg/t3code)): lane 46 rem; rows 6 px apart; streaming re-renders only the last Markdown block; scroll modes `following-end`, `anchoring-new-turn`, `free-scrolling`; anchor offset 24 px, follow re-arm at 40 px; jump pill shown after 150 ms debounce, hidden at once; per-thread scroll and disclosure state for 100 threads; user messages collapse at 8 lines or 600 characters.
- **Cursor, ChatGPT desktop, Warp:** Enter queues, modifier+Enter sends now; Up recalls; `Cmd+F` find in chat; mark unread, next chat needing attention; batched inline review comments sent in one message; per-turn checkpoints that restore files without deleting messages.
- **Things, Arc/Dia, Emil Kowalski, Rauno, Vercel guidelines:** animate only to explain; interruptible; never animate what happens hundreds of times a day or comes from the keyboard; press scale .97; loading indicators after 150 to 300 ms and visible at least 300 to 500 ms; skeletons match the final layout; spend novelty only on agent-specific surfaces.

## 2.2 Principles for this app (what we copy, what we refuse)

1. **Instant in, 150 ms out.** Hover, selection and focus appear at once and fade out in 150 ms; nothing keyboard-initiated animates; a person's own message renders in the frame of the press.
2. **The agent's state is always one line away,** in the same place: `Working · 41s`, `Needs you`, `Nothing new for 2 minutes`, `Done in 41s`. No spinner where a shape change will do.
3. **Never lose the person's words:** drafts survive tab closes and failed sends; edits fork visibly; a message the agent refused returns to the box (already true).
4. **Quiet by default, discoverable by hover and keyboard:** actions on hover and focus (always in the accessibility tree), shortcuts shown next to actions and in the palette.
5. **No novelty in lists, menus and tabs;** the budget goes to code, diffs and the permission dock.

## 2.3 Reading column, rhythm, scrolling, streaming

Today: `CHAT_COLUMN = w-full max-w-3xl self-center px-6` (768 pt, 720 pt of text, `lib/layout.ts:77`); list `gap-2 pb-6 pt-4`; agent text is nsh `TextView` defaults (15 pt on 25.5 pt lines, blocks 11.25 pt apart: not the app's `text-sm`); user bubble `max-w-[85%] rounded-2xl bg-muted`.

Decisions:

- **Lane:** keep 768. Code, diffs, tables and tool cards use the same lane; code and diffs may scroll sideways, never widen the lane. Below 760 the lane is the window. Zed 850 px, T3 736 px, claude.ai about 768: we are inside the range.
- **Rhythm on the 4-pt grid** (`design/foundations.md`): agent text `classes`/`styles` on `TextView`: body 15/24 (line ratio 1.6; nsh's 1.7 is looser than every product read), blocks 12 apart, headings semibold 17/22 with 24 above and 8 below, lists 4 apart; a turn (user message, its work, its answer) is separated from the next by 24, rows within a turn by 8 (today's `gap-2`), a fence by 12. Replaces nsh's 11.25 with 12.
- **Turn grouping:** keep the work fold (`Worked, 2 commands, 1 file changed`); the user message is a quiet right-aligned bubble; the agent's answer has no bubble (a page, not a chat toy). Add `Worked for 41s` (active time only, no waiting, as Linear) on the fold line, replacing `Worked` when the clock is known.
- **Timestamps:** none in the flow (the conversation is a work log; `Worked for` carries duration). The time of a message shows in its hover actions row (`14:02`, full date in the accessible label); a day divider (`Today`, `Yesterday`, `3 Nov`) appears between turns across midnight and after 4 h of silence. Needs wall-clock times in `lib/session-rows.ts` rows (today only durations exist: `startedMs/endedMs`); a replayed turn keeps `Worked` with no time (inventing one is lying, `design/chat.md`).
- **Scroll states** (T3's three, Claude Desktop's 2026-11-05 change): `following-end` (default; re-armed within 40 pt of the end; any wheel up, PageUp or text selection releases it), `anchoring-new-turn` (when the person sends: their message is placed 24 pt from the top and the reply grows below without moving it; the pill says `Following` is off and offers `Jump to latest` once the reply is taller than the view), `free-scrolling`. The pill appears 150 ms after the end leaves the view and hides at once; it shows `3 new messages`, `Needs you` while a request waits (as today), else `Jump to latest`. The permission dock and a question always scroll into view.
- **Scroll memory:** per session, in memory, up to 100 sessions: row key, offset in the row, at-end, and the model's fold state, so switching tabs is lossless (T3, Zed).
- **Streaming without jank:** (1) text parsed off the UI thread, coalesced to one pass per 50 ms (today the engine tick; keep); (2) only the last Markdown block of a message re-renders (nsh `Each` keyed by position and kind already does this; fences split by us are keyed by index); (3) rows are not measured while their code block is pending: `CodeView` has a natural height before its first highlight, no layout jump when colours arrive (same characters); (4) no per-token animation, no blinking caret; the end of a streaming message is marked by the `Working · 41s` footer row; (5) an open fence is shown as it stands, never hidden until it closes (1.2).
- **New-message divider:** a hairline `New` with a count between the last seen and the first unseen row when a tab is revisited with unseen output; cleared when the end is reached.

Acceptance: a 5,000-row chat opens at its end and streams a 600-line fence with frame p95 under one refresh on a GPU (`.perf/code.test.tsx`, plus a chat scenario to add); sending while scrolled up places the message at 24 pt from the top in one frame; `chat-swap`, `chat-long` pass; no row height changes by more than 1 pt when a block's colours arrive (test: heights before and after a highlight).

## 2.4 Message actions

Row actions appear on hover or keyboard focus at the top right of the message (as `Copy message` today), 28 pt, quiet, in the accessibility tree:

| Action | Where | Behaviour |
|---|---|---|
| Copy | agent message (exists), user message (new) | whole Markdown source |
| Copy as Markdown | agent message menu (`…`) | same text, plus thinking as blockquotes when verbosity includes thoughts (Linear does for copied conversations) |
| Copy code | on a fence, `CodeBlock` | exists in 1.5 |
| Retry | last agent turn when it ended in error or when idle | re-sends the last user prompt as a new turn (the old turn stays); never silent |
| Edit and resend | user message | not an in-place edit: it opens the text in the composer and says `Sending this starts a new branch from here`; sending forks the session at that turn (keeper `start` with the history up to it; ACP has no rewind: `[unverified]` that every agent can fork; fall back to a new session seeded with the transcript summary) and the first session is kept intact, named in the header; the fork is visible (`Branch of "payments review", turn 4`) |
| Bookmark | not built | no product read uses it as a primary action; `mod+f` search and `Copy` cover the need. Revisit if the owner asks |
| Fork from here | user message menu | the same as Edit and resend with no change |

Unsent text is never lost: if a send fails the text returns to the composer (exists); Claude's lesson (a pending draft committed as a hidden edit forked a conversation silently) is why edits fork explicitly.

## 2.5 Keyboard in the chat

Rules: global ones carry `mod`, never `alt` (AltGr is Ctrl+Alt; Telex/VNI type with plain letters: so no bare letters, and no `[`/`]` either, Telex maps them to ơ/ư in one variant `[unverified]`); every key is in `lib/shortcuts.ts` once and in the `Keyboard shortcuts` list; `lib/shortcuts.test.ts` and `App.test.tsx` enforce it. Bound while a chat tab is active.

| Id | Keys | Does | Note |
|---|---|---|---|
| `focusPane` | `mod+2` (exists) | focus the composer | |
| `search` | `mod+f` (exists, label already says transcript) | find in the chat: bar over the list, `Enter`/`Shift+Enter` next/previous, `Esc` closes; pauses follow; opens a collapsed message that holds a hit | the terminal mirror keeps `mod+f` on its own tab |
| `chatPrevPrompt` / `chatNextPrompt` | `mod+up` / `mod+down` | move to the previous/next of your own prompts and scroll it to 24 pt | in a multi-line composer with text the field takes the key first (`[unverified]`: test on Linux, macOS) |
| `chatLatest` | `mod+end` | jump to the end and follow | `end` alone still works when no text box has focus |
| `chatCopyCode` | `mod+shift+c` | copy the last code block of the last agent message, toast `Copied` | no product has one: ours |
| `chatCopyReply` | `mod+shift+y` | copy the last agent message as Markdown | |
| `chatToggleWork` | `mod+shift+e` | expand or collapse every work group (Claude cycles verbosity with Ctrl+O) | state to `model.choices` |
| `chatRetry` | `mod+r` | retry the last turn (2.4), confirm only if a turn runs | |
| `chatEditLast` | `up` in an empty composer | puts the last prompt back for editing as a branch | not global: a field key |
| `chatHistory` | `up`/`down` in the composer when the caret is on the first/last line | walk this folder's sent prompts; `Esc` restores the draft | Raycast, Claude Code |

Existing: `escape` stops the turn from the box; `enter` sends or queues; `shift+enter` newline; `pageup`/`pagedown`; `home`/`end` when no field has focus. Do not add `j`/`k` (`design/chat.md`).

## 2.6 Composer

Present: autosize 28 to 168 pt, `/` and `@` pickers, files by `+` or drop, queue with take-back, Stop with a 400 ms guard, text returns on refusal. Missing, decided:

- **Draft persistence:** per session id, in `Storage`, written 500 ms after the last keystroke, cleared on send, restored on open (also after a crash); queue and drafts survive restart (Claude Desktop, Warp does not: we do it, it is cheap).
- **Input history:** per folder, 100 entries, consecutive duplicates collapse; `Up` on an empty composer edits the last prompt, `Up`/`Down` walk, `Esc` restores the draft (Raycast, Claude Code).
- **Send keys:** `Enter` sends, `Shift+Enter` newline (kept). While a turn runs the primary button reads `Queue message`; a configurable `mod+enter` does the other thing once. ACP gives no turn boundary, so **no `Steer`**: offer `Send now` (cancel the turn, then send), labelled exactly that (Zed restricts Steer for the same reason).
- **Paste image:** the engine takes paths, not bytes (`design/chat.md`): write the pasted PNG to `<dataDir>/pastes/<id>.png` (0600) and attach it as a path; `[unverified]`: whether nsh 0.4.0 can read an image from the clipboard on Linux (`Clipboard` has `writeText`; check `readImage`). Without it, drop files stays the way and the spec records the gap.
- **Large paste:** over 40 lines becomes a chip `Pasted text, 212 lines` that expands on press and sends as text (Claude Code).
- **Hint line** under the box only when it teaches something new: `Enter to send · Shift+Enter for a new line` for the first three sends, then `Enter to queue` while busy.
- **Mode and model chips** stay (`session-config.tsx`).
- **Empty box while a request waits:** Enter does nothing (kept), digits answer only while the dock has focus (kept).

## 2.7 Tool rows, diffs, review, thinking

- **Tool row** (kept): kind icon, tense-flipping verb (`Running` → `Ran`), object in mono, state shape. Add elapsed in `tabular-nums` updated from the engine tick (not state per row), shown after 3 s while running (`Running pnpm test · 12s`), final duration on hover.
- **Groups:** `Worked for 41s, 2 commands, 1 file changed` (kept plus the time); repetitive reads fold (`Read 4 files`) in the group summary; subagents stay outside the fold.
- **Output** of a command: `CodeBlock` (no language), last 8 lines for `execute`, as today, `Show all N lines`.
- **Diffs** in the transcript are `DiffBlock`, read-only. **No accept/reject per hunk in v1:** an ACP agent has already written the edit or asks first through the permission dock (the gate that exists). A Review pane later (not in this spec's build): nsh `DiffView` with its hunk revert/accept (`diff/model.rs`), per-turn source (`T1..Tn` as Claude Code), `Mark as viewed`, batched comments sent as one message (Claude Desktop, Warp, Codex). Revert of a hunk is a keeper command through the machine, with confirm and undo; owner decides (question 4).
- **Thinking:** one collapsed line `Thought for 12s` (kept) with a live elapsed while it streams; open shows the thought, muted, bounded to 12 lines tailing; auto-collapses at turn end (Linear, Claude); verbosity `Normal / Thinking / Verbose` is `chatToggleWork`'s second press.
- **Permission dock** (kept, `design/chat-parts.md`), unchanged by this spec.

## 2.8 Errors, stalls, empty and new-session states

- **Error row** in the transcript: the agent's words, one line of what to do, `Retry` (2.4); never a toast alone. **Stall:** after 120 s with no tool running a quiet line `Nothing new for 2 minutes` replaces `Working · Ns` (exists as `Quiet for Nm`: keep that wording or this one, not both), with `Stop`.
- **Offline / reconnect** banner keeps its place and never shifts the composer (T3 #26958).
- **New session** (`Opening the session…` then the empty chat): the composer fills the lane; above it the agent, folder and branch as quiet text (`omp · ~/work/payments-api · main`), under it up to three **recent folders** of this machine as buttons (`payments-api`, `ledger`, `docs`) that restart the session there and the last three prompts of this folder as chips that fill the box (not send). No illustration, no `How can I help?`. A returning person sees the previous transcript, never this.
- **Idle done state:** the footer `Done in 41s · 1 file +3 −1` (kept), the one place Inbox-Zero-style delight is allowed: nothing animates.

## 2.9 Links, file chips, images, tables, math, long messages

- **Links and paths:** today a Markdown link to a path opens the viewer, bare paths and `path:line` in agent text are not linked. Decide: linkify, in agent Markdown and in inline code, `path`, `path:line` and `path:line:col` where the path exists on the session's machine within the folder or two parents (the existing `Files.find` check, cached per message) as a **file chip**: mono, `InlineCode` look, `file` icon only on hover, press opens the viewer at the line (`viewFile(machine, path, line)`), `mod`+press opens the folder. A non-existent path stays plain text (no dead links). URLs open through the existing `openUrl` guard (`http`, `https`, `mailto`).
- **Images:** keep the chip `Image: <alt>` that opens the photo viewer; paths and data URIs ≤512 KiB render inline as today (320 × 200); a web image is never fetched.
- **Tables:** nsh grid, plus `renderTableActions`: a `Copy table` (TSV) action; keep stable layout while streaming (Claude Code fixed tables flipping with half-typed rows; nsh repairs the header row).
- **Math:** nsh's typesetting stays.
- **Long messages:** a user message over 8 lines or 600 characters folds with `Show more` (T3); an agent message never folds (the person asked for it) but a very long one (over 400 lines) gets a sticky `Jump to latest` already; find opens folded messages.

## 2.10 Unread, notifications

Exists in Rust (`notify/`, `docs/ALERTS.md`): off by default, only while the window is away, never silent approval. Add in the chat: unread dot on the tab and the sidebar row while an agent finished or needs you off-screen (the sidebar already shows the shape; the tab gets the same glyph), `mod+j` next attention (exists), `Shift+Escape` clears all unread marks (ChatGPT), and the new-message divider (2.3). A finished turn announces `Agent: <200 chars>` once (exists).

## 2.11 Speed and perceived speed: budgets

Measured like Superhuman: the share of events under each bucket (under 50 ms, under 100 ms, under 1 s), recorded by `lib/perf.ts` timings, shown in the developer panel, asserted in `.perf/chat.test.tsx` (to add):

| Event | Budget | Today |
|---|---|---|
| keystroke to echo in the composer | one frame (16 ms) | unmeasured |
| press of Send to the user's bubble | same frame, optimistic | unmeasured |
| chat tab switch | under 50 ms warm (rows kept, scroll restored) | unmeasured |
| first block of a language coloured | warm: 0 ms; cold: one frame plain at most | measured 1.2 |
| fence chunk to colours | under one frame for blocks under 24 KB | measured 0.3 to 2 ms |
| open a 5,000-row chat at its end | under 100 ms | exists as a test |

Rules: optimistic send with an inline retry on failure, never a modal; skeleton only when the shape is known (a block's lines) and only after 150 ms; a spinner never replaces a shape change; opening is `Opening the session…` text, not a spinner; the composer never changes height by itself except when text is added.

## 2.12 Micro-interactions and sound

Press scale .97 on buttons (exists via `pressFeedback`), 150 ms fade-out on hover fills (`hoverTransition`), toast stack and dock motion as `design/motion.md`; the row arrival rise DesignPass is adding applies to new rows only (240 ms, skipped under reduced motion, never on rows loaded with the tab). Never animated: keyboard-driven selection, folds opened from the keyboard, scroll. **No sound by default** and none planned: Zed ships `play_sound_when_agent_done: never`; no source found for sounds in Linear, Things, Superhuman `[unverified]`.

## 2.13 Accessibility (the contract for every item above)

- Reading order: header, conversation (list), docks, composer; one landmark per region; the transcript is a list named `Conversation`, rows labelled `You: …`, `Agent: …`, `Tool: Ran ls, done`, `Thought`, `Subagent: …` (kept); a code block is a group `Code, TypeScript, 41 lines` with the text of each line inside; a diff `Diff of src/auth.ts, 2 added, 1 removed` with `Previous change`/`Next change` and `Change 2 of 5`.
- Live regions (polite only): turn end once (200 chars), `Copied`, `New: 3 messages` when the divider appears and focus is elsewhere, `Following` off/on when the scroll state changes by the person's action; `Needs you` stays assertive-by-focus as `docs/ACCESSIBILITY.md` says.
- Keyboard: every action reachable without hover (actions are in the tree); a transcript row is a focus stop only where it has an action; `mod+up`/`mod+down` move between prompts; folds are buttons with `expanded`.
- Reduced motion: arrival rise, fades and press scale off; scrolls already unanimated; skeleton shimmer none.
- Contrast: code roles at least 4.5:1 on every surface (3:1 punctuation), tested; `fontScale()` 2.0: the block's line height scales with its font; the header tools wrap under the label.

# Part 3: Order, tests, composition

## 3.1 Build order (each step ships green)

| Step | What | Acceptance |
|---|---|---|
| 1 | `lib/markdown-fences.ts` + `MarkdownText` split; `CodeBlock` in agent messages; `classes.code`; settings moved | fence tests (closed, open, nested in list stays default, `~~~`, four backticks); `session-tab.test.tsx` pass; `chat-long` and `chat-swap` screenshots at 1280/960/760 light and dark; no height jump test |
| 2 | Tool `Mono` and `Edit`, `permission-diff` to `CodeBlock`/`DiffBlock`; controlled `open`; label updates in tests | pinned labels updated, the dock's read-to-end test untouched and green |
| 3 | Scroll model (anchor new turn, memory, divider), day dividers, wall-clock times in rows | scripted scenario: send while scrolled; per-session scroll restored; heights stable |
| 4 | Message actions row, copy as Markdown, retry; keys `chatCopyCode`, `chatCopyReply`, `chatToggleWork`, `chatLatest`, `chatPrevPrompt`/`chatNextPrompt`, `search` | `shortcuts.test.ts`, `App.test.tsx` as macOS/Windows/Linux, a11y audit names |
| 5 | Composer: drafts, history, large paste chip, paste image, hint line | restart test restores draft; history test; clipboard image `[unverified]` decided |
| 6 | Find in chat | hit count announced, opens folded rows, pauses follow |
| 7 | Edit and resend as fork | fork visible in header; first session intact (needs keeper support: question 3) |
| 8 | Linkified file chips | existing paths only; `path:line` opens at the line |
| 9 | Review pane (later) | not scheduled |

Each UI step: screenshots (cairo, Xvfb) at 1280, 960, 760, light and dark, two themes, looked at; `make a11y`; `make docs`; perf scenario deltas (`docs/PERFORMANCE.md`); a test that failed before each fix.

## 3.2 Integration file list (the GO step)

| File | Change |
|---|---|
| `components/markdown.tsx` | fence split, `CodeBlock` per fence, `classes={{ code: inlineCodeClasses }}`, call `loadCodeSettings`/`Code.warm` |
| `lib/markdown-fences.ts` (new) | top-level fence scanner (open fence = last, unclosed) with tests |
| `components/session-item.tsx` | actions row (copy as Markdown, retry, fork), day divider, `New` divider, timestamps on hover; pass `streaming` of the open fence only |
| `components/session-tool.tsx` | `Mono` to `CodeBlock`, `Edit` to `DiffBlock`, elapsed in tool rows, group summary |
| `components/permission-diff.tsx`, `permission-dock.tsx` (`Read all` only), `session-signin.tsx` | as the table in 1.7 |
| `components/session-transcript.tsx` | scroll states, anchor, threshold 640, memory, pill debounce 150 ms, find bar mount |
| `components/session-composer.tsx` | drafts, history, large paste chip, paste image, hint line |
| `components/session-tab.tsx` | key bindings, announcements, scroll/fold memory |
| `lib/session.ts`, `lib/session-rows.ts` | wall-clock times in rows, day dividers, `New` marker, `open` state of blocks in `model.choices`; row kinds and keys unchanged (`i:`, `w:`, `more:`) |
| `lib/shortcuts.ts` (+ test) | `chatPrevPrompt`, `chatNextPrompt`, `chatLatest`, `chatCopyCode`, `chatCopyReply`, `chatToggleWork`, `chatRetry` |
| `lib/settings.ts`, `components/settings.tsx` | code options (1.7) |
| `design/chat.md`, `design/code.md` (new, draft in 3.3), `design/typography.md` (code size) | docs in the same change |
| `native/app` | `CodeView`/`CodeDiff`/`Code` already registered; keeper support for fork (question 3) |

## 3.3 Draft of `design/code.md` (to move to `design/` at integration; under 150 lines, every identifier exists)

```
# Code
One renderer: `CodeBlock` (components/code-block.tsx) over native `CodeView`; diffs `DiffBlock` over `CodeDiff`.
Never `TextView`'s block, `Editor` or `DiffView` in the transcript. Colours are `code-*` tokens (`lib/theme/code.ts`):
a role is a kind of token (`CODE_ROLES`, the same list as `Role` in native/app/src/highlight/engine/role.rs).
- Ink budget: identifiers in `code-plain`; colour is for strings, numbers, types, definitions. Italics off; `CODE_MEDIUM` roles are Medium.
- Every role reaches `CODE_MIN_CONTRAST` on every surface (`codeSurfaces`); punctuation `PUNCTUATION_MIN_CONTRAST`. The test names the pair.
- Diff: `+` or `−` in its own column, a tint, a 2 pt bar: three signals. Never recolour token text on a diff row.
- A block is a group named by `codeLabel`; its tools are named by what they do and stay in the accessibility tree.
- Streaming: `streaming` only on the open fence; a block never folds while it is written.
- Language: `Lang.detect` (fence word, path, shebang, sniff); unknown is plain.
```

## 3.4 What DesignPass's foundations must provide (and does, as read)

Already in `design/foundations.md`: the 4-pt spacing scale, `TYPE` (13/15/17…), `RADIUS`, `COLUMN.chat` 768, `ROW`, `HIT.pointer` 28. This spec composes with it: code is 13 pt in 20 pt lines (`text-xs`'s size, row-grid aligned), blocks have `RADIUS.md`, tools are 28 pt, gaps are `1/2/3/4/6` only (the lab was fixed to that). Still needed from it: (a) a **reading-prose scale** for the transcript (15/24 body, 12 between blocks, heading steps) as `PROSE` in `lib/layout.ts` and handed to `TextView` `classes`; (b) `COLUMN.chat` kept as the one lane; (c) a **motion token for hover fade-out** (150 ms) shared with `lib/motion.ts` `hoverTransition`; (d) a **gutter/mono size token** (`CODE` 13/20) so a future font-size setting moves code and terminal together; (e) `arrivals` from `lib/motion.ts` limited to rows created after the tab opened (this spec relies on it).

## 3.5 Open questions for the owner (max 6)

1. **Binary size:** tree-sitter for 25 languages adds 27.7 MB raw (3.0 MB gzip) to the app. Keep all, or move Swift, Kotlin and C++ (11 MB) to TextMate (they lose most semantic colour)?
2. **Fences nested in lists and quotes** keep nsh's plain block (we split top-level fences only). Acceptable, or do you want a `renderCodeBlock` path for those too, accepting per-chunk remounts?
3. **Edit and resend as fork** needs the keeper to start a session from a history prefix; not every ACP agent can. Build it, or ship `Copy` plus `Retry` only?
4. **Review loop:** per-hunk accept/revert on files an agent already changed (a keeper command with confirm and undo), or permission-dock-only for now?
5. **Steer:** ACP has no turn boundary, so we offer `Send now` (cancel then send) and no `Steer`. Agreed?
6. **Paste image** needs a clipboard image read that nsh 0.4.0 may not have on Linux; if it does not, is drop-a-file enough for now?

## 3.6 Unverified, honestly

Colour-blind simulation of the palette; Orca reading of blocks; the GPU frame budget for code (CPU-drawn cairo and debug Rust only); `mod+up`/`mod+down` precedence inside a multi-line composer on Linux and macOS; clipboard image read; keeper fork; ChatGPT's and claude.ai's real column widths (only CSS variable names, third-party userscripts); Linear's in-app (authenticated) CSS (only marketing-site CSS measured); every Things, Arc and Superhuman easing number and UI sound (not published); the `make a11y` audit with the new labels; macOS rendering of any of it.
