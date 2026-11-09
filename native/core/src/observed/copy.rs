//! The saved copy of an observed chat: the last records `follow` sent for the pane's log, with the byte offsets
//! they ended at, so the next open shows them at once and asks the keeper only for what came after (`follow
//! --from <end>`).
//!
//! A copy is a contiguous run of the log: `start` is where its first record begins, `end` where the last one
//! ends. It is trusted only as far as the follower's own checks go: the keeper says `R` when the file is not the
//! one the offset came from, and a look for the pane's log must agree with `path` (pane ids are reused).

use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::cache::{decode_lines, encode_lines};

const VERSION: u32 = 1;

/// The records a copy keeps: the newest ones; older ones drop off the front.
pub const MAX_RECORDS: usize = 4_000;

/// The text a copy keeps (the records' JSON, not what it takes on disk, which is deflated).
pub const MAX_BYTES: usize = 1024 * 1024;

/// What is said about the records. Offsets are in the log file's own bytes.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Header {
    v: u32,
    /// The agent's kind: a pane id can come back as another agent after a herdr restart, and its log is not
    /// mapped by this one's mapper.
    kind: String,
    path: String,
    start: u64,
    end: u64,
    saved_ms: u64,
}

/// A copy read back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    /// The log file the records came from.
    pub path: String,
    /// Where the first record begins.
    pub start: u64,
    /// Where the last record ends: the offset the next read resumes from.
    pub end: u64,
    /// When it was saved (unix milliseconds).
    pub saved_ms: u64,
    /// Each record's end offset and JSON body, in file order.
    pub records: Vec<(u64, String)>,
}

impl Saved {
    /// `None` for anything that is not a copy this version wrote for an agent of `kind`, or whose offsets do not
    /// run in order up to its `end`: a copy that cannot be resumed from is no copy.
    pub fn decode(bytes: &[u8], kind: &str) -> Option<Saved> {
        let (header, lines): (Header, _) = decode_lines(bytes)?;
        if header.v != VERSION || header.kind != kind || header.path.is_empty() {
            return None;
        }
        let mut records = Vec::with_capacity(lines.len());
        let mut at = header.start;
        for line in lines {
            let (end, json) = line.split_once('\t')?;
            let end: u64 = end.parse().ok()?;
            if end <= at || json.is_empty() {
                return None;
            }
            at = end;
            records.push((end, json.to_owned()));
        }
        if records.is_empty() || at != header.end {
            return None;
        }
        Some(Saved {
            path: header.path,
            start: header.start,
            end: header.end,
            saved_ms: header.saved_ms,
            records,
        })
    }
}

/// The records of the log being followed, as far as a copy keeps them.
#[derive(Default)]
pub struct Window {
    path: String,
    start: u64,
    end: u64,
    /// Each record's end offset and body.
    records: VecDeque<(u64, String)>,
    bytes: usize,
}

impl Window {
    /// The window a saved copy continues in.
    pub fn from_saved(saved: Saved) -> Window {
        let bytes = saved.records.iter().map(|(_, json)| json.len()).sum();
        Window {
            path: saved.path,
            start: saved.start,
            end: saved.end,
            records: saved.records.into(),
            bytes,
        }
    }

    /// Another log is followed: nothing of the last one belongs here.
    pub fn begin(&mut self, path: &str) {
        path.clone_into(&mut self.path);
        self.restart(0);
    }

    /// A read from scratch starts at byte `at`: what was kept is not part of it.
    pub fn restart(&mut self, at: u64) {
        self.records.clear();
        self.bytes = 0;
        self.start = at;
        self.end = at;
    }

