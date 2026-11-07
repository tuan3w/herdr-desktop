//! Maps the lines of an `omp` session log (`~/.omp/agent/sessions/.../*.jsonl`) to the [`Update`]s of the
//! observed session, so that an omp turn reads in the app the way the same turn of an ACP session does.
//!
//! Entry kinds read (everything else, and anything malformed, maps to nothing):
//! - `session` (the cwd, used to resolve relative paths; a title), `title` and `title_change` (the session
//!   title);
//! - `message` with role `user`, `assistant` (text, thinking, `toolCall` blocks, `stopReason: error`),
//!   `toolResult`, `bashExecution` and `pythonExecution`; `developer`, `fileMention` and other roles are
//!   housekeeping and stay hidden;
//! - `custom_message` that the user started (a skill prompt, a peer's prompt) and `irc:incoming` (a message
//!   from another agent, as a note); an `async-result` only updates the subagents and background tasks;
//! - `compaction` and `branch_summary` (one quiet note); `reset_boundary` (the conversation was cleared: the
//!   transcript starts over with one note);
//! - `custom`: `user_todo_edit` (the plan) and `session_exit` (the process is gone, so what was running is
//!   cancelled).
//!
//! The `task` tool shows as one row (`Subagents: A, B`) whose content is a roster; the subagents are the
//! latest state per name, from the call, its result's progress and later `wait` results. A `write` to
//! `agent://<name>` is a message to another agent: it shows as a note, not as a tool row. A subagent's own
//! log (`<parent>/<name>.jsonl`) has the same format.
//!
//! The background tasks follow the jobs omp reports as running in the background (`details.async` of a
//! `bash`, `eval` or `task` result) until the log says they ended: an `async-result` notice, a `wait` or proc
//! result, a kill the model issued, or `session_exit` (which also starts a new epoch, since omp's `bg_N` ids
//! restart with the process). `turn_ended` says whether the last turn of the log is over. Neither is
//! confirmed by the agent's UI: a job stopped there is never recorded.
//!
//! A log is written by whole entries, so nothing streams: a message arrives complete, a tool call arrives
//! when the assistant message that holds it is written (the tool is then running) and again, as a patch,
//! with its result.
//!
//! Idempotent: messages are whole-message upserts keyed by the entry id, tool calls are keyed by their call
//! id and patches replace, and an entry id this mapper has already mapped yields nothing, so a line fed
//! twice (a resume that overlaps, a reconnect) changes nothing. The memory of seen ids lives in the mapper:
//! reset it together with the state it feeds.
//!
//! What a tool printed goes in `content` as text, and also in `rawOutput` as in the Dart original (the
//! reducer does not read it); a call omp skipped keeps `_meta.herdr.skipped`.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::observed::model::{
    AskOption, AskQuestion, BackgroundKind, BackgroundStatus, BackgroundTask, LogImage, LogMapper,
    PendingAsk, PlanStatus, PlanStep, ProposedPlan, Role, StopRoute, SubagentInfo, Update,
    cancelled_patch, cap_json, cap_text, cut_text, first_line, fnv, message, parse_omp_blob,
    parse_stamp, user_message,
};

const TITLE_CHARS: usize = 120;
/// Finished tasks kept for the list; the oldest go first.
const FINISHED_KEPT: usize = 30;
const ASSIGNMENT_CHARS: usize = 400;

static PLAN_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-plan\.md$").expect("static regex"));
/// What omp's own text says of a job that did not succeed. Used only when the notice has no status.
static FAILED_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Command timed out|Command exited with code [1-9][0-9]*").expect("static regex")
});
static CANCELLED_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Cancelled background job (\S+?)\.(?:\s|$)").expect("static regex")
});
static JOB_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"── Job (\S+)").expect("static regex"));
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*://").expect("static regex"));
static READ_SELECTOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.+):([0-9]+)(?:[-+,][0-9]+)*$").expect("static regex"));
static HASHLINE_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^\[([^\]\n#]+)#[0-9A-Za-z]+\]").expect("static regex"));

const FILE_TOOLS: [&str; 6] = [
    "edit",
    "patch",
    "apply_patch",
    "ast_edit",
    "multi_edit",
    "str_replace",
];

/// A map that keeps the order keys first appeared in (replacing a value keeps its place), with
/// logarithmic insert and remove.
struct Ordered<V> {
    next: u64,
    index: HashMap<String, u64>,
    items: BTreeMap<u64, (String, V)>,
}

impl<V> Ordered<V> {
    fn new() -> Self {
        Self {
            next: 0,
            index: HashMap::new(),
            items: BTreeMap::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.items.get(self.index.get(key)?).map(|(_, v)| v)
    }

    fn contains(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    fn insert(&mut self, key: &str, value: V) {
        if let Some(at) = self.index.get(key) {
            if let Some(slot) = self.items.get_mut(at) {
                slot.1 = value;
            }
            return;
        }
        self.index.insert(key.to_owned(), self.next);
        self.items.insert(self.next, (key.to_owned(), value));
        self.next += 1;
    }

    fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.index.remove(key)?;
        self.items.remove(&at).map(|(_, v)| v)
    }

    fn entries(&self) -> impl Iterator<Item = (&str, &V)> {
        self.items.values().map(|(k, v)| (k.as_str(), v))
    }

    fn values(&self) -> impl Iterator<Item = &V> {
        self.items.values().map(|(_, v)| v)
    }

    fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    fn clear(&mut self) {
        self.index.clear();
        self.items.clear();
    }
}

/// A tool call that started and has no result yet.
struct OpenCall {
    name: String,
    /// The change the call's arguments described, kept until the result.
    diffs: Vec<Value>,
    /// The subagents a `task` call spawns.
    names: Vec<String>,
    /// The shell command or code cell, for a background job's title.
    command: Option<String>,
}

/// What a tool does, as ACP's `kind` says it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Execute,
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Fetch,
    Think,
    Other,
}

impl Kind {
    fn of(name: &str) -> Self {
        match name.to_lowercase().as_str() {
            "bash" | "shell" | "exec" | "eval" | "run_code" | "python" => Self::Execute,
            "read" => Self::Read,
            "edit" | "write" | "patch" | "apply_patch" | "ast_edit" | "multi_edit"
            | "str_replace" => Self::Edit,
            "delete" => Self::Delete,
            "move" => Self::Move,
            "grep" | "glob" | "find" | "search" | "ast_grep" => Self::Search,
            "fetch" | "web_search" | "web_fetch" | "websearch" | "webfetch" => Self::Fetch,
            "todo" | "think" => Self::Think,
            _ => Self::Other,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            Self::Execute => "execute",
            Self::Read => "read",
            Self::Edit => "edit",
            Self::Delete => "delete",
            Self::Move => "move",
            Self::Search => "search",
            Self::Fetch => "fetch",
            Self::Think => "think",
            Self::Other => "other",
        }
    }
}

/// Maps omp session log lines. One per session; see the module docs.
pub struct OmpMapper {
    /// Entry ids already mapped (those that produce updates).
    seen: HashSet<String>,
    /// Every tool call id that started, so that a result for an unseen start (a log followed from the
    /// middle) can name the call itself.
    started: HashSet<String>,
    /// Calls that started and have no result yet.
    open: Ordered<OpenCall>,
    ask: Option<PendingAsk>,
    cwd: Option<String>,
    /// Subagents by name, in the order they first appeared.
    subagents: Ordered<SubagentInfo>,
    /// Calls that are not shown as tool rows (messages to other agents show as notes); their results are
    /// dropped.
    hidden: HashSet<String>,
    /// Background tasks by [`BackgroundTask::key`], in the order they started.
    tasks: Ordered<BackgroundTask>,
    /// Bumped by `session_exit`: omp's job ids restart with its process.
    bg_epoch: u32,
    turn_ended: bool,
    /// The plan the agent submitted with `write xd://propose` and has not been answered: omp opens its plan
    /// review for it.
    proposed: Option<ProposedPlan>,
    /// What the agent last wrote to each plan file (`local://<slug>-plan.md`), by path; `None` when something
    /// else changed the file since. The submitted plan is that file, and the log holds its text only as the
    /// write's content.
    plan_files: HashMap<String, Option<String>>,
}

impl Default for OmpMapper {
    fn default() -> Self {
        Self::new()
    }
}

impl OmpMapper {
    /// A mapper that has seen nothing.
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
            started: HashSet::new(),
            open: Ordered::new(),
            ask: None,
            cwd: None,
            subagents: Ordered::new(),
            hidden: HashSet::new(),
            tasks: Ordered::new(),
            bg_epoch: 0,
            turn_ended: false,
            proposed: None,
            plan_files: HashMap::new(),
        }
    }
}

