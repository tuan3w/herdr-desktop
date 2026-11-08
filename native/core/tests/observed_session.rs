//! An observed session end to end: the real keeper script (`follow`) reading a synthetic JSONL log in a
//! home of its own, a toy mapper for a toy log format, and a scripted pane. What is under test is the
//! orchestration (locating, following, resetting, the person's hand on the pane, answering by keys with the
//! log's last word); the real agents' mappers have their own tests.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use herdr_core::observed::kinds::ObservedKind;
use herdr_core::observed::model::{
    AskAnswer, AskDriver, AskOption, AskQuestion, AskStep, BackgroundTask, LocateCtx, Location,
    Locator, LogMapper, PendingAsk, ProposedPlan, Role, SubagentInfo, Update, message,
};
use herdr_core::observed::session::{ObservedConfig, PaneIo, PaneState};
use herdr_core::schema::AgentStatus;
use herdr_core::session::{
    Ask, EarlierHistory, FieldAnswer, HubConfig, ItemKind, KeeperError, KeeperHost, ObservedLink,
    Refusal, SessionHub, SessionPhase, SessionSnapshot,
};
use parking_lot::Mutex;
use serde_json::{Value, json};

const T: Duration = Duration::from_secs(30);
const LOCAL: &str = "local";

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

// ---- a toy log format --------------------------------------------------------------------------

/// `{"k":"user"|"agent","id","text"}`, `{"k":"ask","id"}`, `{"k":"ask_result","id","output"}`, `{"k":"clear"}`.
#[derive(Default)]
struct ToyMapper {
    pending: Option<PendingAsk>,
    last_agent: bool,
}

impl LogMapper for ToyMapper {
    fn map(&mut self, line: &str) -> Vec<Update> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let id = v["id"].as_str().unwrap_or("x").to_owned();
        match v["k"].as_str() {
            Some("user") => {
                self.last_agent = false;
                vec![message(Role::User, &id, v["text"].as_str().unwrap_or(""))]
            }
            Some("agent") => {
                self.last_agent = true;
                vec![message(Role::Agent, &id, v["text"].as_str().unwrap_or(""))]
            }
            Some("ask") => {
                self.pending = Some(PendingAsk {
                    tool_call_id: id.clone(),
                    questions: vec![AskQuestion {
                        id: "q1".into(),
                        question: "Which store?".into(),
                        options: ["SQLite", "Postgres"]
                            .map(|label| AskOption {
                                label: label.into(),
                                description: String::new(),
                            })
                            .to_vec(),
                        multi: false,
                        recommended: Some(1),
                    }],
                });
                vec![Update::ToolStart(
                    json!({"toolCallId": id, "title": "Ask", "kind": "other", "status": "in_progress"}),
                )]
            }
            Some("ask_result") => {
                self.pending = None;
                vec![Update::ToolPatch(
                    json!({"toolCallId": id, "status": "completed",
                    "content": [{"type": "content", "content": {"type": "text", "text": v["output"]}}]}),
                )]
            }
            Some("clear") => {
                self.pending = None;
                vec![Update::Cleared]
            }
            _ => Vec::new(),
        }
    }
    fn pending_ask(&self) -> Option<PendingAsk> {
        self.pending.clone()
    }
    fn proposed_plan(&self) -> Option<ProposedPlan> {
        None
    }
    fn open_tool_calls(&self) -> BTreeSet<String> {
        BTreeSet::new()
    }
    fn subagents(&self) -> Vec<SubagentInfo> {
        Vec::new()
    }
    fn background_tasks(&self) -> Vec<BackgroundTask> {
        Vec::new()
    }
    fn turn_ended(&self) -> bool {
        self.last_agent
    }
    fn reset(&mut self) {
        self.pending = None;
        self.last_agent = false;
    }
}

struct ToyLocator;

impl Locator for ToyLocator {
    fn may_locate(&self, _: &herdr_core::schema::AgentInfo) -> bool {
        true
    }
    fn locate(&self, _: &LocateCtx<'_>) -> Location {
        unreachable!("the scripted pane locates by itself")
    }
}

/// Answers with the first option: `down` x n then `enter`, as a dialog would take it, and says so on screen.
struct ToyAsk;

