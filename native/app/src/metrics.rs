//! Developer metrics: what only the Rust side can see about the live pane path, for the dev panel
//! (`mod+shift+d`) and `docs/PERFORMANCE.md`. Nothing here is a budget: it measures.
//!
//! The engine and `PaneScreen` record into one process-wide [`Recorder`] (a lock and a push per event,
//! cheap next to a socket read); `Herdr.metrics()` reads it, twice a second at most while the panel is
//! open, and never touches the engine, so it works before `Herdr.configure` and in every test.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use nsh_core::prelude::*;
use parking_lot::Mutex;

/// Samples a rolling window keeps, as the TSX side's (`lib/perf.ts`).
const WINDOW: usize = 300;

/// How far back the reads-per-second figure looks.
const RATE_WINDOW: Duration = Duration::from_secs(5);

/// The last [`WINDOW`] samples of one measurement.
#[derive(Debug, Default)]
pub struct Rolling {
    samples: VecDeque<f64>,
}

impl Rolling {
    /// Adds a sample, dropping the oldest past the window.
    pub fn push(&mut self, value: f64) {
        if self.samples.len() == WINDOW {
            self.samples.pop_front();
        }
        self.samples.push_back(value);
    }

    /// How many samples are held.
    pub fn len(&self) -> usize {
        self.samples.len()
    }

    /// Whether no sample was taken yet.
    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// The mean of the window; 0 when empty.
    pub fn mean(&self) -> f64 {
        if self.samples.is_empty() {
            0.0
        } else {
            self.samples.iter().sum::<f64>() / self.samples.len() as f64
        }
    }

    /// The `p` quantile (0 to 1) of the window; 0 when empty. Same rule as the TSX side's `percentile`.
    pub fn quantile(&self, p: f64) -> f64 {
        if self.samples.is_empty() {
            return 0.0;
        }
        let mut sorted: Vec<f64> = self.samples.iter().copied().collect();
        sorted.sort_by(f64::total_cmp);
        let at = ((sorted.len() as f64 * p).floor() as usize).min(sorted.len() - 1);
        sorted[at]
    }
}

/// Events per second over the last [`RATE_WINDOW`], with an injectable clock.
#[derive(Debug, Default)]
pub struct Rate {
    stamps: VecDeque<Instant>,
    first: Option<Instant>,
}

impl Rate {
    /// Notes one event at `now`.
    pub fn record(&mut self, now: Instant) {
        self.first.get_or_insert(now);
        self.stamps.push_back(now);
        self.forget(now);
    }

    fn forget(&mut self, now: Instant) {
        while self
            .stamps
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) > RATE_WINDOW)
        {
            self.stamps.pop_front();
        }
    }

    /// Events per second as of `now`: over the window once it is full, over the time since the first
    /// event before that (so a pane read for one second does not read as a fifth of its rate).
    pub fn per_second(&mut self, now: Instant) -> f64 {
        self.forget(now);
        let Some(first) = self.first else { return 0.0 };
        let span = now
            .saturating_duration_since(first)
            .min(RATE_WINDOW)
            .as_secs_f64();
        if span < 0.001 || self.stamps.is_empty() {
            0.0
        } else {
            self.stamps.len() as f64 / span
        }
    }
}

/// The rows of `next` that are not the rows of `last` (a different `Arc`): exactly the rows `PaneScreen`
/// rebinds, since a row that kept its `Arc` keeps its views. A longer or shorter screen counts the rows
/// that appeared or went.
pub fn changed_rows(last: &herdr_core::screen::Screen, next: &herdr_core::screen::Screen) -> usize {
    let moved = last
        .rows
        .iter()
        .zip(&next.rows)
        .filter(|(a, b)| !std::sync::Arc::ptr_eq(a, b))
        .count();
    moved + last.rows.len().abs_diff(next.rows.len())
}

/// What the process itself uses. Linux reads `/proc/self`, macOS asks `proc_pidinfo`; anywhere else the
/// figures are 0, which the developer panel shows as unmeasured rather than as a small number.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Process {
    /// Resident memory in kilobytes.
    pub rss_kb: u64,
    /// OS threads.
    pub threads: u32,
}

