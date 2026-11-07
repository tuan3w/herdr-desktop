//! The omp mapper against synthetic logs shaped like omp's own. The conversation a log produces is read
//! through a tiny reducer (`Fold`) that applies updates the way the transcript does: messages upsert by id,
//! a tool start inserts, a patch lays its keys over the call.

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use super::*;
use crate::files::{Entry, EntryKind};
use crate::observed::model::{
    BackgroundKind, BackgroundStatus, BackgroundTask, Block, LogImage, LogMapper, PictureRef,
    PlanStatus, PlanStep, Role, StopRoute, SubagentInfo, Update, parse_iso_millis,
};

// -- a reducer for the tests --------------------------------------------------------------------------------

enum Item {
    Msg {
        role: Role,
        id: String,
        blocks: Vec<Block>,
    },
    Tool(Map<String, Value>),
}

#[derive(Default)]
struct Fold {
    items: Vec<Item>,
    plan: Vec<PlanStep>,
    title: Option<String>,
}

impl Fold {
    fn apply(&mut self, u: Update) {
        match u {
            Update::Message { role, id, blocks } => {
                let at = self
                    .items
                    .iter()
                    .position(|i| matches!(i, Item::Msg { id: other, .. } if *other == id));
                let item = Item::Msg { role, id, blocks };
                match at {
                    Some(at) => self.items[at] = item,
                    None => self.items.push(item),
                }
            }
            Update::ToolStart(v) => {
                let Value::Object(call) = v else {
                    panic!("a tool call is an object")
                };
                let id = call["toolCallId"].as_str().unwrap().to_owned();
                match self.tool_at(&id) {
                    Some(at) => self.items[at] = Item::Tool(call),
                    None => self.items.push(Item::Tool(call)),
                }
            }
            Update::ToolPatch(v) => {
                let Value::Object(fields) = v else {
                    panic!("a patch is an object")
                };
                let id = fields["toolCallId"].as_str().unwrap().to_owned();
                let at = self.tool_at(&id).unwrap_or_else(|| {
                    let mut empty = Map::new();
                    empty.insert("toolCallId".into(), id.clone().into());
                    self.items.push(Item::Tool(empty));
                    self.items.len() - 1
                });
                let Item::Tool(call) = &mut self.items[at] else {
                    unreachable!()
                };
                for (k, v) in fields {
                    call.insert(k, v);
                }
            }
            Update::Plan(p) => self.plan = p,
            Update::Title(t) => self.title = t,
            Update::Commands(_) => {}
            Update::Cleared => self.items.clear(),
        }
    }

    fn tool_at(&self, id: &str) -> Option<usize> {
        self.items
            .iter()
            .position(|i| matches!(i, Item::Tool(c) if c["toolCallId"] == id))
    }

    fn tool(&self, id: &str) -> Option<&Map<String, Value>> {
        match self.items.get(self.tool_at(id)?)? {
            Item::Tool(c) => Some(c),
            Item::Msg { .. } => None,
        }
    }

    fn tools(&self) -> Vec<&Map<String, Value>> {
        self.items
            .iter()
            .filter_map(|i| match i {
                Item::Tool(c) => Some(c),
                Item::Msg { .. } => None,
            })
            .collect()
    }

    fn messages(&self, role: Option<Role>) -> Vec<(&str, &[Block])> {
        self.items
            .iter()
            .filter_map(|i| match i {
                Item::Msg {
                    role: r,
                    id,
                    blocks,
                } if role.is_none_or(|w| w == *r) => Some((id.as_str(), blocks.as_slice())),
                _ => None,
            })
            .collect()
    }

    fn texts(&self, role: Role) -> Vec<String> {
        self.messages(Some(role))
            .into_iter()
            .map(|(_, b)| text_of(b))
            .collect()
    }

    /// A line per item, in order: what a replay must not change.
    fn fingerprint(&self) -> String {
        let items: Vec<Value> = self
            .items
            .iter()
            .map(|i| match i {
                Item::Msg { role, id, blocks } => {
                    json!({"role": format!("{role:?}"), "id": id, "text": text_of(blocks),
                        "images": blocks.iter().filter(|b| matches!(b, Block::Image(_))).count()})
                }
                Item::Tool(c) => Value::Object(c.clone()),
            })
            .collect();
        let plan: Vec<Value> = self
            .plan
            .iter()
            .map(|p| json!([p.content, format!("{:?}", p.status)]))
            .collect();
        json!({"items": items, "plan": plan, "title": self.title}).to_string()
    }
}

