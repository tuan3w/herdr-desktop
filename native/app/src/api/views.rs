//! The values TSX sees: plain objects built from the engine's types. Doc comments become TypeScript doc
//! comments, so they say what a screen needs to know.

use std::time::Duration;

use herdr_core::board::AgentRow;
use herdr_core::prompt::{PromptInfo, is_negative_reply};
use herdr_core::schema::AgentStatus;
use herdr_core::store::Machine;
use nsh_core::JsonValue;
use nsh_core::prelude::*;

use crate::engine::{
    AnswerOutcome, BoardState, Connection, Created, LinkKind, MachineHealth,
    MachineInput as EngineInput, PaneSummary, Preview, Split, StartAgent as EngineStart,
};
use crate::feed::{FeedState, PaneSource};

/// What an agent is doing. `done` is finished and not yet looked at; a finished agent the person has
/// reviewed reads `idle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum AgentState {
    /// Waiting on the person.
    Blocked,
    /// Finished and not yet looked at.
    Done,
    /// Working.
    Working,
    /// At rest.
    Idle,
    /// herdr says something this app does not know, or the pane has no agent.
    Unknown,
}

impl From<AgentStatus> for AgentState {
    fn from(status: AgentStatus) -> Self {
        match status {
            AgentStatus::Blocked => Self::Blocked,
            AgentStatus::Done => Self::Done,
            AgentStatus::Working => Self::Working,
            AgentStatus::Idle => Self::Idle,
            AgentStatus::Unknown => Self::Unknown,
        }
    }
}

/// How a machine's connection is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum LinkStateName {
    /// The first attempt is in flight.
    Connecting,
    /// Connected and live.
    Online,
    /// Lost; retrying with a growing pause.
    Offline,
    /// Needs the person: no retries until `reconnect` (a changed host key, no login).
    Attention,
    /// Switched off.
    Off,
}

impl From<LinkKind> for LinkStateName {
    fn from(kind: LinkKind) -> Self {
        match kind {
            LinkKind::Connecting => Self::Connecting,
            LinkKind::Online => Self::Online,
            LinkKind::Offline => Self::Offline,
            LinkKind::Attention => Self::Attention,
            LinkKind::Off => Self::Off,
        }
    }
}

/// Whether what a pane shows can be trusted: `live` reads succeed, `stale` is the last text of a
/// machine that is not connected (show it dimmed, with a notice), `gone` is a pane herdr no longer has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum FeedStateName {
    /// Reads succeed.
    Live,
    /// The last text of a machine that is not connected.
    Stale,
    /// herdr no longer has the pane.
    Gone,
}

impl From<FeedState> for FeedStateName {
    fn from(state: FeedState) -> Self {
        match state {
            FeedState::Live => Self::Live,
            FeedState::Stale => Self::Stale,
            FeedState::Gone => Self::Gone,
        }
    }
}

/// Which part of a pane a view shows: the live `visible` screen or the scrollback `recent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum PaneSourceName {
    /// The live screen.
    Visible,
    /// The scrollback, up to 1000 rows.
    Recent,
}

impl From<PaneSourceName> for PaneSource {
    fn from(source: PaneSourceName) -> Self {
        match source {
            PaneSourceName::Visible => Self::Visible,
            PaneSourceName::Recent => Self::Recent,
        }
    }
}

/// How an answer ended: `sent` (the keys went to the pane), `changed` (the question is not what the
/// person saw: nothing was sent), `notBlocked` (the agent is not waiting any more: nothing was sent) or
/// `failed` (the message says why; nothing was sent unless the message says otherwise).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum AnswerKind {
    /// The keys went to the pane.
    Sent,
    /// The pane no longer shows the question the person saw.
    Changed,
    /// The agent is not waiting any more.
    NotBlocked,
    /// Nothing could be sent, or the send failed.
    Failed,
}

/// Which way a split goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum SplitDirection {
    /// The new pane is on the right.
    Right,
    /// The new pane is below.
    Down,
}

impl From<SplitDirection> for Split {
    fn from(direction: SplitDirection) -> Self {
        match direction {
            SplitDirection::Right => Self::Right,
            SplitDirection::Down => Self::Down,
        }
    }
}

/// What `Herdr.configure` takes.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
#[prop(exact)]
pub struct ConfigureOptions {
    /// Where machines, reviewed marks and settings are kept (`process.dataDir`); empty uses a fresh
    /// temporary directory.
    pub data_dir: String,
    /// The name of a scripted herdr in `fixtures/herdr`, honoured only when the environment variable
    /// `HERDR_DESKTOP_TEST` is `1`; otherwise ignored.
    #[prop(skip_none)]
    pub fixture: Option<String>,
}

