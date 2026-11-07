//! Answers omp's question tool (`ask`) by KEYS, from what the pane shows.
//!
//! omp draws the tool as a modal "Ask" box at the bottom of the pane (`AskDialogComponent`,
//! `packages/tui/src/overlays/ask-dialog.ts`, omp 18.4):
//!
//! ```text
//! ╭─ Ask ───────────────────────────────╮
//! │  Storage    extras    name    Submit │   tab strip (only with 2+ questions
//! │ Where should data live?              │   or any multi-select question)
//! ├──────────────────────────────────────┤
//! │   ○ SQLite                           │   ❯ marks the cursor row, ○/◉ a
//! │       Single file                    │   single choice, ☐/☑ a multi-select
//! │ ❯ ○ Postgres (Recommended)           │
//! │   ○ Other (type your own)            │   always the last row
//! ├──────────────────────────────────────┤
//! │ ⏎ select · n note · ↑/↓ move · …     │
//! ╰──────────────────────────────────────╯
//! ```
//!
//! Keys (verified on a real omp 18.4.12):
//!
//! | key | where | effect |
//! | --- | --- | --- |
//! | `up` / `down` | question tab | cursor one row (clamped, no wrap) |
//! | `enter` | single choice, on an option | select it and go to the next tab; a lone single-choice question submits |
//! | `space` | multi-select, on an option | toggle it |
//! | `enter` | multi-select, on an option | NO toggle: go to the next tab; a lone multi-select question submits |
//! | `enter` | on `Other (type your own)` | open the custom-answer editor |
//! | `tab` / `shift+tab` | with a tab strip | next / previous tab, wrapping through `Submit` (the review tab) |
//! | `enter` | review tab | submit |
//! | `esc` | anywhere | cancel the whole tool call |
//! | `enter` / `ctrl+u` / `esc` | editor | submit its text / clear the line / back to the dialog |
//!
//! The tab strip does not say which tab is active in plain text (only the colour does), so the active
//! question is found by matching the question text and the option labels on screen against the structured
//! [`PendingAsk`] the session log gave us.
//!
//! The screen is the truth. [`OmpAskDriver::next`] reads a screen and gives the ONE next thing to send. The
//! driver keeps one memory: the checked state of multi-select rows that scrolled out of view (they cannot
//! change while out of view), and counters that stop an endless loop.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

use regex::Regex;

use super::text::{cut_by_ellipsis, flat, key, rx, trim, trim_end, trim_start};
use super::{Guard, keys, moves, repeat, send, typing};
use crate::observed::model::{AskAnswer, AskDriver, AskQuestion, AskStep, PendingAsk};

/// Which part of omp's ask dialog a screen shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AskScreenKind {
    /// No ask dialog is showing.
    #[default]
    None,
    /// A question tab.
    Question,
    /// The review tab (`Submit`).
    Review,
    /// The custom-answer (or note) editor over the dialog.
    Editor,
}

impl AskScreenKind {
    fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Question => "question",
            Self::Review => "review",
            Self::Editor => "editor",
        }
    }
}

/// One option row as drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskScreenRow {
    /// The label as drawn: wrapped lines joined with a space, `(Recommended)` still on it.
    pub label: String,
    /// The `❯` is on this row.
    pub cursor: bool,
    /// The marker is the ticked one (`◉`, `☑`).
    pub checked: bool,
    /// A checkbox (`☐`/`☑`), not a radio (`○`/`◉`).
    pub multi: bool,
    /// The description rows (at most two while collapsed), or for the `Other` row the custom answer drawn
    /// under it.
    pub description: String,
}

impl AskScreenRow {
    /// The free-text row, always last.
    pub fn is_other(&self) -> bool {
        key(&self.label) == other_key()
    }
}

fn other_key() -> &'static str {
    static OTHER: LazyLock<String> = LazyLock::new(|| key("Other (type your own)"));
    &OTHER
}

/// One line of the review tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskReviewLine {
    /// Zero-based question index.
    pub index: usize,
    /// What the review shows after the label; `unanswered` when empty.
    pub answer: String,
}

