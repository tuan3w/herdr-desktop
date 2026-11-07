//! A small model of omp's ask dialog (`AskDialogComponent`, omp 18.4.12): it takes herdr key names and pasted
//! text like the real one and draws the same box in plain text, so the key plans of the omp driver can be
//! run against it.
//!
//! How faithful it is: the key sequences that produced the screens captured from a real omp (see
//! `omp_fixtures::CAPTURES`) were replayed on it and its dialog compared row for row with the capture
//! (layout, wrapping, tab strip, review tab, scrolling and scrollbar thumb, the footer, the editor box); the
//! goldens in `omp_screen_tests` are some of them. Keys are modelled from the component's source (what
//! Enter, Space, Tab, Esc, Ctrl+U do). NOT modelled: markdown in labels (only backticks are dropped), notes
//! (`n`), page up/down, the countdown, images, the draft guard, a cursor row taller than the body, the
//! colour that marks the active tab.
//!
//! Lengths are counted in characters: the texts used are all narrow, so a character is a cell (and, being
//! in the basic plane, one UTF-16 unit, which is what the Dart fake counts).

use std::collections::{BTreeSet, HashMap};

use crate::observed::model::{AskAnswer, AskQuestion};

/// The state a person could have left one question in.
#[derive(Debug, Default, Clone)]
pub(super) struct Seed {
    pub cursor: Option<usize>,
    pub selected: Option<BTreeSet<usize>>,
    pub custom: Option<String>,
}

#[derive(Debug, Clone)]
struct QState {
    cursor: usize,
    scroll: usize,
    selected: BTreeSet<usize>,
    custom: Option<String>,
}

pub(super) struct FakeOmpAsk {
    questions: Vec<AskQuestion>,
    cols: usize,
    term_rows: usize,
    /// Tab labels the agent gave (`header`), by question index; the id otherwise.
    headers: HashMap<usize, String>,
    states: Vec<QState>,
    tab: usize,
    /// Text typed so far, or `None` when the editor is closed.
    editor: Option<String>,
    editor_for: usize,
    expanded: bool,
    stable_height: Option<usize>,
    pub closed: bool,
    pub cancelled: bool,
    /// What the dialog handed back on submit: per question the selected option indexes in option order and
    /// the custom answer.
    pub submitted: Option<Vec<AskAnswer>>,
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

impl FakeOmpAsk {
    pub fn new(questions: &[AskQuestion]) -> Self {
        Self::with(questions, 119, &[])
    }

    pub fn with(questions: &[AskQuestion], cols: usize, headers: &[(usize, &str)]) -> Self {
        let states = questions
            .iter()
            .map(|q| QState {
                cursor: q
                    .recommended
                    .unwrap_or(0)
                    .min(q.options.len().saturating_sub(1)),
                scroll: 0,
                selected: BTreeSet::new(),
                custom: None,
            })
            .collect();
        Self {
            questions: questions.to_vec(),
            cols,
            term_rows: 40,
            headers: headers.iter().map(|(k, h)| (*k, (*h).to_owned())).collect(),
            states,
            tab: 0,
            editor: None,
            editor_for: 0,
            expanded: false,
            stable_height: None,
            closed: false,
            cancelled: false,
            submitted: None,
        }
    }

    fn has_tabs(&self) -> bool {
        self.questions.len() > 1 || self.questions.iter().any(|q| q.multi)
    }

    fn on_review(&self) -> bool {
        self.has_tabs() && self.tab == self.questions.len()
    }

    /// Puts question `k` in a state the person could have left it in; test set-up only.
    pub fn seed(&mut self, k: usize, seed: Seed) {
        let s = &mut self.states[k];
        if let Some(c) = seed.cursor {
            s.cursor = c;
        }
        if let Some(sel) = seed.selected {
            s.selected = sel;
        }
        if seed.custom.is_some() {
            s.custom = seed.custom;
        }
    }

    /// Makes the dialog start on that tab.
    pub fn set_tab(&mut self, tab: usize) {
        self.tab = tab;
    }

    // ---------------------------------------------------------------- input