/// A machine herdr runs on, as listed.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct MachineView {
    /// Stable id: `local` for this computer, `m1`, `m2`... for the others.
    pub id: String,
    /// What the person calls it.
    pub name: String,
    /// `user@host` or an ssh config alias; empty for this computer.
    pub dest: String,
    /// ssh port when not the default.
    #[prop(skip_none)]
    pub port: Option<u32>,
    /// herdr session on that machine when not the default one.
    #[prop(skip_none)]
    pub session: Option<String>,
    /// Whether the machine is switched on.
    pub enabled: bool,
    /// Whether this is the computer the app runs on.
    pub local: bool,
}

impl From<Machine> for MachineView {
    fn from(m: Machine) -> Self {
        Self {
            local: m.is_local(),
            id: m.id,
            name: m.name,
            dest: m.dest,
            port: m.port.map(u32::from),
            session: m.session,
            enabled: m.enabled,
        }
    }
}

/// What the machine form submits (`saveMachine`, `testConnection`). There is no password or key: `ssh`
/// brings its own identity and host-key trust.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct MachineInput {
    /// The machine being changed; leave out to add one.
    #[prop(skip_none)]
    pub id: Option<String>,
    /// What the person calls it.
    pub name: String,
    /// `user@host` or an ssh config alias. Empty means this computer (for `testConnection` only).
    pub dest: String,
    /// ssh port.
    #[prop(skip_none)]
    pub port: Option<u32>,
    /// herdr session on that machine.
    #[prop(skip_none)]
    pub session: Option<String>,
    /// Whether the machine is switched on.
    pub enabled: bool,
}

impl MachineInput {
    pub(super) fn into_engine(self) -> Result<EngineInput, String> {
        let port = match self.port {
            None => None,
            Some(p) => Some(
                u16::try_from(p)
                    .ok()
                    .filter(|p| *p != 0)
                    .ok_or_else(|| "invalid port: must be 1 to 65535".to_owned())?,
            ),
        };
        Ok(EngineInput {
            id: self.id,
            name: self.name,
            dest: self.dest,
            port,
            session: self.session,
            enabled: self.enabled,
        })
    }
}

/// How a connection test ended.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct TestResult {
    /// Whether herdr answered.
    pub ok: bool,
    /// herdr's version when it answered.
    #[prop(skip_none)]
    pub version: Option<String>,
    /// Workspaces herdr has when it answered.
    #[prop(skip_none)]
    pub workspaces: Option<usize>,
    /// What to show: `Connected · herdr 0.9.5 · 3 workspaces`, or why it failed and what to do.
    pub message: String,
}

impl From<Connection> for TestResult {
    fn from(c: Connection) -> Self {
        Self {
            ok: c.ok,
            version: c.version,
            workspaces: c.workspaces,
            message: c.message,
        }
    }
}

/// One destination the person visited (`Herdr.recents`).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct Recent {
    /// What `Herdr.visit` was given: `agent:<BoardRow.key>` or `project:<BoardProject.key>`.
    pub key: String,
    /// When it was visited last, in milliseconds since the epoch.
    pub last_visit: u64,
    /// How many visits were counted in all.
    pub count: u64,
    /// How often and how recently, from the last ten visits (a visit just now weighs 1, a week ago 0.5): for a ranking.
    pub frecency: f64,
}

/// One machine's connection, for the machine list and the sidebar.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct MachineStatus {
    /// The machine's id.
    pub id: String,
    /// What the person calls it.
    pub name: String,
    /// How the connection is doing.
    pub state: LinkStateName,
    /// Why it is offline or needs attention, ready to show (for `attention`: what to do).
    #[prop(skip_none)]
    pub detail: Option<String>,
    /// While `offline`: seconds until the next attempt (`reconnecting in 4 s`).
    #[prop(skip_none)]
    pub retry_in_secs: Option<u64>,
    /// herdr's version on that machine.
    #[prop(skip_none)]
    pub herdr_version: Option<String>,
    /// herdr there speaks a newer protocol than this app was written for; it is used as it is.
    pub newer_herdr: bool,
    /// Seconds since the machine last said anything.
    #[prop(skip_none)]
    pub heard_ago_secs: Option<u64>,
    /// Agents on it, as of the last snapshot.
    pub agents: usize,
    /// Agents on it that wait for the person (0 unless it is online).
    pub needs_you: usize,
}

