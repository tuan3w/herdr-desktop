//! The detector: the last rows of a blocked pane in, the question and its
//! one-tap answers out. See [`detect`] for what is recognised and why it is
//! conservative.

use std::sync::LazyLock;

use regex::{Captures, Regex};

use super::re::{rx, rx_i};
use super::risk::{Risk, command_risk, grants_standing_permission, prose_risk, risk_of};
use super::text::{cap, cap_at_word, indent, ulen};
use super::{PromptInfo, QuickReply, prompt_digest};

/// Rows of the screen the detector looks at: the prompt sits at the very bottom.
const WINDOW: usize = 12;
const MAX_REPLIES: usize = 9;
const LABEL_MAX: usize = 40;
const QUESTION_MAX: usize = 160;
const SUBJECT_ROWS: usize = 6;
const SUBJECT_ROW_MAX: usize = 160;
/// The pane previews cut every row at this many characters, indentation
/// included, without a mark.
const PREVIEW_ROW_MAX: usize = 160;

/// What a dashed rule (`╌╌╌`) cleans to. Claude Code draws the command of a
/// permission dialog between two of them, under a description that is not part
/// of it: [`detect`] needs them to tell the command from the rows around.
/// Every other rule is dropped. This row is never shown (see [`is_dashed_rule`]).
pub const DASHED_RULE_ROW: &str = "\u{E000}rule\u{E000}";

/// Whether `row` is the stand-in of a dashed rule: a preview leaves it out.
pub fn is_dashed_rule(row: &str) -> bool {
    row == DASHED_RULE_ROW
}

macro_rules! lazy_rx {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| rx($pattern));
    };
}

macro_rules! lazy_rx_i {
    ($name:ident, $pattern:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| rx_i($pattern));
    };
}