impl AskDriver for ToyAsk {
    fn looks_like_ask(&self, screen: &str) -> bool {
        screen.contains("Which store?")
    }
    fn stepper(
        &self,
        _ask: &PendingAsk,
        answers: &[AskAnswer],
    ) -> Box<dyn FnMut(&str) -> AskStep + Send> {
        let pick = answers[0].selected.first().copied();
        let mut sent = false;
        Box::new(move |screen| {
            if !screen.contains("Which store?") {
                return AskStep::Mismatch("not the dialog".into());
            }
            if sent {
                return AskStep::Done;
            }
            sent = true;
            let mut keys: Vec<String> = vec!["down".into(); pick.unwrap_or(0)];
            keys.push("enter".into());
            AskStep::Send {
                keys,
                text: None,
                submits: true,
                why: "pick".into(),
            }
        })
    }
    fn result_matches(
        &self,
        output: Option<&str>,
        _ask: &PendingAsk,
        answers: &[AskAnswer],
    ) -> bool {
        output == Some(["SQLite", "Postgres"][answers[0].selected[0]])
    }
}

static TOY_LOCATOR: ToyLocator = ToyLocator;
static TOY_ASK: ToyAsk = ToyAsk;

static PLAIN: LazyLock<ObservedKind> = LazyLock::new(|| toy_kind(false));
static ASKING: LazyLock<ObservedKind> = LazyLock::new(|| toy_kind(true));

fn toy_kind(with_ask: bool) -> ObservedKind {
    ObservedKind {
        id: "omp",
        label: "omp",
        new_mapper: || Box::new(ToyMapper::default()),
        locator: &TOY_LOCATOR,
        ask: with_ask.then_some(&TOY_ASK as &'static dyn AskDriver),
        wakes_on_background: true,
        integration: None,
    }
}

fn kind(with_ask: bool) -> &'static ObservedKind {
    if with_ask { &ASKING } else { &PLAIN }
}

// ---- a scripted pane ---------------------------------------------------------------------------

/// Runs when keys go in: what the terminal does to the log.
type OnEnter = Box<dyn Fn(&[String]) + Send>;

struct Pane {
    state: Mutex<PaneState>,
    location: Mutex<Location>,
    screen: Mutex<String>,
    inputs: Mutex<Vec<(String, Vec<String>)>>,
    keys: Mutex<Vec<Vec<String>>>,
    reads: AtomicUsize,
    /// What a `send_input` of keys does to the log: appended when `enter` goes in.
    on_enter: Mutex<Option<OnEnter>>,
}

impl Pane {
    fn new(location: Location) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(PaneState::Agent {
                status: AgentStatus::Idle,
                cwd: Some("/home/dev/project".into()),
                title: None,
            }),
            location: Mutex::new(location),
            screen: Mutex::new(String::new()),
            inputs: Mutex::new(Vec::new()),
            keys: Mutex::new(Vec::new()),
            reads: AtomicUsize::new(0),
            on_enter: Mutex::new(None),
        })
    }

    fn set_status(&self, status: AgentStatus) {
        *self.state.lock() = PaneState::Agent {
            status,
            cwd: Some("/home/dev/project".into()),
            title: None,
        };
    }
}

impl PaneIo for Pane {
    fn state(&self) -> PaneState {
        self.state.lock().clone()
    }
    fn locate(&self, _: &dyn Locator) -> Location {
        self.location.lock().clone()
    }
    fn read_screen(&self) -> Result<String, String> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        Ok(self.screen.lock().clone())
    }
    fn send_input(&self, text: &str, keys: &[String]) -> Result<(), String> {
        self.inputs.lock().push((text.to_owned(), keys.to_vec()));
        if let Some(hook) = &*self.on_enter.lock() {
            hook(keys);
        }
        Ok(())
    }
    fn send_keys(&self, keys: &[String]) -> Result<(), String> {
        self.keys.lock().push(keys.to_vec());
        Ok(())
    }
    fn read_file(&self, _: &str, _: usize) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
}

// ---- the rig ---------------------------------------------------------------------------------

struct Rig {
    _dir: tempfile::TempDir,
    home: PathBuf,
    log: PathBuf,
    hub: SessionHub,
}

impl Rig {
    fn new() -> Self {
        Self::with(ObservedConfig::default())
    }

