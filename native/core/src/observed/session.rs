//! One observed session: an agent in a herdr pane, shown as a chat built from its own session log.
//!
//! Two threads. The **follower** finds the log (the kind's locator), follows it through the keeper's `follow`
//! command (a child process on this computer, or on another over the ControlMaster) and sends what it reads to
//! the **worker**, which maps lines to [`Update`]s, applies them to the transcript, and publishes immutable
//! [`SessionSnapshot`]s, as a keeper session's thread does. A burst of lines is one snapshot.
//!
//! The person's hand is the pane. Text goes in with [`PaneIo::send_input`] (what the agent's own composer
//! takes) and the log says whether it arrived; a question the agent's question tool asked is answered by keys,
//! one screen at a time ([`AskDriver`]), and the log has the last word on what was recorded. Approvals are the
//! terminal's own prompts and are answered through the pane (`Herdr.answer`), not here. Nothing is sent on a
//! timer or by default.

use std::collections::HashMap;
use std::io::BufReader;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, unbounded};
use parking_lot::{Condvar, Mutex};

use super::kinds::ObservedKind;
use super::model::{AskAnswer, Location, LogMapper, PendingAsk, Update};
use crate::schema::AgentStatus;
use crate::session::adapter::{ObservedMeta, ObservedTranscript, picture_ref};
use crate::session::{
    Ask, Attach, AttachLines, BackgroundView, FieldAnswer, FieldChoice, FieldKind, ItemKind,
    KeeperHost, ObservedInfo, ObservedLink, ProposedPlanView, QuestionField, QuestionView, Refusal,
    SendOutcome, SessionPhase, SessionSnapshot, SubagentView, Waiting,
};

/// An answer within this long of its question appearing is refused: that press was meant for what was on
/// screen before.
const ANSWER_GUARD_MS: u64 = 400;

/// What the pane is, as far as herdr says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneState {
    /// herdr no longer lists the pane (its machine answers, so it is really gone).
    Gone,
    /// The pane is there but nothing in it is an agent any more.
    NotAgent,
    /// An agent runs in it.
    Agent {
        /// What it is doing.
        status: AgentStatus,
        /// Its folder.
        cwd: Option<String>,
        /// The terminal's title.
        title: Option<String>,
    },
}

/// The pane an observed session reads and types into. Implemented by whoever owns the machine's herdr link.
pub trait PaneIo: Send + Sync {
    /// The pane now (a cheap read of what herdr last said).
    fn state(&self) -> PaneState;

    /// Where the agent's log is, by the kind's locator (the implementor holds what a locator needs).
    fn locate(&self, locator: &dyn super::model::Locator) -> Location;

    /// The pane's visible text now (about 60 rows, plain).
    fn read_screen(&self) -> Result<String, String>;

    /// Types `text` (bracketed-paste aware, no Enter), then presses `keys`. Either may be empty.
    fn send_input(&self, text: &str, keys: &[String]) -> Result<(), String>;

    /// Presses keys by herdr's names.
    fn send_keys(&self, keys: &[String]) -> Result<(), String>;

