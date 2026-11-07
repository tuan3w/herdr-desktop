//! The questions behind the omp dialogs of the tests (the tool calls a real omp was given when its screens
//! were captured), and the key sequences that lead to each of those screens.

use super::fake_omp::FakeOmpAsk;
use crate::observed::model::{AskOption, AskQuestion, PendingAsk};

fn options(list: &[(&str, &str)]) -> Vec<AskOption> {
    list.iter()
        .map(|(label, description)| AskOption {
            label: (*label).to_owned(),
            description: (*description).to_owned(),
        })
        .collect()
}

pub(super) fn question(
    id: &str,
    text: &str,
    multi: bool,
    recommended: Option<usize>,
    list: &[(&str, &str)],
) -> AskQuestion {
    AskQuestion {
        id: id.to_owned(),
        question: text.to_owned(),
        options: options(list),
        multi,
        recommended,
    }
}

pub(super) fn pending(questions: &[AskQuestion]) -> PendingAsk {
    PendingAsk {
        tool_call_id: "call".to_owned(),
        questions: questions.to_vec(),
    }
}

pub(super) fn db_question() -> AskQuestion {
    question(
        "db",
        "Which database should the project use?",
        false,
        Some(0),
        &[
            ("SQLite", "Single file, zero setup, good for local tools"),
            (
                "Postgres",
                "Full server, best for concurrent writes and large data sets",
            ),
            ("DuckDB", "Embedded columnar engine for analytics queries"),
        ],
    )
}

pub(super) fn tools_question() -> AskQuestion {
    question(
        "tools",
        "Which tools should the pipeline run?",
        true,
        None,
        &[
            ("Lint", "Static checks on every commit"),
            ("Unit tests", "Fast tests, under a minute"),
            (
                "Integration tests",
                "Needs a database container and takes several minutes on a cold CI runner, so schedule it nightly",
            ),
            ("Type check", ""),
        ],
    )
}

pub(super) fn form_questions() -> Vec<AskQuestion> {
    vec![
        question(
            "storage",
            "Where should data live?",
            false,
            Some(1),
            &[
                ("SQLite", "Single file"),
                ("Postgres", "Server with concurrent writes"),
                ("DuckDB", "Analytics engine"),
            ],
        ),
        question(
            "extras",
            "Which extras do you want?",
            true,
            None,
            &[
                ("Docker image", ""),
                ("CI workflow", ""),
                ("Changelog", ""),
                ("Pre-commit hooks", ""),
            ],
        ),
        question(
            "name",
            "What should the project be called?",
            false,
            None,
            &[],
        ),
    ]
}

pub(super) const FORM_HEADERS: [(usize, &str); 1] = [(0, "Storage")];

pub(super) fn narrow_list() -> AskQuestion {
    question(
        "pick",
        "Pick a target for the release, considering the long list below?",
        false,
        Some(7),
        &[
            ("Alpha", ""),
            ("Bravo", ""),
            (
                "Charlie with a considerably longer label that wraps over several lines in a narrow pane",
                "A very long description that keeps going and going so that it needs more than two rows when wrapped in a narrow pane like this one",
            ),
            ("Delta", ""),
            ("Echo", ""),
            ("Foxtrot", ""),
            ("Golf", ""),
            ("Hotel (use `hotel.cfg`)", ""),
            ("India", ""),
            ("Juliet", ""),
            ("Kilo", ""),
            ("Lima", ""),
            ("Mike", ""),
            ("Tiếng Việt có dấu: Đà Nẵng", ""),
        ],
    )
}

