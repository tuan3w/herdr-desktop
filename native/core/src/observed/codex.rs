//! Maps the lines of a Codex session log
//! (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`) to [`Update`]s.
//!
//! A port of herdr-mobile's `codex_log_mapper.dart`, the non-ask parts of `codex_kind.dart` and
//! `stopMessageForCodex`. Codex writes two dialects:
//!
//! **Paginated** (`session_meta.payload.history_mode == "paginated"`, every log of a current Codex TUI): the
//! chat is the `event_msg` lines of type `item_completed` whose `item.type` is `UserMessage`, `AgentMessage`
//! (`phase` commentary or final answer), `CommandExecution`, `FileChange`, `McpToolCall`, `Plan`, ... Those
//! items carry NO call id. The model calls one tool, `exec`, a script of JavaScript (`response_item`
//! `custom_tool_call`, `input` is the script) whose output comes back as `custom_tool_call_output`; the items
//! of the commands it ran land between the two, or, for a command that outlived the script's wait (a
//! unified-exec process), much later, named by `process_id` (the `session_id` of the script's result). A
//! script that outlives its own wait stays a "cell": its output says `Script running with cell ID N` until a
//! `wait` call ends it.
//!
//! **Legacy** (`history_mode` absent: older Codex and the desktop app): `event_msg` `user_message`,
//! `agent_message`, `exec_command_end` and `patch_apply_end`, joined to `response_item` `function_call` /
//! `custom_tool_call` by `call_id`.
//!
//! In both dialects `response_item.message` repeats the event stream and is never mapped. Nothing is written
//! while Codex waits for an approval, but the `custom_tool_call` of the command that waits is on disk, so the
//! approval card can show it. A `compacted` line is about 1.2 MB: it is skipped from its first characters,
//! before it is decoded. The log of a subagent starts with a replay of its parent: only lines from
//! `subagent_history_start_ordinal` on are its own.
//!
//! Idempotent: a line is mapped once (by its `ordinal`, else a hash of the line), messages are whole-message
//! upserts and tool calls are keyed by their call id, so the same file fed twice changes nothing.
//!
//! Differences from the Dart mapper, none of which changes what a person sees:
//! - a tool call is the ACP JSON object of [`Update::ToolStart`] / [`Update::ToolPatch`] (no `name`, which
//!   nothing reads); what a command printed is in `content` text, and `rawOutput` stays as Dart sends it;
//! - lengths and cut points count characters, not UTF-16 units;
//! - the order of the files of one `FileChange` is the order of the log line: `serde_json` keeps it because
//!   the `acp` crate this crate depends on turns on its `preserve_order` feature (a test pins it).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::model::{
    BackgroundKind, BackgroundStatus, BackgroundTask, LogImage, LogMapper, PendingAsk, PlanStatus,
    PlanStep, ProposedPlan, Role, StopRoute, SubagentInfo, Update, cancelled_patch, cap_json,
    cap_text, cut_text, diff_from_unified, first_line, fnv, message, parse_keeper_marker,
    user_message, with_image_markers,
};

type Obj = Map<String, Value>;

/// The longest title of a row or a task, in characters.
const TITLE_CHARS: usize = 120;
/// How many finished background tasks are kept.
const FINISHED_KEPT: usize = 30;

/// Where one tool call stands, as the reducer reads `status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

impl Status {
    fn wire(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// The ACP `kind` of a row.
#[derive(Debug, Clone, Copy)]
enum Kind {
    Read,
    Edit,
    Execute,
    Fetch,
    Other,
}

impl Kind {
    fn wire(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Edit => "edit",
            Self::Execute => "execute",
            Self::Fetch => "fetch",
            Self::Other => "other",
        }
    }
}

/// One file's change, as an ACP `diff` content entry.
struct Diff {
    path: String,
    old: Option<String>,
    new: String,
}

impl Diff {
    fn json(&self) -> Value {
        let mut o = Obj::new();
        o.insert("type".into(), "diff".into());
        o.insert("path".into(), self.path.clone().into());
        if let Some(old) = &self.old {
            o.insert("oldText".into(), old.clone().into());
        }
        o.insert("newText".into(), self.new.clone().into());
        Value::Object(o)
    }
}

/// What a tool row shows: the Dart `_Row`.
struct Row {
    title: String,
    kind: Kind,
    raw: Option<Value>,
    status: Status,
    output: String,
    diffs: Vec<Diff>,
    command: Option<String>,
}

impl Row {
    fn new(title: impl Into<String>, kind: Kind) -> Self {
        Self {
            title: title.into(),
            kind,
            raw: None,
            status: Status::InProgress,
            output: String::new(),
            diffs: Vec::new(),
            command: None,
        }
    }

    fn done(title: impl Into<String>, kind: Kind) -> Self {
        Self {
            status: Status::Completed,
            ..Self::new(title, kind)
        }
    }

    fn raw(mut self, raw: Value) -> Self {
        self.raw = Some(raw);
        self
    }

    /// The `content` list: the diffs, then what the command printed.
    fn content(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self.diffs.iter().map(Diff::json).collect();
        if !self.output.is_empty() {
            out.push(text_content(&self.output));
        }
        out
    }

    /// The whole `tool_call` object, at status `at`.
    fn to_call(&self, id: &str, at: Status) -> Value {
        let mut o = Obj::new();
        o.insert("toolCallId".into(), id.into());
        o.insert("title".into(), self.title.clone().into());
        o.insert("kind".into(), self.kind.wire().into());
        o.insert("status".into(), at.wire().into());
        if let Some(raw) = &self.raw {
            o.insert("rawInput".into(), raw.clone());
        }
        if !self.output.is_empty() {
            o.insert("rawOutput".into(), cap_text(&self.output).into());
        }
        o.insert("content".into(), Value::Array(self.content()));
        Value::Object(o)
    }
}

/// A tool call the mapper has seen start.
struct Call {
    /// The command the call runs, to find the item of it by.
    command: Option<String>,
    /// Not shown as a tool row (the plan call shows as the plan).
    hidden: bool,
    /// An item of the call's own command already filled its row.
    claimed: bool,
    /// The status the command's own item gave (a failed command stays failed when the script's output says
    /// nothing about it).
    item_status: Option<Status>,
}

impl Call {
    fn new(command: Option<String>) -> Self {
        Self {
            command,
            hidden: false,
            claimed: false,
            item_status: None,
        }
    }
}

/// How `Script <how>` starts the output of an `exec` or `wait` call.
struct Header {
    /// `completed`, `failed`, `terminated`, or `running with cell ID N`.
    word: String,
    /// `N` of a script still running.
    cell: Option<String>,
}

static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^Script (completed|failed|terminated|running with cell ID ([0-9]+))")
        .expect("header regex")
});

