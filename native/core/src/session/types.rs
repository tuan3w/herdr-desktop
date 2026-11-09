//! What a screen shows of one agent session: plain values, no dependency on the reducer's crates.
//!
//! [`SessionSnapshot`] is immutable and cheap to share (`Arc`); unchanged transcript items are the same
//! `Arc` from one snapshot to the next, so a long conversation costs a pointer copy per item, not a
//! copy of its text, on every streamed word.

use std::sync::Arc;

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The person.
    User,
    /// The agent's answer.
    Agent,
    /// The agent's reasoning (shown collapsed).
    Thought,
}

/// How far a tool call has got.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolStatus {
    /// Announced, not started.
    Pending,
    /// Running.
    InProgress,
    /// Finished well.
    Completed,
    /// Failed, or never reported a result before the turn ended.
    Failed,
}

/// One edit a tool call made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffView {
    /// The file.
    pub path: String,
    /// The text before, `None` for a new file.
    pub old: Option<String>,
    /// The text after.
    pub new: String,
    /// Lines the edit added.
    pub added: usize,
    /// Lines the edit removed.
    pub removed: usize,
}

/// A file and line a tool call touches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    /// Absolute path.
    pub path: String,
    /// 1-based, when the agent says.
    pub line: Option<u32>,
}

/// What a non-text block of a message or a tool's output is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartKind {
    /// A picture.
    Image,
    /// Sound.
    Audio,
    /// A file the message points at (`@name` in its text).
    File,
    /// A file the message includes (embedded context).
    Resource,
}

/// A picture, sound or file carried by a message or a tool's output, beside its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    /// What it is.
    pub kind: PartKind,
    /// What the person reads: the file's name, or `image` / `audio`.
    pub name: String,
    /// Where it lives (`file:///...`), when it says.
    pub uri: Option<String>,
    /// `image/png`... when it says.
    pub mime: Option<String>,
    /// Bytes, when known.
    pub size: Option<u64>,
    /// A picture's bytes as base64, only when small (at most 512 KiB of base64); a bigger one is named
    /// and sized, not carried.
    pub data: Option<String>,
}

/// Where one subagent of a `task` call stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskAgentStatus {
    /// Asked for, not running yet.
    Pending,
    Running,
    Completed,
    Failed,
    Aborted,
}

/// One subagent of an omp `task` call, as the call last reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskAgentView {
    /// omp's id for it.
    pub id: String,
    /// What the person reads: the name the launch gave it, else its id.
    pub name: String,
    /// The agent type (`task`, `reviewer`); empty when omp does not say.
    pub agent: String,
    pub status: TaskAgentStatus,
    /// What it was asked, on one line, cut at 300 characters.
    pub assignment: String,
    /// Tools it has called.
    pub tool_count: u64,
    /// How long it has run, as omp last reported.
    pub duration_ms: u64,
    /// The tool it is in now, with its subject (`read lib/auth.ts`).
    pub current_tool: Option<String>,
    /// Its last three finished tools, oldest first.
    pub recent_tools: Vec<String>,
    /// Tokens it has used, when omp says.
    pub tokens: Option<u64>,
}

/// A tool call: what the agent ran and what came of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolView {
    /// The agent's id for the call.
    pub id: String,
    /// What the agent calls it (`Run cargo test`).
    pub title: String,
    /// The agent's programmatic name for the tool (`Bash`), when it gives one.
    pub name: Option<String>,
    /// `execute`, `edit`, `read`, `fetch`, ... when the agent says.
    pub kind: Option<String>,
    /// Where it stands.
    pub status: ToolStatus,
    /// The command or path, whole.
    pub subject: Option<String>,
    /// What the agent sent the tool, as text (a string as it is, anything else as indented JSON), cut at
    /// 4 KiB.
    pub input: Option<String>,
    /// What the agent says the call is for (omp's `i`, Claude Code's `description`), one safe line.
    pub intent: Option<String>,
    /// The files it touches.
    pub locations: Vec<Location>,
    /// The first lines of its output.
    pub head: Vec<String>,
    /// The last lines of its output.
    pub tail: Vec<String>,
    /// Lines of output between `head` and `tail` that are not kept.
    pub omitted: usize,
    /// The edits it made, at most a few.
    pub diffs: Vec<DiffView>,
    /// Pictures and files among its output.
    pub parts: Vec<Part>,
    /// The agent ran it in a terminal (its output is the terminal's).
    pub terminal: bool,
    /// Where the command ran, when the agent says.
    pub cwd: Option<String>,
    /// The exit code of the command, when it ended and the agent says.
    pub exit_code: Option<i64>,
    /// The signal that ended the command, when one did.
    pub exit_signal: Option<String>,
    /// For omp's `task` call: its subagents (at most 16), empty for any other call.
    pub subagents: Vec<TaskAgentView>,
}