    pub fn press(&mut self, key: &str) {
        if self.closed {
            return;
        }
        if let Some(editor) = self.editor.as_mut() {
            match key {
                "enter" | "ctrl+q" => self.finish_editor(),
                "esc" => self.editor = None,
                "ctrl+u" => editor.clear(),
                "backspace" => {
                    editor.pop();
                }
                _ => {}
            }
            return;
        }
        if key == "esc" {
            self.closed = true;
            self.cancelled = true;
            return;
        }
        if key == "ctrl+o" {
            self.expanded = !self.expanded;
            self.stable_height = None;
            return;
        }
        if self.has_tabs() {
            match key {
                "tab" | "right" => return self.switch_tab(1),
                "shift+tab" | "left" => return self.switch_tab(-1),
                _ => {}
            }
        }
        if self.on_review() {
            if key == "enter" {
                self.submit();
            }
            return;
        }
        let rows = self.questions[self.tab].options.len() + 1;
        let tab = self.tab;
        match key {
            "up" => {
                let s = &mut self.states[tab];
                s.cursor = s.cursor.saturating_sub(1);
            }
            "down" => {
                let s = &mut self.states[tab];
                s.cursor = (s.cursor + 1).min(rows - 1);
            }
            "enter" | "space" => {
                if key == "space" && !self.questions[tab].multi {
                    return;
                }
                self.commit(key == "enter");
            }
            _ => {}
        }
    }

    /// Pasted text (bracketed paste) goes into the editor; elsewhere it is lost.
    pub fn paste(&mut self, text: &str) {
        if let Some(e) = self.editor.as_mut() {
            e.push_str(text);
        }
    }

    fn switch_tab(&mut self, d: isize) {
        let count = self.questions.len() as isize + 1;
        self.tab = ((self.tab as isize + d + count) % count) as usize;
    }

    fn commit(&mut self, is_enter: bool) {
        let tab = self.tab;
        let multi = self.questions[tab].multi;
        let n = self.questions[tab].options.len();
        let s = &mut self.states[tab];
        if s.cursor == n {
            self.editor = Some(s.custom.clone().unwrap_or_default());
            self.editor_for = tab;
            return;
        }
        if multi {
            if is_enter {
                return self.advance();
            }
            if !s.selected.remove(&s.cursor) {
                s.selected.insert(s.cursor);
            }
            return;
        }
        s.selected.clear();
        s.selected.insert(s.cursor);
        s.custom = None;
        self.advance();
    }

    fn finish_editor(&mut self) {
        let text = self.editor.take().unwrap_or_default();
        let k = self.editor_for;
        let multi = self.questions[k].multi;
        if text.trim().is_empty() {
            self.states[k].custom = None;
            return;
        }
        self.states[k].custom = Some(text);
        if !multi {
            self.states[k].selected.clear();
        }
        if multi && self.questions.len() == 1 {
            self.tab = self.questions.len();
        } else {
            self.advance();
        }
    }

    fn advance(&mut self) {
        if self.questions.len() == 1 {
            return self.submit();
        }
        self.tab = if self.tab + 1 < self.questions.len() {
            self.tab + 1
        } else {
            self.questions.len()
        };
    }

    fn submit(&mut self) {
        self.closed = true;
        self.submitted = Some(
            self.states
                .iter()
                .map(|s| AskAnswer {
                    selected: s.selected.iter().copied().collect(),
                    custom: s.custom.clone(),
                })
                .collect(),
        );
    }

    // -------------------------------------------------------------- drawing

    fn w(&self) -> usize {
        self.cols - 4
    }

    fn marker(q: &AskQuestion, checked: bool) -> &'static str {
        match (q.multi, checked) {
            (true, true) => "☑",
            (true, false) => "☐",
            (false, true) => "◉",
            (false, false) => "○",
        }
    }

    fn wrap(text: &str, width: usize) -> Vec<String> {
        let width = width.max(1);
        let mut out = Vec::new();
        for para in text.split('\n') {
            let mut line = String::new();
            for word in para.split(' ') {
                let mut word = word.to_owned();
                if word.is_empty() {
                    continue;
                }
                while chars(&word) > width {
                    if !line.is_empty() {
                        out.push(std::mem::take(&mut line));
                    }
                    out.push(word.chars().take(width).collect());
                    word = word.chars().skip(width).collect();
                }
                if line.is_empty() {
                    line = word;
                } else if chars(&line) + 1 + chars(&word) <= width {
                    line = format!("{line} {word}");
                } else {
                    out.push(std::mem::replace(&mut line, word));
                }
            }
            out.push(line);
        }
        out
    }