pub(super) fn release_questions() -> Vec<AskQuestion> {
    let mut labels: Vec<(String, String)> = (1..=29)
        .map(|i| {
            let label = if i == 4 {
                "Release 04 with a considerably longer label that wraps over several lines in a narrow pane"
                    .to_owned()
            } else {
                format!("Release {i:02}")
            };
            (label, String::new())
        })
        .collect();
    labels.push(("Tiếng Việt có dấu: Đà Nẵng".to_owned(), String::new()));
    let pick: Vec<(&str, &str)> = labels
        .iter()
        .map(|(l, d)| (l.as_str(), d.as_str()))
        .collect();
    vec![
        question("pick", "Pick a release number?", false, Some(14), &pick),
        question(
            "flags",
            "Which flags?",
            true,
            None,
            &[("Dry run", ""), ("Tag", ""), ("Sign", "")],
        ),
    ]
}

pub(super) const RELEASE_HEADERS: [(usize, &str); 1] = [(1, "Release flags and other long things")];

pub(super) fn yes_no_question() -> AskQuestion {
    question(
        "write_approval",
        "Approve writing hello.txt with content 'hello omq'?",
        false,
        None,
        &[("Yes", ""), ("No", "")],
    )
}

fn repeat(key: &str, n: usize) -> Vec<String> {
    vec![key.to_owned(); n]
}

fn steps(parts: &[&[&str]]) -> Vec<String> {
    parts
        .iter()
        .flat_map(|p| p.iter().map(|s| (*s).to_owned()))
        .collect()
}

/// One screen of a real omp and how to reach it on the fake: the questions, the keys (herdr key names, or
/// `paste:<text>`), the width and the tab labels.
pub(super) struct Capture {
    pub name: &'static str,
    pub questions: Vec<AskQuestion>,
    pub steps: Vec<String>,
    pub cols: usize,
    pub headers: &'static [(usize, &'static str)],
}

impl Capture {
    fn new(name: &'static str, questions: Vec<AskQuestion>, steps: Vec<String>) -> Self {
        Self {
            name,
            questions,
            steps,
            cols: 119,
            headers: &[],
        }
    }

    fn form(name: &'static str, steps: Vec<String>) -> Self {
        Self {
            headers: &FORM_HEADERS,
            ..Self::new(name, form_questions(), steps)
        }
    }

    fn release(name: &'static str, steps: Vec<String>) -> Self {
        Self {
            cols: 58,
            headers: &RELEASE_HEADERS,
            ..Self::new(name, release_questions(), steps)
        }
    }

    /// The fake with the capture's keys pressed.
    pub fn build(&self) -> FakeOmpAsk {
        let mut fake = FakeOmpAsk::with(&self.questions, self.cols, self.headers);
        for s in &self.steps {
            match s.strip_prefix("paste:") {
                Some(text) => fake.paste(text),
                None => fake.press(s),
            }
        }
        fake
    }
}

const FORM_TO_Q2_TOGGLED: &[&str] = &["down", "enter", "space", "down", "down", "space"];
const FORM_TO_NAME: &[&str] = &[
    "enter",
    "enter",
    "paste:abc def",
    "ctrl+u",
    "paste:Hà Nội — dự án",
    "enter",
];

