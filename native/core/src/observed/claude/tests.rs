//! Ports of herdr-mobile's `claude_log_mapper_test.dart`. The Dart tests replay captured sessions; these
//! build the same shapes (field names and nesting of Claude Code 2.1's log lines) from short synthetic
//! text, with fake ids and `/home/dev/project` paths.
//!
//! What the Dart reducer does with the updates, [`Sim`] does here: a message upserts by id, a tool call
//! starts whole and patches merge field by field, the plan, title and commands replace.
//!
//! What these tests rely on (observed on real Claude Code 2.1.29x):
//! * While a permission prompt is on screen the pending `tool_use` line is already in the log and is its last
//!   line. Nothing marks "waiting for permission".
//! * `thinking` blocks carry no text, only a signature.
//! * Esc during a tool or during streamed text writes `[Request interrupted by user ...]` and no
//!   `turn_duration`; refusing a tool with No writes the same two lines and then `turn_duration`.
//! * A subagent's own transcript has `isSidechain: true` on every line; the main file has none of those.
//! * A background job's end arrives as a `<task-notification>` (a user line, or an attachment when the person
//!   stopped it); a job the model stopped with `TaskStop` has no notice.

use serde_json::{Map, Value, json};

use super::*;
use crate::observed::model::{Block, PictureRef};

const CWD: &str = "/home/dev/project";

// -- the reducer the updates feed ------------------------------------------------------------------------

enum Item {
    Message {
        role: Role,
        id: String,
        blocks: Vec<Block>,
    },
    Tool(Map<String, Value>),
}

#[derive(Default)]
struct Sim {
    items: Vec<Item>,
    plan: Vec<PlanStep>,
    title: Option<String>,
    commands: Vec<SlashCommand>,
}

impl Sim {
    fn apply(&mut self, update: Update) {
        match update {
            Update::Message { role, id, blocks } => {
                let existing = self
                    .items
                    .iter_mut()
                    .find(|i| matches!(i, Item::Message { id: have, .. } if *have == id));
                match existing {
                    Some(slot) => *slot = Item::Message { role, id, blocks },
                    None => self.items.push(Item::Message { role, id, blocks }),
                }
            }
            Update::ToolStart(Value::Object(call)) => {
                match self.tool_slot(call["toolCallId"].as_str().unwrap_or_default()) {
                    Some(slot) => *slot = call,
                    None => self.items.push(Item::Tool(call)),
                }
            }
            Update::ToolPatch(Value::Object(patch)) => {
                let id = patch["toolCallId"].as_str().unwrap_or_default().to_owned();
                match self.tool_slot(&id) {
                    Some(call) => call.extend(patch),
                    None => self.items.push(Item::Tool(patch)),
                }
            }
            Update::ToolStart(_) | Update::ToolPatch(_) => panic!("a tool call is an object"),
            Update::Plan(plan) => self.plan = plan,
            Update::Title(title) => self.title = title,
            Update::Commands(commands) => self.commands = commands,
            Update::Cleared => self.items.clear(),
        }
    }

    fn tool_slot(&mut self, id: &str) -> Option<&mut Map<String, Value>> {
        self.items.iter_mut().find_map(|i| match i {
            Item::Tool(call) if call["toolCallId"] == id => Some(call),
            _ => None,
        })
    }

    fn messages(&self, role: Role) -> Vec<(&str, &[Block])> {
        self.items
            .iter()
            .filter_map(|i| match i {
                Item::Message {
                    role: r,
                    id,
                    blocks,
                } if *r == role => Some((id.as_str(), blocks.as_slice())),
                _ => None,
            })
            .collect()
    }

    /// The text of the messages of `role`: the text blocks of each, joined.
    fn texts(&self, role: Role) -> Vec<String> {
        self.messages(role)
            .into_iter()
            .map(|(_, blocks)| text_of_blocks(blocks))
            .collect()
    }

    fn tools(&self) -> Vec<&Map<String, Value>> {
        self.items
            .iter()
            .filter_map(|i| match i {
                Item::Tool(call) => Some(call),
                _ => None,
            })
            .collect()
    }

    fn tool_named(&self, name: &str) -> &Map<String, Value> {
        self.tools()
            .into_iter()
            .find(|c| c.get("name").and_then(Value::as_str) == Some(name))
            .unwrap_or_else(|| panic!("no tool call named {name}"))
    }

    /// Message index of the first message of `role` whose text contains `needle`.
    fn index_of(&self, role: Role, needle: &str) -> usize {
        self.items
            .iter()
            .position(|i| {
                matches!(i, Item::Message { role: r, blocks, .. }
                    if *r == role && text_of_blocks(blocks).contains(needle))
            })
            .unwrap_or_else(|| panic!("no {role:?} message with {needle}"))
    }
}