/// What the ask dialog on a screen says. Pure reading; no judgement.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AskScreenState {
    /// What part of the dialog this is.
    pub kind: AskScreenKind,
    /// Tab labels including the final `Submit`; empty without a tab strip. The active one is not marked in
    /// plain text.
    pub tabs: Vec<String>,
    /// The question as drawn (wrapped rows joined; ends in `…` when cut), the editor's question, or
    /// `Review answers`.
    pub title: String,
    /// Question tab: the VISIBLE option rows, the `Other` row last when in view.
    pub rows: Vec<AskScreenRow>,
    /// Review tab.
    pub review: Vec<AskReviewLine>,
    /// Review tab: how many questions it says are unanswered.
    pub unanswered: usize,
    /// The countdown in the box title (`Ask (12s)`), when the agent set a timeout.
    pub seconds_left: Option<u64>,
    /// Editor: what is typed so far.
    pub editor_text: String,
    /// The composer holds a draft, so the dialog ignores keys until it is cleared.
    pub blocked_by_draft: bool,
}

impl AskScreenState {
    /// Whether the dialog has a tab strip.
    pub fn has_tabs(&self) -> bool {
        !self.tabs.is_empty()
    }

    /// Index into [`rows`](Self::rows) of the cursor.
    pub fn cursor_row(&self) -> Option<usize> {
        self.rows.iter().position(|r| r.cursor)
    }

    /// Whether the visible rows are checkboxes.
    pub fn multi(&self) -> bool {
        self.rows.iter().any(|r| r.multi)
    }

    /// Same dialog, same cursor, same checks, same text.
    pub fn fingerprint(&self) -> String {
        let mut parts = vec![
            self.kind.name().to_owned(),
            self.tabs.join("|"),
            self.title.clone(),
        ];
        parts.extend(
            self.rows
                .iter()
                .map(|r| format!("{}{}{}{}", r.cursor, r.checked, r.label, r.description)),
        );
        parts.extend(
            self.review
                .iter()
                .map(|l| format!("{}{}", l.index, l.answer)),
        );
        parts.push(self.editor_text.clone());
        parts.join("\n")
    }
}

/// The rows of a pane read: carriage returns and escape sequences gone, trailing space trimmed.
pub(super) fn screen_lines(screen: &str) -> Vec<String> {
    static ANSI: LazyLock<Regex> = LazyLock::new(|| {
        rx(
            r"\x1B\[[0-9;:?<=>]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[()][A-Za-z0-9]|\x1B[=>]",
        )
    });
    screen
        .split('\n')
        .map(|l| trim_end(&ANSI.replace_all(&l.replace('\r', ""), "")).to_owned())
        .collect()
}

/// The last titled box (`╭─ Title ───╮`) of `lines`: the row it starts on and its title. An earlier one is a
/// finished tool call.
pub(super) fn last_titled_box(lines: &[String]) -> Option<(usize, String)> {
    static TOP_BOX: LazyLock<Regex> = LazyLock::new(|| rx(r"^╭─+ (.+?) ─*╮$"));
    lines.iter().enumerate().rev().find_map(|(i, l)| {
        TOP_BOX
            .captures(trim_start(l))
            .map(|m| (i, m[1].to_owned()))
    })
}

/// The box a cell lives in: its text between the side bars, one space of padding and the trailing bar
/// removed. `None` for a line that is not a box row.
pub(super) fn cell(line: &str) -> Option<String> {
    let t = trim_start(line).strip_prefix('│')?;
    let c = t.strip_prefix(' ').unwrap_or(t);
    let c = trim_end(c);
    let c = c.strip_suffix('│').unwrap_or(c);
    Some(trim_end(c).to_owned())
}

/// Whether an ask dialog (or its custom-answer editor) is on `screen`.
pub fn looks_like_ask(screen: &str) -> bool {
    parse_ask_screen(screen).kind != AskScreenKind::None
}

