//! What every agent's log mapper produces and what the rest of the observed pipeline consumes.
//!
//! A port of herdr-mobile's `observed_contracts.dart` and `log_mapping.dart` (the helpers every mapper
//! shares) and of `log_picture.dart`'s references. The mobile app's mappers emit its own chat reducer's
//! updates; these emit [`Update`]s, which the observed session applies to the same vendored transcript
//! real sessions use, so one screen renders both.
//!
//! **Tool calls are ACP JSON.** [`Update::ToolStart`] and [`Update::ToolPatch`] carry the `tool_call` /
//! `tool_call_update` object (`toolCallId`, `title`, `kind`, `status`, `rawInput`, `content`, ...): the
//! reducer reads `title`, `kind`, `status` (`pending`, `in_progress`, `completed`, `failed`, and
//! `cancelled` for a call the turn's interruption left without a result), `rawInput` (whose `command` or
//! path is the subject) and `content` (text and diffs). **What a tool printed belongs in `content` as text**;
//! a mapper may keep `rawOutput` or `_meta` for its own tests, the reducer does not read them.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

pub use crate::session::{PlanStatus, PlanStep, Role, SlashCommand};

/// The longest text kept per field, in characters. The host already cuts a field to about 16 KB;
/// anything longer than this gets a visible marker here.
pub const MAX_LOG_FIELD_CHARS: usize = 20_000;

const CUT_MARK: &str = "\n... [cut]";

/// Where the bytes of a picture the log does not carry are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PictureRef {
    /// The keeper dropped it from a log line and can send it again: its note said
    /// `[N bytes of data not sent; ref=<start>.<hash>]` (`blob PATH START HASH`).
    Keeper {
        /// Byte offset where the log line begins.
        start: u64,
        /// 16 hex digits naming the payload in that line.
        hash: String,
        /// Size when the note says it.
        bytes: Option<u64>,
    },
    /// An omp picture: the log holds `blob:sha256:<hex>`, the bytes are a file in the agent's `blobs/` folder.
    Omp {
        /// 64 hex digits.
        sha256: String,
        /// Size when known.
        bytes: Option<u64>,
    },
}

impl PictureRef {
    /// What the picture is cached under: its content, never where it was seen.
    pub fn key(&self) -> String {
        match self {
            Self::Keeper { hash, .. } => format!("log-{hash}"),
            Self::Omp { sha256, .. } => format!("omp-{sha256}"),
        }
    }
}

/// A picture of a log chat with no data of its own: `source` says where to get it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogImage {
    /// `image/png`...
    pub mime: String,
    /// Where the bytes are.
    pub source: PictureRef,
}

/// One piece of a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    /// Words.
    Text(String),
    /// A picture, fetched only when the person asks.
    Image(LogImage),
}

/// What a line of a log changed in the conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    /// A whole message: replaces the message of this `id` (so a line mapped twice changes nothing),
    /// or appends it. `Role::Thought` is the agent's reasoning.
    Message {
        /// Who wrote it.
        role: Role,
        /// Stable id; the same id replaces.
        id: String,
        /// Its text (capped) and pictures.
        blocks: Vec<Block>,
    },
    /// A tool call starts: the whole `tool_call` object (see the module docs).
    ToolStart(Value),
    /// A change to a tool call: a `tool_call_update` object naming only what changed. Applied over an
    /// empty call when the start was never seen.
    ToolPatch(Value),
    /// The agent's plan (replaces the last).
    Plan(Vec<PlanStep>),
    /// The session's title; `None` clears it.
    Title(Option<String>),
    /// The slash commands the agent offers (replaces the last).
    Commands(Vec<SlashCommand>),
    /// The log was compacted or cleared: everything before this is gone from the conversation.
    Cleared,
}

/// A message of `role` with one text block, capped.
pub fn message(role: Role, id: &str, text: &str) -> Update {
    Update::Message {
        role,
        id: id.to_owned(),
        blocks: vec![Block::Text(cap_text(text))],
    }
}

/// A whole message of `blocks`: text blocks are capped like any text, pictures stay.
pub fn message_blocks(role: Role, id: &str, blocks: Vec<Block>) -> Update {
    Update::Message {
        role,
        id: id.to_owned(),
        blocks: blocks
            .into_iter()
            .map(|b| match b {
                Block::Text(t) => Block::Text(cap_text(&t)),
                other => other,
            })
            .collect(),
    }
}