fn text_of(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text(t) => Some(t.as_str()),
            Block::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn feed(m: &mut OmpMapper, f: &mut Fold, lines: &[String]) {
    for line in lines {
        for u in m.map(line) {
            f.apply(u);
        }
    }
}

fn run(lines: &[String]) -> (Fold, OmpMapper) {
    let mut m = OmpMapper::new();
    let mut f = Fold::default();
    feed(&mut m, &mut f, lines);
    (f, m)
}

fn feed_only(m: &mut OmpMapper, lines: &[String]) {
    for line in lines {
        m.map(line);
    }
}

// -- reading a tool call --------------------------------------------------------------------------------------

fn status(c: &Map<String, Value>) -> &str {
    c["status"].as_str().unwrap()
}

fn title(c: &Map<String, Value>) -> &str {
    c["title"].as_str().unwrap()
}

fn kind(c: &Map<String, Value>) -> &str {
    c["kind"].as_str().unwrap()
}

fn name(c: &Map<String, Value>) -> &str {
    c["name"].as_str().unwrap()
}

fn tool_text(c: &Map<String, Value>) -> String {
    c.get("content")
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter(|x| x["type"] == "content" && x["content"]["type"] == "text")
                .map(|x| x["content"]["text"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn diffs(c: &Map<String, Value>) -> Vec<&Value> {
    c.get("content")
        .and_then(Value::as_array)
        .map(|content| content.iter().filter(|x| x["type"] == "diff").collect())
        .unwrap_or_default()
}

fn paths(c: &Map<String, Value>) -> Vec<&str> {
    c.get("locations")
        .and_then(Value::as_array)
        .map(|l| l.iter().map(|x| x["path"].as_str().unwrap()).collect())
        .unwrap_or_default()
}

fn ids(set: &BTreeSet<String>) -> Vec<&str> {
    set.iter().map(String::as_str).collect()
}

// -- building a log -------------------------------------------------------------------------------------------

fn entry(v: Value) -> String {
    v.to_string()
}

fn session(cwd: &str) -> String {
    entry(json!({"type": "session", "id": "sess", "cwd": cwd}))
}

fn user(id: &str, text: &str) -> String {
    entry(json!({"type": "message", "id": id,
        "message": {"role": "user", "content": [{"type": "text", "text": text}]}}))
}

fn assistant(id: &str, content: Vec<Value>, stop: &str) -> String {
    entry(json!({"type": "message", "id": id,
        "message": {"role": "assistant", "content": content, "stopReason": stop}}))
}

fn said(id: &str, text: &str) -> String {
    assistant(id, vec![json!({"type": "text", "text": text})], "stop")
}

fn result(
    id: &str,
    call_id: &str,
    tool: &str,
    text: &str,
    details: Option<Value>,
    error: bool,
) -> String {
    entry(json!({"type": "message", "id": id,
        "message": {"role": "toolResult", "toolCallId": call_id, "toolName": tool,
            "content": [{"type": "text", "text": text}],
            "details": details.unwrap_or_else(|| json!({})), "isError": error}}))
}

fn ok(id: &str, call_id: &str, tool: &str, text: &str) -> String {
    result(id, call_id, tool, text, None, false)
}

fn call(id: &str, tool: &str, args: Value, intent: Option<&str>) -> Value {
    let mut c = json!({"type": "toolCall", "id": id, "name": tool, "arguments": args});
    if let Some(i) = intent {
        c["intent"] = i.into();
    }
    c
}

fn calls(id: &str, content: Vec<Value>) -> String {
    assistant(id, content, "toolUse")
}

// -- the synthetic logs ---------------------------------------------------------------------------------------

fn bash_turn() -> Vec<String> {
    vec![
        session("/home/dev/project"),
        user("u1", "Use the bash tool to run: echo hello-from-bash"),
        calls(
            "a1",
            vec![
                json!({"type": "thinking", "thinking": "I should run the command."}),
                call(
                    "call_bash",
                    "bash",
                    json!({"command": "echo hello-from-bash"}),
                    Some("Running echo command"),
                ),
            ],
        ),
        ok("r1", "call_bash", "bash", "hello-from-bash\n"),
        assistant(
            "a2",
            vec![
                json!({"type": "thinking", "thinking": "It printed the word."}),
                json!({"type": "text", "text": "done"}),
            ],
            "stop",
        ),
    ]
}

fn file_tools_turn() -> Vec<String> {
    let edit_result = json!({
        "path": "notes.txt",
        "perFileResults": [{"path": "notes.txt", "oldText": "one\ntwo\nthree", "newText": "one\nTWO\nthree"}],
    });
    vec![
        session("/home/dev/project"),
        user("u1", "Work on the files."),
        calls(
            "a1",
            vec![call(
                "c_read",
                "read",
                json!({"path": "hello.txt"}),
                Some("Reading hello.txt"),
            )],
        ),
        result(
            "r1",
            "c_read",
            "read",
            "1:alpha\n2:beta\n",
            Some(json!({"path": "hello.txt"})),
            false,
        ),
        calls(
            "a2",
            vec![call(
                "c_write",
                "write",
                json!({"path": "notes.txt", "content": "one\ntwo\nthree"}),
                Some("Writing notes"),
            )],
        ),
        result(
            "r2",
            "c_write",
            "write",
            "Successfully wrote 13 bytes to notes.txt",
            Some(json!({"path": "notes.txt"})),
            false,
        ),
        calls(
            "a3",
            vec![call(
                "c_edit",
                "edit",
                json!({"input": "[notes.txt#AB12]\n- 2:two\n+ TWO"}),
                Some("Changing two to TWO"),
            )],
        ),
        result(
            "r3",
            "c_edit",
            "edit",
            "Updated notes.txt",
            Some(edit_result),
            false,
        ),
        calls(
            "a4",
            vec![call(
                "c_grep",
                "grep",
                json!({"pattern": "beta", "path": "hello.txt"}),
                Some("Grepping for beta in hello.txt"),
            )],
        ),
        ok("r4", "c_grep", "grep", "2:beta"),
        calls(
            "a5",
            vec![call(
                "c_glob",
                "glob",
                json!({"pattern": "*.txt"}),
                Some("Listing text files"),
            )],
        ),
        ok("r5", "c_glob", "glob", "notes.txt\nhello.txt"),
        said("a6", "All tasks completed."),
    ]
}

fn failing_tools() -> Vec<String> {
    vec![
        calls(
            "a1",
            vec![
                call("c_bash", "bash", json!({"command": "ls /nope"}), None),
                call("c_read", "read", json!({"path": "missing_file.txt"}), None),
            ],
        ),
        result(
            "r1",
            "c_bash",
            "bash",
            "ls: cannot access\nCommand exited with code 2",
            None,
            true,
        ),
        result(
            "r2",
            "c_read",
            "read",
            "Path 'missing_file.txt' not found",
            None,
            true,
        ),
        said("a2", "Both operations failed."),
    ]
}

fn phases(tasks: &[(&str, &str)]) -> Value {
    let tasks: Vec<Value> = tasks
        .iter()
        .map(|(c, s)| json!({"content": c, "status": s}))
        .collect();
    json!({"phases": [{"name": "Work", "tasks": tasks}]})
}

fn todo_plan() -> Vec<String> {
    vec![
        user("u1", "Plan it."),
        calls(
            "a1",
            vec![
                call(
                    "t1",
                    "todo",
                    json!({}),
                    Some("Initialize plan with Work phase"),
                ),
                call("t2", "todo", json!({}), Some("Mark write code completed")),
                call("t3", "todo", json!({}), Some("Mark run tests in progress")),
            ],
        ),
        result(
            "r1",
            "t1",
            "todo",
            "ok",
            Some(phases(&[
                ("write code", "in_progress"),
                ("run tests", "pending"),
            ])),
            false,
        ),
        result(
            "r2",
            "t2",
            "todo",
            "ok",
            Some(phases(&[
                ("write code", "completed"),
                ("run tests", "pending"),
            ])),
            false,
        ),
        result(
            "r3",
            "t3",
            "todo",
            "ok",
            Some(phases(&[
                ("write code", "completed"),
                ("run tests", "in_progress"),
            ])),
            false,
        ),
        entry(
            json!({"type": "custom_message", "id": "rem", "customType": "todo-reminder",
            "content": "<system-reminder>keep your todo list current</system-reminder>", "display": false}),
        ),
    ]
}

fn subagent_log() -> Vec<String> {
    vec![
        entry(
            json!({"type": "message", "id": "u1", "message": {"role": "user", "content":
            "Complete assignment thoroughly:\nReply with the word pong."}}),
        ),
        calls(
            "a1",
            vec![call("c_yield", "yield", json!({"result": "pong"}), None)],
        ),
        ok("r1", "c_yield", "yield", "Result submitted."),
    ]
}

fn task_call(id: &str, tasks: Value) -> Value {
    call(id, "task", json!({"tasks": tasks}), None)
}

fn subagent_task() -> Vec<String> {
    vec![
        user("u1", "Spawn one agent."),
        calls(
            "a1",
            vec![task_call(
                "c_task",
                json!([{"name": "PongReply", "task": "Reply with the word pong and do nothing else."}]),
            )],
        ),
        result(
            "r1",
            "c_task",
            "task",
            "Spawned agent PongReply. NEVER poll for its result.",
            Some(json!({"progress": [{"id": "PongReply", "status": "pending"}]})),
            false,
        ),
        calls(
            "a2",
            vec![call(
                "c_wait",
                "wait",
                json!({"i": "Waiting for PongReply"}),
                None,
            )],
        ),
        result(
            "r2",
            "c_wait",
            "wait",
            "## Completed",
            Some(
                json!({"op": "wait", "jobs": [{"id": "PongReply", "type": "task", "status": "completed"}]}),
            ),
            false,
        ),
        said("a3", "The agent replied."),
    ]
}

fn subagents_irc() -> Vec<String> {
    vec![
        session("/home/dev/project"),
        user("u1", "Run two agents."),
        calls(
            "a1",
            vec![task_call(
                "call_task",
                json!([
                    {"name": "Alpha", "agent": "task", "task": "Write the parser."},
                    {"name": "Beta", "agent": "explore", "task": "Find the callers."},
                ]),
            )],
        ),
        result(
            "r1",
            "call_task",
            "task",
            "Spawned 2 agents. NEVER poll.",
            Some(json!({"progress": [
                {"id": "Alpha", "agent": "task", "status": "running", "assignment": "Write the parser.\nUse records.",
                    "toolCount": 2, "recentTools": ["read", {"tool": "grep"}]},
                {"id": "Beta", "agent": "explore", "status": "pending"},
            ]})),
            false,
        ),
        calls(
            "a2",
            vec![call(
                "call_irc",
                "write",
                json!({"path": "agent://Alpha", "content": "Please also add a unit test."}),
                None,
            )],
        ),
        ok("r2", "call_irc", "write", "Sent."),
        calls(
            "a3",
            vec![call(
                "call_bash",
                "bash",
                json!({"command": "sleep 5"}),
                None,
            )],
        ),
        entry(
            json!({"type": "message", "id": "r3", "timestamp": "2026-10-05T10:00:00.000Z",
            "message": {"role": "toolResult", "toolCallId": "call_bash", "toolName": "bash",
                "content": [{"type": "text", "text": "Backgrounded as job bg_1"}],
                "details": {"async": {"state": "running", "jobId": "bg_1", "type": "bash"}}, "isError": false}}),
        ),
        entry(
            json!({"type": "custom_message", "id": "irc1", "customType": "irc:incoming",
            "details": {"from": "Alpha", "message": "Parser is done, tests added."}}),
        ),
        entry(
            json!({"type": "custom_message", "id": "ar1", "customType": "async-result",
            "content": "<system-notice>\n2 background jobs have completed.\n</system-notice>",
            "details": {"jobs": [
                {"jobId": "Alpha", "type": "task", "status": "completed"},
                {"jobId": "bg_1", "type": "bash"},
            ]}}),
        ),
        calls("a4", vec![call("call_wait", "wait", json!({}), None)]),
        result(
            "r4",
            "call_wait",
            "wait",
            "## Completed",
            Some(
                json!({"op": "wait", "jobs": [{"id": "Beta", "type": "task", "status": "failed"}]}),
            ),
            false,
        ),
        said("a5", "One finished, one failed."),
    ]
}

fn ask_args() -> Value {
    json!({"questions": [
        {"id": "lang", "question": "Which language should the project use?",
            "options": [
                {"label": "Dart", "description": "Flutter app, shares code with the phone"},
                {"label": "Rust", "description": "Fast, more setup"},
                {"label": "Go"},
            ], "recommended": 0},
        {"id": "extras", "question": "Which extras?", "multi": true,
            "options": ["CI", "Docs", "Benchmarks"], "recommended": 2},
    ]})
}

fn ask_pending() -> Vec<String> {
    vec![
        user("ask_u1", "Set up a project."),
        calls(
            "ask_a1",
            vec![call(
                "toolu_ask_0001",
                "ask",
                ask_args(),
                Some("Asking about the setup"),
            )],
        ),
    ]
}

fn ask_answered() -> Vec<String> {
    let args = json!({"questions": [
        {"id": "lang", "question": "Language?", "options": ["Dart", "Rust"], "recommended": 0},
        {"id": "extras", "question": "Extras?", "multi": true, "options": ["CI", "Docs"]},
    ]});
    vec![
        user("u1", "Set up my-project."),
        said("a0", "Let me ask a question."),
        calls(
            "a1",
            vec![call(
                "toolu_ask_0002",
                "ask",
                args,
                Some("Asking about the setup"),
            )],
        ),
        ok("r1", "toolu_ask_0002", "ask", "lang: Dart\nextras: CI"),
        said("a2", "Setting up my-project in Dart."),
    ]
}

fn compaction_branch() -> Vec<String> {
    vec![
        entry(
            json!({"type": "session", "id": "s", "cwd": "/home/dev/project", "title": "Long running work"}),
        ),
        user("u1", "Before"),
        entry(json!({"type": "compaction", "id": "c1"})),
        entry(json!({"type": "branch_summary", "id": "b1"})),
        entry(json!({"type": "reset_boundary", "id": "x1"})),
        user("u2", "After the clear"),
    ]
}

fn turn_error() -> Vec<String> {
    vec![
        user("u1", "Build it."),
        calls(
            "a1",
            vec![
                json!({"type": "text", "text": "Starting the build."}),
                call("toolu_build_0001", "bash", json!({"command": "make"}), None),
            ],
        ),
        entry(
            json!({"type": "message", "id": "a2", "message": {"role": "assistant", "content": [],
            "stopReason": "error",
            "errorMessage": "529 overloaded_error: the model is overloaded, try again later"}}),
        ),
        user("u2", "Try again."),
        calls(
            "a3",
            vec![call(
                "toolu_build_0002",
                "bash",
                json!({"command": "make"}),
                None,
            )],
        ),
        assistant("a4", vec![], "aborted"),
    ]
}

const SHA_ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn odd_entries() -> Vec<String> {
    let shot = format!("blob:sha256:{SHA_ZERO}");
    vec![
        entry(
            json!({"type": "session", "id": "s", "cwd": "/home/dev/project", "title": "Odd entries session"}),
        ),
        entry(
            json!({"type": "message", "id": "u1", "message": {"role": "user", "content": "A plain string user message"}}),
        ),
        entry(
            json!({"type": "message", "id": "d1", "message": {"role": "developer", "content": "hidden"}}),
        ),
        entry(
            json!({"type": "message", "id": "f1", "message": {"role": "fileMention", "content": "hidden"}}),
        ),
        entry(
            json!({"type": "custom_message", "id": "sk", "customType": "skill-prompt", "content": "go",
            "display": true, "attribution": "user", "details": {"name": "tdd", "args": "the parser"}}),
        ),
        entry(
            json!({"type": "custom_message", "id": "nudge", "customType": "mid-run-todo-nudge",
            "content": "x", "display": false}),
        ),
        entry(
            json!({"type": "message", "id": "u2", "message": {"role": "user", "content": [
            {"type": "text", "text": "Look at this screenshot"},
            {"type": "image", "data": shot, "mimeType": "image/png"}]}}),
        ),
        assistant(
            "a1",
            vec![
                json!({"type": "thinking", "thinking": "  "}),
                json!({"type": "redactedThinking", "data": "xxxx"}),
                json!({"type": "text", "text": "Visible answer"}),
                json!({"type": "toolCall", "name": "bash", "arguments": {}}),
                json!({"type": "toolCall", "id": "toolu_str_args", "name": "grep",
                    "arguments": "{\"pattern\":\"needle\",\"path\":\"src\"}"}),
            ],
            "toolUse",
        ),
        entry(
            json!({"type": "message", "id": "e1", "message": {"role": "bashExecution",
            "command": "git status --short", "output": " M lib/a.dart\n", "exitCode": 0}}),
        ),
        entry(
            json!({"type": "message", "id": "e2", "message": {"role": "bashExecution",
            "command": "false", "output": "", "exitCode": 1}}),
        ),
        ok(
            "r1",
            "toolu_orphan_0001",
            "read",
            "a result whose call this log never showed",
        ),
        entry(
            json!({"type": "message", "id": "r2", "message": {"role": "toolResult", "content": []}}),
        ),
    ]
}

fn edit_modes() -> Vec<String> {
    let multi = "[src/c.dart#AAAA]\n- 1:zero\n+ one\n[src/d.dart#BBBB]\n- 1:gone\n[src/e.dart#CCCC]\n+ brand new";
    vec![
        session("/work/proj"),
        user("u1", "Edit things."),
        calls(
            "a1",
            vec![
                call("call_rd", "read", json!({"path": "src/a.dart:10"}), None),
                call(
                    "call_rep",
                    "edit",
                    json!({"path": "src/b.dart", "old_string": "int x = 1;", "new_string": "int x = 2;"}),
                    None,
                ),
                call(
                    "call_multi",
                    "edit",
                    json!({"input": multi}),
                    Some("Editing two files"),
                ),
                call(
                    "call_wr",
                    "write",
                    json!({"path": "src/f.dart", "content": "x"}),
                    None,
                ),
                call(
                    "call_web",
                    "web_search",
                    json!({"query": "dart records"}),
                    None,
                ),
            ],
        ),
        ok("r1", "call_rd", "read", "10:int a;"),
        result(
            "r2",
            "call_rep",
            "edit",
            "Updated src/b.dart",
            Some(
                json!({"path": "src/b.dart", "oldText": "int x = 1;\nint y = 0;",
                "newText": "int x = 2;\nint y = 0;"}),
            ),
            false,
        ),
        result(
            "r3",
            "call_multi",
            "edit",
            "Updated 3 files",
            Some(json!({"perFileResults": [
                {"path": "src/c.dart", "oldText": "zero\n", "newText": "one\n"},
                {"path": "src/d.dart"},
                {"path": "src/e.dart", "newText": "brand new\n"},
                {"path": "src/g.dart", "oldText": "a", "newText": "b", "isError": true},
            ]})),
            false,
        ),
        result(
            "r4",
            "call_wr",
            "write",
            "Error: permission denied",
            None,
            true,
        ),
        ok("r5", "call_web", "web_search", "Records are..."),
        entry(
            json!({"type": "message", "id": "py", "message": {"role": "pythonExecution",
            "code": "print(1+1)\nprint('x')", "output": "2\nx\n", "exitCode": 0}}),
        ),
    ]
}

const T0: &str = "2026-10-05T10:00:00.000Z";
const T0_MS: i64 = 1_791_194_400_000;

fn stamped(id: &str, at: &str, mut v: Value) -> String {
    v["id"] = id.into();
    v["timestamp"] = at.into();
    entry(v)
}

/// A `bash` call and its result that went to the background as `job`, in the shape omp writes them.
fn bg_start(
    id: &str,
    call_id: &str,
    job: &str,
    tool: &str,
    kind: &str,
    timeout: Option<Value>,
    at: Option<&str>,
) -> String {
    let mut details = json!({"async": {"state": "running", "jobId": job, "type": kind}});
    if let Some(t) = timeout {
        details["timeoutSeconds"] = t;
    }
    let mut e = json!({"type": "message", "id": id,
        "message": {"role": "toolResult", "toolCallId": call_id, "toolName": tool,
            "content": [{"type": "text", "text": format!("Backgrounded as job {job}")}],
            "details": details, "isError": false}});
    if let Some(at) = at {
        e["timestamp"] = at.into();
    }
    entry(e)
}

fn bg_call(id: &str, call_id: &str, tool: &str, args: Value) -> String {
    calls(id, vec![call(call_id, tool, args, None)])
}

fn bg_finished(id: &str, jobs: &[&str], text: &str, at: Option<&str>) -> String {
    let n = jobs.len();
    let head = if n == 1 {
        format!("Background job {} has completed.", jobs[0])
    } else {
        format!("{n} background jobs have completed.")
    };
    let list: Vec<Value> = jobs
        .iter()
        .map(|j| json!({"jobId": j, "type": "bash", "label": j, "durationMs": 5}))
        .collect();
    let mut e = json!({"type": "custom_message", "id": id, "customType": "async-result",
        "content": format!("<system-notice>\n{head}\n{text}\n</system-notice>"),
        "details": {"jobs": list}});
    if let Some(at) = at {
        e["timestamp"] = at.into();
    }
    entry(e)
}

fn bg_wait(id: &str, jobs: &[(&str, &str)], tool: &str) -> String {
    let list: Vec<Value> = jobs
        .iter()
        .map(|(i, s)| json!({"id": i, "type": "bash", "status": s}))
        .collect();
    result(
        id,
        &format!("w{id}"),
        tool,
        "## Completed",
        Some(json!({"op": "wait", "jobs": list})),
        false,
    )
}

/// The shape of a real background-heavy log: bg_1 (bash, a 300 s limit) ends by notice; a `task` with three
/// subagents, two of them settled by `wait`; the process exits; bg_4 in the new process times out; bg_6 (no
/// limit) runs on while the turn is over.
fn background_jobs() -> Vec<String> {
    vec![
        // 0
        bg_call(
            "a0",
            "c_bg1",
            "bash",
            json!({"command": "export MODEL=demo AGENT=tool; ./run paper --long-argument-list --another-argument-to-make-this-title-too-long-for-the-row-width\nnvidia-smi"}),
        ),
        // 1
        bg_start(
            "r0",
            "c_bg1",
            "bg_1",
            "bash",
            "bash",
            Some(json!(300)),
            Some("2026-10-02T23:35:23.245Z"),
        ),
        // 2
        bg_finished("n0", &["bg_1"], "done", Some("2026-10-02T23:40:00.000Z")),
        // 3
        bg_call(
            "a1",
            "c_task",
            "task",
            json!({"tasks": [{"name": "RLFrameworks", "task": "# Target\nSurvey RL frameworks."},
                {"name": "SFTStacks", "task": "Survey SFT stacks."}, {"name": "PapersUse", "task": "Find papers."}]}),
        ),
        // 4
        entry(
            json!({"type": "message", "id": "r1", "timestamp": "2026-10-02T23:41:00.000Z",
            "message": {"role": "toolResult", "toolCallId": "c_task", "toolName": "task",
                "content": [{"type": "text", "text": "Spawned 3 agents."}],
                "details": {"async": {"state": "running", "jobId": "RLFrameworks", "type": "task"},
                    "progress": [
                        {"id": "RLFrameworks", "status": "pending", "assignment": format!("# Target\n{}", "y".repeat(900))},
                        {"id": "SFTStacks", "status": "pending", "task": "Survey SFT stacks."},
                        {"id": "PapersUse", "status": "pending"}]},
                "isError": false}}),
        ),
        // 5, 6
        bg_wait("w1", &[("PapersUse", "completed")], "wait"),
        bg_wait("w2", &[("SFTStacks", "completed")], "wait"),
        // 7
        stamped(
            "x1",
            "2026-10-03T15:25:24.570Z",
            json!({"type": "custom", "customType": "session_exit", "data": {"reason": "sighup"}}),
        ),
        // 8
        bg_call("a2", "c_bg4", "bash", json!({"command": "python train.py"})),
        // 9
        bg_start(
            "r2",
            "c_bg4",
            "bg_4",
            "bash",
            "bash",
            Some(json!(3000)),
            Some("2026-10-03T16:00:00.000Z"),
        ),
        // 10
        bg_finished(
            "n1",
            &["bg_4"],
            "[Command timed out after 3000 seconds]",
            Some("2026-10-03T16:50:00.000Z"),
        ),
        // 11
        bg_call(
            "a3",
            "c_bg6",
            "bash",
            json!({"command": "F=data/coder2b/x.bin; ./fetch $F"}),
        ),
        // 12
        bg_start(
            "r3",
            "c_bg6",
            "bg_6",
            "bash",
            "bash",
            None,
            Some("2026-10-05T06:26:42.445Z"),
        ),
        // 13
        bg_wait("w3", &[("bg_6", "running")], "wait"),
        // 14
        said("a4", "bg_6 is still running; I will wait."),
    ]
}

fn plan_proposal() -> Vec<String> {
    let plan = "## Context\nCreate `/home/dev/project/hello.py`.\n\n## Verification\nRun it.";
    vec![
        session("/home/dev/project"),
        entry(json!({"type": "mode_change", "id": "m0", "mode": "plan"})),
        user("u1", "Plan a hello script."),
        calls(
            "a1",
            vec![call(
                "tc-write",
                "write",
                json!({"path": "local://hello-py-plan.md", "content": plan}),
                None,
            )],
        ),
        ok("r1", "tc-write", "write", "Wrote local://hello-py-plan.md"),
        calls(
            "a2",
            vec![call(
                "tc-propose",
                "write",
                json!({"path": "xd://propose", "content": "{\"title\":\"hello-py\"}"}),
                None,
            )],
        ),
        result(
            "r2",
            "tc-propose",
            "write",
            "Plan submitted.",
            Some(json!({"xdev": {"tool": "propose", "mode": "execute",
                "inner": {"planFilePath": "local://hello-py-plan.md", "title": "hello-py"}}})),
            false,
        ),
        assistant("a3", vec![], "aborted"),
        entry(json!({"type": "mode_change", "id": "m1", "mode": "plan"})),
    ]
}

/// Every synthetic log above, for the replay tests.
fn all_logs() -> Vec<(&'static str, Vec<String>)> {
    vec![
        ("bash_turn", bash_turn()),
        ("file_tools_turn", file_tools_turn()),
        ("failing_tools", failing_tools()),
        ("todo_plan", todo_plan()),
        ("subagent_task", subagent_task()),
        ("subagent_log", subagent_log()),
        ("ask_pending", ask_pending()),
        ("ask_answered", ask_answered()),
        ("compaction_branch", compaction_branch()),
        ("turn_error", turn_error()),
        ("odd_entries", odd_entries()),
        ("edit_modes", edit_modes()),
        ("subagents_irc", subagents_irc()),
        ("background_jobs", background_jobs()),
        ("plan_proposal", plan_proposal()),
    ]
}

// -- a generated turn reads like an ACP session ---------------------------------------------------------------

#[test]
fn bash_turn_is_user_thought_tool_thought_answer() {
    let (f, m) = run(&bash_turn());
    let roles: Vec<String> = f
        .items
        .iter()
        .map(|i| match i {
            Item::Msg { role, .. } => format!("{role:?}"),
            Item::Tool(_) => "Tool".into(),
        })
        .collect();
    assert_eq!(roles, ["User", "Thought", "Tool", "Thought", "Agent"]);
    let users = f.messages(Some(Role::User));
    assert_eq!(users.len(), 1);
    assert_eq!(users[0].0, "u1");
    assert!(text_of(users[0].1).starts_with("Use the bash tool to run: echo hello-from-bash"));
    assert_eq!(f.texts(Role::Agent), ["done"]);
    assert_eq!(f.messages(Some(Role::Agent))[0].0, "a2:1");

    let c = f.tool("call_bash").unwrap();
    assert_eq!(name(c), "bash");
    assert_eq!(kind(c), "execute");
    assert_eq!(status(c), "completed");
    assert_eq!(title(c), "Running echo command");
    assert_eq!(c["rawInput"]["command"], "echo hello-from-bash");
    assert!(tool_text(c).starts_with("hello-from-bash"));
    assert!(
        c["rawOutput"]
            .as_str()
            .unwrap()
            .starts_with("hello-from-bash")
    );
    assert!(m.open_tool_calls().is_empty());
    assert!(m.pending_ask().is_none());
    assert!(f.plan.is_empty());
}

#[test]
fn file_tools_read_write_with_diff_edit_with_the_result_diff_grep_glob() {
    let (f, m) = run(&file_tools_turn());
    let calls = f.tools();
    let kinds: Vec<&str> = calls.iter().map(|c| kind(c)).collect();
    assert_eq!(kinds, ["read", "edit", "edit", "search", "search"]);
    assert!(calls.iter().all(|c| status(c) == "completed"));
    assert!(m.open_tool_calls().is_empty());

    let read = calls[0];
    assert_eq!(title(read), "Reading hello.txt");
    assert_eq!(paths(read), ["/home/dev/project/hello.txt"]);
    assert!(tool_text(read).contains("2:beta"));

    let write = calls[1];
    assert_eq!(name(write), "write");
    let wd = diffs(write);
    assert_eq!(wd.len(), 1);
    assert_eq!(wd[0]["path"], "/home/dev/project/notes.txt");
    assert!(wd[0].get("oldText").is_none());
    assert_eq!(wd[0]["newText"], "one\ntwo\nthree");
    assert!(tool_text(write).contains("Successfully wrote 13 bytes"));
    assert_eq!(paths(write), ["/home/dev/project/notes.txt"]);

    let edit = calls[2];
    assert_eq!(name(edit), "edit");
    assert_eq!(title(edit), "Changing two to TWO");
    let ed = diffs(edit);
    assert_eq!(ed.len(), 1);
    assert_eq!(ed[0]["path"], "/home/dev/project/notes.txt");
    assert_eq!(ed[0]["oldText"], "one\ntwo\nthree");
    assert_eq!(ed[0]["newText"], "one\nTWO\nthree");
    // The diff comes before the text, as in ACP.
    assert_eq!(edit["content"][0]["type"], "diff");
    assert_eq!(paths(edit), ["/home/dev/project/notes.txt"]);

    assert_eq!(title(calls[3]), "Grepping for beta in hello.txt");
    assert!(tool_text(calls[3]).contains("beta"));
    assert_eq!(tool_text(calls[4]), "notes.txt\nhello.txt");
    assert!(f.texts(Role::Agent)[0].starts_with("All tasks completed"));
}

#[test]
fn an_edit_with_only_its_arguments_has_no_diff_yet_and_the_result_adds_it() {
    let lines = file_tools_turn();
    let i = lines
        .iter()
        .position(|l| l.contains("\"name\":\"edit\""))
        .unwrap();
    let mut m = OmpMapper::new();
    let mut f = Fold::default();
    feed(&mut m, &mut f, &lines[..=i]);
    let pending = f.tool("c_edit").unwrap();
    assert_eq!(status(pending), "in_progress");
    assert!(diffs(pending).is_empty());
    // From the hashline header.
    assert_eq!(paths(pending), ["/home/dev/project/notes.txt"]);
    assert_eq!(ids(&m.open_tool_calls()), ["c_edit"]);
    feed(&mut m, &mut f, &lines[i + 1..i + 2]);
    assert_eq!(diffs(f.tool("c_edit").unwrap()).len(), 1);
}

#[test]
fn failures_fail_their_rows_and_keep_the_error_text() {
    let (f, m) = run(&failing_tools());
    let bash = f.tool("c_bash").unwrap();
    let read = f.tool("c_read").unwrap();
    assert_eq!(status(bash), "failed");
    assert!(tool_text(bash).contains("Command exited with code 2"));
    assert_eq!(status(read), "failed");
    assert_eq!(tool_text(read), "Path 'missing_file.txt' not found");
    assert!(m.open_tool_calls().is_empty());
    assert!(f.texts(Role::Agent)[0].contains("Both operations failed"));
}

#[test]
fn todo_parallel_calls_and_results_end_in_the_final_plan_and_the_reminder_stays_hidden() {
    let (f, m) = run(&todo_plan());
    let plan: Vec<(&str, PlanStatus)> = f
        .plan
        .iter()
        .map(|p| (p.content.as_str(), p.status))
        .collect();
    assert_eq!(
        plan,
        [
            ("write code", PlanStatus::Completed),
            ("run tests", PlanStatus::InProgress)
        ]
    );
    let todos = f.tools();
    assert_eq!(todos.len(), 3);
    assert!(
        todos
            .iter()
            .all(|t| kind(t) == "think" && status(t) == "completed")
    );
    let titles: Vec<&str> = todos.iter().map(|t| title(t)).collect();
    assert_eq!(
        titles,
        [
            "Initialize plan with Work phase",
            "Mark write code completed",
            "Mark run tests in progress"
        ]
    );
    assert!(
        f.messages(None)
            .iter()
            .all(|(_, b)| !text_of(b).contains("system-reminder"))
    );
    assert!(m.open_tool_calls().is_empty());
}

#[test]
fn a_todo_abandoned_task_is_not_started_and_blocked_is_pending() {
    let line = result(
        "r1",
        "c1",
        "todo",
        "ok",
        Some(json!({"phases": [
            {"name": "A", "tasks": [
                {"content": "x", "status": "abandoned"},
                {"content": "y", "status": "blocked"},
                {"content": "", "status": "pending"},
            ]},
            {"name": "B", "tasks": [{"content": "z"}]},
        ]})),
        false,
    );
    let (f, _) = run(&[line]);
    // Dart reports `abandoned` as cancelled; the transcript's plan has no such state (the ACP crate reads
    // `cancelled` as pending too), so the step stays listed as not done.
    let plan: Vec<(&str, PlanStatus)> = f
        .plan
        .iter()
        .map(|p| (p.content.as_str(), p.status))
        .collect();
    assert_eq!(
        plan,
        [
            ("x", PlanStatus::Pending),
            ("y", PlanStatus::Pending),
            ("z", PlanStatus::Pending)
        ]
    );
}

#[test]
fn a_todo_result_that_failed_leaves_the_plan_alone() {
    let line = result(
        "r1",
        "c1",
        "todo",
        "nope",
        Some(phases(&[("x", "pending")])),
        true,
    );
    let (f, _) = run(&[line]);
    assert!(f.plan.is_empty());
}

#[test]
fn the_log_of_a_subagent_maps_unchanged_its_assignment_is_the_first_message() {
    let (f, m) = run(&subagent_log());
    assert!(f.texts(Role::User)[0].starts_with("Complete assignment thoroughly:"));
    let y = f.tool("c_yield").unwrap();
    assert_eq!(name(y), "yield");
    assert_eq!(status(y), "completed");
    assert_eq!(tool_text(y), "Result submitted.");
    assert!(m.open_tool_calls().is_empty());
}

// -- subagents and messages between agents --------------------------------------------------------------------

#[test]
fn a_task_run_shows_a_roster_and_the_subagent_ends_completed() {
    let (f, m) = run(&subagent_task());
    let task = f.tool("c_task").unwrap();
    assert_eq!(kind(task), "other");
    assert_eq!(status(task), "completed");
    assert_eq!(title(task), "Subagents: PongReply");
    assert!(tool_text(task).starts_with("PongReply (task): pending - Reply with the word pong"));
    assert!(!tool_text(task).contains("NEVER poll"));
    let subs = m.subagents();
    assert_eq!(subs.len(), 1);
    let info = &subs[0];
    assert_eq!(info.name, "PongReply");
    assert_eq!(info.agent, "task");
    // The wait result said so.
    assert_eq!(info.status, "completed");
    assert_eq!(
        info.assignment,
        "Reply with the word pong and do nothing else."
    );
    assert_eq!(info.tool_count, 0);
    assert_eq!(name(f.tool("c_wait").unwrap()), "wait");
}

#[test]
fn two_subagents_a_message_each_way_a_finished_and_a_failed_job() {
    let (f, m) = run(&subagents_irc());
    let task = f.tool("call_task").unwrap();
    assert_eq!(title(task), "Subagents: Alpha, Beta");
    assert_eq!(
        tool_text(task).split('\n').collect::<Vec<_>>(),
        [
            "Alpha (task): running - Write the parser.",
            "Beta (explore): pending - Find the callers."
        ]
    );
    let subs = m.subagents();
    let names: Vec<&str> = subs.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["Alpha", "Beta"]);
    let alpha = &subs[0];
    // The async-result said so.
    assert_eq!(alpha.status, "completed");
    assert_eq!(alpha.tool_count, 2);
    assert_eq!(alpha.recent_tools, ["read", "grep"]);
    assert_eq!(alpha.assignment, "Write the parser.\nUse records.");
    let beta = &subs[1];
    assert_eq!(
        (beta.agent.as_str(), beta.status.as_str()),
        ("explore", "failed")
    );

    assert_eq!(
        f.texts(Role::Agent)[..2],
        [
            "this agent → Alpha: Please also add a unit test.",
            "Alpha → this agent: Parser is done, tests added."
        ]
    );
    // A message to an agent is a note, not a tool row.
    assert!(f.tool("call_irc").is_none());
    assert!(m.open_tool_calls().is_empty());
    assert!(!subs.iter().any(|s| s.name == "bg_1"));
}

#[test]
fn a_long_assignment_is_cut_to_about_400_characters() {
    let mut m = OmpMapper::new();
    m.map(&calls(
        "a1",
        vec![task_call(
            "c1",
            json!([{"name": "Long", "task": "x".repeat(5000)}]),
        )],
    ));
    let subs = m.subagents();
    assert!(subs[0].assignment.chars().count() <= 400);
    assert!(subs[0].assignment.ends_with('…'));
}

#[test]
fn a_kill_reports_the_subagents_it_touched_a_failed_one_stays_failed_a_running_one_ends_cancelled()
{
    let mut m = OmpMapper::new();
    let kill = |who: &str, st: &str| {
        result(
            &format!("k{who}"),
            &format!("kill{who}"),
            "write",
            "## Cancelled (1)",
            Some(json!({"proc": {"op": "cancel",
                "jobs": [{"id": who, "type": "task", "status": st}],
                "cancelled": [{"id": who, "status": "cancelled"}]}})),
            false,
        )
    };
    feed_only(
        &mut m,
        &[
            calls(
                "a1",
                vec![task_call(
                    "c1",
                    json!([{"name": "Dead", "task": "x"}, {"name": "Live", "task": "y"}]),
                )],
            ),
            result(
                "r1",
                "c1",
                "task",
                "Spawned 2 background agents.",
                Some(json!({"progress": [
                    {"id": "Dead", "status": "pending"}, {"id": "Live", "status": "pending"}]})),
                false,
            ),
            kill("Dead", "failed"),
            kill("Live", "running"),
        ],
    );
    let got: Vec<(String, String)> = m
        .subagents()
        .into_iter()
        .map(|s| (s.name, s.status))
        .collect();
    assert_eq!(
        got,
        [
            ("Dead".to_owned(), "failed".to_owned()),
            ("Live".to_owned(), "aborted".to_owned())
        ]
    );
}

// -- the question tool ----------------------------------------------------------------------------------------

#[test]
fn a_pending_question_has_questions_options_multi_and_the_recommended_index() {
    let (f, m) = run(&ask_pending());
    let ask = m.pending_ask().unwrap();
    assert_eq!(ask.tool_call_id, "toolu_ask_0001");
    assert_eq!(ask.questions.len(), 2);
    let q1 = &ask.questions[0];
    assert_eq!(q1.id, "lang");
    assert_eq!(q1.question, "Which language should the project use?");
    assert!(!q1.multi);
    assert_eq!(q1.recommended, Some(0));
    let labels: Vec<&str> = q1.options.iter().map(|o| o.label.as_str()).collect();
    assert_eq!(labels, ["Dart", "Rust", "Go"]);
    let descriptions: Vec<&str> = q1.options.iter().map(|o| o.description.as_str()).collect();
    assert_eq!(
        descriptions,
        [
            "Flutter app, shares code with the phone",
            "Fast, more setup",
            ""
        ]
    );
    let q2 = &ask.questions[1];
    assert_eq!(
        (q2.id.as_str(), q2.multi, q2.recommended),
        ("extras", true, Some(2))
    );
    assert_eq!(ids(&m.open_tool_calls()), ["toolu_ask_0001"]);

    let row = f.tool("toolu_ask_0001").unwrap();
    assert_eq!(kind(row), "other");
    assert_eq!(status(row), "in_progress");
    assert_eq!(title(row), "Asking about the setup");
    assert_eq!(row["rawInput"]["questions"].as_array().unwrap().len(), 2);
}

#[test]
fn the_result_clears_the_question_and_completes_the_row() {
    let lines = ask_answered();
    let mut m = OmpMapper::new();
    let mut f = Fold::default();
    feed(&mut m, &mut f, &lines[..3]);
    let ask = m.pending_ask().unwrap();
    let counts: Vec<usize> = ask.questions.iter().map(|q| q.options.len()).collect();
    assert_eq!(counts, [2, 2]);
    assert_eq!(ask.questions[1].recommended, None);
    feed(&mut m, &mut f, &lines[3..]);
    assert!(m.pending_ask().is_none());
    assert!(m.open_tool_calls().is_empty());
    let row = f.tool("toolu_ask_0002").unwrap();
    assert_eq!(status(row), "completed");
    assert!(row["rawOutput"].as_str().unwrap().contains("lang: Dart"));
    assert_eq!(
        f.texts(Role::Agent)[1..],
        ["Setting up my-project in Dart."]
    );
}

#[test]
fn a_failed_result_from_a_cancelled_dialog_clears_the_question_too() {
    let mut m = OmpMapper::new();
    m.map(&calls(
        "a1",
        vec![call(
            "c1",
            "ask",
            json!({"questions": [{"id": "q", "question": "Sure?", "options": [{"label": "Yes"}]}]}),
            None,
        )],
    ));
    assert!(m.pending_ask().is_some());
    let u = m.map(&result("r1", "c1", "ask", "cancelled", None, true));
    assert!(m.pending_ask().is_none());
    assert_eq!(u.len(), 1);
    let Update::ToolPatch(p) = &u[0] else {
        panic!("a patch")
    };
    assert_eq!(p["status"], "failed");
}

#[test]
fn a_later_user_message_clears_the_question_and_cancels_the_row() {
    let mut m = OmpMapper::new();
    let mut f = Fold::default();
    feed(&mut m, &mut f, &ask_pending());
    assert!(m.pending_ask().is_some());
    feed(
        &mut m,
        &mut f,
        &[user("typed", "I answered in the terminal")],
    );
    assert!(m.pending_ask().is_none());
    assert!(m.open_tool_calls().is_empty());
    assert_eq!(status(f.tool("toolu_ask_0001").unwrap()), "cancelled");
}

#[test]
fn hostile_question_shapes_options_as_strings_out_of_range_recommended_no_id_no_questions() {
    let mut m = OmpMapper::new();
    m.map(&calls(
        "a1",
        vec![call(
            "c1",
            "ask",
            json!({"questions": [
                {"question": "Pick", "options": ["A", "B", 7, {"nolabel": true}], "recommended": 9},
                {"id": "neg", "question": "Neg", "options": ["A"], "recommended": -1},
                "garbage",
            ]}),
            None,
        )],
    ));
    let ask = m.pending_ask().unwrap();
    let qids: Vec<&str> = ask.questions.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(qids, ["q0", "neg"]);
    let labels: Vec<&str> = ask.questions[0]
        .options
        .iter()
        .map(|o| o.label.as_str())
        .collect();
    assert_eq!(labels, ["A", "B"]);
    assert!(ask.questions.iter().all(|q| q.recommended.is_none()));

    let mut empty = OmpMapper::new();
    empty.map(&calls(
        "a2",
        vec![call("c2", "ask", json!({"questions": []}), None)],
    ));
    assert!(empty.pending_ask().is_none());
    // The row still runs.
    assert_eq!(ids(&empty.open_tool_calls()), ["c2"]);
}

#[test]
fn an_assistant_abort_cancels_the_question() {
    let mut m = OmpMapper::new();
    m.map(&calls(
        "a1",
        vec![call(
            "c1",
            "ask",
            json!({"questions": [{"id": "q", "question": "Sure?", "options": ["Yes"]}]}),
            None,
        )],
    ));
    m.map(&assistant("a2", vec![], "aborted"));
    assert!(m.pending_ask().is_none());
    assert!(m.open_tool_calls().is_empty());
}

// -- housekeeping, errors, odd input --------------------------------------------------------------------------

#[test]
fn a_wait_omp_skipped_or_had_nothing_to_wait_for_did_not_fail() {
    let lines = [
        user("u1", "go"),
        calls(
            "a1",
            vec![call(
                "c1",
                "wait",
                json!({"i": "Waiting for reviewers"}),
                None,
            )],
        ),
        result(
            "r1",
            "c1",
            "wait",
            "Skipped due to a queued background completion (job or supervised process). Do not count this skipped result as completed work.",
            Some(
                json!({"__interrupted": true, "source": "interrupt_skipped", "execution": "started"}),
            ),
            true,
        ),
        calls(
            "a2",
            vec![call(
                "c2",
                "wait",
                json!({"i": "Waiting for fix agents"}),
                None,
            )],
        ),
        result(
            "r2",
            "c2",
            "wait",
            "Nothing to wait for: no background job or service you started is running.",
            None,
            true,
        ),
        calls(
            "a2b",
            vec![call(
                "c5",
                "write",
                json!({"path": "a.md", "content": "x"}),
                None,
            )],
        ),
        result(
            "r5",
            "c5",
            "write",
            "Skipped due to queued user message. Do not count this skipped result as completed work.",
            Some(json!({"__synthetic": true, "source": "interrupt_skipped", "executed": false})),
            true,
        ),
        calls(
            "a3",
            vec![call("c3", "bash", json!({"command": "false"}), None)],
        ),
        result("r3", "c3", "bash", "exit 1", None, true),
        said("a4", "Done."),
    ];
    let (f, _) = run(&lines);
    assert_eq!(status(f.tool("c1").unwrap()), "cancelled");
    // What the UI reads to tell a skipped call from an interrupted one.
    assert_eq!(f.tool("c1").unwrap()["_meta"]["herdr"]["skipped"], true);
    assert_eq!(f.tool("c5").unwrap()["_meta"]["herdr"]["skipped"], true);
    assert_eq!(status(f.tool("c2").unwrap()), "completed");
    assert!(f.tool("c2").unwrap().get("_meta").is_none());
    // A real error is still one.
    assert_eq!(status(f.tool("c3").unwrap()), "failed");
    assert!(f.tool("c3").unwrap().get("_meta").is_none());
    // The row says what happened.
    assert!(
        tool_text(f.tool("c1").unwrap()).contains("Skipped due to a queued background completion")
    );
}

#[test]
fn compaction_and_branch_summary_are_quiet_notes_a_clear_drops_what_came_before_the_header_title_shows()
 {
    let (f, _) = run(&compaction_branch());
    assert_eq!(f.title.as_deref(), Some("Long running work"));
    assert_eq!(f.texts(Role::User), ["After the clear"]);
    assert_eq!(
        f.texts(Role::Agent),
        ["The conversation was cleared on the machine"]
    );
    let roles: Vec<Role> = f
        .items
        .iter()
        .map(|i| match i {
            Item::Msg { role, .. } => *role,
            Item::Tool(_) => panic!("no tool"),
        })
        .collect();
    // The note opens the new conversation, nothing from before it stays.
    assert_eq!(roles, [Role::Agent, Role::User]);
}

#[test]
fn compaction_and_branch_summary_notes_sit_where_they_happened() {
    let (f, _) = run(&[
        "{\"type\":\"message\",\"id\":\"n1\",\"timestamp\":\"2026-10-04T11:30:00.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Q\"}]}}".to_owned(),
        "{\"type\":\"compaction\",\"id\":\"n2\",\"timestamp\":\"2026-10-04T11:31:00.000Z\"}".to_owned(),
        "{\"type\":\"message\",\"id\":\"n3\",\"timestamp\":\"2026-10-04T11:32:00.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Q2\"}]}}".to_owned(),
    ]);
    let roles: Vec<Role> = f
        .messages(None)
        .iter()
        .map(|(id, _)| match *id {
            "n2" => Role::Agent,
            _ => Role::User,
        })
        .collect();
    assert_eq!(roles, [Role::User, Role::Agent, Role::User]);
    assert_eq!(f.texts(Role::Agent), ["Earlier messages were summarised"]);
}

#[test]
fn a_failed_turn_says_so_with_the_error_text_and_interrupted_calls_are_cancelled() {
    let (f, m) = run(&turn_error());
    assert_eq!(
        f.texts(Role::Agent),
        [
            "Starting the build.",
            "The turn failed: 529 overloaded_error: the model is overloaded, try again later"
        ]
    );
    assert_eq!(status(f.tool("toolu_build_0001").unwrap()), "cancelled");
    // aborted
    assert_eq!(status(f.tool("toolu_build_0002").unwrap()), "cancelled");
    assert!(m.open_tool_calls().is_empty());
}

#[test]
fn an_error_without_a_message_still_says_the_turn_failed() {
    let mut m = OmpMapper::new();
    let mut f = Fold::default();
    for u in m.map(&assistant("a1", vec![], "error")) {
        f.apply(u);
    }
    assert_eq!(f.texts(Role::Agent), ["The turn failed."]);
}

#[test]
fn odd_entries_hidden_ones_stay_hidden_shown_ones_show_nothing_breaks() {
    let (f, m) = run(&odd_entries());
    assert_eq!(
        f.texts(Role::User),
        [
            "A plain string user message",
            "/skill:tdd the parser",
            "Look at this screenshot"
        ]
    );
    let users = f.messages(Some(Role::User));
    let shots: Vec<&LogImage> = users[2]
        .1
        .iter()
        .filter_map(|b| match b {
            Block::Image(i) => Some(i),
            Block::Text(_) => None,
        })
        .collect();
    assert_eq!(shots.len(), 1);
    assert_eq!(shots[0].mime, "image/png");
    assert_eq!(
        shots[0].source,
        PictureRef::Omp {
            sha256: SHA_ZERO.to_owned(),
            bytes: None
        }
    );
    // Blank and redacted thinking are dropped.
    assert_eq!(f.texts(Role::Agent), ["Visible answer"]);
    assert!(f.messages(Some(Role::Thought)).is_empty());
    assert_eq!(f.title.as_deref(), Some("Odd entries session"));

    let tools = f.tools();
    let runs: Vec<_> = tools
        .iter()
        .filter(|c| c["toolCallId"].as_str().unwrap().starts_with("run:"))
        .collect();
    let seen: Vec<(&str, &str, &str)> = runs
        .iter()
        .map(|c| (title(c), status(c), kind(c)))
        .collect();
    assert_eq!(
        seen,
        [
            ("git status --short", "completed", "execute"),
            ("false", "failed", "execute")
        ]
    );
    assert_eq!(tool_text(runs[0]), " M lib/a.dart\n");

    let orphan = f.tool("toolu_orphan_0001").unwrap();
    assert_eq!(
        (name(orphan), kind(orphan), status(orphan)),
        ("read", "read", "completed")
    );
    assert_eq!(title(orphan), "read");
    assert_eq!(
        tool_text(orphan),
        "a result whose call this log never showed"
    );

    let grep = f.tool("toolu_str_args").unwrap();
    assert_eq!(title(grep), "grep: src");
    // Arguments sent as a JSON string.
    assert_eq!(grep["rawInput"]["pattern"], "needle");
    assert_eq!(ids(&m.open_tool_calls()), ["toolu_str_args"]);

    // The call with no id and the result with no call id are dropped.
    assert!(
        tools
            .iter()
            .all(|c| !c["toolCallId"].as_str().unwrap().is_empty())
    );
    assert_eq!(tools.len(), runs.len() + 2);
}

#[test]
fn a_line_fed_twice_in_a_row_shows_once() {
    let doubled: Vec<String> = odd_entries()
        .into_iter()
        .flat_map(|l| [l.clone(), l])
        .collect();
    let (f, _) = run(&doubled);
    assert_eq!(f.texts(Role::Agent), ["Visible answer"]);
}

#[test]
fn unknown_and_malformed_lines_give_nothing_and_never_panic() {
    let mut m = OmpMapper::new();
    let deep = "[".repeat(100_000);
    let bad = [
        String::new(),
        "   ".into(),
        "not json".into(),
        "{".into(),
        "{\"type\":".into(),
        "[1,2]".into(),
        "null".into(),
        "\"s\"".into(),
        "42".into(),
        "{}".into(),
        "{\"type\":null}".into(),
        "{\"type\":\"message\"}".into(),
        "{\"type\":\"message\",\"message\":[]}".into(),
        "{\"type\":\"message\",\"message\":{\"role\":5}}".into(),
        "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":7}}".into(),
        "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[1,\"x\",null,{\"type\":\"toolCall\",\"id\":5,\"name\":{}}]}}".into(),
        "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":3}}".into(),
        "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":5}]}}".into(),
        "{\"type\":\"custom_message\",\"attribution\":\"user\",\"display\":true,\"content\":{}}".into(),
        "{\"type\":\"custom\",\"customType\":\"user_todo_edit\",\"data\":\"x\"}".into(),
        "{\"type\":\"compaction\"}".into(),
        "{\"type\":\"title_change\",\"title\":5}".into(),
        "{\"type\":\"future\",\"id\":\"zz\",\"x\":[1,2,3]}".into(),
        format!("{{\"type\":\"message\",\"message\":{{\"role\":\"assistant\",\"content\":[]}}}}{deep}"),
        format!("{{\"type\":\"message\",\"message\":{deep}"),
    ];
    for line in &bad {
        let u = m.map(line);
        // The one line that is a whole entry (a compaction) gives its note; nothing else gives anything.
        if line == "{\"type\":\"compaction\"}" {
            assert_eq!(u.len(), 1);
        } else {
            assert!(u.is_empty(), "{}", &line[..line.len().min(80)]);
        }
    }
    assert!(m.open_tool_calls().is_empty());
    assert!(m.pending_ask().is_none());
}

