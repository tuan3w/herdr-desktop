//! omp's cursor menus: the tool approval (`Allow tool: bash`) and the plan review (`Plan mode - next step`).
//!
//! Choosing an option is moving the cursor there and `enter`. The move is computed from where the cursor IS
//! on screen, so it works whatever the person did with the keys before.

use std::sync::LazyLock;

use regex::Regex;

use super::omp::{cell, last_titled_box, screen_lines};
use super::repeat;
use super::text::{rx, trim, trim_end, trim_start};
use crate::prompt::{PromptInfo, QuickReply, prompt_digest};

/// One row of a menu with a cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpMenuOption {
    /// What the row says.
    pub label: String,
    /// The cursor is on this row.
    pub cursor: bool,
}

/// A cursor menu (tool approval, plan review).
pub trait OmpMenuScreen {
    /// The options in the order drawn.
    fn options(&self) -> &[OmpMenuOption];

    /// Index of the option the cursor is on.
    fn cursor_index(&self) -> Option<usize> {
        self.options().iter().position(|o| o.cursor)
    }

    /// Keys that choose option `index` from the current cursor; `None` when the cursor cannot be found or
    /// the keys cannot be told for sure.
    fn keys_for(&self, index: usize) -> Option<Vec<String>> {
        let c = self.cursor_index()?;
        if index >= self.options().len() {
            return None;
        }
        let mut keys = repeat(if index > c { "down" } else { "up" }, index.abs_diff(c));
        keys.push("enter".to_owned());
        Some(keys)
    }

    /// Keys for the option labelled `label` (case-insensitive prefix).
    fn keys_for_label(&self, label: &str) -> Option<Vec<String>> {
        let want = label.to_lowercase();
        let i = self
            .options()
            .iter()
            .position(|o| o.label.to_lowercase().starts_with(&want))?;
        self.keys_for(i)
    }
}

/// omp's tool approval (`Allow tool: bash`): `Approve` / `Deny`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpApprovalScreen {
    /// The tool name from the title.
    pub tool: String,
    /// The rows above the options as drawn: `Reason: …`, `Command: …`, `Path: …`.
    pub detail: Vec<String>,
    /// `Approve` and `Deny`, in order drawn.
    pub options: Vec<OmpMenuOption>,
}

impl OmpApprovalScreen {
    /// `esc` also denies.
    pub const CANCEL: [&'static str; 1] = ["esc"];

    /// The keys that approve.
    pub fn approve(&self) -> Option<Vec<String>> {
        self.keys_for_label("Approve")
    }

    /// The keys that deny.
    pub fn deny(&self) -> Option<Vec<String>> {
        self.keys_for_label("Deny")
    }
}

impl OmpMenuScreen for OmpApprovalScreen {
    fn options(&self) -> &[OmpMenuOption] {
        &self.options
    }
}

/// omp's plan review ("Plan mode - next step"): Approve and execute / compact context / keep context,
/// Refine plan, Save and quit. Keys only act on the options while the focus is on them (the default; `tab`
/// moves it to the Contents or the plan text, where `down` scrolls and `enter` only moves the focus back),
/// which [`focus_on_options`](Self::focus_on_options) says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpPlanReviewScreen {
    /// The options in the order drawn.
    pub options: Vec<OmpMenuOption>,
    /// False while the Contents, the plan text or a note being typed has the focus: nothing sent would
    /// choose an option.
    pub focus_on_options: bool,
}

impl OmpPlanReviewScreen {
    /// The keys that approve and execute.
    pub fn approve(&self) -> Option<Vec<String>> {
        self.keys_for_label("Approve and execute")
    }
}

const KEEP_CONTEXT: &str = "Approve and keep";

/// Whether omp draws the keep-context row disabled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keep {
    Enabled,
    Disabled,
    Unknown,
}

impl OmpMenuScreen for OmpPlanReviewScreen {
    fn options(&self) -> &[OmpMenuOption] {
        &self.options
    }