const CHECKED_MARKERS: [&str; 6] = ["◉", "☑", "(o)", "[x]", "\u{f14a}", "\u{f192}"];
const MULTI_MARKERS: [&str; 6] = ["☐", "☑", "[ ]", "[x]", "\u{f14a}", "\u{f096}"];

/// Reads the ask dialog out of `screen` (plain or ANSI; whole rows of the pane, at least the dialog's
/// height: 45 rows are safe).
pub fn parse_ask_screen(screen: &str) -> AskScreenState {
    static ASK_TITLE: LazyLock<Regex> = LazyLock::new(|| rx(r"^Ask(?: \(([0-9]+)s\))?$"));
    static EDITOR_TITLE: LazyLock<Regex> =
        LazyLock::new(|| rx(r"^(Custom answer|Note for .*?)(?:: (.*))?$"));
    static SCROLLBAR: LazyLock<Regex> = LazyLock::new(|| rx(r"\s[█│▐▌┃]$"));
    static SPLIT_TABS: LazyLock<Regex> = LazyLock::new(|| rx(r"\s{2,}"));

    let lines = screen_lines(screen);
    // The last titled box wins; an earlier one is a finished tool call.
    let Some((top, title)) = last_titled_box(&lines) else {
        return AskScreenState::default();
    };
    let ask = ASK_TITLE.captures(&title);
    let editor = EDITOR_TITLE.captures(&title);
    if ask.is_none() && editor.is_none() {
        return AskScreenState::default();
    }
    let Some(bottom) = (top + 1..lines.len()).find(|&i| trim_start(&lines[i]).starts_with('╰'))
    else {
        return AskScreenState::default();
    };

    // Sections between the dividers.
    let mut sections: Vec<Vec<String>> = vec![Vec::new()];
    for line in &lines[top + 1..bottom] {
        if trim_start(line).starts_with('├') {
            sections.push(Vec::new());
            continue;
        }
        if let Some(c) = cell(line) {
            sections.last_mut().expect("one section").push(c);
        }
    }
    let footer = sections
        .last()
        .and_then(|s| s.last())
        .map_or("", |s| s.as_str());
    let draft = footer.contains("Finish or clear the current prompt");

    let Some(ask) = ask else {
        let editor = editor.expect("a title is the ask's or the editor's");
        let question = editor.get(2).map_or("", |m| m.as_str());
        return parse_editor(question, &sections[0], draft);
    };

    let seconds = ask.get(1).and_then(|m| m.as_str().parse::<u64>().ok());
    if sections.len() < 3 {
        return AskScreenState::default();
    }
    let mut header = sections[0].clone();
    let body: Vec<String> = sections[1]
        .iter()
        .map(|c| SCROLLBAR.replace(c, "").into_owned())
        .collect();

    let mut tabs: Vec<String> = Vec::new();
    if let Some(first) = header.first()
        && first.starts_with(' ')
        && trim_end(first).ends_with("Submit")
    {
        let parts: Vec<String> = SPLIT_TABS.split(trim(first)).map(str::to_owned).collect();
        if parts.len() >= 2 {
            tabs = parts;
            header.remove(0);
        }
    }
    let title0 = header
        .iter()
        .map(|l| trim(l))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

    if title0 == "Review answers" {
        return parse_review(tabs, title0, &body, seconds, draft);
    }

    let mut rows: Vec<AskScreenRow> = Vec::new();
    let mut open: Option<AskScreenRow> = None;
    for c in &body {
        if trim(c).is_empty() {
            continue;
        }
        if let Some(r) = parse_row(c) {
            rows.extend(open.take());
            open = Some(r);
        } else if let Some(row) = open.as_mut() {
            if c.starts_with("      ") {
                row.description = format!("{} {}", row.description, trim(c));
            } else if c.starts_with("    ") {
                row.label = format!("{} {}", row.label, trim(c));
            }
        }
        // else: the tail of a row that scrolled off the top
    }
    rows.extend(open);
    for r in &mut rows {
        r.label = trim(&r.label).to_owned();
        r.description = trim(&r.description).to_owned();
    }

    AskScreenState {
        kind: AskScreenKind::Question,
        tabs,
        title: title0,
        rows,
        seconds_left: seconds,
        blocked_by_draft: draft,
        ..AskScreenState::default()
    }
}