#[test]
fn zero_and_one_entries() {
    let (f, _) = run(&[]);
    assert!(f.items.is_empty());
    let (f, _) = run(&[user("only", "hi")]);
    assert_eq!(f.texts(Role::User), ["hi"]);
}

// -- pictures in a message ------------------------------------------------------------------------------------

fn picture_user(id: &str, content: Value) -> String {
    entry(
        json!({"type": "message", "id": id, "timestamp": "2026-10-04T13:00:09.000Z",
        "message": {"role": "user", "content": content, "attribution": "user"}}),
    )
}

#[test]
fn an_image_whose_data_is_a_blob_reference_is_a_block_any_other_keeps_the_image_line() {
    let sha = "ab".repeat(32);
    let (f, _) = run(&[picture_user(
        "e1",
        json!([
            {"type": "text", "text": "see"},
            {"type": "image", "data": format!("blob:sha256:{sha}"), "mimeType": "image/webp"},
            {"type": "image", "data": "blob:sha256:ff", "mimeType": "image/png"},
        ]),
    )]);
    let msgs = f.messages(Some(Role::User));
    assert_eq!(msgs.len(), 1);
    let pictures: Vec<&LogImage> = msgs[0]
        .1
        .iter()
        .filter_map(|b| match b {
            Block::Image(i) => Some(i),
            Block::Text(_) => None,
        })
        .collect();
    assert_eq!(pictures.len(), 1);
    assert_eq!(pictures[0].mime, "image/webp");
    assert_eq!(
        pictures[0].source,
        PictureRef::Omp {
            sha256: sha.clone(),
            bytes: None
        }
    );
    assert_eq!(pictures[0].source.key(), format!("omp-{sha}"));
    // What cannot be fetched stays a line.
    assert_eq!(text_of(msgs[0].1), "see\n[image: image/png]");
}

