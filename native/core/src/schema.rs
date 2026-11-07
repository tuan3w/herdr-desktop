//! The subset of herdr's public JSON API (protocol 22) that the desktop app reads and writes.
//!
//! Facts come from `docs/herdr-api.schema.json`; `tests/schema.rs` fails when a field the schema
//! marks `required` is missing here. Unknown fields are ignored and unknown enum values degrade
//! (`AgentStatus::Unknown`, `Event::Other`) so a newer herdr never breaks the app.
//!
//! herdr omits null fields, so every optional field is an `Option` or has a default.

use std::collections::BTreeMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

use crate::wire::WireError;

/// The protocol version this crate was written against. A herdr that reports a higher one is
/// still used (a banner, never a failure); see `link::LinkNote::NewerHerdr`.
pub const PROTOCOL: u32 = 22;

/// What an agent is doing, as herdr reports it. `Done` is idle and not yet looked at (herdr's own
/// notion; the app's "reviewed" set turns it into idle for the person).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Working,
    /// Waiting on the person.
    Blocked,
    Done,
    /// Anything herdr says that this app does not know, and panes with no agent.
    #[default]
    #[serde(other)]
    Unknown,
}

/// One request line: `{"id","method","params"}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Request {
    pub id: String,
    pub method: String,
    pub params: Value,
}

impl Request {
    /// A request; `params` is `{}` for methods without parameters (herdr rejects `null`).
    pub fn new(id: impl Into<String>, method: &str, params: Value) -> Self {
        let params = if params.is_null() { json!({}) } else { params };
        Self {
            id: id.into(),
            method: method.to_owned(),
            params,
        }
    }

    /// The bytes to write: one JSON line ending in `\n`.
    pub fn to_line(&self) -> Vec<u8> {
        let mut line = serde_json::to_vec(self).expect("a Request always serialises");
        line.push(b'\n');
        line
    }
}

/// herdr's error answer body.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
pub struct ApiError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

/// One answer line: `{"id","result"}` or `{"id","error":{"code","message"}}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub id: String,
    pub body: Result<Value, ApiError>,
}

impl Response {
    /// Reads one answer line. An object with neither `result` nor `error` is unreadable.
    pub fn parse(line: &[u8]) -> Result<Self, WireError> {
        #[derive(Deserialize)]
        struct Raw {
            #[serde(default)]
            id: Value,
            result: Option<Value>,
            error: Option<ApiError>,
        }
        let raw: Raw = serde_json::from_slice(line).map_err(|e| {
            WireError::retryable(format!("herdr sent an answer this app cannot read: {e}"))
        })?;
        let id = match raw.id {
            Value::String(s) => s,
            Value::Null => String::new(),
            other => other.to_string(),
        };
        let body = match (raw.result, raw.error) {
            (_, Some(error)) => Err(error),
            (Some(result), None) => Ok(result),
            (None, None) => {
                return Err(WireError::retryable(
                    "herdr sent an answer with neither result nor error",
                ));
            }
        };
        Ok(Self { id, body })
    }

    /// The `result`, or the herdr error as `ErrorKind::Api`.
    pub fn into_result(self) -> Result<Value, WireError> {
        self.body.map_err(|e| WireError::api(e.code, e.message))
    }
}

/// One entry of the `events.subscribe` params array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Subscription {
    /// Subscription types use dots (`pane.updated`); the events they produce use underscores.
    #[serde(rename = "type")]
    pub kind: String,
    /// `pane.agent_status_changed`, `pane.scroll_changed` and `pane.output_matched` have no global form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

impl Subscription {
    /// A subscription to every pane/workspace/tab (`kind` such as `pane.updated`).
    pub fn global(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            pane_id: None,
        }
    }

    /// A per-pane subscription.
    pub fn pane(kind: &str, pane_id: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            pane_id: Some(pane_id.to_owned()),
        }
    }

    /// The JSON the `Wire` takes.
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("a Subscription always serialises")
    }
}

/// Where an agent keeps its session (a file path or an id), as herdr detected it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AgentSession {
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub kind: AgentSessionKind,
    #[serde(default)]
    pub value: String,
}

/// Whether [`AgentSession::value`] is a path or an id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionKind {
    Id,
    Path,
    #[default]
    #[serde(other)]
    Unknown,
}

/// How far a pane is scrolled back.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PaneScroll {
    #[serde(default)]
    pub offset_from_bottom: u64,
    #[serde(default)]
    pub max_offset_from_bottom: u64,
    #[serde(default)]
    pub viewport_rows: u64,
}