/// A picture in a message of an observed session. The log does not carry its bytes: fetch them when the
/// person asks, with `source`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRef {
    /// What the picture is cached under: its content, never where it was seen.
    pub key: String,
    /// `image/png`...
    pub mime: String,
    /// Size when the log says it.
    pub bytes: Option<u64>,
    /// Opaque: pass it back to fetch the bytes.
    pub source: String,
}

/// What a transcript item is.
// Items live behind an `Arc` and are built once per change; boxing the tool call would add a pointer hop to
// every row a screen reads for no saving.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemKind {
    /// A message of the person, the agent, or the agent's thinking.
    Message {
        /// Who wrote it.
        role: Role,
        /// The agent's id for it, when it gave one.
        message_id: Option<String>,
        /// Its text (markdown for the agent).
        text: String,
        /// Pictures it carries (observed sessions only).
        images: Vec<ImageRef>,
        /// Pictures, sounds and files it carries besides its text, structured: the text keeps an
        /// `@name` line for every file, as typed.
        parts: Vec<Part>,
    },
    /// A tool call.
    Tool(ToolView),
    /// A line from the app about the session (`Answered: Allow once`, `Turn ended: cancelled`).
    Note(String),
    /// A live notice from the agent (`info`, `warning` or `error`; or one of its own severities), not
    /// part of the conversation and not kept across a reattach.
    Notice {
        /// `info`, `warning`, `error`, or the agent's own.
        severity: String,
        title: String,
        /// Supporting detail.
        text: Option<String>,
    },
    /// The end of a turn, said once: how long it took and what it changed.
    Done {
        /// `Done in 41s · 1 file +6 −2 · 4 tools`.
        text: String,
        /// The turn did not end on a failed tool call.
        ok: bool,
    },
}

/// A transcript item with a stable id (a cache key) and a revision (bumped when its text or status changes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// Never reused within a session.
    pub id: u64,
    /// Changes whenever the item does.
    pub rev: u64,
    /// When the item began, in milliseconds since the session was attached; `None` for what the
    /// history replay brought.
    pub started_ms: Option<u64>,
    /// When it was done (a tool call finished, a message or a thought was followed by the next
    /// item), same clock.
    pub ended_ms: Option<u64>,
    /// What it is.
    pub kind: ItemKind,
}

/// How a plan step stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanStatus {
    /// Not started.
    Pending,
    /// Being done.
    InProgress,
    /// Done.
    Completed,
}

/// One step of the agent's plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanStep {
    /// What the step is.
    pub content: String,
    /// Where it stands.
    pub status: PlanStatus,
}

/// A slash command the agent offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashCommand {
    /// The word after the slash.
    pub name: String,
    /// What it does.
    pub description: String,
    /// What follows it (`<file>`), when the agent says.
    pub hint: Option<String>,
    /// The agent's own command or a skill.
    pub kind: CommandKind,
}

/// What a slash command is, where the agent says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    /// Built into the agent (`/clear`, `/compact`). Also every command of an ACP session: ACP's
    /// `available_commands_update` does not tell a skill from a built-in.
    Command,
    /// A skill or a custom command the person or a plugin added (Claude's `skill_listing`).
    Skill,
}

/// How much a session mode lowers the guard between the agent and the machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeRisk {
    /// The agent asks as the person expects.
    None,
    /// Part of the asking is switched off.
    Elevated,
    /// Nothing is asked.
    Dangerous,
}

/// One value a session option can take.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptionChoice {
    /// What is sent.
    pub value: String,
    /// What the person reads.
    pub name: String,
    /// For a mode: how far it goes. Choosing a risky mode takes a deliberate second step.
    pub risk: ModeRisk,
}

/// One setting of the session (the model, the mode, the thinking level).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionOption {
    /// The id to change it by.
    pub id: String,
    /// What the person reads (`Model`).
    pub name: String,
    /// `mode`, `model`, `thought_level` when the agent says.
    pub category: Option<String>,
    /// The value now.
    pub current: Option<String>,
    /// What it can be changed to.
    pub choices: Vec<OptionChoice>,
    /// An on/off switch: `current` is `"true"` or `"false"` and `choices` are `On` and `Off`.
    pub boolean: bool,
    /// What the agent says the option is for.
    pub description: Option<String>,
}