    /// Up to `limit` bytes of a file on the pane's machine (an omp picture), `None` when it is not there.
    fn read_file(&self, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String>;
}

/// Timing and limits. The defaults are herdr-mobile's; tests shorten them.
#[derive(Debug, Clone)]
pub struct ObservedConfig {
    /// How often the pane is looked at when no line arrives.
    pub poll_every: Duration,
    /// How long the log gets to show a message or an answer that was sent.
    pub confirm_within: Duration,
    /// How long a problem is shown.
    pub problem_hold: Duration,
    /// First wait between two looks for a log that does not exist yet; it doubles to `locate_max`.
    pub locate_every: Duration,
    /// The longest of those waits.
    pub locate_max: Duration,
    /// Waits between two attempts to reach a log that dropped; the last repeats.
    pub backoff: Vec<Duration>,
    /// Attempts before the log is given up on.
    pub max_attempts: usize,
    /// The most keys-and-reads an answer to a question may take.
    pub max_ask_steps: usize,
}

impl Default for ObservedConfig {
    fn default() -> Self {
        Self {
            poll_every: Duration::from_millis(500),
            confirm_within: Duration::from_secs(10),
            problem_hold: Duration::from_secs(12),
            locate_every: Duration::from_secs(5),
            locate_max: Duration::from_secs(30),
            backoff: [1, 2, 4, 8, 15, 30].map(Duration::from_secs).to_vec(),
            max_attempts: 12,
            max_ask_steps: 25,
        }
    }
}

enum Input {
    /// A mapped log line (without its offset).
    Line(String),
    /// The file shrank or was replaced: rebuild.
    Reset,
    /// Where the tail read began; more than 0 means earlier turns exist.
    Head(u64),
    /// Everything the file held has been read: what follows is what the agent appends.
    CaughtUp,
    Link(ObservedLink),
    /// A message was typed into the pane: the log should show it.
    Sent(String),
    Problem(String),
    /// The log cannot be read and trying again will not help.
    FollowFailed(String),
    Stop,
}

struct Shared {
    snapshot: Mutex<Arc<SessionSnapshot>>,
    changed: Condvar,
    alive: AtomicBool,
    pending: Mutex<Option<PendingAsk>>,
    log_path: Mutex<Option<String>>,
    /// An answer is being sent: a second one waits for it to finish.
    busy: AtomicBool,
    started: Instant,
    /// The follow child, to end it without waiting for its next line.
    child: Mutex<Option<Arc<crate::ssh::Proc>>>,
}

/// An observed session. Cloning shares it; the threads stop when the last clone is dropped or
/// [`detach`](Self::detach) is called.
#[derive(Clone)]
pub struct ObservedHandle {
    inner: Arc<Inner>,
}

struct Inner {
    machine: String,
    pane: String,
    kind: &'static ObservedKind,
    io: Arc<dyn PaneIo>,
    host: Arc<KeeperHost>,
    config: ObservedConfig,
    inputs: Sender<Input>,
    stop: Sender<()>,
    shared: Arc<Shared>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Inner {
    fn shutdown(&self) {
        let _ = self.stop.send(());
        let _ = self.inputs.send(Input::Stop);
        if let Some(child) = self.shared.child.lock().take() {
            child.kill();
        }
        let threads: Vec<_> = self.threads.lock().drain(..).collect();
        for thread in threads {
            let _ = thread.join();
        }
        self.shared.alive.store(false, Ordering::Release);
    }
}

impl ObservedHandle {
    /// Starts reading the pane's log. `on_change` is called from the worker after every published snapshot;
    /// it must not block.
    pub fn open(
        host: Arc<KeeperHost>,
        machine: &str,
        pane: &str,
        kind: &'static ObservedKind,
        io: Arc<dyn PaneIo>,
        config: ObservedConfig,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<ObservedHandle, String> {
        let (inputs, rx) = unbounded();
        let (stop, stop_rx) = unbounded();
        let shared = Arc::new(Shared {
            snapshot: Mutex::new(Arc::new(placeholder(kind, pane))),
            changed: Condvar::new(),
            alive: AtomicBool::new(true),
            pending: Mutex::new(None),
            log_path: Mutex::new(None),
            busy: AtomicBool::new(false),
            started: Instant::now(),
            child: Mutex::new(None),
        });
        let worker = Worker {
            kind,
            pane: pane.to_owned(),
            io: io.clone(),
            config: config.clone(),
            shared: shared.clone(),
            on_change,
            mapper: (kind.new_mapper)(),
            transcript: ObservedTranscript::default(),
            link: ObservedLink::Locating("Looking for the agent’s log".to_owned()),
            caught_up: false,
            failed: false,
            stop: stop.clone(),
            head: 0,
            sent: Vec::new(),
            problem: None,
            arrived: HashMap::new(),
            last_state: None,
        };
        let follower = Follower {
            kind,
            io: io.clone(),
            host: host.clone(),
            config: config.clone(),
            shared: shared.clone(),
            inputs: inputs.clone(),
            stop: stop_rx,
        };
        let spawn = |name: String, body: Box<dyn FnOnce() + Send>| {
            std::thread::Builder::new()
                .name(name)
                .spawn(body)
                .map_err(|e| format!("Could not start a thread: {e}"))
        };
        let threads = vec![
            spawn(
                format!("herdr-observed-{pane}"),
                Box::new(move || worker.run(&rx)),
            )?,
            spawn(
                format!("herdr-observed-follow-{pane}"),
                Box::new(move || follower.run()),
            )?,
        ];
        Ok(ObservedHandle {
            inner: Arc::new(Inner {
                machine: machine.to_owned(),
                pane: pane.to_owned(),
                kind,
                io,
                host,
                config,
                inputs,
                stop,
                shared,
                threads: Mutex::new(threads),
            }),
        })
    }

    /// The machine the pane is on.
    pub fn machine(&self) -> &str {
        &self.inner.machine
    }

    /// The pane's id.
    pub fn pane(&self) -> &str {
        &self.inner.pane
    }

    /// The conversation as it stands. Cheap: an `Arc` clone.
    pub fn snapshot(&self) -> Arc<SessionSnapshot> {
        self.inner.shared.snapshot.lock().clone()
    }

    /// Whether the session still reads: it ends with its pane, or when the log cannot be read.
    pub fn is_open(&self) -> bool {
        self.inner.shared.alive.load(Ordering::Acquire)
    }

    /// Waits until `done(snapshot)` holds or `timeout` passes; whether it held.
    fn wait_for(&self, timeout: Duration, done: impl Fn(&SessionSnapshot) -> bool) -> bool {
        let shared = &self.inner.shared;
        let deadline = Instant::now() + timeout;
        let mut snapshot = shared.snapshot.lock();
        loop {
            if done(&snapshot) {
                return true;
            }
            if shared
                .changed
                .wait_until(&mut snapshot, deadline)
                .timed_out()
            {
                return done(&snapshot);
            }
        }
    }

    fn now_ms(&self) -> u64 {
        u64::try_from(self.inner.shared.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Types a message into the pane's own composer and presses Enter, as the person would. The agent takes it
    /// at once (omp steers a running turn; Claude Code and Codex read it after the current tool call). Refused,
    /// nothing typed, while a question waits (answer it first) or the terminal needs the person.
    pub fn send(&self, text: &str) -> Result<SendOutcome, Refusal> {
        let text = text.trim_end();
        if text.trim().is_empty() {
            return Err(Refusal::Invalid("There is nothing to send".into()));
        }
        let snapshot = self.snapshot();
        if matches!(snapshot.phase, SessionPhase::Ended(_)) {
            return Err(Refusal::Ended);
        }
        if snapshot.needs_you() {
            return Err(Refusal::Blocked("Answer the question above first".into()));
        }
        match self.inner.io.state() {
            PaneState::Gone | PaneState::NotAgent => return Err(Refusal::Ended),
            PaneState::Agent {
                status: AgentStatus::Blocked,
                ..
            } => return Err(Refusal::Blocked("Needs you in the terminal".into())),
            PaneState::Agent { .. } => {}
        }
        self.inner
            .io
            .send_input(text, &["enter".to_owned()])
            .map_err(Refusal::Blocked)?;
        let _ = self.inner.inputs.send(Input::Sent(text.to_owned()));
        Ok(SendOutcome::Sent)
    }

    /// Presses Esc in the pane while the agent works: it interrupts the turn. Refused when nothing runs (an Esc
    /// that finds the agent idle does nothing good).
    pub fn stop(&self) -> Result<(), Refusal> {
        match self.inner.io.state() {
            PaneState::Agent {
                status: AgentStatus::Working,
                ..
            } => self
                .inner
                .io
                .send_keys(&["esc".to_owned()])
                .map_err(Refusal::Blocked),
            PaneState::Gone | PaneState::NotAgent => Err(Refusal::Ended),
            PaneState::Agent { .. } => Err(Refusal::NothingWaiting),
        }
    }

    /// Answers the question the person was shown, every field at once, by keys into the agent's dialog. Sends
    /// only if `request_id` and `digest` are the ones that wait, never within 400 ms of the question appearing,
    /// and only keys the screen shows are right for; then waits for the log to record the answer and checks it
    /// says what the person answered.
    pub fn answer_question(
        &self,
        request_id: &str,
        digest: &str,
        answers: &[FieldAnswer],
    ) -> Result<(), Refusal> {
        let Some(driver) = self.inner.kind.ask else {
            return Err(Refusal::Blocked(
                "This agent’s questions are answered in the terminal.".into(),
            ));
        };
        let shared = &self.inner.shared;
        if shared.busy.swap(true, Ordering::AcqRel) {
            return Err(Refusal::Busy);
        }
        let result = self.answer_with(driver, request_id, digest, answers);
        shared.busy.store(false, Ordering::Release);
        result
    }

    fn answer_with(
        &self,
        driver: &'static dyn super::model::AskDriver,
        request_id: &str,
        digest: &str,
        answers: &[FieldAnswer],
    ) -> Result<(), Refusal> {
        let snapshot = self.snapshot();
        let waiting = snapshot.waiting.first().ok_or(Refusal::NothingWaiting)?;
        if waiting.request_id != request_id || waiting.digest != digest {
            return Err(Refusal::Changed);
        }
        if self.now_ms().saturating_sub(waiting.arrived_ms) < ANSWER_GUARD_MS {
            return Err(Refusal::TooSoon);
        }
        let ask = self
            .inner
            .shared
            .pending
            .lock()
            .clone()
            .ok_or(Refusal::NothingWaiting)?;
        let answers = ask_answers(&ask, answers)?;
        let not_taken =
            || Refusal::Blocked("The terminal didn’t take that answer. Open the terminal.".into());
        let mut step = driver.stepper(&ask, &answers);
        let mut submitted = false;
        for _ in 0..self.inner.config.max_ask_steps {
            if submitted {
                break;
            }
            let screen = self.inner.io.read_screen().map_err(Refusal::Blocked)?;
            match step(&screen) {
                super::model::AskStep::Done => submitted = true,
                super::model::AskStep::Mismatch(_) => return Err(not_taken()),
                super::model::AskStep::Send {
                    keys,
                    text,
                    submits,
                    ..
                } => {
                    self.inner
                        .io
                        .send_input(text.as_deref().unwrap_or(""), &keys)
                        .map_err(Refusal::Blocked)?;
                    submitted = submits;
                }
            }
        }
        if !submitted {
            return Err(not_taken());
        }
        // The log has the last word: the tool's result line, with the answer.
        let id = request_id.to_owned();
        let recorded = self.wait_for(self.inner.config.confirm_within, |s| {
            s.waiting.iter().all(|w| w.request_id != id)
        });
        if !recorded {
            return Err(not_taken());
        }
        let output = tool_output(&self.snapshot(), &ask.tool_call_id);
        if !driver.result_matches(output.as_deref(), &ask, &answers) {
            let _ = self.inner.inputs.send(Input::Problem(
                "The terminal recorded a different answer than the one you gave. Check the terminal.".into(),
            ));
        }
        Ok(())
    }

    /// Declines the question with Esc, which cancels the whole tool call: sent only while the agent's dialog
    /// is on the screen, because an Esc that finds the agent working interrupts its turn.
    pub fn dismiss(&self, request_id: &str, digest: &str) -> Result<(), Refusal> {
        let Some(driver) = self.inner.kind.ask else {
            return Err(Refusal::Blocked(
                "This agent’s questions are answered in the terminal.".into(),
            ));
        };
        let snapshot = self.snapshot();
        let waiting = snapshot.waiting.first().ok_or(Refusal::NothingWaiting)?;
        if waiting.request_id != request_id || waiting.digest != digest {
            return Err(Refusal::Changed);
        }
        if self.now_ms().saturating_sub(waiting.arrived_ms) < ANSWER_GUARD_MS {
            return Err(Refusal::TooSoon);
        }
        let screen = self.inner.io.read_screen().map_err(Refusal::Blocked)?;
        if !driver.looks_like_ask(&screen) {
            return Err(Refusal::Changed);
        }
        self.inner
            .io
            .send_keys(&["esc".to_owned()])
            .map_err(Refusal::Blocked)
    }

    /// The bytes of a picture of the chat (`ImageRef::source`): from the keeper (a picture it left out of a
    /// log line) or from omp's `blobs/` folder. At most 20 MB.
    pub fn log_picture(&self, source: &str) -> Result<Vec<u8>, String> {
        const LIMIT: usize = 20 * 1024 * 1024;
        let reference = picture_ref(source).ok_or("That is not a picture reference.")?;
        let path = self
            .inner
            .shared
            .log_path
            .lock()
            .clone()
            .ok_or("The picture is no longer on the machine.")?;
        let bytes = match reference {
            super::model::PictureRef::Keeper { start, hash, .. } => self
                .inner
                .host
                .blob(&path, start, &hash)
                .map_err(|e| e.message())?,
            super::model::PictureRef::Omp { sha256, .. } => {
                // omp keeps a picture as a plain file next to its `sessions/` folder.
                let at = path
                    .rfind("/sessions/")
                    .ok_or("The picture is no longer on the machine.")?;
                let file = format!("{}/blobs/{sha256}", &path[..at]);
                self.inner
                    .io
                    .read_file(&file, LIMIT + 1)?
                    .ok_or("The picture is no longer on the machine.")?
            }
        };
        if bytes.len() > LIMIT {
            return Err("Too large to show here.".into());
        }
        Ok(bytes)
    }

    /// Stops reading. The agent in the pane is not touched.
    pub fn detach(&self) {
        self.inner.shutdown();
    }
}

/// What a snapshot shows before the worker has said anything.
fn placeholder(kind: &ObservedKind, pane: &str) -> SessionSnapshot {
    let mut transcript = ObservedTranscript::default();
    transcript.snapshot(ObservedMeta {
        phase: SessionPhase::Connecting,
        agent: kind.id.to_owned(),
        cwd: String::new(),
        fallback_title: None,
        waiting: Vec::new(),
        running: false,
        info: ObservedInfo {
            pane_id: pane.to_owned(),
            kind: kind.id.to_owned(),
            label: kind.label.to_owned(),
            log_path: None,
            link: ObservedLink::Locating("Looking for the agent’s log".to_owned()),
            turn_ended: false,
            subagents: Vec::new(),
            background: Vec::new(),
            proposed_plan: None,
            earlier_in_log: false,
            problem: None,
            answers_questions: kind.ask.is_some(),
        },
    })
}

/// The answers a person gave to a question's fields as the drivers take them.
fn ask_answers(ask: &PendingAsk, answers: &[FieldAnswer]) -> Result<Vec<AskAnswer>, Refusal> {
    if answers.len() != ask.questions.len() {
        return Err(Refusal::Invalid(
            "There is one answer per question".to_owned(),
        ));
    }
    ask.questions
        .iter()
        .zip(answers)
        .map(|(q, a)| {
            let selected: Vec<usize> = if q.multi {
                a.ticked.clone().unwrap_or_default()
            } else {
                a.choice.into_iter().collect()
            };
            if selected.iter().any(|i| *i >= q.options.len()) {
                return Err(Refusal::NoSuchOption);
            }
            let custom = a.text.clone().filter(|t| !t.trim().is_empty());
            if selected.is_empty() && custom.is_none() {
                return Err(Refusal::Invalid(format!("{}: Required", q.question)));
            }
            Ok(AskAnswer { selected, custom })
        })
        .collect()
}

/// What a tool call printed, as recorded in the snapshot (head, then tail).
fn tool_output(snapshot: &SessionSnapshot, tool_call_id: &str) -> Option<String> {
    snapshot.items.iter().find_map(|item| match &item.kind {
        ItemKind::Tool(t) if t.id == tool_call_id => {
            let lines: Vec<&str> = t.head.iter().chain(&t.tail).map(String::as_str).collect();
            (!lines.is_empty()).then(|| lines.join("\n"))
        }
        _ => None,
    })
}

// ---- the worker ---------------------------------------------------------------------------------

struct Worker {
    kind: &'static ObservedKind,
    pane: String,
    io: Arc<dyn PaneIo>,
    config: ObservedConfig,
    shared: Arc<Shared>,
    on_change: Arc<dyn Fn() + Send + Sync>,
    mapper: Box<dyn LogMapper>,
    transcript: ObservedTranscript,
    link: ObservedLink,
    caught_up: bool,
    /// The log cannot be read for good.
    failed: bool,
    stop: Sender<()>,
    head: u64,
    /// Messages typed into the pane that the log has not shown yet, with when to give up waiting.
    sent: Vec<(String, Instant)>,
    problem: Option<(String, Instant)>,
    /// Question tool call id -> when it first appeared (ms since the session began).
    arrived: HashMap<String, u64>,
    last_state: Option<PaneState>,
}

impl Worker {
    fn run(mut self, rx: &Receiver<Input>) {
        self.publish();
        loop {
            let mut dirty = false;
            match rx.recv_timeout(self.config.poll_every) {
                Ok(Input::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(input) => {
                    dirty |= self.handle(input);
                    // A burst is one snapshot: everything already queued is taken before publishing.
                    while let Ok(more) = rx.try_recv() {
                        if matches!(more, Input::Stop) {
                            self.finish();
                            return;
                        }
                        dirty |= self.handle(more);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            dirty |= self.look_at_the_pane();
            if dirty {
                self.publish();
            }
            if self.over() {
                break;
            }
        }
        self.finish();
    }

    /// The pane is gone or its agent left, or the log cannot be read: nothing more will come.
    fn over(&self) -> bool {
        matches!(self.last_state, Some(PaneState::Gone | PaneState::NotAgent)) || self.failed
    }

    fn finish(&self) {
        let _ = self.stop.send(());
        if let Some(child) = self.shared.child.lock().take() {
            child.kill();
        }
        self.shared.alive.store(false, Ordering::Release);
    }

    /// Applies one input; whether the snapshot changed.
    fn handle(&mut self, input: Input) -> bool {
        match input {
            Input::Line(line) => {
                for update in self.mapper.map(&line) {
                    self.apply(update);
                }
                self.confirm_sent();
                true
            }
            Input::Reset => {
                self.mapper.reset();
                self.transcript.apply(Update::Cleared);
                self.caught_up = false;
                self.head = 0;
                true
            }
            Input::Head(offset) => {
                self.head = offset;
                true
            }
            Input::CaughtUp => {
                self.caught_up = true;
                true
            }
            Input::Link(link) => {
                if self.link == link {
                    return false;
                }
                self.link = link;
                true
            }
            Input::Sent(text) => {
                self.sent
                    .push((text, Instant::now() + self.config.confirm_within));
                false
            }
            Input::FollowFailed(why) => {
                self.failed = true;
                self.link = ObservedLink::Failed(why);
                true
            }
            Input::Problem(text) => {
                self.problem = Some((text, Instant::now() + self.config.problem_hold));
                true
            }
            Input::Stop => false,
        }
    }

    fn apply(&mut self, update: Update) {
        self.transcript.apply(update);
    }

    /// A message the person typed shows up in the log: it arrived. One that does not within the time is said.
    fn confirm_sent(&mut self) {
        if self.sent.is_empty() {
            return;
        }
        let seen = self.snapshot_texts();
        self.sent
            .retain(|(text, _)| !seen.iter().any(|t| t.trim_end() == text.trim_end()));
    }

    fn snapshot_texts(&self) -> Vec<String> {
        self.transcript.recent_user_texts(20)
    }

    /// Looks at the pane and the clocks; whether the snapshot changed.
    fn look_at_the_pane(&mut self) -> bool {
        let mut changed = false;
        let state = self.io.state();
        if self.last_state.as_ref() != Some(&state) {
            self.last_state = Some(state.clone());
            changed = true;
        }
        let now = Instant::now();
        if let Some((_, until)) = &self.problem
            && *until <= now
        {
            self.problem = None;
            changed = true;
        }
        if self.sent.iter().any(|(_, deadline)| *deadline <= now) {
            self.sent.retain(|(_, deadline)| *deadline > now);
            self.problem = Some((
                "The terminal may not have taken that message. Check the terminal.".to_owned(),
                now + self.config.problem_hold,
            ));
            changed = true;
        }
        changed
    }

    fn publish(&mut self) {
        let snapshot = Arc::new(self.build());
        *self.shared.pending.lock() = self.mapper.pending_ask();
        *self.shared.snapshot.lock() = snapshot;
        self.shared.changed.notify_all();
        (self.on_change)();
    }

    fn build(&mut self) -> SessionSnapshot {
        let state = self.last_state.clone().unwrap_or_else(|| self.io.state());
        let pending = self.mapper.pending_ask();
        let now_ms = u64::try_from(self.shared.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        // A question counts from the moment it was first seen.
        if let Some(p) = &pending {
            self.arrived.entry(p.tool_call_id.clone()).or_insert(now_ms);
        }
        self.arrived
            .retain(|id, _| pending.as_ref().is_some_and(|p| &p.tool_call_id == id));
        let waiting: Vec<Waiting> = match (&pending, self.kind.ask) {
            (Some(p), Some(_)) => vec![question_waiting(
                p,
                self.arrived.get(&p.tool_call_id).copied().unwrap_or(now_ms),
            )],
            _ => Vec::new(),
        };
        let (cwd, pane_title, status) = match &state {
            PaneState::Agent { status, cwd, title } => (
                cwd.clone().unwrap_or_default(),
                title.clone(),
                Some(*status),
            ),
            PaneState::Gone | PaneState::NotAgent => (String::new(), None, None),
        };
        let link = match &state {
            PaneState::Gone => ObservedLink::Ended("herdr no longer lists this pane.".to_owned()),
            PaneState::NotAgent => ObservedLink::Ended(format!(
                "{} isn’t running in this pane any more.",
                self.kind.label
            )),
            PaneState::Agent { .. } => self.link.clone(),
        };
        let phase = if let ObservedLink::Ended(why) = &link {
            SessionPhase::Ended(why.clone())
        } else if !waiting.is_empty() {
            SessionPhase::BlockedOnQuestion
        } else if matches!(self.link, ObservedLink::Following) && !self.caught_up {
            SessionPhase::Connecting
        } else {
            match status {
                Some(AgentStatus::Blocked) => SessionPhase::BlockedOnPermission,
                Some(AgentStatus::Working) => SessionPhase::Working,
                _ => SessionPhase::Idle,
            }
        };
        let fallback = pane_title
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
            .or_else(|| {
                let folder = crate::board::folder_name(Some(&cwd));
                (!folder.is_empty()).then_some(folder)
            })
            .or_else(|| Some(self.kind.label.to_owned()));
        let info = ObservedInfo {
            pane_id: self.pane.clone(),
            kind: self.kind.id.to_owned(),
            label: self.kind.label.to_owned(),
            log_path: self.shared.log_path.lock().clone(),
            link,
            turn_ended: self.mapper.turn_ended(),
            subagents: self
                .mapper
                .subagents()
                .into_iter()
                .map(|s| SubagentView {
                    name: s.name,
                    agent: s.agent,
                    status: s.status,
                    assignment: s.assignment,
                    tool_count: s.tool_count,
                    recent_tools: s.recent_tools,
                })
                .collect(),
            background: self
                .mapper
                .background_tasks()
                .into_iter()
                .map(|t| BackgroundView {
                    key: t.key(),
                    id: t.id.clone(),
                    kind: format!("{:?}", t.kind).to_lowercase(),
                    status: format!("{:?}", t.status).to_lowercase(),
                    title: t.title.clone(),
                    detail: t.detail.clone(),
                    active: t.status.is_active(),
                })
                .collect(),
            proposed_plan: self.mapper.proposed_plan().map(|p| ProposedPlanView {
                title: p.title,
                markdown: p.markdown,
            }),
            earlier_in_log: self.head > 0,
            problem: self.problem.as_ref().map(|(text, _)| text.clone()),
            answers_questions: self.kind.ask.is_some(),
        };
        self.transcript.snapshot(ObservedMeta {
            phase,
            agent: self.kind.id.to_owned(),
            cwd,
            fallback_title: fallback,
            waiting,
            running: status == Some(AgentStatus::Working),
            info,
        })
    }
}

/// The agent's question as the question form every session screen already draws.
fn question_waiting(ask: &PendingAsk, arrived_ms: u64) -> Waiting {
    let mut digest = String::new();
    for q in &ask.questions {
        digest.push_str(&q.id);
        digest.push('\u{1}');
        digest.push_str(&q.question);
        for o in &q.options {
            digest.push('\u{2}');
            digest.push_str(&o.label);
        }
    }
    let fields = ask
        .questions
        .iter()
        .map(|q| QuestionField {
            name: q.id.clone(),
            label: q.question.clone(),
            description: Some("Choose, or type your own answer in the text box.".to_owned()),
            required: true,
            secret: false,
            kind: if q.multi {
                FieldKind::Multi
            } else {
                FieldKind::Choice
            },
            integer: false,
            choices: q
                .options
                .iter()
                .map(|o| FieldChoice {
                    value: o.label.clone(),
                    title: if o.description.is_empty() {
                        o.label.clone()
                    } else {
                        format!("{} — {}", o.label, o.description)
                    },
                })
                .collect(),
            text: String::new(),
            choice: (!q.multi).then_some(q.recommended).flatten(),
            ticked: Vec::new(),
        })
        .collect();
    Waiting {
        request_id: serde_json::to_string(&ask.tool_call_id).unwrap_or_default(),
        digest: crate::observed::model::fnv(&digest),
        ask: Ask::Question(QuestionView {
            message: "The agent asks".to_owned(),
            description: None,
            fields,
        }),
        arrived_ms,
    }
}

// ---- the follower ---------------------------------------------------------------------------------

struct Follower {
    kind: &'static ObservedKind,
    io: Arc<dyn PaneIo>,
    host: Arc<KeeperHost>,
    config: ObservedConfig,
    shared: Arc<Shared>,
    inputs: Sender<Input>,
    stop: Receiver<()>,
}

/// How one `follow` ended.
enum Followed {
    /// The session was stopped.
    Stopped,
    /// The connection ended; whether any record came through, and what the command said when it said.
    Ended {
        got_records: bool,
        fatal: Option<String>,
    },
}

impl Follower {
    /// Sleeps `d`, or until the session stops; whether it stopped.
    fn stopped_within(&self, d: Duration) -> bool {
        !matches!(self.stop.recv_timeout(d), Err(RecvTimeoutError::Timeout))
    }

    fn say(&self, link: ObservedLink) {
        let _ = self.inputs.send(Input::Link(link));
    }

    fn run(self) {
        let mut attempt = 0usize;
        let mut locate_delay = self.config.locate_every;
        let mut followed: Option<String> = None;
        let mut offset: Option<u64> = None;
        loop {
            match self.io.locate(self.kind.locator) {
                Location::Unlinked(why) => {
                    self.say(ObservedLink::Failed(why));
                    // Waiting changes nothing the agent will say on its own; a later look may find it
                    // (the person installs the integration, the pane starts a session).
                    if self.stopped_within(self.config.locate_max) {
                        return;
                    }
                }
                Location::NotYet(why) => {
                    // The agent writes its file with the first message: wait, quietly. An empty chat, not
                    // a connection that never comes.
                    self.say(ObservedLink::Locating(why));
                    if self.stopped_within(locate_delay) {
                        return;
                    }
                    locate_delay = (locate_delay * 2).min(self.config.locate_max);
                }
                Location::Located(path) => {
                    locate_delay = self.config.locate_every;
                    if followed.as_deref() != Some(path.as_str()) {
                        if followed.is_some() {
                            // Another session: it opens at its end like any other.
                            let _ = self.inputs.send(Input::Reset);
                        }
                        followed = Some(path.clone());
                        offset = None;
                        *self.shared.log_path.lock() = Some(path.clone());
                    }
                    self.say(ObservedLink::Following);
                    match self.follow_once(&path, &mut offset) {
                        Followed::Stopped => return,
                        Followed::Ended { got_records, fatal } => {
                            if let Some(why) = fatal {
                                let _ = self.inputs.send(Input::FollowFailed(why));
                                return;
                            }
                            if got_records {
                                attempt = 0;
                            }
                        }
                    }
                    if attempt >= self.config.max_attempts {
                        let _ = self.inputs.send(Input::FollowFailed(
                            "The connection to the log kept dropping.".to_owned(),
                        ));
                        return;
                    }
                    self.say(ObservedLink::Locating("Reconnecting to the log".to_owned()));
                    let wait = self
                        .config
                        .backoff
                        .get(attempt)
                        .or(self.config.backoff.last())
                        .copied()
                        .unwrap_or(Duration::from_secs(1));
                    attempt += 1;
                    if self.stopped_within(wait) {
                        return;
                    }
                }
            }
        }
    }

    /// One `follow` command, read to its end.
    fn follow_once(&self, path: &str, offset: &mut Option<u64>) -> Followed {
        let mut conn: Attach = match self.host.follow(path, *offset, None) {
            Ok(conn) => conn,
            Err(e) if e.is_fatal() => {
                return Followed::Ended {
                    got_records: false,
                    fatal: Some(e.message()),
                };
            }
            Err(_) => {
                return Followed::Ended {
                    got_records: false,
                    fatal: None,
                };
            }
        };
        *self.shared.child.lock() = Some(conn.proc.clone());
        let Some(stdout) = conn.stdout.take() else {
            return Followed::Ended {
                got_records: false,
                fatal: None,
            };
        };
        let mut lines = AttachLines::new(BufReader::new(stdout), conn.zipped);
        let mut got_records = false;
        while let Ok(Some(line)) = lines.next_line() {
            got_records = true;
            match record(&line) {
                Record::Data { end, json } => {
                    *offset = Some(end);
                    if self.inputs.send(Input::Line(json.to_owned())).is_err() {
                        return Followed::Stopped;
                    }
                }
                Record::Head(at) => {
                    let _ = self.inputs.send(Input::Head(at));
                }
                Record::Reset(at) => {
                    *offset = Some(at);
                    let _ = self.inputs.send(Input::Reset);
                }
                Record::CaughtUp => {
                    let _ = self.inputs.send(Input::CaughtUp);
                }
                Record::Failed(why) => {
                    let _ = self
                        .inputs
                        .send(Input::Problem(format!("The log could not be read: {why}")));
                }
                Record::Other => {}
            }
        }
        *self.shared.child.lock() = None;
        if self.stop.try_recv().is_ok() {
            conn.close();
            return Followed::Stopped;
        }
        let exit = conn.proc.wait_exit(Duration::from_secs(3));
        conn.close();
        // 66: not a log under the home folder, or unreadable; 65, 78: no keeper here. None of these gets
        // better by trying again.
        let fatal = exit.as_ref().and_then(|e| match e.code {
            Some(code @ (64..=66 | 69 | 78)) => Some(
                crate::session::KeeperError::from_exit(code, &e.stderr, "read the log").message(),
            ),
            _ => None,
        });
        Followed::Ended { got_records, fatal }
    }
}

/// One record of `follow`'s output.
enum Record<'a> {
    /// A log line and the byte offset just after it.
    Data {
        end: u64,
        json: &'a str,
    },
    /// Where the tail read began.
    Head(u64),
    /// The file shrank or was replaced.
    Reset(u64),
    /// Everything the file held has been sent.
    CaughtUp,
    /// Reading failed.
    Failed(&'a str),
    Other,
}

fn record(line: &str) -> Record<'_> {
    let Some((head, rest)) = line.split_once('\t') else {
        return Record::Other;
    };
    match head {
        "S" => rest.trim().parse().map_or(Record::Other, Record::Head),
        "R" => rest.trim().parse().map_or(Record::Other, Record::Reset),
        "C" => Record::CaughtUp,
        "E" => Record::Failed(rest),
        number => match number.parse() {
            Ok(end) => Record::Data { end, json: rest },
            Err(_) => Record::Other,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follow_records_are_read_by_their_first_field() {
        assert!(matches!(
            record("120\t{\"a\":1}"),
            Record::Data {
                end: 120,
                json: "{\"a\":1}"
            }
        ));
        assert!(matches!(record("S\t0"), Record::Head(0)));
        assert!(matches!(record("R\t42"), Record::Reset(42)));
        assert!(matches!(record("C\t999"), Record::CaughtUp));
        assert!(matches!(record("E\tboom"), Record::Failed("boom")));
        assert!(matches!(record("garbage"), Record::Other));
        assert!(matches!(record("x\t1"), Record::Other));
    }
}
