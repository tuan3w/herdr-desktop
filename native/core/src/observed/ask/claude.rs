//! Answers Claude Code's question tool (`AskUserQuestion`) by KEYS, from what the pane shows, with the same
//! protocol as the omp driver: [`ClaudeAskDriver::next`] reads a screen and gives the ONE next thing to
//! send; the caller sends it, reads the pane again and asks again, until [`AskStep::Done`].
//!
//! Claude Code 2.1.29x draws the tool in the pane, under the transcript:
//!
//! ```text
//! ─────────────────────────────────────────────
//!  ☐ Lang  ☒ Extras  ✔ Submit  →         tab strip (a lone single-choice question
//!                                        has only ` ☐ Color`; ☒ = answered)
//! Which language do I prefer?            the question
//!
//! ❯ 1. Python                            ❯ marks the cursor row
//!      Python as your preferred language
//!   2. Go ✔                              ✔ after the label: answered with it
//!   3. Rust
//!   4. Type something.                   the Other row: typing goes in the row
//! ─────────────────────────────────────────────
//!   5. Chat about this
//! Enter to select · Tab/Arrow keys to navigate · Esc to cancel
//! ```
//!
//! A multi-select question shows `1. [ ] Apple` rows, `5. [ ] Type something` and an unnumbered `Submit` row
//! before the rule. After the last question comes the review tab: `Review your answers`, a `● question` /
//! `→ answer` pair per question, `Ready to submit your answers?`, `1. Submit answers`, `2. Cancel`.
//!
//! Keys (observed on Claude Code 2.1.293 and 2.1.295):
//!
//! | key | where | effect |
//! | --- | --- | --- |
//! | `up` / `down` | any tab | cursor one row; clamped at the ends (`up` from row 1 may wrap) |
//! | `enter` | single choice, on an option | select it; a lone question submits, a form goes to the next tab |
//! | `enter` | multi-select, on an option | toggle its checkbox |
//! | `enter` | on the Other row with text | single choice: submits it (form: next tab); multi: toggles the box |
//! | digit | an option row (cursor not on the Other row) | the same as moving there and `enter`; on the Other row a digit is TEXT |
//! | typed text | on the Other row | edits the row in place (a multi-select box checks itself) |
//! | `right` / `left` | any tab | next / previous tab; `right` from the last question goes to the review |
//! | `1` / `enter` on row 1 | review | submit (all questions) |
//! | `2` / `esc` | review / anywhere | cancel: the tool call is declined |
//!
//! The screen is the truth: nothing is assumed about where the cursor, the tab or the checkboxes were, so a
//! key that did not land only costs another round. The driver remembers which questions it has answered in
//! this attempt and counters that stop an endless loop.

use std::collections::{BTreeSet, HashMap};
use std::sync::LazyLock;

use regex::Regex;

use super::text::{flat, rx, trim, trim_end};
use super::{Guard, keys, moves, repeat, send, typing};
use crate::observed::model::{AskAnswer, AskDriver, AskQuestion, AskStep, PendingAsk};

/// Which part of Claude Code's question dialog a screen shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeAskKind {
    /// No question dialog.
    None,
    /// A question tab.
    Question,
    /// The review tab.
    Review,
}

/// One option row as drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAskRow {
    /// The number before the label.
    pub number: usize,
    /// The first row of the label, without the checkbox and the answered mark.
    pub label: String,
    /// The `❯` is on this row.
    pub cursor: bool,
    /// `[✔]` of a multi-select row.
    pub checked: bool,
    /// `✔` after the label of a single choice: the answer given earlier.
    pub marked: bool,
}

/// One tab of the strip: the question's header and whether it is answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAskTab {
    /// The question's header.
    pub label: String,
    /// The tab's box is ticked.
    pub answered: bool,
}

