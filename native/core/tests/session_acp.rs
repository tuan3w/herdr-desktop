//! What the ACP specification asks of a client, one behaviour per test, against this repository's scripted
//! agent (`tests/support/fake_acp_agent.py`) behind the real keeper script. `docs/ACP.md` names each test
//! next to the row it backs: a feature is `full` only when one of these (or a reducer test beside the
//! code) makes the agent do it and looks at what the person would see.
//!
//! Hermetic like `tests/session.rs`: every test has a home and a `PATH` of its own, no real agent is ever
//! started, and the keepers a test starts are ended by the rig when it ends.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use herdr_core::session::{
    AcpInfo, HubConfig, ItemKind, KeeperHost, PartKind, Refusal, Role, SendOutcome, SessionHandle,
    SessionHub, SessionPhase, SessionSnapshot, ToolStatus, ToolView,
};

const T: Duration = Duration::from_secs(40);
const LOCAL: &str = "local";

fn find_in_path(name: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| panic!("{name} is not installed"))
}

fn fake_agent() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake_acp_agent.py")
}

/// Polls until the condition holds; a test never sleeps a fixed time.
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

/// A home, a bin folder holding a scripted `omp`, a folder to run in, and the agent's log.
struct Rig {
    dir: tempfile::TempDir,
    home: PathBuf,
    work: PathBuf,
    log: PathBuf,
    hosts: parking_lot::Mutex<Vec<Arc<KeeperHost>>>,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("home");
        let bin = dir.path().join("bin");
        let work = dir.path().join("work");
        for d in [&home, &bin, &work] {
            std::fs::create_dir_all(d).expect("mkdir");
        }
        let omp = bin.join("omp");
        std::fs::write(
            &omp,
            format!("#!/bin/sh\nexec python3 {}\n", fake_agent().display()),
        )
        .expect("write");
        std::fs::set_permissions(&omp, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        for tool in ["python3", "base64", "sh"] {
            std::os::unix::fs::symlink(find_in_path(tool), bin.join(tool)).expect("link");
        }
        let log = dir.path().join("agent.log");
        Self {
            dir,
            home,
            work,
            log,
            hosts: parking_lot::Mutex::new(Vec::new()),
        }
    }

    fn cwd(&self) -> String {
        self.work.display().to_string()
    }

    /// A hub whose local keeper runs the scripted agent with `env` (a `FAKE_ACP_*` setting each).
    fn hub(&self, env: &[(&str, &str)]) -> SessionHub {
        let path = format!("{}:/usr/bin:/bin", self.dir.path().join("bin").display());
        let mut host = KeeperHost::local(&self.home)
            .env("PATH", path)
            .env("FAKE_ACP_LOG", self.log.display().to_string());
        for (k, v) in env {
            host = host.env(*k, *v);
        }
        let host = Arc::new(host);
        self.hosts.lock().push(host.clone());
        let hub = SessionHub::new(HubConfig::new(Arc::new(|| {})));
        hub.set_host(LOCAL, host);
        hub
    }

    /// What reached the agent: every JSON-RPC message, in order.
    fn received(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .filter_map(|v| v.get("recv").cloned())
            .collect()
    }

    /// The `clientCapabilities` the agent was told in `initialize`.
    fn client_caps(&self) -> serde_json::Value {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
            .find_map(|v| v.get("client_caps").cloned())
            .expect("the agent was initialized")
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        for host in self.hosts.lock().iter() {
            if let Ok(all) = host.list_if_installed() {
                for keeper in all {
                    let _ = host.kill(&keeper.id);
                }
            }
        }
    }
}

fn open(rig: &Rig, hub: &SessionHub) -> SessionHandle {
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    session
}

fn wait_idle(handle: &SessionHandle) -> Arc<SessionSnapshot> {
    eventually("the session to open and rest", || {
        let s = handle.snapshot();
        (s.phase == SessionPhase::Idle).then_some(s)
    })
}

