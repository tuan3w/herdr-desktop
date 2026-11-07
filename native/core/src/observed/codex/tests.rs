//! Port of herdr-mobile's `codex_log_mapper_test.dart`.
//!
//! The Dart tests read captured Codex 0.153.4 logs; those hold a person's session, so every log here is
//! built from synthetic lines that keep the structure and field names of the captured ones (the shapes of
//! the captures are described in the comments of each scenario). Dart applied the updates with the mobile
//! app's reducer; [`Chat`] below is the few lines of it these tests need: whole messages replace by id, a
//! tool-call start replaces, a patch lays its keys over the call (or over an empty call).

use serde_json::{Value, json};

use super::*;
use crate::observed::model::{Block, PictureRef};

const THREAD: &str = "00000000-0000-4000-8000-000000000001";

// -- the transcript -----------------------------------------------------------------

enum Item {
    Msg {
        role: Role,
        blocks: Vec<Block>,
        id: String,
    },
    Tool {
        id: String,
        call: Obj,
    },
}

#[derive(Default)]
struct Chat {
    items: Vec<Item>,
    title: Option<String>,
    plan: Vec<PlanStep>,
}

/// One tool call of the transcript.
struct Tool<'a> {
    id: &'a str,
    call: &'a Obj,
}

impl Tool<'_> {
    fn str(&self, k: &str) -> &str {
        self.call.get(k).and_then(Value::as_str).unwrap_or("")
    }
    fn title(&self) -> &str {
        self.str("title")
    }
    fn kind(&self) -> &str {
        self.call
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("other")
    }
    fn status(&self) -> &str {
        self.call
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending")
    }
    fn raw_input(&self, k: &str) -> Option<&Value> {
        self.call.get("rawInput")?.get(k)
    }
    fn content(&self) -> &[Value] {
        self.call
            .get("content")
            .and_then(Value::as_array)
            .map_or(&[], Vec::as_slice)
    }
    /// What the call printed: its text entries, joined.
    fn text(&self) -> String {
        self.content()
            .iter()
            .filter(|c| c["type"] == "content" && c["content"]["type"] == "text")
            .filter_map(|c| c["content"]["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
    /// `(oldText, newText)` of every diff.
    fn diffs(&self) -> Vec<(Option<&str>, &str)> {
        self.content()
            .iter()
            .filter(|c| c["type"] == "diff")
            .map(|c| {
                (
                    c.get("oldText").and_then(Value::as_str),
                    c["newText"].as_str().unwrap_or(""),
                )
            })
            .collect()
    }
}

impl Chat {
    fn apply(&mut self, u: Update) {
        match u {
            Update::Message { role, id, blocks } => {
                let new = Item::Msg {
                    role,
                    blocks,
                    id: id.clone(),
                };
                match self
                    .items
                    .iter_mut()
                    .find(|i| matches!(i, Item::Msg { id: m, .. } if *m == id))
                {
                    Some(slot) => *slot = new,
                    None => self.items.push(new),
                }
            }
            Update::ToolStart(call) => {
                let Value::Object(call) = call else {
                    panic!("a tool call is an object")
                };
                let id = call["toolCallId"].as_str().expect("toolCallId").to_owned();
                let new = Item::Tool {
                    id: id.clone(),
                    call,
                };
                match self.find_tool(&id) {
                    Some(slot) => *slot = new,
                    None => self.items.push(new),
                }
            }
            Update::ToolPatch(patch) => {
                let Value::Object(patch) = patch else {
                    panic!("a patch is an object")
                };
                let id = patch["toolCallId"].as_str().expect("toolCallId").to_owned();
                match self.find_tool(&id) {
                    Some(Item::Tool { call, .. }) => call.extend(patch),
                    _ => self.items.push(Item::Tool { id, call: patch }),
                }
            }
            Update::Plan(steps) => self.plan = steps,
            Update::Title(t) => self.title = t,
            Update::Commands(_) => {}
            Update::Cleared => self.items.clear(),
        }
    }

    fn find_tool(&mut self, id: &str) -> Option<&mut Item> {
        self.items
            .iter_mut()
            .find(|i| matches!(i, Item::Tool { id: t, .. } if t == id))
    }

    fn feed(&mut self, m: &mut CodexMapper, lines: &[String]) {
        for line in lines {
            for u in m.map(line) {
                self.apply(u);
            }
        }
    }

    fn texts(&self, want: Role) -> Vec<String> {
        self.messages(want)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| match b {
                        Block::Text(t) => Some(t.as_str()),
                        Block::Image(_) => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect()
    }

    fn messages(&self, want: Role) -> impl Iterator<Item = &Vec<Block>> {
        self.items.iter().filter_map(move |i| match i {
            Item::Msg { role, blocks, .. } if *role == want => Some(blocks),
            _ => None,
        })
    }

    fn tools(&self) -> Vec<Tool<'_>> {
        self.items
            .iter()
            .filter_map(|i| match i {
                Item::Tool { id, call } => Some(Tool { id, call }),
                Item::Msg { .. } => None,
            })
            .collect()
    }

    fn statuses(&self) -> Vec<(String, String)> {
        self.tools()
            .iter()
            .map(|t| (t.id.to_owned(), t.status().to_owned()))
            .collect()
    }
}

fn run(lines: &[String]) -> (Chat, CodexMapper) {
    let mut chat = Chat::default();
    let mut m = CodexMapper::default();
    chat.feed(&mut m, lines);
    (chat, m)
}

fn task_ids(m: &CodexMapper) -> Vec<(String, BackgroundStatus)> {
    m.background_tasks()
        .into_iter()
        .map(|t| (t.id, t.status))
        .collect()
}

// -- synthetic logs --------------------------------------------------------------------

/// One log line the way Codex writes it.
fn line(ordinal: i64, ty: &str, payload: Value) -> String {
    json!({"timestamp": "2026-01-01T00:00:00.000Z", "ordinal": ordinal, "type": ty, "payload": payload})
        .to_string()
}

/// A paginated Codex log under construction. Ordinals count from the `session_meta` at 0.
struct Log {
    lines: Vec<String>,
}

impl Log {
    fn new() -> Self {
        Self::with_meta(
            json!({"history_mode": "paginated", "id": THREAD, "cwd": "/home/dev/project"}),
        )
    }

    fn with_meta(meta: Value) -> Self {
        Self {
            lines: vec![line(0, "session_meta", meta)],
        }
    }

    fn push(&mut self, ty: &str, payload: Value) -> usize {
        self.lines.push(line(self.lines.len() as i64, ty, payload));
        self.lines.len() - 1
    }

    fn event(&mut self, payload: Value) -> usize {
        self.push("event_msg", payload)
    }

    fn response(&mut self, payload: Value) -> usize {
        self.push("response_item", payload)
    }

    fn item(&mut self, item: Value) -> usize {
        self.event(json!({"type": "item_completed", "thread_id": THREAD, "item": item}))
    }

    /// The lines Codex writes between the ones that matter and the mapper ignores.
    fn noise(&mut self) {
        self.event(json!({"type": "token_count", "info": null}));
        self.push("token_usage_record", json!({"usage": {"total_tokens": 10}}));
        self.push(
            "turn_context",
            json!({"cwd": "/home/dev/project", "model": "m"}),
        );
    }

    fn started(&mut self) {
        self.event(json!({"type": "task_started", "started_at": 1_700_000_000}));
    }

    fn complete(&mut self) {
        self.event(json!({"type": "task_complete", "last_agent_message": "x"}));
    }

    fn aborted(&mut self) -> usize {
        self.response(json!({
            "type": "message", "role": "developer",
            "content": [{"type": "input_text", "text": "<turn_aborted>\nThe turn was interrupted."}],
        }));
        self.event(json!({"type": "turn_aborted", "reason": "interrupted"}))
    }

    /// The person's message: its item and the `response_item` copy of it that is never mapped.
    fn user(&mut self, id: &str, text: &str) {
        self.response(json!({
            "type": "message", "role": "user", "content": [{"type": "input_text", "text": text}],
        }));
        self.item(json!({
            "type": "UserMessage", "id": id,
            "content": [{"type": "text", "text": text, "text_elements": []}],
        }));
    }

    fn agent(&mut self, id: &str, text: &str, phase: &str) {
        self.item(json!({
            "type": "Reasoning", "id": format!("rs-{id}"), "summary_text": [], "raw_content": [],
        }));
        self.item(json!({
            "type": "AgentMessage", "id": id, "phase": phase,
            "content": [{"type": "Text", "text": text}],
        }));
        self.response(json!({
            "type": "message", "role": "assistant", "phase": phase,
            "content": [{"type": "output_text", "text": text}],
        }));
    }

    /// The model's `exec` call: a script of JavaScript.
    fn exec(&mut self, call_id: &str, js: &str) -> usize {
        self.response(json!({
            "type": "custom_tool_call", "status": "completed", "call_id": call_id, "name": "exec", "input": js,
        }))
    }

    /// An `exec` script that runs one command.
    fn exec_cmd(&mut self, call_id: &str, cmd: &str) -> usize {
        let js = format!(
            "const r = await tools.exec_command({{\"cmd\":{},\"workdir\":\"/home/dev/project\"}});\ntext(JSON.stringify(r));",
            json!(cmd)
        );
        self.exec(call_id, &js)
    }

    /// The output of an `exec` call: a header part and the script's own output.
    fn output(&mut self, call_id: &str, header: &str, body: &str) -> usize {
        self.response(json!({
            "type": "custom_tool_call_output", "call_id": call_id,
            "output": [{"type": "input_text", "text": header}, {"type": "input_text", "text": body}],
        }))
    }

    /// The output of an `exec` call whose script is still running or was aborted: one plain string.
    fn output_text(&mut self, call_id: &str, text: &str) -> usize {
        self.response(json!({
            "type": "custom_tool_call_output", "call_id": call_id, "output": text,
        }))
    }

    /// The item of a command the script ran.
    fn command(
        &mut self,
        id: &str,
        process: Option<&str>,
        cmd: &str,
        status: &str,
        out: &str,
        exit: i64,
    ) -> usize {
        let mut item = json!({
            "type": "CommandExecution", "id": id,
            "command": ["/bin/zsh", "-lc", cmd],
            "cwd": "file:///home/dev/project",
            "source": "unified_exec_startup",
            "status": status, "stdout": out, "stderr": "",
            "aggregated_output": out, "exit_code": exit, "formatted_output": out,
        });
        if let Some(p) = process {
            item["process_id"] = json!(p);
        }
        self.item(item)
    }

    fn function_call(&mut self, call_id: &str, name: &str, args: &Value) -> usize {
        self.response(json!({
            "type": "function_call", "name": name, "call_id": call_id, "arguments": args.to_string(),
        }))
    }

    fn function_output(&mut self, call_id: &str, text: &str) -> usize {
        self.response(json!({"type": "function_call_output", "call_id": call_id, "output": text}))
    }
}

const COMPLETED: &str = "Script completed\nWall time 0.8 seconds\nOutput:\n";
const RUNNING_1: &str = "Script running with cell ID 1\nWall time 31.0 seconds\nOutput:\n";

fn result_json(exit: i64, output: &str) -> String {
    json!({"chunk_id": "a1b2c3", "wall_time_seconds": 0.1, "exit_code": exit, "output": output})
        .to_string()
}

/// Two turns of a conversation; the second is the one a person asked after the first answer.
fn plain() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "say hi in 5 words");
    l.noise();
    l.agent("a1", "Hi there, nice to meet.", "final_answer");
    l.complete();
    l.started();
    l.user("u2", "now say bye in 3 words");
    l.agent("a2", "Bye for now.", "final_answer");
    l.complete();
    l.lines
}