/// A line break that `.` does not match (Dart's `RegExp` and this one disagree on which are).
const NOT_LINE: &str = r"[^\n\r\u{2028}\u{2029}]";

/// The `"..."` or `'...'` string after `key:` in a JavaScript object literal, quoted key or not.
fn js_string_regex(key: &str) -> Regex {
    let dq = format!(r#""(?:[^"\\]|\\{NOT_LINE})*""#);
    let sq = format!(r"'(?:[^'\\]|\\{NOT_LINE})*'");
    Regex::new(&format!(
        r#"(?:^|[{{,\s])["']?{key}["']?\s*:\s*({dq}|{sq})"#
    ))
    .expect("js string regex")
}

static JS_CMD: LazyLock<Regex> = LazyLock::new(|| js_string_regex("cmd"));
static JS_WORKDIR: LazyLock<Regex> = LazyLock::new(|| js_string_regex("workdir"));

static PATCH_CONST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"const\s+[A-Za-z0-9_]+\s*=\s*("(?:[^"\\]|\\{NOT_LINE})*")\s*;"#
    ))
    .expect("patch regex")
});

/// Maps the lines of one Codex session log.
#[derive(Default)]
pub struct CodexMapper {
    seen: HashSet<String>,
    calls: HashMap<String, Call>,
    /// The keys of `calls`, oldest first.
    call_order: Vec<String>,
    /// Calls that started and have no output yet, oldest first.
    open: Vec<String>,
    /// Shell processes still running after their script returned: the process id (a script's `session_id`)
    /// to the call that started it.
    procs: HashMap<String, String>,
    /// Scripts still running ("cells"): cell id to the call that started it.
    cells: HashMap<String, String>,
    /// A `wait` call to the cell it waits for.
    waits: HashMap<String, String>,
    start_ordinal: Option<i64>,
    saw_meta: bool,
    titled: bool,
    turn_ended: bool,
    extra: usize,
    /// Subagents by key (their thread id, or `pending:<name>` until it is known), first seen first.
    subagents: Vec<(String, SubagentInfo)>,
    tasks: Vec<BackgroundTask>,
}

/// A new mapper behind the trait the observed session uses.
pub fn new_mapper() -> Box<dyn LogMapper> {
    Box::new(CodexMapper::default())
}

/// The message that asks Codex to end scripts `ids` that still run (`cell<N>`): its `wait` tool with
/// `terminate` stops a cell (observed on Codex 0.153.4). `None` when there is nothing to ask or an id is not
/// a plain token.
pub fn stop_message<'a>(ids: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let list: Vec<&str> = ids.into_iter().collect();
    if list.is_empty() || !list.iter().all(|id| is_safe_id(id)) {
        return None;
    }
    let cells: Vec<&str> = list
        .iter()
        .map(|id| id.strip_prefix("cell").unwrap_or(id))
        .collect();
    let noun = if cells.len() == 1 { "cell" } else { "cells" };
    Some(format!(
        "Stop the running {noun} now: {}. Call wait with terminate true on each. Do nothing else.",
        cells.join(", ")
    ))
}

/// The thread id a subagent's own rollout is found by (`SubAgentActivity.agent_thread_id`): a Codex subagent
/// is a thread of its own, so its log is located by that id like any session's. `None` while the parent has
/// not named the thread.
pub fn subagent_log_id(info: &SubagentInfo) -> Option<&str> {
    info.log_id.as_deref()
}

/// Whether a subagent's rollout, last modified at `modified_ms` (milliseconds since the epoch), is still
/// being written at `now_ms`: it ran if it changed within the last `running_ms`. `None` for a file without a
/// modification time: it counts as finished.
pub fn subagent_running(modified_ms: Option<i64>, now_ms: i64, running_ms: i64) -> bool {
    modified_ms.is_some_and(|at| now_ms - at <= running_ms)
}

/// `^[A-Za-z0-9_.:-]{1,64}$`: ids come from an agent's log or wire and go into a message to the agent; only
/// plain tokens pass.
fn is_safe_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