/// A whole message of the person: `text` and, when there are any, `pictures` after it (a picture alone is
/// a message of its own).
pub fn user_message(id: &str, text: &str, pictures: Vec<LogImage>) -> Update {
    if pictures.is_empty() {
        return message(Role::User, id, text);
    }
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(Block::Text(text.to_owned()));
    }
    blocks.extend(pictures.into_iter().map(Block::Image));
    message_blocks(Role::User, id, blocks)
}

/// A tool call that ended without a result because the turn was interrupted.
pub fn cancelled_patch(id: &str) -> Update {
    Update::ToolPatch(json!({"toolCallId": id, "status": "cancelled"}))
}

/// The log entry's own time in milliseconds since the Unix epoch, by the host's clock (`timestamp` as an
/// ISO 8601 string or as a number of milliseconds); `None` when it has none or it is not sane.
pub fn parse_stamp(entry: &Value) -> Option<i64> {
    match entry.get("timestamp")? {
        Value::String(s) => parse_iso_millis(s),
        Value::Number(n) => n.as_i64().filter(|t| (0..253_402_300_800_000).contains(t)),
        _ => None,
    }
}

/// `2026-11-06T10:00:00.123Z` (or with an offset) as milliseconds since the epoch.
pub fn parse_iso_millis(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |from: usize, to: usize| -> Option<i64> {
        std::str::from_utf8(b.get(from..to)?).ok()?.parse().ok()
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let mut at = 19;
    let mut millis = 0;
    if b.get(at) == Some(&b'.') {
        let digits = b[at + 1..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count();
        let frac = std::str::from_utf8(&b[at + 1..at + 1 + digits]).ok()?;
        millis = format!("{frac:0<3}")[..3].parse::<i64>().ok()?;
        at += 1 + digits;
    }
    let offset_min = match b.get(at) {
        None | Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let (oh, om) = (num(at + 1, at + 3)?, num(at + 4, at + 6).unwrap_or(0));
            let total = oh * 60 + om;
            if *sign == b'+' { total } else { -total }
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + mi - offset_min) * 60_000 + sec * 1000 + millis)
}

/// FNV-1a 32 of the UTF-16 code units of `s`, in lower-case hex: the id a message gets when its line has none.
/// Identical to herdr-mobile's `fnv`, so ids agree between the two apps.
pub fn fnv(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for unit in s.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:x}")
}

/// `s` up to its first newline.
pub fn first_line(s: &str) -> &str {
    s.split('\n').next().unwrap_or(s)
}

/// `s` cut to `max` characters with an ellipsis.
pub fn cut_text(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let kept: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{kept}…")
}

/// `text` of a message that carried `images` pictures: one `[image]` line for each, unless the agent's own
/// text already marks them (`[Image #1]`). A message with a picture never shows empty and never loses the
/// picture silently.
pub fn with_image_markers(text: &str, images: usize) -> String {
    if images == 0 || text.contains("[Image #") {
        return text.to_owned();
    }
    let markers = vec!["[image]"; images].join("\n");
    if text.is_empty() {
        markers
    } else {
        format!("{text}\n{markers}")
    }
}

/// `s` cut at [`MAX_LOG_FIELD_CHARS`] with a visible marker; whole when shorter.
pub fn cap_text(s: &str) -> String {
    if s.chars().count() <= MAX_LOG_FIELD_CHARS {
        return s.to_owned();
    }
    let kept: String = s.chars().take(MAX_LOG_FIELD_CHARS).collect();
    format!("{kept}{CUT_MARK}")
}

/// A copy of `v` whose strings are capped.
pub fn cap_json(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(cap_text(s)),
        Value::Array(a) => Value::Array(a.iter().map(cap_json).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), cap_json(v))).collect())
        }
        other => other.clone(),
    }
}

/// The old and new text of one file from a unified diff (Codex records its file changes that way): the old
/// text is the context and `-` lines, the new text the context and `+` lines; hunk and file headers are
/// dropped (the headers of a file come before its first hunk, never inside one).
pub fn diff_from_unified(unified: &str) -> (String, String) {
    let (mut old, mut new) = (Vec::new(), Vec::new());
    let mut in_hunk = false;
    for line in unified.split('\n') {
        if line.starts_with("@@") {
            in_hunk = true;
            continue;
        }
        // File headers come before the first hunk only: inside one, `---` is a removed line that starts
        // with `--` and `+++` an added `++i`.
        if !in_hunk && (line.starts_with("+++") || line.starts_with("---")) {
            continue;
        }
        if line.starts_with('\\') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('+') {
            new.push(rest);
        } else if let Some(rest) = line.strip_prefix('-') {
            old.push(rest);
        } else if let Some(rest) = line.strip_prefix(' ') {
            old.push(rest);
            new.push(rest);
        }
    }
    (old.join("\n"), new.join("\n"))
}