/// Sends `text` and waits for the turn to end.
fn turn(session: &SessionHandle, text: &str, files: &[String]) -> Arc<SessionSnapshot> {
    assert_eq!(session.send(text, files), Ok(SendOutcome::Sent));
    eventually(&format!("the turn `{text}` to end"), || {
        let s = session.snapshot();
        let ended = s
            .items
            .iter()
            .any(|i| matches!(i.kind, ItemKind::Done { .. }));
        if !ended && std::env::var_os("ACP_DEBUG").is_some() {
            eprintln!("{:?} running={} items={:#?}", s.phase, s.running, s.items);
        }
        (ended && s.phase == SessionPhase::Idle).then_some(s)
    })
}

fn tools(s: &SessionSnapshot) -> Vec<ToolView> {
    s.items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Tool(t) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

fn agent_text(s: &SessionSnapshot) -> Vec<String> {
    s.items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Message {
                role: Role::Agent,
                text,
                ..
            } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn notes(s: &SessionSnapshot) -> Vec<String> {
    s.items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Note(t) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

fn option<'a>(s: &'a SessionSnapshot, id: &str) -> &'a herdr_core::session::SessionOption {
    s.options
        .iter()
        .find(|o| o.id == id)
        .unwrap_or_else(|| panic!("no option {id}: {:?}", s.options))
}

// ---- initialize ---------------------------------------------------------------------------------

#[test]
fn the_keeper_tells_the_agent_what_this_client_can_do_and_what_it_cannot() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    open(&rig, &hub);
    let caps = rig.client_caps();
    // Not offered, on purpose (docs/ACP.md, "Files and terminals"): the agent runs on the keeper's machine
    // and has its own files and shell.
    assert_eq!(caps["fs"]["readTextFile"], false);
    assert_eq!(caps["fs"]["writeTextFile"], false);
    assert_eq!(caps["terminal"], false);
    // Offered, because the desktop shows them.
    assert!(caps["elicitation"]["form"].is_object(), "{caps}");
    assert!(caps["elicitation"].get("url").is_none(), "{caps}");
    assert!(caps["session"]["configOptions"]["boolean"].is_object());
    assert!(caps["session"]["notices"].is_object());
    assert!(caps["session"]["compaction"].is_object());
}

#[test]
fn what_the_agent_says_about_itself_reaches_the_screen() {
    let rig = Rig::new();
    let extra = r#"{"promptCapabilities": {"audio": true, "embeddedContext": true},
        "sessionCapabilities": {"resume": {}, "list": {}, "close": {}}, "auth": {"logout": {}}}"#;
    let hub = rig.hub(&[("FAKE_ACP_EXTRA_CAPS", extra)]);
    let s = open(&rig, &hub).snapshot();
    let a = &s.acp;
    assert_eq!(a.agent_name.as_deref(), Some("fake-acp"));
    assert_eq!(a.agent_title.as_deref(), Some("Fake ACP"));
    assert_eq!(a.agent_version.as_deref(), Some("1"));
    assert!(a.can_resume && a.can_list && a.can_close && a.can_logout);
    assert!(a.accepts_audio && a.accepts_embedded);
    assert!(s.accepts_pictures);
    // The plain agent claims none of it.
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let plain = open(&rig, &hub).snapshot();
    assert_eq!(
        (
            plain.acp.can_resume,
            plain.acp.accepts_audio,
            plain.acp.can_logout
        ),
        (false, false, false)
    );
}

// ---- authentication -----------------------------------------------------------------------------