impl LogMapper for CodexMapper {
    fn map(&mut self, line: &str) -> Vec<Update> {
        if line.is_empty() {
            return Vec::new();
        }
        // The compacted history is a megabyte: its type is in the first bytes. (160 characters; Dart
        // counted UTF-16 units, which differs only for text no `"type":"compacted"` marker is in.)
        let end = line.char_indices().nth(160).map_or(line.len(), |(i, _)| i);
        if line[..end].contains(r#""type":"compacted""#) {
            return Vec::new();
        }
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(e)) => self.line(&e, line),
            _ => Vec::new(),
        }
    }

    fn pending_ask(&self) -> Option<PendingAsk> {
        // Codex asks through its own approval (herdr reports it blocked) and its questions are answered in
        // the terminal.
        None
    }

    fn proposed_plan(&self) -> Option<ProposedPlan> {
        None
    }

    fn open_tool_calls(&self) -> BTreeSet<String> {
        // A script that outlives its wait (a cell) is a background task, not the call a permission dialog
        // asks about.
        self.open
            .iter()
            .filter(|id| !self.cells.values().any(|c| c == *id))
            .cloned()
            .collect()
    }

    fn subagents(&self) -> Vec<SubagentInfo> {
        self.subagents.iter().map(|(_, s)| s.clone()).collect()
    }

    fn background_tasks(&self) -> Vec<BackgroundTask> {
        self.tasks.clone()
    }

    fn turn_ended(&self) -> bool {
        self.turn_ended
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

impl CodexMapper {
    // -- lines -----------------------------------------------------------------

    fn line(&mut self, e: &Obj, line: &str) -> Vec<Update> {
        let (Some(Value::String(ty)), Some(Value::Object(p))) = (e.get("type"), e.get("payload"))
        else {
            return Vec::new();
        };
        let ordinal = e.get("ordinal").and_then(Value::as_i64);
        if ty == "session_meta" {
            if self.saw_meta {
                return Vec::new();
            }
            self.saw_meta = true;
            if let Some(start) = p
                .get("subagent_history_start_ordinal")
                .and_then(Value::as_i64)
            {
                self.start_ordinal = Some(start);
            }
            return Vec::new();
        }
        if let (Some(o), Some(start)) = (ordinal, self.start_ordinal)
            && o < start
        {
            return Vec::new();
        }
        if ty != "event_msg" && ty != "response_item" {
            return Vec::new();
        }
        let key = match ordinal {
            Some(o) => format!("o{o}"),
            None => format!("h{}", fnv(line)),
        };
        if !self.seen.insert(key.clone()) {
            return Vec::new();
        }
        if ty == "event_msg" {
            self.event(p, &key)
        } else {
            self.response(p)
        }
    }

    // -- events ----------------------------------------------------------------

    fn event(&mut self, p: &Obj, key: &str) -> Vec<Update> {
        match str_of(p, "type") {
            Some("item_completed") => match p.get("item") {
                Some(Value::Object(item)) => self.item(item, key),
                _ => Vec::new(),
            },
            Some("task_started") => {
                self.turn_ended = false;
                Vec::new()
            }
            Some("task_complete") => {
                self.turn_ended = true;
                Vec::new()
            }
            Some("turn_aborted") => {
                self.turn_ended = true;
                let mut out = self.cancel_open();
                out.push(message(
                    Role::Agent,
                    &format!("aborted:{key}"),
                    "Interrupted",
                ));
                out
            }
            Some("user_message") => self.user_message(str_of(p, "message"), key, Vec::new()),
            Some("agent_message") => agent_message(str_of(p, "message"), key),
            Some("exec_command_end") => self.legacy_exec_end(p),
            Some("patch_apply_end") => self.legacy_patch_end(p),
            _ => Vec::new(),
        }
    }

    fn item(&mut self, item: &Obj, key: &str) -> Vec<Update> {
        let id = str_of(item, "id")
            .filter(|s| !s.is_empty())
            .unwrap_or(key)
            .to_owned();
        let id = id.as_str();
        match str_of(item, "type") {
            Some("UserMessage") => {
                // A picture whose note says where to fetch it becomes a block, shown on a tap. The
                // UserMessage item usually lists a `local_image` path only (the bytes are in the sibling
                // `response_item`, which is not read for messages): that stays the `[image]` line.
                let content = item.get("content");
                let pictures = pictures_of(content);
                let text = with_image_markers(
                    &text_parts(content, "text"),
                    images_of(content).saturating_sub(pictures.len()),
                );
                self.user_message(Some(&text), id, pictures)
            }
            Some("AgentMessage") => {
                let text = text_parts(item.get("content"), "Text");
                if text.is_empty() {
                    return questions(item.get("questions"), id);
                }
                agent_message(Some(&text), id)
            }
            Some("Plan") => match str_of(item, "text") {
                Some(text) if !text.trim().is_empty() => vec![message(Role::Agent, id, text)],
                _ => Vec::new(),
            },
            Some("ContextCompaction") => {
                vec![message(Role::Agent, id, "Earlier messages were summarised")]
            }
            Some("CommandExecution") => self.command_item(item, id),
            Some("FileChange") => self.file_change_item(item, id),
            Some("McpToolCall") => self.attach(mcp_row(item), id, None, None),
            Some("Extension") => {
                if str_of(item, "kind") != Some("web.search") {
                    return Vec::new();
                }
                self.attach(search_row(item), id, None, None)
            }
            Some("ImageView") => {
                let name = match str_of(item, "path") {
                    Some(path) => last_segment(path).to_owned(),
                    None => "an image".to_owned(),
                };
                self.attach(
                    Row::done(format!("Viewed {name}"), Kind::Read),
                    id,
                    None,
                    None,
                )
            }
            Some("WebSearch") => self.attach(search_row(item), id, None, None),
            Some("DynamicToolCall") => {
                let tool = str_of(item, "tool").unwrap_or("tool");
                let ns = match str_of(item, "namespace") {
                    Some(ns) if !ns.is_empty() => format!("{ns}: "),
                    _ => String::new(),
                };
                let mut row = Row::done(cut_text(&format!("{ns}{tool}"), TITLE_CHARS), Kind::Other);
                if item.get("success") == Some(&Value::Bool(false)) {
                    row.status = Status::Failed;
                }
                if let Some(args) = non_null(item, "arguments") {
                    row = row.raw(json!({"arguments": cap_json(args)}));
                }
                self.attach(row, id, None, None)
            }
            Some("ImageGeneration") => {
                let mut row = Row::done("Generated an image", Kind::Other);
                if str_of(item, "status") == Some("failed") {
                    row.status = Status::Failed;
                }
                self.attach(row, id, None, None)
            }
            Some(ty @ ("EnteredReviewMode" | "ExitedReviewMode")) => {
                let text = if ty == "EnteredReviewMode" {
                    "Review started"
                } else {
                    "Review finished"
                };
                vec![message(Role::Agent, id, text)]
            }
            Some("SubAgentActivity") => {
                self.subagent_activity(item);
                Vec::new()
            }
            // Items that only repeat what the log says elsewhere or are for the model: nothing to show
            // (`codexItemCoverage` in Dart marks them `ignored`).
            Some(
                "Reasoning" | "HookPrompt" | "FunctionCallOutput" | "CollabAgentToolCall" | "Sleep",
            ) => Vec::new(),
            // Anything else is shown as a row of its own, so a new kind of item is never lost silently:
            // it says what it is.
            Some(ty) if !ty.is_empty() => {
                let raw = json!({"item": cap_json(&Value::Object(item.clone()))});
                self.attach(Row::done(ty, Kind::Other).raw(raw), id, None, None)
            }
            _ => Vec::new(),
        }
    }

    fn user_message(
        &mut self,
        text: Option<&str>,
        id: &str,
        pictures: Vec<LogImage>,
    ) -> Vec<Update> {
        let Some(text) = text else {
            return Vec::new();
        };
        if (text.trim().is_empty() && pictures.is_empty())
            || text.trim_start().starts_with("<turn_aborted>")
        {
            return Vec::new();
        }
        self.turn_ended = false;
        let mut out = vec![user_message(id, text, pictures)];
        if !self.titled && !text.trim().is_empty() {
            self.titled = true;
            out.push(Update::Title(Some(cut_text(first_line(text.trim()), 80))));
        }
        out
    }

    // -- response items --------------------------------------------------------

    fn response(&mut self, p: &Obj) -> Vec<Update> {
        match str_of(p, "type") {
            Some("custom_tool_call") => self.custom_call(p),
            Some("custom_tool_call_output" | "function_call_output") => self.output(p),
            Some("function_call") => self.function_call(p),
            _ => Vec::new(),
        }
    }

    fn custom_call(&mut self, p: &Obj) -> Vec<Update> {
        let Some(id) = str_of(p, "call_id").filter(|s| !s.is_empty()) else {
            return Vec::new();
        };
        let input = str_of(p, "input").unwrap_or("");
        let row = if str_of(p, "name").unwrap_or("exec") == "apply_patch" {
            Row::new("Applying a patch", Kind::Edit).raw(json!({"patch": cap_text(input)}))
        } else {
            parse_script(input)
        };
        self.start(id, row, None)
    }

    fn function_call(&mut self, p: &Obj) -> Vec<Update> {
        let (Some(id), Some(name)) = (
            str_of(p, "call_id").filter(|s| !s.is_empty()),
            str_of(p, "name"),
        ) else {
            return Vec::new();
        };
        let args = p.get("arguments").and_then(decode);
        let arg = |k: &str| args.as_ref().and_then(|a| non_null(a, k));
        match name {
            "wait" => {
                if let Some(cell) = arg("cell_id") {
                    self.waits.insert(id.to_owned(), dart_str(cell));
                }
                Vec::new()
            }
            "wait_agent" | "request_user_input_async" => Vec::new(),
            "update_plan" => {
                self.insert_call(
                    id,
                    Call {
                        hidden: true,
                        ..Call::new(None)
                    },
                );
                plan(arg("plan"))
            }
            "exec_command" | "shell" => {
                let text = match arg("cmd").or_else(|| arg("command")) {
                    Some(Value::Array(parts)) => {
                        Some(parts.iter().map(dart_str).collect::<Vec<_>>().join(" "))
                    }
                    Some(Value::String(s)) => Some(s.clone()),
                    _ => None,
                };
                let Some(text) = text else {
                    return self.start(id, Row::new(name, Kind::Execute), None);
                };
                let mut raw = Obj::new();
                raw.insert("command".into(), cap_text(&text).into());
                if let Some(workdir) = arg("workdir") {
                    raw.insert("workdir".into(), workdir.clone());
                }
                let row = Row::new(cut_text(first_line(&text), TITLE_CHARS), Kind::Execute)
                    .raw(Value::Object(raw));
                self.start(id, row, Some(text))
            }
            "spawn_agent" => {
                let task = arg("task_name")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty());
                if let Some(task) = task
                    && !self.subagents.iter().any(|(_, s)| s.name == task)
                {
                    let mut info = SubagentInfo::new(task);
                    info.call_id = Some(id.to_owned());
                    self.subagents.push((format!("pending:{task}"), info));
                }
                let title = match task {
                    Some(task) => format!("{name}: {task}"),
                    None => name.to_owned(),
                };
                self.start(id, Row::new(title, Kind::Other), None)
            }
            "request_user_input" => {
                let first = arg("questions")
                    .and_then(Value::as_array)
                    .and_then(|qs| qs.first())
                    .and_then(|q| q.get("question"))
                    .and_then(Value::as_str);
                let title = match first {
                    Some(q) => cut_text(first_line(q), TITLE_CHARS),
                    None => "Question".to_owned(),
                };
                let mut row = Row::new(title, Kind::Other);
                if let Some(args) = &args {
                    row = row.raw(json!({"arguments": cap_json(&Value::Object(args.clone()))}));
                }
                self.start(id, row, None)
            }
            _ => {
                let title = match arg("task_name")
                    .or_else(|| arg("target"))
                    .and_then(Value::as_str)
                {
                    Some(target) => format!("{name}: {target}"),
                    None => name.to_owned(),
                };
                self.start(id, Row::new(title, Kind::Other), None)
            }
        }
    }

    // -- tool rows -------------------------------------------------------------

    fn insert_call(&mut self, id: &str, call: Call) {
        if self.calls.insert(id.to_owned(), call).is_none() {
            self.call_order.push(id.to_owned());
        }
    }

    fn start(&mut self, id: &str, row: Row, command: Option<String>) -> Vec<Update> {
        if self.calls.contains_key(id) {
            return Vec::new();
        }
        self.insert_call(id, Call::new(command.or_else(|| row.command.clone())));
        self.open.push(id.to_owned());
        self.turn_ended = false;
        vec![Update::ToolStart(row.to_call(id, Status::InProgress))]
    }

    // -- items that belong to a call --------------------------------------------

    fn command_item(&mut self, item: &Obj, id: &str) -> Vec<Update> {
        let cmd = match item.get("command") {
            Some(Value::Array(parts)) => {
                if parts.len() >= 3
                    && parts[1].as_str() == Some("-lc")
                    && let Some(script) = parts[2].as_str()
                {
                    script.to_owned()
                } else {
                    parts.iter().map(dart_str).collect::<Vec<_>>().join(" ")
                }
            }
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        let cwd = str_of(item, "cwd").map(|c| c.replacen("file://", "", 1));
        let output = str_of(item, "aggregated_output")
            .or_else(|| str_of(item, "formatted_output"))
            .unwrap_or("")
            .to_owned();
        let exit = item.get("exit_code").and_then(Value::as_i64);
        let status = match str_of(item, "status") {
            Some("declined") => Status::Cancelled,
            Some("failed") => Status::Failed,
            Some("inProgress" | "in_progress") => Status::InProgress,
            _ if exit.is_some_and(|c| c != 0) => Status::Failed,
            _ => Status::Completed,
        };
        let mut raw = Obj::new();
        raw.insert("command".into(), cap_text(&cmd).into());
        if let Some(cwd) = cwd {
            raw.insert("cwd".into(), cwd.into());
        }
        let row = Row {
            raw: Some(Value::Object(raw)),
            status,
            output,
            command: Some(cmd.clone()),
            ..Row::new(cut_text(first_line(cmd.trim()), TITLE_CHARS), Kind::Execute)
        };
        let process = non_null(item, "process_id").map(dart_str);
        let out = self.attach(row, id, Some(&cmd), process.as_deref());
        if let Some(process) = process
            && status != Status::InProgress
        {
            let end = if status == Status::Completed {
                BackgroundStatus::Finished
            } else {
                BackgroundStatus::Failed
            };
            self.finish_task(&format!("proc{process}"), end);
        }
        out
    }

    fn file_change_item(&mut self, item: &Obj, id: &str) -> Vec<Update> {
        let Some(Value::Object(changes)) = item.get("changes") else {
            return Vec::new();
        };
        let mut diffs = Vec::new();
        for (path, c) in changes {
            let Value::Object(c) = c else {
                continue;
            };
            match str_of(c, "type") {
                Some("add") => diffs.push(Diff {
                    path: path.clone(),
                    old: None,
                    new: cap_text(str_of(c, "content").unwrap_or("")),
                }),
                Some("delete") => diffs.push(Diff {
                    path: path.clone(),
                    old: str_of(c, "content").map(cap_text),
                    new: String::new(),
                }),
                _ => {
                    if let Some(u) = str_of(c, "unified_diff") {
                        diffs.push(unified_diff(path, u));
                    }
                }
            }
        }
        if diffs.is_empty() {
            return Vec::new();
        }
        let first = last_segment(&diffs[0].path).to_owned();
        let more = diffs.len() - 1;
        let stdout = str_of(item, "stdout").unwrap_or("").to_owned();
        // A patch the person declined is written after the turn was aborted, when its call is already
        // cancelled: nothing more to show.
        let stderr = item
            .get("stderr")
            .map_or_else(|| "null".to_owned(), dart_str);
        if self.open.is_empty() && stderr.contains("TurnAborted") {
            return Vec::new();
        }
        let status = match str_of(item, "status") {
            Some("declined") => Status::Cancelled,
            Some("failed") => Status::Failed,
            _ => Status::Completed,
        };
        let title = if more > 0 {
            format!("Edited {first} and {more} more")
        } else {
            format!("Edited {first}")
        };
        let row = Row {
            status,
            diffs,
            output: stdout,
            ..Row::new(title, Kind::Edit)
        };
        self.attach(row, id, None, None)
    }

    /// A finished item of a command, a patch, ...: it belongs to the call it ran for (the process it names,
    /// the call whose command it is, else the call the script is still running), or is a row of its own
    /// when none is known.
    fn attach(
        &mut self,
        row: Row,
        item_id: &str,
        command: Option<&str>,
        process: Option<&str>,
    ) -> Vec<Update> {
        let mut target: Option<String> = process.and_then(|p| self.procs.get(p).cloned());
        let mut late = false;
        if target.is_none()
            && let Some(cmd) = command
        {
            let same = |c: &Call| c.command.as_deref().is_some_and(|x| x.trim() == cmd.trim());
            target = self
                .call_order
                .iter()
                .rev()
                .find(|id| {
                    let c = &self.calls[*id];
                    !c.claimed && !c.hidden && same(c)
                })
                .cloned();
            if target.is_none() && self.open.is_empty() {
                // The script is over and its row filled: this is the same command's late item (a process
                // that ended after the turn did). Nothing new to show.
                target = self
                    .call_order
                    .iter()
                    .rev()
                    .find(|id| {
                        let c = &self.calls[*id];
                        !c.hidden && same(c)
                    })
                    .cloned();
                late = target.is_some();
            }
        }
        if target.is_none() && !self.open.is_empty() {
            // The newest call still running that has no item yet (not a cell: it waits for its own
            // command, which may arrive much later).
            let unclaimed = self.open.iter().rev().find(|id| {
                self.calls.get(*id).is_some_and(|c| !c.claimed)
                    && !self.cells.values().any(|c| c == *id)
            });
            match unclaimed {
                Some(id) => target = Some(id.clone()),
                None => {
                    // The call's script ran more than one command: one row each.
                    let last = self.open.last().cloned().unwrap_or_default();
                    self.extra += 1;
                    let id = format!("{last}:{}", self.extra);
                    return vec![Update::ToolStart(row.to_call(&id, row.status))];
                }
            }
        }
        let Some(target) = target.filter(|t| self.calls.contains_key(t)) else {
            return vec![Update::ToolStart(row.to_call(item_id, row.status))];
        };
        let open = self.open.contains(&target);
        if let Some(call) = self.calls.get_mut(&target) {
            call.claimed = true;
            call.item_status = Some(row.status);
        }
        let mut fields = Obj::new();
        fields.insert("toolCallId".into(), target.clone().into());
        fields.insert("title".into(), row.title.clone().into());
        fields.insert("kind".into(), row.kind.wire().into());
        if let Some(raw) = &row.raw {
            fields.insert("rawInput".into(), raw.clone());
        }
        // The call's own status is the script's: an item that says "completed" only says its command
        // ended, and a call still open stays open until its output. A failure or a decline of the command
        // counts at once.
        if !late && (!open || row.status != Status::Completed) {
            fields.insert("status".into(), row.status.wire().into());
        }
        fields.insert("content".into(), Value::Array(row.content()));
        if !row.output.is_empty() {
            fields.insert("rawOutput".into(), cap_text(&row.output).into());
        }
        vec![Update::ToolPatch(Value::Object(fields))]
    }

    // -- outputs ---------------------------------------------------------------

    fn output(&mut self, p: &Obj) -> Vec<Update> {
        let Some(id) = str_of(p, "call_id").filter(|s| !s.is_empty()) else {
            return Vec::new();
        };
        let raw = p.get("output");
        let parts: Vec<String> = match raw {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        };
        let waited = self.waits.remove(id);
        let known = self
            .calls
            .get(id)
            .map(|c| (c.hidden, c.claimed, c.item_status, c.command.clone()));
        if known.is_none() && waited.is_none() {
            return Vec::new();
        }
        if known.as_ref().is_some_and(|k| k.0) {
            return Vec::new();
        }
        let first = parts.first().map_or("", String::as_str);
        let header = HEADER.captures(first).map(|c| Header {
            word: c[1].to_owned(),
            cell: c.get(2).map(|m| m.as_str().to_owned()),
        });
        if let Some(cell) = waited {
            return self.wait_result(&cell, header.as_ref(), &parts);
        }
        let Some((_, claimed, item_status, command)) = known else {
            return Vec::new();
        };

        // The cell is still running: the call stays open.
        if let Some(cell) = header.as_ref().and_then(|h| h.cell.clone()) {
            self.cells.insert(cell.clone(), id.to_owned());
            let title = match &command {
                None => "Running a script".to_owned(),
                Some(c) => cut_text(first_line(c.trim()), TITLE_CHARS),
            };
            self.start_task(
                format!("cell{cell}"),
                BackgroundKind::Shell,
                title,
                command,
                id,
                StopRoute::Message,
            );
            return Vec::new();
        }
        self.open.retain(|o| o != id);
        self.turn_ended = false;

        let mut body = if parts.len() > 1 {
            parts[1..].join("\n")
        } else if header.is_none() {
            first.to_owned()
        } else {
            String::new()
        };
        let result = decode_str(&body);
        let session = result
            .as_ref()
            .and_then(|r| non_null(r, "session_id"))
            .map(dart_str);
        if let Some(out) = result.as_ref().and_then(|r| str_of(r, "output")) {
            body = out.to_owned();
        }
        if let Some(session) = session.filter(|s| !s.is_empty()) {
            // The process belongs to the call that started it; a `write_stdin` that polls it names the
            // same id.
            self.procs
                .entry(session.clone())
                .or_insert_with(|| id.to_owned());
            let title = match &command {
                None => "Running command".to_owned(),
                Some(c) => cut_text(first_line(c.trim()), TITLE_CHARS),
            };
            self.start_task(
                format!("proc{session}"),
                BackgroundKind::Terminal,
                title,
                command,
                id,
                StopRoute::None,
            );
        }
        let aborted = matches!(raw, Some(Value::String(s)) if s.starts_with("aborted by user"));
        let exit = result
            .as_ref()
            .and_then(|r| r.get("exit_code"))
            .and_then(Value::as_i64);
        let failed =
            header.as_ref().is_some_and(|h| h.word == "failed") || exit.is_some_and(|c| c != 0);
        let status = if aborted {
            Status::Cancelled
        } else if failed {
            Status::Failed
        } else {
            Status::Completed
        };
        let text = if aborted {
            raw.and_then(Value::as_str).unwrap_or("").to_owned()
        } else {
            body
        };
        if claimed {
            // The item of the command has the output and the exit status; the script's own failure still
            // counts.
            let own = match item_status {
                Some(s @ (Status::Failed | Status::Cancelled)) => s,
                _ => Status::Completed,
            };
            let shown = if aborted || failed { status } else { own };
            return vec![Update::ToolPatch(
                json!({"toolCallId": id, "status": shown.wire()}),
            )];
        }
        let mut fields = Obj::new();
        fields.insert("toolCallId".into(), id.into());
        fields.insert("status".into(), status.wire().into());
        fields.insert(
            "content".into(),
            Value::Array(if text.is_empty() {
                Vec::new()
            } else {
                vec![text_content(&text)]
            }),
        );
        if !text.is_empty() {
            fields.insert("rawOutput".into(), cap_text(&text).into());
        }
        vec![Update::ToolPatch(Value::Object(fields))]
    }

    /// What a `wait` call reported about cell `cell`: it ended, or still runs.
    fn wait_result(
        &mut self,
        cell: &str,
        header: Option<&Header>,
        parts: &[String],
    ) -> Vec<Update> {
        let Some(header) = header.filter(|h| h.cell.is_none()) else {
            return Vec::new();
        };
        let id = self.cells.remove(cell);
        let failed = header.word == "failed";
        let stopped = header.word == "terminated";
        self.finish_task(
            &format!("cell{cell}"),
            if stopped {
                BackgroundStatus::Stopped
            } else if failed {
                BackgroundStatus::Failed
            } else {
                BackgroundStatus::Finished
            },
        );
        let Some(id) = id else {
            return Vec::new();
        };
        if !self.open.contains(&id) {
            return Vec::new();
        }
        self.open.retain(|o| *o != id);
        let claimed = self.calls.get(&id).is_some_and(|c| c.claimed);
        let text = if parts.len() > 1 {
            parts[1..].join("\n")
        } else {
            String::new()
        };
        let mut fields = Obj::new();
        fields.insert("toolCallId".into(), id.into());
        let status = if stopped {
            Status::Cancelled
        } else if failed {
            Status::Failed
        } else {
            Status::Completed
        };
        fields.insert("status".into(), status.wire().into());
        if !claimed && !text.is_empty() {
            fields.insert("content".into(), Value::Array(vec![text_content(&text)]));
            fields.insert("rawOutput".into(), cap_text(&text).into());
        }
        vec![Update::ToolPatch(Value::Object(fields))]
    }

    /// Every call still running ends: the turn was interrupted. A cell dies with its turn; a shell process
    /// may go on (Codex says so) until its item arrives.
    fn cancel_open(&mut self) -> Vec<Update> {
        if self.open.is_empty() {
            return Vec::new();
        }
        let out = self.open.iter().map(|id| cancelled_patch(id)).collect();
        let cells: Vec<String> = self.cells.keys().cloned().collect();
        for cell in cells {
            self.finish_task(&format!("cell{cell}"), BackgroundStatus::Stopped);
        }
        self.cells.clear();
        self.open.clear();
        out
    }

    // -- legacy dialect --------------------------------------------------------

    fn legacy_exec_end(&mut self, p: &Obj) -> Vec<Update> {
        let Some(id) = str_of(p, "call_id").filter(|id| self.calls.contains_key(*id)) else {
            return Vec::new();
        };
        self.open.retain(|o| o != id);
        if let Some(call) = self.calls.get_mut(id) {
            call.claimed = true;
        }
        let exit = p.get("exit_code").and_then(Value::as_i64);
        let failed = str_of(p, "status") == Some("failed") || exit.is_some_and(|c| c != 0);
        let output = str_of(p, "aggregated_output").unwrap_or("");
        let mut fields = Obj::new();
        fields.insert("toolCallId".into(), id.into());
        fields.insert(
            "status".into(),
            if failed { "failed" } else { "completed" }.into(),
        );
        fields.insert(
            "content".into(),
            Value::Array(if output.is_empty() {
                Vec::new()
            } else {
                vec![text_content(output)]
            }),
        );
        if !output.is_empty() {
            fields.insert("rawOutput".into(), cap_text(output).into());
        }
        vec![Update::ToolPatch(Value::Object(fields))]
    }

    fn legacy_patch_end(&mut self, p: &Obj) -> Vec<Update> {
        let Some(id) = str_of(p, "call_id").filter(|id| self.calls.contains_key(*id)) else {
            return Vec::new();
        };
        self.open.retain(|o| o != id);
        if let Some(call) = self.calls.get_mut(id) {
            call.claimed = true;
        }
        let mut content = Vec::new();
        if let Some(Value::Object(changes)) = p.get("changes") {
            for (path, c) in changes {
                let Value::Object(c) = c else {
                    continue;
                };
                if str_of(c, "type") == Some("add")
                    && let Some(text) = str_of(c, "content")
                {
                    let diff = Diff {
                        path: path.clone(),
                        old: None,
                        new: cap_text(text),
                    };
                    content.push(diff.json());
                } else if let Some(u) = str_of(c, "unified_diff") {
                    content.push(unified_diff(path, u).json());
                }
            }
        }
        let stdout = str_of(p, "stdout").unwrap_or("");
        if !stdout.is_empty() {
            content.push(text_content(stdout));
        }
        let mut fields = Obj::new();
        fields.insert("toolCallId".into(), id.into());
        let failed = p.get("success") == Some(&Value::Bool(false));
        fields.insert(
            "status".into(),
            if failed { "failed" } else { "completed" }.into(),
        );
        fields.insert("content".into(), Value::Array(content));
        if !stdout.is_empty() {
            fields.insert("rawOutput".into(), cap_text(stdout).into());
        }
        vec![Update::ToolPatch(Value::Object(fields))]
    }

    // -- subagents ---------------------------------------------------------------

    fn subagent_activity(&mut self, item: &Obj) {
        let Some(thread) = str_of(item, "agent_thread_id").filter(|t| !t.is_empty()) else {
            return;
        };
        let name = match str_of(item, "agent_path") {
            Some(path) if !path.is_empty() => path
                .split('/')
                .rev()
                .find(|s| !s.is_empty())
                .unwrap_or(thread),
            _ => thread,
        };
        let old = match self.subagents.iter().find(|(k, _)| k == thread) {
            Some((_, s)) => Some(s.clone()),
            None => {
                let pending = format!("pending:{name}");
                let at = self.subagents.iter().position(|(k, _)| *k == pending);
                at.map(|i| self.subagents.remove(i).1)
            }
        };
        let status = match str_of(item, "kind") {
            Some("started" | "interacted") => "running".to_owned(),
            Some("completed") => "completed".to_owned(),
            Some("interrupted") => "aborted".to_owned(),
            _ => old
                .as_ref()
                .map_or_else(|| "running".to_owned(), |o| o.status.clone()),
        };
        let info = SubagentInfo {
            name: old
                .as_ref()
                .map_or_else(|| name.to_owned(), |o| o.name.clone()),
            agent: old.as_ref().map(|o| o.agent.clone()).unwrap_or_default(),
            status,
            assignment: old
                .as_ref()
                .map(|o| o.assignment.clone())
                .unwrap_or_default(),
            tool_count: old.as_ref().map_or(0, |o| o.tool_count),
            recent_tools: old
                .as_ref()
                .map(|o| o.recent_tools.clone())
                .unwrap_or_default(),
            log_id: Some(thread.to_owned()),
            call_id: old
                .and_then(|o| o.call_id)
                .or_else(|| str_of(item, "id").map(str::to_owned)),
            started_ms: None,
            ended_ms: None,
        };
        match self.subagents.iter_mut().find(|(k, _)| k == thread) {
            Some(slot) => slot.1 = info,
            None => self.subagents.push((thread.to_owned(), info)),
        }
    }

    // -- background tasks ----------------------------------------------------------

    fn start_task(
        &mut self,
        id: String,
        kind: BackgroundKind,
        title: String,
        detail: Option<String>,
        tool_call_id: &str,
        stop: StopRoute,
    ) {
        if self.tasks.iter().any(|t| t.id == id) {
            return;
        }
        self.tasks.push(BackgroundTask {
            id,
            epoch: 0,
            kind,
            status: BackgroundStatus::Running,
            title,
            detail: detail.map(|d| cap_text(&d)),
            started_ms: None,
            ended_ms: None,
            deadline_secs: None,
            tool_call_id: Some(tool_call_id.to_owned()),
            stop,
        });
        self.tasks_changed();
    }

    fn finish_task(&mut self, id: &str, status: BackgroundStatus) {
        let Some(task) = self.tasks.iter_mut().find(|t| t.id == id) else {
            return;
        };
        if !task.status.is_active() {
            return;
        }
        task.status = status;
        task.stop = StopRoute::None;
        self.tasks_changed();
    }

    /// Keeps the newest [`FINISHED_KEPT`] finished tasks.
    fn tasks_changed(&mut self) {
        let finished = self.tasks.iter().filter(|t| !t.status.is_active()).count();
        let mut extra = finished.saturating_sub(FINISHED_KEPT);
        if extra == 0 {
            return;
        }
        self.tasks.retain(|t| {
            if extra == 0 || t.status.is_active() {
                return true;
            }
            extra -= 1;
            false
        });
    }
}

// -- plain helpers ---------------------------------------------------------------

fn str_of<'a>(o: &'a Obj, k: &str) -> Option<&'a str> {
    o.get(k).and_then(Value::as_str)
}

