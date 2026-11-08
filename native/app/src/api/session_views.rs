//! The values the `Sessions` module hands TSX: plain objects built from `herdr-core`'s session types.
//! Doc comments become TypeScript doc comments, so they say what a screen needs to know.

use herdr_core::prompt::{EffectKind, ToolEffect, tool_effect};
use herdr_core::session::{
    self as core, Ask, EarlierHistory, FieldKind, ItemKind, KeeperInfo, KeeperState, ModeRisk,
    ObservedInfo, ObservedLink, PastSession, PastSessions, PlanStatus, Refusal, Role, Route,
    SessionPhase, SessionSnapshot, ToolStatus,
};
use nsh_core::prelude::*;

use super::session_acp_views::{AcpView, LocationView, PartView};

/// An agent a machine can run, for the New session form.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct AgentRoute {
    /// `omp`, `claude`, `codex`, `pi`: pass to `start`.
    pub id: String,
    /// What the person reads (`Claude Code`).
    pub label: String,
}

impl From<Route> for AgentRoute {
    fn from(r: Route) -> Self {
        Self {
            id: r.id,
            label: r.label,
        }
    }
}

/// Where a keeper is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum KeeperStateName {
    /// Its agent has not answered `initialize` yet.
    Starting,
    /// Running.
    Running,
    /// Its agent has exited (`exitReason` says why); `Continue` reopens its conversation in a new one.
    Exited,
}

impl From<KeeperState> for KeeperStateName {
    fn from(s: KeeperState) -> Self {
        match s {
            KeeperState::Starting => Self::Starting,
            KeeperState::Running => Self::Running,
            KeeperState::Exited => Self::Exited,
        }
    }
}

/// A session a machine's keeper holds.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct SessionInfo {
    /// The keeper's id: names the session everywhere (`attach`, `kill`).
    pub id: String,
    /// The agent's route id.
    pub agent: String,
    /// The folder it runs in on the machine.
    pub cwd: String,
    /// Where the keeper is in its life.
    pub state: KeeperStateName,
    /// The agent's title for the session.
    #[prop(skip_none)]
    pub title: Option<String>,
    /// Requests of the agent waiting for an answer.
    pub pending: u32,
    /// The agent is working on a turn.
    pub turn_active: bool,
    /// The agent's own id for the conversation; `resume` needs it.
    #[prop(skip_none)]
    pub session_id: Option<String>,
    /// Why the agent exited, once it has.
    #[prop(skip_none)]
    pub exit_reason: Option<String>,
    /// This app is connected to it now (`view` and `items` work).
    pub attached: bool,
    /// This app started it, so it may end it (`kill`); a session started elsewhere is not its to end.
    pub owned: bool,
}

impl SessionInfo {
    pub(super) fn new(k: KeeperInfo, attached: bool, owned: bool) -> Self {
        Self {
            id: k.id,
            agent: k.agent,
            cwd: k.cwd,
            state: k.state.into(),
            title: k.title,
            pending: k.pending,
            turn_active: k.turn_active,
            session_id: k.session_id,
            exit_reason: k.exit_reason,
            attached,
            owned,
        }
    }
}

/// A session an agent kept in its own store.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PastSessionView {
    /// The agent's id for it: pass to `resume`.
    pub session_id: String,
    /// The folder it ran in.
    pub cwd: String,
    /// The agent's title for it.
    #[prop(skip_none)]
    pub title: Option<String>,
    /// When it last changed, as the agent says (ISO 8601).
    #[prop(skip_none)]
    pub updated_at: Option<String>,
    /// Messages in it, where the agent reports it.
    #[prop(skip_none)]
    pub message_count: Option<u32>,
}

impl From<PastSession> for PastSessionView {
    fn from(p: PastSession) -> Self {
        Self {
            session_id: p.session_id,
            cwd: p.cwd,
            title: p.title,
            updated_at: p.updated_at,
            message_count: p.message_count,
        }
    }
}

/// What one agent remembers.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PastSessionsView {
    /// The agent's route id.
    pub agent: String,
    /// Newest first.
    pub sessions: Vec<PastSessionView>,
    /// The agent can list its sessions at all; false means `sessions` is empty because it cannot say.
    pub can_list: bool,
    /// The agent can replay a session into a new process (`resume` works).
    pub can_load: bool,
    /// The agent can reopen a session without replaying it.
    pub can_resume: bool,
    /// There are more than were returned.
    pub more: bool,
}

impl From<PastSessions> for PastSessionsView {
    fn from(p: PastSessions) -> Self {
        Self {
            agent: p.agent,
            sessions: p.sessions.into_iter().map(Into::into).collect(),
            can_list: p.can_list,
            can_load: p.can_load,
            can_resume: p.can_resume,
            more: p.more,
        }
    }
}

/// What `start`, `resume` and `attach` give back: the session is attached; pull it with `view`.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct SessionRef {
    /// The machine's id.
    pub machine: String,
    /// The session's id.
    pub id: String,
}