/// Two commands in two scripts, their items landing before the outputs, the first one failing.
fn command_fail() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "run two commands");
    l.agent("a1", "One at a time.", "commentary");
    l.exec_cmd("c1", "ls /no-such-dir");
    l.noise();
    l.command(
        "e1",
        Some("5001"),
        "ls /no-such-dir",
        "failed",
        "ls: /no-such-dir: No such file or directory\n",
        1,
    );
    l.output(
        "c1",
        COMPLETED,
        &result_json(1, "ls: /no-such-dir: No such file or directory\n"),
    );
    l.exec_cmd("c2", "cat hello.txt");
    l.command(
        "e2",
        Some("5002"),
        "cat hello.txt",
        "completed",
        "hello\nthere\n",
        0,
    );
    l.output("c2", COMPLETED, &result_json(0, "hello\nthere\n"));
    l.agent("a2", "The first failed.", "final_answer");
    l.complete();
    l.lines
}

/// One script that applies two patches: two `FileChange` items, one output.
fn patch() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "create hello.txt then change it");
    l.agent("a1", "Creating, then editing.", "commentary");
    let js = "const patch1 = \"*** Begin Patch\\n*** Add File: hello.txt\\n+hello\\n+world\\n*** End Patch\";\nconst r1 = await tools.apply_patch(patch1);\nconst r2 = await tools.apply_patch(patch2);";
    l.exec("c1", js);
    l.item(json!({
        "type": "FileChange", "id": "f1", "status": "completed",
        "changes": {"/home/dev/project/hello.txt": {"type": "add", "content": "hello\nworld\n"}},
        "stdout": "Success. Updated the following files:\nA hello.txt\n", "stderr": "",
    }));
    l.item(json!({
        "type": "FileChange", "id": "f2", "status": "completed",
        "changes": {"/home/dev/project/hello.txt": {
            "type": "update", "unified_diff": "@@ -1,2 +1,2 @@\n hello\n-world\n+there\n", "move_path": null,
        }},
        "stdout": "Success. Updated the following files:\nM hello.txt\n", "stderr": "",
    }));
    l.output("c1", COMPLETED, "{\"r1\":{},\"r2\":{}}");
    l.agent("a2", "Done.", "final_answer");
    l.complete();
    l.lines
}