lazy_rx!(DASHED_RULE, r"^[╌┄┈]{20,}$");
lazy_rx!(LEFT_BAR, r"^(\s*)[│┃║] ?");
lazy_rx!(RIGHT_BAR, r"\s*[│┃║]\s*$");
lazy_rx!(RULE_ONLY, r"^[\s─━═╭╮╰╯┌┐└┘├┤┬┴┼│┃║╌┄┈\-_=*·•]+$");
// A title row of a dialog about a command (`Bash command`, `Bash command ·
// from the general-purpose agent`).
lazy_rx!(COMMAND_HEADER, r"^[A-Z][A-Za-z ]{1,24}?(?:\s+·\s+.*)?$");
// The header of a dialog about a file: its two rules hold a diff or the new
// content, which is not a command.
lazy_rx_i!(
    FILE_HEADER,
    r"^\s*(?:edit|create|overwrite|update|delete|read|write)\s+(?:file|notebook)s?(?:\s+·.*)?\s*$"
);
// Starts a transcript row (a tool call, its output, a prompt), never a title.
lazy_rx!(MARKER, r"^[●⏺⎿└├│>$#✻✔✘]");
// indent, pointer, number, text
lazy_rx!(NUMBERED, r"^(\s*)([❯›▶▸➤>→]?)\s*(\d{1,2})[.)]\s+(\S.*)$");
lazy_rx!(CODEX_QUESTION_HEADER, r"^\s*Question (\d+)/(\d+)\b");
lazy_rx!(STRONG_POINTER, r"^[❯›▶▸➤→]$");
lazy_rx!(POINTER_ROW, r"^(\s*)([❯›▶▸➤])\s*(\S.*)$");
lazy_rx!(RADIO_ROW, r"^(\s*)([●◉○◯])\s+(\S.*)$");
lazy_rx!(CHECKBOX, r"^[☐☑☒]");
lazy_rx_i!(
    FOOTER,
    r"(\besc(ape)?\b|enter to |to navigate|\btab to\b|ctrl\+|shift\+tab|[↑↓]|shortcuts|press enter|arrow keys|to select|to cancel|to confirm|to exit)"
);
lazy_rx_i!(
    YES_NO,
    r"[\[(]\s*(y(?:es)?)\s*/\s*(n(?:o)?)(?:\s*/\s*\[?fingerprint\]?)?\s*[\])][\s?:]*$"
);
lazy_rx_i!(
    PRESS_ENTER,
    r"\b(?:press|hit)\s+(?:enter|return|any\s+key)\s+to\s+(?:continue|proceed|close|exit|start|begin|dismiss)\b[^a-z]*$"
);
lazy_rx_i!(
    QUESTION_PHRASE,
    r"^(?:do you want|would you like|are you sure|allow|approve|proceed|continue|choose|select|which|what|how|confirm|trust)\b"
);
lazy_rx_i!(
    NEGATIVE,
    r"^(?:no\b|not now\b|not yet\b|maybe later\b|remind me\b|later\b|don.t\b|do not\b|deny\b|denied\b|reject\w*|cancel\w*|abort\w*|stop\b|skip\b|never\b|exit\b|quit\b|decline\w*|esc\b)"
);
lazy_rx!(QUESTION_TAIL, r#"["'”’)\]]+$"#);
lazy_rx!(NUMBER_PREFIX, r"^\s*\d{1,2}[.)]\s*");
lazy_rx!(
    REASON_ROW,
    r"^\s*(?:Environment|Reason|Description|Permissions?|Working directory):"
);
// A reply that opens a field for the person's own words: it cannot be given by
// a tap (`Tell Claude what to change`, `Yes, and tell Claude what to do next`).
lazy_rx_i!(NEEDS_TYPING, r"^(?:tell\b|yes,? and tell\b)");
lazy_rx_i!(
    TRAILING_HINT,
    r"\s*\((?:esc|[a-z]|tab|enter|shift\+tab|ctrl\+\w|alt\+\w)\)\s*$"
);
lazy_rx_i!(NO_AND_TELL, r"^(no),\s+and\s+tell\b.*$");
lazy_rx_i!(YES_DONT_ASK, r"^(yes),?\s+and\s+(don.t\s+ask\s+again)\b.*$");
lazy_rx!(
    OPTIONAL_NOTES,
    r"\s+Optionally, add details in notes \(tab\)\.?"
);
lazy_rx!(WHITESPACE_RUN, r"\s{2,}");
lazy_rx_i!(ESC_OR_CANCEL, r"esc|cancel");

/// A terminal row as shown in a preview: side bars of a box removed, trailing
/// spaces trimmed, `None` when nothing readable is left (blank, or only
/// box-drawing/rule characters). Indentation is kept.
pub fn clean_preview_row(raw: &str) -> Option<String> {
    let t = LEFT_BAR.replace(raw, |c: &Captures| c[1].to_owned());
    let t = RIGHT_BAR.replace(&t, "").trim_end().to_owned();
    // A rule is a whole row of them with no bar: a row of a multi-line command
    // that is only dashes (drawn behind ` │ `) is the command's, not a rule.
    if DASHED_RULE.is_match(raw.trim()) || raw == DASHED_RULE_ROW {
        return Some(DASHED_RULE_ROW.to_owned());
    }
    if t.is_empty() || RULE_ONLY.is_match(&t) {
        return None;
    }
    Some(t)
}

/// Whether `reply` declines: its label, without the number in front, starts as a
/// refusal does ("No", "Deny", "Cancel"). The observed chat shows such a reply
/// as a rejection and every other one as an allow.
pub fn is_negative_reply(reply: &QuickReply) -> bool {
    is_negative(&NUMBER_PREFIX.replace(&reply.label, ""))
}

fn is_negative(text: &str) -> bool {
    NEGATIVE.is_match(text.trim())
}

/// Recognises the question a blocked agent is waiting on in the last rows of its
/// terminal and turns it into one-tap answers.
///
/// Deliberately conservative: a miss costs the user one keystroke in the full
/// pane view, a wrong match could approve something. The caller must only ask
/// while herdr reports the pane as `blocked`; this function additionally insists
/// the prompt sits at the very bottom of `rows` (a few hint/border rows may
/// follow it), so a numbered list that merely scrolled past is never mistaken
/// for a menu.
///
/// `rows` are ANSI-stripped terminal rows, oldest first (blank rows are
/// ignored). Recognised, in this order:
///
///  * numbered menus (`❯ 1. Yes` / `2. Yes, and don't ask again` / `3. No`):
///    consecutive numbers from 1, a selection marker or a question right above;
///  * un-numbered menus with a pointer (`❯ Allow once`) or radio (`●`/`○`)
///    marker and a question right above;
///  * inline `[y/N]`, `(Y/n)`, `(yes/no)` on the last row;
///  * `Press Enter to continue` on the last row.
///
/// Numbered replies send the digit then `enter`: Claude Code and Codex select on
/// the digit alone (the `enter` then lands in an empty input box), other menus
/// only move the highlight (the `enter` confirms). Un-numbered menus are
/// answered by walking the highlight with `up`/`down` then `enter`.
///
/// What the question is about goes into [`PromptInfo::subject`]: Claude Code's
/// command block (the rows indented under a short header, above "Do you want to
/// proceed?"), Codex's command row (between its question and the menu) and, for
/// any menu with no such block, the row above the question when it is what made
/// the question risky (it may as well be scrollback otherwise). What is shown is
/// in the digest, so the card and a notification's button cover it. A reply that
/// needs a second tap carries the reason in [`QuickReply::risk`], judged by the
/// risk rules on the subject, the question, the row above the question and the
/// option's own text; never on the scrollback around. The subject is read whole
/// for risk, however much of it is shown: when a row or the row count had to be
/// cut (`…`), or the 12-row window dropped the rows above a block that runs to
/// its top, the affirmative answers also ask for a second tap
/// ([`Risk::LongCommand`]) unless a more specific reason applies.
pub fn detect(rows: &[String]) -> Option<PromptInfo> {
    let mut lines: Vec<String> = rows
        .iter()
        .filter_map(|raw| clean_preview_row(raw))
        .collect();
    lines = without_dashed_rules(lines);
    // The window drops the older rows: a block of rows that runs to the top of
    // what is left may go on above it (see `subject_above`).
    let scrolled = lines.len() > WINDOW;
    if scrolled {
        lines.drain(..lines.len() - WINDOW);
    }
    if lines.is_empty() {
        return None;
    }

    // Hint and key-help rows that Claude Code / Codex draw under a menu.
    let mut end = lines.len();
    let mut footer = 0;
    while end > 1 && footer < 3 && is_footer(&lines[end - 1]) {
        end -= 1;
        footer += 1;
    }
    let body = &lines[..end];

    let mut prompt = numbered_menu(body, scrolled)
        .or_else(|| marker_menu(body, scrolled))
        .or_else(|| inline_yes_no(body))
        .or_else(|| enter_to_continue(&lines))?;
    prompt.digest = prompt_digest(&prompt);
    Some(prompt)
}

fn is_footer(line: &str) -> bool {
    ulen(line) <= 140 && !NUMBERED.is_match(line) && FOOTER.is_match(line)
}

fn questionish(line: &str) -> bool {
    let t = line.trim();
    let t = QUESTION_TAIL.replace(t, "");
    t.ends_with('?') || t.ends_with(':') || QUESTION_PHRASE.is_match(&t)
}

/// A question row: ends in `?` or `:` (stricter than [`questionish`]).
fn is_question_row(line: &str) -> bool {
    let t = line.trim();
    t.ends_with('?') || t.ends_with(':')
}

// ------------------------------------------------------------ dashed rules

/// `lines` without the dashed rules. Claude Code's dialog about a command is
/// drawn as
///
/// ```text
///  Bash command
///  Tip: ...                       (sometimes)
///  <the description>
///  ╌╌╌╌╌╌╌╌
///  <the command>
///  ╌╌╌╌╌╌╌╌
///  This command requires approval    (sometimes)
///  Do you want to proceed?
/// ```
///
/// The command becomes the block the rest of the detector reads (rows indented
/// under the header, the description and the tip left out); a dialog about a
/// file, or one that does not look like this, only loses its rules.
fn without_dashed_rules(lines: Vec<String>) -> Vec<String> {
    let plain = |lines: &[String]| {
        lines
            .iter()
            .filter(|l| !is_dashed_rule(l))
            .cloned()
            .collect::<Vec<_>>()
    };
    let marks: Vec<usize> = (0..lines.len())
        .filter(|&i| is_dashed_rule(&lines[i]))
        .collect();
    if marks.is_empty() {
        return lines;
    }
    if marks.len() < 2 {
        return plain(&lines);
    }
    let a = marks[marks.len() - 2];
    let b = marks[marks.len() - 1];
    // The question, or a note ("This command requires approval") and then it.
    let mut q = b + 1;
    if q + 1 < lines.len() && !questionish(&lines[q]) && questionish(&lines[q + 1]) {
        q += 1;
    }
    if b - a < 2 || q >= lines.len() || !questionish(&lines[q]) {
        return plain(&lines);
    }
    let near_above = || (a.saturating_sub(3)..a).rev();
    if near_above().any(|i| FILE_HEADER.is_match(&lines[i])) {
        return plain(&lines);
    }
    let header = near_above().find(|&i| {
        let t = lines[i].trim();
        COMMAND_HEADER.is_match(t) && !t.ends_with('.') && !t.contains('?')
    });
    let Some(header) = header else {
        return plain(&lines);
    };
    let mut out: Vec<String> = lines[..header]
        .iter()
        .filter(|l| !is_dashed_rule(l))
        .cloned()
        .collect();
    // "Bash command · from the general-purpose agent": the title is the part
    // before the dot (a title row is short, see `is_header`).
    out.push(
        lines[header]
            .split(" · ")
            .next()
            .unwrap_or_default()
            .to_owned(),
    );
    out.extend(lines[a + 1..b].iter().map(|l| format!("  {l}")));
    out.extend_from_slice(&lines[q..]);
    out
}

// ---------------------------------------------------------------- numbered

fn numbered_menu(body: &[String], scrolled: bool) -> Option<PromptInfo> {
    // The menu starts at the LAST row numbered 1 whose tail is a clean menu.
    for i in (0..body.len()).rev() {
        let Some(first) = NUMBERED.captures(&body[i]) else {
            continue;
        };
        if &first[3] != "1" {
            continue;
        }
        let Some(options) = parse_numbered(body, i) else {
            continue;
        };
        return build_numbered(body, i, &options, scrolled);
    }
    None
}

struct Opt {
    number: u32,
    /// The option's own row: what the chip shows.
    text: String,
    /// Wrapped or description rows under it.
    more: String,
    pointer: String,
}

impl Opt {
    /// Everything said about the option, for the risk check.
    fn full(&self) -> String {
        format!("{} {}", self.text, self.more)
    }
}

/// Number of UTF-16 units before byte offset `at` of `row`.
fn column_of(row: &str, at: usize) -> usize {
    ulen(&row[..at])
}

/// Options from row `start` to the end, numbered 1..n in order, with indented
/// continuation rows allowed; `None` if anything else interrupts.
fn parse_numbered(body: &[String], start: usize) -> Option<Vec<Opt>> {
    let mut out: Vec<Opt> = Vec::new();
    let mut digit_column = 0;
    let mut continuation = 0;
    for row in &body[start..] {
        if let Some(m) = NUMBERED.captures(row) {
            let n: u32 = m[3].parse().ok()?;
            if n as usize != out.len() + 1 {
                return None;
            }
            out.push(Opt {
                number: n,
                text: m[4].trim().to_owned(),
                more: String::new(),
                pointer: m[2].to_owned(),
            });
            digit_column = column_of(row, m.get(3)?.start());
            continuation = 0;
        } else {
            // A wrapped option or its description: indented under the number.
            let ind = indent(row);
            if out.is_empty() || ind <= digit_column {
                return None;
            }
            continuation += 1;
            if continuation > 3 {
                return None;
            }
            let last = out.last_mut()?;
            last.more = format!("{} {}", last.more, row.trim());
        }
    }
    if out.len() < 2 || out.len() > MAX_REPLIES {
        return None;
    }
    Some(out)
}

fn build_numbered(
    body: &[String],
    start: usize,
    options: &[Opt],
    scrolled: bool,
) -> Option<PromptInfo> {
    // Claude Code's question tool (a `Chat about this` row): its rows toggle
    // boxes and type text, which no reply of a card can say. It is answered by
    // the question driver from the log, or in the terminal.
    if options
        .iter()
        .any(|o| o.text.starts_with("Chat about this"))
    {
        return None;
    }
    let pointers: Vec<&Opt> = options.iter().filter(|o| !o.pointer.is_empty()).collect();
    if pointers.len() > 1 {
        return None;
    }
    let strong = pointers.len() == 1 && STRONG_POINTER.is_match(&pointers[0].pointer);
    let above = &body[..start];
    let at = question_row_above(above);
    // A bare `>` is also a quote marker: it only counts next to a question.
    if !strong && at.is_none() {
        return None;
    }

    // Without a question, a strong pointer still makes a menu: the row above
    // stands in for the question.
    let q: isize = at.map_or(above.len() as isize - 1, |a| a as isize);
    let block: Vec<String> = match at {
        None => Vec::new(),
        Some(a) if a == above.len() - 1 => subject_above(above, a),
        // Codex: the command is the rows between the question and the menu,
        // after its `Environment:` / `Reason:` rows.
        Some(a) => rows_after_reason(above, a),
    };
    // Codex's question tool ("Question 1/2" above the question): the digit
    // selects, and on the last question submits; with more questions to come an
    // `enter` after it would answer the next one with its first option.
    let header = at
        .filter(|&a| a > 0)
        .and_then(|a| CODEX_QUESTION_HEADER.captures(&above[a - 1]));
    let digit_only = header.is_some();
    // A row that is a place to type feedback ("Tell Claude what to change") is
    // not an answer a tap can give.
    let offered: Vec<&Opt> = options
        .iter()
        .filter(|o| !NEEDS_TYPING.is_match(&o.text))
        .collect();
    if offered.len() < 2 {
        return None;
    }
    let mut prompt = prompt_of(above, q, &block, scrolled, |reason, cut| {
        offered
            .iter()
            .map(|o| {
                quick_reply(
                    format!("{}. {}", o.number, short_label(&o.text)),
                    if digit_only {
                        vec![o.number.to_string()]
                    } else {
                        vec![o.number.to_string(), "enter".to_owned()]
                    },
                    &o.full(),
                    reason,
                    Some(&o.text),
                    cut.then_some(Risk::LongCommand),
                )
            })
            .collect()
    });
    // Which question of the form this is: the card is one at a time.
    if let Some(h) = header {
        prompt.question = cap(
            &format!("{} of {} · {}", &h[1], &h[2], prompt.question),
            QUESTION_MAX,
        );
    }
    Some(prompt)
}

/// The rows under the question at `q` that are the command: all of them, after
/// the last row that gives a reason or an environment; the last row when that
/// leaves none.
fn rows_after_reason(above: &[String], q: usize) -> Vec<String> {
    let mut from = q + 1;
    for (i, row) in above.iter().enumerate().skip(q + 1) {
        if REASON_ROW.is_match(row) {
            from = i + 1;
        }
    }
    if from < above.len() {
        above[from..].to_vec()
    } else {
        above.last().cloned().into_iter().collect()
    }
}

/// The question at row `q` of `body` with what it is about, and its replies
/// (given the scope reason and whether the subject was cut).
///
/// `block` is the rows drawn under a header or between the question and the
/// menu, read as a command, all of it (the cut that keeps the card short must
/// not hide a dangerous tail). Without one, the row above the question is read
/// as a command or a sentence, and shown when it flags something (`row_above`).
/// `scrolled`: the 12-row window dropped older rows, so a block that runs to the
/// top of it was cut.
fn prompt_of(
    body: &[String],
    q: isize,
    block: &[String],
    scrolled: bool,
    replies: impl FnOnce(Option<Risk>, bool) -> Vec<QuickReply>,
) -> PromptInfo {
    let subject: Vec<String> = if block.is_empty() {
        row_above(body, q)
    } else {
        block.to_vec()
    };
    let mut sentences: Vec<&str> = Vec::new();
    if q >= 0 {
        sentences.push(&body[q as usize]);
    }
    if block.is_empty() && q > 0 {
        sentences.push(&body[q as usize - 1]);
    }
    let reason = scope_risk(block, &sentences);
    let top_cut = scrolled && !block.is_empty() && q - block.len() as isize == 0;
    let cut = top_cut || is_cut(&subject);
    let shown = subject_text(&subject);
    PromptInfo {
        question: if q < 0 {
            String::new()
        } else {
            cap(body[q as usize].trim(), QUESTION_MAX)
        },
        subject: (!shown.is_empty()).then_some(shown),
        options: replies(reason, cut),
        digest: String::new(),
    }
}

/// The row right above the question at `q` when it is what made the question
/// risky and is no deeper than the question: a command or a sentence drawn as
/// part of the prompt, so the card shows the reason's cause and the digest tells
/// `rm -rf x` from `rm -rf y`. A row that flags nothing is not shown: there it
/// may as well be the scrollback (a tab title, a log line), which would put
/// noise on every card and change the digest as it scrolls. One deeper than the
/// question is the output of something else (a diff above an edit dialog); it is
/// judged, and its reason shows, but it is not the subject.
fn row_above(body: &[String], q: isize) -> Vec<String> {
    if q <= 0 {
        return Vec::new();
    }
    let q = q as usize;
    if indent(&body[q - 1]) > indent(&body[q]) {
        return Vec::new();
    }
    let row = &body[q - 1];
    if scope_risk(std::slice::from_ref(row), &[row.as_str()]).is_none() {
        Vec::new()
    } else {
        vec![row.clone()]
    }
}

/// The first reason in `commands` (read as commands) or `sentences` (as a
/// command, else as a sentence): a command reason anywhere wins over prose.
fn scope_risk<C: AsRef<str>>(commands: &[C], sentences: &[&str]) -> Option<Risk> {
    let all: Vec<&str> = commands
        .iter()
        .map(AsRef::as_ref)
        .chain(sentences.iter().copied())
        .collect();
    command_risk(&all.join("\n")).or_else(|| prose_risk(&sentences.join("\n")))
}

/// The subject as shown: at most [`SUBJECT_ROWS`] rows of [`SUBJECT_ROW_MAX`]
/// characters, every cut marked with `…` so the card never claims to be whole.
fn subject_text(rows: &[String]) -> String {
    let mut shown: Vec<String> = rows
        .iter()
        .take(SUBJECT_ROWS)
        .map(|r| shown_row(r))
        .collect();
    if rows.len() > SUBJECT_ROWS
        && let Some(last) = shown.last_mut()
        && !last.ends_with('…')
    {
        *last = cap(&format!("{last}…"), SUBJECT_ROW_MAX);
    }
    shown.join("\n")
}

fn shown_row(row: &str) -> String {
    let t = row.trim();
    if ulen(t) > SUBJECT_ROW_MAX {
        return cap(t, SUBJECT_ROW_MAX);
    }
    if row_cut(row) {
        cap(&format!("{t}…"), SUBJECT_ROW_MAX)
    } else {
        t.to_owned()
    }
}

/// A row (untrimmed) that is longer than shown, or about as long as the previews
/// allow, which means it was probably cut there (a box's side bars were already
/// taken off it).
fn row_cut(row: &str) -> bool {
    ulen(row.trim()) > SUBJECT_ROW_MAX || ulen(row) >= PREVIEW_ROW_MAX - 4
}

/// Whether `rows` (untrimmed) hold more than [`subject_text`] shows.
fn is_cut(rows: &[String]) -> bool {
    rows.len() > SUBJECT_ROWS || rows.iter().any(|r| row_cut(r))
}

/// A reply with the reason it needs a second tap, if any. In order: a permission
/// that outlives this answer, then `scope_risk` (what the question is about),
/// then the option's own words, then `cut_risk` (the subject was cut and may hide
/// something). A negative option never carries one: declining is always safe.
/// `negative_text` is the option's own row when `option_text` also holds wrapped
/// rows.
fn quick_reply(
    label: String,
    keys: Vec<String>,
    option_text: &str,
    scope_risk: Option<Risk>,
    negative_text: Option<&str>,
    cut_risk: Option<Risk>,
) -> QuickReply {
    let risk = if is_negative(negative_text.unwrap_or(option_text)) {
        None
    } else if grants_standing_permission(option_text) {
        Some(Risk::StandingGrant)
    } else {
        scope_risk.or_else(|| risk_of(option_text)).or(cut_risk)
    };
    QuickReply {
        label,
        keys,
        risk,
        standing_grant: risk == Some(Risk::StandingGrant),
    }
}

/// Index of the row that introduces a menu: the nearest row ending in `?` within
/// six rows above it (else `:` or a typical opening such as "Do you want");
/// `None` when there is none.
fn question_row_above(above: &[String]) -> Option<usize> {
    let from = above.len().saturating_sub(6);
    (from..above.len())
        .rev()
        .find(|&i| above[i].trim().ends_with('?'))
        .or_else(|| (from..above.len()).rev().find(|&i| questionish(&above[i])))
}

/// The rows drawn right above the question at `q`, indented deeper than it
/// (Claude Code: the command and its description under "Bash command"), all of
/// them. Empty when there are none, or when the row above them does not look
/// like a header (then they are some other output); the block may also run to
/// the top of the visible rows, its header scrolled out, and then it may go on
/// above them too (see `prompt_of` on `scrolled`).
fn subject_above(above: &[String], q: usize) -> Vec<String> {
    let ind = indent(&above[q]);
    let mut top = q;
    while top > 0 && indent(&above[top - 1]) > ind {
        top -= 1;
    }
    if top == q || (top > 0 && !is_header(&above[top - 1], ind)) {
        return Vec::new();
    }
    above[top..q].to_vec()
}

/// A short title row ("Bash command", "Tool use", "Fetch"): not deeper than the
/// question, no sentence, no question and no transcript marker.
fn is_header(row: &str, question_indent: usize) -> bool {
    let t = row.trim();
    indent(row) <= question_indent
        && ulen(t) <= 30
        && !t.contains('?')
        && !t.ends_with('.')
        && !t.ends_with(':')
        && !MARKER.is_match(t)
}

fn short_label(text: &str) -> String {
    // Codex's question rows pad the label and its description into columns, and
    // tell about notes a card cannot add.
    let t = OPTIONAL_NOTES.replace(text, "");
    let t = TRAILING_HINT.replace(&t, "");
    let t = t.trim();
    let t = WHITESPACE_RUN.replace_all(t, " · ");
    let t = NO_AND_TELL.replace(&t, |c: &Captures| c[1].to_owned());
    let t = YES_DONT_ASK.replace(&t, |c: &Captures| {
        format!("{}, {}", &c[1], c[2].to_lowercase())
    });
    cap_at_word(&t, LABEL_MAX - 3)
}

// --------------------------------------------------------- un-numbered menu

fn marker_menu(body: &[String], scrolled: bool) -> Option<PromptInfo> {
    radio_menu(body, scrolled).or_else(|| pointer_menu(body, scrolled))
}

/// Short enough to be a choice rather than prose.
fn choice_length(line: &str) -> bool {
    ulen(line.trim()) <= 60
}

fn pointer_menu(body: &[String], scrolled: bool) -> Option<PromptInfo> {
    // The pointed row is within the last few rows; its siblings share its text
    // column and run to the very end.
    for p in (body.len().saturating_sub(MAX_REPLIES)..body.len()).rev() {
        let Some(m) = POINTER_ROW.captures(&body[p]) else {
            continue;
        };
        let text = m.get(3)?;
        // A checkbox list (omp's multi-select question) is answered with space to
        // tick and enter to go on; a row's keys here would only go on.
        if CHECKBOX.is_match(text.as_str()) || !choice_length(&body[p]) {
            return None;
        }
        let column = column_of(&body[p], text.start());
        let sibling = |i: usize| {
            choice_length(&body[i]) && !is_question_row(&body[i]) && indent(&body[i]) == column
        };
        if (p + 1..body.len()).any(|i| !sibling(i)) {
            return None;
        }
        let mut start = p;
        while start > 0 && sibling(start - 1) {
            start -= 1;
        }
        let texts: Vec<String> = (start..body.len())
            .map(|i| {
                if i == p {
                    text.as_str().trim().to_owned()
                } else {
                    body[i].trim().to_owned()
                }
            })
            .collect();
        return arrow_menu(body, start, &texts, p - start, scrolled);
    }
    None
}

fn radio_menu(body: &[String], scrolled: bool) -> Option<PromptInfo> {
    let mut start = body.len();
    let mut selected: Option<usize> = None;
    let mut texts: Vec<String> = Vec::new();
    while start > 0 && texts.len() <= MAX_REPLIES {
        let Some(m) = RADIO_ROW.captures(&body[start - 1]) else {
            break;
        };
        if !choice_length(&body[start - 1]) {
            break;
        }
        start -= 1;
        texts.insert(0, m[3].trim().to_owned());
        if matches!(&m[2], "●" | "◉") {
            if selected.is_some() {
                return None;
            }
            selected = Some(body.len() - 1 - start);
        }
    }
    let selected = selected?;
    // `selected` was counted from the bottom; make it an index into `texts`.
    arrow_menu(body, start, &texts, texts.len() - 1 - selected, scrolled)
}

/// A menu answered with up/down to the wanted row, then enter. Needs a question
/// row right above it.
fn arrow_menu(
    body: &[String],
    start: usize,
    texts: &[String],
    selected: usize,
    scrolled: bool,
) -> Option<PromptInfo> {
    if texts.len() < 2 || texts.len() > MAX_REPLIES {
        return None;
    }
    if start == 0 || !is_question_row(&body[start - 1]) {
        return None;
    }
    // The question and what it is about (rows under a header, else the row above
    // it: a tool name, a command) are read as a command or a sentence and shown;
    // each option is judged on its own text.
    let block = subject_above(body, start - 1);
    Some(prompt_of(
        body,
        start as isize - 1,
        &block,
        scrolled,
        |reason, cut| {
            texts
                .iter()
                .enumerate()
                .map(|(k, text)| {
                    let key = if k > selected { "down" } else { "up" };
                    let mut keys: Vec<String> = vec![key.to_owned(); k.abs_diff(selected)];
                    keys.push("enter".to_owned());
                    quick_reply(
                        short_label(text),
                        keys,
                        text,
                        reason,
                        None,
                        cut.then_some(Risk::LongCommand),
                    )
                })
                .collect()
        },
    ))
}

// ------------------------------------------------------------ inline prompts

fn inline_yes_no(lines: &[String]) -> Option<PromptInfo> {
    let last = lines.last()?;
    if ulen(last) > 200 {
        return None;
    }
    let m = YES_NO.captures(last)?;
    let full = m[1].eq_ignore_ascii_case("yes");
    let prev = if lines.len() > 1 {
        lines[lines.len() - 2].trim()
    } else {
        ""
    };
    // The last row and the one before it: what the question says and what it
    // refers to. Only Yes can carry a reason.
    let reason = risk_of(last).or_else(|| if prev.is_empty() { None } else { risk_of(prev) });
    // A short "Continue? [y/N]" is meaningless without the row that says what.
    let question = if ulen(last.trim()) < 40 && !prev.is_empty() {
        format!("{prev}\n{}", last.trim())
    } else {
        last.trim().to_owned()
    };
    let word = |full: bool, yes: bool| -> Vec<String> {
        let mut keys: Vec<String> = match (yes, full) {
            (true, true) => vec!["y", "e", "s"],
            (true, false) => vec!["y"],
            (false, true) => vec!["n", "o"],
            (false, false) => vec!["n"],
        }
        .into_iter()
        .map(str::to_owned)
        .collect();
        keys.push("enter".to_owned());
        keys
    };
    Some(PromptInfo {
        question: cap(&question, QUESTION_MAX * 2),
        subject: None,
        options: vec![
            QuickReply {
                label: "Yes".to_owned(),
                keys: word(full, true),
                risk: reason,
                standing_grant: false,
            },
            QuickReply {
                label: "No".to_owned(),
                keys: word(full, false),
                risk: None,
                standing_grant: false,
            },
        ],
        digest: String::new(),
    })
}

fn enter_to_continue(lines: &[String]) -> Option<PromptInfo> {
    let last = lines.last()?;
    if ulen(last) > 160 || !PRESS_ENTER.is_match(last) || ESC_OR_CANCEL.is_match(last) {
        return None;
    }
    Some(PromptInfo {
        question: cap(last.trim(), QUESTION_MAX),
        subject: None,
        options: vec![QuickReply {
            label: "Enter".to_owned(),
            keys: vec!["enter".to_owned()],
            risk: None,
            standing_grant: false,
        }],
        digest: String::new(),
    })
}