/// The reference in a note the keeper left where it dropped a picture (`[N bytes of data not sent;
/// ref=<start>.<hash>]`, also after the `data:<mime>;base64,` of a data URI). `None` for anything else.
pub fn parse_keeper_marker(s: &str) -> Option<PictureRef> {
    let rest = match s.strip_prefix("data:") {
        Some(after) => after.split_once(',')?.1,
        None => s,
    };
    let inner = rest.strip_prefix('[')?.strip_suffix(']')?;
    let (chars, tail) = inner.split_once(" bytes of data not sent; ref=")?;
    let (start, hash) = tail.split_once('.')?;
    if hash.len() != 16 || !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    if !chars.bytes().all(|b| b.is_ascii_digit()) || !start.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(PictureRef::Keeper {
        start: start.parse().ok()?,
        hash: hash.to_owned(),
        bytes: Some(chars.parse::<u64>().ok()? * 3 / 4),
    })
}

/// The reference in an omp image's `data` (`blob:sha256:<64 hex>`); `None` for anything else.
pub fn parse_omp_blob(s: &str) -> Option<PictureRef> {
    let hex = s.strip_prefix("blob:sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then(|| {
        PictureRef::Omp {
            sha256: hex.to_owned(),
            bytes: None,
        }
    })
}

/// One option of a question the agent asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskOption {
    /// What the person reads.
    pub label: String,
    /// More words, may be empty.
    pub description: String,
}

/// One question of the agent's question tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskQuestion {
    /// The agent's id for it.
    pub id: String,
    /// The question.
    pub question: String,
    /// The options.
    pub options: Vec<AskOption>,
    /// More than one option may be chosen.
    pub multi: bool,
    /// Zero-based index of the option the agent recommends, if it named one.
    pub recommended: Option<usize>,
}

/// A question tool call that has no result yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingAsk {
    /// The tool call.
    pub tool_call_id: String,
    /// Its questions.
    pub questions: Vec<AskQuestion>,
}

/// A plan the agent submitted for approval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposedPlan {
    /// Its title.
    pub title: String,
    /// The plan's text as the agent wrote it; `None` when the log does not hold what the agent submitted.
    pub markdown: Option<String>,
}

/// What the person answered, one entry per question, in order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AskAnswer {
    /// Zero-based indexes of the chosen options (one for a single choice).
    pub selected: Vec<usize>,
    /// Free text typed instead of, or in addition to, the options.
    pub custom: Option<String>,
}

/// A subagent the observed agent spawned with its `task` tool, as the parent's log last described it. Its own
/// transcript is a log of the same format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentInfo {
    /// The subagent's id and display name (`PongReply`).
    pub name: String,
    /// Its agent type (`task`, `explore`...); empty when the log did not say.
    pub agent: String,
    /// `pending`, `running`, `completed`, `failed`, `aborted`...
    pub status: String,
    /// What it was asked to do, cut to about 400 characters.
    pub assignment: String,
    /// Tool calls it made.
    pub tool_count: usize,
    /// Names of its latest tool calls, oldest first.
    pub recent_tools: Vec<String>,
    /// The id the host's transcript file is named by, when that is not `name` (Claude `agent-<id>.jsonl`,
    /// a Codex thread id). `None` for omp.
    pub log_id: Option<String>,
    /// The id of the tool call that spawned it.
    pub call_id: Option<String>,
    /// When it started by the log's clock (ms since the epoch); `None` when the log does not say.
    pub started_ms: Option<i64>,
    /// When it ended by the log's clock; `None` while it runs or when the log does not say.
    pub ended_ms: Option<i64>,
}

impl SubagentInfo {
    /// A subagent named `name` in state `pending`, nothing else known.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            agent: String::new(),
            status: "pending".to_owned(),
            assignment: String::new(),
            tool_count: 0,
            recent_tools: Vec::new(),
            log_id: None,
            call_id: None,
            started_ms: None,
            ended_ms: None,
        }
    }
}

/// What a background task is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundKind {
    /// A shell command the agent started in the background (`bg_6`).
    Shell,
    /// A background terminal (Codex unified exec).
    Terminal,
    /// A code cell (omp `eval`).
    Eval,
    /// A workflow the agent runs.
    Workflow,
    /// A monitor (Claude Code) that watches something.
    Monitor,
    /// A subagent the agent started in the background.
    Agent,
    /// Anything else an agent reports.
    Other,
}