/// What [`parse_claude_ask`] read from a screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAskScreen {
    /// What part of the dialog this is.
    pub kind: ClaudeAskKind,
    /// The questions' tabs (the `Submit` tab is not one); empty without a strip.
    pub tabs: Vec<ClaudeAskTab>,
    /// The question as drawn, wrapped rows joined with a space.
    pub title: String,
    /// The numbered rows, the Other row last; empty on the review tab.
    pub options: Vec<ClaudeAskRow>,
    /// The number of the row the cursor is on among the rows the arrows visit (the numbered rows, a
    /// multi-select's `Submit` row, `Chat about this`); `None` when it cannot be told.
    pub cursor_number: Option<usize>,
    /// The cursor is on the multi-select `Submit` row.
    pub cursor_on_submit: bool,
    /// `(question, answer)` of the review tab, in the order shown.
    pub review: Vec<(String, String)>,
    /// Same dialog in the same state, to tell a key that did not land.
    pub fingerprint: String,
}

impl ClaudeAskScreen {
    fn none() -> Self {
        Self {
            kind: ClaudeAskKind::None,
            tabs: Vec::new(),
            title: String::new(),
            options: Vec::new(),
            cursor_number: None,
            cursor_on_submit: false,
            review: Vec::new(),
            fingerprint: String::new(),
        }
    }

    /// Whether tab `i` is ticked.
    pub fn tab_answered(&self, i: usize) -> bool {
        self.tabs.get(i).is_some_and(|t| t.answered)
    }

    /// The answer the review shows for question `text`.
    pub fn review_answer_of(&self, text: &str) -> Option<&str> {
        self.review
            .iter()
            .find(|(q, _)| same(q, text))
            .map(|(_, a)| a.as_str())
    }
}

/// Whether a Claude Code question dialog (or its review tab) is on `screen`.
pub fn looks_like_claude_ask(screen: &str) -> bool {
    parse_claude_ask(screen).kind != ClaudeAskKind::None
}

fn is_marker(c: char) -> bool {
    matches!(c, '☐' | '☒' | '✔' | '☑')
}

fn is_rule(line: &str) -> bool {
    static RULE: LazyLock<Regex> = LazyLock::new(|| rx(r"^\s*─{5,}\s*$"));
    RULE.is_match(line)
}

fn option_row(line: &str) -> Option<regex::Captures<'_>> {
    static OPTION: LazyLock<Regex> = LazyLock::new(|| rx(r"^\s*(❯)?\s*([0-9]{1,2})\.\s+(.*?)\s*$"));
    OPTION.captures(line)
}

fn is_submit_row(line: &str) -> Option<bool> {
    static SUBMIT: LazyLock<Regex> = LazyLock::new(|| rx(r"^\s*(❯)?\s+Submit\s*$"));
    SUBMIT.captures(line).map(|m| m.get(1).is_some())
}

fn strip_row(line: &str) -> Option<String> {
    static STRIP: LazyLock<Regex> = LazyLock::new(|| rx(r"^\s*←?\s*([☐☒✔☑].*?)\s*→?\s*$"));
    STRIP.captures(line).map(|m| m[1].to_owned())
}

/// The tabs of a strip row (`☒ Lang  ☐ Extras  ✔ Submit`), without the `Submit` tab.
fn parse_strip(row: &str) -> Vec<ClaudeAskTab> {
    static GAP: LazyLock<Regex> = LazyLock::new(|| rx(r"\s{2,}"));
    static TAB: LazyLock<Regex> = LazyLock::new(|| rx(r"^([☐☒✔☑])\s+(.*?)\s*$"));
    // Tabs are separated by two spaces or more before the next tab's box, as `split(/\s{2,}(?=[☐☒✔☑])/)`.
    let mut parts: Vec<&str> = Vec::new();
    let mut last = 0;
    for m in GAP.find_iter(row) {
        if row[m.end()..].starts_with(is_marker) {
            parts.push(&row[last..m.start()]);
            last = m.end();
        }
    }
    parts.push(&row[last..]);
    parts
        .into_iter()
        .filter_map(|part| {
            let m = TAB.captures(trim(part))?;
            (&m[2] != "Submit").then(|| ClaudeAskTab {
                label: m[2].to_owned(),
                answered: matches!(&m[1], "☒" | "☑"),
            })
        })
        .collect()
}

