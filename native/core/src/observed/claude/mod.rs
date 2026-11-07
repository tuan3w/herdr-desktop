//! Claude Code's session log (`~/.claude/projects/<cwd>/<sessionId>.jsonl`) as [`Update`]s: a port of
//! herdr-mobile's `claude_log_mapper.dart`, so that a Claude Code turn reads in the desktop app the way the
//! same turn of an ACP session does.
//!
//! What the log looks like (Claude Code 2.1): one JSON object per line, in the order the file was written. An
//! API message is split into one line per content block (same `message.id`, `apiBlockIndex` 0..N-1), a tool
//! call is written before the tool finishes, and each tool result is a line of its own that pairs with its
//! call only by `tool_use_id`. `parentUuid` is not a chain and timestamps are not monotonic: only the file
//! order is used.
//!
//! Lines read (everything else maps to nothing, and so does anything malformed):
//! - `assistant`: `text`, `thinking` (only when it holds text: the log keeps only an opaque signature) and
//!   `tool_use` blocks; a synthetic API error;
//! - `user`: the person's prompt, a slash command, a `tool_result`, the `[Request interrupted by user]`
//!   marker, a background task's `<task-notification>`; housekeeping (`isMeta`, caveats, reminders, a
//!   non-human `origin`) stays hidden;
//! - `attachment`: `queued_command` (a prompt typed while a turn ran) and `skill_listing` (the session's
//!   commands);
//! - `system`: `turn_duration` (the turn is over), `compact_boundary`, `local_command`, `informational`;
//! - `queue-operation` `enqueue`, `ai-title` and `custom-title`.
//!
//! A subagent's transcript (`<session>/subagents/agent-<id>.jsonl`, see [`subagent_log_path`]) has the same
//! format with `isSidechain: true` on every line: the main file's mapper skips those lines, a mapper made
//! with `sidechain: true` maps only them.
//!
//! Idempotent: a line is mapped once (its `uuid`, else a hash of the line), a message is a whole-message
//! upsert, a tool call is keyed by its id and patches replace, so the same file fed twice (a resume that
//! overlaps, a reconnect) changes nothing. Reset the mapper together with the state it feeds.
//!
//! Deviations from the Dart: lengths and cuts count characters, not UTF-16 units; times are milliseconds
//! since the epoch ([`parse_stamp`]) instead of `DateTime`; what a tool printed is in the call's `content`
//! text and, as in Dart, in `rawOutput` (Claude has no terminal-output `_meta`, so nothing moved there).

use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::model::{
    AskOption, AskQuestion, BackgroundKind, BackgroundStatus, BackgroundTask, LogImage, LogMapper,
    PendingAsk, PlanStatus, PlanStep, ProposedPlan, Role, SlashCommand, StopRoute, SubagentInfo,
    Update, cancelled_patch, cap_json, cap_text, cut_text, first_line, fnv, message,
    parse_keeper_marker, parse_stamp, user_message, with_image_markers,
};

mod subagents;
pub use subagents::{
    MAX_META_BYTES, is_agent_id, meta_agent_id, meta_tool_use_id, subagent_dir, subagent_log_path,
    subagent_log_path_for,
};

#[cfg(test)]
mod tests;

const TITLE_CHARS: usize = 120;
const ASSIGNMENT_CHARS: usize = 400;
const FINISHED_KEPT: usize = 30;

/// The slash commands whose echo says nothing the chat does not show better: `/clear` starts a new session
/// (its file opens with this echo, so every fresh chat would begin with "/clear"); `/rename` is the title.
const HOUSEKEEPING: [&str; 2] = ["/clear", "/rename"];

static TEAMMATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^<teammate-message\s+teammate_id="([^"]+)"([^>]*)>([\s\S]*?)</teammate-message>"#)
        .expect("static pattern")
});
static SUMMARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"summary="([^"]*)""#).expect("static pattern"));
static TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^<>]{1,200}>").expect("static pattern"));
static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("\u{1b}\\[[0-9;]*[A-Za-z]").expect("static pattern"));
/// `- name: description` per skill; a name may hold `:` (`plugin:skill`) but never `: `.
static SKILL_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^- (.+?): (.*)$").expect("static pattern"));
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.-]*://").expect("static pattern"));
static COPY_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" \([0-9]+\)$").expect("static pattern"));

/// Maps the lines of a Claude Code session log. One per session; see the module docs.
pub struct ClaudeMapper {
    /// Maps a subagent's transcript instead of the main file.
    sidechain: bool,
    /// Line ids already mapped.
    seen: HashSet<String>,
    /// Every tool call id that started, so that a result for an unseen start (a log followed from the
    /// middle) can name the call itself.
    started: HashSet<String>,
    /// Calls that started and have no result yet.
    open: Ordered<OpenCall>,
    /// Calls that are not shown (their results are dropped).
    hidden: HashSet<String>,
    ask: Option<PendingAsk>,
    cwd: Option<String>,
    last_typed: Option<String>,
    custom_titled: bool,
    /// Prompts shown when they were typed, waiting for their second record.
    queued: HashSet<String>,
    turn_ended: bool,
    /// The task list as `TaskCreate` and `TaskUpdate` build it: id -> task.
    task_list: Ordered<Task>,
    /// Subagents by call id, in the order they started.
    subagents: Ordered<SubagentInfo>,
    /// Background tasks by [`BackgroundTask::key`], in the order they started.
    tasks: Ordered<BackgroundTask>,
    /// The skills Claude lists for the session (user, project, plugin and bundled ones), by name, in the
    /// order listed.
    skills: Ordered<SlashCommand>,
}

impl ClaudeMapper {
    /// A mapper of the main log (`sidechain: false`) or of one subagent's transcript (`true`).
    pub fn new(sidechain: bool) -> Self {
        Self {
            sidechain,
            seen: HashSet::new(),
            started: HashSet::new(),
            open: Ordered::new(),
            hidden: HashSet::new(),
            ask: None,
            cwd: None,
            last_typed: None,
            custom_titled: false,
            queued: HashSet::new(),
            turn_ended: false,
            task_list: Ordered::new(),
            subagents: Ordered::new(),
            tasks: Ordered::new(),
            skills: Ordered::new(),
        }
    }
}

impl Default for ClaudeMapper {
    /// A mapper of the main log.
    fn default() -> Self {
        Self::new(false)
    }
}

/// A new mapper of a session's main log.
pub fn new_mapper() -> Box<dyn LogMapper> {
    Box::new(ClaudeMapper::new(false))
}