    fn with(observed: ObservedConfig) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("home");
        let log = home.join(".omp/agent/sessions/project/log.jsonl");
        std::fs::create_dir_all(log.parent().expect("parent")).expect("mkdir");
        let mut config = HubConfig::new(Arc::new(|| {}));
        config.observed = observed;
        let hub = SessionHub::new(config);
        hub.set_host(
            LOCAL,
            Arc::new(KeeperHost::local(&home).env("PATH", "/usr/bin:/bin")),
        );
        Self {
            _dir: dir,
            home,
            log,
            hub,
        }
    }

    fn append(&self, lines: &[Value]) {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)
            .expect("log");
        for l in lines {
            writeln!(f, "{l}").expect("append");
        }
    }

    fn located(&self) -> Location {
        Location::Located(self.log.display().to_string())
    }
}

fn fast() -> ObservedConfig {
    ObservedConfig {
        poll_every: Duration::from_millis(20),
        confirm_within: Duration::from_millis(600),
        problem_hold: Duration::from_millis(300),
        locate_every: Duration::from_millis(40),
        locate_max: Duration::from_millis(80),
        backoff: vec![Duration::from_millis(50)],
        max_attempts: 3,
        max_ask_steps: 6,
        tail_start: 192 * 1024,
        tail_max: 64 * 1024 * 1024,
    }
}

fn texts(s: &SessionSnapshot, role: herdr_core::session::Role) -> Vec<String> {
    s.items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Message { role: r, text, .. } if *r == role => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn user(id: &str, text: &str) -> Value {
    json!({"k": "user", "id": id, "text": text})
}

fn agent(id: &str, text: &str) -> Value {
    json!({"k": "agent", "id": id, "text": text})
}

// ---- tests -----------------------------------------------------------------------------------

#[test]
fn a_log_that_exists_becomes_a_chat_and_what_the_agent_appends_arrives() {
    let rig = Rig::new();
    rig.append(&[user("u1", "hello"), agent("a1", "hi there")]);
    let pane = Pane::new(rig.located());
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), pane.clone())
        .expect("observe");

    let s = eventually("the replay", || {
        let s = chat.snapshot();
        (s.phase == SessionPhase::Idle && texts(&s, herdr_core::session::Role::Agent).len() == 1)
            .then_some(s)
    });
    assert_eq!(texts(&s, herdr_core::session::Role::User), ["hello"]);
    let info = s.observed.as_ref().expect("observed");
    assert_eq!(info.link, ObservedLink::Following);
    assert_eq!(info.pane_id, "w1:p1");
    assert_eq!(
        info.log_path.as_deref(),
        Some(rig.log.to_str().expect("utf8"))
    );
    // The agent's own title is missing: the pane's folder names the chat.
    assert_eq!(s.title.as_deref(), Some("project"));
    assert!(info.turn_ended);

    // The agent works and writes: the new line arrives without anyone asking, and the phase follows the pane.
    pane.set_status(AgentStatus::Working);
    rig.append(&[user("u2", "more"), agent("a2", "on it")]);
    let s = eventually("the appended lines", || {
        let s = chat.snapshot();
        (texts(&s, herdr_core::session::Role::Agent).len() == 2).then_some(s)
    });
    assert_eq!(
        texts(&s, herdr_core::session::Role::User),
        ["hello", "more"]
    );
    eventually("working", || {
        (chat.snapshot().phase == SessionPhase::Working).then_some(())
    });
    assert!(chat.snapshot().running);
}

#[test]
fn a_whole_message_replaces_the_message_of_its_id_instead_of_repeating_it() {
    let rig = Rig::new();
    rig.append(&[agent("a1", "draft")]);
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), Pane::new(rig.located()))
        .expect("observe");
    eventually("the draft", || {
        (texts(&chat.snapshot(), herdr_core::session::Role::Agent) == ["draft"]).then_some(())
    });
    rig.append(&[agent("a1", "final")]);
    eventually("the final text", || {
        (texts(&chat.snapshot(), herdr_core::session::Role::Agent) == ["final"]).then_some(())
    });
}

