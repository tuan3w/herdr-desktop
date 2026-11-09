//! The saved copy of a keeper chat: the lines the keeper sent, kept as they came, so the next attach can paint at
//! once and ask only for what is new.
//!
//! A copy is the raw `session/update` lines of one conversation (the reducer's own input), not the transcript: the
//! reducer is the one place that knows what a line means, and the keeper's turn stamps (`_meta.herdr.{epoch,turn}`
//! on the first line of each replayed turn) ride along in the lines, so the point to ask the keeper to continue
//! from is found by reading the copy, never recorded beside it.
//!
//! [`Window`] is the recorder the driver feeds while the session runs; [`Saved`] is what a file decodes to.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cache::{decode_lines, encode_lines};

/// The keeper's own log is bounded at 20 000 lines; a copy holds no more than that.
pub(super) const MAX_LINES: usize = 20_000;
/// What the lines of a copy may add up to (before the cache deflates them).
pub(super) const MAX_BYTES: usize = 4 * 1024 * 1024;
/// A line over this is not kept (a pasted file in a prompt): the copy then has a gap and is never continued, only
/// replaced by a full replay.
pub(super) const MAX_LINE: usize = 128 * 1024;

/// What a copy file starts with. `v` is the format: a copy of another version is a miss.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Header {
    pub v: u32,
    /// The ACP session id the lines belong to.
    pub sid: Option<String>,
    /// When the copy was written, in unix milliseconds: what the saved-copy strip tells the person.
    pub saved_ms: u64,
    /// Lines were dropped from the front to stay in the bounds: the copy shows less than a full replay would.
    pub partial: bool,
    /// A line was skipped (too big): the copy is not the whole conversation.
    pub gap: bool,
}

/// Where a copy can be continued from: the keeper's last stamp in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Since {
    pub epoch: String,
    pub turn: u64,
    /// The position of the stamped line: the lines before it are what the person already holds, the keeper
    /// sends this line's turn again from its first line.
    pub index: usize,
}

/// A copy read back from disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Saved {
    pub header: Header,
    pub lines: Vec<String>,
}

impl Saved {
    /// `None` for bytes that are not a copy this version wrote, and for a copy with nothing in it.
    pub(super) fn decode(bytes: &[u8]) -> Option<Saved> {
        let (header, lines) = decode_lines::<Header>(bytes)?;
        (header.v == 1 && !lines.is_empty()).then_some(Saved { header, lines })
    }

    /// The last turn stamp in the copy, when the copy is a whole conversation that has something before it. A copy
    /// that lost its front, or a line, would show less history than a full replay: it is replayed in full instead.
    pub(super) fn since(&self) -> Option<Since> {
        if self.header.partial || self.header.gap {
            return None;
        }
        let (index, epoch, turn) = self
            .lines
            .iter()
            .enumerate()
            .rev()
            .find_map(|(i, line)| stamp(line).map(|(epoch, turn)| (i, epoch, turn)))?;
        (index > 0).then_some(Since { epoch, turn, index })
    }
}

