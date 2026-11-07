# Performance

What is measured, where, and how to read it. **There are no budgets yet:** they are set from measured runs of the scenarios in `.perf/` on a release build (plan step 8.2), not guessed. Every number below is therefore a way to measure, not a promise. What was not measured on this machine is marked unverified.

An app at rest draws no frames and uses about 0% CPU (nsh draws only on change). A scenario that breaks that is a bug.

## The developer panel

`Ctrl+Shift+D` (`devPanel` in `lib/shortcuts.ts`) opens a panel with one line per metric, refreshed twice a second while it is open. Nothing runs while it is closed except `timing` recording (two clock reads per measured call). Metrics are registered with `registerMetric` (`lib/perf.ts`); the Rust ones are in `lib/native-metrics.ts` and come from one `Herdr.metrics()` call per refresh (`native/app/src/metrics.rs`). Panel lines have no health colour until budgets exist.

| Metric (panel label) | What it is | How it is measured | Covers / does not cover |
|---|---|---|---|
| `FPS`, `JS lag` | Frames the JS thread saw per second and its p95 gap; how late a 100 ms timer fires | `requestAnimationFrame` gaps and a 100 ms interval, rolling window of 300 (`lib/perf.ts`) | The JS thread only; GPU and compositor time are `--fps`'s |
| `Read to paint` | Latency from herdr reporting a pane's activity to `PaneScreen` setting the new rows on the view; p50 and p95 | The scheduler stamps the first unread `pane_updated` activity of a watch (`Watch::activity` in `engine/panes.rs`); the read that publishes a changed screen carries the stamp (`PaneFeed::activity_at`); `PaneScreen` reports `elapsed()` once per screen when it sets the rows (`News::pull` in `pane_screen.rs`) | Event arrival at the scheduler, the 50 ms read gap, `pane.read`, parse, publish, task wake-up, setting the rows. Does **not** cover GTK laying out and drawing the frame after that (unverified until measured on a display), nor the time between herdr's own change and its event |
| `Pane reads` | `pane.read` answers per second, all watched panes | Timestamps of answered reads, over the last 5 seconds (the first seconds are divided by the time since the first read) | Only the screen reads of watched panes (`read_screen`); the card previews' reads and answer re-reads are not counted |
| `Parse` | Microseconds per row to turn a pane's ANSI text into rows, mean and p95 | `Instant` around `Screen::parse` in `read_screen`, divided by the row count, one sample per read, last 300 | Parsing only (`herdr-core` `screen`); `benches/parse.rs` is the same code in isolation |
| `Rows rebound` | Rows `PaneScreen` rebinds per screen update (mean, and the most in one update) | A row whose `Arc` is unchanged keeps its views; the count is rows whose `Arc` differs (`metrics::changed_rows`) plus rows that appeared or went | The proportionality the plan asks for: one changed row of 50 should read about 1, not 50 |
| `Memory` | Resident memory of the app | `VmRSS` of `/proc/self/status` | The whole process: engine, JS heap, GTK |
| `Threads · fds` | OS threads and open file descriptors | `Threads` of `/proc/self/status`; entries of `/proc/self/fd` (minus the directory handle) | A leak shows as a count that only climbs while the same panes are open |

All Rust figures are `0` until a sample exists, and `-` in the panel for the latency and parse lines. They are process-wide (all panes, all machines).

## Scenarios

`bun scripts/perf.mjs` runs `.perf/scenarios.test.tsx` in a real GTK window with nsh's monitor (`--fps`), reads its one line per second (frame rate, main-thread time per frame, JS and core time per commit, CPU, memory) and prints a row per scenario; `bun scripts/cpu.mjs` reads the host process's CPU time from `/proc` between scenario markers (the process the script spawned, never one found by name). Both need a display for GPU numbers; without one they run under Xvfb with the cairo renderer, which is CPU-drawn, so frame times are an upper bound and only counts and ratios carry over. The core parser has its own bench: `cargo bench --manifest-path native/core/Cargo.toml` (plain `main`, prints ns per row).

Headless proportionality: `nsh test --trace` shows the mount-item count of a commit; a change of one row of a pane must cost a fraction of changing every row (the test in `native/app` asserts the ratio, not a time).

## Not measured yet

- Budgets (`.perf/budgets.json`): none. Plan step 8.2 measures the scenarios on a release build (`nsh run . --target linux --release --fps`) and sets each budget to the measurement times 1.15.
- Real-GPU frame times (this machine's RTX 3090 under a real session): unverified, there is no display in the agent sessions.
- Remote links: the relay sends whole answers; projections and row deltas are optional optimisations to add only if a measured remote-link bottleneck asks for them.
- Release package size and start time: the Linux package is one 70 MB executable (`make package`); cold-start time is unmeasured.