/// An option row of a question tab (cursor slot, marker, label), `None` for any other line.
fn parse_row(c: &str) -> Option<AskScreenRow> {
    static ROW: LazyLock<Regex> = LazyLock::new(|| {
        rx(
            r"^([❯>\x{f054}]|\s) (○|◉|☐|☑|\( \)|\(o\)|\[ \]|\[x\]|[\x{f14a}\x{f096}\x{f192}\x{f10c}])(?: (.*))?$",
        )
    });
    let m = ROW.captures(c)?;
    let marker = &m[2];
    Some(AskScreenRow {
        label: m.get(3).map_or("", |l| l.as_str()).to_owned(),
        cursor: !trim(&m[1]).is_empty(),
        checked: CHECKED_MARKERS.contains(&marker),
        multi: MULTI_MARKERS.contains(&marker),
        description: String::new(),
    })
}

fn parse_review(
    tabs: Vec<String>,
    title: String,
    body: &[String],
    seconds: Option<u64>,
    draft: bool,
) -> AskScreenState {
    static REVIEW: LazyLock<Regex> = LazyLock::new(|| rx(r"^([0-9]+)\. (.*)$"));
    static UNANSWERED: LazyLock<Regex> = LazyLock::new(|| rx(r"^([0-9]+) unanswered questions?;"));
    let mut review = Vec::new();
    let mut unanswered = 0;
    for c in body {
        if let Some(u) = UNANSWERED.captures(c) {
            unanswered = u[1].parse().unwrap_or(0);
            continue;
        }
        let Some(m) = REVIEW.captures(c) else {
            continue;
        };
        // Questions count from 1; a `0.` row is none of ours (Dart would index the tab strip with -1).
        let Some(index) = m[1].parse::<usize>().ok().and_then(|n| n.checked_sub(1)) else {
            continue;
        };
        let mut rest = m[2].to_owned();
        let own_prefix = tabs.get(index).map(|label| format!("{label}:"));
        if let Some(prefix) = own_prefix.filter(|p| rest.starts_with(p.as_str())) {
            rest = rest[prefix.len()..].to_owned();
        } else if let Some(cut) = rest.find(": ") {
            rest = rest[cut + 1..].to_owned();
        }
        review.push(AskReviewLine {
            index,
            answer: trim(&rest).to_owned(),
        });
    }
    AskScreenState {
        kind: AskScreenKind::Review,
        tabs,
        title,
        review,
        unanswered,
        seconds_left: seconds,
        blocked_by_draft: draft,
        ..AskScreenState::default()
    }
}

fn parse_editor(question: &str, cells: &[String], draft: bool) -> AskScreenState {
    let mut text: Vec<String> = Vec::new();
    if let Some(start) = cells.iter().position(|c| c.starts_with('>')) {
        for (i, c) in cells.iter().enumerate().skip(start) {
            if c.contains("submit") && c.contains("cancel") {
                break;
            }
            text.push(if i == start {
                trim_start(&c[1..]).to_owned()
            } else {
                trim(c).to_owned()
            });
        }
    }
    while text.last().is_some_and(String::is_empty) {
        text.pop();
    }
    AskScreenState {
        kind: AskScreenKind::Editor,
        title: question.to_owned(),
        editor_text: text.join("\n"),
        blocked_by_draft: draft,
        ..AskScreenState::default()
    }
}

// ------------------------------------------------------------------ matching

/// Whether the title drawn on screen is `question`'s (the screen cuts a long title with `…`).
fn title_matches(screen_title: &str, question: &str) -> bool {
    let q = key(question);
    match cut_by_ellipsis(screen_title) {
        Some(cut) => {
            let s = key(cut);
            !s.is_empty() && q.starts_with(&s)
        }
        None => key(screen_title) == q,
    }
}