/// The epoch and turn the keeper stamped on a line, if it did.
fn stamp(line: &str) -> Option<(String, u64)> {
    // Most lines carry none: a substring test keeps the scan from parsing a whole conversation.
    if !line.contains("\"epoch\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let herdr = v.pointer("/params/_meta/herdr")?;
    Some((
        herdr.get("epoch")?.as_str()?.to_owned(),
        herdr.get("turn")?.as_u64()?,
    ))
}

/// The lines of a conversation as they arrive, bounded.
#[derive(Debug, Default)]
pub(super) struct Window {
    lines: VecDeque<String>,
    bytes: usize,
    partial: bool,
    gap: bool,
    sid: Option<String>,
}

impl Window {
    /// What a copy held: the recorder starts from it, so a save while the session is still opening stays whole.
    pub(super) fn from_saved(saved: &Saved) -> Window {
        let lines: VecDeque<String> = saved.lines.iter().cloned().collect();
        Window {
            bytes: lines.iter().map(|l| l.len() + 1).sum(),
            lines,
            partial: saved.header.partial,
            gap: saved.header.gap,
            sid: saved.header.sid.clone(),
        }
    }

    /// Adds one line of session `sid`. A line too big, or one that is not one line, is skipped and marks the gap;
    /// going over the bounds drops the oldest lines and marks the front as lost.
    pub(super) fn push(&mut self, sid: &str, line: String) {
        if line.len() > MAX_LINE || line.contains('\n') {
            self.gap = true;
            return;
        }
        if self.sid.is_none() {
            self.sid = Some(sid.to_owned());
        }
        self.bytes += line.len() + 1;
        self.lines.push_back(line);
        while self.lines.len() > MAX_LINES || self.bytes > MAX_BYTES {
            let Some(front) = self.lines.pop_front() else {
                break;
            };
            self.bytes -= front.len() + 1;
            self.partial = true;
        }
    }

    /// Keeps the first `len` lines: the keeper is about to send the rest again.
    pub(super) fn truncate(&mut self, len: usize) {
        self.lines.truncate(len);
        self.bytes = self.lines.iter().map(|l| l.len() + 1).sum();
    }

    /// Forgets everything: the keeper is about to send the whole conversation, which is then the copy.
    pub(super) fn clear(&mut self) {
        *self = Window::default();
    }

    #[cfg(test)]
    pub(super) fn lines(&self) -> impl Iterator<Item = &str> {
        self.lines.iter().map(String::as_str)
    }

    /// The bytes of the copy file (before the cache deflates them), written at `saved_ms`.
    pub(super) fn encode(&self, saved_ms: u64) -> Vec<u8> {
        let header = Header {
            v: 1,
            sid: self.sid.clone(),
            saved_ms,
            partial: self.partial,
            gap: self.gap,
        };
        let lines: Vec<&str> = self.lines.iter().map(String::as_str).collect();
        encode_lines(&header, &lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(text: &str, stamp: Option<(&str, u64)>) -> String {
        let mut params = json!({"sessionId": "s", "update": {"sessionUpdate": "agent_message_chunk",
            "messageId": text, "content": {"type": "text", "text": text}}});
        if let Some((epoch, turn)) = stamp {
            params["_meta"] = json!({"herdr": {"epoch": epoch, "turn": turn}});
        }
        json!({"jsonrpc": "2.0", "method": "session/update", "params": params}).to_string()
    }

    fn saved(window: &Window) -> Saved {
        Saved::decode(&window.encode(42)).expect("a copy that reads back")
    }

    #[test]
    fn a_copy_reads_back_with_its_lines_and_goes_on_from_its_last_turn_stamp() {
        let mut w = Window::default();
        w.push("s", line("a", Some(("e1", 0))));
        w.push("s", line("b", None));
        w.push("s", line("c", Some(("e1", 1))));
        w.push("s", line("d", None));
        let back = saved(&w);
        assert_eq!(back.header.saved_ms, 42);
        assert_eq!(back.header.sid.as_deref(), Some("s"));
        assert_eq!(back.lines.len(), 4);
        assert_eq!(
            back.since(),
            Some(Since {
                epoch: "e1".into(),
                turn: 1,
                index: 2
            })
        );
    }

    #[test]
    fn a_copy_with_a_hole_or_a_lost_front_is_never_continued() {
        let mut w = Window::default();
        w.push("s", line("a", None));
        w.push("s", line("b", Some(("e1", 0))));
        w.push("s", "x".repeat(MAX_LINE + 1));
        let gap = saved(&w);
        assert!(gap.header.gap && gap.since().is_none());

        let mut w = Window::default();
        for n in 0..=MAX_LINES {
            w.push("s", line(&n.to_string(), (n == 5).then_some(("e1", 0))));
        }
        let cut = saved(&w);
        assert!(cut.header.partial && cut.lines.len() == MAX_LINES);
        assert!(cut.since().is_none());
    }

    #[test]
    fn a_stamp_on_the_first_line_has_nothing_before_it_to_keep() {
        let mut w = Window::default();
        w.push("s", line("a", Some(("e1", 0))));
        w.push("s", line("b", None));
        assert!(saved(&w).since().is_none());
    }
}
