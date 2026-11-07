//! Reading a big text file by lines without reading it whole: a sparse index of where every 512th line starts, pages of
//! lines read from the nearest checkpoint, and a search that streams in 1 MB ranges.
//!
//! The index is built by one pass over the file ([`scan`]), which a thread runs while the viewer already shows the first
//! page: `lines` grows as the pass goes and the viewer's scroll range grows with it. A page is one range read from a
//! checkpoint, so showing line 40,000,000 of a log costs a read of a few kilobytes, not a scan.

use std::sync::atomic::{AtomicBool, Ordering};

use memchr::memchr_iter;
use parking_lot::Mutex;

use super::{EntryKind, FileError, FileErrorKind, Files, validate_path};

/// Lines between two checkpoints.
pub const STRIDE: u64 = 512;

/// Characters of one line that are kept: a minified JSON on one line must not become a megabyte string in a row.
pub const LINE_MAX: usize = 4000;

/// The range one read of a page or a scan asks for.
const RANGE: usize = 1024 * 1024;

/// A page read asks for this many bytes at a time; most pages are one read.
const PAGE_RANGE: usize = 64 * 1024;

/// What the pass has found out so far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Index {
    /// The file's size when the pass began.
    pub size: u64,
    /// Where lines `0, STRIDE, 2*STRIDE, ...` start.
    checkpoints: Vec<u64>,
    /// Lines counted so far (the last, unterminated one included once the pass reaches the end).
    pub lines: u64,
    /// Bytes the pass has covered.
    pub scanned: u64,
    /// The pass reached the end.
    pub done: bool,
}

impl Index {
    /// An index of a file of `size` bytes, nothing scanned yet.
    pub fn new(size: u64) -> Self {
        Self {
            size,
            checkpoints: vec![0],
            lines: 0,
            scanned: 0,
            done: size == 0,
        }
    }
}

/// The one pass over the file: counts lines, notes checkpoints, publishes after each range. Stops early on `cancel`.
pub fn scan(
    files: &dyn Files,
    path: &str,
    index: &Mutex<Index>,
    cancel: &AtomicBool,
) -> Result<(), FileError> {
    let size = index.lock().size;
    let mut at = 0u64;
    let mut newlines = 0u64;
    let mut last_byte = b'\n';
    while at < size {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let chunk = files.read(path, at, RANGE.min((size - at) as usize))?.data;
        if chunk.is_empty() {
            break;
        }
        let mut found = Vec::new();
        for pos in memchr_iter(b'\n', &chunk) {
            newlines += 1;
            // The line after the `newlines`-th newline starts just past it.
            if newlines.is_multiple_of(STRIDE) {
                found.push(at + pos as u64 + 1);
            }
        }
        last_byte = chunk[chunk.len() - 1];
        at += chunk.len() as u64;
        let mut index = index.lock();
        index.checkpoints.extend(found);
        index.scanned = at;
        index.lines = newlines;
    }
    let mut index = index.lock();
    // A last line with no newline after it is a line too.
    index.lines = newlines + u64::from(last_byte != b'\n' && at > 0);
    index.scanned = at;
    index.done = true;
    // A checkpoint at the very end names a line that does not exist.
    while index.checkpoints.len() > 1
        && (index.checkpoints.len() as u64 - 1) * STRIDE >= index.lines
    {
        index.checkpoints.pop();
    }
    Ok(())
}

fn cut(line: &[u8]) -> String {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let text = String::from_utf8_lossy(line);
    if text.chars().count() > LINE_MAX {
        let mut short: String = text.chars().take(LINE_MAX).collect();
        short.push('…');
        short
    } else {
        text.into_owned()
    }
}