/// Which option of a question a visible row is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Aligned {
    /// The `Other` row.
    Other,
    /// The option at this index.
    Option(usize),
}

/// Per visible row: its option, the Other row, or `None` when the row is none of `q`'s options. Rows are a
/// window of the options in order.
fn align(q: &AskQuestion, rows: &[AskScreenRow]) -> Vec<Option<Aligned>> {
    let mut out = Vec::with_capacity(rows.len());
    let mut next = 0;
    for r in rows {
        if r.is_other() {
            out.push(Some(Aligned::Other));
            continue;
        }
        let k = key(&r.label);
        let found = (next..q.options.len()).find(|&i| {
            let o = key(&q.options[i].label);
            k == o || k == format!("{o}recommended")
        });
        if let Some(i) = found {
            next = i + 1;
        }
        out.push(found.map(Aligned::Option));
    }
    out
}

/// `s` on one line.
fn inline(s: &str) -> String {
    flat(s)
}

/// Whether the text drawn under the `Other` row is `custom` (it is cut with `…` when long).
fn preview_matches(preview: &str, custom: &str) -> bool {
    let c = key(&inline(custom));
    match cut_by_ellipsis(preview) {
        Some(cut) => c.starts_with(&key(cut)),
        None => key(preview) == c,
    }
}

// -------------------------------------------------------------------- driver

/// What the driver knows about the question tab on screen.
#[derive(Clone, Copy)]
struct Tab<'a> {
    q: &'a AskQuestion,
    /// The options the person wants, in order.
    wants: &'a BTreeSet<usize>,
    /// The custom answer, trimmed; empty for none.
    custom: &'a str,
    /// The option index the cursor is on (`options.len()` for Other).
    cursor: usize,
    other: Option<&'a AskScreenRow>,
    /// The Other row is ticked and shows `custom`.
    custom_shown: bool,
}

/// Plans the keys that answer one [`PendingAsk`] with `answers` (one per question, same order). One
/// instance per attempt; call [`next`](Self::next) with each fresh screen.
#[derive(Debug)]
pub struct OmpAskDriver {
    ask: PendingAsk,
    answers: Vec<AskAnswer>,
    guard: Guard,
    clearing: bool,
    /// Per question, per option index (`n` for Other): the checked state last seen.
    known: HashMap<usize, BTreeMap<usize, bool>>,
    revisits: HashMap<usize, usize>,
}

impl OmpAskDriver {
    /// A driver for `ask` and one answer per question. A different number of answers is never driven: every
    /// screen is a [`AskStep::Mismatch`].
    pub fn new(ask: PendingAsk, answers: Vec<AskAnswer>) -> Self {
        Self::with_max_steps(ask, answers, 80)
    }

    /// [`new`](Self::new) that gives up (mismatch) after `max_steps` sent steps.
    pub fn with_max_steps(ask: PendingAsk, answers: Vec<AskAnswer>, max_steps: usize) -> Self {
        Self {
            ask,
            answers,
            guard: Guard::new(max_steps),
            clearing: false,
            known: HashMap::new(),
            revisits: HashMap::new(),
        }
    }

    /// The next step for `screen`.
    pub fn next(&mut self, screen: &str) -> AskStep {
        if self.answers.len() != self.ask.questions.len() {
            return AskStep::Mismatch("one answer per question".to_owned());
        }
        let s = parse_ask_screen(screen);
        let step = self.plan(&s);
        let print = if matches!(step, AskStep::Send { .. }) {
            s.fingerprint()
        } else {
            String::new()
        };
        self.guard.check(step, &print)
    }

