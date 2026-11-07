//! Notifications over a real D-Bus, to a stand-in for the desktop's notification service.
//!
//! Each test starts a private session bus (`dbus-daemon`) and `tests/support/notification_service.py`
//! on it, points `DBUS_SESSION_BUS_ADDRESS` there, and runs the real notifier and `DesktopSink` against a
//! scripted source on a manual clock. The service prints every call it receives, so a test asserts what
//! the person's desktop would have been told, and it emits `ActionInvoked` as a press would. Only the
//! processes started here are ever killed, by their handle. Needs `dbus-daemon` and python3 with `gi`.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, unbounded};
use herdr_core::link::ManualClock;
use herdr_core::prompt::{PromptInfo, QuickReply, Risk};
use herdr_desktop_native::notify::{
    DesktopSink, Input, Item, Kind, Notifier, Question, Sent, Settings, Source, Target, channel,
};
use parking_lot::Mutex as FastMutex;
use serde_json::Value;

const PATIENCE: Duration = Duration::from_secs(15);

/// The environment is process-wide: one bus at a time.
static ONE_BUS: Mutex<()> = Mutex::new(());

struct Bus {
    daemon: Child,
    _dir: tempfile::TempDir,
    _serial: MutexGuard<'static, ()>,
}

fn start_bus() -> Bus {
    let serial = ONE_BUS.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().expect("a temp dir");
    let config = dir.path().join("bus.conf");
    std::fs::write(
        &config,
        format!(
            r#"<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path={}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy>
</busconfig>"#,
            dir.path().join("bus").display()
        ),
    )
    .expect("the bus config is written");
    let mut daemon = Command::new("dbus-daemon")
        .args(["--nofork", "--print-address=1", "--config-file"])
        .arg(&config)
        .stdout(Stdio::piped())
        .spawn()
        .expect("dbus-daemon starts");
    let mut address = String::new();
    BufReader::new(daemon.stdout.take().expect("piped"))
        .read_line(&mut address)
        .expect("the bus prints its address");
    // SAFETY: the tests of this file hold `ONE_BUS` for as long as they use the bus, and no other
    // thread of this process reads or writes the environment meanwhile.
    unsafe { std::env::set_var("DBUS_SESSION_BUS_ADDRESS", address.trim()) };
    Bus {
        daemon,
        _dir: dir,
        _serial: serial,
    }
}

impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

struct Service {
    child: Child,
    stdin: ChildStdin,
    calls: Receiver<Value>,
}

