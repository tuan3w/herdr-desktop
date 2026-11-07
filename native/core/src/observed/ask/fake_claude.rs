//! A model of Claude Code's question dialog (`AskUserQuestion`, 2.1.29x) that takes the keys the real one
//! takes and draws the screens the real one draws: what the captured `askfull-*` screens of herdr-mobile
//! show, with the key effects of the capture's key table. The driver is tested against it; the parse tests
//! check its screens against golden ones, so the fake cannot drift from the real screens unnoticed.

use std::collections::BTreeSet;

use crate::observed::model::AskQuestion;

pub(super) struct FakeClaudeAsk {
    pub questions: Vec<AskQuestion>,
    cols: usize,
    /// The tab: 0..n-1 a question, n the review.
    pub tab: usize,
    cursor: Vec<usize>,
    chosen: Vec<Option<usize>>,
    checked: Vec<BTreeSet<usize>>,
    text: Vec<String>,
    other_checked: Vec<bool>,
    /// The dialog ended: the answers given, or declined.
    pub submitted: bool,
    pub declined: bool,
    /// Keys that arrived, in order.
    pub keys: Vec<String>,
}

impl FakeClaudeAsk {
    pub fn new(questions: &[AskQuestion]) -> Self {
        let n = questions.len();
        Self {
            questions: questions.to_vec(),
            cols: 105,
            tab: 0,
            cursor: vec![0; n],
            chosen: vec![None; n],
            checked: vec![BTreeSet::new(); n],
            text: vec![String::new(); n],
            other_checked: vec![false; n],
            submitted: false,
            declined: false,
            keys: Vec::new(),
        }
    }

    fn open(&self) -> bool {
        !self.submitted && !self.declined
    }

    fn lone(&self) -> bool {
        self.questions.len() == 1 && !self.questions[0].multi
    }

    /// The answer of question `q` as the dialog shows it, or `None` when none.
    pub fn answer_of(&self, q: usize) -> Option<String> {
        let question = &self.questions[q];
        if question.multi {
            let mut all: Vec<String> = self.checked[q]
                .iter()
                .map(|&k| question.options[k].label.clone())
                .collect();
            if !self.text[q].is_empty() && self.other_checked[q] {
                all.push(self.text[q].clone());
            }
            return (!all.is_empty()).then(|| all.join(", "));
        }
        let c = self.chosen[q]?;
        Some(if c == question.options.len() {
            self.text[q].clone()
        } else {
            question.options[c].label.clone()
        })
    }

    // Rows of question `q`: options 0..n-1, Other n, Submit n+1 (multi), Chat last.
    fn rows(&self, q: usize) -> usize {
        self.questions[q].options.len() + 1 + usize::from(self.questions[q].multi) + 1
    }

    fn other_row(&self, q: usize) -> usize {
        self.questions[q].options.len()
    }

    fn chat_row(&self, q: usize) -> usize {
        self.rows(q) - 1
    }

    pub fn press(&mut self, key: &str) {
        if !self.open() {
            return;
        }
        self.keys.push(key.to_owned());
        if self.tab == self.questions.len() {
            return self.press_review(key);
        }
        let q = self.tab;
        let n = self.questions[q].options.len();
        match key {
            "down" => self.cursor[q] = (self.cursor[q] + 1).min(self.rows(q) - 1),
            // From the first row it wraps to the Other row.
            "up" => {
                self.cursor[q] = if self.cursor[q] == 0 {
                    self.other_row(q)
                } else {
                    self.cursor[q] - 1
                }
            }
            "right" | "tab" => self.go(self.tab + 1),
            "left" | "shift+tab" => self.go(self.tab.saturating_sub(1)),
            "esc" => self.declined = true,
            "enter" => self.enter(q),
            digit if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() => {
                let d = usize::from(digit.as_bytes()[0] - b'0');
                if self.cursor[q] == self.other_row(q) {
                    self.text[q].push_str(digit);
                    if self.questions[q].multi {
                        self.other_checked[q] = true;
                    }
                } else if d >= 1 && d <= n {
                    self.select(q, d - 1);
                }
            }
            _ => {}
        }
    }

    /// Text typed (pasted) where the cursor is: only the Other row takes it.
    pub fn paste(&mut self, text: &str) {
        if !self.open() || self.tab == self.questions.len() {
            return;
        }
        self.keys.push(format!("paste:{text}"));
        let q = self.tab;
        if self.cursor[q] != self.other_row(q) {
            return;
        }
        self.text[q].push_str(text);
        if self.questions[q].multi {
            self.other_checked[q] = true;
        }
    }

    fn go(&mut self, to: usize) {
        let next = to.min(self.questions.len());
        if next != self.tab && next < self.questions.len() {
            self.cursor[next] = 0;
        }
        self.tab = next;
    }

    fn enter(&mut self, q: usize) {
        let n = self.questions[q].options.len();
        let row = self.cursor[q];
        if row < n {
            return self.select(q, row);
        }
        if row == self.other_row(q) {
            if self.text[q].is_empty() {
                return;
            }
            if self.questions[q].multi {
                self.other_checked[q] = !self.other_checked[q];
            } else {
                self.chosen[q] = Some(n);
                self.after_choice();
            }
            return;
        }
        if self.questions[q].multi && row == n + 1 {
            return self.go(self.questions.len());
        }
        self.declined = true; // Chat about this
    }