    fn plan(&mut self, s: &AskScreenState) -> AskStep {
        if s.kind == AskScreenKind::None {
            return AskStep::Done;
        }
        if s.blocked_by_draft {
            return AskStep::Mismatch("the composer holds a draft: clear it first".to_owned());
        }
        if s.has_tabs() && s.tabs.len() != self.ask.questions.len() + 1 {
            return AskStep::Mismatch(format!(
                "{} tabs on screen, {} questions asked",
                s.tabs.len() - 1,
                self.ask.questions.len()
            ));
        }
        match s.kind {
            AskScreenKind::Editor => self.editor(s),
            AskScreenKind::Review => self.review(s),
            _ => self.question(s),
        }
    }

    /// Index of the question the screen is on, `None` when unsure.
    fn which(&self, s: &AskScreenState, editor: bool) -> Option<usize> {
        let qs = &self.ask.questions;
        let by_title: Vec<usize> = (0..qs.len())
            .filter(|&i| title_matches(&s.title, &qs[i].question))
            .collect();
        if editor {
            return (by_title.len() == 1).then(|| by_title[0]);
        }
        let candidates: Vec<usize> = if by_title.is_empty() {
            (0..qs.len()).collect()
        } else {
            by_title.clone()
        };
        let mut fits = Vec::new();
        for i in candidates {
            let rows = align(&qs[i], &s.rows);
            if rows.iter().any(Option::is_none) {
                continue;
            }
            if by_title.is_empty() && rows.iter().all(|r| *r == Some(Aligned::Other)) {
                continue;
            }
            fits.push(i);
        }
        (fits.len() == 1).then(|| fits[0])
    }

    fn n(&self) -> usize {
        self.ask.questions.len()
    }

    fn editor(&mut self, s: &AskScreenState) -> AskStep {
        if s.title.starts_with("Note for") {
            return keys(&["esc"], "leave a note editor");
        }
        let Some(k) = self.which(s, true) else {
            return AskStep::Mismatch(
                "cannot tell which question the editor belongs to".to_owned(),
            );
        };
        let custom = self.answers[k].custom.as_deref().map_or("", trim);
        let q = &self.ask.questions[k];
        if custom.is_empty() {
            if !s.editor_text.is_empty() {
                self.clearing = true;
                return keys(&["ctrl+u"], "clear the custom answer");
            }
            return if self.clearing {
                keys(&["enter"], "an empty custom answer drops it")
            } else {
                keys(&["esc"], "no custom answer wanted")
            };
        }
        self.clearing = false;
        if key(&s.editor_text) == key(custom) {
            return send(
                vec!["enter".to_owned()],
                self.n() == 1 && !q.multi,
                "submit the custom answer".to_owned(),
            );
        }
        if !s.editor_text.is_empty() {
            return keys(&["ctrl+u"], "clear the prefilled text");
        }
        typing(custom, "type the custom answer")
    }