impl From<MachineHealth> for MachineStatus {
    fn from(h: MachineHealth) -> Self {
        Self {
            id: h.id,
            name: h.name,
            state: h.state.into(),
            detail: h.detail,
            retry_in_secs: h.retry_in.map(whole_seconds_up),
            herdr_version: h.herdr_version,
            newer_herdr: h.newer_herdr,
            heard_ago_secs: h.heard_ago.map(|d| d.as_secs()),
            agents: h.agents,
            needs_you: h.needs_you,
        }
    }
}

/// A wait shown as `in 4 s`: rounded up, so it never reads `0 s` while still waiting.
fn whole_seconds_up(d: Duration) -> u64 {
    d.as_secs() + u64::from(d.subsec_nanos() > 0)
}

/// One way to answer a question.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PromptOption {
    /// The option's words as the agent draws them (`1. Yes`, `No`, `Enter`).
    pub label: String,
    /// Set when answering needs a second, deliberate activation, and says why (`pushes to a remote`).
    #[prop(skip_none)]
    pub risk_reason: Option<String>,
    /// The option grants a permission that outlives this answer ("don't ask again").
    pub standing_grant: bool,
    /// The option declines ("No", "Deny", "Cancel"). The reply field is shown only when one does: it means
    /// "deny and say this", and the words are sent after that option, never into the menu.
    pub reject: bool,
    /// Pass this to `answer` with the prompt's `digest`.
    pub index: usize,
}

/// The question a blocked agent is waiting on.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PromptView {
    /// One or two lines.
    pub question: String,
    /// What it is about as the agent drew it: the command, URL or path being approved. Show all of it.
    #[prop(skip_none)]
    pub subject: Option<String>,
    /// The answers, in on-screen order.
    pub options: Vec<PromptOption>,
    /// Fingerprint of what the question shows. `answer` sends only if the pane still shows it.
    pub digest: String,
}

impl From<&PromptInfo> for PromptView {
    fn from(p: &PromptInfo) -> Self {
        Self {
            question: p.question.clone(),
            subject: p.subject.clone(),
            options: p
                .options
                .iter()
                .enumerate()
                .map(|(index, o)| PromptOption {
                    label: o.label.clone(),
                    risk_reason: o.risk.map(|r| r.reason().to_owned()),
                    standing_grant: o.standing_grant,
                    reject: is_negative_reply(o),
                    index,
                })
                .collect(),
            digest: p.digest.clone(),
        }
    }
}

/// One agent on the board.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct BoardRow {
    /// Stable across refreshes: `<machine>/<paneId>`, or `<machine>/session:<id>` for a session.
    pub key: String,
    /// The machine's id.
    pub machine: String,
    /// The machine's name.
    pub machine_name: String,
    /// The pane the agent runs in; for a `session` row, the session's id (open it with `Sessions.attach`).
    pub pane_id: String,
    /// This row is an agent session (a chat with an ACP agent kept by a keeper on the machine), not a
    /// terminal pane: it has no preview, no prompt chips and no reviewed mark; answer it in its own tab.
    pub session: bool,
    /// The pane's workspace.
    pub workspace_id: String,
    /// The pane's tab.
    pub tab_id: String,
    /// The key of the project it belongs to (`BoardProject.key`).
    pub project: String,
    /// The folder of its checkout when the project has checkouts (`BoardCheckout.path`).
    #[prop(skip_none)]
    pub checkout: Option<String>,
    /// For a session: the first line of what the agent said last, when known.
    #[prop(skip_none)]
    pub last_message: Option<String>,
    /// The agent's kind (`omp`, `claude`); empty when herdr names none.
    pub agent: String,
    /// What the person calls it: the pane's label, else the terminal title, else the folder.
    pub name: String,
    /// What it is doing. A finished agent the person reviewed reads `idle`.
    pub status: AgentState,
    /// How long it has been in this state, when known.
    #[prop(skip_none)]
    pub since_secs: Option<u64>,
    /// Its machine is not connected: this is the last known state, to show dimmed and never count.
    pub offline: bool,
    /// Its folder.
    #[prop(skip_none)]
    pub cwd: Option<String>,
    /// A finished state the person looked at.
    pub reviewed: bool,
    /// Pass to `review`/`unreview` to mark this finished state: `<machine>|<paneId>|<episode>`.
    pub review_key: String,
    /// The question, while the agent is blocked on one the app understands.
    #[prop(skip_none)]
    pub prompt: Option<PromptView>,
    /// The last rows of the pane, oldest first (read when the agent's state changes, not on every output).
    pub preview: Vec<String>,
}