#[test]
fn a_picture_alone_is_a_message_and_mapping_it_twice_does_not_double_it() {
    let line = picture_user(
        "e2",
        json!([{"type": "image", "data": format!("blob:sha256:{}", "ab".repeat(32)), "mimeType": "image/png"}]),
    );
    let (once, _) = run(std::slice::from_ref(&line));
    let msgs = once.messages(Some(Role::User));
    assert_eq!(msgs.len(), 1);
    assert!(matches!(msgs[0].1, [Block::Image(_)]));
    // Into the same state with a new mapper: the upsert replaces.
    let mut twice = once;
    let mut m = OmpMapper::new();
    feed(&mut m, &mut twice, std::slice::from_ref(&line));
    assert_eq!(twice.messages(Some(Role::User)).len(), 1);
}

// -- edit modes, paths and kinds ------------------------------------------------------------------------------

#[test]
fn replace_mode_edit_multi_file_result_failed_write_read_selector_other_kinds() {
    let (f, m) = run(&edit_modes());
    assert!(m.open_tool_calls().is_empty());

    let read = f.tool("call_rd").unwrap();
    assert_eq!(paths(read), ["/work/proj/src/a.dart"]);
    assert_eq!(read["locations"][0]["line"], 10);

    let rep = f.tool("call_rep").unwrap();
    let rd = diffs(rep);
    assert_eq!(rd.len(), 1);
    assert_eq!(rd[0]["path"], "/work/proj/src/b.dart");
    assert_eq!(rd[0]["oldText"], "int x = 1;\nint y = 0;");
    assert_eq!(rd[0]["newText"], "int x = 2;\nint y = 0;");
    assert_eq!(paths(rep), ["/work/proj/src/b.dart"]);

    let multi = f.tool("call_multi").unwrap();
    assert_eq!(title(multi), "Editing two files");
    let md = diffs(multi);
    // The pruned file has no snapshot, so no diff.
    assert_eq!(md.len(), 2);
    assert_eq!(md[0]["path"], "/work/proj/src/c.dart");
    assert_eq!(md[0]["oldText"], "zero\n");
    assert_eq!(md[0]["newText"], "one\n");
    assert_eq!(md[1]["path"], "/work/proj/src/e.dart");
    assert!(md[1].get("oldText").is_none());
    assert_eq!(md[1]["newText"], "brand new\n");
    let mp = paths(multi);
    for p in [
        "/work/proj/src/c.dart",
        "/work/proj/src/d.dart",
        "/work/proj/src/e.dart",
    ] {
        assert!(mp.contains(&p), "{p}");
    }

    let wr = f.tool("call_wr").unwrap();
    assert_eq!(status(wr), "failed");
    // A failed write changed nothing.
    assert!(diffs(wr).is_empty());
    assert!(tool_text(wr).starts_with("Error: permission denied"));

    let web = f.tool("call_web").unwrap();
    assert_eq!(
        (kind(web), title(web), status(web)),
        ("fetch", "web_search: dart records", "completed")
    );

    let tools = f.tools();
    let py: Vec<_> = tools.iter().filter(|c| name(c) == "python").collect();
    assert_eq!(py.len(), 1);
    assert_eq!(
        (name(py[0]), title(py[0]), kind(py[0]), status(py[0])),
        ("python", "print(1+1)", "execute", "completed")
    );
    assert_eq!(py[0]["rawInput"]["code"], "print(1+1)\nprint('x')");
}