#[test]
fn an_agent_that_wants_a_sign_in_is_signed_in_to_and_the_session_opens() {
    let rig = Rig::new();
    let hub = rig.hub(&[("FAKE_ACP_AUTH", "agent")]);
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    let s = eventually("the sign-in to be asked for", || {
        let s = session.snapshot();
        (s.phase == SessionPhase::AuthRequired).then_some(s)
    });
    assert_eq!(s.acp.auth.len(), 1);
    assert_eq!(s.acp.auth[0].id, "login");
    assert_eq!(s.acp.auth[0].terminal_args, None);
    // A method the agent never offered is not sent.
    assert_eq!(session.authenticate("other"), Err(Refusal::NoSuchOption));

    session.authenticate("login").expect("signed in");
    let open = wait_idle(&session);
    assert!(
        notes(&open).iter().any(|n| n == "Signed in: Log in"),
        "{:?}",
        notes(&open)
    );
    assert!(open.acp.auth.is_empty());
    // And the conversation works.
    turn(&session, "plain", &[]);
}

#[test]
fn a_sign_in_done_in_a_terminal_is_told_how_and_then_tried_again() {
    let rig = Rig::new();
    let marker = rig.dir.path().join("signed-in");
    let hub = rig.hub(&[
        ("FAKE_ACP_AUTH", "terminal"),
        ("FAKE_ACP_AUTH_FILE", &marker.display().to_string()),
    ]);
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    let s = eventually("the sign-in to be asked for", || {
        let s = session.snapshot();
        (s.phase == SessionPhase::AuthRequired).then_some(s)
    });
    assert_eq!(
        s.acp.auth[0].terminal_args.as_deref(),
        Some(&["--login".to_owned()][..])
    );
    // The app cannot do it for the person: it says what to run and sends nothing.
    match session.authenticate("term") {
        Err(Refusal::Invalid(why)) => assert!(why.contains("--login"), "{why}"),
        other => panic!("{other:?}"),
    }
    assert!(!rig.received().iter().any(|m| m["method"] == "authenticate"));
    std::fs::write(&marker, "ok").expect("sign in");
    session.reopen().expect("try again");
    wait_idle(&session);
}

// ---- sessions: load, resume ---------------------------------------------------------------------

#[test]
fn an_agent_that_only_resumes_reopens_an_old_session_and_says_the_replay_is_missing() {
    let rig = Rig::new();
    let store = rig.dir.path().join("store.json");
    std::fs::write(
        &store,
        serde_json::json!({"sessions": [{
            "sessionId": "old-1", "cwd": rig.cwd(), "title": "Yesterday", "updatedAt": "2026-11-06T10:00:00Z",
            "updates": [{"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "earlier answer"}}]
        }]})
        .to_string(),
    )
    .expect("store");
    let hub = rig.hub(&[
        ("FAKE_ACP_STORE", &store.display().to_string()),
        ("FAKE_ACP_CAPS", "list,resume"),
        (
            "FAKE_ACP_EXTRA_CAPS",
            r#"{"sessionCapabilities": {"resume": {}}}"#,
        ),
    ]);
    let past = hub
        .history(LOCAL, "omp", Some(&rig.cwd()))
        .expect("history");
    assert!(past.can_resume && !past.can_load);
    let session = hub
        .resume(LOCAL, "omp", &rig.cwd(), "old-1")
        .expect("resume");
    let s = wait_idle(&session);
    // `session/load` was refused, `session/resume` took it, and nothing was replayed.
    let methods: Vec<String> = rig
        .received()
        .iter()
        .filter_map(|m| m["method"].as_str().map(str::to_owned))
        .collect();
    assert!(methods.iter().any(|m| m == "session/load"), "{methods:?}");
    assert!(methods.iter().any(|m| m == "session/resume"), "{methods:?}");
    assert!(agent_text(&s).is_empty());
    assert!(
        notes(&s)
            .iter()
            .any(|n| n == "The agent reopened the session without its earlier messages"),
        "{:?}",
        notes(&s)
    );
    turn(&session, "plain", &[]);
}

#[test]
fn an_agent_that_loads_replays_a_past_session_and_a_seed_in_the_environment_makes_one() {
    let rig = Rig::new();
    let seed = serde_json::json!([{
        "sessionId": "old-1", "cwd": rig.cwd(), "title": "Seeded", "updatedAt": "2026-11-06T10:00:00Z",
        "updates": [
            {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "earlier question"}},
            {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "earlier answer"}}
        ]
    }])
    .to_string();
    let hub = rig.hub(&[("FAKE_ACP_SEED", &seed)]);
    let past = hub
        .history(LOCAL, "omp", Some(&rig.cwd()))
        .expect("history");
    assert!(past.can_load && past.can_list && past.can_resume);
    assert_eq!(past.sessions[0].title.as_deref(), Some("Seeded"));
    let session = hub
        .resume(LOCAL, "omp", &rig.cwd(), "old-1")
        .expect("resume");
    // The agent can load, so `session/load` replays the conversation and `session/resume` is not used.
    let s = eventually("the replay", || {
        let s = session.snapshot();
        (s.phase == SessionPhase::Idle && !agent_text(&s).is_empty()).then_some(s)
    });
    assert_eq!(agent_text(&s), ["earlier answer"]);
    assert!(
        !rig.received()
            .iter()
            .any(|m| m["method"] == "session/resume")
    );
}