#[test]
fn a_log_that_shrinks_rebuilds_the_chat_and_a_cleared_log_empties_it() {
    let rig = Rig::new();
    rig.append(&[user("u1", "one"), agent("a1", "two")]);
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), Pane::new(rig.located()))
        .expect("observe");
    eventually("the replay", || {
        (chat.snapshot().items.len() == 2).then_some(())
    });

    rig.append(&[json!({"k": "clear"}), user("u9", "fresh")]);
    eventually("the clear", || {
        let s = chat.snapshot();
        (texts(&s, herdr_core::session::Role::User) == ["fresh"] && s.items.len() == 1)
            .then_some(())
    });

    // The file was replaced by a shorter one (a new session in the same path): the keeper says `R`.
    std::fs::write(&rig.log, format!("{}\n", user("n1", "new start"))).expect("replace");
    eventually("the rebuild", || {
        let s = chat.snapshot();
        (texts(&s, herdr_core::session::Role::User) == ["new start"]).then_some(())
    });
}

#[test]
fn an_agent_that_has_not_written_its_log_yet_is_an_empty_chat_that_fills_when_it_does() {
    let rig = Rig::with(fast());
    let pane = Pane::new(Location::NotYet(
        "The agent writes its log with the first message.".into(),
    ));
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), pane.clone())
        .expect("observe");
    let s = eventually("the quiet status", || {
        let s = chat.snapshot();
        matches!(&s.observed.as_ref()?.link, ObservedLink::Locating(why) if why.contains("writes its log")).then_some(s)
    });
    assert_eq!(
        s.phase,
        SessionPhase::Idle,
        "an empty chat, not a connection that never comes"
    );
    assert!(s.items.is_empty());

    rig.append(&[user("u1", "first")]);
    *pane.location.lock() = rig.located();
    eventually("the first message", || {
        (texts(&chat.snapshot(), herdr_core::session::Role::User) == ["first"]).then_some(())
    });
}

#[test]
fn a_log_that_cannot_be_read_says_so_and_stops_trying() {
    let rig = Rig::with(fast());
    // Outside the home folder the keeper refuses (exit 66): nothing better comes of trying again.
    let outside = rig._dir.path().join("elsewhere.jsonl");
    std::fs::write(&outside, "{}\n").expect("write");
    let pane = Pane::new(Location::Located(outside.display().to_string()));
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), pane)
        .expect("observe");
    let s = eventually("the failure", || {
        let s = chat.snapshot();
        matches!(s.observed.as_ref()?.link, ObservedLink::Failed(_)).then_some(s)
    });
    assert!(
        matches!(&s.observed.as_ref().expect("observed").link, ObservedLink::Failed(why) if !why.is_empty())
    );
    eventually("the session to close", || (!chat.is_open()).then_some(()));
}

#[test]
fn a_pane_that_is_gone_or_no_longer_an_agent_ends_the_chat() {
    let rig = Rig::with(fast());
    rig.append(&[user("u1", "hi")]);
    let pane = Pane::new(rig.located());
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), pane.clone())
        .expect("observe");
    eventually("the replay", || {
        (chat.snapshot().items.len() == 1).then_some(())
    });
    *pane.state.lock() = PaneState::NotAgent;
    let s = eventually("the end", || {
        let s = chat.snapshot();
        matches!(s.phase, SessionPhase::Ended(_)).then_some(s)
    });
    assert!(matches!(&s.phase, SessionPhase::Ended(why) if why.contains("isn’t running")));
    eventually("the session to close", || (!chat.is_open()).then_some(()));
    assert_eq!(chat.send("hello"), Err(Refusal::Ended));
}

#[test]
fn a_message_is_typed_into_the_pane_and_the_log_says_it_arrived() {
    let rig = Rig::with(fast());
    rig.append(&[agent("a1", "ready")]);
    let pane = Pane::new(rig.located());
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), pane.clone())
        .expect("observe");
    eventually("the replay", || {
        (chat.snapshot().phase == SessionPhase::Idle).then_some(())
    });

    chat.send("please do the thing").expect("sent");
    assert_eq!(
        pane.inputs.lock().as_slice(),
        [("please do the thing".to_owned(), vec!["enter".to_owned()])]
    );
    // The agent's program wrote it to its log: the chat shows it and nothing is wrong.
    rig.append(&[user("u1", "please do the thing")]);
    eventually("the echo", || {
        (texts(&chat.snapshot(), herdr_core::session::Role::User) == ["please do the thing"])
            .then_some(())
    });
    std::thread::sleep(Duration::from_millis(900));
    assert_eq!(
        chat.snapshot().observed.as_ref().expect("observed").problem,
        None
    );
}