    /// The record that ends at `end`. The oldest drop once there are too many or too much.
    pub fn push(&mut self, end: u64, json: &str) {
        // One line each in the file: a record that cannot be one is left out, and with it everything before.
        if json.is_empty() || json.contains('\n') {
            self.restart(end);
            return;
        }
        self.end = end;
        self.bytes += json.len();
        self.records.push_back((end, json.to_owned()));
        while self.records.len() > MAX_RECORDS || self.bytes > MAX_BYTES {
            let Some((at, dropped)) = self.records.pop_front() else {
                break;
            };
            self.bytes -= dropped.len();
            self.start = at;
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// The window as a file for an agent of `kind`; `None` while it holds nothing (what is on disk is older and
    /// still resumable, an empty copy would hide it).
    pub fn encode(&self, kind: &str, saved_ms: u64) -> Option<Vec<u8>> {
        if self.records.is_empty() || self.path.is_empty() {
            return None;
        }
        let lines: Vec<String> = self
            .records
            .iter()
            .map(|(end, json)| format!("{end}\t{json}"))
            .collect();
        let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
        let header = Header {
            v: VERSION,
            kind: kind.to_owned(),
            path: self.path.clone(),
            start: self.start,
            end: self.end,
            saved_ms,
        };
        Some(encode_lines(&header, &lines))
    }
}

/// Now, as unix milliseconds.
pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A window of `n` records of `len` bytes each, the i-th (from 1) ending at `i * 10`.
    fn window(n: u64, len: usize) -> Window {
        let mut w = Window::default();
        w.begin("/home/dev/.omp/agent/sessions/p/log.jsonl");
        for i in 1..=n {
            w.push(i * 10, &"x".repeat(len));
        }
        w
    }

    #[test]
    fn the_oldest_records_drop_off_the_front_and_start_follows_them() {
        let w = window(MAX_RECORDS as u64 + 5, 1);
        assert_eq!(w.len(), MAX_RECORDS);
        let saved = Saved::decode(&w.encode("omp", 7).expect("encoded"), "omp").expect("decoded");
        // Five dropped: the sixth begins where the fifth ended.
        assert_eq!(saved.start, 50);
        assert_eq!(saved.end, (MAX_RECORDS as u64 + 5) * 10);
        assert_eq!(saved.records.len(), MAX_RECORDS);
        assert_eq!(saved.records[0].0, 60);
    }

    #[test]
    fn the_text_is_capped_too() {
        let per = MAX_BYTES / 10;
        let w = window(25, per);
        // Ten fit exactly; the eleventh pushes the first out.
        assert_eq!(w.len(), 10);
        let saved = Saved::decode(&w.encode("omp", 7).expect("encoded"), "omp").expect("decoded");
        assert_eq!(saved.start, 150);
        assert_eq!(saved.end, 250);
    }

    #[test]
    fn a_read_from_scratch_leaves_nothing_of_the_old_one() {
        let mut w = window(3, 4);
        w.restart(900);
        assert!(w.is_empty());
        assert!(
            w.encode("omp", 1).is_none(),
            "an empty window must not replace a copy"
        );
        w.push(950, "{}");
        let saved = Saved::decode(&w.encode("omp", 1).expect("encoded"), "omp").expect("decoded");
        assert_eq!((saved.start, saved.end), (900, 950));
        assert_eq!(saved.records, vec![(950, "{}".to_owned())]);
    }

    #[test]
    fn a_saved_copy_continues_where_it_ended_and_trims_with_the_right_start() {
        let mut w = window(MAX_RECORDS as u64, 1);
        let saved = Saved::decode(&w.encode("omp", 7).expect("encoded"), "omp").expect("decoded");
        assert_eq!(saved.start, 0);
        let mut again = Window::from_saved(saved);
        again.push(MAX_RECORDS as u64 * 10 + 10, "y");
        w.push(MAX_RECORDS as u64 * 10 + 10, "y");
        // The offsets of the records that dropped came from the file, not from a count.
        let (a, b) = (
            again.encode("omp", 7).expect("again"),
            w.encode("omp", 7).expect("w"),
        );
        assert_eq!(a, b);
        assert_eq!(Saved::decode(&a, "omp").expect("decoded").start, 10);
    }

    #[test]
    fn a_copy_that_cannot_be_resumed_from_is_not_one() {
        let good = window(3, 4).encode("omp", 1).expect("encoded");
        assert!(Saved::decode(&good, "omp").is_some());
        // Another agent's pane, another version, offsets out of order, an end that is not the last record's.
        assert!(Saved::decode(&good, "claude").is_none());
        let text = String::from_utf8(good.clone()).expect("text");
        for broken in [
            text.replace("\"v\":1", "\"v\":2"),
            text.replace("20\txxxx", "5\txxxx"),
            text.replace("\"end\":30", "\"end\":31"),
            text.replace("30\txxxx\n", ""),
        ] {
            assert!(
                Saved::decode(broken.as_bytes(), "omp").is_none(),
                "{broken}"
            );
        }
        assert!(Saved::decode(b"not a copy", "omp").is_none());
    }
}