// ---- config options and modes -------------------------------------------------------------------

#[test]
fn a_select_and_a_boolean_option_are_changed_with_set_config_option() {
    let rig = Rig::new();
    let hub = rig.hub(&[("FAKE_ACP_OPTIONS", "config")]);
    let session = open(&rig, &hub);
    let s = session.snapshot();
    let flag = option(&s, "flag");
    assert!(flag.boolean);
    assert_eq!(flag.current.as_deref(), Some("false"));
    assert_eq!(
        flag.description.as_deref(),
        Some("Let the agent search the web")
    );
    let names: Vec<_> = flag.choices.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["On", "Off"]);
    assert_eq!(
        option(&s, "thought_level").category.as_deref(),
        Some("thought_level")
    );

    session.set_option("flag", "true").expect("flag on");
    session.set_option("model", "deep").expect("model");
    let s = eventually("both choices to show", || {
        let s = session.snapshot();
        (option(&s, "flag").current.as_deref() == Some("true")
            && option(&s, "model").current.as_deref() == Some("deep"))
        .then_some(s)
    });
    assert!(
        notes(&s).iter().any(|n| n == "Web search: On"),
        "{:?}",
        notes(&s)
    );
    // A value the option does not have is not sent.
    assert_eq!(
        session.set_option("flag", "maybe"),
        Err(Refusal::NoSuchOption)
    );
    assert_eq!(
        session.set_option("model", "nope"),
        Err(Refusal::NoSuchOption)
    );

    // What went over the wire: a boolean carries its type and a real boolean.
    let set: Vec<_> = rig
        .received()
        .into_iter()
        .filter(|m| m["method"] == "session/set_config_option")
        .map(|m| m["params"].clone())
        .collect();
    assert!(
        set.iter()
            .any(|p| p["configId"] == "flag" && p["type"] == "boolean" && p["value"] == true),
        "{set:?}"
    );
    assert!(
        set.iter()
            .any(|p| p["configId"] == "model" && p["value"] == "deep" && p.get("type").is_none()),
        "{set:?}"
    );

    // The agent may change an option itself (`config_option_update`); the screen follows.
    let (_, _) = (turn(&session, "config", &[]), ());
    assert_eq!(
        option(&session.snapshot(), "flag").current.as_deref(),
        Some("true")
    );
}