#[test]
fn a_message_the_log_never_shows_is_called_out_and_the_note_goes_away() {
    let rig = Rig::with(fast());
    rig.append(&[agent("a1", "ready")]);
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), Pane::new(rig.located()))
        .expect("observe");
    eventually("the replay", || {
        (chat.snapshot().phase == SessionPhase::Idle).then_some(())
    });
    chat.send("lost in the terminal").expect("typed");
    eventually("the problem", || {
        chat.snapshot()
            .observed
            .as_ref()?
            .problem
            .as_deref()
            .filter(|p| p.contains("may not have taken that message"))
            .map(|_| ())
    });
    eventually("the problem to clear itself", || {
        chat.snapshot()
            .observed
            .as_ref()?
            .problem
            .is_none()
            .then_some(())
    });
}

#[test]
fn nothing_is_typed_while_the_terminal_needs_the_person_or_a_question_waits() {
    let rig = Rig::with(fast());
    rig.append(&[agent("a1", "ready")]);
    let pane = Pane::new(rig.located());
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(true), pane.clone())
        .expect("observe");
    eventually("the replay", || {
        (chat.snapshot().phase == SessionPhase::Idle).then_some(())
    });

    pane.set_status(AgentStatus::Blocked);
    eventually("blocked", || {
        (chat.snapshot().phase == SessionPhase::BlockedOnPermission).then_some(())
    });
    assert_eq!(
        chat.send("go"),
        Err(Refusal::Blocked("Needs you in the terminal".into()))
    );

    pane.set_status(AgentStatus::Working);
    rig.append(&[json!({"k": "ask", "id": "t1"})]);
    eventually("the question", || {
        (chat.snapshot().phase == SessionPhase::BlockedOnQuestion).then_some(())
    });
    assert_eq!(
        chat.send("go"),
        Err(Refusal::Blocked("Answer the question above first".into()))
    );
    assert!(pane.inputs.lock().is_empty(), "nothing was typed");
    assert!(matches!(chat.send("  "), Err(Refusal::Invalid(_))));
}

#[test]
fn stop_presses_escape_only_while_the_agent_works() {
    let rig = Rig::with(fast());
    rig.append(&[agent("a1", "ready")]);
    let pane = Pane::new(rig.located());
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), pane.clone())
        .expect("observe");
    assert_eq!(chat.stop(), Err(Refusal::NothingWaiting));
    assert!(pane.keys.lock().is_empty());
    pane.set_status(AgentStatus::Working);
    chat.stop().expect("stopped");
    assert_eq!(pane.keys.lock().as_slice(), [vec!["esc".to_owned()]]);
}

fn asked(
    rig: &Rig,
    pane: &Arc<Pane>,
) -> (
    herdr_core::observed::session::ObservedHandle,
    herdr_core::session::Waiting,
) {
    rig.append(&[agent("a1", "ready"), json!({"k": "ask", "id": "t1"})]);
    *pane.screen.lock() = "╭─ Ask ─╮\n│ Which store? │\n│ ❯ SQLite │".to_owned();
    pane.set_status(AgentStatus::Working);
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(true), pane.clone())
        .expect("observe");
    let waiting = eventually("the question", || chat.snapshot().waiting.first().cloned());
    (chat, waiting)
}