/// A herdr workspace.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub pane_count: u64,
    #[serde(default)]
    pub tab_count: u64,
    #[serde(default)]
    pub active_tab_id: String,
    #[serde(default)]
    pub agent_status: AgentStatus,
    #[serde(default)]
    pub tokens: BTreeMap<String, String>,
    /// Which repository and checkout the workspace is in, when herdr knows (a workspace opened from
    /// a git folder). An unreadable value reads as absent: grouping then falls back to the label.
    #[serde(default, deserialize_with = "lenient")]
    pub worktree: Option<WorkspaceWorktree>,
}

/// Git provenance of a workspace (`WorkspaceWorktreeInfo` in the schema). The branch is not part of
/// it: herdr reports branches only through `worktree.list`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WorkspaceWorktree {
    /// Identifies the repository across its checkouts; the same for the main checkout and every linked worktree.
    #[serde(default)]
    pub repo_key: String,
    /// The repository's name.
    #[serde(default)]
    pub repo_name: String,
    /// The main checkout's folder.
    #[serde(default)]
    pub repo_root: String,
    /// The folder of the checkout this workspace is in.
    #[serde(default)]
    pub checkout_path: String,
    /// The checkout is a linked worktree, not the main one.
    #[serde(default)]
    pub is_linked_worktree: bool,
}

/// Reads a value or, when it has the wrong shape, nothing: a field this app only uses for grouping
/// must never make a whole snapshot unreadable.
fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let raw = Option::<Value>::deserialize(deserializer)?;
    Ok(raw.and_then(|v| serde_json::from_value(v).ok()))
}

/// A herdr tab.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TabInfo {
    pub tab_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub number: u64,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub pane_count: u64,
    #[serde(default)]
    pub agent_status: AgentStatus,
}

/// A herdr pane (a terminal, with or without an agent).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PaneInfo {
    pub pane_id: String,
    #[serde(default)]
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub agent_status: AgentStatus,
    /// Bumped by herdr on every content change of the pane.
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub agent_session: Option<AgentSession>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub display_agent: Option<String>,
    #[serde(default)]
    pub foreground_cwd: Option<String>,
    /// The name the person gave the pane.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub restore_error: Option<String>,
    #[serde(default)]
    pub scroll: Option<PaneScroll>,
    #[serde(default)]
    pub state_labels: BTreeMap<String, String>,
    #[serde(default)]
    pub terminal_title: Option<String>,
    #[serde(default)]
    pub terminal_title_stripped: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tokens: BTreeMap<String, String>,
}

/// An agent herdr detected in a pane. `state_change_seq` names the current state episode: it moves
/// whenever the status changes, which is what dates an episode and what a "reviewed" mark refers to.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AgentInfo {
    #[serde(default)]
    pub terminal_id: String,
    #[serde(default)]
    pub agent_status: AgentStatus,
    pub workspace_id: String,
    pub tab_id: String,
    pub pane_id: String,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub agent_session: Option<AgentSession>,
    #[serde(default)]
    pub completion_seq: Option<u64>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub display_agent: Option<String>,
    #[serde(default)]
    pub foreground_cwd: Option<String>,
    #[serde(default)]
    pub interactive_ready: bool,
    #[serde(default)]
    pub launch_pending: bool,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub screen_detection_skipped: bool,
    #[serde(default)]
    pub state_change_seq: u64,
    #[serde(default)]
    pub state_labels: BTreeMap<String, String>,
    #[serde(default)]
    pub terminal_title: Option<String>,
    #[serde(default)]
    pub terminal_title_stripped: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tokens: BTreeMap<String, String>,
}

/// Everything herdr knows, as `session.snapshot` returns it. Rows that cannot be read are left out
/// rather than failing the whole snapshot: one odd pane must not blind the app to the other 25.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Snapshot {
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub protocol: u32,
    #[serde(default, deserialize_with = "rows")]
    pub workspaces: Vec<WorkspaceInfo>,
    #[serde(default, deserialize_with = "rows")]
    pub tabs: Vec<TabInfo>,
    #[serde(default, deserialize_with = "rows")]
    pub panes: Vec<PaneInfo>,
    /// Pane layouts; kept opaque until a screen needs them.
    #[serde(default)]
    pub layouts: Vec<Value>,
    #[serde(default, deserialize_with = "rows")]
    pub agents: Vec<AgentInfo>,
    #[serde(default)]
    pub focused_workspace_id: Option<String>,
    #[serde(default)]
    pub focused_tab_id: Option<String>,
    #[serde(default)]
    pub focused_pane_id: Option<String>,
    /// The link's change counter when this snapshot was published: strictly increasing per link,
    /// never sent by herdr.
    #[serde(skip)]
    pub revision: u64,
}