/// Reads `VmRSS` and `Threads` out of the text of `/proc/self/status`; a missing line is 0.
#[cfg(target_os = "linux")]
pub fn parse_status(status: &str) -> Process {
    let number = |key: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(key))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0)
    };
    Process {
        rss_kb: number("VmRSS:"),
        threads: number("Threads:") as u32,
    }
}

#[cfg(target_os = "linux")]
fn process() -> Process {
    std::fs::read_to_string("/proc/self/status")
        .map(|s| parse_status(&s))
        .unwrap_or_default()
}

/// Open file descriptors of this process; 0 where `/proc` is missing. The directory handle used to count
/// is itself one of the entries, so it is taken off.
#[cfg(target_os = "linux")]
fn open_fds() -> u32 {
    std::fs::read_dir("/proc/self/fd")
        .map(|dir| dir.count().saturating_sub(1) as u32)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn process() -> Process {
    // SAFETY: `proc_pidinfo` writes at most `size` bytes into `info`, a zeroed plain-data struct of exactly
    // that size, and the return value says how many it wrote.
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let wrote = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDTASKINFO,
            0,
            (&raw mut info).cast(),
            size,
        )
    };
    if wrote != size {
        return Process::default();
    }
    Process {
        rss_kb: info.pti_resident_size / 1024,
        threads: info.pti_threadnum.max(0) as u32,
    }
}

