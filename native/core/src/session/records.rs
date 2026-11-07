//! What the keeper commands print: the agents a machine can run, the keepers it holds, the sessions an agent remembers.

use serde::Deserialize;
use serde_json::Value;

/// An agent the keeper can start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    /// Stable, lower case (`omp`, `claude`, `codex`, `pi`).
    pub id: String,
    /// What the person reads (`Claude Code`).
    pub label: String,
}

/// Where a keeper is in its life.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeeperState {
    /// Its agent has not answered `initialize` yet.
    Starting,
    /// Running.
    #[default]
    Running,
    /// Its agent has exited.
    Exited,
}

/// One keeper: a process that owns one agent so the agent outlives whoever started it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct KeeperInfo {
    /// The keeper's id (`[a-z0-9]`, six characters); names the session.
    pub id: String,
    /// The agent's route id.
    #[serde(default)]
    pub agent: String,
    /// The folder it runs in.
    #[serde(default)]
    pub cwd: String,
    /// Where it is in its life.
    #[serde(default)]
    pub state: KeeperState,
    /// When it started (Unix milliseconds).
    #[serde(default)]
    pub started_at: Option<i64>,
    /// Requests of the agent waiting for an answer.
    #[serde(default)]
    pub pending: u32,
    /// The agent is working on a turn.
    #[serde(default)]
    pub turn_active: bool,
    /// A turn ended that no phone has seen. (A terminal or this app, as viewers, never clear it.)
    #[serde(default)]
    pub unseen_done: bool,
    /// Clients attached now.
    #[serde(default)]
    pub clients: u32,
    /// The agent's session id once it has one.
    #[serde(default)]
    pub session_id: Option<String>,
    /// The agent's title for the session.
    #[serde(default)]
    pub title: Option<String>,
    /// When the agent last said anything (Unix milliseconds).
    #[serde(default)]
    pub last_event_at: Option<i64>,
    /// Why the agent exited, once it has.
    #[serde(default)]
    pub exit_reason: Option<String>,
}

impl KeeperInfo {
    /// Whether the agent is still there.
    pub fn alive(&self) -> bool {
        self.state != KeeperState::Exited
    }
}

/// A session an agent kept in its own store, whether or not a keeper holds it now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastSession {
    /// The agent's id for it; `continue` needs it.
    pub session_id: String,
    /// The folder it ran in.
    pub cwd: String,
    /// The agent's title for it.
    pub title: Option<String>,
    /// When it last changed, as the agent says (ISO 8601).
    pub updated_at: Option<String>,
    /// Messages in it, where the agent reports it.
    pub message_count: Option<u32>,
}

/// What one agent remembers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastSessions {
    /// The agent's route id.
    pub agent: String,
    /// Newest first.
    pub sessions: Vec<PastSession>,
    /// The agent can list its sessions at all; false means `sessions` is empty because it cannot say.
    pub can_list: bool,
    /// The agent can replay a session into a new process.
    pub can_load: bool,
    /// The agent can reopen a session without replaying it.
    pub can_resume: bool,
    /// There are more than were returned.
    pub more: bool,
}

impl PastSessions {
    /// Reads the one JSON line `history` prints.
    pub(crate) fn from_value(v: &Value) -> Option<PastSessions> {
        let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
        let sessions = v
            .get("sessions")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|s| {
                        let session_id = s.get("sessionId")?.as_str().filter(|i| !i.is_empty())?;
                        let cwd = s.get("cwd")?.as_str()?;
                        Some(PastSession {
                            session_id: session_id.to_owned(),
                            cwd: cwd.to_owned(),
                            title: s
                                .get("title")
                                .and_then(Value::as_str)
                                .map(str::trim)
                                .filter(|t| !t.is_empty())
                                .map(str::to_owned),
                            updated_at: s
                                .get("updatedAt")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            message_count: s
                                .pointer("/_meta/messageCount")
                                .and_then(Value::as_u64)
                                .and_then(|n| u32::try_from(n).ok()),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(PastSessions {
            agent: v.get("agent")?.as_str()?.to_owned(),
            sessions,
            can_list: flag("list"),
            can_load: flag("load"),
            can_resume: flag("resume"),
            more: flag("more"),
        })
    }
}