/// The value at `k` unless it is missing or JSON `null` (Dart reads both as `null`).
fn non_null<'a>(o: &'a Obj, k: &str) -> Option<&'a Value> {
    o.get(k).filter(|v| !v.is_null())
}

/// `'$value'` in Dart: a string as it is, anything else as JSON (a number as its digits).
fn dart_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The last non-empty segment of a `/` path, or the path.
fn last_segment(path: &str) -> &str {
    path.split('/')
        .rev()
        .find(|s| !s.is_empty())
        .unwrap_or(path)
}

fn text_content(text: &str) -> Value {
    json!({"type": "content", "content": {"type": "text", "text": cap_text(text)}})
}

/// The object a tool's `arguments` hold: an object, or a string that is one.
fn decode(raw: &Value) -> Option<Obj> {
    match raw {
        Value::Object(o) => Some(o.clone()),
        Value::String(s) => decode_str(s),
        _ => None,
    }
}

fn decode_str(raw: &str) -> Option<Obj> {
    if !raw.trim_start().starts_with('{') {
        return None;
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(o)) => Some(o),
        _ => None,
    }
}

fn unified_diff(path: &str, unified: &str) -> Diff {
    let (old, new) = diff_from_unified(&cap_text(unified));
    Diff {
        path: path.to_owned(),
        old: Some(old),
        new,
    }
}

