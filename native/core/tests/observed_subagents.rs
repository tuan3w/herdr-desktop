//! A Claude Code chat's subagents end to end: the real keeper script (`follow`) reads a synthetic parent log in a home of
//! its own, with a `subagents/` folder beside it, and the parent's own mapper. What is under test: the roster with its
//! times and the background task a subagent runs as, a subagent's transcript found on disk (by the id the parent gave
//! it) and read with the sidechain mapper as a read-only chat, a transcript not written yet, the stop of a background
//! task as a message in the agent's words, and that subagent chats close with their parent.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use herdr_core::files::LocalFiles;
use herdr_core::observed::claude;
use herdr_core::observed::kinds::ObservedKind;
use herdr_core::observed::model::{LocateCtx, Location, Locator};
use herdr_core::observed::session::{ObservedConfig, PaneIo, PaneState};
use herdr_core::schema::{AgentInfo, AgentStatus};
use herdr_core::session::{
    HubConfig, ItemKind, KeeperHost, ObservedLink, Refusal, Role, SessionHub, SessionSnapshot,
};
use herdr_core::wire::{EventStream, Wire, WireError};
use parking_lot::Mutex;
use serde_json::{Value, json};

const T: Duration = Duration::from_secs(30);
const LOCAL: &str = "local";
const PANE: &str = "w1:p1";