/// What `start` takes.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct StartSession {
    /// An agent id from `probe`.
    pub agent: String,
    /// A folder on the machine; `~` and `~/x` expand there.
    pub cwd: String,
}

/// What `resume` takes: a past session, from `history`.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct ResumeSession {
    /// The agent that holds the conversation.
    pub agent: String,
    /// The folder it ran in.
    pub cwd: String,
    /// The agent's id for the conversation (`PastSessionView.sessionId`, or `SessionInfo.sessionId` of an
    /// ended session).
    pub session_id: String,
}

/// Where a session stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum PhaseName {
    /// Not open yet: starting, or replaying history.
    Connecting,
    /// Open and waiting for the person.
    Idle,
    /// The agent is working on a turn.
    Working,
    /// Waiting for a yes or no on something the agent wants to run.
    BlockedOnPermission,
    /// Waiting for answers to a question.
    BlockedOnQuestion,
    /// The agent wants the person signed in before it opens a session: `acp.auth` lists the ways;
    /// `Sessions.authenticate` takes one, `Sessions.reopen` tries again after a sign-in done in a terminal.
    AuthRequired,
    /// Over; `endedReason` says why. A lost connection ends the session here (`connectionLost`):
    /// `attach` again.
    Ended,
}

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum RoleName {
    /// The person.
    User,
    /// The agent's answer (markdown).
    Agent,
    /// The agent's reasoning (shown collapsed).
    Thought,
}

/// How far a tool call has got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ToolStatusName {
    /// Announced, not started.
    Pending,
    /// Running.
    InProgress,
    /// Finished well.
    Completed,
    /// Failed, or never reported a result.
    Failed,
}

/// What a transcript item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ItemType {
    /// A message (`role`, `text`).
    Message,
    /// A tool call (`tool`).
    Tool,
    /// A line from the app about the session (`text`).
    Note,
    /// The end of a turn (`text`, `ok`).
    Done,
    /// A live notice from the agent (`severity`, `title`, `text`): not part of the conversation.
    Notice,
}

/// One edit a tool call made.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct DiffItem {
    /// The file.
    pub path: String,
    /// The text before; absent for a new file.
    #[prop(skip_none)]
    pub old: Option<String>,
    /// The text after.
    pub new: String,
    /// Lines added.
    pub added: usize,
    /// Lines removed.
    pub removed: usize,
}

/// What a finished command did outside this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum EffectKindName {
    /// `git push`.
    Push,
    /// Files or remote data removed.
    Delete,
    /// A package installed.
    Install,
    /// Released or merged where other people see it.
    Publish,
    /// Somebody else's machines or cloud changed.
    Infra,
    /// Anything else that left the machine.
    Other,
}

/// The consequence of a finished command, worth showing even when the call is folded.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct EffectItem {
    /// The class.
    pub kind: EffectKindName,
    /// One line built from the command, never an invented detail (`Pushed to origin/main`).
    pub text: String,
}

/// A tool call: what the agent ran and what came of it.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct ToolItem {
    /// The agent's id for the call.
    pub id: String,
    /// What the agent calls it.
    pub title: String,
    /// `execute`, `edit`, `read`, `fetch`... when the agent says.
    #[prop(skip_none)]
    pub tool_kind: Option<String>,
    /// Where it stands.
    pub status: ToolStatusName,
    /// The command or path, whole.
    #[prop(skip_none)]
    pub subject: Option<String>,
    /// The first lines of the output.
    pub head: Vec<String>,
    /// The last lines of the output.
    pub tail: Vec<String>,
    /// Lines between `head` and `tail` that are not kept.
    pub omitted: usize,
    /// The edits it made.
    pub diffs: Vec<DiffItem>,
    /// The agent's programmatic name for the tool (`Bash`), when it gives one.
    #[prop(skip_none)]
    pub name: Option<String>,
    /// What the agent sent the tool, as text (a string as it is, anything else as indented JSON), cut at
    /// 4 KiB.
    #[prop(skip_none)]
    pub input: Option<String>,
    /// The files it touches.
    pub locations: Vec<LocationView>,
    /// Pictures and files among its output.
    pub parts: Vec<PartView>,
    /// The agent ran it in a terminal: `head`/`tail` are the terminal's output.
    pub terminal: bool,
    /// Where the command ran, when the agent says.
    #[prop(skip_none)]
    pub cwd: Option<String>,
    /// The exit code of the command, when it ended and the agent says.
    #[prop(skip_none)]
    pub exit_code: Option<i64>,
    /// The signal that ended the command, when one did.
    #[prop(skip_none)]
    pub exit_signal: Option<String>,
    /// What a completed command did outside this machine; absent for reads, local work, failed or unfinished calls.
    #[prop(skip_none)]
    pub effect: Option<EffectItem>,
}