/// A message that waits for the turn to end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedMessage {
    /// Names it for `unqueue`.
    pub id: u64,
    /// What will be sent.
    pub text: String,
    /// The files that go with it (paths on the agent's machine).
    pub files: Vec<String>,
    /// The pictures of this computer that go with it.
    pub pictures: Vec<super::outgoing::Pasted>,
    /// Why it will not go by itself, when it will not (`the turn failed`).
    pub held: Option<String>,
}

/// One answer a permission request offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionChoice {
    /// What is sent back.
    pub id: String,
    /// The label to show, exactly (`Yes, and don't ask again`).
    pub name: String,
    /// `allow_once`, `allow_always`, `reject_once`, `reject_always` when the agent says.
    pub kind: Option<String>,
    /// A grant that outlives this call: the person must mean it.
    pub standing: bool,
}

/// The agent asks to run something.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionView {
    /// What the agent calls the call.
    pub title: String,
    /// `execute`, `edit`, ... when the agent says.
    pub kind: Option<String>,
    /// The command or path, whole: the person sees what they approve.
    pub subject: Option<String>,
    /// Why this command deserves a second look (`pushes to a remote`), when the same rules the terminal
    /// prompts use find a reason. Allowing it is two steps.
    pub risk: Option<String>,
    /// The answers, in the agent's order.
    pub choices: Vec<PermissionChoice>,
}

/// What kind of value a question's field takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    /// Free text.
    Text,
    /// A number (or a whole number when `integer`).
    Number,
    /// One of several choices.
    Choice,
    /// Any number of several choices.
    Multi,
    /// Yes or no.
    Bool,
    /// A kind this app cannot show; it is left out of the answer.
    Unsupported,
}

/// One value of a choice field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldChoice {
    /// What is sent.
    pub value: String,
    /// What the person reads.
    pub title: String,
}

/// One field of an agent's question.
#[derive(Debug, Clone, PartialEq)]
pub struct QuestionField {
    /// The key in the answer.
    pub name: String,
    /// What the person reads.
    pub label: String,
    /// Help text from the agent.
    pub description: Option<String>,
    /// The answer may not be empty.
    pub required: bool,
    /// The agent says the answer is secret. It is shown like any other: a form is not a safe place for one.
    pub secret: bool,
    /// What it takes.
    pub kind: FieldKind,
    /// For [`FieldKind::Number`]: whole numbers only.
    pub integer: bool,
    /// The choices of a choice or multi field.
    pub choices: Vec<FieldChoice>,
    /// The text to start from (text and number fields).
    pub text: String,
    /// The index chosen to start from (choice fields; yes is 0 and no is 1 for a bool).
    pub choice: Option<usize>,
    /// The indexes ticked to start from (multi fields).
    pub ticked: Vec<usize>,
}

/// The agent asks the person something in a form.
#[derive(Debug, Clone, PartialEq)]
pub struct QuestionView {
    /// What the agent asks.
    pub message: String,
    /// The schema's own description.
    pub description: Option<String>,
    /// The fields, in the agent's order.
    pub fields: Vec<QuestionField>,
}

/// What a waiting request asks.
#[derive(Debug, Clone, PartialEq)]
pub enum Ask {
    /// May the agent run this?
    Permission(PermissionView),
    /// The agent wants answers.
    Question(QuestionView),
}

/// A request from the agent that waits for the person. Nothing answers it but the person.
#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    /// Names the request. Pass it back with the answer: an answer to a request that is not the one waiting is refused.
    pub request_id: String,
    /// Fingerprint of what the person saw (the command and the options). Pass it back with the answer: if the
    /// request changed under the person's eyes, nothing is sent.
    pub digest: String,
    /// What it asks.
    pub ask: Ask,
    /// Milliseconds since the session opened when it appeared; an answer in the first 400 ms after is refused.
    pub arrived_ms: u64,
}

/// What a person answers to one field of a question; the answers go in the field order of
/// [`QuestionView::fields`]. Anything left out keeps the agent's default.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FieldAnswer {
    /// The text for a text or number field.
    pub text: Option<String>,
    /// The index chosen in a choice field (0 is yes and 1 is no for a bool).
    pub choice: Option<usize>,
    /// The indexes ticked in a multi field.
    pub ticked: Option<Vec<usize>>,
}

/// A message the agent refused, handed back for the composer: nothing was lost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unsent {
    /// Increases each time, so a screen puts it back once.
    pub seq: u64,
    /// The text to put back in the composer.
    pub text: String,
    /// The files that went with it (paths on the agent's machine).
    pub files: Vec<String>,
    /// The pictures of this computer that went with it.
    pub pictures: Vec<super::outgoing::Pasted>,
}