#[test]
fn the_arguments_of_a_replace_edit_already_show_the_change_while_it_runs() {
    let lines = edit_modes();
    let (f, m) = run(&lines[..3]);
    let rep = f.tool("call_rep").unwrap();
    assert_eq!(status(rep), "in_progress");
    let d = diffs(rep);
    assert_eq!(d.len(), 1);
    assert_eq!(
        (d[0]["oldText"].as_str(), d[0]["newText"].as_str()),
        (Some("int x = 1;"), Some("int x = 2;"))
    );
    assert_eq!(
        ids(&m.open_tool_calls()),
        ["call_multi", "call_rd", "call_rep", "call_web", "call_wr"]
    );
}

#[test]
fn a_path_outside_any_cwd_stays_as_it_is_and_internal_urls_give_no_location() {
    let (f, _) = run(&[calls(
        "a1",
        vec![
            call("c1", "read", json!({"path": "skill://tdd"}), None),
            call("c2", "read", json!({"path": "rel/x.dart"}), None),
        ],
    )]);
    assert!(paths(f.tool("c1").unwrap()).is_empty());
    // No session header, no cwd.
    assert_eq!(paths(f.tool("c2").unwrap()), ["rel/x.dart"]);
}

#[test]
fn titles_the_calls_own_words_first_then_what_it_works_on() {
    let (f, _) = run(&[calls(
        "a1",
        vec![
            call(
                "c1",
                "bash",
                json!({"command": "ls -la\necho second line"}),
                None,
            ),
            call(
                "c2",
                "bash",
                json!({"command": "x", "i": "Listing files"}),
                None,
            ),
            call("c3", "grep", json!({"pattern": "foo"}), None),
            call("c4", "mystery", json!({}), None),
            call("c5", "bash", json!({"command": "y".repeat(500)}), None),
            call(
                "c6",
                "edit",
                json!({"i": "Multi\nline intent"}),
                Some("Multi\nline intent"),
            ),
        ],
    )]);
    assert_eq!(title(f.tool("c1").unwrap()), "ls -la");
    assert_eq!(title(f.tool("c2").unwrap()), "Listing files");
    assert_eq!(title(f.tool("c3").unwrap()), "grep: foo");
    assert_eq!(title(f.tool("c4").unwrap()), "mystery");
    assert_eq!(title(f.tool("c5").unwrap()).chars().count(), 120);
    assert!(title(f.tool("c5").unwrap()).ends_with('…'));
    assert_eq!(title(f.tool("c6").unwrap()), "Multi");
}