fn agent_message(text: Option<&str>, id: &str) -> Vec<Update> {
    match text {
        Some(t) if !t.trim().is_empty() => vec![message(Role::Agent, id, t)],
        _ => Vec::new(),
    }
}

/// An agent message that asks questions and says nothing else.
fn questions(questions: Option<&Value>, id: &str) -> Vec<Update> {
    let Some(Value::Array(qs)) = questions else {
        return Vec::new();
    };
    let titles: Vec<&str> = qs
        .iter()
        .filter_map(|q| {
            let q = q.as_object()?;
            non_null(q, "question").or_else(|| q.get("title"))?.as_str()
        })
        .collect();
    if titles.is_empty() {
        return Vec::new();
    }
    vec![message(
        Role::Agent,
        id,
        &format!("Asked: {}", titles.join("; ")),
    )]
}

/// The `image` parts whose URL is the keeper's note with a reference (`local_image` parts have a path on the
/// host, no bytes).
fn pictures_of(content: Option<&Value>) -> Vec<LogImage> {
    let Some(Value::Array(parts)) = content else {
        return Vec::new();
    };
    parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("image"))
        .filter_map(|p| {
            let url = p.get("image_url")?.as_str()?;
            let source = parse_keeper_marker(url)?;
            Some(LogImage {
                mime: data_uri_mime(url).unwrap_or_default().to_owned(),
                source,
            })
        })
        .collect()
}