#[test]
fn a_question_is_answered_by_keys_and_the_log_confirms_what_was_recorded() {
    let rig = Rig::with(fast());
    let pane = Pane::new(rig.located());
    let (chat, waiting) = asked(&rig, &pane);
    let Ask::Question(form) = &waiting.ask else {
        panic!("a question")
    };
    assert_eq!(form.fields[0].label, "Which store?");
    assert_eq!(form.fields[0].choices.len(), 2);
    assert_eq!(
        form.fields[0].choice,
        Some(1),
        "the agent's recommendation starts chosen"
    );
    let answer = [FieldAnswer {
        choice: Some(1),
        ..FieldAnswer::default()
    }];

    // Not the question the person saw, or not enough time: nothing is pressed.
    assert_eq!(
        chat.answer_question("\"other\"", &waiting.digest, &answer),
        Err(Refusal::Changed)
    );
    assert_eq!(
        chat.answer_question(&waiting.request_id, "0000", &answer),
        Err(Refusal::Changed)
    );
    assert!(pane.inputs.lock().is_empty());

    // The terminal records the answer when `enter` goes in.
    let log = rig.log.clone();
    *pane.on_enter.lock() = Some(Box::new(move |keys| {
        if keys.last().map(String::as_str) == Some("enter") {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&log)
                .expect("log");
            writeln!(
                f,
                "{}",
                json!({"k": "ask_result", "id": "t1", "output": "Postgres"})
            )
            .expect("append");
        }
    }));
    eventually("the answer to be accepted", || {
        match chat.answer_question(&waiting.request_id, &waiting.digest, &answer) {
            Err(Refusal::TooSoon) => None,
            other => {
                other.expect("accepted");
                Some(())
            }
        }
    });
    assert_eq!(
        pane.inputs.lock().as_slice(),
        [(String::new(), vec!["down".to_owned(), "enter".to_owned()])]
    );
    eventually("the question to be gone", || {
        chat.snapshot().waiting.is_empty().then_some(())
    });
    // What was recorded is what was answered: no complaint.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        chat.snapshot().observed.as_ref().expect("observed").problem,
        None
    );
}

#[test]
fn a_recorded_answer_that_differs_from_the_one_given_is_called_out() {
    let rig = Rig::with(fast());
    let pane = Pane::new(rig.located());
    let (chat, waiting) = asked(&rig, &pane);
    let log = rig.log.clone();
    *pane.on_enter.lock() = Some(Box::new(move |keys| {
        if keys.last().map(String::as_str) == Some("enter") {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&log)
                .expect("log");
            writeln!(
                f,
                "{}",
                json!({"k": "ask_result", "id": "t1", "output": "SQLite"})
            )
            .expect("append");
        }
    }));
    let answer = [FieldAnswer {
        choice: Some(1),
        ..FieldAnswer::default()
    }];
    eventually("the answer to be accepted", || {
        match chat.answer_question(&waiting.request_id, &waiting.digest, &answer) {
            Err(Refusal::TooSoon) => None,
            other => {
                other.expect("accepted");
                Some(())
            }
        }
    });
    eventually("the complaint", || {
        chat.snapshot()
            .observed
            .as_ref()?
            .problem
            .as_deref()
            .filter(|p| p.contains("recorded a different answer"))
            .map(|_| ())
    });
}

#[test]
fn an_answer_the_screen_cannot_take_sends_nothing_and_says_to_open_the_terminal() {
    let rig = Rig::with(fast());
    let pane = Pane::new(rig.located());
    let (chat, waiting) = asked(&rig, &pane);
    // The dialog is gone from the screen (the agent moved on, or the terminal changed).
    *pane.screen.lock() = "$ ".to_owned();
    let answer = [FieldAnswer {
        choice: Some(0),
        ..FieldAnswer::default()
    }];
    let refusal = eventually("a refusal other than too soon", || {
        match chat.answer_question(&waiting.request_id, &waiting.digest, &answer) {
            Err(Refusal::TooSoon) => None,
            other => Some(other),
        }
    });
    assert!(
        matches!(&refusal, Err(Refusal::Blocked(m)) if m.contains("Open the terminal")),
        "{refusal:?}"
    );
    assert!(pane.inputs.lock().is_empty());
    // Declining is Esc, sent only while the dialog is up.
    assert_eq!(
        chat.dismiss(&waiting.request_id, &waiting.digest),
        Err(Refusal::Changed)
    );
    assert!(pane.keys.lock().is_empty());
    *pane.screen.lock() = "│ Which store? │".to_owned();
    chat.dismiss(&waiting.request_id, &waiting.digest)
        .expect("declined");
    assert_eq!(pane.keys.lock().as_slice(), [vec!["esc".to_owned()]]);
}