fn clean_row(raw: &str) -> String {
    static ANSI: LazyLock<Regex> = LazyLock::new(|| rx(r"\x1b\[[0-9;?]*[ -/]*[@-~]"));
    static BAR: LazyLock<Regex> = LazyLock::new(|| rx(r"^│ ?"));
    let after_return = raw.rfind('\r').map_or(raw, |cr| &raw[cr + 1..]);
    let t = trim_end(&ANSI.replace_all(after_return, "")).to_owned();
    // The question wraps under a bar of its own (`│ ...`).
    BAR.replace(&t, "").into_owned()
}

/// Reads the question dialog out of `screen` (plain or ANSI; whole rows of the pane, at least the dialog's
/// height: 45 rows are safe). Only the dialog at the bottom counts.
pub fn parse_claude_ask(screen: &str) -> ClaudeAskScreen {
    static FOOTER: LazyLock<Regex> = LazyLock::new(|| rx(r"^\s*Enter to select(?-u:\b)"));
    let mut lines: Vec<String> = screen.split('\n').map(clean_row).collect();
    while lines.last().is_some_and(|l| trim(l).is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        return ClaudeAskScreen::none();
    }
    // The review tab ends with its own menu; a question tab with the footer.
    let ready = lines
        .iter()
        .rposition(|l| trim(l) == "Ready to submit your answers?");
    if let Some(ready) = ready
        && lines.len() - ready <= 4
    {
        return parse_review(&lines, ready);
    }
    let Some(footer) = lines.iter().rposition(|l| FOOTER.is_match(l)) else {
        return ClaudeAskScreen::none();
    };
    if lines.len() - footer > 2 {
        return ClaudeAskScreen::none();
    }
    parse_question(&lines, footer)
}