    /// omp draws "keep context" disabled once the context is over 95% full, and its cursor then skips the
    /// row: counting `down` over it overshoots (from the top, 3 downs reach "Save and quit" instead of
    /// "Refine plan", which quits omp). Nothing on a plain-text screen says the row is disabled, so it is
    /// worked out from the usage the label prints. Near the 95% line the printed rounding cannot tell: a
    /// choice whose keys differ either way is not offered.
    fn keys_for(&self, index: usize) -> Option<Vec<String>> {
        let c = self.cursor_index();
        let c = match c {
            Some(c) if self.focus_on_options && index < self.options.len() => c,
            _ => return None,
        };
        let keep = self
            .options
            .iter()
            .position(|o| o.label.starts_with(KEEP_CONTEXT));
        let state = match keep {
            Some(k) if k != c => keep_state(&self.options[k].label),
            _ => Keep::Enabled,
        };
        let walk = |disabled: Option<usize>| -> Option<Vec<String>> {
            if Some(index) == disabled {
                return None;
            }
            // The cursor skips the disabled row: it costs no key to step onto it.
            let (down, mut at, mut n) = (index > c, c, 0);
            while at != index {
                let next = if down { at + 1 } else { at - 1 };
                if Some(next) != disabled {
                    n += 1;
                }
                at = next;
            }
            let mut keys = repeat(if down { "down" } else { "up" }, n);
            keys.push("enter".to_owned());
            Some(keys)
        };
        let on = walk(None);
        let off = walk(keep);
        match state {
            Keep::Enabled => on,
            Keep::Disabled => off,
            Keep::Unknown => match (on, off) {
                (Some(on), Some(off)) if on == off => Some(on),
                _ => None,
            },
        }
    }
}

/// What the keep-context row's `(~used / window)` says about it being over omp's 95% line. Each figure is
/// printed rounded (one decimal below 10 units, whole above), so it is a range.
fn keep_state(label: &str) -> Keep {
    static USAGE: LazyLock<Regex> =
        LazyLock::new(|| rx(r"\(~([0-9]+(?:\.[0-9]+)?)([kmb]?) / ([0-9]+(?:\.[0-9]+)?)([kmb]?)\)"));
    let Some(m) = USAGE.captures(label) else {
        // `Approve and keep context` alone is what omp prints without a usage. Any other text is a label a
        // narrow pane cut (`… (~199k / 2…`): it may be over the line, and counting `down` over a disabled
        // row quits omp.
        return if trim(label) == "Approve and keep context" {
            Keep::Enabled
        } else {
            Keep::Unknown
        };
    };
    let range = |number: &str, suffix: &str| -> (f64, f64) {
        let unit = match suffix {
            "k" => 1e3,
            "m" => 1e6,
            "b" => 1e9,
            _ => 1.0,
        };
        let v: f64 = number.parse().unwrap_or(0.0);
        let half = if suffix.is_empty() || v >= 10.0 {
            0.5
        } else {
            0.05
        };
        ((v - half) * unit, (v + half) * unit)
    };
    let (used_low, used_high) = range(&m[1], &m[2]);
    let (window_low, window_high) = range(&m[3], &m[4]);
    if window_low <= 0.0 {
        return Keep::Unknown;
    }
    if used_low / window_high * 100.0 > 95.0 {
        return Keep::Disabled;
    }
    if used_high / window_low * 100.0 <= 95.0 {
        return Keep::Enabled;
    }
    Keep::Unknown
}

/// A menu row: `❯ label` or `  label`. The first group is the cursor slot, the second the label.
fn menu_row(s: &str) -> Option<(String, String)> {
    static ROW: LazyLock<Regex> = LazyLock::new(|| rx(r"^\s?([❯>\x{f054}]|\s) (\S.*)$"));
    let m = ROW.captures(s)?;
    Some((m[1].to_owned(), m[2].to_owned()))
}

/// Reads a tool approval dialog; `None` when none is on `screen`.
pub fn parse_omp_approval(screen: &str) -> Option<OmpApprovalScreen> {
    static TITLE: LazyLock<Regex> = LazyLock::new(|| rx(r"^Allow tool: (.+)$"));
    let lines = screen_lines(screen);
    let (top, title) = last_titled_box(&lines)?;
    let tool = TITLE.captures(&title)?[1].to_owned();
    let mut cells: Vec<String> = Vec::new();
    for line in &lines[top + 1..] {
        if trim_start(line).starts_with('╰') {
            break;
        }
        if let Some(c) = cell(line) {
            cells.push(c);
        }
    }
    while cells.last().is_some_and(|c| trim(c).is_empty()) {
        cells.pop();
    }
    cells.pop()?; // the key hint
    while cells.last().is_some_and(|c| trim(c).is_empty()) {
        cells.pop();
    }
    // The options are the last block of rows.
    let mut start = cells.len();
    while start > 0 && !trim(&cells[start - 1]).is_empty() {
        start -= 1;
    }
    let mut options = Vec::new();
    for c in &cells[start..] {
        let (slot, label) = menu_row(c)?;
        options.push(OmpMenuOption {
            label: trim(&label).to_owned(),
            cursor: slot != " ",
        });
    }
    if options.is_empty() {
        return None;
    }
    let detail = cells[..start]
        .iter()
        .filter(|c| !trim(c).is_empty())
        .map(|c| trim_end(c).to_owned())
        .collect();
    Some(OmpApprovalScreen {
        tool: trim(&tool).to_owned(),
        detail,
        options,
    })
}