/// A new mapper of a subagent's transcript (`agent-<id>.jsonl`).
pub fn new_sidechain_mapper() -> Box<dyn LogMapper> {
    Box::new(ClaudeMapper::new(true))
}

/// The message that asks Claude Code to stop background tasks `ids` (its `TaskStop` tool). `None` when there
/// is nothing to ask or an id is not a plain token: ids come from a log and go into a message to the agent.
pub fn stop_message<'a>(ids: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let list: Vec<&str> = ids.into_iter().collect();
    if list.is_empty() || !list.iter().all(|id| is_safe_id(id)) {
        return None;
    }
    let noun = if list.len() == 1 { "task" } else { "tasks" };
    Some(format!(
        "Stop these background {noun} now: {}. Use TaskStop. Do nothing else.",
        list.join(", ")
    ))
}

// -- small helpers ------------------------------------------------------------------------------------

/// Insertion-ordered map with replace-in-place on insert, like Dart's `Map`. Tiny: the biggest holds the
/// calls of one turn.
struct Ordered<V>(Vec<(String, V)>);

impl<V> Ordered<V> {
    fn new() -> Self {
        Self(Vec::new())
    }
    fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    /// Replaces the value of an existing key where it stands; appends a new one.
    fn insert(&mut self, key: String, value: V) {
        match self.get_mut(&key) {
            Some(slot) => *slot = value,
            None => self.0.push((key, value)),
        }
    }
    fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(at).1)
    }
    fn values(&self) -> impl Iterator<Item = &V> {
        self.0.iter().map(|(_, v)| v)
    }
    fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    fn clear(&mut self) {
        self.0.clear();
    }
    fn retain(&mut self, mut keep: impl FnMut(&V) -> bool) {
        self.0.retain(|(_, v)| keep(v));
    }
}

/// Dart's `String.trim` strips U+FEFF too.
fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_space)
}

/// `v[key]` when it is a string.
fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

/// `v[key]` when it is a string that holds something besides whitespace.
fn non_blank<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    str_of(v, key).filter(|s| !trim(s).is_empty())
}

fn is_true(v: &Value, key: &str) -> bool {
    v.get(key) == Some(&Value::Bool(true))
}

fn object(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| v.is_object())
}

/// A JSON scalar as Dart interpolates it (`'$id'`).
fn dart_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// An id Claude gave a background task or an agent, safe to put in a message to Claude.
fn is_safe_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// A skill's name: `plugin:skill` is one.
fn is_skill_name(n: &str) -> bool {
    (1..=64).contains(&n.len())
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-'))
}

/// `s` without its XML-ish tags, trimmed.
fn strip_tags(s: &str) -> String {
    trim(&TAG.replace_all(s, "")).to_owned()
}

/// The trimmed text between `<tag>` and the first `</tag>` after it.
fn between(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let from = s.find(&open)? + open.len();
    let len = s[from..].find(&format!("</{tag}>"))?;
    Some(trim(&s[from..from + len]).to_owned())
}

/// A string, or the text blocks of a content list joined. A block that is only a `<system-reminder>` is
/// Claude's own context, not the person's words: it must not hide the prompt that comes with it.
fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| str_of(b, "type") == Some("text"))
            .filter_map(|b| str_of(b, "text"))
            .filter(|t| !trim_start(t).starts_with("<system-reminder>"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// How many pictures a content list carries.
fn images_of(content: Option<&Value>) -> usize {
    match content {
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| str_of(b, "type") == Some("image"))
            .count(),
        _ => 0,
    }
}

/// The pictures of a content list that can be fetched later: an `image` block whose `source.data` is the
/// keeper's note with a reference.
fn pictures(content: Option<&Value>) -> Vec<LogImage> {
    let Some(Value::Array(blocks)) = content else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| str_of(b, "type") == Some("image"))
        .filter_map(|b| {
            let source = object(b.get("source"))?;
            let reference = parse_keeper_marker(str_of(source, "data")?)?;
            Some(LogImage {
                mime: str_of(source, "media_type").unwrap_or("").to_owned(),
                source: reference,
            })
        })
        .collect()
}

/// What a tool printed, from a `tool_result`'s `content`.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| match str_of(p, "type") {
                Some("text") => str_of(p, "text").map(str::to_owned),
                Some("image") => Some("[image]".to_owned()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn plan_status(s: Option<&Value>) -> PlanStatus {
    match s.and_then(Value::as_str) {
        Some("in_progress") => PlanStatus::InProgress,
        Some("completed") => PlanStatus::Completed,
        _ => PlanStatus::Pending,
    }
}

/// The ACP kind of a tool.
fn kind_of(name: &str) -> &'static str {
    match name {
        "Bash" | "BashOutput" => "execute",
        "Read" | "NotebookRead" => "read",
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => "edit",
        "Grep" | "Glob" | "LS" => "search",
        "WebFetch" | "WebSearch" => "fetch",
        "ExitPlanMode" => "switch_mode",
        "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet" => "think",
        _ => "other",
    }
}