impl BoardRow {
    fn new(
        row: &AgentRow,
        machine_name: &str,
        preview: Option<&Preview>,
        now: std::time::Instant,
    ) -> Self {
        Self {
            key: row.key(),
            machine: row.machine.clone(),
            machine_name: machine_name.to_owned(),
            pane_id: row.pane_id.clone(),
            session: row.session,
            workspace_id: row.workspace_id.clone(),
            tab_id: row.tab_id.clone(),
            project: row.project.clone(),
            checkout: row.checkout.clone(),
            last_message: row.last_message.clone(),
            agent: row.agent.clone(),
            name: row.name.clone(),
            status: row.status.into(),
            since_secs: row.age(now).map(|d| d.as_secs()),
            offline: row.offline,
            cwd: row.cwd.clone(),
            reviewed: row.reviewed,
            review_key: review_key(row),
            prompt: preview
                .and_then(|p| p.prompt.as_ref())
                .map(PromptView::from),
            preview: preview.map(|p| p.rows.clone()).unwrap_or_default(),
        }
    }
}

/// The text of a row's [`herdr_core::store::ReviewKey`].
fn review_key(row: &AgentRow) -> String {
    let key = row.review_key();
    format!("{}|{}|{}", key.machine, key.pane_id, key.seq)
}

/// The numbers every surface shows; each agent is in exactly one of the first five.
#[derive(Debug, Clone, Copy, PartialEq, Eq, JsObject)]
pub struct BoardCounts {
    /// Blocked on the person, machine connected.
    pub needs_you: usize,
    /// Finished and not reviewed, machine connected.
    pub to_review: usize,
    /// Working.
    pub working: usize,
    /// Idle or unknown.
    pub idle: usize,
    /// On a machine that is not connected: listed dimmed, never counted above.
    pub offline: usize,
    /// Switched-on machines that are not connected.
    pub machines_not_connected: usize,
}

/// One checkout of a project that has agents: the main one or a linked worktree.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct BoardCheckout {
    /// Its folder; what `BoardRow.checkout` names.
    pub path: String,
    /// The folder's own name, which is what a person calls a worktree.
    pub name: String,
    /// A linked worktree, not the repository's main checkout.
    pub linked: bool,
    /// The branch checked out, once `Herdr.worktrees` has looked (the snapshot carries none); absent until then.
    #[prop(skip_none)]
    pub branch: Option<String>,
}

/// A repository or folder the agents work in, with its agents and what needs the person.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct BoardProject {
    /// Stable and unique per machine: what `pinProject` and the folds are saved under.
    pub key: String,
    /// What the person calls it.
    pub name: String,
    /// The machine's id.
    pub machine: String,
    /// The machine's name.
    pub machine_name: String,
    /// The person pinned it: pinned projects come first, then by name.
    pub pinned: bool,
    /// Its machine is not connected: dim it.
    pub offline: bool,
    /// The checkouts that have agents, the main one first. Empty for a project that is only a label or a folder.
    pub checkouts: Vec<BoardCheckout>,
    /// Agents blocked on the person (0 while offline).
    pub needs_you: usize,
    /// Finished and not reviewed (0 while offline).
    pub to_review: usize,
    /// Working (0 while offline).
    pub working: usize,
    /// Its agents, chat sessions and terminal agents together: those that need the person first, then newest state first.
    pub rows: Vec<BoardRow>,
}

/// The board: every agent on every machine, grouped by project.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct BoardData {
    /// The projects: pinned first, then by name. The order never changes with what the agents do.
    pub projects: Vec<BoardProject>,
    /// The agents blocked on the person, longest waiting first, offline ones last: the `Needs you` strip and the triage walk. The same rows as in `projects`.
    pub needs_you: Vec<BoardRow>,
    /// The numbers behind the status line, the window title and notifications.
    pub counts: BoardCounts,
    /// `2 need you · 3 to review · 3 working · heard just now`; `nothing running`; `1 not connected`.
    pub status_line: String,
    /// The window title: `(2) Herdr Desktop`, or `Herdr Desktop` when nothing needs the person.
    pub title: String,
    /// The engine's change counter when this was pulled.
    pub revision: u64,
}