#[test]
fn an_answer_with_the_wrong_number_of_fields_or_an_unknown_option_is_refused_before_any_key() {
    let rig = Rig::with(fast());
    let pane = Pane::new(rig.located());
    let (chat, waiting) = asked(&rig, &pane);
    let attempt = |answers: Vec<FieldAnswer>| {
        eventually("a refusal other than too soon", || {
            match chat.answer_question(&waiting.request_id, &waiting.digest, &answers) {
                Err(Refusal::TooSoon) => None,
                other => Some(other),
            }
        })
    };
    assert!(matches!(attempt(vec![]), Err(Refusal::Invalid(_))));
    assert_eq!(
        attempt(vec![FieldAnswer {
            choice: Some(7),
            ..FieldAnswer::default()
        }]),
        Err(Refusal::NoSuchOption)
    );
    assert!(matches!(
        attempt(vec![FieldAnswer::default()]),
        Err(Refusal::Invalid(_))
    ));
    assert!(pane.inputs.lock().is_empty());
}

#[test]
fn an_agent_whose_questions_belong_to_the_terminal_is_not_answered_from_here() {
    let rig = Rig::with(fast());
    rig.append(&[json!({"k": "ask", "id": "t1"})]);
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), Pane::new(rig.located()))
        .expect("observe");
    eventually("the replay", || {
        (chat.snapshot().phase == SessionPhase::Idle).then_some(())
    });
    // No driver: the question is not offered as a form.
    assert!(chat.snapshot().waiting.is_empty());
    assert!(matches!(
        chat.answer_question("\"t1\"", "x", &[]),
        Err(Refusal::Blocked(_))
    ));
    assert!(
        !chat
            .snapshot()
            .observed
            .as_ref()
            .expect("observed")
            .answers_questions
    );
}

#[test]
fn at_most_four_chats_from_terminals_are_open_per_machine_and_one_pane_is_one_chat() {
    let rig = Rig::with(fast());
    rig.append(&[agent("a1", "x")]);
    let mut open = Vec::new();
    for n in 0..4 {
        open.push(
            rig.hub
                .observe(
                    LOCAL,
                    &format!("w1:p{n}"),
                    kind(false),
                    Pane::new(rig.located()),
                )
                .expect("observe"),
        );
    }
    match rig
        .hub
        .observe(LOCAL, "w1:p9", kind(false), Pane::new(rig.located()))
    {
        Err(KeeperError::TooMany(m)) => assert!(m.contains('4'), "{m}"),
        Err(other) => panic!("{other:?}"),
        Ok(_) => panic!("a fifth chat opened"),
    }
    // The same pane again is the chat it already has.
    let again = rig
        .hub
        .observe(LOCAL, "w1:p0", kind(false), Pane::new(rig.located()))
        .expect("the same pane");
    assert_eq!(again.pane(), "w1:p0");
    rig.hub.stop_observing(LOCAL, "w1:p0");
    assert!(!open[0].is_open());
    assert!(rig.hub.observed(LOCAL, "w1:p0").is_none());
    rig.hub
        .observe(LOCAL, "w1:p9", kind(false), Pane::new(rig.located()))
        .expect("room again");
    let _ = Path::new(&rig.home);
}

// ---- earlier history ---------------------------------------------------------------------------

/// `turns` user and agent messages of about 1 KB each, `u<i>`/`a<i>`, from `from`.
fn long_log(rig: &Rig, from: usize, turns: usize) {
    let pad = "x".repeat(1000);
    let lines: Vec<Value> = (from..from + turns)
        .flat_map(|i| {
            [
                user(&format!("u{i}"), &format!("q{i} {pad}")),
                agent(&format!("a{i}"), &format!("r{i} {pad}")),
            ]
        })
        .collect();
    rig.append(&lines);
}

/// Every message's key and its leading word (`q12`, `r12`), oldest first.
fn rows(s: &SessionSnapshot) -> Vec<(u64, String)> {
    s.items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Message { text, .. } => {
                Some((i.id, text.split(' ').next().unwrap_or("").to_owned()))
            }
            _ => None,
        })
        .collect()
}

fn earlier(s: &SessionSnapshot) -> EarlierHistory {
    s.observed.as_ref().expect("observed").earlier
}

fn word(n: usize, who: char) -> String {
    format!("{}{n}", if who == 'u' { 'q' } else { 'r' })
}