/// A turn with a command, whose messages are also written as `response_item`s.
fn sandboxed() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "list the files");
    l.agent("a1", "Listing them.", "commentary");
    l.exec_cmd("c1", "ls");
    l.command("e1", Some("5003"), "ls", "completed", "hello.txt\n", 0);
    l.output("c1", COMPLETED, &result_json(0, "hello.txt\n"));
    l.agent("a2", "There is one file.", "final_answer");
    l.complete();
    l.lines
}

/// A `request_user_input` call: Codex answers it in the terminal.
fn ask_two() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "ask me two things");
    let args = json!({"questions": [
        {"id": "room", "header": "Room", "question": "Which room is the desk in?", "options": [
            {"label": "Office", "description": "the office"}, {"label": "Bedroom", "description": "the bedroom"}]},
        {"id": "side", "header": "Side", "question": "Which side?", "options": [
            {"label": "Left", "description": "left"}, {"label": "Right", "description": "right"}]},
    ]});
    l.function_call("q1", "request_user_input", &args);
    l.function_output("q1", "{\"answers\":{\"room\":{\"answers\":[\"Office\"]}}}");
    l.agent("a1", "The desk is in the office.", "final_answer");
    l.complete();
    l.lines
}

/// A `Plan` item.
fn plan_log() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "plan the desk");
    l.item(
        json!({"type": "Plan", "id": "p1", "text": "# Desk Plan\n\n1. Clear the desk\n2. Wipe it"}),
    );
    l.complete();
    l.lines
}

/// A compaction: the megabyte line and the item that says it happened.
fn compact() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "keep going");
    l.agent("a1", "Going.", "final_answer");
    l.complete();
    l.lines.push(
        r#"{"timestamp":"2026-01-01T00:00:00.000Z","ordinal":99,"type":"compacted","payload":{"message":"","replacement_history":[{"type":"message","text":"summary"}]}}"#
            .to_owned(),
    );
    l.item(json!({"type": "ContextCompaction", "id": "k1"}));
    l.lines
}

/// A message typed while a command runs lands inside the turn.
fn steer() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "run sleep 20 then say done");
    l.agent("a1", "Waiting for it.", "commentary");
    l.exec_cmd("c1", "sleep 20");
    l.command("e1", Some("3515"), "sleep 20", "completed", "", 0);
    l.output(
        "c1",
        "Script completed\nWall time 20.1 seconds\nOutput:\n",
        "",
    );
    l.user("u2", "Also add the word banana to your final reply.");
    l.agent("a2", "done banana", "final_answer");
    l.complete();
    l.lines
}

const CURL: &str = "curl -sI https://example.com | head -1";

/// A command that waits for an approval. Returns the log and the index of the line of the call: while Codex
/// waits, that line is the last one that matters.
fn command_approve() -> (Vec<String>, usize) {
    let mut l = Log::new();
    l.started();
    l.user("u1", "fetch the headers");
    l.agent("a1", "Fetching.", "commentary");
    let call = l.exec_cmd("c1", CURL);
    l.noise();
    // Approved: the script outlived the wait, so its output says it still runs; the command's item and the
    // `wait` that ends the cell follow.
    l.output_text("c1", RUNNING_1);
    l.command("e1", None, CURL, "completed", "HTTP/2 200 \n", 0);
    l.function_call(
        "w1",
        "wait",
        &json!({"cell_id": "1", "yield_time_ms": 5000}),
    );
    l.function_output("w1", "Script completed\nWall time 0.1 seconds\nOutput:\n");
    l.agent("a2", "It answered 200.", "final_answer");
    l.complete();
    (l.lines, call)
}

/// Esc after the command finished: its call is complete, the turn is aborted.
fn interrupt() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "run pwd");
    l.exec_cmd("c1", "pwd");
    l.command(
        "e1",
        Some("5004"),
        "pwd",
        "completed",
        "/home/dev/project\n",
        0,
    );
    l.output("c1", COMPLETED, &result_json(0, "/home/dev/project\n"));
    l.aborted();
    l.lines
}

/// Esc on an approval card: the call has no output and the turn is aborted.
fn command_decline() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "fetch the headers");
    l.exec_cmd("c1", CURL);
    l.noise();
    l.aborted();
    l.lines
}

/// A declined patch: the call says aborted, then the aborted `FileChange` is written after the turn.
fn patch_decline() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "create a file");
    l.exec(
        "c1",
        "const r = await tools.apply_patch(\"*** Begin Patch\\n*** Add File: hm.txt\\n+hi\\n*** End Patch\");",
    );
    l.output_text("c1", "aborted by user after 23.0s");
    l.noise();
    l.aborted();
    l.item(json!({
        "type": "FileChange", "id": "f1", "status": "failed",
        "changes": {"/home/dev/project/hm.txt": {"type": "add", "content": "hi\n"}},
        "stdout": "", "stderr": "execution error: TurnAborted",
    }));
    l.lines
}

const SLEEP40: &str = "sleep 40 && echo finished";