fn rows<'de, D, T>(deserializer: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let raw = Vec::<Value>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect())
}

impl Snapshot {
    /// Reads a `session.snapshot` result: `{"type":"session_snapshot","snapshot":{..}}` (the
    /// `snapshot` wrapper is optional so a bare snapshot object also reads).
    pub fn from_result(result: &Value) -> Result<Self, WireError> {
        let body = result.get("snapshot").unwrap_or(result);
        if !body.is_object() {
            return Err(WireError::retryable(
                "herdr's session.snapshot answer is not an object",
            ));
        }
        Self::deserialize(body).map_err(|e| {
            WireError::retryable(format!(
                "herdr's session.snapshot answer cannot be read: {e}"
            ))
        })
    }

    /// The pane with this id.
    pub fn pane(&self, pane_id: &str) -> Option<&PaneInfo> {
        self.panes.iter().find(|p| p.pane_id == pane_id)
    }

    /// The agent running in this pane.
    pub fn agent(&self, pane_id: &str) -> Option<&AgentInfo> {
        self.agents.iter().find(|a| a.pane_id == pane_id)
    }

    /// The workspace with this id.
    pub fn workspace(&self, workspace_id: &str) -> Option<&WorkspaceInfo> {
        self.workspaces
            .iter()
            .find(|w| w.workspace_id == workspace_id)
    }

    /// Whether two snapshots show the person the same thing. Ignores what changes on every output
    /// burst without meaning anything to a reader (`revision`, scroll position, spinner frames in
    /// the raw terminal title), so a busy agent does not make every refresh look like news.
    pub fn same_content(&self, other: &Snapshot) -> bool {
        // Exhaustive destructuring: a field added later must be classified here, not forgotten.
        let Snapshot {
            version,
            protocol,
            workspaces,
            tabs,
            panes,
            layouts,
            agents,
            focused_workspace_id,
            focused_tab_id,
            focused_pane_id,
            revision: _,
        } = self;
        *version == other.version
            && *protocol == other.protocol
            && *workspaces == other.workspaces
            && *tabs == other.tabs
            && *layouts == other.layouts
            && *focused_workspace_id == other.focused_workspace_id
            && *focused_tab_id == other.focused_tab_id
            && *focused_pane_id == other.focused_pane_id
            && panes.len() == other.panes.len()
            && panes.iter().zip(&other.panes).all(|(a, b)| a.same_view(b))
            && agents.len() == other.agents.len()
            && agents
                .iter()
                .zip(&other.agents)
                .all(|(a, b)| a.same_view(b))
    }
}

/// A terminal title with agent chrome removed: braille spinner frames (they change several times a
/// second), omp's `π` mark and leading separators. Keeps spinner animation from making every
/// snapshot "different".
pub fn clean_terminal_title(raw: &str) -> String {
    let no_spinner: String = raw
        .chars()
        .filter(|c| !('\u{2800}'..='\u{28FF}').contains(c))
        .collect();
    let trimmed = no_spinner.trim();
    let trimmed = trimmed.strip_prefix('π').unwrap_or(trimmed);
    trimmed
        .trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim()
        .to_owned()
}

fn same_title(a: &Option<String>, b: &Option<String>) -> bool {
    a == b
        || matches!((a, b), (Some(x), Some(y)) if clean_terminal_title(x) == clean_terminal_title(y))
}

impl PaneInfo {
    /// [`Snapshot::same_content`] for one pane.
    pub fn same_view(&self, other: &PaneInfo) -> bool {
        let PaneInfo {
            pane_id,
            terminal_id,
            workspace_id,
            tab_id,
            focused,
            agent_status,
            revision: _,
            agent,
            agent_session,
            cwd,
            display_agent,
            foreground_cwd,
            label,
            restore_error,
            scroll: _,
            state_labels,
            terminal_title,
            terminal_title_stripped,
            title,
            tokens,
        } = self;
        *pane_id == other.pane_id
            && *terminal_id == other.terminal_id
            && *workspace_id == other.workspace_id
            && *tab_id == other.tab_id
            && *focused == other.focused
            && *agent_status == other.agent_status
            && *agent == other.agent
            && *agent_session == other.agent_session
            && *cwd == other.cwd
            && *display_agent == other.display_agent
            && *foreground_cwd == other.foreground_cwd
            && *label == other.label
            && *restore_error == other.restore_error
            && *state_labels == other.state_labels
            && same_title(terminal_title, &other.terminal_title)
            && *terminal_title_stripped == other.terminal_title_stripped
            && *title == other.title
            && *tokens == other.tokens
    }
}