impl From<ToolEffect> for EffectItem {
    fn from(e: ToolEffect) -> Self {
        Self {
            kind: match e.kind {
                EffectKind::Push => EffectKindName::Push,
                EffectKind::Delete => EffectKindName::Delete,
                EffectKind::Install => EffectKindName::Install,
                EffectKind::Publish => EffectKindName::Publish,
                EffectKind::Infra => EffectKindName::Infra,
                EffectKind::Other => EffectKindName::Other,
            },
            text: e.text,
        }
    }
}

/// One row of the conversation.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct SessionItem {
    /// Stable for the life of the session: the row's key.
    pub id: u64,
    /// Changes whenever the row's content does: a row that cached it re-reads then.
    pub rev: u64,
    /// What it is.
    pub kind: ItemType,
    /// For a message: who wrote it.
    #[prop(skip_none)]
    pub role: Option<RoleName>,
    /// For a message, a note or the end of a turn: the text (markdown for the agent).
    #[prop(skip_none)]
    pub text: Option<String>,
    /// For the end of a turn: it did not end on a failed tool call.
    #[prop(skip_none)]
    pub ok: Option<bool>,
    /// For a tool call.
    #[prop(skip_none)]
    pub tool: Option<ToolItem>,
    /// For a message of a chat read from a terminal's log: its pictures, fetched with `logPicture` when the
    /// person asks (the log does not carry their bytes).
    pub images: Vec<ImageView>,
    /// When the row began, in milliseconds since the session was attached; absent for what the history
    /// replay brought. Same clock as `AcpView.turnStartedMs`.
    #[prop(skip_none)]
    pub started_ms: Option<u64>,
    /// When it was done (a tool call finished, or the next row followed a message or a thought).
    #[prop(skip_none)]
    pub ended_ms: Option<u64>,
    /// For a message: the pictures, sounds and files it carries besides its text (the text keeps an
    /// `@name` line for every file). Empty for rows of an observed session.
    pub parts: Vec<PartView>,
    /// For a notice: `info`, `warning`, `error`, or the agent's own.
    #[prop(skip_none)]
    pub severity: Option<String>,
    /// For a notice: its title (`text` is the detail).
    #[prop(skip_none)]
    pub title: Option<String>,
}

/// A picture in a message of an observed session.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct ImageView {
    /// What it is cached under: its content, never where it was seen.
    pub key: String,
    /// `image/png`...
    pub mime: String,
    /// Size when the log says it.
    #[prop(skip_none)]
    pub bytes: Option<u64>,
    /// Pass to `logPicture`.
    pub source: String,
}

impl From<&core::Item> for SessionItem {
    fn from(item: &core::Item) -> Self {
        let mut out = Self {
            id: item.id,
            rev: item.rev,
            kind: ItemType::Note,
            role: None,
            text: None,
            ok: None,
            tool: None,
            images: Vec::new(),
            started_ms: item.started_ms,
            ended_ms: item.ended_ms,
            parts: Vec::new(),
            severity: None,
            title: None,
        };
        match &item.kind {
            ItemKind::Message {
                role,
                text,
                images,
                parts,
                ..
            } => {
                out.images = images
                    .iter()
                    .map(|i| ImageView {
                        key: i.key.clone(),
                        mime: i.mime.clone(),
                        bytes: i.bytes,
                        source: i.source.clone(),
                    })
                    .collect();
                out.kind = ItemType::Message;
                out.role = Some(match role {
                    Role::User => RoleName::User,
                    Role::Agent => RoleName::Agent,
                    Role::Thought => RoleName::Thought,
                });
                out.text = Some(text.clone());
                out.parts = parts.iter().map(Into::into).collect();
            }
            ItemKind::Tool(t) => {
                out.kind = ItemType::Tool;
                out.tool = Some(ToolItem {
                    id: t.id.clone(),
                    title: t.title.clone(),
                    tool_kind: t.kind.clone(),
                    status: match t.status {
                        ToolStatus::Pending => ToolStatusName::Pending,
                        ToolStatus::InProgress => ToolStatusName::InProgress,
                        ToolStatus::Completed => ToolStatusName::Completed,
                        ToolStatus::Failed => ToolStatusName::Failed,
                    },
                    subject: t.subject.clone(),
                    head: t.head.clone(),
                    tail: t.tail.clone(),
                    omitted: t.omitted,
                    diffs: t
                        .diffs
                        .iter()
                        .map(|d| DiffItem {
                            path: d.path.clone(),
                            old: d.old.clone(),
                            new: d.new.clone(),
                            added: d.added,
                            removed: d.removed,
                        })
                        .collect(),
                    name: t.name.clone(),
                    input: t.input.clone(),
                    locations: t.locations.iter().map(Into::into).collect(),
                    parts: t.parts.iter().map(Into::into).collect(),
                    terminal: t.terminal,
                    cwd: t.cwd.clone(),
                    exit_code: t.exit_code,
                    exit_signal: t.exit_signal.clone(),
                    effect: match t.status {
                        // A push that failed or has not finished did not push.
                        ToolStatus::Completed => {
                            tool_effect(t.kind.as_deref(), t.subject.as_deref()).map(Into::into)
                        }
                        _ => None,
                    },
                });
            }
            ItemKind::Note(text) => out.text = Some(text.clone()),
            ItemKind::Notice {
                severity,
                title,
                text,
            } => {
                out.kind = ItemType::Notice;
                out.severity = Some(severity.clone());
                out.title = Some(title.clone());
                out.text.clone_from(text);
            }
            ItemKind::Done { text, ok } => {
                out.kind = ItemType::Done;
                out.text = Some(text.clone());
                out.ok = Some(*ok);
            }
        }
        out
    }
}