/// A command that outlives its script's wait: a unified-exec process named by `session_id`, polled by
/// `write_stdin`, whose own item arrives much later. Returns the log and the index of the first output.
fn yield_proc() -> (Vec<String>, usize) {
    let mut l = Log::new();
    l.started();
    l.user("u1", "run a slow command");
    l.agent("a1", "Starting it with a short wait.", "commentary");
    l.exec_cmd("c1", SLEEP40);
    let first = l.output(
        "c1",
        "Script completed\nWall time 5.2 seconds\nOutput:\n",
        &json!({"chunk_id": "94ca0c", "wall_time_seconds": 5.0, "session_id": 4242, "output": ""})
            .to_string(),
    );
    let poll = "const r = await tools.write_stdin({\"session_id\":4242,\"chars\":\"\",\"yield_time_ms\":30000});";
    l.exec("c2", poll);
    l.output(
        "c2",
        "Script completed\nWall time 30.0 seconds\nOutput:\n",
        &json!({"wall_time_seconds": 30.0, "session_id": 4242, "output": ""}).to_string(),
    );
    l.exec("c3", poll);
    l.command("e1", Some("4242"), SLEEP40, "completed", "finished\n", 0);
    l.output(
        "c3",
        "Script completed\nWall time 1.5 seconds\nOutput:\n",
        &json!({"wall_time_seconds": 1.4, "exit_code": 0, "output": "finished\n"}).to_string(),
    );
    l.agent("a2", "Finished.", "final_answer");
    l.complete();
    (l.lines, first)
}

const SLEEP25_JS: &str = "const a = await tools.exec_command({cmd:\"sleep 25\",yield_time_ms:30000});\nconst b = await tools.exec_command({cmd:\"echo two\"});";

/// A script that outlives its wait (a cell), polled once and then terminated; its command's item is
/// written again after the final answer. Returns the log and the index of the "still running" output.
fn yield_cell() -> (Vec<String>, usize) {
    let mut l = Log::new();
    l.started();
    l.user("u1", "run a slow script");
    l.agent("a1", "Running it.", "commentary");
    l.exec("c1", SLEEP25_JS);
    l.command("e1", Some("9001"), "sleep 25", "completed", "", 0);
    let running = l.output_text("c1", RUNNING_1);
    l.function_call(
        "w1",
        "wait",
        &json!({"cell_id": "1", "yield_time_ms": 5000}),
    );
    l.function_output("w1", RUNNING_1);
    l.function_call(
        "w2",
        "wait",
        &json!({"cell_id": "1", "yield_time_ms": 5000, "terminate": true}),
    );
    l.function_output("w2", "Script terminated\nWall time 0.0 seconds\nOutput:\n");
    l.agent("a2", "It was still running; I stopped it.", "final_answer");
    l.complete();
    l.command("e2", Some("9002"), "sleep 25", "completed", "", 0);
    (l.lines, running)
}

/// The parent spawns a subagent by thread id, waits for it, and answers.
fn subagent() -> Vec<String> {
    let mut l = Log::new();
    l.started();
    l.user("u1", "spawn a sub-agent to list the files");
    l.function_call(
        "s1",
        "spawn_agent",
        &json!({"task_name": "list_files", "message": "list them"}),
    );
    l.item(json!({
        "type": "SubAgentActivity", "id": "s1", "kind": "started",
        "agent_thread_id": THREAD, "agent_path": "/root/list_files",
    }));
    l.function_output("s1", "{\"task_name\":\"/root/list_files\"}");
    l.function_call("w1", "wait_agent", &json!({"timeout_ms": 10000}));
    l.item(json!({
        "type": "SubAgentActivity", "id": "subagent-completed-1", "kind": "completed",
        "agent_thread_id": THREAD, "agent_path": "/root/list_files",
    }));
    l.item(
        json!({"type": "CollabAgentToolCall", "id": "w1", "tool": "wait", "status": "completed"}),
    );
    l.function_output(
        "w1",
        "{\"message\":\"Wait completed.\",\"timed_out\":false}",
    );
    l.agent("a1", "The sub-agent found hello.txt.", "final_answer");
    l.complete();
    l.lines
}

/// A subagent's own log: it starts with a replay of the parent's turn (ordinals below
/// `subagent_history_start_ordinal`), then its own work.
fn subagent_child() -> Vec<String> {
    let mut l = Log::with_meta(json!({
        "history_mode": "paginated", "id": THREAD, "subagent_history_start_ordinal": 7,
    }));
    l.started();
    l.user("u1", "the parent's prompt");
    l.agent("a0", "the parent's reply", "commentary");
    assert_eq!(l.lines.len(), 7, "the replay ends where the child starts");
    l.started();
    l.agent("a1", "I will list the files.", "commentary");
    l.exec_cmd("c1", "ls -la");
    l.command("e1", Some("5005"), "ls -la", "completed", "hello.txt\n", 0);
    l.output("c1", COMPLETED, &result_json(0, "hello.txt\n"));
    l.agent("a2", "The directory holds hello.txt.", "final_answer");
    l.complete();
    l.lines
}

const PASTE_TEXT: &str = "[Image #1]  what colour is this picture?";

/// A pasted picture: Codex lists a `local_image` path only, next to its own `[Image #1]` placeholder.
fn image_paste() -> Vec<String> {
    let mut l = Log::new();
    for turn in 1..=2 {
        l.started();
        l.item(json!({
            "type": "UserMessage", "id": format!("u{turn}"),
            "content": [
                {"type": "text", "text": PASTE_TEXT, "text_elements": []},
                {"type": "local_image", "path": "/home/dev/project/paste.png"},
            ],
        }));
        l.agent(&format!("a{turn}"), "It is blue.", "final_answer");
        l.complete();
    }
    l.lines
}

/// Every log above that ends with nothing running.
fn finished_logs() -> Vec<(&'static str, Vec<String>)> {
    vec![
        ("plain", plain()),
        ("command-fail", command_fail()),
        ("patch", patch()),
        ("sandboxed", sandboxed()),
        ("ask-two", ask_two()),
        ("plan", plan_log()),
        ("compact", compact()),
        ("steer", steer()),
        ("command-approve", command_approve().0),
        ("interrupt", interrupt()),
        ("command-decline", command_decline()),
        ("patch-decline", patch_decline()),
        ("yield", yield_proc().0),
        ("yield-cell", yield_cell().0),
        ("subagent", subagent()),
        ("subagent-child", subagent_child()),
        ("image-paste", image_paste()),
    ]
}