impl LogMapper for OmpMapper {
    fn map(&mut self, line: &str) -> Vec<Update> {
        if line.is_empty() {
            return Vec::new();
        }
        match serde_json::from_str::<Value>(line) {
            Ok(entry) if entry.is_object() => self.entry(&entry, line),
            _ => Vec::new(),
        }
    }

    fn pending_ask(&self) -> Option<PendingAsk> {
        self.ask.clone()
    }

    fn proposed_plan(&self) -> Option<ProposedPlan> {
        self.proposed.clone()
    }

    fn open_tool_calls(&self) -> BTreeSet<String> {
        self.open.entries().map(|(k, _)| k.to_owned()).collect()
    }

    fn subagents(&self) -> Vec<SubagentInfo> {
        self.subagents.values().cloned().collect()
    }

    fn background_tasks(&self) -> Vec<BackgroundTask> {
        self.tasks.values().cloned().collect()
    }

    fn turn_ended(&self) -> bool {
        self.turn_ended
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

// -- small readers ------------------------------------------------------------------------------------------

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

fn nonempty_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    str_of(v, key).filter(|s| !s.is_empty())
}

fn is_true(v: &Value, key: &str) -> bool {
    v.get(key) == Some(&Value::Bool(true))
}

fn list_of<'a>(v: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    v.get(key)?.as_array()
}

/// The arguments of a call: an object, or a string holding one.
fn arguments(raw: Option<&Value>) -> Option<Cow<'_, Value>> {
    match raw? {
        v @ Value::Object(_) => Some(Cow::Borrowed(v)),
        Value::String(s) if s.trim_start().starts_with('{') => serde_json::from_str::<Value>(s)
            .ok()
            .filter(Value::is_object)
            .map(Cow::Owned),
        _ => None,
    }
}

fn image_note(b: &Value) -> String {
    match str_of(b, "mimeType") {
        Some(mime) if !mime.is_empty() => format!("[image: {mime}]"),
        _ => "[image]".to_owned(),
    }
}

/// The pictures of a user message that can be fetched later: an `image` block whose `data` is
/// `blob:sha256:<hex>`, a file in the agent's `blobs/` folder.
fn pictures(content: Option<&Value>) -> Vec<LogImage> {
    let Some(Value::Array(blocks)) = content else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| str_of(b, "type") == Some("image"))
        .filter_map(|b| {
            let source = parse_omp_blob(str_of(b, "data")?)?;
            Some(LogImage {
                mime: str_of(b, "mimeType").unwrap_or("").to_owned(),
                source,
            })
        })
        .collect()
}

/// What the person typed: a string, or the text blocks joined, with a placeholder line per image that is
/// not a fetchable picture (the log holds a blob reference, not the picture).
fn user_text(content: Option<&Value>) -> String {
    let blocks = match content {
        Some(Value::String(s)) => return s.clone(),
        Some(Value::Array(blocks)) => blocks,
        _ => return String::new(),
    };
    let mut parts = Vec::new();
    for b in blocks {
        match str_of(b, "type") {
            Some("text") => {
                if let Some(t) = str_of(b, "text").filter(|t| !t.is_empty()) {
                    parts.push(t.to_owned());
                }
            }
            Some("image") => {
                if str_of(b, "data").is_some_and(|d| parse_omp_blob(d).is_some()) {
                    continue;
                }
                parts.push(image_note(b));
            }
            _ => {}
        }
    }
    parts.join("\n")
}

fn result_text(content: Option<&Value>) -> String {
    let blocks = match content {
        Some(Value::String(s)) => return s.clone(),
        Some(Value::Array(blocks)) => blocks,
        _ => return String::new(),
    };
    let mut parts = Vec::new();
    for b in blocks {
        match str_of(b, "type") {
            Some("text") => {
                if let Some(t) = str_of(b, "text").filter(|t| !t.is_empty()) {
                    parts.push(t.to_owned());
                }
            }
            Some("image") => parts.push(image_note(b)),
            _ => {}
        }
    }
    parts.join("\n")
}

fn ends_turn(stop: Option<&str>) -> bool {
    matches!(stop, Some("stop" | "length" | "aborted" | "error"))
}

fn text_block(text: &str) -> Value {
    json!({"type": "content", "content": {"type": "text", "text": text}})
}

fn diff_block(path: &str, old: Option<&str>, new: &str) -> Value {
    let mut o = Map::new();
    o.insert("type".into(), "diff".into());
    o.insert("path".into(), path.into());
    if let Some(old) = old {
        o.insert("oldText".into(), old.into());
    }
    o.insert("newText".into(), new.into());
    Value::Object(o)
}

fn background_status(s: &str) -> BackgroundStatus {
    match s {
        "failed" | "error" | "timeout" | "timed_out" => BackgroundStatus::Failed,
        "cancelled" | "canceled" | "aborted" | "killed" | "stopped" => BackgroundStatus::Stopped,
        _ => BackgroundStatus::Finished,
    }
}

fn still_running(s: &str) -> bool {
    s == "running" || s == "pending"
}