pub(super) fn captures() -> Vec<Capture> {
    vec![
        Capture::new("ask-single", vec![db_question()], vec![]),
        Capture::new("ask-single-down", vec![db_question()], steps(&[&["down"]])),
        Capture::new(
            "ask-single-other",
            vec![db_question()],
            steps(&[&["down", "down", "down"]]),
        ),
        Capture::new(
            "ask-other-editor",
            vec![db_question()],
            steps(&[&["down", "down", "down", "enter"]]),
        ),
        Capture::new(
            "ask-other-typed",
            vec![db_question()],
            steps(&[&[
                "down",
                "down",
                "down",
                "enter",
                "paste:Postgres, nhưng dùng PgBouncer",
            ]]),
        ),
        Capture::new("ask-yesno", vec![yes_no_question()], vec![]),
        Capture::new("ask-multi", vec![tools_question()], vec![]),
        Capture::new(
            "ask-multi-one",
            vec![tools_question()],
            steps(&[&["space"]]),
        ),
        Capture::new(
            "ask-multi-two",
            vec![tools_question()],
            steps(&[&["space", "down", "down", "space"]]),
        ),
        Capture::new(
            "ask-multi-review",
            vec![tools_question()],
            steps(&[&["space", "down", "down", "space", "tab"]]),
        ),
        Capture::form("ask-form-q1", vec![]),
        Capture::form("ask-form-q2", steps(&[&["down", "enter"]])),
        Capture::form("ask-form-q2-toggled", steps(&[FORM_TO_Q2_TOGGLED])),
        Capture::form("ask-form-q3", steps(&[FORM_TO_Q2_TOGGLED, &["enter"]])),
        Capture::form(
            "ask-form-review",
            steps(&[FORM_TO_Q2_TOGGLED, FORM_TO_NAME]),
        ),
        Capture::form(
            "ask-form-q3-custom",
            steps(&[FORM_TO_Q2_TOGGLED, FORM_TO_NAME, &["shift+tab"]]),
        ),
        Capture::form(
            "ask-form-editor-prefilled",
            steps(&[FORM_TO_Q2_TOGGLED, FORM_TO_NAME, &["shift+tab", "enter"]]),
        ),
        Capture::form(
            "ask-form-q1-answered",
            steps(&[
                FORM_TO_Q2_TOGGLED,
                FORM_TO_NAME,
                &["shift+tab", "enter", "esc", "shift+tab", "shift+tab"],
            ]),
        ),
        Capture {
            cols: 58,
            ..Capture::new("ask-long-narrow", vec![narrow_list()], vec![])
        },
        Capture {
            cols: 58,
            ..Capture::new(
                "ask-long-narrow-expanded",
                vec![narrow_list()],
                steps(&[&["ctrl+o"]]),
            )
        },
        Capture::release("ask-long-scroll", vec![]),
        Capture::release("ask-long-scroll-down", repeat("down", 7)),
        Capture::release("ask-long-scroll-bottom", repeat("down", 27)),
        Capture::release(
            "ask-long-flags",
            [repeat("down", 27), vec!["tab".to_owned()]].concat(),
        ),
        Capture::release(
            "ask-long-review-unanswered",
            [repeat("down", 27), vec!["tab".to_owned(), "tab".to_owned()]].concat(),
        ),
        // The phone's driver on a real omp: scrambled by hand, then the key plan.
        Capture::release(
            "ask-long-review-custom",
            steps(&[
                &["down", "down", "down", "enter", "space", "tab", "tab"],
                &["down"; 7],
                &[
                    "enter", "space", "down", "space", "down", "space", "down", "enter",
                ],
                &["paste:tag: v2 — bản thử", "enter"],
            ]),
        ),
    ]
}

/// A small deterministic generator (xorshift): the tests that scramble a dialog must scramble it the same
/// way on every run.
pub(super) struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// A number in `0..n`.
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() >> 11) as usize % n
    }

    pub fn flip(&mut self) -> bool {
        self.below(2) == 1
    }
}

