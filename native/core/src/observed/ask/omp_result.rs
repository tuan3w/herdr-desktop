//! Whether the result omp's question tool recorded says what the person answered.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

use super::text::{rx, trim};
use crate::observed::model::{AskAnswer, PendingAsk};

/// Whether the question tool's result text (`output`, verbatim from the log) says `answers` were recorded.
/// One question: `User selected: a, b` and/or `User provided custom input: text`. Several: `User answers:`
/// then one `id: label`, `id: [a, b]` or `id: "custom"` line per question (an own answer wins over the
/// options). Options are compared by label.
pub fn ask_result_matches(output: Option<&str>, ask: &PendingAsk, answers: &[AskAnswer]) -> bool {
    static COMMA: LazyLock<Regex> = LazyLock::new(|| rx(r"\s*,\s*"));
    let Some(output) = output else {
        return false;
    };
    if answers.len() != ask.questions.len() || answers.is_empty() {
        return false;
    }
    let lines: Vec<&str> = output.split('\n').collect();
    let labels_of = |i: usize| -> Vec<&str> {
        let options = &ask.questions[i].options;
        answers[i]
            .selected
            .iter()
            .filter(|&&j| j < options.len())
            .map(|&j| options[j].label.as_str())
            .collect()
    };
    let same_labels = |text: &str, want: &[&str]| -> bool {
        let got: Vec<String> = COMMA
            .split(&strip_notes(text))
            .map(|p| trim(p).to_owned())
            .filter(|p| !p.is_empty())
            .collect();
        let set: BTreeSet<&str> = got.iter().map(String::as_str).collect();
        got.len() == want.len() && want.iter().all(|w| set.contains(w))
    };

    if ask.questions.len() == 1 {
        const SELECTED: &str = "User selected:";
        const CUSTOM: &str = "User provided custom input:";
        let mut picked_text: Option<String> = None;
        let mut custom_text: Option<String> = None;
        for l in &lines {
            if let Some(rest) = l.strip_prefix(SELECTED) {
                picked_text = Some(trim(rest).to_owned());
            }
            if let Some(rest) = l.strip_prefix(CUSTOM) {
                custom_text = Some(strip_notes(trim(rest)));
            }
        }
        let a = &answers[0];
        if let Some(own) = &a.custom {
            return custom_text.as_deref() == Some(own.as_str())
                && picked_text
                    .as_deref()
                    .is_none_or(|p| same_labels(p, &labels_of(0)));
        }
        return custom_text.is_none()
            && picked_text
                .as_deref()
                .is_some_and(|p| same_labels(p, &labels_of(0)));
    }

    for (i, q) in ask.questions.iter().enumerate() {
        let prefix = format!("{}:", q.id);
        let Some(value) = lines
            .iter()
            .find_map(|l| l.strip_prefix(prefix.as_str()))
            .map(|v| strip_notes(trim(v)))
        else {
            return false;
        };
        if let Some(own) = &answers[i].custom {
            if value != format!("\"{own}\"") && value != format!("“{own}”") {
                return false;
            }
            continue;
        }
        let inner = value
            .strip_prefix('[')
            .and_then(|v| v.strip_suffix(']'))
            .unwrap_or(&value);
        if !same_labels(inner, &labels_of(i)) {
            return false;
        }
    }
    true
}

/// `s` without the notes omp appends to a recorded answer (`(auto-selected after timeout)`,
/// `(note: ...)`), however many.
fn strip_notes(s: &str) -> String {
    static NOTE: LazyLock<Regex> =
        LazyLock::new(|| rx(r"\s*\((?:auto-selected after timeout|note:[^)]*)\)\s*$"));
    let mut out = trim(s).to_owned();
    while let Some(m) = NOTE.find(&out) {
        out = trim(&out[..m.start()]).to_owned();
    }
    out
}