/// One answer a permission request offers.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PermissionChoiceView {
    /// Pass to `answerPermission`.
    pub id: String,
    /// The label, exactly as the agent words it.
    pub name: String,
    /// `allow_once`, `allow_always`, `reject_once`, `reject_always` when the agent says.
    #[prop(skip_none)]
    pub kind: Option<String>,
    /// A grant that outlives this call: needs a second, deliberate activation.
    pub standing: bool,
}

/// One value of a choice field.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct FieldChoiceView {
    /// What is sent.
    pub value: String,
    /// What the person reads.
    pub title: String,
}

/// What kind of value a question's field takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum FieldKindName {
    /// Free text.
    Text,
    /// A number.
    Number,
    /// One of `choices`.
    Choice,
    /// Any of `choices`.
    Multi,
    /// Yes or no.
    Bool,
    /// A kind this app cannot show; it is left out of the answer.
    Unsupported,
}

/// One field of an agent's question.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct QuestionFieldView {
    /// The key in the answer.
    pub name: String,
    /// What the person reads.
    pub label: String,
    /// Help text from the agent.
    #[prop(skip_none)]
    pub description: Option<String>,
    /// The answer may not be empty.
    pub required: bool,
    /// The agent says the answer is secret. Shown like any other: a form is not a safe place for a secret.
    pub secret: bool,
    /// What it takes.
    pub kind: FieldKindName,
    /// For `number`: whole numbers only.
    pub integer: bool,
    /// The choices of a `choice` or `multi` field.
    pub choices: Vec<FieldChoiceView>,
    /// The text to start from (`text` and `number`).
    pub text: String,
    /// The index to start from (`choice`; for `bool` 0 is yes and 1 is no).
    #[prop(skip_none)]
    pub choice: Option<usize>,
    /// The indexes to start ticked (`multi`).
    pub ticked: Vec<usize>,
}

/// What the person answers to one field; `answerQuestion` takes one per field, in order. What is left
/// out keeps the agent's default.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct FieldAnswerInput {
    /// For `text` and `number`.
    #[prop(skip_none)]
    pub text: Option<String>,
    /// For `choice` (the index) and `bool` (0 is yes, 1 is no).
    #[prop(skip_none)]
    pub choice: Option<usize>,
    /// For `multi`: the indexes ticked.
    #[prop(skip_none)]
    pub ticked: Option<Vec<usize>>,
}

impl From<FieldAnswerInput> for core::FieldAnswer {
    fn from(a: FieldAnswerInput) -> Self {
        Self {
            text: a.text,
            choice: a.choice,
            ticked: a.ticked,
        }
    }
}

/// Whether a request is a permission or a question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum AskKind {
    /// May the agent run this? Answer with `answerPermission`.
    Permission,
    /// The agent wants answers. Answer with `answerQuestion`.
    Question,
}

/// A request from the agent that waits for the person. Only the first of `waiting` can be answered. Pass
/// `requestId` and `digest` back with the answer: if the request changed under the person's eyes, nothing
/// is sent. Nothing ever answers a request but the person (no timer, no default).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct WaitingView {
    /// Names the request.
    pub request_id: String,
    /// Fingerprint of what was shown (the command and the options, or the question).
    pub digest: String,
    /// Which it is.
    pub ask: AskKind,
    /// Milliseconds since the session opened when it appeared. An answer within 400 ms of it is refused
    /// (`tooSoon`): that key was meant for what was on screen before.
    pub arrived_ms: u64,
    /// For a permission: what the agent calls the call.
    #[prop(skip_none)]
    pub title: Option<String>,
    /// For a permission: `execute`, `edit`... when the agent says.
    #[prop(skip_none)]
    pub tool_kind: Option<String>,
    /// For a permission: the command or path, whole. Show all of it: the person sees what they approve.
    #[prop(skip_none)]
    pub subject: Option<String>,
    /// For a permission: why this command deserves a second look (`pushes to a remote`). Allowing it is
    /// two steps (press, then press again within 4 s).
    #[prop(skip_none)]
    pub risk: Option<String>,
    /// For a permission: the answers, in the agent's order.
    pub choices: Vec<PermissionChoiceView>,
    /// For a question: what the agent asks.
    #[prop(skip_none)]
    pub message: Option<String>,
    /// For a question: the schema's own description.
    #[prop(skip_none)]
    pub description: Option<String>,
    /// For a question: the fields.
    pub fields: Vec<QuestionFieldView>,
}