// -- tests -------------------------------------------------------------------------------

#[test]
fn every_log_maps_and_a_second_pass_changes_nothing() {
    for (name, lines) in finished_logs() {
        // The same mapper and chat fed twice, as Dart did.
        let mut m = CodexMapper::default();
        let mut chat = Chat::default();
        chat.feed(&mut m, &lines);
        let before = (chat.items.len(), chat.statuses());
        chat.feed(&mut m, &lines);
        assert_eq!((chat.items.len(), chat.statuses()), before, "{name}");
        assert!(
            m.open_tool_calls().is_empty(),
            "{name} leaves nothing running"
        );
    }
}

mod a_turn {
    use super::*;

    #[test]
    fn has_the_persons_message_codexs_replies_once_and_the_first_message_as_the_title() {
        let (s, m) = run(&plain());

        assert_eq!(
            s.texts(Role::User),
            ["say hi in 5 words", "now say bye in 3 words"]
        );
        assert_eq!(s.texts(Role::Agent).len(), 2);
        assert_eq!(s.title.as_deref(), Some("say hi in 5 words"));
        assert!(m.turn_ended());
    }

    #[test]
    fn a_command_shows_as_its_real_command_with_its_output_and_exit_status() {
        let (s, _) = run(&command_fail());

        let tools = s.tools();
        let failed = tools
            .iter()
            .find(|c| c.title() == "ls /no-such-dir")
            .unwrap();
        let ok = tools.iter().find(|c| c.title() == "cat hello.txt").unwrap();
        assert_eq!((failed.kind(), failed.status()), ("execute", "failed"));
        assert!(failed.text().contains("No such file or directory"));
        assert_eq!(ok.status(), "completed");
        assert!(ok.text().contains("there"));
        assert_eq!(ok.raw_input("command"), Some(&json!("cat hello.txt")));
        assert_eq!(tools.len(), 2, "the items did not add rows of their own");
    }

    #[test]
    fn an_apply_patch_shows_each_file_change_as_its_old_and_new_text() {
        let (s, _) = run(&patch());

        let rows = s.tools();
        assert!(rows.iter().all(|c| c.kind() == "edit"));
        assert_eq!(rows.len(), 2, "one script, two patches: one row each");
        assert_eq!(rows[0].diffs(), [(None, "hello\nworld\n")]);
        assert_eq!(rows[1].diffs(), [(Some("hello\nworld"), "hello\nthere")]);
        assert_eq!(rows[0].title(), "Edited hello.txt");
    }

    #[test]
    fn the_response_item_copy_of_a_message_is_not_shown_twice() {
        let (s, _) = run(&sandboxed());
        assert_eq!(s.texts(Role::User).len(), 1);
        assert_eq!(s.texts(Role::Agent).len(), 2);
    }

    #[test]
    fn a_request_user_input_call_shows_its_question_and_stays_a_terminal_matter() {
        let (s, m) = run(&ask_two());

        assert_eq!(s.tools().len(), 1);
        assert_eq!(s.tools()[0].title(), "Which room is the desk in?");
        assert!(
            m.pending_ask().is_none(),
            "Codex answers its questions in the terminal"
        );
    }

    #[test]
    fn a_plan_shows_as_a_message() {
        let (s, _) = run(&plan_log());
        let agent = s.texts(Role::Agent);
        assert_eq!(agent.len(), 1);
        assert!(agent[0].starts_with("# Desk Plan"));
    }

    #[test]
    fn a_compaction_is_one_quiet_note() {
        let (s, _) = run(&compact());
        assert!(
            s.texts(Role::Agent)
                .contains(&"Earlier messages were summarised".to_owned())
        );
    }

    #[test]
    fn a_message_typed_while_a_command_runs_shows_once_inside_the_turn() {
        let (s, m) = run(&steer());
        assert_eq!(s.texts(Role::User).len(), 2);
        assert_eq!(
            s.texts(Role::Agent).last().map(String::as_str),
            Some("done banana")
        );
        assert!(m.turn_ended());
    }
}

mod while_it_waits_and_when_it_is_stopped {
    use super::*;

    #[test]
    fn a_command_that_waits_for_approval_is_on_the_screen_as_a_running_row() {
        let (lines, call) = command_approve();
        let (s, m) = run(&lines[..=call]);

        let tools = s.tools();
        assert_eq!(tools.len(), 1);
        let call = &tools[0];
        assert_eq!(call.status(), "in_progress");
        assert_eq!(call.title(), CURL);
        assert_eq!(
            call.raw_input("command"),
            Some(&json!(CURL)),
            "the approval card compares with it"
        );
        assert_eq!(m.open_tool_calls(), BTreeSet::from([call.id.to_owned()]));
        assert!(!m.turn_ended());
    }

    #[test]
    fn the_approved_command_finishes_output_completed_and_the_cell_it_waited_in_ends() {
        let (s, m) = run(&command_approve().0);

        assert_eq!(s.tools().len(), 1);
        assert_eq!(s.tools()[0].status(), "completed");
        assert!(s.tools()[0].text().contains("HTTP/2 200"));
        assert_eq!(
            task_ids(&m),
            [("cell1".to_owned(), BackgroundStatus::Finished)]
        );
    }

    #[test]
    fn esc_the_open_command_is_cancelled_the_turn_is_over_and_it_says_so() {
        for (name, lines) in [
            ("interrupt", interrupt()),
            ("command-decline", command_decline()),
        ] {
            let (s, m) = run(&lines);

            let want = if name == "interrupt" {
                "completed"
            } else {
                "cancelled"
            };
            assert_eq!(s.tools().len(), 1, "{name}");
            assert_eq!(s.tools()[0].status(), want, "{name}");
            assert!(
                s.texts(Role::Agent).contains(&"Interrupted".to_owned()),
                "{name}"
            );
            assert!(m.turn_ended(), "{name}");
        }
    }

    #[test]
    fn a_declined_patch_is_cancelled_and_leaves_no_failed_row_behind() {
        let (s, _) = run(&patch_decline());
        let statuses: Vec<_> = s.tools().iter().map(|c| c.status().to_owned()).collect();
        assert_eq!(statuses, ["cancelled"]);
    }
}

mod background_work {
    use super::*;