/// Reads the plan review options; `None` when it is not on `screen`.
///
/// With two or more role models omp draws a model slider between the prompt and the options (`continue with
/// ◂ smol ▶ default ▸ slow`, then `↳ model name`); those rows are not options.
pub fn parse_omp_plan_review(screen: &str) -> Option<OmpPlanReviewScreen> {
    static LABEL_START: LazyLock<Regex> = LazyLock::new(|| rx(r"^[A-Za-z0-9]"));
    let lines = screen_lines(screen);
    let at = lines
        .iter()
        .rposition(|l| cell(l).is_some_and(|c| trim(&c) == "Plan mode - next step"))?;
    let mut options: Vec<OmpMenuOption> = Vec::new();
    let mut i = at + 1;
    while i < lines.len() {
        let t = trim_start(&lines[i]);
        if t.starts_with('├') || t.starts_with('╰') {
            break;
        }
        let c = match cell(&lines[i]) {
            Some(c) if !trim(&c).is_empty() => c,
            _ => {
                i += 1;
                continue;
            }
        };
        let row = menu_row(&format!(" {c}"));
        let label = row.as_ref().map(|(_, l)| trim(l));
        if options.is_empty() && label.is_none_or(|l| !LABEL_START.is_match(l)) {
            i += 1;
            continue; // the slider
        }
        let (slot, label) = row?;
        options.push(OmpMenuOption {
            label: trim(&label).to_owned(),
            cursor: slot != " ",
        });
        i += 1;
    }
    if options.is_empty() {
        return None;
    }
    // The hint row under the options names what the keys do now: only with the focus on the options does it
    // say `confirm` (`open`, `scroll`, `save` elsewhere).
    let mut hint: Option<String> = None;
    i += 1;
    while i < lines.len() {
        if trim_start(&lines[i]).starts_with('╰') {
            break;
        }
        if let Some(c) = cell(&lines[i])
            && !trim(&c).is_empty()
        {
            hint = Some(c);
        }
        i += 1;
    }
    Some(OmpPlanReviewScreen {
        options,
        focus_on_options: hint.is_none_or(|h| h.contains("confirm")),
    })
}

/// Whether omp's screen shows the plan review. herdr does not call that pane blocked, so the app reads the
/// screen to know.
pub fn omp_waits_on_plan_review(screen: &str) -> bool {
    parse_omp_plan_review(screen).is_some()
}

/// omp's tool approval or plan review as a prompt: each option with the keys that choose it from where the
/// cursor is. An option no keys reach for sure (a disabled one, or the focus is off the options) is left
/// out; with none left the screen is not a prompt the app can answer.
///
/// Like herdr-mobile's, the subject is every row the approval draws above its options, uncut.
pub fn omp_menu_prompt(screen: &str) -> Option<PromptInfo> {
    let approval = parse_omp_approval(screen);
    let plan = if approval.is_none() {
        Some(parse_omp_plan_review(screen)?)
    } else {
        None
    };
    let menu: &dyn OmpMenuScreen = match (&approval, &plan) {
        (Some(a), _) => a,
        (None, Some(p)) => p,
        (None, None) => return None,
    };
    let options: Vec<QuickReply> = menu
        .options()
        .iter()
        .enumerate()
        .filter_map(|(i, o)| {
            menu.keys_for(i).map(|keys| QuickReply {
                label: o.label.clone(),
                keys,
                risk: None,
                standing_grant: false,
            })
        })
        .collect();
    if options.is_empty() {
        return None;
    }
    let (question, subject) = match &approval {
        Some(a) => (
            format!("Allow tool: {}", a.tool),
            Some(approval_subject(&a.detail)).filter(|s| !s.is_empty()),
        ),
        None => ("Plan mode - next step".to_owned(), None),
    };
    let mut prompt = PromptInfo {
        question,
        subject,
        options,
        digest: String::new(),
    };
    prompt.digest = prompt_digest(&prompt);
    Some(prompt)
}

/// The rows above an approval's options, without their `Command:`-style labels when it names a command.
fn approval_subject(detail: &[String]) -> String {
    static NAMED: LazyLock<Regex> =
        LazyLock::new(|| rx(r"^\s*(?:Command|Path|File|Url|URL):\s*(.+)$"));
    for line in detail {
        if let Some(m) = NAMED.captures(line) {
            return trim(&m[1]).to_owned();
        }
    }
    detail
        .iter()
        .map(|l| trim(l))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