/// Up to `count` lines starting at line `from`, read from the nearest checkpoint at or before it. Lines past what the
/// pass has reached so far are not returned (the caller asks again as `lines` grows); lines longer than [`LINE_MAX`] are cut.
pub fn read_lines(
    files: &dyn Files,
    path: &str,
    index: &Mutex<Index>,
    from: u64,
    count: usize,
) -> Result<Vec<String>, FileError> {
    let (start, skip, known, size) = {
        let index = index.lock();
        let block = (from / STRIDE) as usize;
        let Some(&start) = index.checkpoints.get(block) else {
            return Ok(Vec::new());
        };
        (start, from - block as u64 * STRIDE, index.lines, index.size)
    };
    if from >= known {
        return Ok(Vec::new());
    }
    let want = (count as u64).min(known - from) as usize;
    let mut out = Vec::with_capacity(want);
    let mut line = Vec::new();
    let mut at = start;
    let mut skipped = 0u64;
    'read: while at < size && out.len() < want {
        let chunk = files
            .read(path, at, PAGE_RANGE.min((size - at) as usize))?
            .data;
        if chunk.is_empty() {
            break;
        }
        at += chunk.len() as u64;
        let mut from_byte = 0;
        for pos in memchr_iter(b'\n', &chunk) {
            line.extend_from_slice(&chunk[from_byte..pos]);
            from_byte = pos + 1;
            if skipped < skip {
                skipped += 1;
            } else {
                out.push(cut(&line));
                if out.len() == want {
                    break 'read;
                }
            }
            line.clear();
        }
        line.extend_from_slice(&chunk[from_byte..]);
        // A line that is already far over the cut keeps no more bytes: its end is dropped anyway.
        if line.len() > LINE_MAX * 4 {
            line.truncate(LINE_MAX * 4);
        }
    }
    if out.len() < want && at >= size && !line.is_empty() && skipped >= skip {
        out.push(cut(&line));
    }
    Ok(out)
}

fn matches(line: &[u8], query: &[u8]) -> bool {
    if query.is_empty() || line.len() < query.len() {
        return false;
    }
    line.windows(query.len())
        .any(|w| w.eq_ignore_ascii_case(query))
}

/// The line number of the next line after `from` (before it, for `forward` false) that holds `query`, ignoring ASCII case;
/// wraps once around the end (or the start). `from` `None` starts at the first line (the last, backwards). The search
/// never reads past what the pass has indexed, so a match can still be missed while the pass runs: the caller says
/// `still counting` then. Returns `None` when nothing matches. `cancel` stops it.
pub fn find(
    files: &dyn Files,
    path: &str,
    index: &Mutex<Index>,
    query: &str,
    from: Option<u64>,
    forward: bool,
    cancel: &AtomicBool,
) -> Result<Option<u64>, FileError> {
    let query = query.as_bytes();
    if query.is_empty() {
        return Ok(None);
    }
    let lines = index.lock().lines;
    if lines == 0 {
        return Ok(None);
    }
    if forward {
        let first = from.map_or(0, |f| f + 1);
        if let Some(hit) = find_forward(files, path, index, query, first, lines, cancel)? {
            return Ok(Some(hit));
        }
        // Wrapped: from the top to where it began.
        let stop = from.map_or(0, |f| f + 1).min(lines);
        return find_forward(files, path, index, query, 0, stop, cancel);
    }
    let last = from.unwrap_or(lines).min(lines);
    if let Some(hit) = find_backward_range(files, path, index, query, last, 0, cancel)? {
        return Ok(Some(hit));
    }
    find_backward_range(files, path, index, query, lines, last, cancel)
}

/// The first line in `[first, end)` that holds `query`, streaming from the checkpoint at or before `first`.
fn find_forward(
    files: &dyn Files,
    path: &str,
    index: &Mutex<Index>,
    query: &[u8],
    first: u64,
    end: u64,
    cancel: &AtomicBool,
) -> Result<Option<u64>, FileError> {
    if first >= end {
        return Ok(None);
    }
    let (start, mut number, size) = {
        let index = index.lock();
        let block = (first / STRIDE) as usize;
        let Some(&start) = index.checkpoints.get(block) else {
            return Ok(None);
        };
        (start, block as u64 * STRIDE, index.size)
    };
    let mut at = start;
    let mut line = Vec::new();
    while at < size && number < end {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let chunk = files.read(path, at, RANGE.min((size - at) as usize))?.data;
        if chunk.is_empty() {
            break;
        }
        at += chunk.len() as u64;
        let mut from_byte = 0;
        for pos in memchr_iter(b'\n', &chunk) {
            line.extend_from_slice(&chunk[from_byte..pos]);
            from_byte = pos + 1;
            if number >= first && number < end && matches(&line, query) {
                return Ok(Some(number));
            }
            number += 1;
            line.clear();
            if number >= end {
                return Ok(None);
            }
        }
        line.extend_from_slice(&chunk[from_byte..]);
    }
    if !line.is_empty() && number >= first && number < end && matches(&line, query) {
        return Ok(Some(number));
    }
    Ok(None)
}