    fn trunc(s: &str, width: usize) -> String {
        let width = width.max(1);
        if chars(s) <= width {
            s.to_owned()
        } else {
            format!("{}…", s.chars().take(width - 1).collect::<String>())
        }
    }

    fn plain(s: &str) -> String {
        s.replace('`', "")
    }

    fn display_label(q: &AskQuestion, i: usize) -> String {
        let base = Self::plain(&q.options[i].label);
        if q.recommended == Some(i) && !base.ends_with(" (Recommended)") {
            format!("{base} (Recommended)")
        } else {
            base
        }
    }

    fn tab_label(&self, k: usize) -> String {
        let label = self
            .headers
            .get(&k)
            .cloned()
            .unwrap_or_else(|| self.questions[k].id.clone());
        Self::trunc(&label, 16)
    }

    /// One row of a question as lines.
    fn row_lines(
        &self,
        q: &AskQuestion,
        s: &QState,
        row: usize,
        width: usize,
        selected: bool,
    ) -> Vec<String> {
        let is_other = row == q.options.len();
        let checked = if is_other {
            s.custom.is_some()
        } else {
            s.selected.contains(&row)
        };
        let label = if is_other {
            "Other (type your own)".to_owned()
        } else {
            Self::display_label(q, row)
        };
        let cursor = if selected { "❯ " } else { "  " };
        let wrapped = Self::wrap(&label, width.saturating_sub(4).max(1));
        let mut lines = vec![format!(
            "{cursor}{} {}",
            Self::marker(q, checked),
            wrapped[0]
        )];
        for l in wrapped.iter().skip(1) {
            lines.push(format!("    {l}"));
        }
        if !is_other {
            let d = q.options[row].description.trim();
            if !d.is_empty() {
                let w = Self::wrap(&Self::plain(d), width.saturating_sub(6).max(1));
                let take = if self.expanded { w.len() } else { 2 };
                for l in w.iter().take(take) {
                    lines.push(format!("      {}", Self::trunc(l, width.saturating_sub(6))));
                }
            }
        } else if let Some(custom) = &s.custom {
            let one_line = custom.split_whitespace().collect::<Vec<_>>().join(" ");
            lines.push(format!(
                "      {}",
                Self::trunc(&one_line, width.saturating_sub(6))
            ));
        }
        lines
    }

    fn title_lines(q: &AskQuestion, width: usize, max_rows: usize) -> Vec<String> {
        let w = Self::wrap(&Self::plain(&q.question), width);
        if w.len() <= max_rows {
            return w;
        }
        let mut out: Vec<String> = w.iter().take(max_rows - 1).cloned().collect();
        out.push(Self::trunc(
            &w.iter()
                .skip(max_rows - 1)
                .cloned()
                .collect::<Vec<_>>()
                .join(" "),
            width,
        ));
        out
    }

    fn desc_overflow(&self, q: &AskQuestion) -> bool {
        q.options.iter().any(|o| {
            let d = o.description.trim();
            !d.is_empty()
                && Self::wrap(&Self::plain(d), self.w().saturating_sub(6).max(1)).len() > 2
        })
    }

    fn measure_height(&self) -> usize {
        let max_height = 12.max((self.term_rows as f64 * 0.7).floor() as usize);
        let tab_rows = usize::from(self.has_tabs());
        let mut needed = 12;
        for (k, q) in self.questions.iter().enumerate() {
            let title_rows = if self.expanded { 1 << 20 } else { 4 };
            let header = tab_rows + Self::title_lines(q, self.w(), title_rows).len();
            let body: usize = (0..=q.options.len())
                .map(|r| self.row_lines(q, &self.states[k], r, self.w(), false).len())
                .sum();
            needed = needed.max(5 + header + 5.max(body));
        }
        if self.has_tabs() {
            needed = needed.max(5 + tab_rows + 1 + 5.max(2 + self.questions.len() + 2));
        }
        needed.min(max_height)
    }