fn text_of_blocks(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Text(t) => Some(t.as_str()),
            Block::Image(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What a tool printed: the text entries of its content.
fn tool_text(call: &Map<String, Value>) -> String {
    call["content"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter(|e| e["type"] == "content")
                .filter_map(|e| e["content"]["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn diffs(call: &Map<String, Value>) -> Vec<&Value> {
    call["content"]
        .as_array()
        .map(|c| c.iter().filter(|e| e["type"] == "diff").collect())
        .unwrap_or_default()
}

fn feed(sim: &mut Sim, mapper: &mut ClaudeMapper, lines: &[String]) {
    for line in lines {
        for update in mapper.map(line) {
            sim.apply(update);
        }
    }
}

fn run(lines: &[String]) -> (Sim, ClaudeMapper) {
    let mut sim = Sim::default();
    let mut mapper = ClaudeMapper::default();
    feed(&mut sim, &mut mapper, lines);
    (sim, mapper)
}

/// The lines up to and including the line that calls `tool`.
fn through(lines: &[String], tool: &str) -> Vec<String> {
    let at = lines
        .iter()
        .position(|l| {
            l.contains(r#""type":"tool_use""#) && l.contains(&format!(r#""name":"{tool}""#))
        })
        .unwrap_or_else(|| panic!("the log calls {tool}"));
    lines[..=at].to_vec()
}

// -- the lines of a log -----------------------------------------------------------------------------------

fn line(value: Value) -> String {
    value.to_string()
}

/// A prompt the person typed.
fn prompt(uuid: &str, text: &str) -> String {
    line(json!({
        "type": "user", "uuid": uuid, "isSidechain": false, "cwd": CWD,
        "origin": {"kind": "human"},
        "message": {"role": "user", "content": text},
    }))
}

/// A user line with no extras.
fn user(uuid: &str, content: Value) -> String {
    line(json!({
        "type": "user", "uuid": uuid,
        "message": {"role": "user", "content": content},
    }))
}

/// One content block of an API message, written as a line of its own.
fn block(uuid: &str, msg: &str, index: u32, block: Value, stop: Option<&str>) -> String {
    line(json!({
        "type": "assistant", "uuid": uuid, "isSidechain": false, "cwd": CWD,
        "apiBlockIndex": index,
        "message": {
            "id": msg, "role": "assistant", "model": "claude-test-1",
            "content": [block], "stop_reason": stop,
        },
    }))
}

fn say(uuid: &str, msg: &str, index: u32, text: &str, stop: Option<&str>) -> String {
    block(
        uuid,
        msg,
        index,
        json!({"type": "text", "text": text}),
        stop,
    )
}

/// The empty `thinking` block Claude writes: only a signature.
fn think(uuid: &str, msg: &str, index: u32) -> String {
    block(
        uuid,
        msg,
        index,
        json!({"type": "thinking", "thinking": "", "signature": "c2lnbmF0dXJl"}),
        None,
    )
}

fn call(uuid: &str, msg: &str, index: u32, tool_id: &str, name: &str, input: Value) -> String {
    block(
        uuid,
        msg,
        index,
        json!({"type": "tool_use", "id": tool_id, "name": name, "input": input, "caller": {"type": "direct"}}),
        Some("tool_use"),
    )
}

/// A tool's result, with the structured `toolUseResult` Claude writes beside it.
fn result(
    uuid: &str,
    tool_id: &str,
    content: Value,
    is_error: bool,
    extra: Option<Value>,
) -> String {
    let mut l = json!({
        "type": "user", "uuid": uuid, "isSidechain": false, "cwd": CWD,
        "timestamp": "2026-11-01T10:00:00.250Z",
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": content, "is_error": is_error}
        ]},
    });
    if let Some(extra) = extra {
        l["toolUseResult"] = extra;
    }
    line(l)
}

fn turn_duration(uuid: &str) -> String {
    line(json!({
        "type": "system", "subtype": "turn_duration", "uuid": uuid, "isSidechain": false,
        "durationMs": 1200, "isMeta": false,
    }))
}

fn interrupted(uuid: &str, suffix: &str) -> String {
    user(
        uuid,
        json!([{"type": "text", "text": format!("[Request interrupted by user{suffix}]")}]),
    )
}

fn notice(uuid: &str, task: &str, status: &str) -> String {
    line(json!({
        "type": "user", "uuid": uuid, "isSidechain": false,
        "timestamp": "2026-11-01T10:05:00.500Z",
        "origin": {"kind": "task-notification"},
        "message": {"role": "user", "content": format!(
            "<task-notification>\n<task-id>{task}</task-id>\n<status>{status}</status>\n</task-notification>")},
    }))
}

fn enqueue(content: &str) -> String {
    line(
        json!({"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-11-01T10:00:00.000Z", "content": content}),
    )
}

fn dequeue() -> String {
    line(
        json!({"type": "queue-operation", "operation": "dequeue", "timestamp": "2026-11-01T10:00:01.000Z"}),
    )
}

// -- scenarios: what the captured logs held ---------------------------------------------------------------

fn plain() -> Vec<String> {
    vec![
        prompt("u1", "say hi in 5 words"),
        line(json!({"type": "ai-title", "aiTitle": "Greeting in five words", "sessionId": "s1"})),
        think("a1", "m1", 0),
        say("a2", "m1", 1, "Hello there, nice to meet", Some("end_turn")),
        turn_duration("t1"),
        prompt("u2", "now say bye in 3 words"),
        say("a3", "m2", 0, "Goodbye for now", Some("end_turn")),
        turn_duration("t2"),
    ]
}

fn bash_approve() -> Vec<String> {
    vec![
        // The person's prompt comes with Claude's own system reminder, which is context, not words.
        user(
            "u1",
            json!([
                {"type": "text", "text": "<system-reminder>Today is a day.</system-reminder>"},
                {"type": "text", "text": "create the file x.txt"},
            ]),
        ),
        think("a1", "m1", 0),
        call(
            "a2",
            "m1",
            1,
            "toolu_01",
            "Bash",
            json!({"command": "touch /tmp/hm-test/x.txt", "description": "Create x.txt"}),
        ),
        result(
            "r1",
            "toolu_01",
            json!("(no output)"),
            false,
            Some(
                json!({"stdout": "", "stderr": "", "interrupted": false, "noOutputExpected": true}),
            ),
        ),
        say("a3", "m2", 0, "Created the file.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

fn queued_tool() -> Vec<String> {
    vec![
        prompt("u1", "ping the host three times"),
        call(
            "a1",
            "m1",
            0,
            "toolu_01",
            "Bash",
            json!({"command": "ping -c 12 192.0.2.1", "description": "Ping"}),
        ),
        enqueue("PINEAPPLE also say pineapple"),
        line(
            json!({"type": "queue-operation", "operation": "remove", "timestamp": "2026-11-01T10:00:01.000Z",
            "content": "PINEAPPLE also say pineapple", "reason": "dequeued"}),
        ),
        line(json!({
            "type": "attachment", "uuid": "q1", "isSidechain": false,
            "attachment": {"type": "queued_command", "prompt": "PINEAPPLE also say pineapple",
                "commandMode": "prompt", "origin": {"kind": "human"}},
        })),
        result(
            "r1",
            "toolu_01",
            json!("12 packets transmitted, 12 received"),
            false,
            Some(json!({"stdout": "12 packets transmitted, 12 received", "stderr": ""})),
        ),
        say("a2", "m2", 0, "Done. PINEAPPLE.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

fn bash_fail() -> Vec<String> {
    vec![
        prompt("u1", "run a failing command"),
        call(
            "a1",
            "m1",
            0,
            "toolu_01",
            "Bash",
            json!({"command": "false", "description": "Fail"}),
        ),
        result(
            "r1",
            "toolu_01",
            json!("Exit code 1"),
            true,
            Some(json!("Error: Exit code 1")),
        ),
        say("a2", "m2", 0, "It failed.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

fn edit_write() -> Vec<String> {
    let file = "/home/dev/project/note.txt";
    vec![
        prompt("u1", "write and edit a note"),
        call(
            "a1",
            "m1",
            0,
            "toolu_w",
            "Write",
            json!({"file_path": file, "content": "hello world"}),
        ),
        result(
            "r1",
            "toolu_w",
            json!("File created successfully"),
            false,
            Some(
                json!({"type": "create", "filePath": file, "content": "hello world",
                "structuredPatch": [], "originalFile": null}),
            ),
        ),
        call(
            "a2",
            "m2",
            0,
            "toolu_e",
            "Edit",
            json!({"file_path": file, "old_string": "world", "new_string": "there"}),
        ),
        result(
            "r2",
            "toolu_e",
            json!("The file has been updated"),
            false,
            Some(json!({"filePath": file, "oldString": "world", "newString": "there"})),
        ),
        // A hook blocked this one: an error, not a refusal by the person.
        call("a3", "m3", 0, "toolu_r", "Read", json!({"file_path": file})),
        result(
            "r3",
            "toolu_r",
            json!("PreToolUse:Read hook blocked this call"),
            true,
            Some(json!("Error: hook blocked")),
        ),
        say("a4", "m4", 0, "Done.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

fn compact() -> Vec<String> {
    vec![
        prompt("u1", "first question"),
        say("a1", "m1", 0, "first answer", Some("end_turn")),
        turn_duration("t1"),
        // The line the person typed, then the command's own record, then its output.
        prompt("u2", "/compact"),
        line(
            json!({"type": "user", "uuid": "c1", "isSidechain": false, "isMeta": true,
            "message": {"role": "user", "content": "<local-command-caveat>Caveat: ignore</local-command-caveat>"}}),
        ),
        user(
            "c2",
            json!(
                "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"
            ),
        ),
        line(
            json!({"type": "system", "subtype": "local_command", "uuid": "c3", "isSidechain": false,
            "level": "info",
            "content": "<local-command-stdout>Compacted (ctrl+o to see full summary)\n{\"systemMessage\":\"snapshot of the session\"}</local-command-stdout>"}),
        ),
        line(
            json!({"type": "system", "subtype": "compact_boundary", "uuid": "c4", "isSidechain": false,
            "content": "Conversation compacted", "level": "info"}),
        ),
        line(
            json!({"type": "user", "uuid": "c5", "isSidechain": false, "isCompactSummary": true,
            "message": {"role": "user", "content": "This session is being continued from a previous conversation."}}),
        ),
        user("c6", json!("<local-command-stdout></local-command-stdout>")),
    ]
}

fn clear_new() -> Vec<String> {
    vec![
        line(
            json!({"type": "user", "uuid": "c1", "isSidechain": false, "isMeta": true,
            "message": {"role": "user", "content": "<local-command-caveat>Caveat: ignore</local-command-caveat>"}}),
        ),
        user(
            "c2",
            json!(
                "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"
            ),
        ),
        user("c3", json!("<local-command-stdout></local-command-stdout>")),
        prompt("u1", "hello again"),
    ]
}

fn plan_mode() -> Vec<String> {
    vec![
        prompt("u1", "plan creating hello.txt"),
        // Loading a deferred tool's definition is the agent's housekeeping.
        call(
            "a1",
            "m1",
            0,
            "toolu_ts",
            "ToolSearch",
            json!({"query": "select:ExitPlanMode", "max_results": 1}),
        ),
        result(
            "r1",
            "toolu_ts",
            json!([{"type": "text", "text": "loaded"}]),
            false,
            None,
        ),
        call(
            "a2",
            "m2",
            0,
            "toolu_pl",
            "ExitPlanMode",
            json!({"plan": "# Plan: create hello.txt\n\n1. Write the file.", "planFilePath": "/home/dev/.claude/plans/p.md"}),
        ),
        result(
            "r2",
            "toolu_pl",
            json!("User has approved your plan."),
            false,
            Some(
                json!({"plan": "# Plan: create hello.txt\n\n1. Write the file.", "isAgent": false}),
            ),
        ),
        say("a3", "m3", 0, "Plan approved.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

fn interrupt_tool() -> Vec<String> {
    vec![
        prompt("u1", "sleep for a minute"),
        call(
            "a1",
            "m1",
            0,
            "toolu_01",
            "Bash",
            json!({"command": "sleep 60", "description": "Sleep"}),
        ),
        interrupted("u2", " for tool use"),
    ]
}

fn interrupt_text() -> Vec<String> {
    vec![
        prompt("u1", "tell a long story"),
        say(
            "a1",
            "m1",
            0,
            "**The Lighthouse Story**\n\nOnce there was a light.",
            None,
        ),
        interrupted("u2", ""),
    ]
}

const REFUSED: &str = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

fn bash_deny() -> Vec<String> {
    vec![
        prompt("u1", "remove the scratch folder"),
        call(
            "a1",
            "m1",
            0,
            "toolu_01",
            "Bash",
            json!({"command": "rm -rf /tmp/hm-test", "description": "Remove"}),
        ),
        // Claude says it in a field of the line as well as in the words.
        line(json!({
            "type": "user", "uuid": "r1", "isSidechain": false, "toolDenialKind": "user-rejected",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_01", "content": "Permission denied", "is_error": true}]},
            "toolUseResult": "Error: Permission denied",
        })),
        interrupted("u2", " for tool use"),
        turn_duration("t1"),
    ]
}

/// Refused with Esc: only the words say it.
fn bash_esc() -> Vec<String> {
    vec![
        prompt("u1", "remove the scratch folder"),
        call(
            "a1",
            "m1",
            0,
            "toolu_01",
            "Bash",
            json!({"command": "rm -rf /tmp/hm-test", "description": "Remove"}),
        ),
        result(
            "r1",
            "toolu_01",
            json!(REFUSED),
            true,
            Some(json!(format!("Error: {REFUSED}"))),
        ),
        interrupted("u2", " for tool use"),
        turn_duration("t1"),
    ]
}

fn question(header: &str, text: &str, options: Value, multi: bool) -> Value {
    json!({"question": text, "header": header, "options": options, "multiSelect": multi})
}

fn ask_single() -> Vec<String> {
    vec![
        prompt("u1", "ask me for a colour"),
        call(
            "a1",
            "m1",
            0,
            "toolu_q",
            "AskUserQuestion",
            json!({"questions": [question(
                "Color",
                "Which color do you prefer?",
                json!([
                    {"label": "Red", "description": "Warm"},
                    {"label": "Green", "description": "Natural"},
                    {"label": "Blue", "description": "Calm"},
                ]),
                false,
            )]}),
        ),
        result(
            "r1",
            "toolu_q",
            json!(
                "Your questions have been answered: \"Which color do you prefer?\"=\"Blue\". You can now continue."
            ),
            false,
            Some(json!({"answers": {"Which color do you prefer?": "Blue"}})),
        ),
        say("a2", "m2", 0, "Blue it is.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

fn ask_two() -> Vec<String> {
    vec![
        prompt("u1", "ask me two things"),
        call(
            "a1",
            "m1",
            0,
            "toolu_q",
            "AskUserQuestion",
            json!({"questions": [
                question("Lang", "Which language?", json!([{"label": "Rust", "description": ""}, {"label": "Dart", "description": ""}]), false),
                question("Extras", "Which extras?", json!([{"label": "Tests", "description": ""}, {"label": "Docs", "description": ""}]), true),
            ]}),
        ),
    ]
}

fn ask_declined() -> Vec<String> {
    let mut lines = ask_two();
    lines.push(result(
        "r1",
        "toolu_q",
        json!(REFUSED),
        true,
        Some(json!(format!("Error: {REFUSED}"))),
    ));
    lines.push(interrupted("u2", " for tool use"));
    lines.push(turn_duration("t1"));
    lines
}

fn tasks() -> Vec<String> {
    let create = |n: u32, subject: &str| {
        vec![
            call(
                &format!("ac{n}"),
                &format!("mc{n}"),
                0,
                &format!("toolu_c{n}"),
                "TaskCreate",
                json!({"subject": subject, "description": "do it"}),
            ),
            result(
                &format!("rc{n}"),
                &format!("toolu_c{n}"),
                json!(format!("Task #{n} created successfully: {subject}")),
                false,
                Some(json!({"task": {"id": n.to_string(), "subject": subject}})),
            ),
        ]
    };
    let update = |n: u32, status: &str| {
        vec![
            call(
                &format!("au{n}{status}"),
                &format!("mu{n}{status}"),
                0,
                &format!("toolu_u{n}{status}"),
                "TaskUpdate",
                json!({"taskId": n.to_string(), "status": status}),
            ),
            result(
                &format!("ru{n}{status}"),
                &format!("toolu_u{n}{status}"),
                json!(format!("Updated task #{n} status")),
                false,
                Some(
                    json!({"success": true, "taskId": n.to_string(), "updatedFields": ["status"]}),
                ),
            ),
        ]
    };
    let mut lines = vec![prompt("u1", "make a task list and do it")];
    for (n, subject) in [(1, "Research"), (2, "Build"), (3, "Test")] {
        lines.extend(create(n, subject));
    }
    for n in 1..=3 {
        lines.extend(update(n, "in_progress"));
        lines.extend(update(n, "completed"));
    }
    lines.push(say("az", "mz", 0, "All done.", Some("end_turn")));
    lines.push(turn_duration("t1"));
    lines
}

fn todowrite() -> Vec<String> {
    let todos = |a: &str, b: &str| {
        json!({"todos": [
            {"content": "Write the file", "status": a, "activeForm": "Writing the file"},
            {"content": "Check the file", "status": b, "activeForm": "Checking the file"},
        ]})
    };
    vec![
        prompt("u1", "write then check a file"),
        call(
            "a1",
            "m1",
            0,
            "toolu_t1",
            "TodoWrite",
            todos("in_progress", "pending"),
        ),
        result(
            "r1",
            "toolu_t1",
            json!("Todos have been modified successfully"),
            false,
            None,
        ),
        call(
            "a2",
            "m2",
            0,
            "toolu_t2",
            "TodoWrite",
            todos("completed", "completed"),
        ),
        result(
            "r2",
            "toolu_t2",
            json!("Todos have been modified successfully"),
            false,
            None,
        ),
        say("a3", "m3", 0, "Both done.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

const AGENT_ID: &str = "a0f00d00c0ffee001";
const AGENT_CALL: &str = "toolu_agent01";

fn subagent() -> Vec<String> {
    vec![
        prompt("u1", "have a subagent list the files"),
        think("a1", "m1", 0),
        call(
            "a2",
            "m1",
            1,
            AGENT_CALL,
            "Agent",
            json!({
                "description": "List files in project",
                "subagent_type": "general-purpose",
                "prompt": "Use the Bash tool to run `ls` in /home/dev/project and report the entries.",
            }),
        ),
        result(
            "r1",
            AGENT_CALL,
            json!([{"type": "text", "text": "Async agent launched successfully."}]),
            false,
            Some(
                json!({"isAsync": true, "status": "async_launched", "agentId": AGENT_ID,
                "description": "List files in project", "canReadOutputFile": true}),
            ),
        ),
        // The notice is written to the queue first; its text starts with `<`, so it is not a prompt.
        enqueue(&format!(
            "<task-notification>\n<task-id>{AGENT_ID}</task-id>\n<status>completed</status>\n</task-notification>"
        )),
        dequeue(),
        notice("n1", AGENT_ID, "completed"),
        say(
            "a3",
            "m2",
            0,
            "The subagent listed the files.",
            Some("end_turn"),
        ),
        turn_duration("t1"),
    ]
}

/// The transcript of that subagent: every line is a sidechain line.
fn subagent_transcript() -> Vec<String> {
    let side = |mut l: Value| {
        l["isSidechain"] = json!(true);
        l["agentId"] = json!(AGENT_ID);
        line(l)
    };
    vec![
        side(json!({"type": "user", "uuid": "s1",
            "message": {"role": "user", "content": "Use the Bash tool to run `ls` in /home/dev/project and report the entries."}})),
        side(
            json!({"type": "assistant", "uuid": "s2", "apiBlockIndex": 0,
            "message": {"id": "sm1", "role": "assistant", "model": "claude-test-1", "stop_reason": "tool_use",
                "content": [{"type": "tool_use", "id": "toolu_sub1", "name": "Bash",
                    "input": {"command": "ls", "description": "List contents of project temp directory"}}]}}),
        ),
        side(json!({"type": "user", "uuid": "s3",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_sub1", "content": "(no output)", "is_error": false}]},
            "toolUseResult": {"stdout": "", "stderr": ""}})),
        side(
            json!({"type": "assistant", "uuid": "s4", "apiBlockIndex": 0,
            "message": {"id": "sm2", "role": "assistant", "model": "claude-test-1", "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "The directory has no entries."}]}}),
        ),
    ]
}

const BG_TASK: &str = "bwn5dp2o7";

/// Starts `sleep 25 && echo finished` in the background; what follows is told by the caller.
fn background_start() -> Vec<String> {
    vec![
        prompt("u1", "run sleep in the background"),
        call(
            "a1",
            "m1",
            0,
            "toolu_bg",
            "Bash",
            json!({"command": "sleep 25 && echo finished", "description": "Sleep", "run_in_background": true}),
        ),
        result(
            "r1",
            "toolu_bg",
            json!("Command running in background with ID: bwn5dp2o7"),
            false,
            Some(
                json!({"stdout": "", "stderr": "", "interrupted": false, "backgroundTaskId": BG_TASK}),
            ),
        ),
        say("a2", "m2", 0, "Started it.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

fn background_ended_by_notice(status: &str) -> Vec<String> {
    let mut lines = background_start();
    lines.push(enqueue(&format!(
        "<task-notification>\n<task-id>{BG_TASK}</task-id>\n<status>{status}</status>\n</task-notification>"
    )));
    lines.push(dequeue());
    lines.push(notice("n1", BG_TASK, status));
    lines.push(say("a3", "m3", 0, "It ended.", Some("end_turn")));
    lines.push(turn_duration("t2"));
    lines
}

/// The model stopped the job itself (`TaskStop`): there is no notice.
fn background_killed() -> Vec<String> {
    let mut lines = background_start();
    lines.push(call(
        "a3",
        "m3",
        0,
        "toolu_stop",
        "TaskStop",
        json!({"task_id": BG_TASK}),
    ));
    lines.push(result(
        "r2",
        "toolu_stop",
        json!("Successfully stopped task"),
        false,
        Some(json!({"message": "Successfully stopped task", "task_id": BG_TASK, "task_type": "local_bash"})),
    ));
    lines.push(say("a4", "m4", 0, "Stopped it.", Some("end_turn")));
    lines.push(turn_duration("t2"));
    lines
}

/// The person stopped the job: the notice waits for their next prompt and arrives as an attachment.
fn background_user_stopped() -> Vec<String> {
    let mut lines = background_start();
    lines.push(prompt("u2", "never mind that job"));
    lines.push(line(json!({
        "type": "attachment", "uuid": "q1", "isSidechain": false,
        "attachment": {"type": "queued_command", "commandMode": "task-notification",
            "prompt": format!("<task-notification>\n<task-id>{BG_TASK}</task-id>\n<status>killed</status>\n</task-notification>")},
    })));
    lines.push(say("a3", "m3", 0, "Understood.", Some("end_turn")));
    lines.push(turn_duration("t2"));
    lines
}

fn image_paste() -> Vec<String> {
    let names: Vec<String> = (0..70).map(|n| format!("skill-{n:02}")).collect();
    let mut listing = format!(
        "- skill-00: {}\n",
        "Query the project profile and every detail of it, at length, ".repeat(5)
    );
    for name in &names[1..] {
        listing.push_str(&format!("- {name}: Does the work of {name}\n"));
    }
    vec![
        line(
            json!({"type": "attachment", "uuid": "k1", "isSidechain": false,
            "attachment": {"type": "skill_listing", "content": listing, "skillCount": 70,
                "isInitial": true, "names": names}}),
        ),
        line(
            json!({"type": "user", "uuid": "u1", "isSidechain": false, "origin": {"kind": "human"},
            "message": {"role": "user", "content": [
                {"type": "text", "text": "[Image #1] what colour is this picture?"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
            ]}}),
        ),
        // Claude's own companion line naming the file: housekeeping.
        line(
            json!({"type": "user", "uuid": "u2", "isSidechain": false, "isMeta": true,
            "message": {"role": "user", "content": [
                {"type": "text", "text": "[Image: source: /home/dev/.claude/image-cache/1.png]"}]}}),
        ),
        say("a1", "m1", 0, "It is blue.", Some("end_turn")),
        turn_duration("t1"),
    ]
}

fn scenarios() -> Vec<(&'static str, Vec<String>)> {
    vec![
        ("plain", plain()),
        ("bash-approve", bash_approve()),
        ("queued-tool", queued_tool()),
        ("bash-fail", bash_fail()),
        ("edit-write", edit_write()),
        ("compact", compact()),
        ("clear-new", clear_new()),
        ("plan-mode", plan_mode()),
        ("interrupt-tool", interrupt_tool()),
        ("interrupt-text", interrupt_text()),
        ("bash-deny", bash_deny()),
        ("bash-esc", bash_esc()),
        ("ask-single", ask_single()),
        ("ask-two", ask_two()),
        ("ask-declined", ask_declined()),
        ("tasks", tasks()),
        ("todowrite", todowrite()),
        ("subagent", subagent()),
        (
            "background-finished",
            background_ended_by_notice("completed"),
        ),
        ("background-failed", background_ended_by_notice("failed")),
        ("background-killed", background_killed()),
        ("background-user-stopped", background_user_stopped()),
        ("image-paste", image_paste()),
    ]
}

fn status_of(sim: &Sim) -> Vec<(String, String)> {
    sim.tools()
        .iter()
        .map(|c| {
            (
                c["toolCallId"].as_str().unwrap_or_default().to_owned(),
                c["status"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

fn title_of(call: &Map<String, Value>) -> &str {
    call["title"].as_str().unwrap_or_default()
}

fn ids(set: &std::collections::BTreeSet<String>) -> Vec<&str> {
    set.iter().map(String::as_str).collect()
}

// -- tests --------------------------------------------------------------------------------------------------

#[test]
fn every_scenario_maps_and_a_second_pass_changes_nothing() {
    for (name, lines) in scenarios() {
        let mut sim = Sim::default();
        let mut mapper = ClaudeMapper::default();
        feed(&mut sim, &mut mapper, &lines);
        let (items, statuses) = (sim.items.len(), status_of(&sim));
        feed(&mut sim, &mut mapper, &lines);
        assert_eq!(sim.items.len(), items, "{name}");
        assert_eq!(status_of(&sim), statuses, "{name}");
    }
}

mod a_turn {
    use super::*;

    #[test]
    fn has_the_persons_prompts_claudes_replies_the_title_and_no_empty_thinking() {
        let (sim, mapper) = run(&plain());

        assert_eq!(
            sim.texts(Role::User),
            ["say hi in 5 words", "now say bye in 3 words"]
        );
        assert_eq!(sim.texts(Role::Agent).len(), 2);
        assert!(sim.messages(Role::Thought).is_empty());
        assert_eq!(sim.title.as_deref(), Some("Greeting in five words"));
        assert!(mapper.turn_ended());
    }

    #[test]
    fn a_tool_call_written_before_it_finishes_is_a_running_row_and_its_result_completes_it() {
        let lines = bash_approve();
        let mut sim = Sim::default();
        let mut mapper = ClaudeMapper::default();
        feed(&mut sim, &mut mapper, &through(&lines, "Bash"));

        let tools = sim.tools();
        assert_eq!(tools.len(), 1);
        let call = tools[0];
        assert_eq!(
            (
                call["status"].as_str(),
                call["kind"].as_str(),
                call["name"].as_str()
            ),
            (Some("in_progress"), Some("execute"), Some("Bash"))
        );
        // The approval card compares with it.
        assert_eq!(call["rawInput"]["command"], "touch /tmp/hm-test/x.txt");
        assert_eq!(ids(&mapper.open_tool_calls()), ["toolu_01"]);
        assert!(!mapper.turn_ended());

        feed(&mut sim, &mut mapper, &lines);
        assert_eq!(sim.tools().len(), 1);
        assert_eq!(sim.tools()[0]["status"], "completed");
        assert!(mapper.open_tool_calls().is_empty());
    }

    #[test]
    fn a_command_shows_its_output_and_a_failing_one_is_failed() {
        let (ok, _) = run(&queued_tool());
        let (bad, _) = run(&bash_fail());

        assert!(tool_text(ok.tool_named("Bash")).contains("12 packets transmitted"));
        let failed = bad.tool_named("Bash");
        assert_eq!(failed["status"], "failed");
        assert!(tool_text(failed).contains("Exit code 1"));
    }

    #[test]
    fn write_and_edit_show_the_change_and_a_tool_a_hook_blocked_is_failed_not_cancelled() {
        let (sim, _) = run(&edit_write());

        let write = diffs(sim.tool_named("Write"));
        assert_eq!(write.len(), 1);
        assert_eq!(write[0]["path"], "/home/dev/project/note.txt");
        assert_eq!(write[0].get("oldText"), None);
        assert_eq!(write[0]["newText"], "hello world");
        let edit = diffs(sim.tool_named("Edit"));
        assert_eq!(edit.len(), 1);
        assert_eq!(
            (edit[0]["oldText"].as_str(), edit[0]["newText"].as_str()),
            (Some("world"), Some("there"))
        );
        assert_eq!(
            sim.tool_named("Edit")["locations"],
            json!([{"path": "/home/dev/project/note.txt"}])
        );
        assert_eq!(sim.tool_named("Read")["status"], "failed");
    }

    #[test]
    fn a_prompt_typed_while_a_tool_ran_shows_once() {
        let (sim, _) = run(&queued_tool());
        let typed: Vec<_> = sim
            .texts(Role::User)
            .into_iter()
            .filter(|t| t.contains("PINEAPPLE"))
            .collect();
        assert_eq!(typed.len(), 1);
    }

    #[test]
    fn a_slash_command_shows_as_typed_once_and_a_compaction_is_a_quiet_note() {
        let (sim, _) = run(&compact());

        assert_eq!(
            sim.texts(Role::User)
                .iter()
                .filter(|t| *t == "/compact")
                .count(),
            1
        );
        assert!(
            sim.texts(Role::Agent)
                .contains(&"Earlier messages were summarised".to_owned())
        );
    }

    #[test]
    fn clear_is_not_a_message_of_the_person_but_one_note_that_says_why_the_new_chat_is_empty() {
        let (sim, _) = run(&clear_new());
        assert!(!sim.texts(Role::User).contains(&"/clear".to_owned()));
        assert_eq!(sim.texts(Role::User), ["hello again"]);
        assert_eq!(sim.texts(Role::Agent), ["The conversation was cleared"]);
    }

    #[test]
    fn rename_sets_the_title_beats_the_ai_title_however_often_it_is_rewritten_and_is_not_a_message()
    {
        let title =
            |kind: &str, key: &str, t: &str| line(json!({"type": kind, key: t, "sessionId": "x"}));
        let mut sim = Sim::default();
        let mut mapper = ClaudeMapper::default();
        feed(
            &mut sim,
            &mut mapper,
            &[
                title("ai-title", "aiTitle", "Auto title"),
                user(
                    "a",
                    json!(
                        "<command-name>/rename</command-name>\n<command-message>rename</command-message>\n<command-args>My name</command-args>"
                    ),
                ),
                user(
                    "b",
                    json!(
                        "<local-command-stdout>Session renamed to: My name</local-command-stdout>"
                    ),
                ),
                title("custom-title", "customTitle", "My name"),
                // Claude appends both titles again later, the AI one last.
                title("custom-title", "customTitle", "My name"),
                title("ai-title", "aiTitle", "Auto title"),
            ],
        );

        assert_eq!(sim.title.as_deref(), Some("My name"));
        assert!(sim.texts(Role::User).is_empty());
        assert_eq!(sim.texts(Role::Agent), ["Session renamed to: My name"]);

        // Renamed back to an earlier name: the same line as before must still count.
        feed(
            &mut sim,
            &mut mapper,
            &[
                title("custom-title", "customTitle", "Other"),
                title("custom-title", "customTitle", "My name"),
            ],
        );
        assert_eq!(sim.title.as_deref(), Some("My name"));
    }

    #[test]
    fn a_skill_or_custom_command_command_message_first_shows_as_typed_not_as_raw_tags() {
        let (sim, _) = run(&[user(
            "u1",
            json!(
                "<command-message>review is running…</command-message>\n<command-name>/review</command-name>\n<command-args>the diff</command-args>"
            ),
        )]);

        assert_eq!(sim.texts(Role::User), ["/review the diff"]);
    }

    #[test]
    fn bash_mode_memory_notes_stderr_and_teammates_show_as_what_they_are_never_as_raw_tags() {
        let (sim, _) = run(&[
            user("a", json!("<bash-input>ls /tmp</bash-input>")),
            user(
                "b",
                json!("<bash-stdout>one\ntwo</bash-stdout><bash-stderr></bash-stderr>"),
            ),
            user(
                "c",
                json!("<bash-stdout></bash-stdout><bash-stderr>nope</bash-stderr>"),
            ),
            user(
                "d",
                json!("<user-memory-input>use tabs</user-memory-input>"),
            ),
            user(
                "e",
                json!("<local-command-stderr>boom</local-command-stderr>"),
            ),
            user(
                "f",
                json!([
                    {"type": "text", "text": "<system-reminder>context</system-reminder>"},
                    {"type": "text", "text": "fix the build"},
                ]),
            ),
            user(
                "g",
                json!(
                    "<teammate-message teammate_id=\"reviewer\" color=\"blue\" summary=\"Found 2 issues\">long body</teammate-message>"
                ),
            ),
        ]);

        assert_eq!(
            sim.texts(Role::User),
            ["!ls /tmp", "# use tabs", "fix the build"]
        );
        assert_eq!(
            sim.texts(Role::Agent),
            [
                "one\ntwo",
                "stderr:\nnope",
                "boom",
                "reviewer: Found 2 issues"
            ]
        );
    }

    #[test]
    fn a_prompt_typed_during_a_turn_shows_when_it_was_typed_once() {
        let (sim, _) = run(&queued_tool());
        let typed: Vec<_> = sim
            .messages(Role::User)
            .into_iter()
            .filter(|(_, b)| text_of_blocks(b).contains("PINEAPPLE"))
            .collect();
        assert_eq!(typed.len(), 1);
        // Shown when typed (before the agent's reply), not seconds later.
        assert!(sim.index_of(Role::User, "PINEAPPLE") < sim.index_of(Role::Agent, "PINEAPPLE"));
    }

    #[test]
    fn loading_a_deferred_tool_is_not_a_row_and_compact_shows_its_first_line_not_a_hook_report() {
        let (plan, _) = run(&plan_mode());
        assert!(
            plan.tools()
                .iter()
                .all(|c| c["name"] != "ToolSearch" && c["toolCallId"] != "toolu_ts")
        );
        let (compact, _) = run(&self::compact());
        for t in compact.texts(Role::Agent) {
            assert!(!t.contains("systemMessage"), "{t}");
            assert!(!t.contains('\n'), "{t}");
        }
        assert!(
            compact
                .texts(Role::Agent)
                .contains(&"Compacted (ctrl+o to see full summary)".to_owned())
        );
    }

    #[test]
    fn housekeeping_never_shows_caveats_reminders_hook_output() {
        for (name, lines) in [("clear-new", clear_new()), ("bash-approve", bash_approve())] {
            let (sim, _) = run(&lines);
            let mut all = sim.texts(Role::User);
            all.extend(sim.texts(Role::Agent));
            for t in all {
                assert!(!t.contains("local-command-caveat"), "{name}: {t}");
                assert!(!t.contains("system-reminder"), "{name}: {t}");
            }
        }
        // The reminder that came with the prompt is dropped, the prompt is not.
        let (sim, _) = run(&bash_approve());
        assert_eq!(sim.texts(Role::User), ["create the file x.txt"]);
    }

    #[test]
    fn a_failed_api_call_says_so() {
        let (sim, mapper) = run(&[line(json!({
            "type": "assistant", "uuid": "u1", "isSidechain": false, "isApiErrorMessage": true,
            "message": {"model": "<synthetic>", "id": "x",
                "content": [{"type": "text", "text": "API Error: 529 overloaded"}]},
        }))]);

        assert_eq!(
            sim.texts(Role::Agent),
            ["The turn failed: API Error: 529 overloaded"]
        );
        assert!(mapper.turn_ended());
    }
}

mod stopping {
    use super::*;

    #[test]
    fn esc_during_a_tool_the_call_is_cancelled_it_says_so_and_the_turn_is_over_without_a_turn_duration()
     {
        let (sim, mapper) = run(&interrupt_tool());

        assert_eq!(sim.tool_named("Bash")["status"], "cancelled");
        assert!(sim.texts(Role::Agent).contains(&"Interrupted".to_owned()));
        assert!(mapper.turn_ended());
        assert!(mapper.open_tool_calls().is_empty());
    }

    #[test]
    fn esc_during_streamed_text_keeps_the_text_and_ends_the_turn() {
        let (sim, mapper) = run(&interrupt_text());

        assert!(sim.texts(Role::Agent)[0].starts_with("**The Lighthouse Story**"));
        assert!(mapper.turn_ended());
    }

    #[test]
    fn a_tool_the_person_refused_is_cancelled_not_failed() {
        for (name, lines) in [("bash-deny", bash_deny()), ("bash-esc", bash_esc())] {
            let (sim, mapper) = run(&lines);
            assert_eq!(sim.tool_named("Bash")["status"], "cancelled", "{name}");
            assert!(mapper.open_tool_calls().is_empty(), "{name}");
        }
    }

    #[test]
    fn turn_duration_is_what_ends_a_turn_that_finished_by_itself() {
        let lines = plain();
        let end = lines
            .iter()
            .position(|l| l.contains(r#""turn_duration""#))
            .unwrap();
        let (_, mapper) = run(&lines[..end]);
        // The final answer says end_turn already.
        assert!(mapper.turn_ended());

        let (_, other) = run(&through(&bash_approve(), "Bash"));
        assert!(!other.turn_ended());
    }
}

mod questions_and_plans {
    use super::*;

    #[test]
    fn an_ask_user_question_that_waits_is_a_pending_question_with_its_options_and_its_answer_clears_it()
     {
        let lines = ask_single();
        let mut sim = Sim::default();
        let mut mapper = ClaudeMapper::default();
        feed(&mut sim, &mut mapper, &through(&lines, "AskUserQuestion"));

        let ask = mapper.pending_ask().expect("the question waits");
        assert_eq!(ask.tool_call_id, "toolu_q");
        let q = &ask.questions[0];
        assert_eq!(ask.questions.len(), 1);
        assert_eq!(q.id, "Color");
        assert_eq!(q.question, "Which color do you prefer?");
        // Claude adds its own Other row.
        assert_eq!(
            q.options
                .iter()
                .map(|o| o.label.as_str())
                .collect::<Vec<_>>(),
            ["Red", "Green", "Blue"]
        );
        assert_eq!(q.options[0].description, "Warm");
        assert!(!q.multi);

        feed(&mut sim, &mut mapper, &lines);
        assert_eq!(mapper.pending_ask(), None);
        let answered = sim.tool_named("AskUserQuestion");
        assert!(
            answered["rawOutput"]
                .as_str()
                .unwrap()
                .contains("Your questions have been answered")
        );
    }

    #[test]
    fn a_multi_select_and_a_two_question_form_keep_their_shape() {
        let (_, mapper) = run(&ask_two());
        let shape: Vec<_> = mapper
            .pending_ask()
            .unwrap()
            .questions
            .into_iter()
            .map(|q| (q.id, q.multi))
            .collect();
        assert_eq!(
            shape,
            [("Lang".to_owned(), false), ("Extras".to_owned(), true)]
        );
    }

    #[test]
    fn a_declined_question_is_cancelled_and_no_longer_pending() {
        let (sim, mapper) = run(&ask_declined());
        assert_eq!(sim.tool_named("AskUserQuestion")["status"], "cancelled");
        assert_eq!(mapper.pending_ask(), None);
    }

    #[test]
    fn a_question_the_person_answered_in_the_terminal_by_typing_is_dropped_when_they_send_a_prompt()
    {
        let mut sim = Sim::default();
        let mut mapper = ClaudeMapper::default();
        feed(
            &mut sim,
            &mut mapper,
            &through(&ask_single(), "AskUserQuestion"),
        );
        assert!(mapper.pending_ask().is_some());

        feed(&mut sim, &mut mapper, &[prompt("typed-1", "never mind")]);

        assert_eq!(mapper.pending_ask(), None);
        assert_eq!(sim.tool_named("AskUserQuestion")["status"], "cancelled");
        assert!(mapper.open_tool_calls().is_empty());
    }

    #[test]
    fn exit_plan_mode_keeps_the_plan_so_the_approval_card_can_show_it() {
        let (sim, mapper) = {
            let mut sim = Sim::default();
            let mut mapper = ClaudeMapper::default();
            feed(
                &mut sim,
                &mut mapper,
                &through(&plan_mode(), "ExitPlanMode"),
            );
            (sim, mapper)
        };

        let call = sim.tool_named("ExitPlanMode");
        assert_eq!(call["status"], "in_progress");
        assert!(
            call["rawInput"]["plan"]
                .as_str()
                .unwrap()
                .starts_with("# Plan: create hello.txt")
        );
        assert_eq!(call["kind"], "switch_mode");
        assert_eq!(title_of(call), "Plan for approval");
        assert_eq!(mapper.proposed_plan(), None);
    }

    #[test]
    fn task_create_and_task_update_build_the_task_list_and_todo_write_replaces_it() {
        let (tasks, _) = run(&tasks());
        let (todos, _) = run(&todowrite());

        let plan: Vec<_> = tasks
            .plan
            .iter()
            .map(|e| (e.content.as_str(), e.status))
            .collect();
        assert_eq!(
            plan,
            [
                ("Research", PlanStatus::Completed),
                ("Build", PlanStatus::Completed),
                ("Test", PlanStatus::Completed),
            ]
        );
        assert_eq!(todos.plan.len(), 2);
        assert!(todos.plan.iter().all(|e| e.status == PlanStatus::Completed));
        assert_eq!(title_of(todos.tool_named("TodoWrite")), "Task list");
    }
}

mod subagents {
    use super::*;

    #[test]
    fn the_parent_lists_the_subagent_with_the_id_its_transcript_is_named_by() {
        let (sim, mapper) = run(&subagent());

        let subs = mapper.subagents();
        assert_eq!(subs.len(), 1);
        let sub = &subs[0];
        assert_eq!(sub.name, "List files in project");
        assert_eq!(
            (
                sub.agent.as_str(),
                sub.status.as_str(),
                sub.log_id.as_deref()
            ),
            ("general-purpose", "completed", Some(AGENT_ID))
        );
        assert_eq!(
            sub.call_id.as_deref(),
            Some(sim.tool_named("Agent")["toolCallId"].as_str().unwrap())
        );
        assert!(sub.assignment.starts_with("Use the Bash tool to run `ls`"));
        // A subagent's call is a task, not what a permission dialog asks about.
        assert!(mapper.open_tool_calls().is_empty());
    }

    #[test]
    fn a_subagent_still_running_is_running_and_is_a_background_task_the_person_can_stop() {
        let lines = subagent();
        let notice_at = lines
            .iter()
            .position(|l| l.contains("<task-notification>"))
            .unwrap();
        let (_, mapper) = run(&lines[..notice_at]);

        assert_eq!(mapper.subagents()[0].status, "running");
        let tasks = mapper.background_tasks();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].kind, BackgroundKind::Agent);
        assert_eq!(tasks[0].id, AGENT_ID);
        assert_eq!(tasks[0].stop, StopRoute::Message);
        assert_eq!(tasks[0].tool_call_id.as_deref(), Some(AGENT_CALL));
    }

    #[test]
    fn the_transcript_of_a_subagent_is_mapped_by_a_sidechain_mapper_only() {
        let lines = subagent_transcript();

        let (main, _) = run(&lines);
        let mut side = Sim::default();
        feed(&mut side, &mut ClaudeMapper::new(true), &lines);

        assert!(main.items.is_empty());
        let tools = side.tools();
        assert_eq!(tools.len(), 1);
        assert_eq!(
            title_of(tools[0]),
            "List contents of project temp directory"
        );
        let agent = side.texts(Role::Agent);
        assert_eq!(agent.len(), 1);
        assert!(agent[0].contains("no entries"));
        let user = side.texts(Role::User);
        assert_eq!(user.len(), 1);
        assert!(user[0].starts_with("Use the Bash tool to run `ls`"));
    }

    #[test]
    fn a_sidechain_mapper_maps_nothing_of_the_main_log() {
        // The other half of the split.
        let mut side = Sim::default();
        feed(&mut side, &mut ClaudeMapper::new(true), &subagent());
        assert!(side.items.is_empty());
    }

    #[test]
    fn two_subagents_with_one_description_are_told_apart() {
        let agent = |n: u32| {
            call(
                &format!("a{n}"),
                &format!("m{n}"),
                0,
                &format!("toolu_a{n}"),
                "Task",
                json!({"description": "Check", "subagent_type": "explore", "prompt": "look"}),
            )
        };
        let (_, mapper) = run(&[agent(1), agent(2), agent(3)]);
        let names: Vec<_> = mapper.subagents().into_iter().map(|s| s.name).collect();
        assert_eq!(names, ["Check", "Check (2)", "Check (3)"]);
    }
}

mod background_work {
    use super::*;

    #[test]
    fn a_background_command_is_a_running_task_until_its_notice_and_the_notice_is_not_a_message_from_the_person()
     {
        let lines = background_ended_by_notice("completed");
        let at = lines
            .iter()
            .position(|l| l.contains("<task-notification>") && l.contains(r#""type":"user""#))
            .unwrap();
        let mut sim = Sim::default();
        let mut mapper = ClaudeMapper::default();
        feed(&mut sim, &mut mapper, &lines[..at]);

        let tasks = mapper.background_tasks();
        assert_eq!(tasks.len(), 1);
        let t = &tasks[0];
        assert_eq!(
            (t.id.as_str(), t.kind, t.status, t.stop),
            (
                BG_TASK,
                BackgroundKind::Shell,
                BackgroundStatus::Running,
                StopRoute::Message
            )
        );
        assert_eq!(t.title, "sleep 25 && echo finished");
        assert_eq!(t.detail.as_deref(), Some("sleep 25 && echo finished"));
        assert_eq!(t.tool_call_id.as_deref(), Some("toolu_bg"));
        // By the log's own clock: 2026-11-01T10:00:00.250Z.
        assert_eq!((t.started_ms, t.ended_ms), (Some(1_793_527_200_250), None));
        // The turn is over; only the job runs.
        assert!(mapper.turn_ended());

        feed(&mut sim, &mut mapper, &lines[at..]);
        let tasks = mapper.background_tasks();
        assert_eq!(tasks[0].status, BackgroundStatus::Finished);
        assert_eq!(tasks[0].stop, StopRoute::None);
        // 2026-11-01T10:05:00.500Z, the notice's own time.
        assert_eq!(tasks[0].ended_ms, Some(1_793_527_500_500));
        assert!(
            sim.texts(Role::User)
                .iter()
                .all(|t| !t.contains("task-notification"))
        );
    }

    #[test]
    fn failed_killed_by_the_model_and_stopped_by_the_person_end_as_what_they_were() {
        let status = |lines: &[String]| run(lines).1.background_tasks()[0].status;
        assert_eq!(
            status(&background_ended_by_notice("failed")),
            BackgroundStatus::Failed
        );
        assert_eq!(status(&background_killed()), BackgroundStatus::Stopped);
        let (sim, mapper) = run(&background_user_stopped());
        assert_eq!(
            mapper.background_tasks()[0].status,
            BackgroundStatus::Stopped
        );
        assert!(
            sim.texts(Role::User)
                .iter()
                .all(|t| !t.contains("task-notification"))
        );
    }

    #[test]
    fn a_notice_that_waited_for_the_persons_prompt_does_not_start_a_turn_one_of_its_own_does() {
        let waited = line(json!({
            "type": "attachment", "uuid": "q1", "isSidechain": false,
            "attachment": {"type": "queued_command", "commandMode": "task-notification",
                "prompt": format!("<task-notification>\n<task-id>{BG_TASK}</task-id>\n<status>killed</status>\n</task-notification>")},
        }));
        let mut lines = background_start();
        lines.push(waited);
        let (_, mapper) = run(&lines);
        assert!(mapper.turn_ended());
        assert_eq!(
            mapper.background_tasks()[0].status,
            BackgroundStatus::Stopped
        );

        let mut lines = background_start();
        lines.push(notice("n1", BG_TASK, "completed"));
        let (_, woken) = run(&lines);
        assert!(!woken.turn_ended());
    }

    // Hand-written from the official tool schema (WorkflowOutput, MonitorOutput) of
    // @anthropic-ai/claude-agent-sdk: the capture could not make Claude Code run either tool.
    #[test]
    fn a_workflow_and_a_monitor_are_background_tasks_of_their_kinds_ended_by_their_notice() {
        let tool_call = |id: &str, name: &str, input: Value| {
            call(&format!("a-{id}"), &format!("m-{id}"), 0, id, name, input)
        };
        let tool_result = |id: &str, out: Value| {
            result(&format!("r-{id}"), id, json!("launched"), false, Some(out))
        };
        let mut mapper = ClaudeMapper::default();
        let mut sim = Sim::default();
        feed(
            &mut sim,
            &mut mapper,
            &[
                tool_call("t1", "Workflow", json!({"name": "release-check"})),
                tool_result(
                    "t1",
                    json!({"status": "async_launched", "taskId": "wf1abc", "workflowName": "release-check"}),
                ),
                tool_call(
                    "t2",
                    "Monitor",
                    json!({"description": "Watch the deploy log", "timeout_ms": 300000, "command": "tail -f x"}),
                ),
                tool_result("t2", json!({"taskId": "mon9xyz", "timeoutMs": 300000})),
            ],
        );

        let view = |m: &ClaudeMapper| -> Vec<_> {
            m.background_tasks()
                .into_iter()
                .map(|t| (t.id, t.kind, t.title, t.status))
                .collect()
        };
        assert_eq!(
            view(&mapper),
            [
                (
                    "wf1abc".to_owned(),
                    BackgroundKind::Workflow,
                    "release-check".to_owned(),
                    BackgroundStatus::Running
                ),
                (
                    "mon9xyz".to_owned(),
                    BackgroundKind::Monitor,
                    "Watch the deploy log".to_owned(),
                    BackgroundStatus::Running
                ),
            ]
        );

        feed(
            &mut sim,
            &mut mapper,
            &[notice("n1", "wf1abc", "completed")],
        );
        let statuses: Vec<_> = mapper.background_tasks().iter().map(|t| t.status).collect();
        assert_eq!(
            statuses,
            [BackgroundStatus::Finished, BackgroundStatus::Running]
        );
    }

    #[test]
    fn only_plain_task_ids_can_be_put_in_a_message_to_claude() {
        let start = call("a1", "m1", 0, "t1", "Bash", json!({"command": "x"}));
        let done = line(json!({
            "type": "user", "uuid": "r1", "isSidechain": false,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "x"}]},
            "toolUseResult": {"backgroundTaskId": "a b; rm -rf /"},
        }));
        let (_, mapper) = run(&[start, done]);
        assert!(mapper.background_tasks().is_empty());

        assert_eq!(stop_message(["a b; rm -rf /"]), None);
        assert_eq!(stop_message(["ok", "x y"]), None);
    }

    #[test]
    fn a_finished_task_is_kept_but_only_the_latest_thirty() {
        let mut lines = Vec::new();
        for n in 0..35 {
            lines.push(call(
                &format!("a{n}"),
                &format!("m{n}"),
                0,
                &format!("t{n}"),
                "Bash",
                json!({"command": format!("job {n}")}),
            ));
            lines.push(line(json!({
                "type": "user", "uuid": format!("r{n}"), "isSidechain": false,
                "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("t{n}"), "content": "ok"}]},
                "toolUseResult": {"backgroundTaskId": format!("bg{n}")},
            })));
            lines.push(notice(&format!("n{n}"), &format!("bg{n}"), "completed"));
        }
        // One that still runs is never dropped.
        lines.push(call(
            "ax",
            "mx",
            0,
            "tx",
            "Bash",
            json!({"command": "forever"}),
        ));
        lines.push(line(json!({
            "type": "user", "uuid": "rx", "isSidechain": false,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tx", "content": "ok"}]},
            "toolUseResult": {"backgroundTaskId": "bgx"},
        })));
        let (_, mapper) = run(&lines);
        let tasks = mapper.background_tasks();
        let finished: Vec<_> = tasks.iter().filter(|t| !t.status.is_active()).collect();
        assert_eq!(finished.len(), 30);
        assert_eq!(finished[0].id, "bg5");
        assert_eq!(tasks.last().unwrap().id, "bgx");
        assert!(tasks.last().unwrap().status.is_active());
    }

    #[test]
    fn stop_message_asks_for_task_stop_by_id() {
        assert_eq!(
            stop_message(["bwn5dp2o7"]).as_deref(),
            Some("Stop these background task now: bwn5dp2o7. Use TaskStop. Do nothing else.")
        );
        assert_eq!(
            stop_message(["a", "b"]).as_deref(),
            Some("Stop these background tasks now: a, b. Use TaskStop. Do nothing else.")
        );
        assert_eq!(stop_message([]), None);
    }
}

mod robustness {
    use super::*;

    #[test]
    fn garbage_and_unknown_shapes_map_to_nothing() {
        let mut mapper = ClaudeMapper::default();
        for l in [
            "",
            "not json",
            "[]",
            "{}",
            r#"{"type":"assistant"}"#,
            r#"{"type":"user","message":5}"#,
            r#"{"type":"mystery","uuid":"x"}"#,
        ] {
            assert!(mapper.map(l).is_empty(), "{l}");
        }
    }

    #[test]
    fn reset_forgets_everything_so_the_same_file_maps_again() {
        let mut mapper = ClaudeMapper::default();
        let lines = plain();
        let mut first = Sim::default();
        feed(&mut first, &mut mapper, &lines);
        mapper.reset();
        let mut second = Sim::default();
        feed(&mut second, &mut mapper, &lines);

        assert_eq!(second.items.len(), first.items.len());
        assert!(mapper.open_tool_calls().is_empty());
    }

    #[test]
    fn reset_keeps_the_kind_of_log_the_mapper_reads() {
        let mut side = ClaudeMapper::new(true);
        side.reset();
        let mut sim = Sim::default();
        feed(&mut sim, &mut side, &subagent_transcript());
        assert_eq!(sim.tools().len(), 1);
    }

    #[test]
    fn the_boxed_constructors_make_a_main_and_a_sidechain_mapper() {
        let mut sim = Sim::default();
        let mut main = new_mapper();
        let mut side = new_sidechain_mapper();
        for l in subagent_transcript() {
            assert!(main.map(&l).is_empty());
            for u in side.map(&l) {
                sim.apply(u);
            }
        }
        assert_eq!(sim.tools().len(), 1);
    }
}

mod a_message_with_a_picture {
    use super::*;

    #[test]
    fn the_captured_paste_shows_once_with_the_agents_own_placeholder_and_not_the_companion_line_naming_the_file()
     {
        let (sim, _) = run(&image_paste());
        let texts = sim.texts(Role::User);
        assert_eq!(texts[0], "[Image #1] what colour is this picture?");
        assert_eq!(
            texts.iter().filter(|t| t.starts_with("[Image #1]")).count(),
            1
        );
        // The isMeta companion is housekeeping.
        assert!(texts.iter().all(|t| !t.contains("[Image: source:")));
        // The placeholder already marks the picture.
        assert!(texts.iter().all(|t| !t.contains("[image]")));
    }

    #[test]
    fn a_picture_the_text_does_not_mark_gets_an_image_line_and_a_picture_alone_is_not_an_empty_message()
     {
        let image = json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "<trimmed>"}});
        let (sim, _) = run(&[
            user(
                "a",
                json!([{"type": "text", "text": "what is this?"}, image, image]),
            ),
            user("b", json!([image])),
        ]);
        assert_eq!(
            sim.texts(Role::User),
            ["what is this?\n[image]\n[image]", "[image]"]
        );
    }
}

mod a_picture_the_host_can_send_again {
    use super::*;

    fn image(data: &str, mime: &str) -> Value {
        json!({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}})
    }

    #[test]
    fn a_note_with_a_reference_becomes_a_block_with_its_type_and_size_next_to_the_words() {
        let (sim, _) = run(&[user(
            "a",
            json!([
                {"type": "text", "text": "what is this?"},
                image("[107536 bytes of data not sent; ref=4096.0123456789abcdef]", "image/jpeg"),
            ]),
        )]);
        let messages = sim.messages(Role::User);
        assert_eq!(messages.len(), 1);
        let blocks = messages[0].1;
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0], Block::Text("what is this?".to_owned()));
        let Block::Image(picture) = &blocks[1] else {
            panic!("the picture is a block: {blocks:?}")
        };
        assert_eq!(picture.mime, "image/jpeg");
        assert_eq!(
            picture.source,
            PictureRef::Keeper {
                start: 4096,
                hash: "0123456789abcdef".to_owned(),
                bytes: Some(80652),
            }
        );
        // No [image] line for a picture that is a block.
        assert_eq!(sim.texts(Role::User), ["what is this?"]);
    }

    #[test]
    fn a_picture_alone_is_a_message_of_its_own_not_an_empty_one() {
        let (sim, _) = run(&[user(
            "b",
            json!([image(
                "[40 bytes of data not sent; ref=0.0123456789abcdef]",
                "image/png"
            )]),
        )]);
        let messages = sim.messages(Role::User);
        assert_eq!(messages.len(), 1);
        assert!(matches!(messages[0].1, [Block::Image(_)]));
    }

    #[test]
    fn a_note_an_older_host_wrote_with_no_reference_keeps_the_image_line_the_two_kinds_mix() {
        let (sim, _) = run(&[user(
            "c",
            json!([
                {"type": "text", "text": "two"},
                image("[40 bytes of data not sent]", "image/png"),
                image("[40 bytes of data not sent; ref=7.0123456789abcdef]", "image/png"),
            ]),
        )]);
        let messages = sim.messages(Role::User);
        let pictures = messages[0]
            .1
            .iter()
            .filter(|b| matches!(b, Block::Image(_)))
            .count();
        assert_eq!(pictures, 1);
        assert_eq!(sim.texts(Role::User), ["two\n[image]"]);
    }

    #[test]
    fn the_same_line_mapped_twice_replaces_the_message_never_doubles_the_picture() {
        let l = user(
            "d",
            json!([image(
                "[40 bytes of data not sent; ref=7.0123456789abcdef]",
                "image/png"
            )]),
        );
        let mut sim = Sim::default();
        feed(
            &mut sim,
            &mut ClaudeMapper::default(),
            std::slice::from_ref(&l),
        );
        feed(&mut sim, &mut ClaudeMapper::default(), &[l.clone(), l]);
        let pictures: usize = sim
            .messages(Role::User)
            .iter()
            .map(|(_, b)| b.iter().filter(|b| matches!(b, Block::Image(_))).count())
            .sum();
        assert_eq!(pictures, 1);
    }
}

mod the_skills_claude_lists {
    use super::*;

    fn listing(names: Option<&[&str]>, content: Option<&str>, initial: Option<bool>) -> String {
        let mut a = json!({"type": "skill_listing"});
        if let Some(names) = names {
            a["names"] = json!(names);
        }
        if let Some(content) = content {
            a["content"] = json!(content);
        }
        if let Some(initial) = initial {
            a["isInitial"] = json!(initial);
        }
        line(json!({"type": "attachment", "attachment": a}))
    }

    fn names(sim: &Sim) -> Vec<&str> {
        sim.commands.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn the_captured_listing_becomes_the_sessions_commands_with_their_descriptions() {
        let (sim, _) = run(&image_paste());
        assert_eq!(sim.commands.len(), 70);
        assert!(sim.commands.iter().all(|c| c.kind == CommandKind::Skill));
        let first = &sim.commands[0];
        assert_eq!(first.name, "skill-00");
        assert!(first.description.starts_with("Query the project profile"));
        assert!(
            sim.commands
                .iter()
                .all(|c| c.description.chars().count() <= 140)
        );
        assert!(
            first.description.ends_with('…'),
            "a long description is cut"
        );
        assert_eq!(sim.commands[1].description, "Does the work of skill-01");
    }

    #[test]
    fn a_namespaced_skill_keeps_its_whole_name_and_its_description() {
        let (sim, _) = run(&[listing(
            Some(&["superpowers:brainstorming", "review"]),
            Some(
                "- superpowers:brainstorming: Explore ideas: before building\n- review: Review a pull request",
            ),
            None,
        )]);
        let pairs: Vec<_> = sim
            .commands
            .iter()
            .map(|c| (c.name.as_str(), c.description.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                (
                    "superpowers:brainstorming",
                    "Explore ideas: before building"
                ),
                ("review", "Review a pull request"),
            ]
        );
    }

    #[test]
    fn a_later_listing_adds_to_the_set_a_new_first_one_replaces_it_and_a_reset_forgets_it() {
        let mut mapper = ClaudeMapper::default();
        let mut sim = Sim::default();
        feed(
            &mut sim,
            &mut mapper,
            &[listing(Some(&["a", "b"]), None, Some(true))],
        );
        feed(
            &mut sim,
            &mut mapper,
            &[listing(Some(&["c"]), None, Some(false))],
        );
        assert_eq!(names(&sim), ["a", "b", "c"]);
        feed(
            &mut sim,
            &mut mapper,
            &[listing(Some(&["d"]), None, Some(true))],
        );
        assert_eq!(names(&sim), ["d"]);

        mapper.reset();
        let mut fresh = Sim::default();
        feed(
            &mut fresh,
            &mut mapper,
            &[listing(Some(&["e"]), None, Some(false))],
        );
        // Nothing of before the reset is merged.
        assert_eq!(names(&fresh), ["e"]);
    }

    #[test]
    fn names_that_are_not_names_and_a_listing_with_nothing_in_it_say_nothing() {
        let long = "x".repeat(70);
        let (sim, _) = run(&[
            listing(Some(&["ok", "has space", long.as_str(), ""]), None, None),
            listing(None, Some("<trimmed>"), None),
        ]);
        assert_eq!(names(&sim), ["ok"]);
    }

    #[test]
    fn without_a_names_list_the_described_lines_name_the_skills() {
        let (sim, _) = run(&[listing(
            None,
            Some("- one: First\n- two words: Not a name\n- three: Third"),
            None,
        )]);
        let pairs: Vec<_> = sim
            .commands
            .iter()
            .map(|c| (c.name.as_str(), c.description.as_str()))
            .collect();
        assert_eq!(pairs, [("one", "First"), ("three", "Third")]);
    }

    #[test]
    fn a_listing_from_the_head_of_the_log_comes_first_and_one_whole_listing_read_here_wins() {
        let head = |names: &[&str]| {
            names
                .iter()
                .map(|n| SlashCommand {
                    name: (*n).to_owned(),
                    description: String::new(),
                    hint: None,
                    kind: CommandKind::Skill,
                })
                .collect::<Vec<_>>()
        };
        // The tail read only a later listing: the head's set is the base, the later one adds to it.
        let mut mapper = ClaudeMapper::default();
        let mut sim = Sim::default();
        feed(
            &mut sim,
            &mut mapper,
            &[listing(Some(&["c"]), None, Some(false))],
        );
        for u in mapper.adopt_commands(head(&["a", "b"])) {
            sim.apply(u);
        }
        assert_eq!(names(&sim), ["a", "b", "c"]);

        // The tail read a whole listing (a resumed session lists again): the head says nothing newer.
        let mut mapper = ClaudeMapper::default();
        let mut sim = Sim::default();
        feed(
            &mut sim,
            &mut mapper,
            &[listing(Some(&["d"]), None, Some(true))],
        );
        assert!(mapper.adopt_commands(head(&["a"])).is_empty());
        assert_eq!(names(&sim), ["d"]);

        // A subagent's transcript lists nothing: its head is never read.
        assert!(!ClaudeMapper::new(true).lists_commands_at_head());
    }
}

// What follows has no Dart test of its own: it pins behaviour of the Dart mapper that the Dart tests only
// reach through captured logs.
mod what_the_dart_mapper_does_beyond_its_tests {
    use super::*;

    #[test]
    fn a_write_over_an_existing_file_shows_the_old_text_from_the_result() {
        let file = "/home/dev/project/a.txt";
        let (sim, _) = run(&[
            call(
                "a1",
                "m1",
                0,
                "t1",
                "Write",
                json!({"file_path": file, "content": "new"}),
            ),
            result(
                "r1",
                "t1",
                json!("updated"),
                false,
                Some(json!({"type": "update", "filePath": file, "originalFile": "old"})),
            ),
        ]);
        let write = diffs(sim.tool_named("Write"));
        assert_eq!(write.len(), 1);
        assert_eq!(
            (write[0]["oldText"].as_str(), write[0]["newText"].as_str()),
            (Some("old"), Some("new"))
        );
    }

    #[test]
    fn a_multi_edit_is_one_diff_per_edit_and_a_relative_path_is_made_absolute_by_the_logs_cwd() {
        let (sim, _) = run(&[
            prompt("u1", "edit"),
            call(
                "a1",
                "m1",
                0,
                "t1",
                "MultiEdit",
                json!({"file_path": "./src/a.rs", "edits": [
                    {"old_string": "a", "new_string": "b"},
                    {"old_string": "c", "new_string": "d"},
                    {"old_string": "no new"},
                ]}),
            ),
        ]);
        let call = sim.tool_named("MultiEdit");
        let edits = diffs(call);
        assert_eq!(edits.len(), 2);
        assert_eq!(edits[0]["path"], "/home/dev/project/src/a.rs");
        assert_eq!(
            call["locations"],
            json!([{"path": "/home/dev/project/src/a.rs"}])
        );
        assert_eq!(call["kind"], "edit");
        assert_eq!(title_of(call), "MultiEdit: a.rs");
    }

    #[test]
    fn a_bash_result_shows_stdout_then_stderr_from_the_structured_result() {
        let (sim, _) = run(&[
            call("a1", "m1", 0, "t1", "Bash", json!({"command": "make"})),
            result(
                "r1",
                "t1",
                json!("combined"),
                false,
                Some(json!({"stdout": "built", "stderr": "warning: x"})),
            ),
        ]);
        assert_eq!(
            tool_text(sim.tool_named("Bash")),
            "built\nstderr:\nwarning: x"
        );
    }

    #[test]
    fn a_result_for_a_call_that_was_never_seen_names_the_call_itself() {
        let (sim, _) = run(&[result("r1", "t9", json!("late"), false, None)]);
        let call = &sim.tools()[0];
        assert_eq!(call["name"], "tool");
        assert_eq!(call["status"], "completed");
        assert_eq!(tool_text(call), "late");
    }

    #[test]
    fn titles_say_what_the_call_works_on() {
        let title = |name: &str, input: Value| {
            let (sim, _) = run(&[call("a1", "m1", 0, "t1", name, input)]);
            title_of(sim.tools()[0]).to_owned()
        };
        assert_eq!(
            title(
                "Bash",
                json!({"command": "ls -la\nmore", "description": "List files\nx"})
            ),
            "List files"
        );
        assert_eq!(title("Bash", json!({"command": "ls -la\nmore"})), "ls -la");
        assert_eq!(title("Bash", json!({})), "Bash");
        assert_eq!(
            title("mcp__github__list_issues", json!({})),
            "github: list_issues"
        );
        assert_eq!(
            title("Read", json!({"file_path": "/home/dev/project/src/lib.rs"})),
            "Read: lib.rs"
        );
        assert_eq!(
            title("Grep", json!({"pattern": "fn main"})),
            "Grep: fn main"
        );
        assert_eq!(
            title(
                "WebFetch",
                json!({"url": "https://Docs.Example.com:8443/a/b?c=1"})
            ),
            "WebFetch: docs.example.com"
        );
        assert_eq!(
            title("WebSearch", json!({"query": "rust let chains"})),
            "WebSearch: rust let chains"
        );
        assert_eq!(
            title(
                "TaskUpdate",
                json!({"taskId": "3", "status": "in_progress"})
            ),
            "Task #3: in progress"
        );
        assert_eq!(title("TaskUpdate", json!({})), "TaskUpdate");
        assert_eq!(title("Mystery", json!({})), "Mystery");
        assert_eq!(
            title(
                "AskUserQuestion",
                json!({"questions": [{"question": "Which one?\nplease"}]})
            ),
            "Which one?"
        );
    }

    #[test]
    fn a_task_update_to_deleted_removes_the_task_and_a_task_the_mapper_never_saw_changes_nothing() {
        let mut lines = vec![
            call("a1", "m1", 0, "c1", "TaskCreate", json!({"subject": "One"})),
            result(
                "r1",
                "c1",
                json!("ok"),
                false,
                Some(json!({"task": {"id": 1, "subject": "One"}})),
            ),
            call("a2", "m2", 0, "c2", "TaskCreate", json!({"subject": "Two"})),
            result(
                "r2",
                "c2",
                json!("ok"),
                false,
                Some(json!({"task": {"id": 2, "subject": "Two"}})),
            ),
            call(
                "a3",
                "m3",
                0,
                "u1",
                "TaskUpdate",
                json!({"taskId": 1, "status": "deleted"}),
            ),
            result("r3", "u1", json!("ok"), false, None),
            call(
                "a4",
                "m4",
                0,
                "u2",
                "TaskUpdate",
                json!({"taskId": 9, "status": "completed"}),
            ),
            result("r4", "u2", json!("ok"), false, None),
        ];
        let (sim, _) = run(&lines);
        assert_eq!(
            sim.plan
                .iter()
                .map(|s| s.content.as_str())
                .collect::<Vec<_>>(),
            ["Two"]
        );
        lines.truncate(4);
        let (sim, _) = run(&lines);
        assert_eq!(sim.plan.len(), 2);
    }

    #[test]
    fn a_user_prompt_after_a_tool_result_starts_a_new_turn() {
        let lines = bash_approve();
        let (_, mapper) = run(&lines);
        assert!(mapper.turn_ended());
        let mut more = lines;
        more.push(prompt("u9", "and again"));
        let (_, mapper) = run(&more);
        assert!(!mapper.turn_ended());
    }

    #[test]
    fn a_line_of_the_other_kind_of_log_is_skipped_before_its_cwd_is_learned() {
        // The cwd of a sidechain line is not the main log's cwd; a relative path stays relative until a
        // main line names it.
        let mut mapper = ClaudeMapper::default();
        let side = line(
            json!({"type": "user", "uuid": "s", "isSidechain": true, "cwd": "/elsewhere",
            "message": {"role": "user", "content": "x"}}),
        );
        assert!(mapper.map(&side).is_empty());
        // A main-log line that names no cwd.
        let read = line(json!({
            "type": "assistant", "uuid": "a1", "isSidechain": false,
            "message": {"id": "m1", "role": "assistant", "model": "claude-test-1", "stop_reason": "tool_use",
                "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "a.rs"}}]},
        }));
        let mut sim = Sim::default();
        feed(&mut sim, &mut mapper, &[read]);
        assert_eq!(sim.tools()[0]["locations"], json!([{"path": "a.rs"}]));
    }
}
