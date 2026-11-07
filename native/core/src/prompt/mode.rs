//! How much a session mode lowers the guard between the agent and the host.

use std::sync::LazyLock;

use regex::Regex;

use super::re::rx;
use super::text::{ellipsize, plain_line, ulen};

/// How much a session mode lowers the guard between the agent and the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ModeRisk {
    /// The agent asks as the person expects (default, plan, read-only...).
    None,
    /// Part of the asking is switched off or delegated (accept edits, auto).
    Elevated,
    /// Nothing is asked: the agent runs and writes freely.
    Dangerous,
}

/// A mode's risk and, when there is one, why in plain words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeAssessment {
    /// How far the mode lowers the guard.
    pub risk: ModeRisk,
    /// One sentence for a sheet or a tooltip; `None` for [`ModeRisk::None`].
    pub reason: Option<String>,
}

impl ModeAssessment {
    fn none() -> Self {
        Self {
            risk: ModeRisk::None,
            reason: None,
        }
    }

    fn of(risk: ModeRisk, reason: impl Into<String>) -> Self {
        Self {
            risk,
            reason: Some(reason.into()),
        }
    }

    /// Whether the mode lowers the guard at all.
    pub fn is_risky(&self) -> bool {
        self.risk != ModeRisk::None
    }
}

/// The risk of one mode, from its id and its display name. Both are read and the
/// worse reading wins, so a harmless id with a name that says `Bypass` still
/// shows.
///
/// Order, for each of id and name: the exact table of known modes (compared as
/// lower-case letters and digits only, so `bypassPermissions`,
/// `bypass_permissions` and `Bypass Permissions` are one entry), then words that
/// mark a mode nobody has listed. A name this client does not know and that does
/// not look risky is [`ModeRisk::None`]. Descriptions are not read: Claude's own
/// `default` says it "prompts for dangerous operations".
pub fn assess_mode(id: Option<&str>, name: Option<&str>) -> ModeAssessment {
    let by_id = assess(id);
    let by_name = assess(name);
    if by_name.risk > by_id.risk {
        by_name
    } else {
        by_id
    }
}

fn assess(raw: Option<&str>) -> ModeAssessment {
    let Some(raw) = raw else {
        return ModeAssessment::none();
    };
    let key = compact(raw);
    if key.is_empty() {
        return ModeAssessment::none();
    }
    if let Some(known) = known(&key) {
        return known;
    }
    if DANGER_WORDS.iter().any(|w| key.contains(w)) {
        return ModeAssessment::of(
            ModeRisk::Dangerous,
            format!(
                "The mode \"{}\" looks like it skips permission checks.",
                shown(raw)
            ),
        );
    }
    if ELEVATED_WORDS.iter().any(|w| key.contains(w)) {
        return ModeAssessment::of(ModeRisk::Elevated, unknown_elevated(raw));
    }
    if tokens(raw)
        .iter()
        .any(|t| t == "auto" || t.starts_with("autonom"))
    {
        return ModeAssessment::of(ModeRisk::Elevated, unknown_elevated(raw));
    }
    ModeAssessment::none()
}

fn unknown_elevated(raw: &str) -> String {
    format!("The mode \"{}\" may ask for less than usual.", shown(raw))
}

fn shown(raw: &str) -> String {
    let line = plain_line(raw);
    if ulen(&line) <= 40 {
        line
    } else {
        ellipsize(&line, 40)
    }
}

/// Lower-case letters and digits only (any script's letters stay).
fn compact(s: &str) -> String {
    plain_line(s)
        .to_lowercase()
        .chars()
        .filter(|&c| c.is_ascii_digit() || c.is_ascii_lowercase() || (c as u32) > 0x7F)
        .collect()
}

/// The lower-case words of `raw`; camelCase boundaries count (`autoAccept` is
/// `auto`, `accept`).
fn tokens(raw: &str) -> Vec<String> {
    static CAMEL: LazyLock<Regex> = LazyLock::new(|| rx(r"([a-z0-9])([A-Z])"));
    static SPLIT: LazyLock<Regex> = LazyLock::new(|| rx(r"[^\p{L}\p{N}]+"));
    let spaced = CAMEL.replace_all(raw, "$1 $2");
    SPLIT
        .split(&plain_line(&spaced).to_lowercase())
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Words (compacted) that make an unlisted mode dangerous.
const DANGER_WORDS: [&str; 8] = [
    "bypass",
    "yolo",
    "fullaccess",
    "dangerously",
    "dangerfull",
    "skippermission",
    "skipapproval",
    "nosandbox",
];

/// Words (compacted) that make an unlisted mode elevated. A mode that looks like
/// it asks for less is shown: a wrong "elevated" costs a tint, a missed one costs
/// the person's trust.
const ELEVATED_WORDS: [&str; 11] = [
    "acceptedits",
    "autoaccept",
    "autoapprove",
    "autoedit",
    "acceptall",
    "dontask",
    "neverask",
    "noprompt",
    "noapproval",
    "unrestricted",
    "unsafe",
];

/// Modes the four routes are known to send (Claude Code, Codex, omp, pi), by
/// compacted id or name.
///
/// - Claude Code: `default`, `plan` ("Plan Mode"), `dontAsk` (denies what is not
///   pre-approved, so it asks for nothing and runs nothing new: none),
///   `acceptEdits` and `auto` (elevated), `bypassPermissions` (dangerous).
/// - Codex: `read-only`, `workspace-write` ("Workspace access", codex's own
///   default preset: ask before leaving the workspace: none), `agent` ("Auto
///   review": elevated), `agent-full-access` ("Full access": dangerous);
///   `danger-full-access` is the sandbox name of the same thing.
/// - omp: `default`, `plan`. pi: none (its modes are thinking levels).
fn known(key: &str) -> Option<ModeAssessment> {
    const BYPASS: &str = "Every tool call runs without asking you.";
    const FULL_ACCESS: &str = "Full access: the agent can change any file on the machine and use the network without asking.";
    const ACCEPT_EDITS: &str = "File edits are accepted without asking you.";
    const AUTO: &str = "A classifier, not you, approves or denies the permission prompts.";
    const CODEX_AGENT: &str = "It asks only for actions it judges unsafe.";
    Some(match key {
        "bypasspermissions" => ModeAssessment::of(ModeRisk::Dangerous, BYPASS),
        "agentfullaccess" | "fullaccess" | "dangerfullaccess" => {
            ModeAssessment::of(ModeRisk::Dangerous, FULL_ACCESS)
        }
        "acceptedits" => ModeAssessment::of(ModeRisk::Elevated, ACCEPT_EDITS),
        "auto" => ModeAssessment::of(ModeRisk::Elevated, AUTO),
        "agent" | "autoreview" => ModeAssessment::of(ModeRisk::Elevated, CODEX_AGENT),
        "default" | "plan" | "planmode" | "dontask" | "readonly" | "workspacewrite"
        | "workspaceaccess" => ModeAssessment::none(),
        _ => return None,
    })
}