/// The host of `url` as Dart's `Uri.tryParse(url).host`; `url` itself when it has none (no `scheme://`, an
/// empty authority, an unparseable port). A port is dropped, userinfo too, the name is lower-cased and a
/// space or non-ASCII character is percent-encoded, as `Uri` does. (Percent escapes of unreserved
/// characters in a host are not decoded: no tool input has one.)
fn host_of(url: &str) -> String {
    let Some(scheme) = SCHEME.find(url) else {
        return url.to_owned();
    };
    let rest = &url[scheme.end()..];
    let authority = rest.split(['/', '\\', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = if let Some(inner) = host_port.strip_prefix('[') {
        match inner.split_once(']') {
            Some((host, after)) if after.is_empty() || after.starts_with(':') => host,
            _ => return url.to_owned(),
        }
    } else {
        match host_port.rsplit_once(':') {
            Some((host, port)) if port.bytes().all(|b| b.is_ascii_digit()) => host,
            Some(_) => return url.to_owned(),
            None => host_port,
        }
    };
    if host.is_empty() {
        return url.to_owned();
    }
    let mut out = String::new();
    for c in host.chars() {
        if c == ' ' || !c.is_ascii() {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        } else {
            out.push(c.to_ascii_lowercase());
        }
    }
    out
}

/// The call's own description (a `Bash`'s), else the tool and what it works on.
fn call_title(name: &str, input: Option<&Value>) -> String {
    let str_key = |key: &str| input.and_then(|i| non_blank(i, key));
    if name.starts_with("mcp__") {
        let parts: Vec<&str> = name.split("__").collect();
        if parts.len() >= 3 {
            return cut_text(
                &format!("{}: {}", parts[1], parts[2..].join("__")),
                TITLE_CHARS,
            );
        }
    }
    match name {
        "Bash" => {
            if let Some(d) = str_key("description") {
                return cut_text(first_line(trim(d)), TITLE_CHARS);
            }
            return match str_key("command") {
                Some(c) => cut_text(first_line(trim(c)), TITLE_CHARS),
                None => name.to_owned(),
            };
        }
        "AskUserQuestion" => {
            if let Some(Value::Array(qs)) = input.and_then(|i| i.get("questions"))
                && let Some(q) = qs.first().and_then(|q| str_of(q, "question"))
            {
                return cut_text(first_line(trim(q)), TITLE_CHARS);
            }
            return name.to_owned();
        }
        "ExitPlanMode" => return "Plan for approval".to_owned(),
        "TodoWrite" => return "Task list".to_owned(),
        "TaskUpdate" => {
            let id = input.and_then(|i| i.get("taskId")).filter(|v| !v.is_null());
            let status = str_key("status");
            return match id {
                None => name.to_owned(),
                Some(id) => format!(
                    "Task #{}{}",
                    dart_str(id),
                    status.map_or(String::new(), |s| format!(": {}", s.replace('_', " ")))
                ),
            };
        }
        _ => {}
    }
    let path = str_key("file_path")
        .or_else(|| str_key("path"))
        .or_else(|| str_key("notebook_path"));
    let subject: Option<String> = match path {
        Some(p) => Some(
            p.split('/')
                .rfind(|s| !s.is_empty())
                .unwrap_or(p)
                .to_owned(),
        ),
        None => str_key("pattern")
            .map(str::to_owned)
            .or_else(|| str_key("url").map(host_of))
            .or_else(|| str_key("query").map(str::to_owned))
            .or_else(|| str_key("skill").map(str::to_owned))
            .or_else(|| str_key("subject").map(str::to_owned))
            .or_else(|| str_key("description").map(str::to_owned)),
    };
    match subject {
        None => name.to_owned(),
        Some(s) => cut_text(&format!("{name}: {}", first_line(trim(&s))), TITLE_CHARS),
    }
}

/// Claude adds its own "Other" row to every question: not one of ours.
fn parse_ask(id: &str, input: Option<&Value>) -> Option<PendingAsk> {
    let Some(Value::Array(qs)) = input.and_then(|i| i.get("questions")) else {
        return None;
    };
    let mut questions = Vec::new();
    for (i, q) in qs.iter().enumerate() {
        if !q.is_object() {
            continue;
        }
        let mut options = Vec::new();
        if let Some(Value::Array(raw)) = q.get("options") {
            for o in raw {
                if let Some(label) = o.as_str() {
                    options.push(AskOption {
                        label: cut_text(label, 300),
                        description: String::new(),
                    });
                } else if let Some(label) = str_of(o, "label") {
                    options.push(AskOption {
                        label: cut_text(label, 300),
                        description: str_of(o, "description").map(cap_text).unwrap_or_default(),
                    });
                }
            }
        }
        questions.push(AskQuestion {
            id: match str_of(q, "header") {
                Some(h) if !h.is_empty() => h.to_owned(),
                _ => format!("q{i}"),
            },
            question: str_of(q, "question").map(cap_text).unwrap_or_default(),
            options,
            multi: is_true(q, "multiSelect"),
            recommended: None,
        });
    }
    (!questions.is_empty()).then(|| PendingAsk {
        tool_call_id: id.to_owned(),
        questions,
    })
}

/// The plan from `TodoWrite`'s `todos`; `None` when it is not a list.
fn todo_plan(todos: Option<&Value>) -> Option<Vec<PlanStep>> {
    let Some(Value::Array(todos)) = todos else {
        return None;
    };
    Some(
        todos
            .iter()
            .filter_map(|t| {
                let content = str_of(t, "content").filter(|c| !c.is_empty())?;
                Some(PlanStep {
                    content: cut_text(content, 300),
                    status: plan_status(t.get("status")),
                })
            })
            .collect(),
    )
}

/// A file change a call described: an `Edit` or `MultiEdit` (old and new text) or a `Write` (new text only;
/// the old comes with the result).
#[derive(Clone)]
struct Diff {
    path: String,
    old: Option<String>,
    new: String,
}

impl Diff {
    fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("type".into(), json!("diff"));
        o.insert("path".into(), json!(self.path));
        if let Some(old) = &self.old {
            o.insert("oldText".into(), json!(old));
        }
        o.insert("newText".into(), json!(self.new));
        Value::Object(o)
    }
}

struct OpenCall {
    name: String,
    /// The change the call's input described, kept until the result.
    diffs: Vec<Diff>,
    input: Option<Value>,
}

struct Task {
    subject: String,
    status: PlanStatus,
}

impl ClaudeMapper {
    // -- lines -----------------------------------------------------------------------------------------

    fn line(&mut self, e: &Value, line: &str) -> Vec<Update> {
        if is_true(e, "isSidechain") != self.sidechain {
            return Vec::new();
        }
        if self.cwd.is_none()
            && let Some(cwd) = non_empty(e, "cwd")
        {
            self.cwd = Some(cwd.to_owned());
        }
        let Some(kind) = str_of(e, "type") else {
            return Vec::new();
        };
        match kind {
            // No uuid, and Claude writes them again later (a rename back to an earlier name is the same
            // line): setting a title twice is harmless, so they skip the seen-set.
            "ai-title" | "custom-title" => self.title(e, kind == "custom-title"),
            "assistant" | "user" | "attachment" | "system" | "queue-operation" => {
                let Some(key) = self.first_time(e, line) else {
                    return Vec::new();
                };
                match kind {
                    "assistant" => self.assistant(e, &key),
                    "user" => self.user(e, &key),
                    "attachment" => self.attachment(e, &key),
                    "system" => self.system(e, &key),
                    _ => self.enqueued(e),
                }
            }
            _ => Vec::new(),
        }
    }

    /// The key of `e` (its `uuid`, else a hash of its `line`), or `None` when this mapper has mapped it before.
    fn first_time(&mut self, e: &Value, line: &str) -> Option<String> {
        let key = match str_of(e, "uuid") {
            Some(id) if !id.is_empty() => id.to_owned(),
            _ => format!("h{}", fnv(line)),
        };
        self.seen.insert(key.clone()).then_some(key)
    }

    /// A prompt typed while a turn runs is written here at once, and again (as a line or an attachment)
    /// seconds later, when the turn takes it. The person typed it now: it shows now, under a key made from
    /// its text so the later record is the same message.
    fn enqueued(&mut self, e: &Value) -> Vec<Update> {
        if str_of(e, "operation") != Some("enqueue") {
            return Vec::new();
        }
        let Some(text) = str_of(e, "content") else {
            return Vec::new();
        };
        if trim(text).is_empty() || trim_start(text).starts_with('<') {
            return Vec::new();
        }
        self.queued.insert(trim(text).to_owned());
        vec![message(Role::User, &queued_key(text), text)]
    }

    /// The key of a message of the person: its own, unless it was shown when it was typed.
    fn message_key(&mut self, key: &str, text: &str) -> String {
        if self.queued.remove(trim(text)) {
            queued_key(text)
        } else {
            key.to_owned()
        }
    }

    /// `/rename` writes `custom-title`; it wins over Claude's own `ai-title`, which Claude keeps writing (and
    /// re-appends after the custom one) afterwards.
    fn title(&mut self, e: &Value, custom: bool) -> Vec<Update> {
        let t = str_of(e, if custom { "customTitle" } else { "aiTitle" });
        let blank = t.is_none_or(|t| trim(t).is_empty());
        if custom {
            self.custom_titled = !blank;
        }
        match t {
            Some(t) if !blank && (custom || !self.custom_titled) => {
                vec![Update::Title(Some(cut_text(trim(t), 200)))]
            }
            _ => Vec::new(),
        }
    }

    fn system(&mut self, e: &Value, key: &str) -> Vec<Update> {
        match str_of(e, "subtype") {
            Some("turn_duration") => {
                self.turn_ended = true;
                Vec::new()
            }
            Some("compact_boundary") => {
                vec![message(
                    Role::Agent,
                    key,
                    "Earlier messages were summarised",
                )]
            }
            // A command's output line, not a hook's report (`/compact` prints a JSON snapshot of the
            // session after its first line).
            Some("local_command" | "informational") => {
                let content = str_of(e, "content").unwrap_or("");
                let text = cut_text(first_line(&strip_tags(&ANSI.replace_all(content, ""))), 300);
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![message(Role::Agent, key, &text)]
                }
            }
            _ => Vec::new(),
        }
    }

    fn attachment(&mut self, e: &Value, key: &str) -> Vec<Update> {
        let Some(a) = object(e.get("attachment")) else {
            return Vec::new();
        };
        match str_of(a, "type") {
            Some("skill_listing") => return self.skill_listing(a),
            Some("queued_command") => {}
            _ => return Vec::new(),
        }
        let Some(prompt) = non_blank(a, "prompt") else {
            return Vec::new();
        };
        // A background job's notice that waited for the turn to end (a job the person stopped is told this
        // way only): not something they typed.
        if str_of(a, "commandMode") == Some("task-notification")
            || trim_start(prompt).starts_with("<task-notification>")
        {
            return self.task_notification(trim_start(prompt), parse_stamp(a), false);
        }
        self.turn_ended = false;
        let mut out = self.user_clears();
        let id = self.message_key(key, prompt);
        out.push(message(Role::User, &id, prompt));
        out
    }

    /// The skills Claude lists in a `skill_listing` attachment: `names`, and a description for each in
    /// `content`. The first listing of a session (`isInitial`) is the whole set; a later one adds to it.
    /// What is sent is always the whole set. A listing with neither names nor lines (a trimmed capture)
    /// says nothing.
    fn skill_listing(&mut self, a: &Value) -> Vec<Update> {
        let mut described: Ordered<String> = Ordered::new();
        if let Some(content) = str_of(a, "content") {
            for m in SKILL_LINE.captures_iter(content) {
                described.insert(trim(&m[1]).to_owned(), cut_text(trim(&m[2]), 140));
            }
        }
        let listed: Vec<String> = match a.get("names") {
            Some(Value::Array(names)) => names
                .iter()
                .filter_map(Value::as_str)
                .filter(|n| is_skill_name(n))
                .map(str::to_owned)
                .collect(),
            _ => described
                .keys()
                .filter(|n| is_skill_name(n))
                .cloned()
                .collect(),
        };
        if listed.is_empty() {
            return Vec::new();
        }
        if a.get("isInitial") != Some(&Value::Bool(false)) {
            self.skills.clear();
        }
        for name in listed {
            let description = described.get(&name).cloned().unwrap_or_default();
            self.skills.insert(
                name.clone(),
                SlashCommand {
                    name,
                    description,
                    hint: None,
                },
            );
        }
        vec![Update::Commands(self.skills.values().cloned().collect())]
    }

    // -- assistant -------------------------------------------------------------------------------------

    fn assistant(&mut self, e: &Value, key: &str) -> Vec<Update> {
        let Some(m) = object(e.get("message")) else {
            return Vec::new();
        };
        let content = m.get("content");
        if str_of(m, "model") == Some("<synthetic>") {
            if !is_true(e, "isApiErrorMessage") {
                return Vec::new();
            }
            let text = text_of(content);
            self.turn_ended = true;
            return if text.is_empty() {
                Vec::new()
            } else {
                vec![message(
                    Role::Agent,
                    &format!("{key}:error"),
                    &format!("The turn failed: {text}"),
                )]
            };
        }
        let Some(Value::Array(blocks)) = content else {
            return Vec::new();
        };
        let msg_id = match str_of(m, "id") {
            Some(id) if !id.is_empty() => id,
            _ => key,
        };
        let api_index = e.get("apiBlockIndex").and_then(Value::as_i64);
        let mut out = Vec::new();
        for (i, b) in blocks.iter().enumerate() {
            if !b.is_object() {
                continue;
            }
            let id = format!("{msg_id}:{}", api_index.unwrap_or(0) + i as i64);
            match str_of(b, "type") {
                Some("text") => {
                    if let Some(t) = non_blank(b, "text") {
                        out.push(message(Role::Agent, &id, t));
                    }
                }
                Some("thinking") => {
                    if let Some(t) = non_blank(b, "thinking") {
                        out.push(message(Role::Thought, &id, t));
                    }
                }
                Some("tool_use") => out.extend(self.tool_start(b)),
                _ => {}
            }
        }
        self.turn_ended = str_of(m, "stop_reason") == Some("end_turn") && self.open.is_empty();
        out
    }

    // -- user ------------------------------------------------------------------------------------------

    fn user(&mut self, e: &Value, key: &str) -> Vec<Update> {
        let Some(m) = object(e.get("message")) else {
            return Vec::new();
        };
        let content = m.get("content");
        if let Some(Value::Array(blocks)) = content
            && blocks
                .iter()
                .any(|b| str_of(b, "type") == Some("tool_result"))
        {
            let mut out = Vec::new();
            for b in blocks {
                if str_of(b, "type") == Some("tool_result") {
                    out.extend(self.tool_result(e, b));
                }
            }
            self.turn_ended = false;
            return out;
        }
        // A picture whose note says where to fetch it is a block of the message, shown on a tap; any other
        // keeps the `[image]` line.
        let pics = pictures(content);
        let text = with_image_markers(&text_of(content), images_of(content) - pics.len());
        let head = trim_start(&text);
        if head.starts_with("<task-notification>") {
            return self.task_notification(head, parse_stamp(e), true);
        }
        if is_true(e, "isMeta") || is_true(e, "isCompactSummary") {
            return Vec::new();
        }
        if let Some(origin) = object(e.get("origin"))
            && let Some(kind) = origin.get("kind").filter(|k| !k.is_null())
            && kind.as_str() != Some("human")
        {
            return Vec::new();
        }
        if (head.is_empty() && pics.is_empty())
            || head.starts_with("<local-command-caveat>")
            || head.starts_with("<system-reminder>")
            || head.starts_with("<user-prompt-submit-hook>")
        {
            return Vec::new();
        }
        if head.starts_with("<local-command-stdout>") || head.starts_with("<local-command-stderr>")
        {
            let inner = cut_text(first_line(&strip_tags(&ANSI.replace_all(head, ""))), 300);
            return if inner.is_empty() {
                Vec::new()
            } else {
                vec![message(Role::Agent, key, &inner)]
            };
        }
        // The person's `!command` (bash mode): what they typed, then its output. Neither starts a turn, so
        // `turn_ended` stays as it was.
        if head.starts_with("<bash-input>") {
            return match between(head, "bash-input") {
                Some(cmd) if !cmd.is_empty() => {
                    vec![message(Role::User, key, &format!("!{cmd}"))]
                }
                _ => Vec::new(),
            };
        }
        if head.starts_with("<bash-stdout>") || head.starts_with("<bash-stderr>") {
            let clean = |tag: &str| {
                between(head, tag)
                    .map(|s| ANSI.replace_all(&s, "").into_owned())
                    .unwrap_or_default()
            };
            let (out, err) = (clean("bash-stdout"), clean("bash-stderr"));
            let parts: Vec<String> = [
                out,
                if err.is_empty() {
                    String::new()
                } else {
                    format!("stderr:\n{err}")
                },
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect();
            let text = parts.join("\n");
            return if text.is_empty() {
                Vec::new()
            } else {
                vec![message(Role::Agent, key, &cap_text(&text))]
            };
        }
        // `# note` (memory): the person typed the note.
        if head.starts_with("<user-memory-input>") {
            return match between(head, "user-memory-input") {
                Some(note) if !note.is_empty() => {
                    vec![message(Role::User, key, &format!("# {note}"))]
                }
                _ => Vec::new(),
            };
        }
        // Agent teams: another agent's message, not the person's. Shape from claude-devtools' parser
        // (unverified against a real capture, as in the Dart).
        if let Some(teammate) = TEAMMATE.captures(head) {
            let summary = SUMMARY
                .captures(teammate.get(2).map_or("", |g| g.as_str()))
                .map(|c| trim(&c[1]).to_owned());
            let body = cut_text(
                first_line(&strip_tags(teammate.get(3).map_or("", |g| g.as_str()))),
                300,
            );
            let text = match summary {
                Some(s) if !s.is_empty() => s,
                _ => body,
            };
            return if text.is_empty() {
                Vec::new()
            } else {
                vec![message(
                    Role::Agent,
                    key,
                    &format!("{}: {text}", &teammate[1]),
                )]
            };
        }
        // Built-in commands write `<command-name>` first; skills and custom commands write
        // `<command-message>` first. Same record, either order.
        if head.starts_with("<command-name>") || head.starts_with("<command-message>") {
            let name = between(head, "command-name");
            let args = between(head, "command-args");
            let Some(name) = name.filter(|n| !n.is_empty()) else {
                return Vec::new();
            };
            let typed = match args {
                Some(a) if !a.is_empty() => format!("{name} {a}"),
                _ => name.clone(),
            };
            // Claude writes the line the person typed and then the command's own record: one message.
            if self.last_typed.as_deref() == Some(typed.as_str()) {
                self.last_typed = None;
                return Vec::new();
            }
            if HOUSEKEEPING.contains(&name.as_str()) {
                return self.user_clears();
            }
            self.turn_ended = false;
            let mut out = self.user_clears();
            out.push(message(Role::User, key, &typed));
            return out;
        }
        if head.starts_with("[Request interrupted by user") {
            self.turn_ended = true;
            let mut out = self.cancel_open();
            out.push(message(Role::Agent, key, "Interrupted"));
            return out;
        }
        self.turn_ended = false;
        self.last_typed = Some(trim(&text).to_owned());
        let id = self.message_key(key, &text);
        let mut out = self.user_clears();
        out.push(user_message(&id, &text, pics));
        out
    }

    /// A later message from the person ends a question that is still open: the answer, if any, was typed in
    /// the terminal.
    fn user_clears(&mut self) -> Vec<Update> {
        let Some(ask) = self.ask.take() else {
            return Vec::new();
        };
        if self.open.remove(&ask.tool_call_id).is_none() {
            return Vec::new();
        }
        vec![cancelled_patch(&ask.tool_call_id)]
    }

    /// Everything still running is cancelled (the turn was interrupted).
    fn cancel_open(&mut self) -> Vec<Update> {
        if self.open.is_empty() {
            return Vec::new();
        }
        let out = self.open.keys().map(|id| cancelled_patch(id)).collect();
        self.open.clear();
        self.ask = None;
        out
    }

    // -- tool calls ------------------------------------------------------------------------------------

    fn tool_start(&mut self, b: &Value) -> Vec<Update> {
        let Some(id) = str_of(b, "id").filter(|id| !id.is_empty()) else {
            return Vec::new();
        };
        let name = str_of(b, "name")
            .filter(|n| !n.is_empty())
            .unwrap_or("tool");
        let input = object(b.get("input"));
        // Loading a deferred tool's definition is the agent's housekeeping.
        if name == "ToolSearch" {
            self.hidden.insert(id.to_owned());
            return Vec::new();
        }
        let diffs = self.start_diffs(name, input);
        self.started.insert(id.to_owned());
        self.open.insert(
            id.to_owned(),
            OpenCall {
                name: name.to_owned(),
                diffs: diffs.clone(),
                input: input.cloned(),
            },
        );
        if name == "AskUserQuestion" {
            self.ask = parse_ask(id, input);
        }
        if name == "Agent" || name == "Task" {
            self.start_subagent(id, input);
        }
        let mut call = Map::new();
        call.insert("toolCallId".into(), json!(id));
        call.insert("name".into(), json!(name));
        call.insert("title".into(), json!(call_title(name, input)));
        call.insert("kind".into(), json!(kind_of(name)));
        call.insert("status".into(), json!("in_progress"));
        if let Some(input) = input {
            call.insert("rawInput".into(), cap_json(input));
        }
        call.insert(
            "content".into(),
            Value::Array(diffs.iter().map(Diff::to_json).collect()),
        );
        let locations = self.locations(input);
        if !locations.is_empty() {
            call.insert("locations".into(), locations_json(&locations));
        }
        let mut out = vec![Update::ToolStart(Value::Object(call))];
        if name == "TodoWrite"
            && let Some(plan) = todo_plan(input.and_then(|i| i.get("todos")))
        {
            out.push(Update::Plan(plan));
        }
        out
    }

    fn tool_result(&mut self, line: &Value, b: &Value) -> Vec<Update> {
        let Some(id) = str_of(b, "tool_use_id").filter(|id| !id.is_empty()) else {
            return Vec::new();
        };
        if self.hidden.contains(id) {
            return Vec::new();
        }
        let at = parse_stamp(line);
        let open = self.open.remove(id);
        let known = self.started.contains(id);
        self.started.insert(id.to_owned());
        let name = open.as_ref().map_or("tool", |o| o.name.as_str()).to_owned();
        let result = object(line.get("toolUseResult"));
        let mut text = result_text(b.get("content"));
        if name == "Bash"
            && let Some(result) = result
        {
            let err = str_of(result, "stderr").unwrap_or("");
            if let Some(stdout) = str_of(result, "stdout")
                && (!stdout.is_empty() || !err.is_empty())
            {
                text = if err.is_empty() {
                    stdout.to_owned()
                } else {
                    format!("{stdout}\nstderr:\n{err}")
                };
            }
        }
        let is_error = is_true(b, "is_error");
        let denied = is_error
            && (str_of(line, "toolDenialKind") == Some("user-rejected")
                || text.starts_with("The user doesn't want to proceed"));
        let status = if denied {
            "cancelled"
        } else if is_error {
            "failed"
        } else {
            "completed"
        };

        let mut content: Vec<Value> = Vec::new();
        if !is_error {
            content.extend(
                finish_diffs(open.as_ref(), result)
                    .iter()
                    .map(Diff::to_json),
            );
        }
        if !text.is_empty() {
            content.push(
                json!({"type": "content", "content": {"type": "text", "text": cap_text(&text)}}),
            );
        }
        let locations = match &open {
            Some(o) => self.locations(o.input.as_ref()),
            None => Vec::new(),
        };
        let mut fields = Map::new();
        fields.insert("toolCallId".into(), json!(id));
        if !known {
            fields.insert("name".into(), json!(name));
            fields.insert("title".into(), json!(name));
            fields.insert("kind".into(), json!(kind_of(&name)));
        }
        fields.insert("status".into(), json!(status));
        fields.insert("content".into(), Value::Array(content));
        if !text.is_empty() {
            fields.insert("rawOutput".into(), json!(cap_text(&text)));
        }
        if !locations.is_empty() {
            fields.insert("locations".into(), locations_json(&locations));
        }
        if self.ask.as_ref().is_some_and(|a| a.tool_call_id == id) {
            self.ask = None;
        }
        let mut out = vec![Update::ToolPatch(Value::Object(fields))];
        if matches!(name.as_str(), "Agent" | "Task") && open.is_some() {
            self.note_subagent(id, result, is_error, at);
        }
        if !is_error {
            out.extend(self.fold_task(open.as_ref(), result));
            self.note_background(id, open.as_ref(), result, at);
        }
        out
    }

    // -- paths and diffs -------------------------------------------------------------------------------

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

    /// The file a call works on, as an absolute path (the first of its path keys that holds a plain path).
    fn locations(&self, input: Option<&Value>) -> Vec<String> {
        let Some(input) = input else {
            return Vec::new();
        };
        for key in ["file_path", "path", "notebook_path"] {
            if let Some(v) = str_of(input, key)
                && !v.is_empty()
                && !SCHEME.is_match(v)
            {
                return vec![self.abs(v)];
            }
        }
        Vec::new()
    }

    /// The change a call's input describes: an `Edit` or `MultiEdit` (old and new text) or a `Write` (new
    /// text only; the old comes with the result). The result's `structuredPatch` and `originalFile` are not
    /// used otherwise: they are huge.
    fn start_diffs(&self, name: &str, input: Option<&Value>) -> Vec<Diff> {
        let Some(input) = input else {
            return Vec::new();
        };
        let path = match input.get("file_path") {
            Some(Value::String(p)) => Some(p.as_str()),
            _ => input.get("notebook_path").and_then(Value::as_str),
        };
        let Some(path) = path.filter(|p| !p.is_empty()) else {
            return Vec::new();
        };
        let abs = self.abs(path);
        match name {
            "Write" => match str_of(input, "content") {
                Some(c) => vec![Diff {
                    path: abs,
                    old: None,
                    new: cap_text(c),
                }],
                None => Vec::new(),
            },
            "Edit" => match (str_of(input, "old_string"), str_of(input, "new_string")) {
                (Some(from), Some(to)) => vec![Diff {
                    path: abs,
                    old: Some(cap_text(from)),
                    new: cap_text(to),
                }],
                _ => Vec::new(),
            },
            "MultiEdit" => {
                let Some(Value::Array(edits)) = input.get("edits") else {
                    return Vec::new();
                };
                edits
                    .iter()
                    .filter_map(|ed| {
                        Some(Diff {
                            path: abs.clone(),
                            old: Some(cap_text(str_of(ed, "old_string")?)),
                            new: cap_text(str_of(ed, "new_string")?),
                        })
                    })
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    // -- the task list ---------------------------------------------------------------------------------

    /// A finished `TaskCreate` or `TaskUpdate` changes the task list: the whole plan is sent again.
    fn fold_task(&mut self, open: Option<&OpenCall>, result: Option<&Value>) -> Vec<Update> {
        let Some(open) = open else {
            return Vec::new();
        };
        let input = open.input.as_ref();
        match open.name.as_str() {
            "TaskCreate" => {
                let id = result
                    .and_then(|r| r.get("task"))
                    .and_then(|t| t.get("id"))
                    .filter(|v| !v.is_null());
                let subject = input.and_then(|i| str_of(i, "subject"));
                let (Some(id), Some(subject)) = (id, subject) else {
                    return Vec::new();
                };
                self.task_list.insert(
                    dart_str(id),
                    Task {
                        subject: subject.to_owned(),
                        status: PlanStatus::Pending,
                    },
                );
            }
            "TaskUpdate" => {
                let Some(id) = input
                    .and_then(|i| i.get("taskId"))
                    .filter(|v| !v.is_null())
                    .map(dart_str)
                else {
                    return Vec::new();
                };
                let Some(have) = self.task_list.get(&id) else {
                    return Vec::new();
                };
                let status = input.and_then(|i| i.get("status"));
                if status.and_then(Value::as_str) == Some("deleted") {
                    self.task_list.remove(&id);
                } else {
                    let subject = input
                        .and_then(|i| non_empty(i, "subject"))
                        .map_or_else(|| have.subject.clone(), str::to_owned);
                    let status = match status {
                        Some(Value::String(_)) => plan_status(status),
                        _ => have.status,
                    };
                    self.task_list.insert(id, Task { subject, status });
                }
            }
            _ => return Vec::new(),
        }
        vec![Update::Plan(
            self.task_list
                .values()
                .map(|t| PlanStep {
                    content: cut_text(&t.subject, 300),
                    status: t.status,
                })
                .collect(),
        )]
    }

    // -- background work -------------------------------------------------------------------------------

    /// A finished call that left a job running: a `Bash` with `run_in_background` (or one Claude moved to the
    /// background itself) says its `backgroundTaskId` in the result.
    fn note_background(
        &mut self,
        call_id: &str,
        open: Option<&OpenCall>,
        result: Option<&Value>,
        at: Option<i64>,
    ) {
        let Some(open) = open else {
            return;
        };
        let input = open.input.as_ref();
        if let Some(id) = result
            .and_then(|r| str_of(r, "backgroundTaskId"))
            .filter(|id| is_safe_id(id))
        {
            let command = input.and_then(|i| str_of(i, "command")).map_or("", trim);
            self.put(BackgroundTask {
                id: id.to_owned(),
                epoch: 0,
                kind: BackgroundKind::Shell,
                status: BackgroundStatus::Running,
                title: if command.is_empty() {
                    id.to_owned()
                } else {
                    cut_text(first_line(command), TITLE_CHARS)
                },
                detail: (!command.is_empty()).then(|| cap_text(command)),
                started_ms: at,
                ended_ms: None,
                deadline_secs: None,
                tool_call_id: Some(call_id.to_owned()),
                stop: StopRoute::Message,
            });
        }
        // A workflow or a monitor is a background task of its own: the official tool schema
        // (`WorkflowOutput`, `MonitorOutput`) gives its `taskId`; it ends by a `<task-notification>` like
        // the others.
        if matches!(open.name.as_str(), "Workflow" | "Monitor")
            && let Some(task) = result
                .and_then(|r| str_of(r, "taskId"))
                .filter(|t| is_safe_id(t))
        {
            let workflow = open.name == "Workflow";
            let named = if workflow {
                result
                    .and_then(|r| r.get("workflowName"))
                    .filter(|v| !v.is_null())
                    .or_else(|| input.and_then(|i| i.get("name")))
            } else {
                input.and_then(|i| i.get("description"))
            };
            let title = match named.and_then(Value::as_str) {
                Some(n) if !trim(n).is_empty() => cut_text(first_line(trim(n)), TITLE_CHARS),
                _ => open.name.clone(),
            };
            self.put(BackgroundTask {
                id: task.to_owned(),
                epoch: 0,
                kind: if workflow {
                    BackgroundKind::Workflow
                } else {
                    BackgroundKind::Monitor
                },
                status: BackgroundStatus::Running,
                title,
                detail: None,
                started_ms: at,
                ended_ms: None,
                deadline_secs: None,
                tool_call_id: Some(call_id.to_owned()),
                stop: StopRoute::Message,
            });
        }
        if matches!(open.name.as_str(), "TaskStop" | "KillShell") {
            let target = ["task_id", "shell_id", "taskId"]
                .iter()
                .find_map(|k| input.and_then(|i| i.get(*k)).filter(|v| !v.is_null()));
            if let Some(Value::String(target)) = target {
                self.finish(target, BackgroundStatus::Stopped, at);
            }
        }
    }

    /// The notice Claude gives itself when a background job ends: its task id and `completed`, `failed` or
    /// `killed`. It starts a new turn (the agent reacts to it).
    fn task_notification(&mut self, text: &str, at: Option<i64>, wakes: bool) -> Vec<Update> {
        // Only a notice delivered as a message of its own starts a turn; one that waited for the person's
        // next prompt (a job they stopped) does not.
        if wakes {
            self.turn_ended = false;
        }
        let id = between(text, "task-id");
        let status = between(text, "status");
        let Some(id) = id else {
            return Vec::new();
        };
        let ended = match status.as_deref() {
            Some("failed") => BackgroundStatus::Failed,
            Some("killed" | "stopped" | "cancelled") => BackgroundStatus::Stopped,
            _ => BackgroundStatus::Finished,
        };
        self.finish(&id, ended, at);
        let to = match ended {
            BackgroundStatus::Failed => "failed",
            BackgroundStatus::Stopped => "aborted",
            _ => "completed",
        };
        for (_, info) in &mut self.subagents.0 {
            if info.log_id.as_deref() == Some(id.as_str()) {
                info.status = to.to_owned();
            }
        }
        Vec::new()
    }

    // -- subagents -------------------------------------------------------------------------------------

    /// An `Agent` call: the subagent it starts, running until its result or its notice says otherwise. Its
    /// transcript is another file (`<session>/subagents/agent-<agentId>.jsonl`, [`subagent_log_path`]),
    /// found by [`SubagentInfo::log_id`] or by [`SubagentInfo::call_id`] (the file's `.meta.json` names
    /// the call).
    fn start_subagent(&mut self, call_id: &str, input: Option<&Value>) {
        if self.sidechain {
            return;
        }
        let description = input.and_then(|i| non_blank(i, "description"));
        let agent_type = input.and_then(|i| str_of(i, "subagent_type"));
        let mut name = match (description, agent_type) {
            (Some(d), _) => cut_text(first_line(trim(d)), TITLE_CHARS),
            (None, Some(t)) if !t.is_empty() => t.to_owned(),
            _ => "Subagent".to_owned(),
        };
        let taken: HashSet<String> = self.subagents.values().map(|s| s.name.clone()).collect();
        let mut n = 2;
        while taken.contains(&name) {
            name = format!("{} ({n})", COPY_SUFFIX.replace(&name, ""));
            n += 1;
        }
        let prompt = input.and_then(|i| str_of(i, "prompt"));
        self.subagents.insert(
            call_id.to_owned(),
            SubagentInfo {
                name,
                agent: agent_type.unwrap_or("").to_owned(),
                status: "running".to_owned(),
                assignment: prompt.map_or(String::new(), |p| cut_text(trim(p), ASSIGNMENT_CHARS)),
                tool_count: 0,
                recent_tools: Vec::new(),
                log_id: None,
                call_id: Some(call_id.to_owned()),
            },
        );
    }

    fn note_subagent(
        &mut self,
        call_id: &str,
        result: Option<&Value>,
        is_error: bool,
        at: Option<i64>,
    ) {
        let Some(have) = self.subagents.get(call_id).cloned() else {
            return;
        };
        let agent_id = result
            .and_then(|r| str_of(r, "agentId"))
            .filter(|id| is_agent_id(id));
        let is_async = result.and_then(|r| str_of(r, "status")) == Some("async_launched");
        // Dart's `num.toInt()` (a negative count, which no log has, would not fit `usize`: it is 0).
        let count = result
            .and_then(|r| r.get("totalToolUseCount"))
            .and_then(Value::as_number)
            .map(|n| {
                n.as_i64()
                    .unwrap_or_else(|| n.as_f64().unwrap_or(0.0) as i64)
                    .max(0) as usize
            });
        let status = if is_error {
            "failed"
        } else if is_async {
            "running"
        } else if result.and_then(|r| str_of(r, "status")) == Some("failed") {
            "failed"
        } else {
            "completed"
        };
        self.subagents.insert(
            call_id.to_owned(),
            SubagentInfo {
                status: status.to_owned(),
                tool_count: count.unwrap_or(have.tool_count),
                log_id: agent_id.map(str::to_owned).or(have.log_id.clone()),
                ..have.clone()
            },
        );
        if is_async && let Some(id) = agent_id {
            self.put(BackgroundTask {
                id: id.to_owned(),
                epoch: 0,
                kind: BackgroundKind::Agent,
                status: BackgroundStatus::Running,
                title: have.name.clone(),
                detail: (!have.assignment.is_empty()).then(|| have.assignment.clone()),
                started_ms: at,
                ended_ms: None,
                deadline_secs: None,
                tool_call_id: Some(call_id.to_owned()),
                stop: StopRoute::Message,
            });
        }
    }

    fn put(&mut self, task: BackgroundTask) {
        let key = task.key();
        self.tasks.remove(&key);
        self.tasks.insert(key, task);
        self.tasks_changed();
    }

    fn finish(&mut self, id: &str, status: BackgroundStatus, at: Option<i64>) {
        let Some(task) = self.tasks.get_mut(&format!("0/{id}")) else {
            return;
        };
        if !task.status.is_active() {
            return;
        }
        task.status = status;
        task.ended_ms = at;
        task.stop = StopRoute::None;
        self.tasks_changed();
    }

    /// A task was added or ended: keeps the latest [`FINISHED_KEPT`] finished tasks (the running ones always
    /// stay).
    fn tasks_changed(&mut self) {
        let finished = self
            .tasks
            .values()
            .filter(|t| !t.status.is_active())
            .count();
        let mut extra = finished.saturating_sub(FINISHED_KEPT);
        if extra == 0 {
            return;
        }
        self.tasks.retain(|t| {
            if extra > 0 && !t.status.is_active() {
                extra -= 1;
                false
            } else {
                true
            }
        });
    }
}

/// `v[key]` when it is a non-empty string (not trimmed).
fn non_empty<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    str_of(v, key).filter(|s| !s.is_empty())
}

fn queued_key(text: &str) -> String {
    format!("q:{}", fnv(trim(text)))
}

fn locations_json(paths: &[String]) -> Value {
    Value::Array(paths.iter().map(|p| json!({"path": p})).collect())
}

/// The change the finished call made: its input's diffs, with the old text of a `Write` from the result when
/// the file existed.
fn finish_diffs(open: Option<&OpenCall>, result: Option<&Value>) -> Vec<Diff> {
    let Some(open) = open else {
        return Vec::new();
    };
    if open.name != "Write" || open.diffs.len() != 1 {
        return open.diffs.clone();
    }
    match result.and_then(|r| str_of(r, "originalFile")) {
        Some(original) => vec![Diff {
            path: open.diffs[0].path.clone(),
            old: Some(cap_text(original)),
            new: open.diffs[0].new.clone(),
        }],
        None => open.diffs.clone(),
    }
}

impl LogMapper for ClaudeMapper {
    fn map(&mut self, line: &str) -> Vec<Update> {
        if line.is_empty() {
            return Vec::new();
        }
        match serde_json::from_str::<Value>(line) {
            Ok(e @ Value::Object(_)) => self.line(&e, line),
            _ => Vec::new(),
        }
    }

    fn pending_ask(&self) -> Option<PendingAsk> {
        self.ask.clone()
    }

    /// Always `None`: Claude asks through its own approval (herdr reports it blocked).
    fn proposed_plan(&self) -> Option<ProposedPlan> {
        None
    }

    /// A subagent's call stays open for its whole run: it is a task, not what a permission dialog asks about.
    fn open_tool_calls(&self) -> BTreeSet<String> {
        self.open
            .0
            .iter()
            .filter(|(_, c)| c.name != "Agent" && c.name != "Task")
            .map(|(id, _)| id.clone())
            .collect()
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
        *self = Self::new(self.sidechain);
    }
}