fn parse_question(lines: &[String], footer: usize) -> ClaudeAskScreen {
    static BOX: LazyLock<Regex> = LazyLock::new(|| rx(r"^\[([ ✔])\]\s*(.*)$"));
    // Up to the rule above the dialog's own rows.
    let Some((chat, chat_cursor)) = (footer.saturating_sub(3)..footer).rev().find_map(|i| {
        let m = option_row(&lines[i])?;
        m[3].starts_with("Chat about this")
            .then(|| (i, m.get(1).is_some()))
    }) else {
        return ClaudeAskScreen::none();
    };
    let Some(bottom) = (0..chat).rev().find(|&i| is_rule(&lines[i])) else {
        return ClaudeAskScreen::none();
    };
    let Some(top) = (0..bottom).rev().find(|&i| is_rule(&lines[i])) else {
        return ClaudeAskScreen::none();
    };

    let body = &lines[top + 1..bottom];
    let mut at = 0;
    while at < body.len() && trim(&body[at]).is_empty() {
        at += 1;
    }
    let mut tabs = Vec::new();
    if at < body.len()
        && let Some(row) = strip_row(&body[at])
    {
        tabs = parse_strip(&row);
        at += 1;
    }
    // The title: the rows before the first option.
    let mut title: Vec<&str> = Vec::new();
    while at < body.len() && option_row(&body[at]).is_none() {
        if !trim(&body[at]).is_empty() {
            title.push(trim(&body[at]));
        }
        at += 1;
    }
    let mut options: Vec<ClaudeAskRow> = Vec::new();
    let mut cursor_number: Option<usize> = None;
    let mut on_submit = false;
    let mut has_submit = false;
    for row in &body[at..] {
        if let Some(m) = option_row(row) {
            let number: usize = m[2].parse().unwrap_or(0);
            let mut label = m[3].to_owned();
            let mut checked = false;
            if let Some(b) = BOX.captures(&label) {
                checked = &b[1] == "✔";
                label = b[2].to_owned();
            }
            let mut marked = false;
            if let Some(stripped) = label.strip_suffix(" ✔") {
                marked = true;
                label = trim_end(stripped).to_owned();
            }
            let cursor = m.get(1).is_some();
            if cursor {
                cursor_number = Some(number);
            }
            options.push(ClaudeAskRow {
                number,
                label,
                cursor,
                checked,
                marked,
            });
        } else if let Some(cursor) = is_submit_row(row) {
            has_submit = true;
            on_submit = cursor;
        }
    }
    // The arrow rows in order: the numbered options (Other last), a multi-select's unnumbered `Submit`, then
    // `Chat about this`.
    if on_submit {
        cursor_number = Some(options.len() + 1);
    }
    if chat_cursor {
        cursor_number = Some(options.len() + if has_submit { 2 } else { 1 });
    }
    // Numbered 1..n in order, or it is not the dialog this driver knows.
    if options.iter().enumerate().any(|(i, o)| o.number != i + 1) || options.len() < 2 {
        return ClaudeAskScreen::none();
    }
    let title = title.join(" ");
    let mut print = vec![
        tabs.iter()
            .map(|t| if t.answered { "1" } else { "0" })
            .collect::<String>(),
        title.clone(),
    ];
    print.extend(options.iter().map(|o| {
        format!(
            "{}{}{}{}",
            if o.cursor { ">" } else { "" },
            if o.checked { "x" } else { "" },
            if o.marked { "v" } else { "" },
            o.label
        )
    }));
    if on_submit {
        print.push("submit>".to_owned());
    }
    if chat_cursor {
        print.push("chat>".to_owned());
    }
    ClaudeAskScreen {
        kind: ClaudeAskKind::Question,
        tabs,
        title,
        options,
        cursor_number,
        cursor_on_submit: on_submit,
        review: Vec::new(),
        fingerprint: print.join("|"),
    }
}

fn parse_review(lines: &[String], ready: usize) -> ClaudeAskScreen {
    let mut head = ready;
    while trim(&lines[head]) != "Review your answers" {
        if head == 0 || ready - head >= 60 {
            return ClaudeAskScreen::none();
        }
        head -= 1;
    }
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut question: Option<String> = None;
    let mut answer = String::new();
    let mut flush = |question: &mut Option<String>, answer: &mut String| {
        if let Some(q) = question.take() {
            pairs.push((q, trim(answer).to_owned()));
        }
        answer.clear();
    };
    for line in &lines[head + 1..ready] {
        let t = trim(line);
        if let Some(rest) = t.strip_prefix('●') {
            flush(&mut question, &mut answer);
            question = Some(trim(rest).to_owned());
        } else if let (Some(rest), Some(_)) = (t.strip_prefix('→'), question.as_ref()) {
            answer.push_str(trim(rest));
        } else if question.is_some() && !t.is_empty() && !answer.is_empty() {
            // A long answer wrapped.
            answer.push(' ');
            answer.push_str(t);
        } else if let Some(q) = question.as_mut()
            && !t.is_empty()
            && !t.starts_with('⚠')
        {
            q.push(' ');
            q.push_str(t);
        }
    }
    flush(&mut question, &mut answer);
    // Its menu: `1. Submit answers`, `2. Cancel`.
    let mut has_menu = false;
    let mut menu_cursor = 0;
    for line in &lines[ready + 1..] {
        let Some(m) = option_row(line) else {
            continue;
        };
        if &m[2] == "1" && m[3].starts_with("Submit answers") {
            has_menu = true;
        }
        if m.get(1).is_some() {
            menu_cursor = m[2].parse().unwrap_or(0);
        }
    }
    if !has_menu {
        return ClaudeAskScreen::none();
    }
    // The strip above `Review your answers`, if it is on screen.
    let mut tabs = Vec::new();
    for i in (head.saturating_sub(2)..head).rev() {
        if let Some(row) = strip_row(&lines[i]) {
            tabs = parse_strip(&row);
            break;
        }
    }
    let print = format!(
        "review|{}|{menu_cursor}",
        pairs
            .iter()
            .map(|(q, a)| format!("{q}={a}"))
            .collect::<Vec<_>>()
            .join("|")
    );
    ClaudeAskScreen {
        kind: ClaudeAskKind::Review,
        tabs,
        title: String::new(),
        options: Vec::new(),
        cursor_number: (menu_cursor != 0).then_some(menu_cursor),
        cursor_on_submit: false,
        review: pairs,
        fingerprint: print,
    }
}