impl From<&core::Waiting> for WaitingView {
    fn from(w: &core::Waiting) -> Self {
        let mut out = Self {
            request_id: w.request_id.clone(),
            digest: w.digest.clone(),
            ask: AskKind::Permission,
            arrived_ms: w.arrived_ms,
            title: None,
            tool_kind: None,
            subject: None,
            risk: None,
            choices: Vec::new(),
            message: None,
            description: None,
            fields: Vec::new(),
        };
        match &w.ask {
            Ask::Permission(p) => {
                out.title = Some(p.title.clone());
                out.tool_kind = p.kind.clone();
                out.subject = p.subject.clone();
                out.risk = p.risk.clone();
                out.choices = p
                    .choices
                    .iter()
                    .map(|c| PermissionChoiceView {
                        id: c.id.clone(),
                        name: c.name.clone(),
                        kind: c.kind.clone(),
                        standing: c.standing,
                    })
                    .collect();
            }
            Ask::Question(q) => {
                out.ask = AskKind::Question;
                out.message = Some(q.message.clone());
                out.description = q.description.clone();
                out.fields = q
                    .fields
                    .iter()
                    .map(|f| QuestionFieldView {
                        name: f.name.clone(),
                        label: f.label.clone(),
                        description: f.description.clone(),
                        required: f.required,
                        secret: f.secret,
                        kind: match f.kind {
                            FieldKind::Text => FieldKindName::Text,
                            FieldKind::Number => FieldKindName::Number,
                            FieldKind::Choice => FieldKindName::Choice,
                            FieldKind::Multi => FieldKindName::Multi,
                            FieldKind::Bool => FieldKindName::Bool,
                            FieldKind::Unsupported => FieldKindName::Unsupported,
                        },
                        integer: f.integer,
                        choices: f
                            .choices
                            .iter()
                            .map(|c| FieldChoiceView {
                                value: c.value.clone(),
                                title: c.title.clone(),
                            })
                            .collect(),
                        text: f.text.clone(),
                        choice: f.choice,
                        ticked: f.ticked.clone(),
                    })
                    .collect();
            }
        }
        out
    }
}

/// A message that waits for the turn to end.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct QueuedView {
    /// Pass to `unqueue`.
    pub id: u32,
    /// What will be sent.
    pub text: String,
    /// Files that go with it (paths on the agent's machine).
    pub files: Vec<String>,
    /// Pictures of this computer that go with it.
    pub pictures: Vec<PictureInput>,
    /// Why it will not go by itself (`the turn failed`); `releaseQueue` lets it go.
    #[prop(skip_none)]
    pub held: Option<String>,
}

/// A slash command the agent offers.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct CommandView {
    /// The word after the slash.
    pub name: String,
    /// What it does.
    pub description: String,
    /// What follows it (`<file>`), when the agent says.
    #[prop(skip_none)]
    pub hint: Option<String>,
}

/// How much a session mode lowers the guard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ModeRiskName {
    /// The agent asks as the person expects.
    None,
    /// Part of the asking is switched off.
    Elevated,
    /// Nothing is asked. Choosing it takes a deliberate second step.
    Dangerous,
}

/// One value a session setting can take.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct OptionChoiceView {
    /// Pass to `setOption`.
    pub value: String,
    /// What the person reads.
    pub name: String,
    /// For a mode: how far it goes.
    pub risk: ModeRiskName,
}

/// One setting of the session: the model, the mode, the thinking level.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct OptionView {
    /// Pass to `setOption`.
    pub id: String,
    /// What the person reads (`Model`).
    pub name: String,
    /// `mode`, `model`, `thought_level` when the agent says.
    #[prop(skip_none)]
    pub category: Option<String>,
    /// The value now.
    #[prop(skip_none)]
    pub current: Option<String>,
    /// What it can be changed to (while no turn runs).
    pub choices: Vec<OptionChoiceView>,
    /// An on/off switch: `current` is `"true"` or `"false"` and `choices` are `On` and `Off`; render a
    /// switch and pass `"true"` or `"false"` to `setOption`.
    pub boolean: bool,
    /// What the agent says the setting is for.
    #[prop(skip_none)]
    pub description: Option<String>,
}

/// How a plan step stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum PlanStatusName {
    /// Not started.
    Pending,
    /// Being done.
    InProgress,
    /// Done.
    Completed,
}

/// One step of the agent's plan.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PlanStepView {
    /// What the step is.
    pub content: String,
    /// Where it stands.
    pub status: PlanStatusName,
}