    #[test]
    fn a_command_that_outlived_its_script_is_a_running_task_until_its_item_arrives() {
        let (lines, first_output) = yield_proc();
        let (_, m) = run(&lines[..=first_output]);

        let tasks = m.background_tasks();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "proc4242");
        assert_eq!(tasks[0].status, BackgroundStatus::Running);
        assert_eq!(tasks[0].title, SLEEP40);
        assert_eq!(
            tasks[0].stop,
            StopRoute::None,
            "no model tool stops a unified-exec process"
        );

        let (s, m) = run(&lines);
        let first = &s.tools()[0];
        assert_eq!(
            first.title(),
            SLEEP40,
            "its late item went to the call that started it, not to a later poll"
        );
        assert!(first.text().contains("finished"));
        assert_eq!(
            task_ids(&m),
            [("proc4242".to_owned(), BackgroundStatus::Finished)]
        );
    }

    #[test]
    fn a_script_that_outlived_its_wait_is_a_cell_the_model_can_stop_terminating_ends_it() {
        let (lines, running_at) = yield_cell();
        let (s, m) = run(&lines[..=running_at]);

        let tasks = m.background_tasks();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].id, "cell1");
        assert_eq!(tasks[0].status, BackgroundStatus::Running);
        assert_eq!(tasks[0].stop, StopRoute::Message);
        assert_eq!(
            s.tools()[0].status(),
            "in_progress",
            "the call stays open while its cell runs"
        );
        assert!(
            m.open_tool_calls().is_empty(),
            "a cell is a task, not what an approval asks about"
        );

        let (s, m) = run(&lines);
        let tasks = m.background_tasks();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, BackgroundStatus::Stopped);
        assert_eq!(s.tools()[0].status(), "cancelled");
        assert!(m.open_tool_calls().is_empty());
    }
}

mod subagents {
    use super::*;

    #[test]
    fn the_parent_lists_the_subagent_with_the_thread_id_its_transcript_is_named_by() {
        let (_, m) = run(&subagent());

        let subs = m.subagents();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name, "list_files");
        assert_eq!(subs[0].status, "completed");
        assert_eq!(subs[0].log_id.as_deref(), Some(THREAD));
        assert_eq!(
            subs[0].call_id.as_deref(),
            Some("s1"),
            "the spawn call names it"
        );
        assert_eq!(subagent_log_id(&subs[0]), Some(THREAD));
    }

    #[test]
    fn a_subagents_own_log_starts_after_the_replay_of_its_parent() {
        let (s, _) = run(&subagent_child());

        assert!(
            s.texts(Role::User).is_empty(),
            "the parent's prompt is replayed history, not its own"
        );
        assert!(s.texts(Role::Agent).last().unwrap().contains("hello.txt"));
        assert!(s.tools().iter().any(|c| c.title() == "ls -la"));
    }
}

mod the_script_of_an_exec_call {
    use super::*;

    fn call(js: &str, ordinal: i64) -> String {
        line(
            ordinal,
            "response_item",
            json!({
                "type": "custom_tool_call", "status": "completed",
                "call_id": format!("c{ordinal}"), "name": "exec", "input": js,
            }),
        )
    }

    #[test]
    fn a_command_is_named_by_its_real_text_whether_the_model_quoted_the_keys_of_its_object_or_not()
    {
        // The first is a capture (a script of awaited commands: the first names the row); the others are
        // the other spellings of the same JavaScript object.
        let cases = [
            (
                "const a = await tools.exec_command({cmd:\"sleep 25\",yield_time_ms:30000});",
                "sleep 25",
            ),
            (
                "const r = await tools.exec_command({\"cmd\":\"ls -la\",\"workdir\":\"/w\"});",
                "ls -la",
            ),
            (
                "const r = await tools.exec_command({ cmd: 'echo \"hi\" && ls', workdir: '/w' });",
                "echo \"hi\" && ls",
            ),
        ];
        for (at, (js, want)) in (12..).zip(cases) {
            let (s, _) = run(&[call(js, at)]);
            let tools = s.tools();
            assert_eq!(tools.len(), 1, "{js}");
            assert_eq!(tools[0].title(), want, "{js}");
            assert_eq!(tools[0].raw_input("command"), Some(&json!(want)), "{js}");
            assert_eq!(tools[0].kind(), "execute", "{js}");
        }
    }

    #[test]
    fn a_single_quoted_workdir_and_a_quoted_one_are_both_the_rows_workdir() {
        let js = "tools.exec_command({ cmd: 'pwd', workdir: '/home/dev/project' })";
        let (s, _) = run(&[call(js, 12)]);
        assert_eq!(
            s.tools()[0].raw_input("workdir"),
            Some(&json!("/home/dev/project"))
        );
    }

    #[test]
    fn a_script_that_is_none_of_these_is_running_a_script_never_an_error() {
        let (s, _) = run(&[call("const x = 1 + 1; text(String(x));", 12)]);
        assert_eq!(s.tools().len(), 1);
        assert_eq!(s.tools()[0].title(), "Running a script");
    }
}

mod an_item_kind_nobody_has_mapped_yet {
    use super::*;

    fn item(it: Value, ordinal: i64) -> String {
        line(
            ordinal,
            "event_msg",
            json!({"type": "item_completed", "item": it}),
        )
    }

    #[test]
    fn is_shown_as_a_row_that_says_what_it_is_never_dropped() {
        let (s, _) = run(&[item(
            json!({"type": "BrandNewThing", "id": "x1", "detail": "d"}),
            5,
        )]);
        assert_eq!(s.tools().len(), 1);
        assert_eq!(s.tools()[0].title(), "BrandNewThing");
    }

    #[test]
    fn an_item_the_table_marks_as_ignored_stays_out() {
        let (s, _) = run(&[
            item(
                json!({"type": "Reasoning", "id": "r", "summary_text": []}),
                5,
            ),
            item(json!({"type": "Sleep", "id": "s"}), 6),
        ]);
        assert!(s.items.is_empty());
    }
}

mod what_a_command_item_says_is_not_overwritten_by_its_script {
    use super::*;