/// `image/png` of `data:image/png;base64,...`: the run after `data:` up to the first `;` or `,`.
fn data_uri_mime(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("data:")?;
    let end = rest.find([';', ',']).unwrap_or(rest.len());
    (end > 0).then(|| &rest[..end])
}

/// How many pictures a content list carries (`image` by URL, `local_image` by path).
fn images_of(content: Option<&Value>) -> usize {
    match content {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|p| {
                matches!(
                    p.get("type").and_then(Value::as_str),
                    Some("image" | "local_image")
                )
            })
            .count(),
        _ => 0,
    }
}

/// The text parts (`{type: <ty>, text}`) of a content list, joined.
fn text_parts(content: Option<&Value>, ty: &str) -> String {
    let Some(Value::Array(parts)) = content else {
        return String::new();
    };
    parts
        .iter()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some(ty))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n")
}

fn mcp_row(item: &Obj) -> Row {
    let server = str_of(item, "server").unwrap_or("mcp");
    let tool = str_of(item, "tool").unwrap_or("tool");
    let mut text = match item.get("result") {
        Some(Value::Object(r)) => text_parts(r.get("content"), "text"),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    let error = non_null(item, "error");
    if text.is_empty() {
        match error {
            Some(Value::Object(e)) => {
                if let Some(m) = str_of(e, "message") {
                    text = m.to_owned();
                }
            }
            Some(Value::String(e)) => text = e.clone(),
            _ => {}
        }
    }
    let failed = str_of(item, "status") == Some("failed") || error.is_some();
    let mut row = Row {
        status: if failed {
            Status::Failed
        } else {
            Status::Completed
        },
        output: text,
        ..Row::new(
            cut_text(&format!("{server}: {tool}"), TITLE_CHARS),
            Kind::Other,
        )
    };
    if let Some(args) = non_null(item, "arguments") {
        row = row.raw(json!({"arguments": cap_json(args)}));
    }
    row
}

fn search_row(item: &Obj) -> Row {
    let query = non_null(item, "query").or_else(|| {
        item.get("action")
            .and_then(Value::as_object)
            .and_then(|a| a.get("query"))
    });
    match query.and_then(Value::as_str) {
        Some(q) if !q.is_empty() => Row::done(
            cut_text(&format!("Searched: {}", first_line(q)), TITLE_CHARS),
            Kind::Fetch,
        ),
        _ => Row::done("Searched the web", Kind::Fetch),
    }
}

/// The plan an `update_plan` call carries.
fn plan(plan: Option<&Value>) -> Vec<Update> {
    let Some(Value::Array(steps)) = plan else {
        return Vec::new();
    };
    let entries = steps
        .iter()
        .filter_map(|s| {
            let s = s.as_object()?;
            let step = str_of(s, "step").filter(|t| !t.is_empty())?;
            let status = match str_of(s, "status") {
                Some("in_progress") => PlanStatus::InProgress,
                Some("completed") => PlanStatus::Completed,
                _ => PlanStatus::Pending,
            };
            Some(PlanStep {
                content: cut_text(step, 300),
                status,
            })
        })
        .collect();
    vec![Update::Plan(entries)]
}

// -- the script of an exec call -------------------------------------------------------

/// The title, kind and input of a script of the `exec` tool, from the first tool it calls. A script that
/// does not parse is just "Running a script".
fn parse_script(js: &str) -> Row {
    if let Some(exec) = js.find("tools.exec_command(") {
        // The `(` of the call is inside the marker, so the object is looked for after it.
        let open = js[exec..].find('(').map_or(0, |i| exec + i + 1);
        let args = balanced(js, open);
        // The model writes a JavaScript object, which is JSON only when it quotes its keys:
        // `{cmd:"ls"}` is as common as `{"cmd":"ls"}`.
        let map = args.and_then(decode_str);
        let cmd = match map.as_ref().and_then(|m| non_null(m, "cmd")) {
            Some(v) => Some(v.clone()),
            None => args.and_then(|a| js_string(&JS_CMD, a)).map(Value::String),
        };
        if let Some(Value::String(cmd)) = cmd
            && !cmd.is_empty()
        {
            let workdir = match map.as_ref().and_then(|m| non_null(m, "workdir")) {
                Some(v) => Some(v.clone()),
                None => args
                    .and_then(|a| js_string(&JS_WORKDIR, a))
                    .map(Value::String),
            };
            let mut raw = Obj::new();
            raw.insert("command".into(), cap_text(&cmd).into());
            if let Some(w) = workdir {
                raw.insert("workdir".into(), w);
            }
            return Row {
                command: Some(cmd.clone()),
                ..Row::new(cut_text(first_line(cmd.trim()), TITLE_CHARS), Kind::Execute)
                    .raw(Value::Object(raw))
            };
        }
    }
    if js.contains("tools.apply_patch(") {
        let patch = PATCH_CONST
            .captures(js)
            .and_then(|m| serde_json::from_str::<Value>(&m[1]).ok());
        let row = Row::new("Applying a patch", Kind::Edit);
        return match patch {
            Some(Value::String(p)) => row.raw(json!({"patch": cap_text(&p)})),
            _ => row,
        };
    }
    if js.contains("tools.write_stdin(") {
        return Row::new("Writing to a running command", Kind::Execute);
    }
    if js.contains("tools.web__run(") || js.contains("tools.web.") {
        return Row::new("Searching the web", Kind::Fetch);
    }
    if js.contains("tools.view_image(") {
        return Row::new("Viewing an image", Kind::Read);
    }
    if js.contains("tools.mcp__") {
        return Row::new("MCP call", Kind::Other);
    }
    Row::new("Running a script", Kind::Other)
}

/// The string value of the key `re` was built for in a JavaScript object literal `js`, whether the key is
/// quoted or not and the string is `"..."` or `'...'`; `None` when there is none.
fn js_string(re: &Regex, js: &str) -> Option<String> {
    let lit = re.captures(js)?.get(1)?.as_str();
    let json = match lit.strip_prefix('"') {
        Some(_) => lit.to_owned(),
        None => {
            let inner = &lit[1..lit.len() - 1];
            format!("\"{}\"", inner.replace('"', "\\\"").replace("\\'", "'"))
        }
    };
    serde_json::from_str::<String>(&json).ok()
}

/// The `{...}` object whose `{` is at or after byte `from` (with strings and escapes respected), or `None`.
fn balanced(s: &str, from: usize) -> Option<&str> {
    let bytes = s.as_bytes();
    let start = from + s.get(from..)?.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if c == b'\\' {
                i += 1;
            } else if c == b'"' {
                in_string = false;
            }
        } else if c == b'"' {
            in_string = true;
        } else if c == b'{' {
            depth += 1;
        } else if c == b'}' {
            depth -= 1;
            if depth == 0 {
                return Some(&s[start..=i]);
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests;