/// The plan from omp's todo phases (`[{name, tasks:[{content, status}]}]`); `None` when `phases` is not a
/// list. A task omp abandoned is `Pending` here: the reducer's plan has no cancelled state (the ACP crate
/// reads `cancelled` the same way).
fn plan_of(phases: Option<&Value>) -> Option<Update> {
    let Value::Array(phases) = phases? else {
        return None;
    };
    let mut steps = Vec::new();
    for phase in phases {
        let Some(tasks) = list_of(phase, "tasks") else {
            continue;
        };
        for t in tasks {
            let Some(content) = nonempty_str(t, "content") else {
                continue;
            };
            let status = match str_of(t, "status") {
                Some("in_progress") => PlanStatus::InProgress,
                Some("completed") => PlanStatus::Completed,
                _ => PlanStatus::Pending,
            };
            steps.push(PlanStep {
                content: cut_text(content, 300),
                status,
            });
        }
    }
    Some(Update::Plan(steps))
}

/// The names of tools a `recentTools` list holds, the last five.
fn tool_names(v: Option<&Value>) -> Option<Vec<String>> {
    let Value::Array(items) = v? else {
        return None;
    };
    let mut out = Vec::new();
    for t in items {
        let name = match t {
            Value::String(s) => Some(s.as_str()),
            Value::Object(_) => ["tool", "name", "toolName"]
                .iter()
                .find_map(|k| t.get(*k).filter(|v| !v.is_null()))
                .and_then(Value::as_str),
            _ => None,
        };
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            out.push(cut_text(name, 60));
        }
    }
    let skip = out.len().saturating_sub(5);
    Some(out.split_off(skip))
}

/// The part of a notice's `text` that belongs to each job: all of it for one job, the section under each
/// `── Job <id>` header for several.
fn job_bodies<'a>(text: &'a str, ids: &[&'a str]) -> HashMap<&'a str, &'a str> {
    if let [only] = ids {
        return HashMap::from([(*only, text)]);
    }
    let heads: Vec<_> = JOB_HEADER.captures_iter(text).collect();
    let mut out = HashMap::new();
    for (i, c) in heads.iter().enumerate() {
        let (Some(whole), Some(id)) = (c.get(0), c.get(1)) else {
            continue;
        };
        let end = heads
            .get(i + 1)
            .and_then(|n| n.get(0))
            .map_or(text.len(), |m| m.start());
        out.insert(id.as_str(), &text[whole.end()..end]);
    }
    out
}

// -- the mapper ---------------------------------------------------------------------------------------------

impl OmpMapper {
    /// The key a message entry is told apart by (its id, else a hash of the line), or `None` when this
    /// mapper has mapped it before.
    fn first_time(&mut self, e: &Value, line: &str) -> Option<String> {
        let key = nonempty_str(e, "id").map_or_else(|| format!("h{}", fnv(line)), str::to_owned);
        self.seen.insert(key.clone()).then_some(key)
    }

