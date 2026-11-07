# Performance

What is measured, where, how to read it, what the budgets are and what was found. Every number in the tables was measured on the machine and the build named under "Where these numbers come from", five runs each, and is a **median with the spread beside it**. The product targets (frame p95 < 8.3 ms at 120 Hz on the owner's RTX 3090 session, RSS at rest < 150 MB) are **unverified**: there is no display in the agent sessions, so nothing below was drawn by a GPU. The budgets in `.perf/budgets.json` are regression guards over the CPU-drawn numbers, not those targets.

An app at rest draws no frames and uses next to no CPU (nsh draws only on change). A scenario that breaks that is a bug. At rest here means a window with no focused text field, see Finding 2.

## Where these numbers come from

- Machine: Intel Core i7-12700K (12 cores, 20 threads), 31 GB, Linux 7.0.0-42, GTK 4.22, nsh 0.4.0, Rust 1.99.1. It is a shared workstation: other agents compile and a model server runs on it, so the same scenario swings by tens of percent between runs and between hours (the `[min-max]` of the tables). No display: `xvfb-run` with `GSK_RENDERER=cairo`, a **CPU-drawn** renderer, so frame times are an upper bound and only counts and ratios carry over (`scripts/run-linux.mjs`).
- Build: `nsh test --target linux` runs the **development host**, which is unoptimised Rust (`[profile.dev]` has no optimisation, and nsh, GTK bindings and our crates all share it). There is no release switch for `nsh test`; a release build (`nsh run . --target linux --release --fps`) needs a window and a person. Rust-side figures from the app are therefore upper bounds too: `Screen::parse` is 8.4 µs a row in the app and 0.82 µs a row in `cargo bench` (release), ten times apart.
- Tree: commit `a21addd` with the PaneScreen fix of Finding 1 and the scenario files of this change. The numbers move with every UI change; re-run before quoting them.
- Date: 2026-11-07.

Commands (from the repository root, `make perf` and `make cpu` run the first two):

```sh
bun scripts/perf.mjs --runs 5 [--json .scratch/perf.json]   # frames, JS, process, Rust metrics: median [min-max]
bun scripts/cpu.mjs --runs 5                                # CPU of the host process per scenario from /proc
cargo bench --manifest-path native/core/Cargo.toml          # parser, release (plain main, ns per row)
make perf-check                                             # three runs of each, fails when the best run breaks a budget
```

**For the owner, on a real display** (this is what turns the unverified rows into measured ones): run `bun scripts/perf.mjs --runs 5` and `bun scripts/cpu.mjs --runs 5` in a desktop session with `DISPLAY` or `WAYLAND_DISPLAY` set; the scripts then skip Xvfb and the table's footer says "Measured on the display of this session". Frame p95 under 8.3 ms is the product target on the 3090; compare RSS at rest with 150 MB after a minute of idling (Finding 3). Those runs are still the development host; for an optimised build run `nsh run . --target linux --release --fps` and read the `nsh::perf` line it logs each second.

## The developer panel

`Ctrl+Shift+D` (`devPanel` in `lib/shortcuts.ts`) opens a panel with one line per metric, refreshed twice a second while it is open. Nothing runs while it is closed except `timing` recording (two clock reads per measured call). Metrics are registered with `registerMetric` (`lib/perf.ts`); the Rust ones are in `lib/native-metrics.ts` and come from one `Herdr.metrics()` call per refresh (`native/app/src/metrics.rs`). Panel lines have no health colour: the budgets below are for the scripts.

| Metric (panel label) | What it is | How it is measured | Covers / does not cover |
|---|---|---|---|
| `FPS`, `JS lag` | Frames the JS thread saw per second and its p95 gap; how late a 100 ms timer fires | `requestAnimationFrame` gaps and a 100 ms interval, rolling window of 300 (`lib/perf.ts`) | The JS thread only; GPU and compositor time are `--fps`'s |
| `Read to paint` | Latency from herdr reporting a pane's activity to `PaneScreen` setting the new rows on the view; p50 and p95 | The scheduler stamps the first unread `pane_updated` activity of a watch (`Watch::activity` in `engine/panes.rs`); the read that publishes a changed screen carries the stamp (`PaneFeed::activity_at`); `PaneScreen` reports `elapsed()` once per screen when it sets the rows (`News::pull` in `pane_screen.rs`) | Event arrival at the scheduler, the 50 ms read gap, `pane.read`, parse, publish, task wake-up, setting the rows. Does **not** cover GTK laying out and drawing the frame after that (unverified until measured on a display), nor the time between herdr's own change and its event |
| `Pane reads` | `pane.read` answers per second, all watched panes | Timestamps of answered reads, over the last 5 seconds (the first seconds are divided by the time since the first read) | Only the screen reads of watched panes (`read_screen`); the card previews' reads and answer re-reads are not counted |
| `Parse` | Microseconds per row to turn a pane's ANSI text into rows, mean and p95 | `Instant` around `Screen::parse` in `read_screen`, divided by the row count, one sample per read, last 300 | Parsing only (`herdr-core` `screen`); `benches/parse.rs` is the same code in isolation |
| `Rows rebound` | Rows `PaneScreen` rebinds per screen update (mean, and the most in one update) | A row whose `Arc` is unchanged keeps its views; the count is rows whose `Arc` differs (`metrics::changed_rows`) plus rows that appeared or went | Proportionality: one changed row of 50 should read about 1, not 50 |
| `Memory` | Resident memory of the app | `VmRSS` of `/proc/self/status` | The whole process: engine, JS heap, GTK |
| `Threads · fds` | OS threads and open file descriptors | `Threads` of `/proc/self/status`; entries of `/proc/self/fd` (minus the directory handle) | A leak shows as a count that only climbs while the same panes are open |

All Rust figures are `0` until a sample exists, and `-` in the panel for the latency and parse lines. They are process-wide (all panes, all machines): in the Rust-metrics table below, the windows of 300 samples carry over from one scenario to the next, so read each row as "up to and including this scenario".

What the monitor's columns are (`nsh::perf`, one line a second while GTK draws; `scripts/perf.mjs` keeps, per scenario, the worst reading that moved):

| Column | Meaning |
|---|---|
| `s drawn` | Seconds of the scenario in which GTK drew at least one frame. The monitor prints nothing for a second without a frame, so **0 is an app at rest**. |
| `fps min` | The lowest frames-drawn-in-a-second reading |
| `frame p95` | Main-thread time of a drawn frame, GTK's frame clock `before-paint` to `after-paint`, 95th percentile, worst second of the scenario (ms). Under cairo this includes software rasterising, under a GPU it is the CPU side of the frame |
| `over %` | Share of frames that took longer than one refresh (16.7 ms at the monitor's 60) |
| `js p95` | Our JS per commit, 95th percentile, worst second (ms) |
| `core p95` | The engine's own time per commit, same rule (ms) |
| `cpu` | Whole host process, percent of one core: `scripts/cpu.mjs`, from `/proc/<pid>/stat` between the scenario markers (10 ms resolution, so a quiet row reads coarsely) |
| `rss MB` | The monitor's resident memory, the highest reading of the scenario |

## Scenarios

`.perf/scenarios.test.tsx` has four tests, each one window; every scenario logs `PERF-SCENARIO <name>` where it starts and runs until the next marker. Before each marker the app logs `Herdr.metrics()` (`PERF-METRICS`). A test file cannot reach the native module under `--target linux` (it runs apart from the host), so the scripted herdr is driven from the entries `perf-app.tsx` (the whole app plus key-bound drivers: stream, swap the snapshot, read counters) and `perf-chat.tsx`, which sit in the repository root because an app finds its fonts and icons only under its entry directory (from `.perf/` the window runs on fallback fonts and logs 404s). Nothing imports them, so `nsh package` (which bundles from `App.tsx`) does not ship them. The driver's own cost is on the JS thread and inside the figures; it logs it (0.6 ms of every 50 ms tick, 8 panes).

| Scenario | What it measures |
|---|---|
| `idle board` | The `mixed` fixture's board, nothing happening, 5 s: **frames drawn at rest (must be 0)**, CPU at rest, RSS at rest |
| `palette open` | `Ctrl+K` and 5 s of waiting with the search field focused: the cost of a focused text field at rest (Finding 2) |
| `palette typing` | Eight characters at 150 ms in the palette: JS per commit and frame time of a keystroke |
| `crowd of N candidates arrives`, `idle board, N candidates`, `palette open, N candidates`, `palette typing, N candidates` | The palette on a crowd (`ctrl+alt+5`: 1,900 agents, about 2,000 candidates; `ctrl+alt+6`: 4,900, about 5,000, from copies of `big.json`): the arrival, the board at rest for 15 s (it keeps pulling previews for a while, so the palette is measured after that), opening (a catalog of the whole crowd is frozen), then eight characters at 150 ms. Rust ranks in 0.25 ms (2,000) and 0.6 ms (5,000) (`cargo bench --bench search`); the rest of a keystroke is marshalling 30 rows, mounting them (a list stops at 30 rows and says `N more`: every listed row is mounted) and the commit. Headless (`nsh test --trace`) a keystroke commit is 7-16 ms on `big.json`; under Xvfb with cairo on this shared host its JS p95 is 91-330 ms at 2,000 candidates (5 runs, the 5,000 rows are blurred by the arrival's own commit of about 900 ms and a resident set of 1.7 GB), so the 16 ms target is **not met here and unverified on a real display**; the budgets are regression guards (median x 1.5) |
| `open a pane` | Opening a terminal tab from the sidebar: first read, parse, mount |
| `idle pane` | A pane tab in front, nothing arriving, 5 s: no frames, no reads |
| `stream 8 panes, 1 open` | 8 panes of the scripted herdr (50 rows, 100 columns, colour) updated 20 times a second for 10 s; one pane tab open and in front. Frame time with a screen changing every tick, read to paint, rows rebound, and that **only the open pane is read** (`pane.read` per pane: 405 for the open one, 1 for the other seven) |
| `idle pane after streaming` | The same pane after the stream stops: it returns to rest (no frames, no reads) |
| `scrollback 1000 rows, scrolled` | One pane with 1000 rows in the scrollback view (`Wrap lines`), scrolled up and down 12 times: virtualised rows, frame time while scrolling |
| `open 2 more panes in splits` | `Ctrl+\` splits and two more terminal tabs: mounting a pane tab into a new group |
| `stream 8 panes, 3 open in splits` | The same stream with three panes open, each in its own split: reads scale with the open panes (20 a second each, 60 in all), not with the 8 that update |
| `close panes` | Closing the three tabs and going back to the board |
| `switch project x20` | Two projects with a pane open each, then 20 project switches by key (`ctrl+shift+[` / `]`) 450 ms apart: the swap commit, and whether memory, threads, descriptors and watched panes stay flat |
| `idle after 20 switches` | The board again, at rest: no pane watched, no frames |
| `permission storm: 20 blocked at once` | The snapshot swapped for `storm.json` (20 agents blocked in 5 projects): one burst of events is one rebuild of the board |
| `idle with 20 blocked` | The same board at rest: the blocked agents' pulse or chips must not draw frames |
| `200 agents arrive` | The snapshot swapped for `fixtures/herdr/big.json` (200 agents, 31 workspaces, 25 projects, 3 of them repositories with 6 linked worktrees, 12 blocked): the commit and the memory of mounting them |
| `idle board, 200 agents` | That board at rest |
| `project home scroll, 200 agents` | The home scrolled up and down 12 times: frame time with every project card mounted |
| `chat idle, empty` | The chat tab on a real keeper and herdr-mobile's scripted ACP agent, nothing said yet (window 2) |
| `chat 5,000 items arrive` | `long:5000`: 5,000 messages through the keeper, the reducer and the transcript model: the commit, the memory |
| `chat 5,000 items, idle at the end` | The conversation open at its end, 5 s |
| `chat 5,000 items, scrolled` | The 5,000-item conversation scrolled up and down 12 times |
| `chat with code, 5,000 items, idle at the end` | The scripted port (`scene: long`, `fences`): 5,000 rows, every fourth answer with a code block, one in five of those 60 lines; native code views in recycled list cells, open at the end, 4 s |
| `chat with code, 5,000 items, scrolled` | That conversation scrolled 16 times by 2,500 pt: code views created and destroyed in recycled cells, frame time while they are |
| `chat streaming a 600-line fence` | An answer writing one 600-line Rust fence in pieces of 20 lines every 40 ms in a chat that follows its end: JS per commit (the fence scan, `safeCode`, the block's props), core, frame time |
| `chat, the fence written, idle` | The same chat once the fence is closed and folded, 3 s |
| `changes, 500 files scrolled` | `.perf/changes.test.tsx` (entry `changes-lab-app.tsx`): the Changes tab on a repository of 522 changed files, its virtual list scrolled 24 times (the highest module shown must move) |
| `changes, a 5000-line change opened` | A file with 5,000 lines changed (10,000 diff lines, shown cut at 6,000): `j` to a small file and `k` back, press to the diff drawn. Measured 324-348 ms (unoptimized Rust, Xvfb + cairo; the guard fails above 700 ms); the product target is 300 ms in a release build and is **unverified** there |
| `changes at rest` | The tab in front with nothing changing: its 5 s read of git must not draw a frame when nothing changed |

`fixtures/herdr/big.json` is generated by `bun scripts/gen-big-fixture.mjs` (synthetic names, deterministic): change the generator, not the file.

## Measured: frames, JS, CPU, memory

Median of five runs, `[min-max]` where it moved. `-` is no frame drawn (the row's frame columns have nothing to say).

| Scenario | s drawn | frame p95 ms | over % | js p95 ms | cpu % | rss MB |
|---|---|---|---|---|---|---|
| `idle board` | **0** | - | - | - | 0.8 [0.6-1.0] | 291 [291-294] |
| `palette open` | 6 | 22.5 [21.2-29.3] | 14 | 1.7 | 5.2 [4.9-5.3] | 322 [320-323] |
| `palette typing` | 8 | 1.3 [1.0-1.4] | 0 | 0.0 | 4.2 [3.9-4.7] | 323 [320-324] |
| `open a pane` | 2 | 5.0 [4.6-5.7] | 0 | 0.0 [0-10.8] | 8.6 [7.8-8.7] | 329 [192-330] |
| `idle pane` | **0** | - | - | - | 0.4 [0.4-0.6] | 313 [184-314] |
| `stream 8 panes, 1 open` | 10 | 3.6 [2.5-4.5] | 0 | 1.2 [1.2-7.7] | 9.5 [8.2-10.1] | 329 [194-330] |
| `idle pane after streaming` | **0** | - | - | - | 1.0 [0.6-1.6] | 314 [185-315] |
| `scrollback 1000 rows, scrolled` | 17 | 4.8 [4.3-8.0] | 0 | 1.1 [1.0-1.3] | 11.7 [7.6-14.0] | 333 [198-335] |
| `open 2 more panes in splits` | 3 | 8.9 [6.5-10.1] | 2 | 0.5 | 8.1 [7.6-10.3] | 342 [207-344] |
| `stream 8 panes, 3 open in splits` | 10 | 7.3 [5.9-8.5] | 1 | 2.4 | 14.0 [13.8-16.0] | 343 [208-345] |
| `close panes` | 1 | 0.0 [0-4.0] | 0 | 1.0 | 5.6 [3.6-7.5] | 344 [209-345] |
| `permission storm: 20 blocked at once` | 1 | 5.2 [4.1-5.5] | 1 | 2.3 | 12.1 [10.1-13.4] | 348 [213-349] |
| `idle with 20 blocked` | **0** | - | - | - | 0.8 [0.4-1.0] | 335 [207-336] |
| `200 agents arrive` | 1 | 5.5 [0-5.6] | 2 | 2.5 | **43.0** [41.8-44.8] | 401 [267-402] |
| `idle board, 200 agents` | **0** | - | - | - | 0.6 [0.2-0.8] | 382 [255-383] |
| `project home scroll, 200 agents` | 15 | **16.3** [16.1-17.0] | 5 | 0.0 | 14.9 [14.4-15.3] | 401 [267-402] |
| `chat idle, empty` | 3 | 1.4 | 0 | 1.2 | 1.6 [1.3-3.4] | 270 [267-271] |
| `chat 5,000 items arrive` | 2 | 0.7 | 0 | 42.1 [41.5-43.9] | 9.7 [9.3-10.2] | 303 [300-304] |
| `chat 5,000 items, idle at the end` | 5 | 0.7 | 0 | 0.0 | 1.5 [1.0-1.6] | 303 [300-304] |
| `chat 5,000 items, scrolled` | 21 | 3.2 [2.8-3.9] | 0 | 2.3 [1.2-3.7] | 11.2 [10.9-13.3] | 308 [305-308] |
| `chat with code, 5,000 items, idle at the end` | 4 | 0.6 [0.6-0.7] | 0 | 0.0 [0.0-0.2] | 1 [1-2] | 309 |
| `chat with code, 5,000 items, scrolled` | 41 | 3.4 [3.3-3.6] | 0 | 1.5 [1.5-1.8] | 12 [12-12] | 319 |
| `chat streaming a 600-line fence` | 2 | 6.1 [5.3-7.9] | 0 | 6.0 [5.9-6.2] | 34 [33-34] | 308 [307-308] |
| `chat, the fence written, idle` | 3 | 4.9 [4.4-5.1] | 0 | 0.0 | 1 [1-2] | 308 |

## Measured: the Rust side

From `Herdr.metrics()` (the panel's lines), same runs. Reads per second are read while the stream still ran. Rows rebound is mean / most in one update.

| Up to scenario | reads/s | read to paint p50 / p95 ms | parse µs/row | rebound mean / max | threads | fds |
|---|---|---|---|---|---|---|
| `stream 8 panes, 1 open` | 20.0 [19.8-20.0] | 2.25 / 3.19 [spread 2.24-6.2 / 3.1-10.0] | 8.4 [8.3-9.0] | 4.4 / 50 | 75 | 20 |
| `scrollback 1000 rows, scrolled` | - | 2.27 / 3.23 | 8.3 | 19.1 / 1000 | 75 | 20 |
| `stream 8 panes, 3 open in splits` | 59.4 [59.4-60.0] | 2.33 / 3.52 [spread 2.2-10.6 / 3.3-16.4] | 7.7 | 4.4 / 50 | 75 | 20 |
| `project home scroll, 200 agents` | - | 2.33 / 3.52 | 7.7 | 4.4 / 50 | 75 | 20 |
| chat window, `5,000 items, scrolled` | - | - | - | - | 79-83 | 22-23 |

`cargo bench --manifest-path native/core/Cargo.toml --bench parse` (release, 50 rows of 200 columns, five runs; ns per row, median of batches): `parse_cold` 824 [816-899], `parse_unchanged` 771 [769-857], `parse_one_row_changed` 771 [770-857], `links_per_screen` 667, `detect_links_one_row` 1239 [1233-1244], `wrap_to_80` 478, `min_contrast_fg` 1083 [1083-1104]. A screen of 50 rows is 41 µs to parse cold, release.

## Budgets

`.perf/budgets.json`: `default` (`frameP95`, `over`, `jsP95`, `memMB`: the product-shaped numbers a scenario without an entry must meet) and `scenarios.<name>` overrides (the same keys, plus `drawn` for seconds with frames drawn and `cpu` for percent of one core). The file says in its own `note` that it was measured under Xvfb with cairo.

- Each time budget is the **median of the five runs × 1.5** (`bun scripts/perf.mjs --runs 5 --write-budgets`, then the `cpu` keys from `bun scripts/cpu.mjs --runs 5`, which merges into the same file). The slack was 1.15 first and broke: on this shared machine the same scenario moved by 30% between two sessions an hour apart (`chat 5,000 items, scrolled` frame p95: 3.2 ms in the five runs recorded here, 4.15-4.25 ms in three runs an hour later; the check at 1.15 failed on it with the best of three), which is larger than any slack that still means "regression". 1.5 holds across that drift and still catches a doubling. Floors where a median would round to a budget that noise alone breaks: `over` 5 %, `jsP95` 2 ms, `frameP95` 5 ms (a CPU-drawn frame under 5 ms is inside the noise; `close panes` read 2.1-5.1 ms in three runs). A scenario's budget can be tightened by hand once a quiet machine or a display has measured it (`measured.slack` in the file says what produced it).
- A scenario at rest has `drawn: 0` and `cpu: 1` (1% of a core, the threshold of "CPU at rest" in this project): the rule, not a measurement × 1.15.
- `memMB` is the **highest reading any of the five runs reached × 1.15**, not the median: the resident set has two modes (Finding 3), and the median can fall in the low one.
- The frame budgets are regression guards over CPU-drawn numbers. Do not read `frameP95: 25.86` for the palette as a product target; the target is 8.3 ms on a GPU and unverified.
- `--check` runs three times (`--runs N` changes it) and fails when **even the best run** is over a budget (noise on a shared machine only slows a run, so a breach in every run is real); memory is held at its median. It also fails for a scenario with no entry in the file, so a new scenario brings its budget.

Proof that the check works (2026-11-07, on the tree named above): `bun scripts/perf.mjs --check` (three runs) exited 0 with no `!`; with `stream 8 panes, 1 open` lowered to `frameP95: 1.0` a one-run check printed `stream 8 panes, 1 open: frame p95 2.37 > 1` and exited 1; the budget was restored. Earlier checks failed and drove the slack (1.15 → 1.5), the 5 ms frame floor and the 300 s wait for the 5,000 chat items (one run slowed past 120 s when the machine was busy with other builds). `scripts/cpu.mjs --check` is implemented the same way and was **not** run against the budgets.

## Findings

1. **A pane taller than its view opened at its top, not its end (fixed).** `PaneScreen` starts empty and its first rows arrive after the view is built; `initial_scroll_index` is sent before the first layout and nsh's `follow_end` needs a measured end first (`anchor_end` ignores the first call), so on GTK the list stayed at row 0: the prompt, at the bottom of a 50-row pane in a 490 pt view, was hidden below a "166 new lines" pill. The headless engine clamps the jump and shows nothing wrong, which is why no existing test saw it (the new test `a_pane_whose_rows_arrive_after_the_view_opens_at_its_end` passes headless with and without the fix and only guards the headless path). Found by a screenshot of the streaming scenario; the X screen changed once a second instead of twenty times because only the scrolled-away top rows were visible. Fix (`native/app/src/pane_screen.rs`): once there are rows and a size, jump to the end once after 30 ms (`OPEN_SETTLE`). Guard on GTK: the scenario `stream 8 panes, 1 open` throws unless the screen's last row (`Working (`) is on screen.
2. **A focused text field draws 26-42 frames a second at rest, and costs 1.5% (the composer) to 5% (the palette) of a core.** `palette open` (6 s drawn, frame p95 22 ms, 5.2% CPU), the chat composer (`chat idle, empty`, `chat 5,000 items, idle at the end`: 26-30 fps) and a bare nsh `Input` with `autoFocus` in a ten-line app (26-42 fps; the same app without focus draws nothing) all do it, so it is nsh's or GTK's caret machinery under cairo, not our code, and it is unverified on a real display. Consequence: "an app at rest draws no frames" holds only while no field has the focus; the five scenarios without one (`idle board`, `idle pane`, `idle pane after streaming`, `idle with 20 blocked`, `idle board, 200 agents`) drew **0 frames in all five runs**. Nothing to fix here; the budgets for the scenarios with a focused field allow frames.
3. **RSS at rest is two numbers.** Right after start the app is at 291 MB (`idle board`); when the engine's idle collection runs (the engine collects after 0.3 s without a message or due timer) the resident set drops by about 130-190 MB (to 184-213 MB in the five runs recorded here, 105-147 MB in an earlier set of five), in some runs at the first quiet moment and in others never in a 5 s idle (`idle pane`: 313 [184-314]; `chat` window 257-270, no drop seen). That is why the median hides it and why `memMB` budgets the high mode. For scale, the same 5,000-item chat in the headless engine (`nsh test`, no GTK, no cairo) holds 103-108 MB, so most of the two modes is the window system and the dev host, not our data. The product target RSS < 150 MB is met only in the low mode, on this unoptimised build, and is unverified for a release build on a display.
4. **200 agents cost 47 MB and a 43% CPU burst on arrival, and the home scrolls at 16 ms per frame under cairo.** `200 agents arrive`: RSS 335 → 382 MB (348 → 401 MB in the high mode), 43% of a core over the 2 s window (the JS commit itself is 2.5 ms p95: the rest is mounting views), 5.5 ms frame p95. `project home scroll, 200 agents`: frame p95 16.3 ms (5% of frames over a refresh), 14.9% CPU. The sidebar is a virtualised `List`; the home's project cards are an `Each`, so every card and agent row of all 25 projects is mounted (the kit's own note: `Each` is for tens of rows). It is not a regression of this change; left as a finding. The fix would be to virtualise the cards or fold projects past a count. Not measured with a GPU, where the scroll should be cheaper.
5. **5,000 chat items are virtualised and bounded.** Window 2: 270 → 303 MB for the 5,000 items (+33 MB, 6.6 KB an item, reducer plus transcript model plus the rows near the window), flat while scrolling (303 → 308 MB over 12 scrolls), 3.2 ms frame p95 scrolling, 1.5% CPU at the end of the conversation (the focused composer, Finding 2). The arrival is one 42 ms JS commit (p95) once.
6. **Proportionality holds.** Streaming 50 rows with a progress bar and a spinner changing every tick rebinds 4.4 rows an update on average (the scroll once a second rebinds all 50), read to paint is 2.3 ms p50 and 3.2 ms p95 up to the end of the stream (the metric stops when the rows are set; GTK's drawing after it is the frame time above), and the number of reads follows the open panes: 20 a second for one open pane, 60 for three, one read each for the unwatched seven. Threads (75-77; 79-83 in the chat window with its keeper) and fds (20-21; 22-23) are flat across all scenarios: no leak seen.
7. **CPU at rest is 0.4-0.8% of a core, none of it ours.** `idle board` 0.8% [0.6-1.0] and `idle pane` 0.4% with zero frames drawn. A per-thread read of 12 s at rest: 0.42% `nsh-engine` and 0.17% `nsh-dev-client` (the development host's connection to its CLI; a packaged app has none), nothing in the engine, link or notifier threads of this app. Under the 1% line, so not a defect; the figure is the development host's.
8. **Splitting costs frames.** `open 2 more panes in splits` has the highest frame p95 of the interactions outside the 200-agent home (8.9 ms [6.5-10.1], 2% over a refresh) and `stream 8 panes, 3 open in splits` 7.3 ms: each open pane in a group has its own `PaneScreen` and composer. Both are CPU-drawn numbers; the 8.3 ms target is for a GPU.
9. **Code in the chat costs what the conversation did, plus the grammars' memory (2026-11-07, change `feat(chat): one code renderer`).** The five existing chat rows before and after the change, one run each on the same machine (the five-run medians above are the before): `chat 5,000 items, scrolled` frame p95 3.2 → 2.8 ms, JS 2.3 → 1.4 ms; `chat 5,000 items arrive` JS 42.1 → 45.3 ms; `chat idle, empty` RSS 270 → 289 MB. The +17-19 MB is `warmCode()`: the 13 usual tree-sitter grammars compiled and the TextMate set loaded on a background thread at start. Start is the same with and without it (633 ms against 637 ms, mean of six runs each, from `open` to the first `Board` row on the GTK development host under Xvfb: the call returns at once and the compiling is on another thread). A conversation with 1,250 code blocks scrolls with frame p95 3.4 ms over 41 drawn seconds and 319 MB, the same as the plain one. The first version of the streaming row had JS p95 39.8 ms: `splitFences` built a `RegExp` for every line of an open fence and `safeCode` tested two regular expressions per character, both again for every 20-line piece of a 36 KB fence; a closer built once per fence and one test over the whole text brought it to 6.0 ms. Rows at rest draw 0 frames except behind a focused composer (Finding 2), as before.

How the scenarios are driven (traps found while writing them, all about the `--target linux` harness): a test is cut after 30 s unless `test(name, body, timeout)` says otherwise; the first Escape in the palette clears the query and only the second closes it; `app.submit` on this target types a line break into a box that sends on Return (press the `Send message` button); the test file cannot import the native module (drive the scripted herdr from the entry, on a key); an app's assets must live under its entry's directory (hence the entries in the root).

## Not measured yet (unverified)

- **Real-GPU frame times**, at 120 Hz, on the RTX 3090 session: the owner's command is above. Nothing here says the 8.3 ms target is met or missed.
- **An optimised build**: every figure is the development host. Rust-side numbers (parse, commit, engine CPU) will be lower; `cargo bench` is the only release number.
- **RSS < 150 MB** as a product number, on a release build, after a minute of idling.
- **Wayland and X11 sessions**: only Xvfb was run.
- **Remote links**: the relay sends whole answers; projections and row deltas are optional optimisations to add only if a measured remote-link bottleneck asks for them. No scenario drives an ssh machine.
- **Release package size and start time**: the Linux package is one 70 MB executable (`make package`) before the highlighter, which adds about 28 MB raw and 3 MB gzipped by the bake-off in `docs/specs/chat-craft.md` (not measured in a release package: a release build was not made); cold-start time of a release build is unmeasured, the headless start above is the development host.

## Project switch (`switch project x20`, one run, Xvfb + cairo, debug host)

Each switch is one commit of 28.4 ms JS p95 plus 19.1 ms core p95 (the swap of a layout with a pane mirror and a chat or project card: about 48 ms, under the 50 ms budget of `docs/specs/context-switching.md`, and the first row is in that commit, so well under 120 ms). Frame p95 is 14.8 ms, CPU-drawn (a GPU is expected to do better; unverified). After 20 switches the figures are flat: RSS 372 to 375 MB (the Rust side's own 354 to 358), threads 75 to 75, descriptors 19 to 19, panes watched 1 to 1 (0 once the board is shown again). Budgets in `.perf/budgets.json` are this run x 1.5, from one run (`--runs 5` would be better; unmeasured). Not measured: the `PaneScreen` first-row time on a GPU.