// -- idempotence and reset ------------------------------------------------------------------------------------

#[test]
fn every_log_fed_twice_line_by_line_twice_or_overlapped_changes_nothing() {
    for (name, lines) in all_logs() {
        let once = run(&lines).0.fingerprint();

        let both: Vec<String> = lines.iter().chain(&lines).cloned().collect();
        assert_eq!(
            run(&both).0.fingerprint(),
            once,
            "{name}: replayed log, same mapper"
        );

        // A fresh mapper replaying into the state the first one built.
        let (mut state, _) = run(&lines);
        feed(&mut OmpMapper::new(), &mut state, &lines);
        assert_eq!(
            state.fingerprint(),
            once,
            "{name}: replayed log, new mapper"
        );

        let doubled: Vec<String> = lines.iter().flat_map(|l| [l.clone(), l.clone()]).collect();
        assert_eq!(
            run(&doubled).0.fingerprint(),
            once,
            "{name}: every line twice"
        );

        // A resume that overlaps: the last few lines come again.
        let (mut state, mut m) = run(&lines);
        let tail = lines.len().saturating_sub(4);
        feed(&mut m, &mut state, &lines[tail..]);
        assert_eq!(state.fingerprint(), once, "{name}: overlapping tail");
    }
}

#[test]
fn a_replayed_older_title_plan_edit_or_exit_does_not_undo_the_newer_one() {
    let plan = |id: &str, content: &str, status: &str| {
        entry(
            json!({"type": "custom", "customType": "user_todo_edit", "id": id,
            "data": phases(&[(content, status)])}),
        )
    };
    let lines = [
        entry(json!({"type": "session", "id": "sess", "cwd": "/w", "title": "First"})),
        entry(json!({"type": "title_change", "id": "t1", "title": "Second"})),
        plan("p1", "old", "pending"),
        plan("p2", "new", "completed"),
    ];
    let (mut f, mut m) = run(&lines);
    feed(&mut m, &mut f, &lines);
    assert_eq!(f.title.as_deref(), Some("Second"));
    let plan: Vec<&str> = f.plan.iter().map(|p| p.content.as_str()).collect();
    assert_eq!(plan, ["new"]);
}

#[test]
fn the_same_mapper_reports_the_same_pending_question_and_open_calls_after_a_replay() {
    let lines = ask_pending();
    let mut m = OmpMapper::new();
    feed_only(&mut m, &lines);
    feed_only(&mut m, &lines);
    assert_eq!(m.pending_ask().unwrap().tool_call_id, "toolu_ask_0001");
    assert_eq!(ids(&m.open_tool_calls()), ["toolu_ask_0001"]);
}

#[test]
fn reset_forgets_everything_and_the_log_can_be_mapped_again_from_the_start() {
    let mut m = OmpMapper::new();
    let lines = subagents_irc();
    let mut f = Fold::default();
    feed(&mut m, &mut f, &lines);
    let first = f.fingerprint();
    feed_only(&mut m, &ask_pending());
    assert!(m.pending_ask().is_some());
    m.reset();
    assert!(m.pending_ask().is_none());
    assert!(m.open_tool_calls().is_empty());
    assert!(m.subagents().is_empty());
    let mut again = Fold::default();
    feed(&mut m, &mut again, &lines);
    // Not suppressed as a duplicate.
    assert_eq!(again.fingerprint(), first);
    // The cwd is forgotten too: a relative path stays relative.
    m.reset();
    let mut f = Fold::default();
    feed(
        &mut m,
        &mut f,
        &[calls(
            "a1",
            vec![call("c1", "read", json!({"path": "x.dart"}), None)],
        )],
    );
    assert_eq!(paths(f.tool("c1").unwrap()), ["x.dart"]);
}

#[test]
fn a_result_for_a_call_whose_start_was_missed_names_the_call_itself() {
    let (f, _) = run(&[ok("r1", "c9", "bash", "out")]);
    let c = f.tool("c9").unwrap();
    assert_eq!(
        (name(c), kind(c), status(c)),
        ("bash", "execute", "completed")
    );
}

// -- heavy data -----------------------------------------------------------------------------------------------

#[test]
fn five_thousand_entries_map_to_one_row_each_and_nothing_stays_open() {
    // Dart also asserts the mapping takes under a second; a wall-clock bound has no place in a test here.
    let mut lines = Vec::new();
    let mut n = 0;
    while lines.len() < 5000 {
        lines.push(user(&format!("u{n}"), &format!("question {n}")));
        lines.push(calls(
            &format!("a{n}"),
            vec![
                json!({"type": "thinking", "thinking": format!("thinking about {n}")}),
                call(
                    &format!("call{n}"),
                    "bash",
                    json!({"command": format!("echo {n}"), "i": format!("Echoing {n}")}),
                    None,
                ),
            ],
        ));
        lines.push(ok(
            &format!("r{n}"),
            &format!("call{n}"),
            "bash",
            &format!("output {n}\n{}", "line\n".repeat(20)),
        ));
        lines.push(said(&format!("b{n}"), &format!("answer {n}")));
        n += 1;
    }
    let (f, m) = run(&lines);
    assert_eq!(f.tools().len(), n);
    assert_eq!(f.messages(Some(Role::User)).len(), n);
    assert!(m.open_tool_calls().is_empty());
    assert!(f.tools().iter().all(|c| status(c) == "completed"));
}

#[test]
fn two_megabyte_fields_are_cut_with_a_visible_marker_and_never_blow_up() {
    let big = "x".repeat(2 * 1024 * 1024);
    let cap = crate::observed::model::MAX_LOG_FIELD_CHARS;
    let mark = "\n... [cut]";
    let lines = [
        user("u1", &big),
        assistant(
            "a1",
            vec![
                json!({"type": "text", "text": big}),
                json!({"type": "thinking", "thinking": big}),
                call(
                    "w",
                    "write",
                    json!({"path": "big.txt", "content": big, "i": big}),
                    None,
                ),
                call("b", "bash", json!({"command": big}), None),
                call(
                    "e",
                    "edit",
                    json!({"path": "big.txt", "old_string": big, "new_string": big}),
                    None,
                ),
            ],
            "toolUse",
        ),
        ok("r1", "w", "write", &big),
        result("r2", "b", "bash", &big, None, true),
        result(
            "r3",
            "e",
            "edit",
            "ok",
            Some(json!({"path": "big.txt", "oldText": big, "newText": big})),
            false,
        ),
        entry(
            json!({"type": "message", "id": "a2", "message": {"role": "assistant", "content": [],
            "stopReason": "error", "errorMessage": "e".repeat(2_000_000)}}),
        ),
    ];
    let (f, _) = run(&lines);
    for (id, blocks) in f.messages(None) {
        assert!(text_of(blocks).chars().count() <= cap + 300, "{id}");
    }
    assert!(f.texts(Role::User)[0].ends_with(mark));
    assert!(f.texts(Role::Agent)[0].ends_with(mark));
    let w = f.tool("w").unwrap();
    let wd = diffs(w);
    assert_eq!(
        wd[0]["newText"].as_str().unwrap().chars().count(),
        cap + mark.chars().count()
    );
    assert!(wd[0]["newText"].as_str().unwrap().ends_with(mark));
    assert_eq!(
        w["rawInput"]["content"].as_str().unwrap().chars().count(),
        cap + mark.chars().count()
    );
    assert!(tool_text(w).ends_with(mark));
    let b = f.tool("b").unwrap();
    assert!(tool_text(b).ends_with(mark));
    assert_eq!(status(b), "failed");
    let e = diffs(f.tool("e").unwrap());
    let want = cap + mark.chars().count();
    assert_eq!(
        (
            e[0]["oldText"].as_str().unwrap().chars().count(),
            e[0]["newText"].as_str().unwrap().chars().count()
        ),
        (want, want)
    );
    assert!(title(b).chars().count() <= 120);
}

#[test]
fn a_text_shorter_than_the_cap_is_left_untouched() {
    let text = format!("{}\n... [cut by host]", "y".repeat(16_000));
    let (f, _) = run(&[user("u1", &text)]);
    assert_eq!(f.texts(Role::User), [text]);
}

#[test]
fn a_cut_keeps_whole_characters() {
    // Dart cuts by UTF-16 units and must not split a surrogate pair; here the cut counts characters.
    let text = format!("a{}", "😀".repeat(30_000));
    let (f, _) = run(&[user("u1", &text)]);
    let shown = f.texts(Role::User).remove(0);
    assert!(shown.ends_with("\n... [cut]"));
    let body = shown.strip_suffix("\n... [cut]").unwrap();
    assert_eq!(
        body.chars().count(),
        crate::observed::model::MAX_LOG_FIELD_CHARS
    );
    assert!(body.chars().skip(1).all(|c| c == '😀'));
}

#[test]
fn unicode_survives_rtl_combining_marks_zero_width_emoji() {
    let text = "שלום עולם \u{301}e\u{200b}👩‍👩‍👧 日本語";
    let (f, _) = run(&[user("u1", text)]);
    assert_eq!(f.texts(Role::User), [text]);
}

// -- background work ------------------------------------------------------------------------------------------

fn key_status(m: &OmpMapper) -> Vec<(String, BackgroundStatus)> {
    m.background_tasks()
        .into_iter()
        .map(|t| (t.key(), t.status))
        .collect()
}

fn task<'a>(tasks: &'a [BackgroundTask], key: &str) -> &'a BackgroundTask {
    tasks.iter().find(|t| t.key() == key).unwrap()
}

fn active(m: &OmpMapper) -> Vec<String> {
    m.background_tasks()
        .into_iter()
        .filter(|t| t.status.is_active())
        .map(|t| t.key())
        .collect()
}

fn mapped(lines: &[String]) -> OmpMapper {
    let mut m = OmpMapper::new();
    feed_only(&mut m, lines);
    m
}

#[test]
fn a_bash_job_starts_at_the_result_with_the_command_of_its_call_and_ends_at_its_async_result() {
    let lines = background_jobs();
    let mut m = mapped(&lines[..2]);
    let tasks = m.background_tasks();
    assert_eq!(tasks.len(), 1);
    let t = &tasks[0];
    assert_eq!(
        (t.key().as_str(), t.kind, t.status, t.stop),
        (
            "0/bg_1",
            BackgroundKind::Shell,
            BackgroundStatus::Running,
            StopRoute::Message
        )
    );
    assert!(
        t.title
            .starts_with("export MODEL=demo AGENT=tool; ./run paper")
    );
    assert!(t.title.chars().count() <= 120);
    assert!(t.detail.as_deref().unwrap().contains("nvidia-smi"));
    assert_eq!(t.deadline_secs, Some(300));
    assert_eq!(t.started_ms, Some(1_790_984_123_245));
    assert_eq!(t.tool_call_id.as_deref(), Some("c_bg1"));
    assert!(!m.turn_ended());

    feed_only(&mut m, &lines[2..3]);
    let tasks = m.background_tasks();
    let done = &tasks[0];
    assert_eq!(done.status, BackgroundStatus::Finished);
    assert!(done.ended_ms.is_some());
    assert!(!done.status.is_active());
    assert_eq!(done.stop, StopRoute::None);
    // An async-result starts a turn.
    assert!(!m.turn_ended());
}