#[test]
fn a_long_log_opens_at_its_end_and_older_turns_load_above_with_the_same_keys() {
    let rig = Rig::new();
    long_log(&rig, 0, 450); // about 900 KB: the tail read is 192 KB
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), Pane::new(rig.located()))
        .expect("observe");
    let first = eventually("the tail", || {
        let s = chat.snapshot();
        (s.phase == SessionPhase::Idle && !rows(&s).is_empty()).then_some(s)
    });
    let shown = rows(&first);
    assert!(shown.len() < 450, "only the end of the log is read");
    assert_eq!(shown.last().expect("last").1, word(449, 'a'));
    assert_eq!(earlier(&first), EarlierHistory::Available);
    assert_eq!(chat.earlier(), EarlierHistory::Available);

    assert!(chat.load_earlier());
    // A second press while one runs begins nothing.
    assert!(!chat.load_earlier());
    let second = eventually("a wider read", || {
        let s = chat.snapshot();
        (rows(&s).len() > shown.len()).then_some(s)
    });
    let now = rows(&second);
    // The older turns are above; what was shown is the end of what is shown now, under the same keys.
    assert_eq!(&now[now.len() - shown.len()..], shown.as_slice());
    assert!(now.windows(2).all(|w| w[0].0 < w[1].0), "keys ascend");
    assert!(now[0].0 < shown[0].0, "older rows take keys below");
    assert_eq!(earlier(&second), EarlierHistory::Available);

    // Wider again: the start of the file is reached, so there is nothing more to load.
    assert!(chat.load_earlier());
    let third = eventually("the whole log", || {
        let s = chat.snapshot();
        (rows(&s).len() == 900).then_some(s)
    });
    let all = rows(&third);
    assert_eq!(all[0].1, word(0, 'u'));
    assert_eq!(&all[all.len() - now.len()..], now.as_slice());
    assert_eq!(earlier(&third), EarlierHistory::None);
    assert!(!chat.load_earlier());
}

#[test]
fn a_log_longer_than_the_widest_read_says_so_and_does_not_try_again() {
    let rig = Rig::with(ObservedConfig {
        tail_start: 16 * 1024,
        tail_max: 64 * 1024,
        ..fast()
    });
    long_log(&rig, 0, 150); // about 300 KB
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), Pane::new(rig.located()))
        .expect("observe");
    let first = eventually("the tail", || {
        let s = chat.snapshot();
        (!rows(&s).is_empty()).then_some(s)
    });
    assert_eq!(earlier(&first), EarlierHistory::Available);
    let before = rows(&first).len();
    assert!(chat.load_earlier());
    let second = eventually("the widest read", || {
        let s = chat.snapshot();
        (rows(&s).len() > before).then_some(s)
    });
    assert_eq!(earlier(&second), EarlierHistory::TooLong);
    assert!(!chat.load_earlier());
}

#[test]
fn lines_the_agent_writes_during_a_wider_read_arrive_once_and_in_order() {
    let rig = Rig::new();
    long_log(&rig, 0, 450);
    let chat = rig
        .hub
        .observe(LOCAL, "w1:p1", kind(false), Pane::new(rig.located()))
        .expect("observe");
    eventually("the tail", || {
        (!rows(&chat.snapshot()).is_empty()).then_some(())
    });
    assert!(chat.load_earlier());
    // The agent keeps writing while the older turns are read, and after.
    for i in 450..460 {
        long_log(&rig, i, 1);
        std::thread::sleep(Duration::from_millis(5));
    }
    let done = eventually("the appended turns", || {
        let s = chat.snapshot();
        let r = rows(&s);
        (r.last().is_some_and(|l| l.1 == word(459, 'a')) && earlier(&s) != EarlierHistory::Loading)
            .then_some(r)
    });
    let words: Vec<&str> = done.iter().map(|r| r.1.as_str()).collect();
    let mut unique = words.clone();
    unique.dedup();
    assert_eq!(words, unique, "no row is repeated");
    let at = |w: String| words.iter().position(|x| *x == w).expect("row");
    assert!(at(word(449, 'a')) < at(word(450, 'u')) && at(word(450, 'u')) < at(word(459, 'a')));
    // Contiguous: every turn from the first shown to 459 is there once.
    let first: usize = words[0][1..].parse().expect("number");
    let expect: Vec<String> = (first..460)
        .flat_map(|n| [word(n, 'u'), word(n, 'a')])
        .collect();
    let skip = usize::from(words[0].starts_with('r'));
    assert_eq!(
        words,
        expect
            .iter()
            .skip(skip)
            .map(String::as_str)
            .collect::<Vec<_>>()
    );
}