    fn select(&mut self, q: usize, k: usize) {
        if self.questions[q].multi {
            if !self.checked[q].remove(&k) {
                self.checked[q].insert(k);
            }
            return;
        }
        self.chosen[q] = Some(k);
        self.after_choice();
    }

    fn after_choice(&mut self) {
        if self.lone() {
            self.submitted = true;
        } else {
            self.go(self.tab + 1);
        }
    }

    fn press_review(&mut self, key: &str) {
        let q = self.questions.len();
        match key {
            "1" | "enter" => self.submitted = true,
            "2" | "esc" => self.declined = true,
            "left" | "shift+tab" => self.go(q - 1),
            _ => {}
        }
    }

    // -- the screen

    pub fn screen(&self) -> String {
        if !self.open() {
            return format!(
                "⏺ {}\n\n❯ \n",
                if self.submitted {
                    "User answered Claude's questions"
                } else {
                    "User declined to answer questions"
                }
            );
        }
        let rule = "─".repeat(self.cols);
        let mut out: Vec<String> = vec![
            " ▐▛███▛█   Claude Code v2.1.295".to_owned(),
            "▝▜██████▀  Sonnet 5.5 · Claude Max".to_owned(),
            "   /home/dev/project".to_owned(),
            String::new(),
            "❯ ask me something".to_owned(),
            String::new(),
            rule.clone(),
        ];
        let strip = self.strip();
        if self.tab == self.questions.len() {
            out.extend([
                strip,
                String::new(),
                "Review your answers".to_owned(),
                String::new(),
            ]);
            let answered: Vec<usize> = (0..self.questions.len())
                .filter(|&i| self.answer_of(i).is_some())
                .collect();
            if answered.len() < self.questions.len() {
                out.push("⚠ You have not answered all questions".to_owned());
                out.push(String::new());
            }
            for &i in &answered {
                out.push(format!(" ● {}", self.questions[i].question));
                out.push(format!("   → {}", self.answer_of(i).unwrap_or_default()));
            }
            out.extend([
                String::new(),
                "Ready to submit your answers?".to_owned(),
                String::new(),
                "❯ 1. Submit answers".to_owned(),
                "  2. Cancel".to_owned(),
            ]);
            return out.join("\n");
        }
        let q = self.tab;
        let question = &self.questions[q];
        let n = question.options.len();
        let multi = question.multi;
        if !strip.is_empty() {
            out.push(strip);
        }
        out.extend([String::new(), self.wrap(&question.question), String::new()]);
        let mark = |row: usize| if self.cursor[q] == row { "❯" } else { " " };
        for (k, o) in question.options.iter().enumerate() {
            let boxed = if multi {
                if self.checked[q].contains(&k) {
                    "[✔] "
                } else {
                    "[ ] "
                }
            } else {
                ""
            };
            let done = if !multi && self.chosen[q] == Some(k) {
                " ✔"
            } else {
                ""
            };
            out.push(format!("{} {}. {boxed}{}{done}", mark(k), k + 1, o.label));
            let description = if o.description.is_empty() {
                &o.label
            } else {
                &o.description
            };
            out.push(format!(
                "{}{description}",
                " ".repeat(if multi { 9 } else { 5 })
            ));
        }
        let text = &self.text[q];
        let other_label = if multi {
            format!(
                "{} {}",
                if self.other_checked[q] && !text.is_empty() {
                    "[✔]"
                } else {
                    "[ ]"
                },
                if text.is_empty() {
                    "Type something"
                } else {
                    text
                }
            )
        } else if text.is_empty() {
            "Type something.".to_owned()
        } else {
            text.clone()
        };
        out.push(format!("{} {}. {other_label}", mark(n), n + 1));
        if multi {
            out.push(format!("{}    Submit", mark(n + 1)));
        }
        out.push(rule);
        out.push(format!(
            "{} {}. Chat about this",
            mark(self.chat_row(q)),
            self.chat_row(q) + usize::from(!multi)
        ));
        out.push(String::new());
        out.push(format!(
            "Enter to select · {} to navigate{} · Esc to cancel",
            if self.lone() {
                "↑/↓"
            } else {
                "Tab/Arrow keys"
            },
            if self.cursor[q] == self.other_row(q) {
                " · ctrl+g to edit in Vim"
            } else {
                ""
            }
        ));
        out.join("\n")
    }

    fn strip(&self) -> String {
        if self.lone() {
            return format!(" ☐ {} ", self.questions[0].id);
        }
        let tabs: Vec<String> = (0..self.questions.len())
            .map(|i| {
                format!(
                    "{} {}",
                    if self.answer_of(i).is_some() {
                        '☒'
                    } else {
                        '☐'
                    },
                    self.questions[i].id
                )
            })
            .collect();
        format!("←  {}  ✔ Submit  →", tabs.join("  "))
    }

    /// A question longer than a row wraps under a bar of its own.
    fn wrap(&self, text: &str) -> String {
        let width = self.cols - 5;
        if text.chars().count() <= width {
            return text.to_owned();
        }
        let head: Vec<char> = text.chars().take(self.cols - 6).collect();
        let cut = head.iter().rposition(|&c| c == ' ').unwrap_or(head.len());
        let first: String = text.chars().take(cut).collect();
        let rest: String = text.chars().skip(cut + 1).collect();
        format!("│ {first}\n│ {rest}")
    }
}