#[test]
fn a_task_call_adds_every_subagent_of_its_progress_and_wait_results_settle_them_one_by_one() {
    let lines = background_jobs();
    let mut m = mapped(&lines[..5]);
    assert_eq!(
        key_status(&m),
        [
            ("0/bg_1".to_owned(), BackgroundStatus::Finished),
            ("0/RLFrameworks".to_owned(), BackgroundStatus::Running),
            ("0/SFTStacks".to_owned(), BackgroundStatus::Running),
            ("0/PapersUse".to_owned(), BackgroundStatus::Running),
        ]
    );
    let tasks = m.background_tasks();
    let rl = task(&tasks, "0/RLFrameworks");
    assert_eq!(
        (rl.kind, rl.title.as_str(), rl.stop),
        (BackgroundKind::Agent, "RLFrameworks", StopRoute::Message)
    );
    assert!(rl.detail.as_deref().unwrap().starts_with("# Target"));
    assert!(rl.detail.as_deref().unwrap().chars().count() <= 400);
    // Still a subagent too.
    let names: Vec<String> = m.subagents().into_iter().map(|s| s.name).collect();
    assert_eq!(names, ["RLFrameworks", "SFTStacks", "PapersUse"]);

    let status_of =
        |m: &OmpMapper, key: &str| key_status(m).into_iter().find(|(k, _)| k == key).unwrap().1;
    feed_only(&mut m, &lines[5..6]);
    assert_eq!(status_of(&m, "0/PapersUse"), BackgroundStatus::Finished);
    // A running job stays.
    assert_eq!(status_of(&m, "0/RLFrameworks"), BackgroundStatus::Running);
    feed_only(&mut m, &lines[6..7]);
    assert_eq!(status_of(&m, "0/SFTStacks"), BackgroundStatus::Finished);
    assert_eq!(status_of(&m, "0/RLFrameworks"), BackgroundStatus::Running);
}

#[test]
fn session_exit_stops_what_ran_and_the_next_process_starts_a_new_epoch() {
    let lines = background_jobs();
    let mut m = mapped(&lines[..8]);
    let tasks = m.background_tasks();
    let rl = task(&tasks, "0/RLFrameworks");
    assert_eq!(rl.status, BackgroundStatus::Stopped);
    assert_eq!(rl.ended_ms, Some(1_791_041_124_570));
    assert!(active(&m).is_empty());

    feed_only(&mut m, &lines[8..11]);
    let tasks = m.background_tasks();
    // "Command timed out after 3000 seconds"
    assert_eq!(task(&tasks, "1/bg_4").status, BackgroundStatus::Failed);
    assert_eq!(task(&tasks, "1/bg_4").deadline_secs, Some(3000));
}

#[test]
fn the_whole_log_bg_6_outlives_the_turn_that_ended_with_stop() {
    let lines = background_jobs();
    let mut m = mapped(&lines[..14]);
    // The wait result came last.
    assert!(!m.turn_ended());
    assert_eq!(active(&m), ["1/bg_6"]);
    feed_only(&mut m, &lines[14..]);
    assert!(m.turn_ended());
    assert_eq!(active(&m), ["1/bg_6"]);
    let tasks = m.background_tasks();
    let running = task(&tasks, "1/bg_6");
    // timeoutDisabled
    assert_eq!(running.deadline_secs, None);
    assert!(running.title.starts_with("F=data/coder2b/"));
    assert_eq!(running.started_ms, Some(1_791_181_602_445));
    // bg_1, three subagents, bg_4, bg_6
    assert_eq!(tasks.len(), 6);
}

#[test]
fn replayed_and_overlapped_lines_change_nothing_and_reset_forgets_all() {
    let lines = background_jobs();
    let mut m = mapped(&lines);
    let once = m.background_tasks();
    feed_only(&mut m, &lines);
    assert_eq!(m.background_tasks(), once);
    feed_only(&mut m, &lines[lines.len() - 4..]);
    assert_eq!(m.background_tasks(), once);
    assert!(m.turn_ended());
    m.reset();
    assert!(m.background_tasks().is_empty());
    assert!(!m.turn_ended());
    feed_only(&mut m, &lines);
    // The same epochs and statuses after a rebuild.
    assert_eq!(m.background_tasks(), once);
}

#[test]
fn eval_jobs_take_the_title_from_the_code_no_timestamp_means_no_start_a_limit_of_0_is_none() {
    let m = mapped(&[
        bg_call(
            "a1",
            "c1",
            "eval",
            json!({"code": "\n  import time\ntime.sleep(900)"}),
        ),
        bg_start("r1", "c1", "bg_1", "eval", "eval", Some(json!(0)), None),
    ]);
    let tasks = m.background_tasks();
    assert_eq!(tasks.len(), 1);
    let t = &tasks[0];
    assert_eq!(
        (t.kind, t.title.as_str(), t.started_ms, t.deadline_secs),
        (BackgroundKind::Eval, "import time", None, None)
    );
    assert!(t.detail.as_deref().unwrap().contains("time.sleep(900)"));
}

#[test]
fn a_job_whose_call_was_not_seen_is_titled_by_its_id() {
    let m = mapped(&[bg_start("r1", "c1", "bg_9", "bash", "bash", None, Some(T0))]);
    let t = &m.background_tasks()[0];
    assert_eq!((t.title.as_str(), t.detail.as_deref()), ("bg_9", None));
}

#[test]
fn a_timeout_from_the_result_and_the_start_stamp_are_kept_for_the_view_to_judge() {
    // Dart also tests `BackgroundTask.pastDeadline` here; that method is the background view's, not the
    // mapper's. What the mapper owes it is the two facts it computes from.
    let m = mapped(&[
        bg_call("a1", "c1", "bash", json!({"command": "sleep 99"})),
        bg_start(
            "r1",
            "c1",
            "bg_1",
            "bash",
            "bash",
            Some(json!(120)),
            Some(T0),
        ),
    ]);
    let t = &m.background_tasks()[0];
    assert_eq!(t.started_ms, Some(T0_MS));
    assert_eq!(parse_iso_millis(T0), Some(T0_MS));
    assert_eq!(t.deadline_secs, Some(120));
}

#[test]
fn ids_restart_with_the_process_bg_1_before_and_after_session_exit_are_two_tasks() {
    let mut m = mapped(&[
        bg_call("a1", "c1", "bash", json!({"command": "first"})),
        bg_start("r1", "c1", "bg_1", "bash", "bash", None, Some(T0)),
        stamped(
            "x1",
            T0,
            json!({"type": "custom", "customType": "session_exit", "data": {"reason": "sighup"}}),
        ),
        bg_call("a2", "c2", "bash", json!({"command": "second"})),
        bg_start("r2", "c2", "bg_1", "bash", "bash", None, Some(T0)),
    ]);
    let got: Vec<(String, String, BackgroundStatus)> = m
        .background_tasks()
        .into_iter()
        .map(|t| (t.key(), t.title, t.status))
        .collect();
    assert_eq!(
        got,
        [
            (
                "0/bg_1".to_owned(),
                "first".to_owned(),
                BackgroundStatus::Stopped
            ),
            (
                "1/bg_1".to_owned(),
                "second".to_owned(),
                BackgroundStatus::Running
            )
        ]
    );
    feed_only(&mut m, &[bg_finished("f1", &["bg_1"], "done", None)]);
    // The notice is for the new process.
    assert_eq!(
        key_status(&m),
        [
            ("0/bg_1".to_owned(), BackgroundStatus::Stopped),
            ("1/bg_1".to_owned(), BackgroundStatus::Finished)
        ]
    );
}

#[test]
fn a_kill_the_model_issued_details_proc_cancelled_and_the_text_when_the_details_are_missing() {
    let m = mapped(&[
        bg_start("r1", "c1", "bg_1", "bash", "bash", None, Some(T0)),
        bg_start("r2", "c2", "bg_2", "bash", "bash", None, Some(T0)),
        bg_start("r3", "c3", "bg_3", "bash", "bash", None, Some(T0)),
        result(
            "k1",
            "k1c",
            "write",
            "## Cancelled (1)\n\n- Cancelled background job bg_1.",
            Some(json!({"proc": {"op": "cancel",
                "jobs": [{"id": "bg_1", "type": "bash", "status": "cancelled"}],
                "cancelled": [{"id": "bg_1", "status": "cancelled"}]}})),
            false,
        ),
        ok("k2", "k2c", "write", "Cancelled background job bg_2.\n"),
        ok("k3", "k3c", "write", "Cancelled background job bg_3 later"),
    ]);
    // Only a full "Cancelled background job <id>." sentence counts.
    assert_eq!(
        key_status(&m),
        [
            ("0/bg_1".to_owned(), BackgroundStatus::Stopped),
            ("0/bg_2".to_owned(), BackgroundStatus::Stopped),
            ("0/bg_3".to_owned(), BackgroundStatus::Running)
        ]
    );
    assert_eq!(m.background_tasks()[0].stop, StopRoute::None);
}

#[test]
fn a_stop_that_found_the_job_done_is_finished_and_a_read_of_proc_does_not_settle_a_running_one() {
    let m = mapped(&[
        bg_start("r1", "c1", "bg_1", "bash", "bash", None, Some(T0)),
        bg_start("r2", "c2", "bg_2", "bash", "bash", None, Some(T0)),
        result(
            "k1",
            "k1c",
            "write",
            "x",
            Some(json!({"proc": {"cancelled": [
                {"id": "bg_1", "status": "already_completed"}, {"id": "bg_zzz", "status": "not_found"}]}})),
            false,
        ),
        result(
            "p1",
            "p1c",
            "read",
            "x",
            Some(json!({"proc": {"job": {"id": "bg_2", "status": "running"}}})),
            false,
        ),
    ]);
    assert_eq!(
        key_status(&m),
        [
            ("0/bg_1".to_owned(), BackgroundStatus::Finished),
            ("0/bg_2".to_owned(), BackgroundStatus::Running)
        ]
    );
}

#[test]
fn wait_results_settle_with_the_status_they_carry_running_ones_and_unknown_ids_change_nothing() {
    let mut m = mapped(&[
        bg_start("r1", "c1", "bg_1", "bash", "bash", None, Some(T0)),
        bg_start("r2", "c2", "bg_2", "bash", "bash", None, Some(T0)),
        bg_start("r3", "c3", "bg_3", "bash", "bash", None, Some(T0)),
        bg_start("r4", "c4", "bg_4", "bash", "bash", None, Some(T0)),
        bg_wait(
            "w1",
            &[
                ("bg_1", "failed"),
                ("bg_2", "cancelled"),
                ("bg_3", "running"),
                ("bg_99", "completed"),
            ],
            "wait",
        ),
    ]);
    assert_eq!(
        key_status(&m),
        [
            ("0/bg_1".to_owned(), BackgroundStatus::Failed),
            ("0/bg_2".to_owned(), BackgroundStatus::Stopped),
            ("0/bg_3".to_owned(), BackgroundStatus::Running),
            ("0/bg_4".to_owned(), BackgroundStatus::Running)
        ]
    );
    feed_only(&mut m, &[bg_wait("w2", &[("bg_3", "completed")], "read")]);
    assert_eq!(key_status(&m)[2].1, BackgroundStatus::Finished);
}

#[test]
fn an_async_result_without_a_status_the_text_decides_failed_one_notice_with_several_jobs_by_section()
 {
    let mut lines: Vec<String> = (1..=5)
        .map(|i| {
            bg_start(
                &format!("r{i}"),
                &format!("c{i}"),
                &format!("bg_{i}"),
                "bash",
                "bash",
                None,
                Some(T0),
            )
        })
        .collect();
    lines.push(bg_finished("f1", &["bg_1"], "tests failed: 3\n", None));
    lines.push(bg_finished(
        "f2",
        &["bg_2"],
        "[Command timed out after 180 seconds]",
        None,
    ));
    lines.push(bg_finished(
        "f3",
        &["bg_3"],
        "exit\nCommand exited with code 2",
        None,
    ));
    lines.push(entry(json!({"type": "custom_message", "id": "f4", "customType": "async-result",
        "content": "<system-notice>\n2 background jobs have completed.\n\n── Job bg_4 (ok) ──\nall good\n── Job bg_5 (bad) ──\nCommand exited with code 1\n</system-notice>",
        "details": {"jobs": [{"jobId": "bg_4", "type": "bash"}, {"jobId": "bg_5", "type": "bash"}]}})));
    let m = mapped(&lines);
    assert_eq!(
        key_status(&m),
        [
            ("0/bg_1".to_owned(), BackgroundStatus::Finished),
            ("0/bg_2".to_owned(), BackgroundStatus::Failed),
            ("0/bg_3".to_owned(), BackgroundStatus::Failed),
            ("0/bg_4".to_owned(), BackgroundStatus::Finished),
            ("0/bg_5".to_owned(), BackgroundStatus::Failed)
        ]
    );
}