#[test]
fn an_agent_that_reports_only_modes_still_gets_a_mode_picker_and_follows_its_changes() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let s = session.snapshot();
    let mode = option(&s, "mode");
    assert_eq!(mode.category.as_deref(), Some("mode"));
    assert_eq!(mode.current.as_deref(), Some("default"));
    let values: Vec<_> = mode.choices.iter().map(|c| c.value.as_str()).collect();
    assert_eq!(values, ["default", "plan"]);

    session.set_option("mode", "plan").expect("mode");
    eventually("the mode to change", || {
        (option(&session.snapshot(), "mode").current.as_deref() == Some("plan")).then_some(())
    });
    let sent: Vec<_> = rig
        .received()
        .into_iter()
        .filter(|m| m["method"] == "session/set_mode")
        .collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["params"]["modeId"], "plan");
    assert!(
        !rig.received()
            .iter()
            .any(|m| m["method"] == "session/set_config_option"),
        "the older shape is changed with session/set_mode only"
    );

    // The agent changing its own mode moves the picker too (`current_mode_update`).
    turn(&session, "mode:default", &[]);
    assert_eq!(
        option(&session.snapshot(), "mode").current.as_deref(),
        Some("default")
    );
}

// ---- what the agent shows -----------------------------------------------------------------------

#[test]
fn a_command_whose_output_only_comes_in_meta_shows_in_its_tool_row() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let s = turn(&session, "terminal:3", &[]);
    let t = &tools(&s)[0];
    assert!(t.terminal);
    assert_eq!(t.subject.as_deref(), Some("seq 3"));
    assert_eq!(t.head, ["1", "2", "3"]);
    assert_eq!(t.exit_code, Some(0));
    assert_eq!(t.cwd.as_deref(), Some("/work"));
    assert_eq!(t.status, ToolStatus::Completed);
    assert_eq!(agent_text(&s), ["ok"]);
}

#[test]
fn a_failed_command_shows_its_exit_code_and_what_it_printed() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let s = turn(&session, "termfail", &[]);
    let t = &tools(&s)[0];
    assert_eq!(t.status, ToolStatus::Failed);
    assert_eq!(t.exit_code, Some(2));
    assert_eq!(t.head, ["boom"]);
}

#[test]
fn a_tool_row_has_its_name_files_input_raw_result_and_pictures() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let s = turn(&session, "rawout", &[]);
    let t = &tools(&s)[0];
    assert_eq!(t.name.as_deref(), Some("WebFetch"));
    assert_eq!(t.kind.as_deref(), Some("fetch"));
    assert_eq!(t.locations.len(), 1);
    assert_eq!(t.locations[0].path, "/work/page.html");
    assert_eq!(t.locations[0].line, Some(7));
    let input = t.input.as_deref().expect("the input");
    assert!(input.contains("https://example.com"), "{input}");
    // The result came only in `rawOutput`.
    assert_eq!(t.head, ["first", "second"]);
    let kinds: Vec<_> = t.parts.iter().map(|p| p.kind).collect();
    assert_eq!(kinds, [PartKind::Image, PartKind::File]);
    assert_eq!(t.parts[0].mime.as_deref(), Some("image/png"));
    assert_eq!(t.parts[0].data.as_deref(), Some("QUJD"));
    assert_eq!(t.parts[1].name, "page.html");
}

#[test]
fn every_kind_of_content_block_in_a_message_is_kept_beside_its_text() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let s = turn(&session, "parts", &[]);
    let message = s
        .items
        .iter()
        .find_map(|i| match &i.kind {
            ItemKind::Message {
                role: Role::Agent,
                message_id: Some(id),
                text,
                parts,
                ..
            } if id == "p1" => Some((text.clone(), parts.clone())),
            _ => None,
        })
        .expect("the message with parts");
    let kinds: Vec<_> = message.1.iter().map(|p| p.kind).collect();
    assert_eq!(
        kinds,
        [
            PartKind::Image,
            PartKind::File,
            PartKind::Resource,
            PartKind::Audio
        ]
    );
    assert_eq!(message.1[0].size, Some(3));
    assert_eq!(message.1[0].data.as_deref(), Some("QUJD"));
    assert_eq!(message.1[1].name, "notes.md");
    assert_eq!(message.1[1].uri.as_deref(), Some("file:///work/notes.md"));
    assert_eq!(message.1[1].size, Some(12));
    assert_eq!(message.1[2].name, "a.txt");
    assert_eq!(message.1[3].mime.as_deref(), Some("audio/wav"));
    // A sound's bytes are never carried.
    assert_eq!(message.1[3].data, None);
    // A file the message points at is typed in its text, as in the box it came from.
    assert!(message.0.contains("@notes.md"), "{}", message.0);
}