impl AgentInfo {
    /// [`Snapshot::same_content`] for one agent.
    pub fn same_view(&self, other: &AgentInfo) -> bool {
        let AgentInfo {
            terminal_id,
            agent_status,
            workspace_id,
            tab_id,
            pane_id,
            focused,
            revision: _,
            agent,
            agent_session,
            completion_seq,
            cwd,
            display_agent,
            foreground_cwd,
            interactive_ready,
            launch_pending,
            name,
            screen_detection_skipped,
            state_change_seq,
            state_labels,
            terminal_title,
            terminal_title_stripped,
            title,
            tokens,
        } = self;
        *terminal_id == other.terminal_id
            && *agent_status == other.agent_status
            && *workspace_id == other.workspace_id
            && *tab_id == other.tab_id
            && *pane_id == other.pane_id
            && *focused == other.focused
            && *agent == other.agent
            && *agent_session == other.agent_session
            && *completion_seq == other.completion_seq
            && *cwd == other.cwd
            && *display_agent == other.display_agent
            && *foreground_cwd == other.foreground_cwd
            && *interactive_ready == other.interactive_ready
            && *launch_pending == other.launch_pending
            && *name == other.name
            && *screen_detection_skipped == other.screen_detection_skipped
            && *state_change_seq == other.state_change_seq
            && *state_labels == other.state_labels
            && same_title(terminal_title, &other.terminal_title)
            && *terminal_title_stripped == other.terminal_title_stripped
            && *title == other.title
            && *tokens == other.tokens
    }

    /// Copies what a `pane_updated` event carries (the fields a pane and its agent share) into this
    /// agent. `state_change_seq` and `completion_seq` are not on a pane: a status change needs a
    /// snapshot read, never this patch.
    pub fn apply_pane(&mut self, pane: &PaneInfo) {
        self.focused = pane.focused;
        self.revision = pane.revision;
        self.agent = pane.agent.clone();
        self.agent_session = pane.agent_session.clone();
        self.cwd = pane.cwd.clone();
        self.display_agent = pane.display_agent.clone();
        self.foreground_cwd = pane.foreground_cwd.clone();
        self.state_labels = pane.state_labels.clone();
        self.terminal_title = pane.terminal_title.clone();
        self.terminal_title_stripped = pane.terminal_title_stripped.clone();
        self.title = pane.title.clone();
        self.tokens = pane.tokens.clone();
    }
}

/// An event line `{"event","data"}`, reduced to what the link acts on.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// `pane_updated`: a full [`PaneInfo`] (the global firehose, about 25 per second across 26 panes).
    PaneUpdated(Box<PaneInfo>),
    /// `pane_output_changed`.
    PaneOutputChanged { pane_id: String, revision: u64 },
    /// `pane_agent_status_changed`.
    PaneAgentStatusChanged {
        pane_id: String,
        status: AgentStatus,
    },
    /// A workspace, tab, pane, layout or worktree changed shape; the name is the event's.
    Structural(String),
    /// An event kind this app does not know.
    Other(String),
}

impl Event {
    /// Reads an event object; `None` when it has no `event` name (not an event line).
    pub fn parse(value: &Value) -> Option<Event> {
        let name = value.get("event")?.as_str()?;
        let data = value.get("data").unwrap_or(&Value::Null);
        Some(match name {
            "pane_updated" => match data.get("pane").and_then(|p| PaneInfo::deserialize(p).ok()) {
                Some(pane) => Event::PaneUpdated(Box::new(pane)),
                None => Event::Other(name.to_owned()),
            },
            "pane_output_changed" => match data.get("pane_id").and_then(Value::as_str) {
                Some(id) => Event::PaneOutputChanged {
                    pane_id: id.to_owned(),
                    revision: data.get("revision").and_then(Value::as_u64).unwrap_or(0),
                },
                None => Event::Other(name.to_owned()),
            },
            "pane_agent_status_changed" => match data.get("pane_id").and_then(Value::as_str) {
                Some(id) => Event::PaneAgentStatusChanged {
                    pane_id: id.to_owned(),
                    status: data
                        .get("agent_status")
                        .and_then(|s| AgentStatus::deserialize(s).ok())
                        .unwrap_or_default(),
                },
                None => Event::Other(name.to_owned()),
            },
            n if is_structural(n) => Event::Structural(n.to_owned()),
            n => Event::Other(n.to_owned()),
        })
    }
}

fn is_structural(name: &str) -> bool {
    name.starts_with("workspace_")
        || name.starts_with("tab_")
        || name.starts_with("worktree_")
        || matches!(
            name,
            "pane_created"
                | "pane_closed"
                | "pane_moved"
                | "pane_exited"
                | "pane_focused"
                | "pane_agent_detected"
                | "layout_updated"
        )
}