/// Where a session stands, in the five states the board and the sidebar tell apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionPhase {
    /// Not open yet (starting the keeper, replaying history).
    Connecting,
    /// Open and waiting for the person.
    Idle,
    /// The agent is working on a turn.
    Working,
    /// Waiting for a yes or no on something the agent wants to run.
    BlockedOnPermission,
    /// Waiting for answers to a question.
    BlockedOnQuestion,
    /// The agent will not open a session until the person signs in: see [`AcpInfo::auth`].
    AuthRequired,
    /// Over, with the reason in words. A lost connection ends the session here, not at the agent: attach again.
    Ended(String),
}

/// A subagent an observed agent started, as its log last described it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentView {
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
    /// When it started by the log's clock (ms since the epoch); `None` when the log does not say.
    pub started_ms: Option<u64>,
    /// When it ended by the log's clock; `None` while it runs or when the log does not say.
    pub ended_ms: Option<u64>,
    /// The key of the background task it runs as (a subagent started in the background), when it is one.
    pub task: Option<String>,
}

/// Something an observed agent runs in the background, as its log says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundView {
    /// Unique within the session.
    pub key: String,
    /// The agent's own id.
    pub id: String,
    /// `shell`, `terminal`, `eval`, `workflow`, `monitor`, `agent`, `other`.
    pub kind: String,
    /// `running`, `paused`, `finished`, `failed`, `stopped`.
    pub status: String,
    /// The command or the name.
    pub title: String,
    /// The full command, the folder or a summary.
    pub detail: Option<String>,
    /// Still alive.
    pub active: bool,
    /// When it started by the log's clock (ms since the epoch); `None` when the log does not say.
    pub started_ms: Option<u64>,
    /// When it ended by the log's clock.
    pub ended_ms: Option<u64>,
    /// The person can ask for it to stop (`ObservedHandle::stop_background`): the agent offers a way and it runs.
    pub stoppable: bool,
}

/// A plan the agent submitted for the person's decision, which its own program asks about on its screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposedPlanView {
    /// Its title.
    pub title: String,
    /// The plan as the agent wrote it, when the log holds it.
    pub markdown: Option<String>,
}

/// Whether an observed session shows the whole of its log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EarlierHistory {
    /// What is shown starts at the log's start.
    #[default]
    None,
    /// Older turns can be read: `ObservedHandle::load_earlier`.
    Available,
    /// A wider read is under way; what is shown stays until all of it is there.
    Loading,
    /// The widest read is shown and the log is longer still.
    TooLong,
}

/// Where an observed session's log reading stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservedLink {
    /// Looking for the log, or waiting for the agent to write it; the text says which.
    Locating(String),
    /// Reading the log, and reading what the agent appends.
    Following,
    /// The log cannot be read; the text says why and what to do.
    Failed(String),
    /// The pane is gone or its agent exited; the text says which.
    Ended(String),
}

/// What an observed session adds to a session: the pane it comes from and what its log says that a
/// keeper's session does not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedInfo {
    /// The pane the agent runs in: its terminal, answered with `Herdr.answer` for approvals.
    pub pane_id: String,
    /// herdr's agent label: `omp`, `claude`, `codex`.
    pub kind: String,
    /// What the person reads: `omp`, `Claude Code`, `Codex`.
    pub label: String,
    /// The log being read.
    pub log_path: Option<String>,
    /// How reading it goes.
    pub link: ObservedLink,
    /// The log's last turn is over (nothing open, the last message the agent's).
    pub turn_ended: bool,
    /// Subagents the log names.
    pub subagents: Vec<SubagentView>,
    /// Background tasks the log names.
    pub background: Vec<BackgroundView>,
    /// A plan waiting for the person's decision in the terminal.
    pub proposed_plan: Option<ProposedPlanView>,
    /// Whether the log holds turns that are not shown, and whether they can be loaded.
    pub earlier: EarlierHistory,
    /// The last thing that went wrong, in words (a send the terminal did not take); it clears itself.
    pub problem: Option<String>,
    /// This agent's questions are answered from here (`answerQuestion`); else in the terminal.
    pub answers_questions: bool,
}

/// One way to sign in to an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthMethodView {
    /// The id to sign in by.
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// A method done in a terminal on the agent's machine: the arguments the agent says to run it with.
    /// `None` for one the app can carry out (`authenticate`).
    pub terminal_args: Option<Vec<String>>,
}