#[test]
fn the_plan_the_commands_and_the_context_are_kept_current() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let s = turn(&session, "plan", &[]);
    let steps: Vec<_> = s
        .plan
        .iter()
        .map(|p| (p.content.as_str(), p.status))
        .collect();
    assert_eq!(
        steps,
        [
            ("Read the code", herdr_core::session::PlanStatus::Completed),
            ("Write the fix", herdr_core::session::PlanStatus::InProgress)
        ]
    );
    let s = turn(&session, "commands", &[]);
    let review = s
        .commands
        .iter()
        .find(|c| c.name == "review")
        .expect("review");
    assert_eq!(review.hint.as_deref(), Some("a branch"));
    assert_eq!(s.commands.len(), 2);

    let s = turn(&session, "usage", &[]);
    assert_eq!(s.context_percent, Some(25));
    let usage = s.acp.usage.as_ref().expect("usage");
    assert_eq!((usage.used, usage.size), (25000, 100_000));
    assert_eq!(usage.cost, Some((0.5, "USD".to_owned())));
    let turn_usage = s.acp.turn_usage.as_ref().expect("the turn's usage");
    assert_eq!(turn_usage.total, Some(150));
    assert_eq!(turn_usage.cached_read, Some(100));
    assert_eq!(turn_usage.thought, None);
    // `session_info_update`: a title and when the session changed.
    assert_eq!(s.title.as_deref(), Some("Usage title"));
    assert_eq!(s.acp.updated_at.as_deref(), Some("2026-01-01T00:00:00Z"));
}

#[test]
fn a_notice_and_a_compaction_arrive_because_the_keeper_asked_for_them() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let s = turn(&session, "notice", &[]);
    let notice = s
        .items
        .iter()
        .find_map(|i| match &i.kind {
            ItemKind::Notice {
                severity,
                title,
                text,
            } => Some((severity.clone(), title.clone(), text.clone())),
            _ => None,
        })
        .expect("a notice item");
    assert_eq!(notice.0, "warning");
    assert_eq!(notice.1, "MCP server unavailable");
    assert_eq!(notice.2.as_deref(), Some("Continuing without it."));
    assert!(agent_text(&s).is_empty(), "no fallback message");

    let s = turn(&session, "compact", &[]);
    // Two updates (running, completed), one note that changed in place.
    let compaction: Vec<_> = notes(&s)
        .into_iter()
        .filter(|n| n.to_lowercase().contains("compact"))
        .collect();
    assert_eq!(compaction, ["Conversation compacted"]);
}

// ---- prompts ------------------------------------------------------------------------------------

#[test]
fn a_prompt_carries_text_a_picture_and_a_link_and_the_message_lists_them() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let picture = rig.work.join("shot.png");
    let notes_file = rig.work.join("notes.txt");
    std::fs::write(&picture, b"not really a png").expect("write");
    std::fs::write(&notes_file, b"some notes").expect("write");
    let files = vec![
        picture.display().to_string(),
        notes_file.display().to_string(),
    ];
    let s = turn(&session, "blocks", &files);
    // What the agent was sent: the words, the picture's placeholder and the picture itself, a link.
    assert_eq!(
        agent_text(&s),
        ["blocks:text,text,image:image/png,resource_link"]
    );
    // What the person sees of their own message: the files, structured.
    let mine = s
        .items
        .iter()
        .find_map(|i| match &i.kind {
            ItemKind::Message {
                role: Role::User,
                parts,
                ..
            } => Some(parts.clone()),
            _ => None,
        })
        .expect("the message");
    let kinds: Vec<_> = mine.iter().map(|p| p.kind).collect();
    assert_eq!(kinds, [PartKind::Image, PartKind::File]);
    assert_eq!(mine[0].name, "shot.png");
    assert_eq!(mine[1].name, "notes.txt");
    assert_eq!(mine[1].size, Some(10));
    // The picture's bytes do not stay in the transcript.
    assert_eq!(mine[0].data, None);
}