/// A message the agent refused, to put back in the composer.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct UnsentView {
    /// Increases each time: put it back once per `seq`.
    pub seq: u32,
    /// The text.
    pub text: String,
    /// Its files.
    pub files: Vec<String>,
    /// Its pictures, as they were sent.
    pub pictures: Vec<PictureInput>,
}

/// A session as it stands: everything but the rows of the conversation, which are pulled in windows with
/// `items`. Cheap to pull after every `Herdr.onChange`; `revision` says whether anything changed.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct SessionView {
    /// Increases with every change of this session.
    pub revision: u64,
    /// Where it stands.
    pub phase: PhaseName,
    /// When `phase` is `ended`: why, in words.
    #[prop(skip_none)]
    pub ended_reason: Option<String>,
    /// The connection to the machine closed but the agent did not exit: `attach` again to carry on.
    pub connection_lost: bool,
    /// The agent's route id.
    pub agent: String,
    /// The folder it runs in.
    pub cwd: String,
    /// The agent's title for the session.
    #[prop(skip_none)]
    pub title: Option<String>,
    /// Rows in the conversation: the length of what `items` and `itemIds` cover.
    pub item_count: usize,
    /// Rows dropped from the start to keep the conversation small; the machine still has them.
    pub dropped_items: usize,
    /// Said at the top when the machine no longer keeps the oldest turns of the replay.
    #[prop(skip_none)]
    pub earlier_notice: Option<String>,
    /// Requests waiting for the person, oldest first. Only the first can be answered.
    pub waiting: Vec<WaitingView>,
    /// Messages waiting for the turn to end.
    pub queue: Vec<QueuedView>,
    /// Slash commands the agent offers.
    pub commands: Vec<CommandView>,
    /// The session's settings.
    pub options: Vec<OptionView>,
    /// The agent's plan.
    pub plan: Vec<PlanStepView>,
    /// The current mode, by name.
    #[prop(skip_none)]
    pub mode: Option<String>,
    /// Percent of the context window used.
    #[prop(skip_none)]
    pub context_percent: Option<u32>,
    /// A turn is running (show Stop).
    pub running: bool,
    /// The agent takes pictures in a prompt.
    pub accepts_pictures: bool,
    /// A message the agent refused, to put back in the composer.
    #[prop(skip_none)]
    pub unsent: Option<UnsentView>,
    /// Set when this is the chat of an agent in a terminal pane rather than a keeper's session.
    #[prop(skip_none)]
    pub observed: Option<ObservedView>,
    /// What ACP says besides the rows: what the agent can do, how to sign in, usage and cost.
    pub acp: AcpView,
}

/// How reading an observed session's log goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum LinkName {
    /// Looking for the log, or waiting for the agent to write it (`linkText` says which): an empty chat.
    Locating,
    /// Reading the log, and what the agent appends.
    Following,
    /// The log cannot be read (`linkText` says why and what to do).
    Failed,
    /// The pane is gone or its agent left (`linkText` says which).
    Ended,
}

/// Whether an observed chat shows the whole of its log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum EarlierName {
    /// What is shown starts at the log's start: nothing to load.
    None,
    /// Older turns can be read: call `loadEarlier`.
    Available,
    /// Older turns are being read; the rows shown stay until all of them are there.
    Loading,
    /// The widest read (64 MB) is shown and the log is longer still.
    TooLong,
}

/// A subagent an observed agent started, as its log last described it.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct SubagentRow {
    /// Its name.
    pub name: String,
    /// Its agent type; empty when the log did not say.
    pub agent: String,
    /// `pending`, `running`, `completed`, `failed`, `aborted`...
    pub status: String,
    /// What it was asked to do.
    pub assignment: String,
    /// Tool calls it made.
    pub tool_count: usize,
    /// Names of its latest tool calls, oldest first.
    pub recent_tools: Vec<String>,
}

/// Something an observed agent runs in the background, as its log says.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct BackgroundRow {
    /// Unique within the session.
    pub key: String,
    /// `shell`, `terminal`, `eval`, `workflow`, `monitor`, `agent`, `other`.
    pub kind: String,
    /// `running`, `paused`, `finished`, `failed`, `stopped`.
    pub status: String,
    /// The command or the name.
    pub title: String,
    /// The full command, the folder or a summary.
    #[prop(skip_none)]
    pub detail: Option<String>,
    /// Still alive.
    pub active: bool,
}