fn eventually<R>(what: &str, mut condition: impl FnMut() -> Option<R>) -> R {
    let deadline = Instant::now() + T;
    loop {
        if let Some(found) = condition() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

// ---- the parent's kind: Claude Code's mapper, a log the test names ---------------------------------

static PARENT_LOG: Mutex<Option<String>> = Mutex::new(None);

struct ParentLocator;

impl Locator for ParentLocator {
    fn may_locate(&self, _: &AgentInfo) -> bool {
        true
    }
    fn locate(&self, _: &LocateCtx<'_>) -> Location {
        match PARENT_LOG.lock().clone() {
            Some(p) => Location::Located(p),
            None => Location::NotYet("no log yet".into()),
        }
    }
}

static PARENT_LOCATOR: ParentLocator = ParentLocator;
static CLAUDE: LazyLock<ObservedKind> = LazyLock::new(|| ObservedKind {
    id: "claude",
    label: "Claude Code",
    new_mapper: claude::new_mapper,
    locator: &PARENT_LOCATOR,
    ask: None,
    wakes_on_background: true,
    integration: None,
});

struct NoWire;

impl Wire for NoWire {
    fn request(&self, _: &str, _: Value, _: Duration) -> Result<Value, WireError> {
        Err(WireError::retryable("no herdr here"))
    }
    fn events(&self, _: &[Value]) -> Result<Box<dyn EventStream>, WireError> {
        Err(WireError::retryable("no herdr here"))
    }
}

/// A pane whose locating is the locator's own, over this computer's files (as the engine's pane does over the
/// machine's), and whose typing is recorded.
struct Pane {
    inputs: Mutex<Vec<String>>,
}

impl PaneIo for Pane {
    fn state(&self) -> PaneState {
        PaneState::Agent {
            status: AgentStatus::Working,
            cwd: Some("/home/dev/payments".into()),
            title: None,
        }
    }
    fn locate(&self, locator: &dyn Locator) -> Location {
        let agent = AgentInfo::default();
        locator.locate(&LocateCtx {
            agent: &agent,
            pane: None,
            files: &LocalFiles::new(),
            wire: &NoWire,
            home: None,
        })
    }
    fn read_screen(&self) -> Result<String, String> {
        Ok(String::new())
    }
    fn send_input(&self, text: &str, _: &[String]) -> Result<(), String> {
        self.inputs.lock().push(text.to_owned());
        Ok(())
    }
    fn send_keys(&self, _: &[String]) -> Result<(), String> {
        Ok(())
    }
    fn read_file(&self, _: &str, _: usize) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
}

// ---- the synthetic logs ----------------------------------------------------------------------------

const A: &str = "a0a0a0a0a0a0a0a01";
const B: &str = "b0b0b0b0b0b0b0b02";
const C: &str = "c0c0c0c0c0c0c0c03";

fn stamp(minute: u32) -> String {
    format!("2026-11-08T10:{minute:02}:00.000Z")
}

fn prompt(uuid: &str, text: &str) -> Value {
    json!({"type": "user", "uuid": uuid, "isSidechain": false, "timestamp": stamp(0),
        "origin": {"kind": "human"}, "message": {"role": "user", "content": text}})
}

fn call(uuid: &str, minute: u32, id: &str, name: &str, input: Value) -> Value {
    json!({"type": "assistant", "uuid": uuid, "isSidechain": false, "timestamp": stamp(minute), "apiBlockIndex": 0,
        "message": {"id": format!("m-{uuid}"), "role": "assistant", "model": "claude-test-1", "stop_reason": "tool_use",
            "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
}

fn result(uuid: &str, minute: u32, id: &str, is_error: bool, extra: Value) -> Value {
    json!({"type": "user", "uuid": uuid, "isSidechain": false, "timestamp": stamp(minute),
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": id, "content": "ok", "is_error": is_error}]},
        "toolUseResult": extra})
}

fn notice(uuid: &str, minute: u32, task: &str, status: &str) -> Value {
    json!({"type": "user", "uuid": uuid, "isSidechain": false, "timestamp": stamp(minute),
        "origin": {"kind": "task-notification"},
        "message": {"role": "user", "content": format!(
            "<task-notification>\n<task-id>{task}</task-id>\n<status>{status}</status>\n</task-notification>")}})
}

fn agent(description: &str, kind: &str, prompt: &str) -> Value {
    json!({"description": description, "subagent_type": kind, "prompt": prompt})
}

/// Three subagents (one in the background and still running, one finished, one failed) and five background tasks
/// (two shells running, one finished, one failed, a monitor running).
fn parent_log() -> Vec<Value> {
    vec![
        prompt("u1", "Harden the session handling."),
        call(
            "c1",
            1,
            "toolu_a",
            "Agent",
            agent(
                "Audit auth module",
                "general-purpose",
                "Audit the auth module for session fixation. Report in a table.",
            ),
        ),
        result(
            "r1",
            1,
            "toolu_a",
            false,
            json!({"isAsync": true, "status": "async_launched", "agentId": A}),
        ),
        call(
            "c2",
            2,
            "toolu_b",
            "Agent",
            agent("List migrations", "Explore", "List every migration."),
        ),
        result(
            "r2",
            7,
            "toolu_b",
            false,
            json!({"status": "completed", "agentId": B, "totalToolUseCount": 4}),
        ),
        call(
            "c3",
            3,
            "toolu_c",
            "Agent",
            agent(
                "Check schema drift",
                "general-purpose",
                "Compare the schema.",
            ),
        ),
        result(
            "r3",
            8,
            "toolu_c",
            true,
            json!({"status": "failed", "agentId": C}),
        ),
        call(
            "c4",
            4,
            "toolu_s1",
            "Bash",
            json!({"command": "cd /home/dev/payments && pnpm test --watch", "run_in_background": true}),
        ),
        result(
            "r4",
            4,
            "toolu_s1",
            false,
            json!({"backgroundTaskId": "bgwatch1"}),
        ),
        call(
            "c5",
            5,
            "toolu_s2",
            "Bash",
            json!({"command": "tail -f build.log", "run_in_background": true}),
        ),
        result(
            "r5",
            5,
            "toolu_s2",
            false,
            json!({"backgroundTaskId": "bgtail2"}),
        ),
        call(
            "c6",
            5,
            "toolu_s3",
            "Bash",
            json!({"command": "pnpm build", "run_in_background": true}),
        ),
        result(
            "r6",
            5,
            "toolu_s3",
            false,
            json!({"backgroundTaskId": "bgbuild3"}),
        ),
        call(
            "c7",
            6,
            "toolu_s4",
            "Bash",
            json!({"command": "pnpm lint", "run_in_background": true}),
        ),
        result(
            "r7",
            6,
            "toolu_s4",
            false,
            json!({"backgroundTaskId": "bglint4"}),
        ),
        call(
            "c8",
            6,
            "toolu_m",
            "Monitor",
            json!({"description": "Watch for errors"}),
        ),
        result("r8", 6, "toolu_m", false, json!({"taskId": "mon5"})),
        notice("n1", 9, "bgbuild3", "completed"),
        notice("n2", 9, "bglint4", "failed"),
    ]
}

fn side(lines: Vec<Value>) -> Vec<Value> {
    lines
        .into_iter()
        .map(|mut l| {
            l["isSidechain"] = json!(true);
            l
        })
        .collect()
}

fn audit_transcript() -> Vec<Value> {
    side(vec![
        json!({"type": "user", "uuid": "s1", "timestamp": stamp(1),
            "message": {"role": "user", "content": "Audit the auth module for session fixation. Report in a table."}}),
        json!({"type": "assistant", "uuid": "s2", "timestamp": stamp(2), "apiBlockIndex": 0,
            "message": {"id": "sm1", "role": "assistant", "model": "claude-test-1", "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "Two places issue a session id; one rotates it."}]}}),
    ])
}

fn write(path: &Path, lines: &[Value]) {
    std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    let mut f = std::fs::File::create(path).expect("create");
    for l in lines {
        writeln!(f, "{l}").expect("write");
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    folder: PathBuf,
    hub: SessionHub,
    pane: Arc<Pane>,
}

fn rig() -> Rig {
    let dir = tempfile::tempdir().expect("tempdir");
    let home = dir.path().join("home");
    let log =
        home.join(".claude/projects/-home-dev-payments/5a1d0000-0000-4000-8000-000000000001.jsonl");
    write(&log, &parent_log());
    let folder = home
        .join(".claude/projects/-home-dev-payments/5a1d0000-0000-4000-8000-000000000001/subagents");
    write(
        &folder.join(format!("agent-{A}.jsonl")),
        &audit_transcript(),
    );
    *PARENT_LOG.lock() = Some(log.display().to_string());
    let mut config = HubConfig::new(Arc::new(|| {}));
    config.observed = ObservedConfig {
        poll_every: Duration::from_millis(20),
        locate_every: Duration::from_millis(40),
        locate_max: Duration::from_millis(80),
        ..ObservedConfig::default()
    };
    let hub = SessionHub::new(config);
    hub.set_host(
        LOCAL,
        Arc::new(KeeperHost::local(&home).env("PATH", "/usr/bin:/bin")),
    );
    Rig {
        _dir: dir,
        folder,
        hub,
        pane: Arc::new(Pane {
            inputs: Mutex::new(Vec::new()),
        }),
    }
}

fn texts(s: &SessionSnapshot, role: Role) -> Vec<String> {
    s.items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Message { role: r, text, .. } if *r == role => Some(text.clone()),
            _ => None,
        })
        .collect()
}

/// One test, because the parent log's path is a static of this file: the steps run in order on one rig.
#[test]
fn subagents_have_their_times_their_own_read_only_transcripts_and_close_with_the_parent() {
    let rig = rig();
    let parent = rig
        .hub
        .observe(LOCAL, PANE, &CLAUDE, rig.pane.clone())
        .expect("observe");
    let info = eventually("the roster", || {
        let s = parent.snapshot();
        let o = s.observed.clone()?;
        (o.subagents.len() == 3 && o.background.len() == 6).then_some(o)
    });

    // The roster, in the log's order, with the times the log gives and nothing else.
    let by = |name: &str| {
        info.subagents
            .iter()
            .find(|s| s.name == name)
            .expect(name)
            .clone()
    };
    let audit = by("Audit auth module");
    assert_eq!(audit.status, "running");
    assert!(audit.started_ms.is_some());
    assert_eq!(audit.ended_ms, None);
    assert_eq!(audit.task.as_deref(), Some(format!("0/{A}").as_str()));
    let listed = by("List migrations");
    assert_eq!(listed.status, "completed");
    assert!(listed.ended_ms > listed.started_ms);
    assert_eq!(by("Check schema drift").status, "failed");

    // Background tasks carry their times; only a running one with a way to stop it is stoppable.
    let task = |id: &str| {
        info.background
            .iter()
            .find(|b| b.id == id)
            .expect(id)
            .clone()
    };
    assert!(task("bgwatch1").stoppable && task("bgwatch1").started_ms.is_some());
    assert_eq!(task("bgbuild3").status, "finished");
    assert!(task("bgbuild3").ended_ms.is_some() && !task("bgbuild3").stoppable);
    assert_eq!(task("bglint4").status, "failed");
    assert!(task("mon5").active);

    // A subagent's transcript is its own: the sidechain lines, read-only, titled by its name.
    let sub = parent
        .open_subagent("Audit auth module")
        .expect("open the subagent");
    assert!(sub.is_subagent());
    let s = eventually("the subagent's transcript", || {
        let s = sub.snapshot();
        (texts(&s, Role::Agent).len() == 1).then_some(s)
    });
    assert_eq!(
        texts(&s, Role::User),
        ["Audit the auth module for session fixation. Report in a table."]
    );
    assert_eq!(
        texts(&s, Role::Agent),
        ["Two places issue a session id; one rotates it."]
    );
    assert_eq!(s.title.as_deref(), Some("Audit auth module"));
    assert!(matches!(sub.send("hello"), Err(Refusal::Blocked(_))));
    assert!(matches!(sub.stop(), Err(Refusal::Blocked(_))));
    assert!(matches!(
        sub.stop_background("0/bgwatch1"),
        Err(Refusal::Blocked(_))
    ));
    assert!(
        rig.pane.inputs.lock().is_empty(),
        "nothing was typed for the subagent"
    );
    // Opening it again is the same chat.
    assert!(parent.subagent("Audit auth module").is_some());

    // A transcript not written yet waits, quietly; it arrives when the subagent writes it.
    let drift = parent
        .open_subagent("Check schema drift")
        .expect("open the second");
    eventually("waiting for the transcript", || {
        matches!(
            drift.snapshot().observed.as_ref()?.link,
            ObservedLink::Locating(_)
        )
        .then_some(())
    });
    write(
        &rig.folder.join(format!("agent-{C}.jsonl")),
        &side(vec![json!({"type": "user", "uuid": "d1",
            "message": {"role": "user", "content": "Compare the schema."}})]),
    );
    eventually("the late transcript", || {
        (texts(&drift.snapshot(), Role::User) == ["Compare the schema."]).then_some(())
    });

    // A name the log does not give is refused, never made into a path.
    assert!(parent.open_subagent("../../etc/passwd").is_err());

    // The stop of a background task is a message in the agent's words, typed as the person would.
    parent.stop_background("0/bgwatch1").expect("stop");
    let typed = rig.pane.inputs.lock().clone();
    assert_eq!(typed.len(), 1);
    assert!(
        typed[0].contains("bgwatch1") && typed[0].contains("TaskStop"),
        "{typed:?}"
    );
    assert!(matches!(
        parent.stop_background("0/bgbuild3"),
        Err(Refusal::NothingWaiting)
    ));

    // Closing one closes it; closing the parent closes the rest.
    parent.close_subagent("Check schema drift");
    assert!(parent.subagent("Check schema drift").is_none());
    assert!(!drift.is_open());
    rig.hub.stop_observing(LOCAL, PANE);
    assert!(!sub.is_open());
}