// -------------------------------------------------------------- answer text

/// What the dialog shows (and the tool result says) for `a` to `q`: the label of the chosen option; for
/// several, the labels in order, joined with a comma; the custom text instead of an option on a single
/// choice, after the labels on a multi-select.
pub fn expected_answer(q: &AskQuestion, a: &AskAnswer) -> String {
    let custom = a.custom.as_deref().map_or("", trim);
    let mut chosen = a.selected.clone();
    chosen.sort_unstable();
    let labels: Vec<&str> = chosen
        .iter()
        .filter(|&&k| k < q.options.len())
        .map(|&k| q.options[k].label.as_str())
        .collect();
    if !q.multi {
        return if !custom.is_empty() {
            custom.to_owned()
        } else {
            labels.first().map_or("", |l| l).to_owned()
        };
    }
    let mut all = labels;
    if !custom.is_empty() {
        all.push(custom);
    }
    all.join(", ")
}

fn same(a: &str, b: &str) -> bool {
    flat(a) == flat(b)
}

/// `shown` is `want`, or its start when the row cut it with `…`.
fn same_answer(shown: &str, want: &str) -> bool {
    let s = flat(shown);
    let w = flat(want);
    s == w || s.strip_suffix('…').is_some_and(|cut| w.starts_with(cut))
}

/// A label on screen is the label asked: the same, or its start when a long one was wrapped (only the first
/// row is read).
fn label_matches(shown: &str, want: &str) -> bool {
    let s = flat(shown);
    let w = flat(want);
    s == w || (!s.is_empty() && w.starts_with(&s)) || (!w.is_empty() && s.starts_with(&w))
}

fn is_placeholder(label: &str) -> bool {
    flat(label).to_lowercase().starts_with("type something")
}

/// Whether the tool result `output` Claude recorded says what the person answered:
/// `... "<question>"="<answer>" ...` for every question (Claude words the lead-in two ways, `Your questions
/// have been answered:` and `The user answered:`).
pub fn claude_ask_result_matches(
    output: Option<&str>,
    ask: &PendingAsk,
    answers: &[AskAnswer],
) -> bool {
    let Some(output) = output else {
        return false;
    };
    if answers.len() != ask.questions.len() || answers.is_empty() {
        return false;
    }
    let text = flat(output);
    ask.questions.iter().zip(answers).all(|(q, a)| {
        let pair = format!(
            "\"{}\"=\"{}\"",
            flat(&q.question),
            flat(&expected_answer(q, a))
        );
        text.contains(&pair)
    })
}

// ------------------------------------------------------------------- driver

/// Plans the keys that answer one [`PendingAsk`] with `answers` (one per question, same order). One
/// instance per attempt; call [`next`](Self::next) with each fresh screen.
#[derive(Debug)]
pub struct ClaudeAskDriver {
    ask: PendingAsk,
    answers: Vec<AskAnswer>,
    guard: Guard,
    /// Questions this attempt has sent the answer of.
    sent: BTreeSet<usize>,
    revisits: HashMap<usize, usize>,
}

impl ClaudeAskDriver {
    /// A driver for `ask` and one answer per question. A different number of answers is never driven:
    /// every screen is a [`AskStep::Mismatch`].
    pub fn new(ask: PendingAsk, answers: Vec<AskAnswer>) -> Self {
        Self::with_max_steps(ask, answers, 60)
    }