impl Service {
    fn start(capabilities: &str) -> Service {
        let script =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/notification_service.py");
        let mut child = Command::new("python3")
            .arg(script)
            .arg(capabilities)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("python3 starts the stand-in service");
        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let (tx, calls) = unbounded();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(value);
                }
            }
        });
        let service = Service {
            child,
            stdin,
            calls,
        };
        let first = service.next();
        assert_eq!(first["call"], "ready", "{first}");
        service
    }

    /// The next call the service received.
    fn next(&self) -> Value {
        self.calls
            .recv_timeout(PATIENCE)
            .expect("the service was called")
    }

    /// The next call, which must be a `Notify`.
    fn notify(&self) -> Value {
        let call = self.next();
        assert_eq!(call["call"], "Notify", "{call}");
        call
    }

    fn command(&mut self, line: &str) {
        writeln!(self.stdin, "{line}").expect("the service reads stdin");
        self.stdin.flush().expect("flushed");
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// What the notifier asks of the engine, scripted.
struct Script {
    settings: FastMutex<Settings>,
    items: FastMutex<Vec<Item>>,
    answers: FastMutex<Vec<(String, String, String, usize)>>,
    outcome: FastMutex<Sent>,
    /// How many times the notifier read the board.
    looks: AtomicUsize,
}

impl Source for Script {
    fn settings(&self) -> Settings {
        *self.settings.lock()
    }

    fn items(&self) -> Vec<Item> {
        self.looks.fetch_add(1, Ordering::SeqCst);
        self.items.lock().clone()
    }

    fn answer(&self, machine: &str, pane: &str, digest: &str, index: usize) -> Sent {
        self.answers.lock().push((
            machine.to_owned(),
            pane.to_owned(),
            digest.to_owned(),
            index,
        ));
        self.outcome.lock().clone()
    }
}

struct Rig {
    script: Arc<Script>,
    tx: Sender<Input>,
    notifier: Notifier,
    thread: Option<JoinHandle<()>>,
    // Dropped after the notifier is stopped (see `Drop`).
    service: Service,
    _bus: Bus,
}

fn rig(capabilities: &str) -> Rig {
    let bus = start_bus();
    let service = Service::start(capabilities);
    let script = Arc::new(Script {
        settings: FastMutex::new(Settings {
            needs_you: true,
            also_done: false,
        }),
        items: FastMutex::new(Vec::new()),
        answers: FastMutex::new(Vec::new()),
        looks: AtomicUsize::new(0),
        outcome: FastMutex::new(Sent::Yes),
    });
    let (tx, rx) = channel();
    let (notifier, thread) = Notifier::start(
        tx.clone(),
        rx,
        script.clone(),
        Arc::new(DesktopSink::new(tx.clone())),
        Arc::new(ManualClock::new()),
    )
    .expect("the notifier starts");
    Rig {
        script,
        tx,
        notifier,
        thread: Some(thread),
        service,
        _bus: bus,
    }
}

impl Rig {
    fn set(&self, items: Vec<Item>) {
        *self.script.items.lock() = items;
        self.tx.send(Input::Tick).expect("the notifier runs");
    }

    /// The window leaves, and this returns once the notifier has looked at the board in that state: what
    /// is blocked at that moment is what counts as seen.
    fn window_away(&self) {
        let before = self.script.looks.load(Ordering::SeqCst);
        self.tx.send(Input::Away(true)).expect("the notifier runs");
        let deadline = std::time::Instant::now() + PATIENCE;
        while self.script.looks.load(Ordering::SeqCst) == before {
            assert!(
                std::time::Instant::now() < deadline,
                "the notifier never looked"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.tx.send(Input::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn reply(label: &str, keys: &[&str], risk: Option<Risk>) -> QuickReply {
    QuickReply {
        label: label.to_owned(),
        keys: keys.iter().map(|k| (*k).to_owned()).collect(),
        risk,
        standing_grant: false,
    }
}

fn blocked(pane: &str, command: &str) -> Item {
    Item {
        machine: "local".to_owned(),
        pane: pane.to_owned(),
        seq: 1,
        kind: Kind::NeedsYou,
        reachable: true,
        name: format!("agent {pane}"),
        place: "claude on This computer".to_owned(),
        question: Question::Read(Some(PromptInfo {
            question: "Do you want to run this command?".to_owned(),
            subject: Some(command.to_owned()),
            options: vec![
                reply("1. Yes", &["1", "enter"], None),
                reply("2. Yes, and push", &["2", "enter"], Some(Risk::Pushes)),
                reply("3. No", &["3", "enter"], None),
                reply("4. Maybe", &["4", "enter"], None),
            ],
            digest: format!("digest-{pane}"),
        })),
    }
}

/// The actions of a `Notify` call as (key, label) pairs.
fn actions(call: &Value) -> Vec<(String, String)> {
    let all: Vec<&str> = call["actions"]
        .as_array()
        .expect("a list")
        .iter()
        .map(|a| a.as_str().expect("a string"))
        .collect();
    all.chunks(2)
        .map(|p| (p[0].to_owned(), p[1].to_owned()))
        .collect()
}

#[test]
fn the_call_carries_the_question_the_command_and_at_most_two_buttons() {
    let rig = rig("actions,body-markup");
    rig.window_away();
    rig.set(vec![]);
    rig.set(vec![blocked("p1", "ls -la && echo <done>")]);
    let call = rig.service.notify();

    assert_eq!(call["summary"], "agent p1 needs you");
    let body = call["body"].as_str().expect("a body");
    assert!(body.contains("Do you want to run this command?"), "{body}");
    assert!(
        body.contains("ls -la &amp;&amp; echo &lt;done&gt;"),
        "a server that renders markup gets the command escaped, so it reads as typed: {body}"
    );
    assert!(body.ends_with("claude on This computer"));
    let buttons: Vec<_> = actions(&call)
        .into_iter()
        .filter(|(key, _)| key != "default")
        .collect();
    assert_eq!(
        buttons,
        [
            ("answer:0".to_owned(), "1. Yes".to_owned()),
            ("answer:1".to_owned(), "3. No".to_owned())
        ],
        "two plain answers; the risky one is not offered"
    );
    assert_eq!(
        call["hints"]["desktop-entry"],
        "dev.herdrmobile.herdr_desktop"
    );
    assert_eq!(call["timeout"], 0, "a question stays until dealt with");
}

#[test]
fn a_service_without_actions_or_markup_gets_plain_text_and_no_buttons() {
    let rig = rig("body");
    rig.window_away();
    rig.set(vec![]);
    rig.set(vec![blocked("p1", "ls -la && echo <done>")]);
    let call = rig.service.notify();
    assert!(
        call["body"]
            .as_str()
            .expect("a body")
            .contains("ls -la && echo <done>"),
        "{call}"
    );
    assert_eq!(call["actions"], serde_json::json!([]));
}

#[test]
fn a_burst_of_five_blocked_panes_is_three_notifications_and_one_summary() {
    let rig = rig("actions");
    rig.window_away();
    rig.set(vec![]);
    rig.set((1..=5).map(|n| blocked(&format!("p{n}"), "ls")).collect());
    let calls: Vec<Value> = (0..4).map(|_| rig.service.notify()).collect();
    let own: Vec<_> = calls
        .iter()
        .filter(|c| {
            c["summary"]
                .as_str()
                .is_some_and(|s| s.starts_with("agent p"))
        })
        .collect();
    assert_eq!(own.len(), 3, "{calls:?}");
    let summary = calls
        .iter()
        .find(|c| c["summary"] == "5 agents need you")
        .expect("one summary");
    assert_eq!(
        actions(summary),
        [("default".to_owned(), "Open".to_owned())],
        "a summary only opens the app"
    );
}

#[test]
fn an_agent_that_was_already_blocked_when_the_window_left_is_not_announced() {
    let rig = rig("actions");
    rig.set(vec![blocked("old", "ls")]);
    rig.window_away();
    rig.set(vec![blocked("old", "ls")]);
    rig.set(vec![blocked("old", "ls"), blocked("new", "ls")]);
    let call = rig.service.notify();
    assert_eq!(
        call["summary"], "agent new needs you",
        "the first call is the newcomer's"
    );
}

#[test]
fn a_notification_is_withdrawn_when_its_agent_stops_needing_you_and_all_when_the_window_returns() {
    let rig = rig("actions");
    rig.window_away();
    rig.set(vec![]);
    rig.set(vec![blocked("p1", "ls"), blocked("p2", "ls")]);
    let first = rig.service.notify();
    let second = rig.service.notify();
    assert_ne!(first["id"], second["id"]);

    // p1 was answered elsewhere.
    rig.set(vec![blocked("p2", "ls")]);
    let close = rig.service.next();
    assert_eq!(
        (close["call"].as_str(), &close["id"]),
        (Some("Close"), &first["id"])
    );

    // The window comes back: what is left goes.
    rig.tx.send(Input::Away(false)).expect("the notifier runs");
    let close = rig.service.next();
    assert_eq!(
        (close["call"].as_str(), &close["id"]),
        (Some("Close"), &second["id"])
    );
}

#[test]
fn a_button_press_is_answered_through_the_one_checked_path_and_a_refusal_replaces_the_question() {
    let mut rig = rig("actions");
    rig.window_away();
    rig.set(vec![]);
    rig.set(vec![blocked("p1", "ls")]);
    let call = rig.service.notify();
    let id = call["id"].as_u64().expect("an id");

    rig.service.command(&format!("action {id} answer:1"));
    let close = rig.service.next();
    assert_eq!(
        (close["call"].as_str(), close["id"].as_u64()),
        (Some("Close"), Some(id)),
        "an answer that was sent withdraws the notification"
    );
    assert_eq!(
        *rig.script.answers.lock(),
        [(
            "local".to_owned(),
            "p1".to_owned(),
            "digest-p1".to_owned(),
            2
        )],
        "button 1 is option 3 (the risky option 2 has no button), with the digest the person saw"
    );

    // Another agent; this time the pane refuses (the question changed).
    *rig.script.outcome.lock() =
        Sent::No("The question changed, so nothing was sent. Open the agent to see it.".to_owned());
    rig.set(vec![blocked("p1", "ls"), blocked("p2", "ls")]);
    let second = rig.service.notify();
    let id2 = second["id"].as_u64().expect("an id");
    rig.service.command(&format!("action {id2} answer:0"));
    let refusal = rig.service.notify();
    assert_eq!(
        refusal["replaces"].as_u64(),
        Some(id2),
        "it replaces the question"
    );
    assert_eq!(refusal["summary"], "Answer not sent");
    assert!(
        refusal["body"]
            .as_str()
            .expect("a body")
            .contains("nothing was sent")
    );
    assert_eq!(rig.script.answers.lock().len(), 2);

    // Pressing the same button again does not send again.
    rig.service.command(&format!("action {id2} answer:0"));
    rig.set(vec![
        blocked("p1", "ls"),
        blocked("p2", "ls"),
        blocked("p3", "ls"),
    ]);
    let third = rig.service.notify();
    assert_eq!(third["summary"], "agent p3 needs you");
    assert_eq!(
        rig.script.answers.lock().len(),
        2,
        "a spent button is spent"
    );
}

#[test]
fn a_click_on_the_body_is_handed_to_whoever_listens() {
    let mut rig = rig("actions");
    let (_id, clicks) = rig.notifier.subscribe();
    rig.window_away();
    rig.set(vec![]);
    rig.set(vec![blocked("p1", "ls")]);
    let id = rig.service.notify()["id"].as_u64().expect("an id");
    rig.service.command(&format!("action {id} default"));
    let deadline = std::time::Instant::now() + PATIENCE;
    let target = loop {
        if let Ok(target) = clicks.try_recv() {
            break target;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the click never arrived"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(
        target,
        Target::Agent {
            machine: "local".to_owned(),
            pane: "p1".to_owned()
        }
    );
    assert!(
        rig.script.answers.lock().is_empty(),
        "a click answers nothing"
    );
}

#[test]
fn without_a_notification_service_the_sink_says_so() {
    let _bus = start_bus();
    let (tx, _rx) = channel();
    let error = DesktopSink::new(tx)
        .support()
        .expect_err("nothing owns org.freedesktop.Notifications");
    assert!(error.to_lowercase().contains("notification"), "{error}");
}