#[cfg(target_os = "macos")]
fn open_fds() -> u32 {
    // SAFETY: with no buffer `proc_pidinfo` only reports the bytes the descriptor list would take.
    let bytes = unsafe {
        libc::proc_pidinfo(
            libc::getpid(),
            libc::PROC_PIDLISTFDS,
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    (bytes.max(0) as usize / std::mem::size_of::<libc::proc_fdinfo>()) as u32
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process() -> Process {
    Process::default()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn open_fds() -> u32 {
    0
}

/// Everything recorded since the process started (or the window rolled over).
#[derive(Default)]
pub struct Recorder {
    reads: Rate,
    /// Parse time per row, microseconds, one sample per read.
    parse_us_per_row: Rolling,
    /// Rows rebound per screen update.
    rebound: Rolling,
    /// Herdr's pane activity to `PaneScreen` setting the rows, milliseconds.
    read_to_paint_ms: Rolling,
}

impl Recorder {
    /// A `pane.read` that answered.
    pub fn read(&mut self, now: Instant) {
        self.reads.record(now);
    }

    /// A screen parsed: `rows` rows in `took`. An empty screen is not a sample (there is no per-row figure).
    pub fn parsed(&mut self, rows: usize, took: Duration) {
        if rows > 0 {
            self.parse_us_per_row
                .push(took.as_secs_f64() * 1e6 / rows as f64);
        }
    }

    /// `PaneScreen` took a new screen of which `rows` rows differ from the one it showed.
    pub fn rebound(&mut self, rows: usize) {
        self.rebound.push(rows as f64);
    }

    /// A screen whose cause was activity `waited` ago is now set on the view.
    pub fn painted(&mut self, waited: Duration) {
        self.read_to_paint_ms.push(waited.as_secs_f64() * 1e3);
    }

    /// The figures as of `now`.
    pub fn snapshot(&mut self, now: Instant) -> Metrics {
        Metrics {
            pane_reads_per_second: self.reads.per_second(now),
            parse_us_per_row: self.parse_us_per_row.mean(),
            parse_us_per_row_p95: self.parse_us_per_row.quantile(0.95),
            rows_rebound_per_update: self.rebound.mean(),
            rows_rebound_last: self.rebound.quantile(1.0) as u32,
            read_to_paint_samples: self.read_to_paint_ms.len() as u32,
            read_to_paint_ms_p50: self.read_to_paint_ms.quantile(0.5),
            read_to_paint_ms_p95: self.read_to_paint_ms.quantile(0.95),
            rss_mb: 0.0,
            threads: 0,
            open_fds: 0,
            watched_panes: 0,
        }
    }
}

static RECORDER: Mutex<Option<Recorder>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut Recorder) -> R) -> R {
    f(RECORDER.lock().get_or_insert_with(Recorder::default))
}

/// A `pane.read` answered (the engine calls this).
pub fn pane_read() {
    with(|r| r.read(Instant::now()));
}

/// A screen of `rows` rows was parsed in `took` (the engine calls this).
pub fn screen_parsed(rows: usize, took: Duration) {
    with(|r| r.parsed(rows, took));
}

/// `PaneScreen` set a new screen of which `rows` rows differ from the previous one.
pub fn rows_rebound(rows: usize) {
    with(|r| r.rebound(rows));
}

/// A screen that was caused by herdr activity at `activity` is now set on a view.
pub fn screen_painted(activity: Instant) {
    with(|r| r.painted(activity.elapsed()));
}

/// Figures about the live pane path and the process, for the developer panel. Latency, rate and
/// per-row figures are over the last 300 samples (the reads of the last 5 seconds for the rate); a
/// figure with no sample yet is 0.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct Metrics {
    /// `pane.read` answers per second, all panes together, over the last 5 seconds.
    pub pane_reads_per_second: f64,
    /// Parsing a pane's ANSI text into rows, microseconds per row, mean of the last 300 reads.
    pub parse_us_per_row: f64,
    /// The same at the 95th percentile.
    pub parse_us_per_row_p95: f64,
    /// Rows `PaneScreen` rebinds per screen update, mean of the last 300 updates: an unchanged row costs nothing.
    pub rows_rebound_per_update: f64,
    /// The most rows rebound by one of the last 300 updates.
    pub rows_rebound_last: u32,
    /// How many screens the read-to-paint figures are made of.
    pub read_to_paint_samples: u32,
    /// From herdr reporting a pane's activity to `PaneScreen` setting the rows on the view, median,
    /// milliseconds. It ends when the rows are set, not when GTK has drawn the frame.
    pub read_to_paint_ms_p50: f64,
    /// The same at the 95th percentile.
    pub read_to_paint_ms_p95: f64,
    /// Resident memory of the app, megabytes.
    pub rss_mb: f64,
    /// OS threads of the app.
    pub threads: u32,
    /// Open file descriptors of the app.
    pub open_fds: u32,
    /// Panes with a mirror open (`watchPane`); an unwatched pane is never read. Flat across project switches.
    pub watched_panes: u32,
}

/// The recorded figures plus the process's own, read now.
pub fn read() -> Metrics {
    let mut metrics = with(|r| r.snapshot(Instant::now()));
    let process = process();
    metrics.rss_mb = process.rss_kb as f64 / 1024.0;
    metrics.threads = process.threads;
    metrics.open_fds = open_fds();
    metrics
}

#[cfg(test)]
mod tests {
    use super::*;
    use herdr_core::screen::Screen;
    use std::sync::Arc;

    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    #[test]
    fn a_window_keeps_only_the_newest_samples() {
        let mut w = Rolling::default();
        for i in 0..(WINDOW + 50) {
            w.push(i as f64);
        }
        assert_eq!(w.len(), WINDOW);
        // 0..49 fell out: the smallest left is 50
        assert_eq!(w.quantile(0.0), 50.0);
        assert_eq!(w.quantile(1.0), (WINDOW + 49) as f64);
    }

    #[test]
    fn quantiles_of_an_empty_window_are_zero_and_of_one_sample_that_sample() {
        let mut w = Rolling::default();
        assert_eq!((w.mean(), w.quantile(0.95)), (0.0, 0.0));
        w.push(7.0);
        assert_eq!(
            (w.mean(), w.quantile(0.95), w.quantile(0.5)),
            (7.0, 7.0, 7.0)
        );
    }

    #[test]
    fn the_95th_percentile_ignores_a_single_outlier_below_it_and_shows_a_tail() {
        let mut w = Rolling::default();
        for _ in 0..99 {
            w.push(1.0);
        }
        w.push(100.0);
        assert_eq!(w.quantile(0.95), 1.0);
        for _ in 0..10 {
            w.push(100.0);
        }
        assert_eq!(w.quantile(0.95), 100.0);
    }

    #[test]
    fn a_rate_counts_events_in_the_window_and_forgets_older_ones() {
        let base = Instant::now();
        let mut rate = Rate::default();
        assert_eq!(rate.per_second(base), 0.0);
        // 20 reads in the first second: the figure is read over the second that passed, not over 5
        for i in 0..20 {
            rate.record(at(base, i * 50));
        }
        let early = rate.per_second(at(base, 1000));
        assert!((early - 20.0).abs() < 0.5, "{early}");
        // ten seconds of nothing: the reads left the window
        assert_eq!(rate.per_second(at(base, 11_000)), 0.0);
    }

    #[test]
    fn a_steady_rate_reads_as_that_rate_once_the_window_is_full() {
        let base = Instant::now();
        let mut rate = Rate::default();
        for i in 0..400 {
            rate.record(at(base, i * 50)); // 20 a second for 20 s
        }
        let now = at(base, 400 * 50);
        let figure = rate.per_second(now);
        assert!((figure - 20.0).abs() < 0.5, "{figure}");
    }

    fn screen(rows: &[&str]) -> Screen {
        Screen::parse_text(&rows.join("\n"), None)
    }

    #[test]
    fn only_rows_that_changed_count_as_rebound() {
        let first = screen(&["a", "b", "c", "d"]);
        let same = Screen {
            cols: first.cols,
            rows: first.rows.clone(),
        };
        assert_eq!(changed_rows(&first, &same), 0);

        // one row replaced by a different one: one rebind
        let mut one = first.rows.clone();
        one[2] = screen(&["x"]).rows[0].clone();
        let one = Screen {
            cols: first.cols,
            rows: one,
        };
        assert_eq!(changed_rows(&first, &one), 1);

        // the screen grew by two rows: the two new rows are rebound too
        let mut longer = first.rows.clone();
        longer.extend(screen(&["y", "z"]).rows);
        let longer = Screen {
            cols: first.cols,
            rows: longer,
        };
        assert_eq!(changed_rows(&first, &longer), 2);
        assert!(Arc::ptr_eq(&first.rows[0], &longer.rows[0]));
    }

    #[test]
    fn parse_time_is_per_row_and_an_empty_screen_is_no_sample() {
        let mut r = Recorder::default();
        r.parsed(0, Duration::from_millis(1));
        assert_eq!(r.snapshot(Instant::now()).parse_us_per_row, 0.0);
        r.parsed(50, Duration::from_micros(500));
        assert!((r.snapshot(Instant::now()).parse_us_per_row - 10.0).abs() < 1e-6);
    }

    #[test]
    fn latency_and_rebinds_surface_in_the_snapshot() {
        let mut r = Recorder::default();
        for ms in [4, 5, 6, 40] {
            r.painted(Duration::from_millis(ms));
        }
        r.rebound(1);
        r.rebound(50);
        let m = r.snapshot(Instant::now());
        assert_eq!(m.read_to_paint_samples, 4);
        assert_eq!(m.read_to_paint_ms_p50, 6.0);
        assert_eq!(m.read_to_paint_ms_p95, 40.0);
        assert_eq!(m.rows_rebound_last, 50);
        assert_eq!(m.rows_rebound_per_update, 25.5);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn the_status_file_gives_memory_and_threads_and_a_missing_line_is_zero() {
        let text = "Name:\therdr\nVmPeak:\t  900000 kB\nVmRSS:\t  123456 kB\nThreads:\t17\n";
        assert_eq!(
            parse_status(text),
            Process {
                rss_kb: 123456,
                threads: 17
            }
        );
        assert_eq!(parse_status("nothing useful"), Process::default());
    }

    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn this_process_reports_itself() {
        let m = read();
        assert!(m.rss_mb > 1.0, "{m:?}");
        assert!(m.threads >= 1, "{m:?}");
        assert!(m.open_fds >= 3, "{m:?}");
    }
}