    fn entry(&mut self, e: &Value, line: &str) -> Vec<Update> {
        match str_of(e, "type") {
            Some("session") => {
                if let Some(cwd) = nonempty_str(e, "cwd") {
                    self.cwd = Some(cwd.to_owned());
                }
                if self.first_time(e, line).is_none() {
                    return Vec::new();
                }
                title_update(e.get("title"))
            }
            Some("title" | "title_change") => {
                if self.first_time(e, line).is_none() {
                    return Vec::new();
                }
                title_update(e.get("title"))
            }
            Some("message") => match e.get("message") {
                Some(m) if m.is_object() => self.message_entry(e, m, line),
                _ => Vec::new(),
            },
            Some("compaction" | "branch_summary") => {
                self.note(e, line, "Earlier messages were summarised")
            }
            Some("reset_boundary") => self.cleared(e, line),
            Some("custom_message") => self.custom_message(e, line),
            Some("custom") => self.custom(e, line),
            Some("mode_change") => {
                // Approving the plan, or leaving plan mode, ends the review.
                if str_of(e, "mode") != Some("plan") {
                    self.proposed = None;
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// The conversation was cleared on the machine: what was open is over, the transcript restarts with one
    /// note saying why it is short.
    fn cleared(&mut self, e: &Value, line: &str) -> Vec<Update> {
        let Some(key) = self.first_time(e, line) else {
            return Vec::new();
        };
        self.ask = None;
        self.proposed = None;
        self.open.clear();
        vec![
            Update::Cleared,
            message(
                Role::Agent,
                &key,
                "The conversation was cleared on the machine",
            ),
        ]
    }

    /// One quiet agent message for a housekeeping entry.
    fn note(&mut self, e: &Value, line: &str, text: &str) -> Vec<Update> {
        match self.first_time(e, line) {
            Some(key) => vec![message(Role::Agent, &key, text)],
            None => Vec::new(),
        }
    }

    fn custom_message(&mut self, e: &Value, line: &str) -> Vec<Update> {
        let custom = str_of(e, "customType");
        if custom == Some("irc:incoming") {
            return self.irc_incoming(e, line);
        }
        if custom == Some("async-result") {
            if self.first_time(e, line).is_some() {
                self.turn_ended = false;
                self.async_result(e);
                self.jobs_finished(e.get("details"));
            }
            return Vec::new();
        }
        // Only what the person started shows; reminders, nudges and notices the agent injected are for the
        // model.
        if str_of(e, "attribution") != Some("user") || !is_true(e, "display") {
            return Vec::new();
        }
        let pics = pictures(e.get("content"));
        let mut text = user_text(e.get("content"));
        if custom == Some("skill-prompt")
            && let Some(details) = e.get("details").filter(|d| d.is_object())
            && let Some(name) = nonempty_str(details, "name")
        {
            let args = str_of(details, "args")
                .map(str::trim)
                .filter(|a| !a.is_empty());
            text = match args {
                Some(a) => format!("/skill:{name} {a}"),
                None => format!("/skill:{name}"),
            };
        }
        if text.trim().is_empty() && pics.is_empty() {
            return Vec::new();
        }
        let Some(key) = self.first_time(e, line) else {
            return Vec::new();
        };
        self.turn_ended = false;
        self.proposed = None;
        let mut out = self.user_clears();
        out.push(user_message(&key, &text, pics));
        out
    }

    fn custom(&mut self, e: &Value, line: &str) -> Vec<Update> {
        match str_of(e, "customType") {
            Some("user_todo_edit") => {
                if let Some(data) = e.get("data").filter(|d| d.is_object())
                    && self.first_time(e, line).is_some()
                    && let Some(plan) = plan_of(data.get("phases"))
                {
                    return vec![plan];
                }
                Vec::new()
            }
            Some("session_exit") => {
                if self.first_time(e, line).is_none() {
                    return Vec::new();
                }
                self.exit_session(parse_stamp(e));
                self.cancel_open()
            }
            _ => Vec::new(),
        }
    }

    // -- messages -------------------------------------------------------------------------------------------

    fn message_entry(&mut self, e: &Value, m: &Value, line: &str) -> Vec<Update> {
        match str_of(m, "role") {
            Some("user") => {
                let pics = pictures(m.get("content"));
                let text = user_text(m.get("content"));
                if text.trim().is_empty() && pics.is_empty() {
                    return Vec::new();
                }
                let Some(key) = self.first_time(e, line) else {
                    return Vec::new();
                };
                self.turn_ended = false;
                self.proposed = None;
                let mut out = self.user_clears();
                out.push(user_message(&key, &text, pics));
                out
            }
            Some("assistant") => {
                let Some(key) = self.first_time(e, line) else {
                    return Vec::new();
                };
                let out = self.assistant(&key, m);
                let stop = str_of(m, "stopReason");
                // The abort that opens the review leaves an aborted message behind it.
                if stop != Some("aborted") {
                    self.proposed = None;
                }
                self.turn_ended = ends_turn(stop) && self.open.is_empty();
                out
            }
            Some("toolResult") => {
                if self.first_time(e, line).is_none() {
                    return Vec::new();
                }
                self.turn_ended = false;
                self.tool_result(m, parse_stamp(e))
            }
            Some("bashExecution") => match self.first_time(e, line) {
                Some(key) => vec![user_run(&key, m, "command", "bash")],
                None => Vec::new(),
            },
            Some("pythonExecution") => match self.first_time(e, line) {
                Some(key) => vec![user_run(&key, m, "code", "python")],
                None => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// A later user message ends a question that is still open: the answer, if any, was typed in the
    /// terminal.
    fn user_clears(&mut self) -> Vec<Update> {
        let Some(ask) = self.ask.take() else {
            return Vec::new();
        };
        if self.open.remove(&ask.tool_call_id).is_none() {
            return Vec::new();
        }
        vec![cancelled_patch(&ask.tool_call_id)]
    }

    fn assistant(&mut self, key: &str, m: &Value) -> Vec<Update> {
        let mut out = Vec::new();
        match m.get("content") {
            Some(Value::String(s)) => add_text(&mut out, Role::Agent, &format!("{key}:0"), s),
            Some(Value::Array(blocks)) => {
                for (i, b) in blocks.iter().enumerate() {
                    if !b.is_object() {
                        continue;
                    }
                    let id = format!("{key}:{i}");
                    match str_of(b, "type") {
                        Some("text") => {
                            if let Some(t) = str_of(b, "text") {
                                add_text(&mut out, Role::Agent, &id, t);
                            }
                        }
                        Some("thinking") => {
                            if let Some(t) = str_of(b, "thinking") {
                                add_text(&mut out, Role::Thought, &id, t);
                            }
                        }
                        Some("toolCall") => {
                            if let Some(note) = self.agent_write(b, &id) {
                                out.push(note);
                            } else if let Some(start) = self.tool_start(b) {
                                out.push(start);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        let stop = str_of(m, "stopReason");
        if stop == Some("error") {
            let text = match str_of(m, "errorMessage")
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(err) => format!("The turn failed: {}", cap_text(err)),
                None => "The turn failed.".to_owned(),
            };
            out.push(message(Role::Agent, &format!("{key}:error"), &text));
        }
        // An interrupted or failed message leaves its calls without a result.
        if matches!(stop, Some("error" | "aborted")) {
            out.extend(self.cancel_open());
        }
        out
    }

    // -- tool calls -----------------------------------------------------------------------------------------

    fn tool_start(&mut self, b: &Value) -> Option<Update> {
        let id = nonempty_str(b, "id")?;
        let name = nonempty_str(b, "name").unwrap_or("tool");
        let args = arguments(b.get("arguments"));
        let args = args.as_deref();
        let diffs = self.start_diffs(name, args);
        let names = if name == "task" {
            self.task_names(args)
        } else {
            Vec::new()
        };
        self.started.insert(id.to_owned());
        self.open.insert(
            id,
            OpenCall {
                name: name.to_owned(),
                diffs: diffs.clone(),
                names: names.clone(),
                command: command_of(args).map(str::to_owned),
            },
        );
        if name == "ask" {
            self.ask = parse_ask(id, args);
        }
        self.note_plan_file(name, args);
        let intent = str_of(b, "intent").or_else(|| args.and_then(|a| str_of(a, "i")));
        let roster = self.roster(&names);
        let title = if names.is_empty() {
            tool_title(name, args, intent)
        } else {
            cut_text(&format!("Subagents: {}", names.join(", ")), TITLE_CHARS)
        };
        let mut call = Map::new();
        call.insert("toolCallId".into(), id.into());
        call.insert("name".into(), name.into());
        call.insert("title".into(), title.into());
        call.insert("kind".into(), Kind::of(name).wire().into());
        call.insert("status".into(), "in_progress".into());
        if let Some(a) = args {
            call.insert("rawInput".into(), cap_json(a));
        }
        call.insert(
            "content".into(),
            if roster.is_empty() {
                Value::Array(diffs)
            } else {
                json!([text_block(&roster)])
            },
        );
        let locations = self.locations_of_call(name, args);
        if !locations.is_empty() {
            call.insert("locations".into(), Value::Array(locations));
        }
        Some(Update::ToolStart(Value::Object(call)))
    }

    /// Keeps what the agent writes to a plan file, and forgets it when another tool changes that file (the
    /// plan sent for approval would then not be the text written, and showing the old text as the plan
    /// would be wrong).
    fn note_plan_file(&mut self, name: &str, args: Option<&Value>) {
        let Some(args) = args else { return };
        let path = str_of(args, "path");
        if name == "write"
            && let Some(path) = path.filter(|p| PLAN_FILE.is_match(p))
        {
            let content = str_of(args, "content").map(str::to_owned);
            self.plan_files.insert(path.to_owned(), content);
        } else if !self.plan_files.is_empty() && FILE_TOOLS.contains(&name) {
            let text = args.to_string();
            for (p, kept) in &mut self.plan_files {
                let base = p.rsplit('/').next().unwrap_or(p);
                if text.contains(base) {
                    *kept = None;
                }
            }
        }
    }

    /// The plan a result submits: `write xd://propose` (details `xdev.tool` is `propose`, its `inner` names
    /// the plan file and title). `None` for any other.
    fn proposal_of(&self, name: &str, details: Option<&Value>) -> Option<ProposedPlan> {
        if name != "write" {
            return None;
        }
        let xdev = details?.get("xdev").filter(|x| x.is_object())?;
        if str_of(xdev, "tool") != Some("propose") || str_of(xdev, "mode") != Some("execute") {
            return None;
        }
        let inner = xdev.get("inner").filter(|i| i.is_object())?;
        let path = str_of(inner, "planFilePath")?;
        Some(ProposedPlan {
            title: str_of(inner, "title").unwrap_or("").to_owned(),
            markdown: self.plan_files.get(path).cloned().flatten(),
        })
    }

    fn tool_result(&mut self, m: &Value, at: Option<i64>) -> Vec<Update> {
        let Some(id) = nonempty_str(m, "toolCallId") else {
            return Vec::new();
        };
        if self.hidden.contains(id) {
            return Vec::new();
        }
        let is_error = is_true(m, "isError");
        let open = self.open.remove(id);
        let known = self.started.contains(id);
        self.started.insert(id.to_owned());
        let name = open
            .as_ref()
            .map(|o| o.name.clone())
            .unwrap_or_else(|| nonempty_str(m, "toolName").unwrap_or("tool").to_owned());
        let details = m.get("details").filter(|d| d.is_object());
        // A result after the proposal's own ends it; the proposal's result starts it.
        self.proposed = if is_error {
            None
        } else {
            self.proposal_of(&name, details)
        };

        // The change as the result reports it (real old text) wins over the one the call's arguments
        // implied; a failed call changed nothing.
        let mut content = Vec::new();
        if !is_error {
            let reported = self.result_diffs(details);
            if reported.is_empty() {
                if let Some(o) = &open {
                    content.extend(o.diffs.iter().cloned());
                }
            } else {
                content.extend(reported);
            }
        }
        let mut text = result_text(m.get("content"));
        // omp marks two answers as errors that are not: a call it skipped because a job finished or a
        // message queued meanwhile (`details.__interrupted`, or `source: interrupt_skipped` in the other
        // shape; the text says to retry), and a `wait` with nothing to wait for. Neither failed; shown as
        // failures they sat under the final answer of every turn.
        let skipped = is_error
            && details.is_some_and(|d| {
                is_true(d, "__interrupted") || str_of(d, "source") == Some("interrupt_skipped")
            });
        let idle = is_error
            && !skipped
            && name == "wait"
            && details.is_none_or(|d| d.as_object().is_some_and(Map::is_empty))
            && text.starts_with("Nothing to wait for");
        let status = if skipped {
            "cancelled"
        } else if is_error && !idle {
            "failed"
        } else {
            "completed"
        };
        if let Some(d) = details {
            self.note_background(id, &name, d, open.as_ref(), &text, at);
        }
        if name == "task" {
            self.note_task(details);
            // The roster says more than "Spawned agent ... NEVER poll".
            let names = task_result_names(details)
                .or_else(|| open.as_ref().map(|o| o.names.clone()))
                .unwrap_or_default();
            let roster = self.roster(&names);
            if !is_error && !roster.is_empty() {
                text = roster;
            }
        } else {
            self.note_jobs(details);
        }
        if !text.is_empty() {
            content.push(text_block(&cap_text(&text)));
        }

        let locations = self.locations_of_result(details);
        let mut fields = Map::new();
        fields.insert("toolCallId".into(), id.into());
        if !known {
            fields.insert("name".into(), name.as_str().into());
            fields.insert("title".into(), name.as_str().into());
            fields.insert("kind".into(), Kind::of(&name).wire().into());
        }
        fields.insert("status".into(), status.into());
        if skipped {
            fields.insert("_meta".into(), json!({"herdr": {"skipped": true}}));
        }
        fields.insert("content".into(), Value::Array(content));
        if !text.is_empty() {
            fields.insert("rawOutput".into(), cap_text(&text).into());
        }
        if !locations.is_empty() {
            fields.insert("locations".into(), Value::Array(locations));
        }
        if self.ask.as_ref().is_some_and(|a| a.tool_call_id == id) {
            self.ask = None;
        }
        let mut out = vec![Update::ToolPatch(Value::Object(fields))];
        if name == "todo"
            && !is_error
            && let Some(d) = details
            && let Some(plan) = plan_of(d.get("phases"))
        {
            out.push(plan);
        }
        out
    }

    /// Everything still running is cancelled (the turn was interrupted, failed or the process exited).
    fn cancel_open(&mut self) -> Vec<Update> {
        if self.open.is_empty() {
            return Vec::new();
        }
        let out = self
            .open
            .entries()
            .map(|(id, _)| cancelled_patch(id))
            .collect();
        self.open.clear();
        self.ask = None;
        out
    }

    // -- background work ------------------------------------------------------------------------------------

    fn note_background(
        &mut self,
        call_id: &str,
        tool: &str,
        details: &Value,
        open: Option<&OpenCall>,
        text: &str,
        at: Option<i64>,
    ) {
        if let Some(a) = details.get("async").filter(|a| a.is_object()) {
            let state = a.get("state");
            let job_id = str_of(a, "jobId");
            if state.and_then(Value::as_str) == Some("running") {
                self.start_jobs(call_id, tool, a, details, open, at);
            } else if let (Some(state), Some(job_id)) = (state.and_then(Value::as_str), job_id) {
                self.finish(job_id, background_status(state), at);
            }
        }
        let proc = details.get("proc").filter(|p| p.is_object());
        for root in std::iter::once(details).chain(proc) {
            if let Some(jobs) = list_of(root, "jobs") {
                for j in jobs.iter().filter(|j| j.is_object()) {
                    self.settle_job(j, at);
                }
            }
            if let Some(job) = root.get("job").filter(|j| j.is_object()) {
                self.settle_job(job, at);
            }
            if let Some(cancelled) = list_of(root, "cancelled") {
                for c in cancelled {
                    let Some(id) = str_of(c, "id") else { continue };
                    match str_of(c, "status") {
                        Some("cancelled") => self.finish(id, BackgroundStatus::Stopped, at),
                        Some("already_completed") => {
                            self.finish(id, BackgroundStatus::Finished, at)
                        }
                        _ => {}
                    }
                }
            }
        }
        if tool == "write" {
            for c in CANCELLED_TEXT.captures_iter(text) {
                if let Some(id) = c.get(1) {
                    self.finish(id.as_str(), BackgroundStatus::Stopped, at);
                }
            }
        }
    }

    /// A job of a `wait` or proc result: settled unless it still runs.
    fn settle_job(&mut self, j: &Value, at: Option<i64>) {
        let id = j
            .get("id")
            .filter(|v| !v.is_null())
            .or_else(|| j.get("jobId"));
        if let (Some(id), Some(status)) = (id.and_then(Value::as_str), str_of(j, "status"))
            && !still_running(status)
        {
            self.finish(id, background_status(status), at);
        }
    }

    /// The result of a call that went to the background: one task per job (a `task` call starts one per
    /// subagent, the result lists them all).
    fn start_jobs(
        &mut self,
        call_id: &str,
        tool: &str,
        a: &Value,
        details: &Value,
        open: Option<&OpenCall>,
        at: Option<i64>,
    ) {
        let kind_name = str_of(a, "type").unwrap_or(tool);
        let kind = match kind_name {
            "bash" => BackgroundKind::Shell,
            "eval" => BackgroundKind::Eval,
            "task" => BackgroundKind::Agent,
            _ => BackgroundKind::Other,
        };
        // `Duration(seconds: secs.round())`: a limit under one half second rounds to a zero deadline.
        let deadline_secs = details
            .get("timeoutSeconds")
            .and_then(Value::as_f64)
            .filter(|s| *s > 0.0)
            .map(|s| s.round() as u64);
        let mut starts: Vec<(String, String, Option<String>)> = Vec::new();
        if kind_name == "task"
            && let Some(progress) = list_of(details, "progress")
        {
            for p in progress {
                let Some(id) = nonempty_str(p, "id") else {
                    continue;
                };
                let what = match p.get("assignment") {
                    Some(Value::String(s)) => Some(s.as_str()),
                    _ => str_of(p, "task"),
                };
                let what = what
                    .map(str::trim)
                    .filter(|w| !w.is_empty())
                    .map(|w| cut_text(w, ASSIGNMENT_CHARS));
                starts.push((id.to_owned(), id.to_owned(), what));
            }
        }
        if starts.is_empty()
            && let Some(job_id) = nonempty_str(a, "jobId")
        {
            let command = open
                .and_then(|o| o.command.as_deref())
                .map_or("", str::trim);
            starts.push((
                job_id.to_owned(),
                if command.is_empty() {
                    job_id.to_owned()
                } else {
                    cut_text(first_line(command), TITLE_CHARS)
                },
                (!command.is_empty()).then(|| cap_text(command)),
            ));
        }
        for (id, title, detail) in starts {
            self.put(BackgroundTask {
                id,
                epoch: self.bg_epoch,
                kind,
                status: BackgroundStatus::Running,
                title,
                detail,
                started_ms: at,
                ended_ms: None,
                deadline_secs,
                tool_call_id: Some(call_id.to_owned()),
                stop: StopRoute::Message,
            });
        }
    }

    /// An `async-result` notice: the jobs it names ended. It has a status for a subagent; for a shell job the
    /// text decides between done and failed.
    fn async_result(&mut self, e: &Value) {
        let Some(jobs) = e.get("details").and_then(|d| list_of(d, "jobs")) else {
            return;
        };
        let ids: Vec<&str> = jobs.iter().filter_map(|j| str_of(j, "jobId")).collect();
        let text = result_text(e.get("content"));
        let bodies = job_bodies(&text, &ids);
        let at = parse_stamp(e);
        for j in jobs {
            let Some(id) = str_of(j, "jobId") else {
                continue;
            };
            if let Some(status) = str_of(j, "status") {
                if !still_running(status) {
                    self.finish(id, background_status(status), at);
                }
            } else {
                let failed = FAILED_TEXT.is_match(bodies.get(id).copied().unwrap_or(""));
                let status = if failed {
                    BackgroundStatus::Failed
                } else {
                    BackgroundStatus::Finished
                };
                self.finish(id, status, at);
            }
        }
    }

    /// The process ended: what ran is gone and the next process counts ids from the start again.
    fn exit_session(&mut self, at: Option<i64>) {
        for t in self.tasks.items.values_mut().map(|(_, t)| t) {
            if t.status.is_active() {
                t.status = BackgroundStatus::Stopped;
                t.ended_ms = at;
                t.stop = StopRoute::None;
            }
        }
        self.bg_epoch += 1;
        self.tasks_changed();
    }

    fn put(&mut self, t: BackgroundTask) {
        let key = t.key();
        self.tasks.remove(&key);
        self.tasks.insert(&key, t);
        self.tasks_changed();
    }

    /// A task was added or ended: keeps the latest [`FINISHED_KEPT`] finished tasks (the running ones always
    /// stay).
    fn tasks_changed(&mut self) {
        let finished = self
            .tasks
            .values()
            .filter(|x| !x.status.is_active())
            .count();
        let Some(extra) = finished.checked_sub(FINISHED_KEPT).filter(|e| *e > 0) else {
            return;
        };
        let drop: Vec<String> = self
            .tasks
            .entries()
            .filter(|(_, x)| !x.status.is_active())
            .take(extra)
            .map(|(k, _)| k.to_owned())
            .collect();
        for k in drop {
            self.tasks.remove(&k);
        }
    }

    /// `id` of the current epoch ended as `status`; a task that is not running (unknown, or already ended) is
    /// left alone.
    fn finish(&mut self, id: &str, status: BackgroundStatus, at: Option<i64>) {
        let key = format!("{}/{id}", self.bg_epoch);
        let Some(idx) = self.tasks.index.get(&key).copied() else {
            return;
        };
        let Some((_, t)) = self.tasks.items.get_mut(&idx) else {
            return;
        };
        if !t.status.is_active() {
            return;
        }
        t.status = status;
        t.ended_ms = at;
        t.stop = StopRoute::None;
        self.tasks_changed();
    }

    // -- subagents and messages between agents --------------------------------------------------------------

    /// The names a `task` call spawns; each becomes a pending subagent unless it is known already.
    fn task_names(&mut self, args: Option<&Value>) -> Vec<String> {
        let Some(tasks) = args.and_then(|a| list_of(a, "tasks")) else {
            return Vec::new();
        };
        let mut names = Vec::new();
        for t in tasks {
            let Some(name) = nonempty_str(t, "name") else {
                continue;
            };
            names.push(name.to_owned());
            if !self.subagents.contains(name) {
                let mut info = SubagentInfo::new(name);
                info.agent = str_of(t, "agent").unwrap_or("task").to_owned();
                info.assignment =
                    str_of(t, "task").map_or_else(String::new, |a| cut_text(a, ASSIGNMENT_CHARS));
                self.subagents.insert(name, info);
            }
        }
        names
    }

    fn note_task(&mut self, details: Option<&Value>) {
        let Some(progress) = details.and_then(|d| list_of(d, "progress")) else {
            return;
        };
        for p in progress {
            let Some(name) = nonempty_str(p, "id") else {
                continue;
            };
            let old = self.subagents.get(name);
            let assignment = match p.get("assignment") {
                Some(Value::String(s)) => Some(s.as_str()),
                _ => str_of(p, "task"),
            };
            let info = SubagentInfo {
                name: name.to_owned(),
                agent: str_of(p, "agent")
                    .map(str::to_owned)
                    .or_else(|| old.map(|o| o.agent.clone()))
                    .unwrap_or_default(),
                status: str_of(p, "status")
                    .map(str::to_owned)
                    .or_else(|| old.map(|o| o.status.clone()))
                    .unwrap_or_else(|| "pending".to_owned()),
                assignment: assignment
                    .map(|a| cut_text(a, ASSIGNMENT_CHARS))
                    .or_else(|| old.map(|o| o.assignment.clone()))
                    .unwrap_or_default(),
                tool_count: p
                    .get("toolCount")
                    .and_then(Value::as_f64)
                    .map(|c| c as usize)
                    .or_else(|| old.map(|o| o.tool_count))
                    .unwrap_or(0),
                recent_tools: tool_names(p.get("recentTools"))
                    .or_else(|| old.map(|o| o.recent_tools.clone()))
                    .unwrap_or_default(),
                log_id: None,
                call_id: None,
            };
            self.subagents.insert(name, info);
        }
    }

    /// A background-jobs snapshot reports the state of jobs, subagents among them: `wait` lists them under
    /// `jobs`, a `write` to `proc://<id>/kill` under `proc.jobs` and `proc.cancelled`. Observed once: three
    /// scouts failed, were killed, and the roster said done, because only `wait` was read and their empty
    /// result file counted as success.
    fn note_jobs(&mut self, details: Option<&Value>) {
        let Some(details) = details else { return };
        let proc = details.get("proc").filter(|p| p.is_object());
        for root in std::iter::once(details).chain(proc) {
            if let Some(jobs) = list_of(root, "jobs") {
                for j in jobs {
                    let (Some(id), Some(status)) = (str_of(j, "id"), str_of(j, "status")) else {
                        continue;
                    };
                    if self.subagents.contains(id) || str_of(j, "type") == Some("task") {
                        self.set_status(id, status);
                    }
                }
            }
            // A kill of a subagent that had already failed or finished keeps that ending: the snapshot's
            // `jobs` said it first, and it says why.
            if let Some(cancelled) = list_of(root, "cancelled") {
                for c in cancelled {
                    if str_of(c, "status") != Some("cancelled") {
                        continue;
                    }
                    let Some(id) = str_of(c, "id") else { continue };
                    let Some(old) = self.subagents.get(id) else {
                        continue;
                    };
                    if old.status == "failed" || old.status == "completed" {
                        continue;
                    }
                    self.set_status(id, "aborted");
                }
            }
        }
    }

    /// An `async-result` notice: background jobs that finished.
    fn jobs_finished(&mut self, details: Option<&Value>) {
        let Some(jobs) = details.and_then(|d| list_of(d, "jobs")) else {
            return;
        };
        for j in jobs {
            if str_of(j, "type") != Some("task") {
                continue;
            }
            if let Some(id) = nonempty_str(j, "jobId") {
                self.set_status(id, str_of(j, "status").unwrap_or("completed"));
            }
        }
    }

    fn set_status(&mut self, name: &str, status: &str) {
        let old = self.subagents.get(name);
        let info = SubagentInfo {
            name: name.to_owned(),
            agent: old.map(|o| o.agent.clone()).unwrap_or_default(),
            status: status.to_owned(),
            assignment: old.map(|o| o.assignment.clone()).unwrap_or_default(),
            tool_count: old.map_or(0, |o| o.tool_count),
            recent_tools: old.map(|o| o.recent_tools.clone()).unwrap_or_default(),
            log_id: None,
            call_id: None,
        };
        self.subagents.insert(name, info);
    }

    /// One line per subagent: `Name (agent): status, what it was asked`.
    fn roster(&self, names: &[String]) -> String {
        let lines: Vec<String> = names
            .iter()
            .map(|name| {
                let Some(s) = self.subagents.get(name) else {
                    return name.clone();
                };
                let what = first_line(s.assignment.trim());
                let agent = if s.agent.is_empty() {
                    String::new()
                } else {
                    format!(" ({})", s.agent)
                };
                let asked = if what.is_empty() {
                    String::new()
                } else {
                    format!(" - {}", cut_text(what, 100))
                };
                format!("{}{agent}: {}{asked}", s.name, s.status)
            })
            .collect();
        lines.join("\n")
    }

    /// A message another agent sent to the observed one.
    fn irc_incoming(&mut self, e: &Value, line: &str) -> Vec<Update> {
        let Some(d) = e.get("details").filter(|d| d.is_object()) else {
            return Vec::new();
        };
        let Some(msg) = str_of(d, "message").filter(|m| !m.trim().is_empty()) else {
            return Vec::new();
        };
        let Some(key) = self.first_time(e, line) else {
            return Vec::new();
        };
        let who = str_of(d, "from")
            .filter(|f| !f.is_empty())
            .map_or_else(|| "another agent".to_owned(), |f| cut_text(f, 80));
        vec![message(
            Role::Agent,
            &key,
            &format!(
                "{who} → this agent: {}",
                cut_text(msg.trim(), ASSIGNMENT_CHARS)
            ),
        )]
    }

    /// A `write` to `agent://<name>` is a message to another agent: a note, not a tool row. `None` when `b`
    /// is something else.
    fn agent_write(&mut self, b: &Value, note_id: &str) -> Option<Update> {
        if str_of(b, "name") != Some("write") {
            return None;
        }
        let id = nonempty_str(b, "id")?;
        let args = arguments(b.get("arguments"))?;
        let to = str_of(&args, "path")?.strip_prefix("agent://")?;
        let content = str_of(&args, "content")?;
        self.hidden.insert(id.to_owned());
        let to = if to == "all" {
            "all agents".to_owned()
        } else {
            cut_text(to, 80)
        };
        Some(message(
            Role::Agent,
            note_id,
            &format!(
                "this agent → {to}: {}",
                cut_text(content.trim(), ASSIGNMENT_CHARS)
            ),
        ))
    }

    // -- paths, locations, diffs ----------------------------------------------------------------------------

    fn abs(&self, path: &str) -> String {
        let Some(cwd) = &self.cwd else {
            return path.to_owned();
        };
        if path.starts_with('/') || SCHEME.is_match(path) {
            return path.to_owned();
        }
        let rel = path.strip_prefix("./").unwrap_or(path);
        if cwd.ends_with('/') {
            format!("{cwd}{rel}")
        } else {
            format!("{cwd}/{rel}")
        }
    }

    fn locations_of_call(&self, name: &str, args: Option<&Value>) -> Vec<Value> {
        let Some(args) = args else {
            return Vec::new();
        };
        let mut out: Vec<(String, Option<u64>)> = Vec::new();
        let mut add = |raw: Option<&str>, line: Option<u64>| {
            let Some(raw) = raw.filter(|r| !r.is_empty() && !SCHEME.is_match(r)) else {
                return;
            };
            let p = self.abs(raw);
            if !out.iter().any(|(q, _)| *q == p) {
                out.push((p, line));
            }
        };
        let path = str_of(args, "path");
        match path {
            Some(path) if name == "read" => match READ_SELECTOR.captures(path) {
                Some(m) => add(m.get(1).map(|g| g.as_str()), m[2].parse().ok()),
                None => add(Some(path), None),
            },
            _ => add(path, None),
        }
        add(str_of(args, "oldPath"), None);
        add(str_of(args, "newPath"), None);
        if let Some(input) = str_of(args, "input")
            && Kind::of(name) == Kind::Edit
        {
            for h in HASHLINE_HEADER.captures_iter(input) {
                add(h.get(1).map(|g| g.as_str()), None);
            }
        }
        out.into_iter()
            .map(|(path, line)| match line {
                Some(line) => json!({"path": path, "line": line}),
                None => json!({"path": path}),
            })
            .collect()
    }

    fn locations_of_result(&self, details: Option<&Value>) -> Vec<Value> {
        let Some(details) = details else {
            return Vec::new();
        };
        let mut out: Vec<String> = Vec::new();
        let mut add = |raw: Option<&str>| {
            let Some(raw) = raw.filter(|r| !r.is_empty() && !SCHEME.is_match(r)) else {
                return;
            };
            let p = self.abs(raw);
            if !out.contains(&p) {
                out.push(p);
            }
        };
        add(str_of(details, "path"));
        add(str_of(details, "resolvedPath"));
        if let Some(per) = list_of(details, "perFileResults") {
            for f in per.iter().filter(|f| f.is_object()) {
                add(str_of(f, "path"));
            }
        }
        out.into_iter().map(|p| json!({"path": p})).collect()
    }

    /// The change a call's arguments describe: a `write` (new text only), or an edit that names the old and
    /// the new text. Hashline and patch edits carry neither; their result does.
    fn start_diffs(&self, name: &str, args: Option<&Value>) -> Vec<Value> {
        const PAIRS: [(&str, &str); 3] = [
            ("old_string", "new_string"),
            ("oldText", "newText"),
            ("old_text", "new_text"),
        ];
        let Some(args) = args else {
            return Vec::new();
        };
        let Some(path) = nonempty_str(args, "path") else {
            return Vec::new();
        };
        if name == "write"
            && let Some(content) = str_of(args, "content")
        {
            return vec![diff_block(&self.abs(path), None, &cap_text(content))];
        }
        if Kind::of(name) != Kind::Edit {
            return Vec::new();
        }
        let one = |holder: &Value, from: &str, to: &str| -> Option<Value> {
            Some(diff_block(
                &self.abs(path),
                Some(&cap_text(str_of(holder, from)?)),
                &cap_text(str_of(holder, to)?),
            ))
        };
        let mut out: Vec<Value> = PAIRS.iter().filter_map(|(f, t)| one(args, f, t)).collect();
        if let Some(edits) = list_of(args, "edits") {
            for e in edits.iter().filter(|e| e.is_object()) {
                out.extend(PAIRS.iter().filter_map(|(f, t)| one(e, f, t)));
            }
        }
        out
    }

    /// The changes an edit result reports, one per file.
    fn result_diffs(&self, details: Option<&Value>) -> Vec<Value> {
        let Some(details) = details else {
            return Vec::new();
        };
        let entries: Vec<&Value> = match list_of(details, "perFileResults") {
            Some(per) => per.iter().collect(),
            None => vec![details],
        };
        let mut out = Vec::new();
        for e in entries {
            if !e.is_object() || is_true(e, "isError") {
                continue;
            }
            let Some(path) = nonempty_str(e, "path") else {
                continue;
            };
            let from = str_of(e, "oldText");
            let to = str_of(e, "newText");
            if from.is_none() && to.is_none() {
                continue;
            }
            out.push(diff_block(
                &self.abs(path),
                from.map(cap_text).as_deref(),
                &to.map(cap_text).unwrap_or_default(),
            ));
        }
        out
    }
}

fn title_update(title: Option<&Value>) -> Vec<Update> {
    let Some(t) = title
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
    else {
        return Vec::new();
    };
    vec![Update::Title(Some(cut_text(t, 200)))]
}

fn add_text(out: &mut Vec<Update>, role: Role, id: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    out.push(message(role, id, text));
}

/// A `!` command or `$` snippet the person ran in the terminal: one finished tool call.
fn user_run(key: &str, m: &Value, input_key: &str, name: &str) -> Update {
    let source = str_of(m, input_key).unwrap_or("");
    let output = str_of(m, "output").unwrap_or("");
    let failed = m
        .get("exitCode")
        .and_then(Value::as_f64)
        .is_some_and(|c| c != 0.0);
    let status = if is_true(m, "cancelled") {
        "cancelled"
    } else if failed {
        "failed"
    } else {
        "completed"
    };
    let content = if output.is_empty() {
        Vec::new()
    } else {
        vec![text_block(&cap_text(output))]
    };
    Update::ToolStart(json!({
        "toolCallId": format!("run:{key}"),
        "name": name,
        "title": cut_text(first_line(source), TITLE_CHARS),
        "kind": Kind::Execute.wire(),
        "status": status,
        "rawInput": {input_key: cap_text(source)},
        "content": content,
    }))
}

/// The text a `bash` call runs or an `eval` call evaluates.
fn command_of(args: Option<&Value>) -> Option<&str> {
    let args = args?;
    args.get("command")
        .filter(|c| !c.is_null())
        .or_else(|| args.get("code"))
        .and_then(Value::as_str)
}

/// The subagents a `task` result's progress lists, or `None` when it lists none.
fn task_result_names(details: Option<&Value>) -> Option<Vec<String>> {
    let progress = list_of(details?, "progress")?;
    let names: Vec<String> = progress
        .iter()
        .filter_map(|p| nonempty_str(p, "id"))
        .map(str::to_owned)
        .collect();
    (!names.is_empty()).then_some(names)
}

/// The call's own words (`intent` / `i`), else what it works on.
fn tool_title(name: &str, args: Option<&Value>, intent: Option<&str>) -> String {
    let i = intent.map_or("", |i| first_line(i.trim()));
    if !i.is_empty() {
        return cut_text(i, TITLE_CHARS);
    }
    let str_arg = |key: &str| -> Option<&str> {
        args.and_then(|a| str_of(a, key))
            .filter(|s| !s.trim().is_empty())
    };
    let command = str_arg("command");
    if Kind::of(name) == Kind::Execute
        && let Some(command) = command
    {
        return cut_text(first_line(command.trim()), TITLE_CHARS);
    }
    if name == "ask"
        && let Some(q) = args
            .and_then(|a| list_of(a, "questions"))
            .and_then(|qs| qs.first())
            .and_then(|q| str_of(q, "question"))
    {
        return cut_text(first_line(q.trim()), TITLE_CHARS);
    }
    let subject = str_arg("path")
        .or(command)
        .or_else(|| str_arg("pattern"))
        .or_else(|| str_arg("query"));
    match subject {
        Some(subject) => cut_text(
            &format!("{name}: {}", first_line(subject.trim())),
            TITLE_CHARS,
        ),
        None => name.to_owned(),
    }
}

// -- the question tool ----------------------------------------------------------------------------------------

fn parse_ask(id: &str, args: Option<&Value>) -> Option<PendingAsk> {
    let qs = list_of(args?, "questions")?;
    let mut out = Vec::new();
    for (i, q) in qs.iter().enumerate() {
        if !q.is_object() {
            continue;
        }
        let mut options = Vec::new();
        if let Some(raw) = list_of(q, "options") {
            for o in raw {
                match o {
                    Value::String(s) => options.push(AskOption {
                        label: cut_text(s, 300),
                        description: String::new(),
                    }),
                    Value::Object(_) => {
                        if let Some(label) = str_of(o, "label") {
                            options.push(AskOption {
                                label: cut_text(label, 300),
                                description: str_of(o, "description")
                                    .map_or_else(String::new, cap_text),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        let recommended = q
            .get("recommended")
            .and_then(Value::as_f64)
            .filter(|r| *r >= 0.0 && *r < options.len() as f64)
            .map(|r| r as usize);
        out.push(AskQuestion {
            id: nonempty_str(q, "id").map_or_else(|| format!("q{i}"), str::to_owned),
            question: str_of(q, "question").map_or_else(String::new, cap_text),
            options,
            multi: is_true(q, "multi"),
            recommended,
        });
    }
    (!out.is_empty()).then(|| PendingAsk {
        tool_call_id: id.to_owned(),
        questions: out,
    })
}