    /// [`new`](Self::new) that gives up (mismatch) after `max_steps` sent steps.
    pub fn with_max_steps(ask: PendingAsk, answers: Vec<AskAnswer>, max_steps: usize) -> Self {
        Self {
            ask,
            answers,
            guard: Guard::new(max_steps),
            sent: BTreeSet::new(),
            revisits: HashMap::new(),
        }
    }

    /// The next step for `screen`.
    pub fn next(&mut self, screen: &str) -> AskStep {
        if self.answers.len() != self.ask.questions.len() {
            return AskStep::Mismatch("one answer per question".to_owned());
        }
        let s = parse_claude_ask(screen);
        let step = self.plan(&s);
        self.guard.check(step, &s.fingerprint)
    }

    fn plan(&mut self, s: &ClaudeAskScreen) -> AskStep {
        if s.kind == ClaudeAskKind::None {
            return AskStep::Done;
        }
        let qs = self.ask.questions.len();
        if !s.tabs.is_empty() && s.tabs.len() != qs {
            return AskStep::Mismatch(format!(
                "{} tabs on screen, {qs} questions asked",
                s.tabs.len()
            ));
        }
        if s.kind == ClaudeAskKind::Review {
            self.review(s)
        } else {
            self.question(s)
        }
    }

    // -- the review tab

    fn review(&mut self, s: &ClaudeAskScreen) -> AskStep {
        let n = self.ask.questions.len();
        // Everything on it must be what the person answered, in order of asking.
        for i in 0..n {
            let shown = s.review_answer_of(&self.ask.questions[i].question);
            let want = expected_answer(&self.ask.questions[i], &self.answers[i]);
            if shown.is_some_and(|shown| same_answer(shown, &want)) {
                continue;
            }
            // Not answered, or answered otherwise: back to that question.
            let visits = self.revisits.entry(i).or_insert(0);
            *visits += 1;
            if *visits > 2 {
                return AskStep::Mismatch(format!("question {} would not take its answer", i + 1));
            }
            self.sent.remove(&i);
            return send(
                repeat("left", n - i),
                false,
                format!("back to question {}", i + 1),
            );
        }
        // Digit 1 submits at once, wherever the cursor is.
        send(vec!["1".to_owned()], true, "submit the answers".to_owned())
    }

    // -- a question tab

    /// The index of the question `s` shows: the only one of a lone question, else the one whose text is the
    /// title.
    fn which(&self, s: &ClaudeAskScreen) -> Option<usize> {
        let qs = &self.ask.questions;
        if s.tabs.is_empty() && qs.len() == 1 && s.title.is_empty() {
            return Some(0);
        }
        let hits: Vec<usize> = (0..qs.len())
            .filter(|&i| same(&s.title, &qs[i].question))
            .collect();
        (hits.len() == 1).then(|| hits[0])
    }