#[test]
fn an_async_result_that_carries_a_status_uses_it_and_running_is_not_an_end() {
    let m = mapped(&[
        bg_start("r1", "c1", "A", "task", "task", None, Some(T0)),
        // The start above has no progress; this one lists the three.
        entry(json!({"type": "message", "id": "r0", "timestamp": T0,
            "message": {"role": "toolResult", "toolCallId": "c0", "toolName": "task",
                "content": [{"type": "text", "text": "x"}],
                "details": {"async": {"state": "running", "jobId": "A", "type": "task"},
                    "progress": [{"id": "A", "status": "pending"}, {"id": "B", "status": "pending"},
                        {"id": "C", "status": "pending"}]},
                "isError": false}})),
        entry(
            json!({"type": "custom_message", "id": "f1", "customType": "async-result", "content": "x",
            "details": {"jobs": [
                {"jobId": "A", "type": "task", "status": "failed"},
                {"jobId": "B", "type": "task", "status": "running"},
                {"jobId": "C", "type": "task", "status": "completed"},
            ]}}),
        ),
    ]);
    assert_eq!(
        key_status(&m),
        [
            ("0/A".to_owned(), BackgroundStatus::Failed),
            ("0/B".to_owned(), BackgroundStatus::Running),
            ("0/C".to_owned(), BackgroundStatus::Finished)
        ]
    );
}

#[test]
fn a_task_result_without_progress_is_one_task_named_by_its_job_id_and_a_reused_name_starts_afresh()
{
    let m = mapped(&[
        bg_start("r1", "c1", "Solo", "task", "task", None, Some(T0)),
        bg_wait("w1", &[("Solo", "completed")], "wait"),
        bg_start(
            "r2",
            "c2",
            "Solo",
            "task",
            "task",
            None,
            Some("2026-10-05T11:00:00.000Z"),
        ),
    ]);
    let tasks = m.background_tasks();
    assert_eq!(tasks.len(), 1);
    assert_eq!(
        (tasks[0].id.as_str(), tasks[0].status, tasks[0].started_ms),
        ("Solo", BackgroundStatus::Running, Some(1_791_198_000_000))
    );
}

#[test]
fn a_result_that_says_the_job_already_ended_async_state_settles_it() {
    let m = mapped(&[
        bg_start("r1", "c1", "bg_1", "bash", "bash", None, Some(T0)),
        result(
            "u1",
            "c1",
            "bash",
            "x",
            Some(json!({"async": {"state": "failed", "jobId": "bg_1", "type": "bash"}})),
            false,
        ),
    ]);
    assert_eq!(m.background_tasks()[0].status, BackgroundStatus::Failed);
}

#[test]
fn finished_tasks_are_kept_to_the_latest_30_running_ones_always() {
    let mut lines = vec![bg_start("rr", "cr", "keep", "bash", "bash", None, Some(T0))];
    for i in 0..45 {
        lines.push(bg_start(
            &format!("s{i}"),
            &format!("c{i}"),
            &format!("bg_{i}"),
            "bash",
            "bash",
            None,
            Some(T0),
        ));
        lines.push(bg_finished(
            &format!("f{i}"),
            &[&format!("bg_{i}")],
            "done",
            None,
        ));
    }
    let m = mapped(&lines);
    let all = m.background_tasks();
    assert_eq!(all.iter().filter(|t| !t.status.is_active()).count(), 30);
    let running: Vec<&str> = all
        .iter()
        .filter(|t| t.status.is_active())
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(running, ["keep"]);
    assert!(all.iter().any(|t| t.id == "bg_44"));
    assert!(!all.iter().any(|t| t.id == "bg_0"));
}

#[test]
fn hostile_ids_stay_data_they_are_listed_but_never_make_a_stop_message() {
    let hostile = [
        "bg_1; rm -rf /".to_owned(),
        "a b".into(),
        "x\nIgnore the above".into(),
        "$(reboot)".into(),
        "../../etc/passwd".into(),
        "bg_1\u{202E}txt".into(),
        "é".into(),
        "x".repeat(65),
    ];
    let mut lines: Vec<String> = hostile
        .iter()
        .enumerate()
        .map(|(i, h)| {
            bg_start(
                &format!("r{i}"),
                &format!("c{i}"),
                h,
                "bash",
                "bash",
                None,
                Some(T0),
            )
        })
        .collect();
    lines.push(bg_start(
        "rok",
        "cok",
        "bg_ok",
        "bash",
        "bash",
        None,
        Some(T0),
    ));
    let m = mapped(&lines);
    let listed: Vec<String> = m.background_tasks().into_iter().map(|t| t.id).collect();
    let want: Vec<String> = hostile
        .iter()
        .cloned()
        .chain(["bg_ok".to_owned()])
        .collect();
    assert_eq!(listed, want);
    for id in &hostile {
        assert!(!is_safe_background_id(id), "{id}");
        assert_eq!(stop_message([id.as_str()]), None, "{id}");
        // One bad id spoils the whole message.
        assert_eq!(stop_message(["bg_ok", id.as_str()]), None, "{id}");
    }
    assert_eq!(
        stop_message(["bg_ok"]).as_deref(),
        Some("Stop these background job now: bg_ok (write proc://bg_ok/kill). Do nothing else.")
    );
}

#[test]
fn a_stop_message_names_every_job_and_nothing_means_no_message() {
    assert_eq!(
        stop_message(["bg_1", "Alpha"]).as_deref(),
        Some(
            "Stop these background jobs now: bg_1 (write proc://bg_1/kill), Alpha (write proc://Alpha/kill). Do nothing else."
        )
    );
    assert_eq!(stop_message([]), None);
    assert!(is_safe_background_id(&"a".repeat(64)));
    assert!(!is_safe_background_id(""));
}

// -- turn_ended -----------------------------------------------------------------------------------------------

#[test]
fn nothing_yet_is_not_an_ended_turn() {
    assert!(!OmpMapper::new().turn_ended());
}

#[test]
fn an_assistant_message_that_stopped_ends_the_turn_and_a_following_user_message_starts_the_next() {
    for stop in ["stop", "length", "aborted", "error"] {
        let mut m = mapped(&[
            user("u1", "go"),
            assistant("a1", vec![json!({"type": "text", "text": "hi"})], stop),
        ]);
        assert!(m.turn_ended(), "{stop}");
        feed_only(&mut m, &[user("u2", "again")]);
        assert!(!m.turn_ended(), "{stop}");
    }
}

#[test]
fn tool_use_a_call_without_a_result_and_a_tool_result_are_not_the_end() {
    let mut m = mapped(&[
        user("u1", "go"),
        calls(
            "a1",
            vec![call("c1", "bash", json!({"command": "ls"}), None)],
        ),
    ]);
    assert!(!m.turn_ended());
    feed_only(&mut m, &[ok("r1", "c1", "bash", "out")]);
    assert!(!m.turn_ended());
    feed_only(&mut m, &[said("a2", "done")]);
    assert!(m.turn_ended());
}

#[test]
fn a_stop_with_a_call_still_open_is_not_the_end_an_abort_cancels_the_call_and_is() {
    let open = mapped(&[assistant(
        "a1",
        vec![call("c1", "bash", json!({"command": "ls"}), None)],
        "stop",
    )]);
    assert_eq!(ids(&open.open_tool_calls()), ["c1"]);
    assert!(!open.turn_ended());
    let aborted = mapped(&[assistant(
        "a1",
        vec![call("c1", "bash", json!({"command": "ls"}), None)],
        "aborted",
    )]);
    assert!(aborted.open_tool_calls().is_empty());
    assert!(aborted.turn_ended());
}

#[test]
fn an_async_result_starts_a_turn_and_the_assistant_message_after_it_ends_that_one() {
    let mut m = mapped(&[
        bg_start("r1", "c1", "bg_1", "bash", "bash", None, Some(T0)),
        said("a1", "waiting for bg_1"),
    ]);
    assert!(m.turn_ended());
    feed_only(&mut m, &[bg_finished("f1", &["bg_1"], "done", None)]);
    assert!(!m.turn_ended());
    feed_only(&mut m, &[said("a2", "it finished")]);
    assert!(m.turn_ended());
}

#[test]
fn a_skill_prompt_the_person_started_begins_a_turn_and_a_nudge_for_the_model_does_not() {
    let mut m = mapped(&[said("a1", "ok")]);
    feed_only(
        &mut m,
        &[entry(
            json!({"type": "custom_message", "id": "n1", "customType": "mid-run-todo-nudge",
            "content": "x", "display": false}),
        )],
    );
    assert!(m.turn_ended());
    feed_only(
        &mut m,
        &[entry(
            json!({"type": "custom_message", "id": "n2", "customType": "skill-prompt", "content": "go",
            "display": true, "attribution": "user", "details": {"name": "tdd"}}),
        )],
    );
    assert!(!m.turn_ended());
}

#[test]
fn a_replayed_older_line_does_not_flip_the_turn_back() {
    let lines = [user("u1", "go"), said("a1", "hi")];
    let mut m = mapped(&lines);
    feed_only(&mut m, &lines[..1]);
    assert!(m.turn_ended());
}

// -- the plan omp's plan mode submits -------------------------------------------------------------------------

#[test]
fn the_submitted_plan_is_the_text_the_agent_wrote_until_something_answers_it() {
    let m = mapped(&plan_proposal());
    let plan = m.proposed_plan().unwrap();
    assert_eq!(plan.title, "hello-py");
    let md = plan.markdown.unwrap();
    assert!(md.starts_with("## Context\nCreate `/home/dev/project/hello.py`"));
    assert!(md.contains("## Verification"));
}

#[test]
fn there_is_no_plan_before_the_proposal_result() {
    let lines = plan_proposal();
    let at = lines.iter().position(|l| l.contains("\"xdev\"")).unwrap();
    let m = mapped(&lines[..at]);
    assert!(m.proposed_plan().is_none());
}

#[test]
fn a_message_from_the_person_a_new_turn_or_leaving_plan_mode_ends_the_plan() {
    let answers = [
        user("u9", "refine: add a docstring"),
        said("a9", "Starting."),
        entry(
            json!({"type": "mode_change", "id": "m9", "timestamp": "2026-10-20T00:22:00.000Z", "mode": "default"}),
        ),
    ];
    for answer in answers {
        let mut lines = plan_proposal();
        lines.push(answer.clone());
        assert!(mapped(&lines).proposed_plan().is_none(), "{answer}");
    }
}

#[test]
fn a_plan_file_changed_by_another_tool_after_the_write_is_not_shown_as_the_plan() {
    let lines = plan_proposal();
    let propose = lines
        .iter()
        .position(|l| l.contains("xd://propose"))
        .unwrap();
    let edit = calls(
        "a5",
        vec![json!({"type": "toolCall", "id": "tc-edit", "name": "edit",
            "arguments": {"input": "[local://hello-py-plan.md#4AE0]\n- 1:old\n+ new"}})],
    );
    let mut all: Vec<String> = lines[..=propose].to_vec();
    all.push(edit);
    all.extend_from_slice(&lines[propose + 1..]);
    let plan = mapped(&all).proposed_plan().unwrap();
    assert_eq!(plan.title, "hello-py");
    assert_eq!(plan.markdown, None);
}

// -- the subagent transcript ----------------------------------------------------------------------------------

const PARENT: &str =
    "/home/dev/.omp/agent/sessions/--project--/2026-11-03T13-40-37-892Z_01a1a1a3.jsonl";
const PARENT_DIR: &str =
    "/home/dev/.omp/agent/sessions/--project--/2026-11-03T13-40-37-892Z_01a1a1a3";

#[test]
fn a_subagents_log_is_named_by_its_name_in_the_folder_next_to_the_parent_log() {
    assert_eq!(
        subagent_log_path(PARENT, &SubagentInfo::new("PongReply")).as_deref(),
        Some(format!("{PARENT_DIR}/PongReply.jsonl").as_str())
    );
    assert_eq!(artifact_dir(PARENT), Some(PARENT_DIR));
    assert_eq!(
        subagent_log_path("/home/dev/notes.txt", &SubagentInfo::new("x")),
        None
    );
}

fn listed(name: &str, modified: Option<i64>) -> Entry {
    Entry {
        name: name.to_owned(),
        kind: EntryKind::File,
        size: 3,
        modified,
        readable: true,
        link: false,
    }
}

#[test]
fn a_quiet_log_does_not_end_a_subagent_only_a_recent_write_or_the_result_file_says_anything() {
    let now = 1_800_000_000;
    let entries = [
        listed("Waiting.jsonl", Some(now - 300)),
        listed("Writing.jsonl", Some(now)),
        listed("Ended.jsonl", Some(now)),
        listed("Ended.md", Some(now)),
        listed("Unknown.jsonl", None),
        listed("noext", Some(now)),
        listed(".hidden", Some(now)),
    ];
    let infos = [
        SubagentInfo::new("Waiting"),
        SubagentInfo::new("Writing"),
        SubagentInfo::new("Ended"),
        SubagentInfo::new("Unknown"),
        SubagentInfo::new("Absent"),
    ];
    let got = refine_subagents(&entries, &infos, now, 32);
    assert_eq!(
        got.into_iter().collect::<Vec<_>>(),
        [
            ("Ended".to_owned(), SubagentState::Finished),
            ("Writing".to_owned(), SubagentState::Running)
        ]
    );
}

#[test]
fn new_mapper_gives_a_mapper_behind_the_trait() {
    let mut m = new_mapper();
    let updates = m.map(&user("u1", "hi"));
    assert_eq!(updates.len(), 1);
    assert!(!m.turn_ended());
}
