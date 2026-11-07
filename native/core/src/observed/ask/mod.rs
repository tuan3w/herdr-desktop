//! Answering an agent's question tool, and omp's menus, by keys.
//!
//! A port of herdr-mobile's `omp_ask_driver.dart` and `claude_ask_driver.dart`, of the ask and menu parts of
//! `omp_kind.dart`, and of `askResultMatches` (omp) and `claudeAskResultMatches`. The dialogs are drawn in
//! the pane, so the pane's screen is the truth: a driver reads one screen and gives the ONE next thing to
//! send; the caller sends it, reads the pane again and asks again until [`AskStep::Done`]. Nothing is
//! assumed about where a cursor, a tab or a checkbox was, so a key that did not land only costs another
//! round, and anything the driver cannot be sure of is an [`AskStep::Mismatch`] instead of a guess. Two
//! counters stop an endless loop (too many steps, a dialog that does not react to the keys).
//!
//! - [`OmpAsk`]: omp's `ask` tool, a modal box with a tab strip, radios, checkboxes and a custom-answer
//!   editor ([`parse_ask_screen`]), plus its tool approval and plan review menus ([`omp_menu_prompt`]).
//! - [`ClaudeAsk`]: Claude Code's `AskUserQuestion` ([`parse_claude_ask`]).

mod claude;
mod omp;
mod omp_menu;
mod omp_result;
mod text;

#[cfg(test)]
mod claude_goldens;
#[cfg(test)]
mod claude_tests;
#[cfg(test)]
mod fake_claude;
#[cfg(test)]
mod fake_omp;
#[cfg(test)]
mod omp_fixtures;
#[cfg(test)]
mod omp_goldens;
#[cfg(test)]
mod omp_menu_tests;
#[cfg(test)]
mod omp_plan_tests;
#[cfg(test)]
mod omp_screen_tests;

pub use claude::{
    ClaudeAsk, ClaudeAskDriver, ClaudeAskKind, ClaudeAskRow, ClaudeAskScreen, ClaudeAskTab,
    claude_ask_result_matches, expected_answer, looks_like_claude_ask, parse_claude_ask,
};
pub use omp::{
    AskReviewLine, AskScreenKind, AskScreenRow, AskScreenState, OmpAsk, OmpAskDriver,
    looks_like_ask, next_ask_step, parse_ask_screen,
};
pub use omp_menu::{
    OmpApprovalScreen, OmpMenuOption, OmpMenuScreen, OmpPlanReviewScreen, omp_menu_prompt,
    omp_waits_on_plan_review, parse_omp_approval, parse_omp_plan_review,
};
pub use omp_result::ask_result_matches;

use super::model::AskStep;

/// A step that sends `keys` and nothing else.
fn keys(keys: &[&str], why: &str) -> AskStep {
    AskStep::Send {
        keys: keys.iter().map(|k| (*k).to_owned()).collect(),
        text: None,
        submits: false,
        why: why.to_owned(),
    }
}

/// A step that sends `keys` (an owned list) and says whether they end the dialog.
fn send(keys: Vec<String>, submits: bool, why: String) -> AskStep {
    AskStep::Send {
        keys,
        text: None,
        submits,
        why,
    }
}

/// A step that types `text` first, no key.
fn typing(text: &str, why: &str) -> AskStep {
    AskStep::Send {
        keys: Vec::new(),
        text: Some(text.to_owned()),
        submits: false,
        why: why.to_owned(),
    }
}

/// `n` times `key`.
fn repeat(key: &str, n: usize) -> Vec<String> {
    vec![key.to_owned(); n]
}

/// The keys that move a cursor from row `from` to row `to`, one `up` or `down` each.
fn moves(from: usize, to: usize) -> Vec<String> {
    repeat(if to > from { "down" } else { "up" }, from.abs_diff(to))
}

/// What both drivers remember between screens: how many steps they have sent, and whether the last
/// screen they sent keys for looks the same as this one (a dialog that ignored the keys).
#[derive(Debug)]
struct Guard {
    max_steps: usize,
    steps: usize,
    repeats: usize,
    last_print: Option<String>,
    last_was_send: bool,
}

impl Guard {
    fn new(max_steps: usize) -> Self {
        Self {
            max_steps,
            steps: 0,
            repeats: 0,
            last_print: None,
            last_was_send: false,
        }
    }

    /// `step` as planned for a screen with this `print`, or the mismatch that stops the loop. Only a
    /// step that sends something counts.
    fn check(&mut self, step: AskStep, print: &str) -> AskStep {
        if !matches!(step, AskStep::Send { .. }) {
            self.last_was_send = false;
            return step;
        }
        self.steps += 1;
        if self.steps > self.max_steps {
            return AskStep::Mismatch("too many steps".to_owned());
        }
        self.repeats = if self.last_was_send && self.last_print.as_deref() == Some(print) {
            self.repeats + 1
        } else {
            0
        };
        if self.repeats >= 2 {
            return AskStep::Mismatch("the dialog did not react to the keys".to_owned());
        }
        self.last_print = Some(print.to_owned());
        self.last_was_send = true;
        step
    }
}