    #[test]
    fn a_failed_command_stays_failed_when_the_script_printed_nothing_about_its_exit() {
        let l = |o: i64, ty: &str, p: Value| line(o, ty, p);
        let (s, _) = run(&[
            l(
                1,
                "response_item",
                json!({
                    "type": "custom_tool_call", "call_id": "c1", "name": "exec",
                    "input": "const r = await tools.exec_command({cmd:\"ls /nope\"});\ntext(\"done\");",
                }),
            ),
            l(
                2,
                "event_msg",
                json!({"type": "item_completed", "item": {
                    "type": "CommandExecution", "id": "e1",
                    "command": ["/bin/zsh", "-lc", "ls /nope"],
                    "status": "failed", "exit_code": 1,
                    "aggregated_output": "ls: /nope: No such file",
                }}),
            ),
            l(
                3,
                "response_item",
                json!({
                    "type": "custom_tool_call_output", "call_id": "c1",
                    "output": [
                        {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                        {"type": "input_text", "text": "done"},
                    ],
                }),
            ),
        ]);
        assert_eq!(s.tools().len(), 1);
        assert_eq!(s.tools()[0].status(), "failed");
    }

    #[test]
    fn the_item_of_a_process_that_ended_after_the_final_answer_adds_no_stray_row() {
        let (s, _) = run(&yield_cell().0);
        assert_eq!(s.tools().len(), 1);
    }

    #[test]
    fn a_removed_line_that_starts_with_dashes_and_an_added_plus_plus_i_stay_in_the_diff() {
        let (s, _) = run(&[line(
            1,
            "event_msg",
            json!({"type": "item_completed", "item": {
                "type": "FileChange", "id": "f1", "status": "completed",
                "changes": {"/w/a.sql": {
                    "type": "update", "unified_diff": "@@ -1,2 +1,2 @@\n keep\n--- a comment\n+++i\n",
                }},
            }}),
        )]);
        assert_eq!(s.tools().len(), 1);
        assert_eq!(
            s.tools()[0].diffs(),
            [(Some("keep\n-- a comment"), "keep\n++i")]
        );
    }

    /// Not in Dart: the first file of a change names the row, so the order of the log line must survive
    /// `serde_json` (it keeps it only while the `acp` crate's `preserve_order` feature is on).
    #[test]
    fn the_files_of_one_change_keep_the_order_of_the_line() {
        let raw = r#"{"ordinal":1,"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"f1","status":"completed","changes":{"/w/zeta.txt":{"type":"add","content":"z"},"/w/alpha.txt":{"type":"add","content":"a"}}}}}"#;
        let (s, _) = run(&[raw.to_owned()]);
        assert_eq!(s.tools()[0].title(), "Edited zeta.txt and 1 more");
        assert_eq!(s.tools()[0].diffs(), [(None, "z"), (None, "a")]);
    }
}

mod robustness {
    use super::*;

    #[test]
    fn a_compacted_line_is_skipped_from_its_first_characters_without_decoding_it() {
        // Decoded, this line would be a user message (the later duplicate keys win): it maps to nothing
        // only because the first 160 characters said `compacted`.
        let trap = r#"{"ordinal":1,"type":"compacted","payload":{"type":"x"},"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":"u","content":[{"type":"text","text":"hi"}]}}}"#;
        let decoded: Value = serde_json::from_str(trap).unwrap();
        assert_eq!(decoded["type"], "event_msg");
        assert!(CodexMapper::default().map(trap).is_empty());

        let big = format!(
            r#"{{"timestamp":"2026-10-09T12:43:35.249Z","ordinal":23,"type":"compacted","payload":{{"message":"","replacement_history":[{{"type":"message","text":"{}"}}]}}}}"#,
            "x".repeat(1_200_000)
        );
        assert!(CodexMapper::default().map(&big).is_empty());
    }

    #[test]
    fn garbage_and_unknown_shapes_map_to_nothing() {
        let mut m = CodexMapper::default();
        for l in ["", "not json", "[]", r#"{"type":"event_msg"}"#] {
            assert!(m.map(l).is_empty(), "{l}");
        }
    }

    #[test]
    fn reset_forgets_everything() {
        // Mappers that each saw a log that leaves something behind. (One mapper cannot see two logs: a
        // line is mapped once by its ordinal.)
        let (_, tasks) = run(&yield_proc().0);
        let (_, subagents) = run(&subagent());
        let (_, ended) = run(&plain());
        assert!(!tasks.background_tasks().is_empty());
        assert!(!subagents.subagents().is_empty());
        assert!(ended.turn_ended());
        let (_, open) = run(&command_decline()[..5]);
        assert!(!open.open_tool_calls().is_empty());

        let mut all = [tasks, subagents, ended, open];
        for m in &mut all {
            m.reset();
            assert!(m.background_tasks().is_empty());
            assert!(m.open_tool_calls().is_empty());
            assert!(m.subagents().is_empty());
            assert!(!m.turn_ended());
        }
    }
}

// Hand-written in Dart too: this Codex writes only the paginated dialect, so these lines follow the
// documented legacy shape, not a capture.
mod the_legacy_dialect {
    use super::*;

    #[test]
    fn a_turn_maps_like_the_paginated_one_messages_a_command_joined_by_call_id_a_patch() {
        let line = |p: Value, ty: &str, o: i64| line(o, ty, p);
        let lines = [
            line(json!({"id": "t", "cwd": "/w"}), "session_meta", 0),
            line(
                json!({"type": "user_message", "message": "list files"}),
                "event_msg",
                1,
            ),
            line(
                json!({"type": "agent_message", "message": "on it", "phase": "commentary"}),
                "event_msg",
                2,
            ),
            line(
                json!({
                    "type": "function_call", "name": "exec_command",
                    "arguments": json!({"cmd": "ls -la", "workdir": "/w"}).to_string(), "call_id": "c1",
                }),
                "response_item",
                3,
            ),
            line(
                json!({
                    "type": "exec_command_end", "call_id": "c1", "command": ["ls"],
                    "aggregated_output": "a\nb\n", "exit_code": 0, "status": "completed",
                }),
                "event_msg",
                4,
            ),
            line(
                json!({
                    "type": "custom_tool_call", "name": "apply_patch",
                    "input": "*** Begin Patch\n*** End Patch", "call_id": "c2",
                }),
                "response_item",
                5,
            ),
            line(
                json!({"type": "patch_apply_end", "call_id": "c2", "success": false, "stdout": "", "changes": {}}),
                "event_msg",
                6,
            ),
        ];
        let (s, m) = run(&lines);

        assert_eq!(s.texts(Role::User), ["list files"]);
        assert_eq!(s.texts(Role::Agent), ["on it"]);
        let tools = s.tools();
        let ls = tools.iter().find(|t| t.id.ends_with("c1")).unwrap();
        assert_eq!(
            (ls.title(), ls.status(), ls.text().as_str()),
            ("ls -la", "completed", "a\nb\n")
        );
        let patch = tools.iter().find(|t| t.id.ends_with("c2")).unwrap();
        assert_eq!((patch.kind(), patch.status()), ("edit", "failed"));
        assert!(m.open_tool_calls().is_empty());
    }