/// The last line in `[floor, before)` that holds `query`, a block of [`STRIDE`] lines at a time from the end.
fn find_backward_range(
    files: &dyn Files,
    path: &str,
    index: &Mutex<Index>,
    query: &[u8],
    before: u64,
    floor: u64,
    cancel: &AtomicBool,
) -> Result<Option<u64>, FileError> {
    let mut end = before;
    while end > floor {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let block_start = ((end - 1) / STRIDE * STRIDE).max(floor);
        let rows = read_lines(
            files,
            path,
            index,
            block_start,
            (end - block_start) as usize,
        )?;
        for (i, row) in rows.iter().enumerate().rev() {
            if matches(row.as_bytes(), query) {
                return Ok(Some(block_start + i as u64));
            }
        }
        end = block_start;
    }
    Ok(None)
}

/// Checks `path` is a regular file the viewer can page through, and returns its size.
pub fn size_of(files: &dyn Files, path: &str) -> Result<u64, FileError> {
    validate_path(path)?;
    let stat = files.stat(path)?;
    match stat.kind {
        EntryKind::File => Ok(stat.size),
        EntryKind::Dir => Err(FileError::new(
            FileErrorKind::IsADirectory,
            format!("{path} is a folder"),
        )),
        EntryKind::Other => Err(FileError::new(
            FileErrorKind::Other,
            format!("{path} is not a regular file"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::testmem::Mem;

    fn log(n: usize) -> Vec<u8> {
        (0..n)
            .map(|i| {
                format!(
                    "{i:07} line {i} {}\n",
                    if i % 1000 == 777 {
                        "NEEDLE here"
                    } else {
                        "plain"
                    }
                )
            })
            .collect::<String>()
            .into_bytes()
    }

    fn indexed(files: &Mem, path: &str) -> Mutex<Index> {
        let index = Mutex::new(Index::new(size_of(files, path).unwrap()));
        scan(files, path, &index, &AtomicBool::new(false)).unwrap();
        index
    }

    #[test]
    fn the_pass_counts_every_line_and_a_page_is_exact_wherever_it_starts() {
        let files = Mem::with("/big.log", log(5000));
        let index = indexed(&files, "/big.log");
        assert_eq!(index.lock().lines, 5000);
        assert!(index.lock().done);
        for from in [0u64, 1, 511, 512, 513, 2999, 4990] {
            let rows = read_lines(&files, "/big.log", &index, from, 10).unwrap();
            let want = ((from as usize)..(from as usize + 10).min(5000)).count();
            assert_eq!(rows.len(), want, "from {from}");
            assert!(
                rows[0].starts_with(&format!("{from:07} line")),
                "from {from}: {}",
                rows[0]
            );
        }
        assert!(
            read_lines(&files, "/big.log", &index, 5000, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_page_far_in_reads_a_few_kilobytes_not_the_file() {
        let files = Mem::with("/big.log", log(200_000));
        let index = indexed(&files, "/big.log");
        let before = files.reads().len();
        let rows = read_lines(&files, "/big.log", &index, 150_000, 40).unwrap();
        assert!(rows[0].starts_with("0150000"));
        let page_reads = &files.reads()[before..];
        assert!(page_reads.len() <= 2, "{page_reads:?}");
        assert!(page_reads.iter().all(|(_, n)| *n <= 64 * 1024));
    }

    #[test]
    fn a_last_line_without_a_newline_and_crlf_endings_are_handled() {
        let files = Mem::with("/a.txt", b"one\r\ntwo\r\nthree".to_vec());
        let index = indexed(&files, "/a.txt");
        assert_eq!(index.lock().lines, 3);
        assert_eq!(
            read_lines(&files, "/a.txt", &index, 0, 10).unwrap(),
            vec!["one", "two", "three"]
        );
        let files = Mem::with("/b.txt", b"one\ntwo\n".to_vec());
        assert_eq!(indexed(&files, "/b.txt").lock().lines, 2);
        let files = Mem::with("/e.txt", Vec::new());
        let index = indexed(&files, "/e.txt");
        let state = index.lock().clone();
        assert_eq!((state.lines, state.done), (0, true));
    }

    #[test]
    fn the_pass_works_when_a_machine_returns_less_than_asked() {
        let mut files = Mem::with("/s.log", log(3000));
        files.cap = 10_000;
        let index = indexed(&files, "/s.log");
        assert_eq!(index.lock().lines, 3000);
        let rows = read_lines(&files, "/s.log", &index, 1500, 3).unwrap();
        assert!(rows[0].starts_with("0001500"));
    }

    #[test]
    fn a_very_long_line_is_cut_with_an_ellipsis_and_a_split_character_survives() {
        let mut body = "é".repeat(LINE_MAX * 3).into_bytes();
        body.extend_from_slice(b"\nshort\n");
        let files = Mem::with("/j.json", body);
        let index = indexed(&files, "/j.json");
        let rows = read_lines(&files, "/j.json", &index, 0, 2).unwrap();
        assert_eq!(rows[0].chars().count(), LINE_MAX + 1);
        assert!(rows[0].ends_with('…') && rows[0].starts_with("éé"));
        assert_eq!(rows[1], "short");
    }

    #[test]
    fn find_walks_forward_and_back_and_wraps() {
        let files = Mem::with("/big.log", log(5000));
        let index = indexed(&files, "/big.log");
        let go = |from, forward| {
            find(
                &files,
                "/big.log",
                &index,
                "needle",
                from,
                forward,
                &AtomicBool::new(false),
            )
            .unwrap()
        };
        assert_eq!(go(None, true), Some(777));
        assert_eq!(go(Some(777), true), Some(1777));
        assert_eq!(go(Some(4777), true), Some(777), "wraps to the top");
        assert_eq!(go(Some(1777), false), Some(777));
        assert_eq!(go(Some(777), false), Some(4777), "wraps to the end");
        assert_eq!(go(None, false), Some(4777));
        assert_eq!(
            find(
                &files,
                "/big.log",
                &index,
                "nothing like this",
                None,
                true,
                &AtomicBool::new(false)
            )
            .unwrap(),
            None
        );
    }

    #[test]
    fn find_streams_in_megabyte_ranges_and_a_cancel_stops_it() {
        let files = Mem::with("/big.log", log(200_000));
        let index = indexed(&files, "/big.log");
        let before = files.reads().len();
        let hit = find(
            &files,
            "/big.log",
            &index,
            "NEEDLE",
            Some(500),
            true,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(hit, Some(777));
        assert!(
            files.reads()[before..]
                .iter()
                .all(|(_, n)| *n <= 1024 * 1024)
        );
        let stopped = find(
            &files,
            "/big.log",
            &index,
            "zzz",
            None,
            true,
            &AtomicBool::new(true),
        )
        .unwrap();
        assert_eq!(stopped, None);
    }

    #[test]
    fn a_cancelled_pass_stops_and_leaves_the_index_partial() {
        let files = Mem::with("/big.log", log(100_000));
        let index = Mutex::new(Index::new(files.stat("/big.log").unwrap().size));
        scan(&files, "/big.log", &index, &AtomicBool::new(true)).unwrap();
        assert!(!index.lock().done);
        assert!(files.reads().is_empty());
    }
}