/// `screen` as a terminal sends it: colours around the box bars and the cursor, a carriage return before
/// each line break.
pub(super) fn with_ansi(screen: &str) -> String {
    screen
        .lines()
        .map(|l| {
            let coloured = l
                .replace('│', "\x1b[0m\x1b[38;2;42;48;56m│\x1b[0m")
                .replace('❯', "\x1b[1m\x1b[38;2;0;180;255m❯\x1b[0m");
            format!("\x1b[0m{coloured}\x1b[0m")
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

/// A box row: `text` between the bars, padded to `width` cells.
fn boxed(text: &str, width: usize) -> String {
    let pad = width.saturating_sub(text.chars().count());
    format!("│ {text}{} │", " ".repeat(pad))
}

fn rule(open: char, close: char, width: usize) -> String {
    format!("{open}{}{close}", "─".repeat(width + 2))
}

/// The rows of a finished tool call above a dialog: an earlier titled box must not be read as the dialog.
fn transcript() -> Vec<String> {
    vec![
        String::new(),
        "╭─── Write: hello.txt ───────────────────────────────╮".to_owned(),
        "│   1 hello                                          │".to_owned(),
        "╰────────────────────────────────────────────────────╯".to_owned(),
        String::new(),
    ]
}

/// omp's tool approval for `tool`: `detail` rows above the options, the cursor on option `cursor`.
pub(super) fn approval_screen(tool: &str, detail: &[&str], cursor: usize) -> String {
    let width = 70;
    let title = format!("╭─ Allow tool: {tool} ");
    let mut rows = transcript();
    rows.push(format!(
        "{title}{}╮",
        "─".repeat(width + 3 - title.chars().count())
    ));
    rows.push(boxed("", width));
    rows.extend(detail.iter().map(|d| boxed(d, width)));
    rows.push(boxed("", width));
    for (i, label) in ["Approve", "Deny"].iter().enumerate() {
        rows.push(boxed(
            &format!(" {} {label}", if i == cursor { '❯' } else { ' ' }),
            width,
        ));
    }
    rows.push(boxed("", width));
    rows.push(boxed("↑/↓ navigate  ⏎ select  ⎋ cancel", width));
    rows.push(boxed("", width));
    rows.push(rule('╰', '╯', width));
    rows.join("\n")
}

/// omp's plan review: the plan box, then the options with the cursor on `cursor`. `slider` draws the model
/// slider omp shows with two or more role models above the options; `usage` is what the keep-context row
/// prints; `hint` is the key hint under the options.
pub(super) fn plan_review_screen(cursor: usize, usage: &str, slider: bool, hint: &str) -> String {
    let width = 70;
    let mut rows = transcript();
    let title = "╭─ Plan Review ";
    rows.push(format!(
        "{title}{}╮",
        "─".repeat(width + 3 - title.chars().count())
    ));
    rows.push(boxed("▎Context       │  Add a hello function", width - 1));
    rows.push(boxed(" Approach      │", width - 1));
    for _ in 0..3 {
        rows.push(boxed("              │", width - 1));
    }
    rows.push(rule('├', '┤', width));
    rows.push(boxed("Plan mode - next step", width));
    if slider {
        rows.push(boxed("continue with  ◂  smol  ◀ default ▶  slow  ▸", width));
        rows.push(boxed("  ↳ example-model", width));
    }
    let labels = [
        "Approve and execute".to_owned(),
        "Approve and compact context".to_owned(),
        format!("Approve and keep context {usage}"),
        "Refine plan".to_owned(),
        "Save and quit".to_owned(),
    ];
    for (i, label) in labels.iter().enumerate() {
        rows.push(boxed(
            &format!("{} {label}", if i == cursor { '❯' } else { ' ' }),
            width,
        ));
    }
    rows.push(rule('├', '┤', width));
    rows.push(boxed(hint, width));
    rows.push(rule('╰', '╯', width));
    rows.join("\n")
}

/// The hint omp draws under the plan review's options while they have the focus.
pub(super) const PLAN_HINT: &str =
    "↑/↓ select · ⏎ confirm · c copy · ⇥ regions · Ctrl+G editor · ⎋ cancel";

/// A session picker: a titled box with cursor rows, none of omp's question tool or menus.
pub(super) fn resume_picker_screen() -> String {
    let width = 70;
    let title = "╭─ Resume session ";
    let mut rows = vec![format!(
        "{title}{}╮",
        "─".repeat(width + 3 - title.chars().count())
    )];
    rows.push(boxed("❯ Fix the login form", width));
    rows.push(boxed("  Add a hello function", width));
    rows.push(boxed("↑/↓ navigate  ⏎ select  ⎋ cancel", width));
    rows.push(rule('╰', '╯', width));
    rows.join("\n")
}