    fn question(&mut self, s: &AskScreenState) -> AskStep {
        let Some(k) = self.which(s, false) else {
            return AskStep::Mismatch("the question on screen is not the one asked".to_owned());
        };
        let q = self.ask.questions[k].clone();
        let a = &self.answers[k];
        let n = q.options.len();
        let aligned = align(&q, &s.rows);
        let cursor = match s.cursor_row().and_then(|cr| aligned[cr]) {
            Some(Aligned::Other) => n,
            Some(Aligned::Option(i)) => i,
            None => return AskStep::Mismatch("cannot find the cursor row".to_owned()),
        };
        let custom = a.custom.as_deref().map_or("", trim).to_owned();
        let wants: BTreeSet<usize> = a.selected.iter().copied().filter(|&i| i < n).collect();
        let multi_tab = s.rows.iter().any(|r| r.multi);
        if multi_tab != q.multi {
            return AskStep::Mismatch(format!(
                "{} expected, the other drawn",
                if q.multi { "checkboxes" } else { "radios" }
            ));
        }

        let other_idx = aligned.iter().position(|r| *r == Some(Aligned::Other));
        let other = other_idx.map(|i| &s.rows[i]);
        let custom_shown =
            other.is_some_and(|o| o.checked && preview_matches(&o.description, &custom));

        if !q.multi {
            return Self::single(
                s,
                &Tab {
                    q: &q,
                    wants: &wants,
                    custom: &custom,
                    cursor,
                    other,
                    custom_shown,
                },
            );
        }

        // Multi-select. Rows in view are re-read every time; rows out of view keep what was last seen.
        let known = self.known.entry(k).or_default();
        for (r, al) in aligned.iter().enumerate() {
            let at = match al {
                Some(Aligned::Other) => n,
                Some(Aligned::Option(i)) => *i,
                None => continue,
            };
            known.insert(at, s.rows[r].checked);
        }
        let toggles: Vec<usize> = (0..n)
            .filter(|i| known.get(i).is_some_and(|&c| c != wants.contains(i)))
            .collect();
        if !toggles.is_empty() {
            let mut keys_out: Vec<String> = Vec::new();
            let mut at = cursor;
            let mut left = toggles.clone();
            while !left.is_empty() {
                // Stable, so a tie goes to the lower row (Dart's sort is stable for lists this short).
                left.sort_by_key(|&x| x.abs_diff(at));
                let t = left.remove(0);
                keys_out.extend(moves(at, t));
                keys_out.push("space".to_owned());
                at = t;
                if let Some(c) = known.get_mut(&t) {
                    *c = !*c;
                }
            }
            let labels = toggles
                .iter()
                .map(|&i| q.options[i].label.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return send(keys_out, false, format!("toggle {labels}"));
        }
        let mut unseen: Vec<usize> = (0..=n).filter(|i| !known.contains_key(i)).collect();
        if !unseen.is_empty() {
            unseen.sort_by_key(|&x| x.abs_diff(cursor));
            let first = unseen[0];
            return send(
                moves(cursor, first),
                false,
                format!(
                    "scroll to {}",
                    if first == n {
                        "Other"
                    } else {
                        &q.options[first].label
                    }
                ),
            );
        }
        let other_checked = other
            .map(|o| o.checked)
            .or_else(|| known.get(&n).copied())
            .unwrap_or(false);
        if !custom.is_empty() && !(other_checked && (other.is_none() || custom_shown)) {
            let mut ks = moves(cursor, n);
            ks.push("enter".to_owned());
            return send(ks, false, "open the custom answer editor".to_owned());
        }
        if custom.is_empty() && other_checked {
            let mut ks = moves(cursor, n);
            ks.push("enter".to_owned());
            return send(
                ks,
                false,
                "open the editor to drop the custom answer".to_owned(),
            );
        }
        if n == 0 {
            return if s.has_tabs() {
                keys(&["tab"], "no answer wanted, next tab")
            } else {
                AskStep::Mismatch("nothing to answer".to_owned())
            };
        }
        let mut ks = Vec::new();
        if cursor == n {
            ks.push("up".to_owned());
        }
        ks.push("enter".to_owned());
        let lone = self.n() == 1;
        send(
            ks,
            lone,
            if lone { "submit" } else { "next tab" }.to_owned(),
        )
    }

    /// A single-choice tab.
    fn single(s: &AskScreenState, tab: &Tab<'_>) -> AskStep {
        let Tab {
            q,
            wants,
            custom,
            cursor,
            other,
            custom_shown,
        } = *tab;
        let n = q.options.len();
        if !custom.is_empty() {
            if custom_shown && s.has_tabs() {
                return keys(&["tab"], "custom answer already set, next tab");
            }
            let mut ks = moves(cursor, n);
            ks.push("enter".to_owned());
            return send(ks, false, "open the custom answer editor".to_owned());
        }
        if wants.len() > 1 {
            return AskStep::Mismatch("several answers for a single choice".to_owned());
        }
        let Some(&want) = wants.iter().next() else {
            if !s.has_tabs() {
                return AskStep::Mismatch("nothing to answer".to_owned());
            }
            // Skipping must also drop an old custom answer, so look at the Other row.
            let Some(other) = other else {
                return send(moves(cursor, n), false, "look at the Other row".to_owned());
            };
            return if other.checked {
                let mut ks = moves(cursor, n);
                ks.push("enter".to_owned());
                send(
                    ks,
                    false,
                    "open the editor to drop the custom answer".to_owned(),
                )
            } else {
                keys(&["tab"], "no answer wanted, next tab")
            };
        };
        let mut ks = moves(cursor, want);
        ks.push("enter".to_owned());
        send(
            ks,
            !s.has_tabs(),
            format!("choose {}", q.options[want].label),
        )
    }

    /// What the review tab should say for question `k`.
    fn expected_summary(&self, k: usize) -> String {
        let q = &self.ask.questions[k];
        let a = &self.answers[k];
        let custom = a.custom.as_deref().map_or("", trim);
        let wants: BTreeSet<usize> = a
            .selected
            .iter()
            .copied()
            .filter(|&i| i < q.options.len())
            .collect();
        let label = |i: usize| {
            if q.recommended == Some(i) {
                format!("{} (Recommended)", q.options[i].label)
            } else {
                q.options[i].label.clone()
            }
        };
        if !q.multi {
            if !custom.is_empty() {
                return format!("“{}”", inline(custom));
            }
            return wants
                .iter()
                .next()
                .map_or_else(|| "unanswered".to_owned(), |&i| label(i));
        }
        let mut parts: Vec<String> = wants.iter().map(|&i| label(i)).collect();
        if !custom.is_empty() {
            parts.push(format!("Other: “{}”", inline(custom)));
        }
        if parts.is_empty() {
            "unanswered".to_owned()
        } else {
            parts.join(", ")
        }
    }

    fn review_matches(shown: &str, expected: &str) -> bool {
        match cut_by_ellipsis(shown) {
            Some(cut) => key(expected).starts_with(&key(cut)),
            None => key(shown) == key(expected),
        }
    }

    fn review(&mut self, s: &AskScreenState) -> AskStep {
        let n = self.n();
        for j in 0..n {
            let shown = s
                .review
                .iter()
                .find(|l| l.index == j)
                .map_or("unanswered", |l| l.answer.as_str());
            let expected = self.expected_summary(j);
            if Self::review_matches(shown, &expected) {
                continue;
            }
            let visits = self.revisits.entry(j).or_insert(0);
            *visits += 1;
            if *visits > 2 {
                return AskStep::Mismatch(format!(
                    "review shows \"{shown}\" for question {}, wanted \"{expected}\"",
                    j + 1
                ));
            }
            let (back, forward) = (n - j, j + 1);
            let ks = if back <= forward {
                repeat("shift+tab", back)
            } else {
                repeat("tab", forward)
            };
            return send(ks, false, format!("back to question {}", j + 1));
        }
        send(
            vec!["enter".to_owned()],
            true,
            "submit the answers".to_owned(),
        )
    }
}

/// [`OmpAskDriver::next`] without memory: right for lists that fit in the box (rows scrolled out of view
/// are only remembered by an instance).
pub fn next_ask_step(ask: &PendingAsk, answers: &[AskAnswer], screen: &str) -> AskStep {
    OmpAskDriver::new(ask.clone(), answers.to_vec()).next(screen)
}

/// omp's question tool: [`OmpAskDriver`] for the keys, [`ask_result_matches`](super::ask_result_matches)
/// for the log's word on what was answered.
#[derive(Debug, Clone, Copy, Default)]
pub struct OmpAsk;

impl AskDriver for OmpAsk {
    fn looks_like_ask(&self, screen: &str) -> bool {
        looks_like_ask(screen)
    }

    fn stepper(
        &self,
        ask: &PendingAsk,
        answers: &[AskAnswer],
    ) -> Box<dyn FnMut(&str) -> AskStep + Send> {
        let mut driver = OmpAskDriver::new(ask.clone(), answers.to_vec());
        Box::new(move |screen| driver.next(screen))
    }

    fn result_matches(
        &self,
        output: Option<&str>,
        ask: &PendingAsk,
        answers: &[AskAnswer],
    ) -> bool {
        super::ask_result_matches(output, ask, answers)
    }
}