/// What an observed session adds: the pane it comes from and what its log says that a keeper's session does not.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct ObservedView {
    /// The pane the agent runs in: its terminal. Tool approvals are the terminal's own prompts; answer them
    /// through the pane (`Herdr.answer`), and use `Herdr.sendKeys` for anything the chat cannot do.
    pub pane_id: String,
    /// herdr's agent label: `omp`, `claude`, `codex`.
    pub kind: String,
    /// What the person reads: `omp`, `Claude Code`, `Codex`.
    pub label: String,
    /// The log being read.
    #[prop(skip_none)]
    pub log_path: Option<String>,
    /// How reading it goes.
    pub link: LinkName,
    /// Words for `link` when it is not `following`.
    #[prop(skip_none)]
    pub link_text: Option<String>,
    /// The log's last turn is over.
    pub turn_ended: bool,
    /// Subagents the log names.
    pub subagents: Vec<SubagentRow>,
    /// Background tasks the log names.
    pub background: Vec<BackgroundRow>,
    /// A plan's title waiting for the person's decision in the terminal.
    #[prop(skip_none)]
    pub proposed_plan_title: Option<String>,
    /// The plan as the agent wrote it, when the log holds it.
    #[prop(skip_none)]
    pub proposed_plan: Option<String>,
    /// Whether the log holds turns that are not shown, and whether they can be loaded (`loadEarlier`).
    pub earlier: EarlierName,
    /// What last went wrong (a message the terminal did not take); it clears itself after a while.
    #[prop(skip_none)]
    pub problem: Option<String>,
    /// This agent's questions are answered here (`answerQuestion`); otherwise in the terminal.
    pub answers_questions: bool,
}

impl From<&ObservedInfo> for ObservedView {
    fn from(o: &ObservedInfo) -> Self {
        let (link, link_text) = match &o.link {
            ObservedLink::Locating(t) => (LinkName::Locating, Some(t.clone())),
            ObservedLink::Following => (LinkName::Following, None),
            ObservedLink::Failed(t) => (LinkName::Failed, Some(t.clone())),
            ObservedLink::Ended(t) => (LinkName::Ended, Some(t.clone())),
        };
        Self {
            pane_id: o.pane_id.clone(),
            kind: o.kind.clone(),
            label: o.label.clone(),
            log_path: o.log_path.clone(),
            link,
            link_text,
            turn_ended: o.turn_ended,
            subagents: o
                .subagents
                .iter()
                .map(|s| SubagentRow {
                    name: s.name.clone(),
                    agent: s.agent.clone(),
                    status: s.status.clone(),
                    assignment: s.assignment.clone(),
                    tool_count: s.tool_count,
                    recent_tools: s.recent_tools.clone(),
                })
                .collect(),
            background: o
                .background
                .iter()
                .map(|b| BackgroundRow {
                    key: b.key.clone(),
                    kind: b.kind.clone(),
                    status: b.status.clone(),
                    title: b.title.clone(),
                    detail: b.detail.clone(),
                    active: b.active,
                })
                .collect(),
            proposed_plan_title: o.proposed_plan.as_ref().map(|p| p.title.clone()),
            proposed_plan: o.proposed_plan.as_ref().and_then(|p| p.markdown.clone()),
            earlier: match o.earlier {
                EarlierHistory::None => EarlierName::None,
                EarlierHistory::Available => EarlierName::Available,
                EarlierHistory::Loading => EarlierName::Loading,
                EarlierHistory::TooLong => EarlierName::TooLong,
            },
            problem: o.problem.clone(),
            answers_questions: o.answers_questions,
        }
    }
}

impl From<&SessionSnapshot> for SessionView {
    fn from(s: &SessionSnapshot) -> Self {
        let (phase, ended_reason) = match &s.phase {
            SessionPhase::Connecting => (PhaseName::Connecting, None),
            SessionPhase::Idle => (PhaseName::Idle, None),
            SessionPhase::Working => (PhaseName::Working, None),
            SessionPhase::BlockedOnPermission => (PhaseName::BlockedOnPermission, None),
            SessionPhase::BlockedOnQuestion => (PhaseName::BlockedOnQuestion, None),
            SessionPhase::AuthRequired => (PhaseName::AuthRequired, None),
            SessionPhase::Ended(why) => (PhaseName::Ended, Some(why.clone())),
        };
        Self {
            revision: s.revision,
            phase,
            ended_reason,
            connection_lost: s.connection_lost,
            agent: s.agent.clone(),
            cwd: s.cwd.clone(),
            title: s.title.clone(),
            item_count: s.items.len(),
            dropped_items: s.dropped_items,
            earlier_notice: s.earlier_notice.clone(),
            waiting: s.waiting.iter().map(Into::into).collect(),
            queue: s
                .queue
                .iter()
                .map(|q| QueuedView {
                    id: u32::try_from(q.id).unwrap_or(u32::MAX),
                    text: q.text.clone(),
                    files: q.files.clone(),
                    pictures: q.pictures.iter().map(PictureInput::from).collect(),
                    held: q.held.clone(),
                })
                .collect(),
            commands: s
                .commands
                .iter()
                .map(|c| CommandView {
                    name: c.name.clone(),
                    description: c.description.clone(),
                    hint: c.hint.clone(),
                })
                .collect(),
            options: s
                .options
                .iter()
                .map(|o| OptionView {
                    id: o.id.clone(),
                    name: o.name.clone(),
                    category: o.category.clone(),
                    current: o.current.clone(),
                    boolean: o.boolean,
                    description: o.description.clone(),
                    choices: o
                        .choices
                        .iter()
                        .map(|c| OptionChoiceView {
                            value: c.value.clone(),
                            name: c.name.clone(),
                            risk: match c.risk {
                                ModeRisk::None => ModeRiskName::None,
                                ModeRisk::Elevated => ModeRiskName::Elevated,
                                ModeRisk::Dangerous => ModeRiskName::Dangerous,
                            },
                        })
                        .collect(),
                })
                .collect(),
            plan: s
                .plan
                .iter()
                .map(|p| PlanStepView {
                    content: p.content.clone(),
                    status: match p.status {
                        PlanStatus::Pending => PlanStatusName::Pending,
                        PlanStatus::InProgress => PlanStatusName::InProgress,
                        PlanStatus::Completed => PlanStatusName::Completed,
                    },
                })
                .collect(),
            mode: s.mode.clone(),
            context_percent: s.context_percent.map(u32::from),
            running: s.running,
            accepts_pictures: s.accepts_pictures,
            unsent: s.unsent.as_ref().map(|u| UnsentView {
                seq: u32::try_from(u.seq).unwrap_or(u32::MAX),
                text: u.text.clone(),
                files: u.files.clone(),
                pictures: u.pictures.iter().map(PictureInput::from).collect(),
            }),
            observed: s.observed.as_ref().map(ObservedView::from),
            acp: (&s.acp).into(),
        }
    }
}