impl BoardData {
    pub(super) fn new(state: &BoardState, revision: u64) -> Self {
        let name_of = |machine: &str| {
            state
                .machine_names
                .get(machine)
                .map_or("", String::as_str)
                .to_owned()
        };
        let row = |row: &AgentRow| {
            BoardRow::new(
                row,
                &name_of(&row.machine),
                state.previews.get(&row.key()),
                state.now,
            )
        };
        let b = &state.board;
        let c = b.counts;
        Self {
            projects: b
                .projects
                .iter()
                .map(|p| BoardProject {
                    key: p.key.clone(),
                    name: p.name.clone(),
                    machine: p.machine.clone(),
                    machine_name: name_of(&p.machine),
                    pinned: p.pinned,
                    offline: p.offline,
                    checkouts: p
                        .checkouts
                        .iter()
                        .map(|k| BoardCheckout {
                            path: k.path.clone(),
                            name: k.name.clone(),
                            linked: k.linked,
                            branch: k.branch.clone(),
                        })
                        .collect(),
                    needs_you: p.needs_you,
                    to_review: p.to_review,
                    working: p.working,
                    rows: p.rows.iter().map(row).collect(),
                })
                .collect(),
            needs_you: b.needs_you.iter().map(row).collect(),
            counts: BoardCounts {
                needs_you: c.needs_you,
                to_review: c.to_review,
                working: c.working,
                idle: c.idle,
                offline: c.offline,
                machines_not_connected: c.machines_not_connected,
            },
            status_line: state.status_line.clone(),
            title: state.title.clone(),
            revision,
        }
    }
}

/// What a screen shows of one pane (a tab's header, the answer dock).
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PaneMeta {
    /// What the person calls it.
    pub name: String,
    /// The agent's kind; empty for a plain terminal.
    pub agent: String,
    /// Its folder.
    #[prop(skip_none)]
    pub cwd: Option<String>,
    /// What it is doing (`unknown` for a plain terminal).
    pub status: AgentState,
    /// The pane's workspace (empty when herdr no longer has the pane).
    pub workspace_id: String,
    /// The pane's tab (empty when herdr no longer has the pane).
    pub tab_id: String,
    /// The workspace's name.
    pub workspace_label: String,
    /// The tab's name.
    pub tab_label: String,
    /// The name the person gave the pane; empty when none.
    pub pane_label: String,
    /// The tab's name was given by the person (it is not herdr's default, its number).
    pub tab_named: bool,
    /// The workspace's name was given by the person (it is not the folder or repository herdr names it by).
    pub workspace_named: bool,
    /// The machine's name.
    pub machine_name: String,
    /// Whether what the pane shows can be trusted; `gone` means herdr no longer has the pane.
    pub feed_state: FeedStateName,
    /// The question, while the agent is blocked on one the app understands.
    #[prop(skip_none)]
    pub prompt: Option<PromptView>,
}

impl From<PaneSummary> for PaneMeta {
    fn from(s: PaneSummary) -> Self {
        Self {
            name: s.name,
            agent: s.agent,
            cwd: s.cwd,
            status: s.status.into(),
            workspace_id: s.workspace_id,
            tab_id: s.tab_id,
            workspace_label: s.workspace_label,
            tab_label: s.tab_label,
            pane_label: s.pane_label,
            tab_named: s.tab_named,
            workspace_named: s.workspace_named,
            machine_name: s.machine_name,
            feed_state: s.feed.into(),
            prompt: s.prompt.as_ref().map(PromptView::from),
        }
    }
}

/// How an answer ended; see [`AnswerKind`].
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct AnswerResult {
    /// What happened.
    pub kind: AnswerKind,
    /// Why, for `failed`.
    #[prop(skip_none)]
    pub message: Option<String>,
}

impl From<AnswerOutcome> for AnswerResult {
    fn from(outcome: AnswerOutcome) -> Self {
        let (kind, message) = match outcome {
            AnswerOutcome::Sent => (AnswerKind::Sent, None),
            AnswerOutcome::Changed => (AnswerKind::Changed, None),
            AnswerOutcome::NotBlocked => (AnswerKind::NotBlocked, None),
            AnswerOutcome::Failed(message) => (AnswerKind::Failed, Some(message)),
        };
        Self { kind, message }
    }
}

/// What a create call made.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct CreatedView {
    /// The workspace; empty when the call made none.
    pub workspace_id: String,
    /// The tab.
    pub tab_id: String,
    /// The pane (a new tab or workspace has one).
    pub pane_id: String,
}

impl From<Created> for CreatedView {
    fn from(c: Created) -> Self {
        Self {
            workspace_id: c.workspace_id,
            tab_id: c.tab_id,
            pane_id: c.pane_id,
        }
    }
}

