//! `prompt`: permission-prompt detection and command risk.
//!
//! A blocked agent is waiting on a question drawn in the last rows of its
//! terminal. [`detect`] reads those rows and offers the answers as keys for
//! herdr's `pane.send_keys`; [`Risk`] names why an answer must be confirmed
//! before it is sent. The module is a port of herdr-mobile's
//! `prompt_detector.dart` and `command_risk.dart` and keeps their bias: a miss
//! costs one keystroke, a wrong match could approve something.
//!
//! Typical use:
//!
//! ```
//! let rows: Vec<String> = [
//!     "Do you want to proceed?",
//!     "❯ 1. Yes",
//!     "  2. No",
//! ]
//! .map(String::from)
//! .to_vec();
//! let prompt = herdr_core::prompt::detect(&rows).expect("a menu");
//! assert_eq!(prompt.options[0].keys, ["1", "enter"]);
//! ```

mod detect;
mod mode;
mod re;
mod risk;
mod text;

use std::sync::LazyLock;

use regex::Regex;

pub use detect::{DASHED_RULE_ROW, clean_preview_row, detect, is_dashed_rule, is_negative_reply};
pub use mode::{ModeAssessment, ModeRisk, assess_mode};
pub use risk::{Risk, command_risk, grants_standing_permission, path_risk, prose_risk, risk_of};
pub use text::{ellipsize, plain_line, strip_ansi};

/// One tap-to-answer option of a [`PromptInfo`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickReply {
    /// Short chip text, e.g. `1. Yes`, `No`, `Enter`.
    pub label: String,
    /// Keys as accepted by herdr's `pane.send_keys`, e.g. `["1", "enter"]`.
    pub keys: Vec<String>,
    /// Why the option (or the command it approves) deserves a second look: the
    /// UI asks for a second activation before sending. `None` when no
    /// confirmation is needed.
    pub risk: Option<Risk>,
    /// The option grants a permission that outlives this answer ("don't ask
    /// again", "allow always", a mode that asks for less). Always paired with
    /// `risk == Some(Risk::StandingGrant)`.
    pub standing_grant: bool,
}

impl QuickReply {
    /// Whether the UI must ask for a second activation before sending.
    pub fn needs_confirm(&self) -> bool {
        self.risk.is_some()
    }
}

/// A question a blocked agent is waiting on, with one-tap answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptInfo {
    /// One or two lines (joined by `\n`), ready to show.
    pub question: String,
    /// What the question is about, as the agent drew it: the command, URL or
    /// path being approved, rows joined by `\n` (at most 6, each at most 160
    /// characters; a cut row or a sixth row with more below ends in `…`).
    /// `None` when the screen shows none (an edit dialog names the file in the
    /// question).
    pub subject: Option<String>,
    /// In on-screen order; never empty.
    pub options: Vec<QuickReply>,
    /// A 64-bit fingerprint (16 hex digits) of what the question shows the
    /// person, see [`prompt_digest`]. An answer is sent only if a fresh read of
    /// the pane still has this digest.
    pub digest: String,
}

/// A 64-bit fingerprint (16 hex digits) of what a question shows the person: the
/// question, what it is about and the words of every option. Not the keys of an
/// option, which depend on where the cursor is and are read again when an answer
/// is sent. Two questions with one fingerprint read the same.
pub fn prompt_digest(prompt: &PromptInfo) -> String {
    let mut a: u32 = 0x811c_9dc5;
    let mut b: u32 = 0x050c_5d1f;
    let mut add = |unit: u16| {
        a = (a ^ u32::from(unit)).wrapping_mul(0x0100_0193);
        b = (b ^ u32::from(unit))
            .wrapping_mul(0x0100_0193)
            .rotate_left(5);
    };
    let mut add_text = |s: &str| {
        s.encode_utf16().for_each(&mut add);
        add(1);
    };
    add_text(&prompt.question);
    add_text(prompt.subject.as_deref().unwrap_or(""));
    for r in &prompt.options {
        add_text(&r.label);
    }
    format!("{a:08x}{b:08x}")
}

/// Whether a notification may carry `reply` as a button: one tap must be the
/// whole answer. Anything the card makes the person confirm (a risky command, a
/// standing grant) is not.
pub fn answerable_from_notification(reply: &QuickReply) -> bool {
    !reply.needs_confirm() && !grants_standing_permission(&reply.label)
}

/// `s` without escape sequences ([`strip_ansi`]) and without the control
/// characters that leaves behind: the ESC of a sequence that did not complete.
/// Tab, newline and carriage return stay.
fn strip_controls(s: &str) -> String {
    static CONTROL: LazyLock<Regex> = LazyLock::new(|| re::rx(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]"));
    CONTROL.replace_all(&strip_ansi(s), "").into_owned()
}

/// The rows [`detect`] reads, from the text of a `pane.read`: escape sequences
/// removed, a carriage return resolved (a progress bar shows its last state), box
/// side bars and rule-only rows dropped, trailing spaces trimmed, blank rows
/// removed, rows cut at `max_length` UTF-16 units. At most `keep` rows, oldest
/// first. herdr-mobile reads 24 rows of at most 160 characters.
pub fn preview_rows(text: &str, max_length: usize, keep: usize) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.split('\n') {
        let line = strip_controls(raw).replace('\t', "    ");
        let line = match line.trim_end().rfind('\r') {
            Some(cr) => line[cr + 1..].to_owned(),
            None => line,
        };
        let Some(cleaned) = clean_preview_row(&line) else {
            continue;
        };
        out.push(if text::ulen(&cleaned) > max_length {
            text::cut_units(&cleaned, max_length)
        } else {
            cleaned
        });
    }
    let skip = out.len().saturating_sub(keep);
    out.split_off(skip)
}