/// Where a background task stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundStatus {
    /// Running.
    Running,
    /// Paused.
    Paused,
    /// Ended well.
    Finished,
    /// Ended badly.
    Failed,
    /// Stopped by a person or the agent.
    Stopped,
}

impl BackgroundStatus {
    /// Still alive: it may yet say something, wake the agent, or need a stop.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Paused)
    }
}

/// How a stop reaches the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopRoute {
    /// The agent offers no way to stop this task from here.
    None,
    /// A protocol request.
    Direct,
    /// A message asking the agent to stop the task (omp has no key or request for it; the model can).
    Message,
}

/// One background task. Value-equal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundTask {
    /// The agent's own id (`bg_6`, `command-1`, `RLFrameworks`); omp ids restart with the process.
    pub id: String,
    /// Process or session generation the id belongs to: see [`BackgroundTask::key`].
    pub epoch: u32,
    /// What it is.
    pub kind: BackgroundKind,
    /// Where it stands.
    pub status: BackgroundStatus,
    /// The command or the name, raw.
    pub title: String,
    /// The full command, the working folder or the agent's last summary.
    pub detail: Option<String>,
    /// When it started by the log's clock (ms since the epoch); `None` from a replay.
    pub started_ms: Option<i64>,
    /// When it ended (ms since the epoch).
    pub ended_ms: Option<i64>,
    /// How long the agent lets it run in seconds (omp bash `timeoutSeconds`); `None` for no limit or unknown.
    pub deadline_secs: Option<u64>,
    /// The transcript row that started it.
    pub tool_call_id: Option<String>,
    /// How a stop reaches the agent.
    pub stop: StopRoute,
}

impl BackgroundTask {
    /// Unique within a session.
    pub fn key(&self) -> String {
        format!("{}/{}", self.epoch, self.id)
    }
}

/// Turns the lines of one agent's session log into [`Update`]s. One instance per session, fed every line in
/// order. A line of an unknown or malformed shape gives an empty list and never panics.
pub trait LogMapper: Send {
    /// Updates for `line` (a whole JSON line).
    fn map(&mut self, line: &str) -> Vec<Update>;

    /// The question tool call that has no result yet, if any.
    fn pending_ask(&self) -> Option<PendingAsk>;

    /// The plan the agent submitted for the person's decision and that nothing in the log has answered yet.
    fn proposed_plan(&self) -> Option<ProposedPlan>;

    /// Ids of tool calls that started and have no result yet.
    fn open_tool_calls(&self) -> BTreeSet<String>;

    /// The subagents seen in `task` calls and results, latest state per name, in the order they first appeared.
    fn subagents(&self) -> Vec<SubagentInfo>;

    /// What the agent's log says runs in the background, oldest first; finished ones stay for a while.
    fn background_tasks(&self) -> Vec<BackgroundTask>;

    /// The last turn of the log is over: its last message is the agent's, it stopped by itself or was
    /// interrupted, and no tool call is open. False after a message from the person, a tool result, a tool
    /// call, and when a finished background job started a new turn.
    fn turn_ended(&self) -> bool;

    /// Drops everything learned (after a reset of the log).
    fn reset(&mut self);
}

/// What to do next to answer an agent's question dialog from its pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskStep {
    /// Send `text` (through the bracketed-paste-aware text path, WITHOUT enter), then `keys`
    /// (`pane.send_keys`); either may be empty, not both.
    Send {
        /// Keys by herdr's names.
        keys: Vec<String>,
        /// Text to type first.
        text: Option<String>,
        /// These keys end the dialog: the tool call gets its answer.
        submits: bool,
        /// What the step is for, for logs and tests.
        why: String,
    },
    /// The dialog is gone (answered, cancelled or timed out): check the log.
    Done,
    /// The screen cannot be driven (not the expected dialog, a draft in the composer, the dialog ignored the
    /// keys...). Nothing was sent.
    Mismatch(String),
}

/// How an agent's question tool is answered from a pane: its dialog is driven by keys, one screen at a time,
/// and the log has the last word.
pub trait AskDriver: Send + Sync {
    /// Whether the question dialog (or its custom-answer editor) is on `screen`.
    fn looks_like_ask(&self, screen: &str) -> bool;

    /// The planner for one answer (one per answer: it remembers what scrolled out of view). Feed it the
    /// pane's screen; it returns the one next thing to send.
    fn stepper(
        &self,
        ask: &PendingAsk,
        answers: &[AskAnswer],
    ) -> Box<dyn FnMut(&str) -> AskStep + Send>;

