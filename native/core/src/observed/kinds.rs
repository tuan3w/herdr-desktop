//! The kinds of agent whose panes open as a chat: how to find a kind's log, how to read it and what it can do
//! from here. Registered by herdr's agent label.

use std::sync::LazyLock;

use super::ask::{ClaudeAsk, OmpAsk};
use super::locate::{ClaudeLocator, CodexLocator, OmpLocator};
use super::model::{AskDriver, Locator, LogMapper};
use super::{claude, codex, omp};

/// One kind of agent whose panes open as a chat.
pub struct ObservedKind {
    /// herdr's agent label: `omp`, `claude` or `codex`.
    pub id: &'static str,
    /// What the person reads: `omp`, `Claude Code`, `Codex`.
    pub label: &'static str,
    /// A fresh mapper for one session's log.
    pub new_mapper: fn() -> Box<dyn LogMapper>,
    /// Where the log of a pane of this kind is.
    pub locator: &'static dyn Locator,
    /// How its question tool is answered by keys; `None`: its questions are answered in the terminal.
    pub ask: Option<&'static dyn AskDriver>,
    /// A background job that finishes starts a turn of the agent by itself (omp, Claude Code). Codex does not:
    /// it sees a finished command when it next looks.
    pub wakes_on_background: bool,
    /// The herdr integration target that makes the agent report its session
    /// (`herdr integration install <target>`).
    pub integration: Option<&'static str>,
}

static OMP_LOCATOR: OmpLocator = OmpLocator;
static CLAUDE_LOCATOR: LazyLock<ClaudeLocator> = LazyLock::new(ClaudeLocator::new);
static CODEX_LOCATOR: LazyLock<CodexLocator> = LazyLock::new(CodexLocator::new);
static OMP_ASK: OmpAsk = OmpAsk;
static CLAUDE_ASK: ClaudeAsk = ClaudeAsk;

/// omp: it tells herdr the path of its log, its question tool and its menus are driven by keys, and its
/// subagents write `<log minus .jsonl>/<name>.jsonl`.
static OMP: LazyLock<ObservedKind> = LazyLock::new(|| ObservedKind {
    id: "omp",
    label: "omp",
    new_mapper: omp::new_mapper,
    locator: &OMP_LOCATOR,
    ask: Some(&OMP_ASK),
    wakes_on_background: true,
    integration: None,
});

/// Claude Code: herdr's hook reports the session once its integration is installed; without it the running
/// process names it (`~/.claude/sessions/<pid>.json`). Its question tool is answered by keys and checked
/// against the tool result in the log.
static CLAUDE: LazyLock<ObservedKind> = LazyLock::new(|| ObservedKind {
    id: "claude",
    label: "Claude Code",
    new_mapper: claude::new_mapper,
    locator: &*CLAUDE_LOCATOR,
    ask: Some(&CLAUDE_ASK),
    wakes_on_background: true,
    integration: Some("claude"),
});

/// Codex: herdr reports the thread id (not the path) once its integration is installed; the thread's file is
/// found by that id. Its questions are answered in the terminal.
static CODEX: LazyLock<ObservedKind> = LazyLock::new(|| ObservedKind {
    id: "codex",
    label: "Codex",
    new_mapper: codex::new_mapper,
    locator: &*CODEX_LOCATOR,
    ask: None,
    wakes_on_background: false,
    integration: Some("codex"),
});

/// The kind whose herdr agent label is `label`, if its panes can open as a chat.
pub fn kind_for(label: &str) -> Option<&'static ObservedKind> {
    match label {
        "omp" => Some(&OMP),
        "claude" => Some(&CLAUDE),
        "codex" => Some(&CODEX),
        _ => None,
    }
}