    #[test]
    fn update_plan_becomes_the_plan() {
        let (s, _) = run(&[line(
            1,
            "response_item",
            json!({
                "type": "function_call", "name": "update_plan", "call_id": "p",
                "arguments": json!({"plan": [
                    {"step": "one", "status": "completed"},
                    {"step": "two", "status": "in_progress"},
                ]}).to_string(),
            }),
        )]);

        assert_eq!(
            s.plan,
            [
                PlanStep {
                    content: "one".into(),
                    status: PlanStatus::Completed
                },
                PlanStep {
                    content: "two".into(),
                    status: PlanStatus::InProgress
                },
            ]
        );
        assert!(
            s.tools().is_empty(),
            "the plan call shows as the plan, not as a row"
        );
    }
}

mod a_message_with_a_picture {
    use super::*;

    fn item(id: &str, content: Value) -> String {
        json!({
            "type": "event_msg",
            "payload": {"type": "item_completed", "item": {"type": "UserMessage", "id": id, "content": content}},
        })
        .to_string()
    }

    fn user_blocks(s: &Chat) -> Vec<&Vec<Block>> {
        s.messages(Role::User).collect()
    }

    #[test]
    fn the_captured_paste_shows_once_per_turn_with_codexs_own_placeholder() {
        let (s, _) = run(&image_paste());
        let texts = s.texts(Role::User);
        assert_eq!(texts, [PASTE_TEXT, PASTE_TEXT]);
        assert!(texts.iter().all(|t| !t.contains("[image]")));
    }

    #[test]
    fn a_picture_the_text_does_not_mark_gets_an_image_line_a_picture_alone_is_not_an_empty_message()
    {
        let (s, _) = run(&[
            item(
                "a",
                json!([
                    {"type": "text", "text": "what is this?"},
                    {"type": "local_image", "path": "/h/x.jpg"},
                ]),
            ),
            item(
                "b",
                json!([{"type": "image", "image_url": "data:image/png;base64,<trimmed>"}]),
            ),
        ]);
        assert_eq!(s.texts(Role::User), ["what is this?\n[image]", "[image]"]);
    }

    #[test]
    fn an_image_part_whose_url_is_the_hosts_note_with_a_reference_is_a_block_a_local_image_path_stays_a_line()
     {
        let (s, _) = run(&[
            item(
                "a",
                json!([
                    {"type": "text", "text": "look"},
                    {"type": "image", "image_url": "data:image/png;base64,[40000 bytes of data not sent; ref=512.0123456789abcdef]"},
                ]),
            ),
            item(
                "b",
                json!([{"type": "image", "image_url": "[40 bytes of data not sent; ref=9.fedcba9876543210]"}]),
            ),
            item("c", json!([{"type": "local_image", "path": "/h/x.jpg"}])),
        ]);
        let users = user_blocks(&s);
        assert_eq!(users.len(), 3);

        let images: Vec<_> = users[0]
            .iter()
            .filter_map(|b| match b {
                Block::Image(i) => Some(i),
                Block::Text(_) => None,
            })
            .collect();
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].mime, "image/png");
        assert!(matches!(
            images[0].source,
            PictureRef::Keeper { start: 512, .. }
        ));
        assert_eq!(s.texts(Role::User)[0], "look");

        assert!(
            matches!(users[1].as_slice(), [Block::Image(i)] if i.mime.is_empty()),
            "a picture alone is not an empty message"
        );
        assert_eq!(s.texts(Role::User)[2], "[image]");
    }

    #[test]
    fn the_captured_paste_lists_only_a_local_image_path_the_picture_stays_an_image_line() {
        let (s, _) = run(&image_paste());
        let images = user_blocks(&s)
            .iter()
            .flat_map(|blocks| blocks.iter())
            .filter(|b| matches!(b, Block::Image(_)))
            .count();
        assert_eq!(images, 0);
    }
}

// -- not in Dart's mapper tests ---------------------------------------------------------------

#[test]
fn a_user_message_that_only_says_the_turn_was_aborted_is_not_the_persons() {
    let mut l = Log::new();
    l.event(
        json!({"type": "user_message", "message": "<turn_aborted>\nThe turn was interrupted."}),
    );
    let (s, m) = run(&l.lines);
    assert!(s.items.is_empty());
    assert!(!m.turn_ended());
}

#[test]
fn stop_asks_codex_to_terminate_the_cells_by_number() {
    assert_eq!(
        stop_message(["cell1"]).as_deref(),
        Some(
            "Stop the running cell now: 1. Call wait with terminate true on each. Do nothing else."
        )
    );
    assert_eq!(
        stop_message(["cell1", "cell12"]).as_deref(),
        Some(
            "Stop the running cells now: 1, 12. Call wait with terminate true on each. Do nothing else."
        )
    );
}

#[test]
fn stop_names_nothing_it_was_not_given_or_cannot_say_safely() {
    assert_eq!(stop_message([]), None);
    assert_eq!(stop_message(["cell1", "a b"]), None);
    assert_eq!(stop_message(["cell1; rm -rf ~"]), None);
    assert_eq!(stop_message([""]), None);
    assert_eq!(stop_message(["x".repeat(65).as_str()]), None);
    assert!(stop_message(["x".repeat(64).as_str()]).is_some());
}

#[test]
fn a_subagent_runs_while_its_rollout_changes_and_is_finished_after() {
    assert!(subagent_running(Some(1_000), 1_000, 5_000));
    assert!(subagent_running(Some(1_000), 6_000, 5_000));
    assert!(!subagent_running(Some(1_000), 6_001, 5_000));
    assert!(!subagent_running(None, 1_000, 5_000));
}

#[test]
fn the_trait_object_is_a_working_mapper() {
    let mut m = new_mapper();
    let updates = m.map(&line(
        1,
        "event_msg",
        json!({"type": "item_completed", "item": {"type": "AgentMessage", "id": "a", "content": [{"type": "Text", "text": "hi"}]}}),
    ));
    assert_eq!(updates.len(), 1);
}