    /// Whether the tool result the agent recorded (`output`) says what the person answered.
    fn result_matches(&self, output: Option<&str>, ask: &PendingAsk, answers: &[AskAnswer])
    -> bool;
}

/// Where the session log of a pane is, as far as the app can tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    /// The log is at this path (validated: see `is_readable_log_path` in `locate`).
    Located(String),
    /// The agent has not written its file yet (a session has none until the first message); the text is a
    /// quiet status for the person; ask again later.
    NotYet(String),
    /// The log cannot be found and waiting will not change that; the text says what to do, shown as it is.
    Unlinked(String),
}

/// What a locator may look at.
pub struct LocateCtx<'a> {
    /// The agent as the snapshot lists it (`agent_session`, `cwd`, `terminal_title`...).
    pub agent: &'a crate::schema::AgentInfo,
    /// The pane, when the snapshot has it.
    pub pane: Option<&'a crate::schema::PaneInfo>,
    /// Reads files on the machine the pane runs on.
    pub files: &'a dyn crate::files::Files,
    /// Talks to that machine's herdr (`pane.process_info`).
    pub wire: &'a dyn crate::wire::Wire,
    /// The agent user's home folder on that machine, when known.
    pub home: Option<&'a str>,
}

/// Finds the log of the agent in a pane. Every file access goes through `LocateCtx::files`: nothing is put
/// in a shell, and every path built from a log, a pid or a session id is validated before it is used.
pub trait Locator: Send + Sync {
    /// Whether the pane may have a log: cheap and synchronous, for the board and menus. `locate` has the
    /// final word.
    fn may_locate(&self, agent: &crate::schema::AgentInfo) -> bool;

    /// Where the log is.
    fn locate(&self, ctx: &LocateCtx<'_>) -> Location;
}

/// An object map for building tool-call JSON.
pub type Fields = Map<String, Value>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_stamps_become_epoch_milliseconds_with_offsets_and_fractions() {
        assert_eq!(parse_iso_millis("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_iso_millis("2026-11-06T10:00:00.5Z"),
            Some(1_793_959_200_500)
        );
        assert_eq!(
            parse_iso_millis("2026-11-06T17:00:00+07:00"),
            parse_iso_millis("2026-11-06T10:00:00Z")
        );
        assert_eq!(parse_iso_millis("not a time"), None);
        assert_eq!(
            parse_stamp(&json!({"timestamp": 1_700_000_000_000_i64})),
            Some(1_700_000_000_000)
        );
        assert_eq!(parse_stamp(&json!({"timestamp": -5})), None);
    }

    #[test]
    fn text_is_capped_with_a_visible_mark_and_ids_match_the_phones() {
        let long = "x".repeat(MAX_LOG_FIELD_CHARS + 5);
        assert!(cap_text(&long).ends_with("\n... [cut]"));
        assert_eq!(cap_text("short"), "short");
        // FNV-1a 32 of "a" is e40c292c.
        assert_eq!(fnv("a"), "e40c292c");
        assert_eq!(cut_text("abcdef", 4), "abc…");
        assert_eq!(with_image_markers("", 2), "[image]\n[image]");
        assert_eq!(with_image_markers("see [Image #1]", 1), "see [Image #1]");
    }

    #[test]
    fn a_unified_diff_gives_the_old_and_the_new_text_without_headers() {
        let (old, new) =
            diff_from_unified("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n--gone\n+++added\n");
        assert_eq!(old, "keep\n-gone");
        assert_eq!(new, "keep\n++added");
    }

    #[test]
    fn picture_references_are_read_from_the_keepers_note_and_omps_blob_name() {
        let hash = "0123456789abcdef";
        let note = format!("[400 bytes of data not sent; ref=17.{hash}]");
        assert_eq!(
            parse_keeper_marker(&note),
            Some(PictureRef::Keeper {
                start: 17,
                hash: hash.into(),
                bytes: Some(300)
            })
        );
        assert!(parse_keeper_marker(&format!("data:image/png;base64,{note}")).is_some());
        assert_eq!(parse_keeper_marker("[400 bytes of data not sent]"), None);
        let sha = "a".repeat(64);
        assert!(matches!(
            parse_omp_blob(&format!("blob:sha256:{sha}")),
            Some(PictureRef::Omp { .. })
        ));
        assert_eq!(parse_omp_blob("blob:sha256:short"), None);
    }
}