/// How an action ended. `done` and `queued` mean it took effect; the rest are refusals, and nothing
/// was sent to the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ActionKind {
    /// It went through.
    Done,
    /// A message was queued: the agent works, and it goes when the turn ends.
    Queued,
    /// The request changed, or is not the one that waits any more ("The question changed").
    Changed,
    /// Pressed within 400 ms of the request appearing: meant for something else.
    TooSoon,
    /// The request has no such answer, or the setting no such value.
    NoSuchOption,
    /// Nothing waits for an answer any more.
    NothingWaiting,
    /// The session is not open yet.
    NotReady,
    /// The agent is working (a setting changes between turns).
    Busy,
    /// The session is over.
    Ended,
    /// A field does not take that; `message` says which and why.
    Invalid,
    /// Ten messages wait already.
    QueueFull,
    /// A file to send could not be read.
    CannotRead,
    /// The session's connection is gone: `attach` again.
    Stopped,
    /// Not possible from here now (the terminal needs the person, a question waits first, the pane did not
    /// take it): `message` says what to do.
    Blocked,
}

/// How an action on a session ended.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct ActionResult {
    /// What happened.
    pub kind: ActionKind,
    /// Words for the person; empty when `kind` is `done`.
    pub message: String,
}

impl ActionResult {
    pub(super) fn done() -> Self {
        Self {
            kind: ActionKind::Done,
            message: String::new(),
        }
    }

    pub(super) fn queued() -> Self {
        Self {
            kind: ActionKind::Queued,
            message: String::new(),
        }
    }
}

impl From<Refusal> for ActionResult {
    fn from(r: Refusal) -> Self {
        let kind = match &r {
            Refusal::Changed => ActionKind::Changed,
            Refusal::TooSoon => ActionKind::TooSoon,
            Refusal::NoSuchOption => ActionKind::NoSuchOption,
            Refusal::NothingWaiting => ActionKind::NothingWaiting,
            Refusal::NotReady => ActionKind::NotReady,
            Refusal::Busy => ActionKind::Busy,
            Refusal::Ended => ActionKind::Ended,
            Refusal::Invalid(_) => ActionKind::Invalid,
            Refusal::QueueFull(_) => ActionKind::QueueFull,
            Refusal::CannotRead(_) => ActionKind::CannotRead,
            Refusal::Stopped => ActionKind::Stopped,
            Refusal::Blocked(_) => ActionKind::Blocked,
        };
        Self {
            kind,
            message: r.to_string(),
        }
    }
}

/// A queued message taken back out to edit.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct UnqueuedView {
    /// What it said.
    pub text: String,
    /// The files that went with it.
    pub files: Vec<String>,
    /// The pictures that went with it.
    pub pictures: Vec<PictureInput>,
}

/// A picture of THIS computer a message carries: a file of `Compose.preparePicture`, with the number its
/// `[Image n]` has in the text.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PictureInput {
    /// The prepared file.
    pub path: String,
    /// What the transcript calls it.
    pub name: String,
    /// Its number in the text (`[Image 2]`).
    pub number: u32,
}

impl From<&core::Pasted> for PictureInput {
    fn from(p: &core::Pasted) -> Self {
        Self {
            path: p.path.clone(),
            name: p.name.clone(),
            number: p.number,
        }
    }
}