    fn summary(&self, k: usize) -> String {
        let q = &self.questions[k];
        let s = &self.states[k];
        let sel: Vec<String> = (0..q.options.len())
            .filter(|i| s.selected.contains(i))
            .map(|i| Self::display_label(q, i))
            .collect();
        let inline = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
        if q.multi {
            let mut all = sel;
            if let Some(c) = &s.custom {
                all.push(format!("Other: “{}”", inline(c)));
            }
            return if all.is_empty() {
                "unanswered".to_owned()
            } else {
                all.join(", ")
            };
        }
        if let Some(c) = &s.custom {
            return format!("“{}”", inline(c));
        }
        sel.first()
            .cloned()
            .unwrap_or_else(|| "unanswered".to_owned())
    }

    fn fit(text: &str, width: usize) -> String {
        let t = Self::trunc(text, width);
        let pad = width.saturating_sub(chars(&t));
        format!("{t}{}", " ".repeat(pad))
    }

    fn row(&self, text: &str) -> String {
        format!("│ {} │", Self::fit(text, self.w()))
    }

    fn scroll_suffix(offset: usize, rows: usize, total: usize) -> &'static str {
        match (offset > 0, offset + rows < total) {
            (true, true) => "↕",
            (true, false) => "↑",
            (false, true) => "↓",
            (false, false) => "",
        }
    }

    /// The dialog (or the editor over it) as rows of the drawn box.
    pub fn dialog_lines(&mut self) -> Vec<String> {
        if self.editor.is_some() {
            return self.editor_lines();
        }
        let total = match self.stable_height {
            Some(t) => t,
            None => {
                let t = self.measure_height();
                self.stable_height = Some(t);
                t
            }
        };
        let tab_rows = usize::from(self.has_tabs());
        let mut header: Vec<String> = Vec::new();
        if self.has_tabs() {
            let mut tabs: Vec<String> = (0..self.questions.len())
                .map(|k| format!(" {} ", self.tab_label(k)))
                .collect();
            tabs.push(" Submit ".to_owned());
            header.push(tabs.join("  "));
        }
        let review = self.on_review();
        let max_title_rows = total.saturating_sub(10 + tab_rows).max(1);
        if review {
            header.push("Review answers".to_owned());
        } else {
            let q = &self.questions[self.tab];
            let rows = if self.expanded { max_title_rows } else { 4 };
            header.extend(Self::title_lines(q, self.w(), rows));
        }
        let fixed = 1 + header.len() + 1 + 1 + 1 + 1;
        let body_rows = total.saturating_sub(fixed).max(5);

        let mut body: Vec<String> = Vec::new();
        let indicator = if review {
            let unanswered = (0..self.questions.len())
                .filter(|&k| self.states[k].selected.is_empty() && self.states[k].custom.is_none())
                .count();
            if unanswered > 0 {
                body.push(format!(
                    "{unanswered} unanswered question{}; ⏎ still submits.",
                    if unanswered == 1 { "" } else { "s" }
                ));
                body.push(String::new());
            }
            for k in 0..self.questions.len() {
                body.push(format!(
                    "{}. {}: {}",
                    k + 1,
                    self.tab_label(k),
                    self.summary(k)
                ));
            }
            body.push(String::new());
            body.push("❯ Submit".to_owned());
            while body.len() < body_rows {
                body.push(String::new());
            }
            Self::scroll_suffix(0, body_rows, body.len())
        } else {
            let tab = self.tab;
            let q = self.questions[tab].clone();
            let render = |width: usize, me: &Self| -> Vec<Vec<String>> {
                (0..=q.options.len())
                    .map(|r| {
                        me.row_lines(&q, &me.states[tab], r, width, r == me.states[tab].cursor)
                    })
                    .collect()
            };
            let mut rows = render(self.w(), self);
            let count: usize = rows.iter().map(Vec::len).sum();
            let scrollbar = count > body_rows && self.w() > 1;
            if scrollbar {
                rows = render(self.w() - 1, self);
            }
            let mut starts = Vec::new();
            let mut at = 0;
            for r in &rows {
                starts.push(at);
                at += r.len();
            }
            let all: Vec<String> = rows.into_iter().flatten().collect();
            let cursor = self.states[tab].cursor;
            let cursor_start = starts[cursor];
            let cursor_end = if cursor + 1 < starts.len() {
                starts[cursor + 1]
            } else {
                all.len()
            };
            let max_offset = all.len().saturating_sub(body_rows);
            let mut offset = self.states[tab].scroll.min(max_offset);
            if max_offset > 0 && (cursor_start < offset || cursor_end > offset + body_rows) {
                offset = if cursor_end - cursor_start <= body_rows {
                    cursor_end.saturating_sub(body_rows)
                } else {
                    cursor_start
                }
                .min(max_offset);
            }
            if max_offset == 0 {
                offset = 0;
            }
            self.states[tab].scroll = offset;
            let mut visible: Vec<String> =
                all.iter().skip(offset).take(body_rows).cloned().collect();
            if scrollbar {
                let size = 1.max((body_rows * body_rows / all.len()).min(body_rows));
                let travel = body_rows - size;
                let start = if max_offset == 0 {
                    0
                } else {
                    (offset as f64 / max_offset as f64 * travel as f64).round() as usize
                };
                for (i, v) in visible.iter_mut().enumerate() {
                    let bar = if i >= start && i < start + size {
                        '█'
                    } else {
                        '│'
                    };
                    *v = format!("{}{bar}", Self::fit(v, self.w() - 1));
                }
            }
            body.extend(visible);
            while body.len() < body_rows {
                body.push(String::new());
            }
            Self::scroll_suffix(offset, body_rows, all.len())
        };

        let scroll = if indicator.is_empty() {
            String::new()
        } else {
            format!(" {indicator} scroll ·")
        };
        let footer = if review {
            format!("⏎ submit · ↑/↓ scroll ·{scroll} ⎋ cancel")
        } else {
            let q0 = &self.questions[self.tab];
            let enter_action = if self.questions.len() > 1 {
                "next"
            } else {
                "submit"
            };
            let action = if q0.multi {
                format!("␣ toggle · ⏎ {enter_action}")
            } else {
                "⏎ select · n note".to_owned()
            };
            let tabs = if self.has_tabs() {
                " · ⇥/←/→"
            } else {
                ""
            };
            let title_cut = Self::wrap(&Self::plain(&q0.question), self.w()).len() > 4;
            let expand = if title_cut || self.desc_overflow(q0) {
                format!(
                    " · Ctrl+O {}",
                    if self.expanded { "collapse" } else { "expand" }
                )
            } else {
                String::new()
            };
            format!("{action} · ↑/↓ move{tabs} ·{scroll} ⎋ cancel{expand}")
        };

        let bar = "─".repeat(self.cols - 2);
        let title = "╭─ Ask ";
        let mut out = vec![format!(
            "{title}{}╮",
            "─".repeat(self.cols - chars(title) - 1)
        )];
        out.extend(header.iter().map(|h| self.row(h)));
        out.push(format!("├{bar}┤"));
        out.extend(body.iter().map(|b| self.row(b)));
        out.push(format!("├{bar}┤"));
        out.push(self.row(&footer));
        out.push(format!("╰{bar}╯"));
        out
    }

    fn editor_lines(&self) -> Vec<String> {
        let q = &self.questions[self.editor_for];
        let head = format!("╭─ Custom answer: {} ", Self::plain(&q.question));
        let bar = "─".repeat(self.cols - 2);
        let editor = self.editor.clone().unwrap_or_default();
        let mut out = vec![
            format!(
                "{}{}╮",
                Self::trunc(&head, self.cols - 1),
                "─".repeat((self.cols - 1).saturating_sub(chars(&head)))
            ),
            self.row(""),
        ];
        for (i, t) in editor.split('\n').enumerate() {
            out.push(self.row(&if i == 0 {
                format!("> {t}")
            } else {
                format!("  {t}")
            }));
        }
        out.push(self.row(""));
        out.push(self.row("⏎ or Ctrl+Q submit  ⎋ cancel  Ctrl+G external editor"));
        out.push(self.row(""));
        out.push(format!("╰{bar}╯"));
        out
    }

    /// A pane screen: a few transcript rows, then the dialog.
    pub fn screen(&mut self) -> String {
        let mut rows = vec![
            String::new(),
            "Call the ask tool once, no other text.".to_owned(),
            String::new(),
        ];
        if !self.closed {
            rows.extend(self.dialog_lines());
        }
        rows.join("\n")
    }
}