    fn question(&mut self, s: &ClaudeAskScreen) -> AskStep {
        let Some(i) = self.which(s) else {
            return AskStep::Mismatch("the question on screen is not the one asked".to_owned());
        };
        let q = self.ask.questions[i].clone();
        let a = self.answers[i].clone();
        let lone = s.tabs.len() <= 1 && self.ask.questions.len() == 1 && !q.multi;
        let n = q.options.len();
        // Rows 1..n are the options, n+1 is Other: anything else is a dialog this driver does not know.
        if s.options.len() != n + 1 {
            return AskStep::Mismatch(format!(
                "{} options on screen, {n} asked",
                s.options.len() as i64 - 1
            ));
        }
        for k in 0..n {
            if !label_matches(&s.options[k].label, &q.options[k].label) {
                return AskStep::Mismatch(format!(
                    "option {} on screen is not \"{}\"",
                    k + 1,
                    q.options[k].label
                ));
            }
        }
        let custom = a.custom.as_deref().map_or("", trim);
        let other = &s.options[n];
        // 1-based among the rows the arrows visit: the options, Other, the Submit row of a multi-select,
        // `Chat about this`.
        let Some(cursor) = s.cursor_number else {
            return AskStep::Mismatch("the cursor is not on a row of the dialog".to_owned());
        };

        if q.multi {
            let want: BTreeSet<usize> = a.selected.iter().copied().collect();
            for k in 0..n {
                if s.options[k].checked != want.contains(&k) {
                    let mut ks = moves(cursor, k + 1);
                    ks.push("enter".to_owned());
                    return send(ks, false, format!("toggle {}", q.options[k].label));
                }
            }
            if !custom.is_empty() {
                if !(other.checked && same(&other.label, custom)) {
                    if cursor != n + 1 {
                        return send(moves(cursor, n + 1), false, "to the Other row".to_owned());
                    }
                    if is_placeholder(&other.label) {
                        return typing(custom, "type the other answer");
                    }
                    return AskStep::Mismatch("the Other row holds other text".to_owned());
                }
            } else if other.checked {
                let mut ks = moves(cursor, n + 1);
                ks.push("enter".to_owned());
                return send(ks, false, "uncheck the Other row".to_owned());
            }
            return self.advance(i, cursor == n + 1);
        }

        // A single choice.
        if !custom.is_empty() {
            if same(&other.label, custom) {
                if cursor != n + 1 {
                    return send(moves(cursor, n + 1), false, "to the Other row".to_owned());
                }
                self.sent.insert(i);
                return send(
                    vec!["enter".to_owned()],
                    lone,
                    "submit the other answer".to_owned(),
                );
            }
            if cursor != n + 1 {
                return send(moves(cursor, n + 1), false, "to the Other row".to_owned());
            }
            if is_placeholder(&other.label) {
                return typing(custom, "type the other answer");
            }
            return AskStep::Mismatch("the Other row holds other text".to_owned());
        }
        let [k] = a.selected[..] else {
            return AskStep::Mismatch(format!("question {} needs exactly one option", i + 1));
        };
        if k >= n {
            return AskStep::Mismatch(format!("question {} needs exactly one option", i + 1));
        }
        // Already answered with it (the tab strip says so and the row is marked): on to the next tab.
        if self.sent.contains(&i) && s.tab_answered(i) && s.options[k].marked {
            return self.advance(i, cursor == n + 1);
        }
        // Sent but the dialog did not take it: ask again.
        self.sent.insert(i);
        let mut ks = moves(cursor, k + 1);
        ks.push("enter".to_owned());
        send(ks, lone, format!("choose {}", q.options[k].label))
    }

    /// Goes on from a finished question to the next tab (the review after the last), off the Other row
    /// first: there the arrow keys may move the text cursor.
    fn advance(&mut self, i: usize, on_other_row: bool) -> AskStep {
        self.sent.insert(i);
        if on_other_row {
            return keys(&["up"], "off the Other row");
        }
        keys(&["right"], "next tab")
    }
}

/// Claude Code's question tool: [`ClaudeAskDriver`] for the keys, [`claude_ask_result_matches`] for the
/// log's word on what was answered.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClaudeAsk;

impl AskDriver for ClaudeAsk {
    fn looks_like_ask(&self, screen: &str) -> bool {
        looks_like_claude_ask(screen)
    }

    fn stepper(
        &self,
        ask: &PendingAsk,
        answers: &[AskAnswer],
    ) -> Box<dyn FnMut(&str) -> AskStep + Send> {
        let mut driver = ClaudeAskDriver::new(ask.clone(), answers.to_vec());
        Box::new(move |screen| driver.next(screen))
    }

    fn result_matches(
        &self,
        output: Option<&str>,
        ask: &PendingAsk,
        answers: &[AskAnswer],
    ) -> bool {
        claude_ask_result_matches(output, ask, answers)
    }
}