// ---- cancellation and requests the client does not serve ----------------------------------------

#[test]
fn a_stopped_turn_that_the_agent_answers_with_an_error_ends_as_cancelled() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    assert_eq!(session.send("cancelerr", &[]), Ok(SendOutcome::Sent));
    let running = eventually("the turn to run", || {
        let s = session.snapshot();
        (s.running && !agent_text(&s).is_empty()).then_some(s)
    });
    assert!(
        running.acp.turn_started_ms.is_some(),
        "the running turn has a start"
    );
    session.cancel().expect("cancel");
    let s = eventually("the turn to end", || {
        let s = session.snapshot();
        (!s.running && s.phase == SessionPhase::Idle).then_some(s)
    });
    // Ended by the person's stop, not failed: nothing goes back in the box and no error is shown.
    let said = notes(&s);
    assert!(
        said.iter().any(|n| n == "Turn ended: cancelled"),
        "{said:?}"
    );
    assert!(!said.iter().any(|n| n.starts_with("Not sent")), "{said:?}");
    assert!(s.unsent.is_none());
    assert!(s.acp.turn_started_ms.is_none());
    assert!(
        rig.received()
            .iter()
            .any(|m| m["method"] == "session/cancel" && m.get("id").is_none()),
        "session/cancel is a notification"
    );
    // The session is usable afterwards.
    turn(&session, "plain", &[]);
}

#[test]
fn a_request_for_a_file_or_a_terminal_is_refused_as_not_offered() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let s = turn(&session, "fsask", &[]);
    // -32601: method not found.
    assert!(
        agent_text(&s).contains(&"fs:-32601".to_owned()),
        "{:?}",
        agent_text(&s)
    );
    let s = turn(&session, "termask", &[]);
    assert!(
        agent_text(&s).contains(&"terminal:-32601".to_owned()),
        "{:?}",
        agent_text(&s)
    );
}

// ---- timing -------------------------------------------------------------------------------------

#[test]
fn live_items_have_a_start_and_an_end_and_what_a_replay_brings_has_none() {
    let rig = Rig::new();
    let hub = rig.hub(&[]);
    let session = open(&rig, &hub);
    let id = session.id().to_owned();
    let s = turn(&session, "terminal:2", &[]);
    for item in s.items.iter() {
        match &item.kind {
            ItemKind::Message { .. } | ItemKind::Tool(_) => {
                let (start, end) = (
                    item.started_ms.expect("a live item has a start"),
                    item.ended_ms.expect("and an end once the turn is over"),
                );
                assert!(end >= start, "{item:?}");
            }
            _ => {}
        }
    }

    hub.detach(LOCAL, &id);
    let again = hub.attach(LOCAL, &id).expect("attach");
    let replayed = eventually("the replay", || {
        let s = again.snapshot();
        (s.phase == SessionPhase::Idle && !agent_text(&s).is_empty()).then_some(s)
    });
    assert!(
        replayed
            .items
            .iter()
            .filter(|i| matches!(i.kind, ItemKind::Message { .. } | ItemKind::Tool(_)))
            .all(|i| i.started_ms.is_none() && i.ended_ms.is_none()),
        "a replayed item was not timed by this app"
    );
    let _: &AcpInfo = &replayed.acp;
}