/// The context window of the session and what it has cost (`usage_update`).
#[derive(Debug, Clone, PartialEq)]
pub struct UsageView {
    /// Tokens in the context now.
    pub used: u64,
    /// The window's size in tokens.
    pub size: u64,
    /// What the session has cost so far, when the agent says: `(amount, currency)`.
    pub cost: Option<(f64, String)>,
}

/// What the last turn used (the `usage` of the prompt's answer); an agent may leave any part out.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnUsageView {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub total: Option<u64>,
    pub thought: Option<u64>,
    pub cached_read: Option<u64>,
    pub cached_write: Option<u64>,
}

/// What an agent session knows from ACP besides its transcript: what the agent said it can do,
/// how it can be signed in to, what the session costs, and when it began working.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AcpInfo {
    /// `agentInfo` of `initialize`: the agent's own name, title and version.
    pub agent_name: Option<String>,
    pub agent_title: Option<String>,
    pub agent_version: Option<String>,
    /// The agent can open an old session without replaying it (`sessionCapabilities.resume`).
    pub can_resume: bool,
    /// The agent can list its old sessions (`sessionCapabilities.list`).
    pub can_list: bool,
    /// The agent can close a session (`sessionCapabilities.close`).
    pub can_close: bool,
    /// The agent can sign out (`auth.logout`).
    pub can_logout: bool,
    /// A prompt may carry sound (`promptCapabilities.audio`).
    pub accepts_audio: bool,
    /// A prompt may embed a file's text (`promptCapabilities.embeddedContext`).
    pub accepts_embedded: bool,
    /// While the phase is [`SessionPhase::AuthRequired`]: how the person can sign in.
    pub auth: Vec<AuthMethodView>,
    /// The context window and cost, when the agent has said.
    pub usage: Option<UsageView>,
    /// What the last turn used, when the agent said.
    pub turn_usage: Option<TurnUsageView>,
    /// When the agent says the session last changed (`updatedAt`, ISO 8601).
    pub updated_at: Option<String>,
    /// When the running turn began, in milliseconds since the session was attached (the clock of
    /// [`Item::started_ms`]); `None` when none runs or it began before this app looked.
    pub turn_started_ms: Option<u64>,
}

/// A conversation as it stands now. Immutable; a new one is published for every change.
#[derive(Debug, Clone)]
pub struct SessionSnapshot {
    /// Increases with every change of this session.
    pub revision: u64,
    /// Where it stands.
    pub phase: SessionPhase,
    /// The agent's route id (`omp`, `claude`).
    pub agent: String,
    /// The folder the session runs in.
    pub cwd: String,
    /// The agent's title for the session, when it has one.
    pub title: Option<String>,
    /// The conversation, oldest first.
    pub items: Arc<Vec<Arc<Item>>>,
    /// Items dropped from the start to keep the conversation small. The keeper still has them.
    pub dropped_items: usize,
    /// Said at the top when the machine no longer keeps the oldest turns of the replay
    /// (`Earlier messages are no longer kept on the machine (3 turns).`).
    pub earlier_notice: Option<String>,
    /// Requests waiting for the person, the oldest first; only the first can be answered.
    pub waiting: Vec<Waiting>,
    /// Messages waiting for the turn to end.
    pub queue: Vec<QueuedMessage>,
    /// Slash commands the agent offers.
    pub commands: Vec<SlashCommand>,
    /// The session's settings.
    pub options: Vec<SessionOption>,
    /// The agent's plan.
    pub plan: Vec<PlanStep>,
    /// The agent's current mode, by name, when it has said.
    pub mode: Option<String>,
    /// Percent of the context window used, when the agent has said.
    pub context_percent: Option<u8>,
    /// A turn is running.
    pub running: bool,
    /// The agent takes pictures in a prompt.
    pub accepts_pictures: bool,
    /// The connection to the keeper closed without the agent exiting: attach again to carry on.
    pub connection_lost: bool,
    /// While the conversation shown is a copy saved on this computer (the live one is still on its way): when it was
    /// saved, in milliseconds since the epoch. `None` for a conversation that came from the machine.
    pub cached_at_ms: Option<u64>,
    /// A message the agent refused, to put back in the composer.
    pub unsent: Option<Unsent>,
    /// Set for an observed session (an agent in a terminal pane): see [`ObservedInfo`].
    pub observed: Option<ObservedInfo>,
    /// What ACP says about an agent session besides its transcript.
    pub acp: AcpInfo,
}

impl SessionSnapshot {
    /// Whether anything waits for the person.
    pub fn needs_you(&self) -> bool {
        !self.waiting.is_empty()
    }
}