/// What `startAgent` takes.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct StartAgent {
    /// The folder the agent works in.
    pub cwd: String,
    /// The agent's kind as herdr knows it (`claude`, `codex`, `omp`).
    pub agent: String,
    /// The name of the new tab or workspace and of the agent; the kind when left out.
    #[prop(skip_none)]
    pub name: Option<String>,
    /// Open it in a new tab of this workspace; a new workspace when left out.
    #[prop(skip_none)]
    pub workspace_id: Option<String>,
    /// Arguments after the agent's command.
    #[prop(default)]
    pub args: Vec<String>,
}

impl From<StartAgent> for EngineStart {
    fn from(s: StartAgent) -> Self {
        Self {
            cwd: s.cwd,
            agent: s.agent,
            name: s.name,
            workspace_id: s.workspace_id,
            args: s.args,
        }
    }
}

/// A request the scripted herdr served (test seam only).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct TestRequest {
    /// The method, such as `pane.send_keys`.
    pub method: String,
    /// The request's parameters as sent.
    pub params: JsonValue,
}

/// A click on a notification: what to show. Both fields are absent for a summary (`5 agents need you`):
/// open the board.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct NotificationOpen {
    /// The machine of the agent the notification was about.
    #[prop(skip_none)]
    pub machine: Option<String>,
    /// The agent's pane.
    #[prop(skip_none)]
    pub pane: Option<String>,
}

impl From<crate::notify::Target> for NotificationOpen {
    fn from(target: crate::notify::Target) -> Self {
        match target {
            crate::notify::Target::Agent { machine, pane } => Self {
                machine: Some(machine),
                pane: Some(pane),
            },
            crate::notify::Target::Board => Self {
                machine: None,
                pane: None,
            },
        }
    }
}

/// Whether the desktop can show notifications.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct NotificationSupport {
    /// A notification service answered on the session bus.
    pub available: bool,
    /// When unavailable: what is missing, ready to show. Otherwise empty.
    pub detail: String,
    /// The service shows answer buttons; without it a notification only opens the app.
    pub buttons: bool,
}

impl From<Result<crate::notify::Support, String>> for NotificationSupport {
    fn from(support: Result<crate::notify::Support, String>) -> Self {
        match support {
            Ok(support) => Self {
                available: true,
                detail: String::new(),
                buttons: support.actions,
            },
            Err(detail) => Self {
                available: false,
                detail,
                buttons: false,
            },
        }
    }
}

/// A notification a scripted herdr's app "showed" (test seam only).
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct TestNotification {
    /// Its id; pass it to `testPressNotification`.
    pub id: u64,
    /// The headline.
    pub title: String,
    /// The question, the command and where the agent runs.
    pub body: String,
    /// The words of its answer buttons.
    pub buttons: Vec<String>,
    /// The machine of the agent it is about; absent for a summary.
    #[prop(skip_none)]
    pub machine: Option<String>,
    /// The pane it is about; absent for a summary.
    #[prop(skip_none)]
    pub pane: Option<String>,
    /// Still on the desktop (not withdrawn).
    pub open: bool,
}

impl From<crate::notify::RecordedNotification> for TestNotification {
    fn from(n: crate::notify::RecordedNotification) -> Self {
        let open: NotificationOpen = n.target.into();
        Self {
            id: n.id,
            title: n.title,
            body: n.body,
            buttons: n.buttons,
            machine: open.machine,
            pane: open.pane,
            open: n.open,
        }
    }
}

#[cfg(test)]
mod tests {
    use herdr_core::prompt::{PromptInfo, QuickReply};

    use super::PromptView;

    fn reply(label: &str) -> QuickReply {
        QuickReply {
            label: label.to_owned(),
            keys: vec![],
            risk: None,
            standing_grant: false,
        }
    }

    /// The reply field is offered only where an option declines, so which options do comes from the words
    /// the agent drew, not from where they stand in the list.
    #[test]
    fn the_options_that_decline_are_marked_by_their_words_not_their_place() {
        let info = PromptInfo {
            question: "Proceed?".to_owned(),
            subject: None,
            options: vec![
                reply("1. No"),
                reply("2. Yes"),
                reply("3. Deny, and tell the agent why"),
                reply("Cancel"),
            ],
            digest: "d".to_owned(),
        };
        let marks: Vec<_> = PromptView::from(&info)
            .options
            .iter()
            .map(|o| o.reject)
            .collect();
        assert_eq!(marks, [true, false, true, true]);
    }
}
