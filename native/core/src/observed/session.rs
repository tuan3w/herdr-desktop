//! One observed session: an agent in a herdr pane, shown as a chat built from its own session log.
//!
//! Two threads. The **follower** finds the log (the kind's locator), follows it through the keeper's `follow`
//! command (a child process on this computer, or on another over the ControlMaster) and sends what it reads to
//! the **worker**, which maps lines to [`Update`]s, applies them to the transcript, and publishes immutable
//! [`SessionSnapshot`]s, as a keeper session's thread does. A burst of lines is one snapshot.
//!
//! A chat that was open before starts from the copy of its last records the follower saved ([`super::copy`]): the
//! follower shows it at once and asks the keeper only for what the log gained since (`follow --from`).
//!
//! The person's hand is the pane. Text goes in with [`PaneIo::send_input`] (what the agent's own composer
//! takes) and the log says whether it arrived; a question the agent's question tool asked is answered by keys,
//! one screen at a time ([`AskDriver`]), and the log has the last word on what was recorded. Approvals are the
//! terminal's own prompts and are answered through the pane (`Herdr.answer`), not here. Nothing is sent on a
//! timer or by default.

use std::collections::{HashMap, HashSet};
use std::io::BufReader;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, unbounded};
use parking_lot::{Condvar, Mutex};

use super::copy::{Saved, Window, unix_ms};
use super::kinds::ObservedKind;
use super::model::{
    AskAnswer, Location, LogMapper, PendingAsk, SlashCommand, SubagentInfo, Update,
};
use super::model::{BackgroundTask, StopRoute};
use super::subagent::SubagentLocator;
use crate::cache::{Cache, Key, Kind};
use crate::schema::AgentStatus;
use crate::session::adapter::{ObservedMeta, ObservedTranscript, picture_ref};
use crate::session::{
    Ask, Attach, AttachLines, BackgroundView, EarlierHistory, FieldAnswer, FieldChoice, FieldKind,
    ItemKind, KeeperHost, ObservedInfo, ObservedLink, ProposedPlanView, QuestionField,
    QuestionView, Refusal, SendOutcome, SessionPhase, SessionSnapshot, SubagentView, Waiting,
};

/// An answer within this long of its question appearing is refused: that press was meant for what was on
/// screen before.
const ANSWER_GUARD_MS: u64 = 400;

/// Subagent transcripts open at once per parent: each is another follow of a file on the machine.
const MAX_SUBAGENT_CHATS: usize = 2;

/// What a subagent's chat answers to anything that would type into a terminal.
const SUBAGENT_READ_ONLY: &str =
    "A subagent is steered through its parent agent: write to the parent, which relays it.";

/// How much of the head of a log is read for the commands the agent lists there (Claude writes its skills with
/// the session's first prompt): a first prompt longer than this hides them.
const HEAD_COMMANDS_BYTES: u64 = 512 * 1024;

/// A log read for a long time is saved at least this often (in records), not only when it caught up.
const SAVE_EVERY_RECORDS: usize = 256;

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

    /// The pane's machine's files, for the skills the agent reads from its folders; `None` where they cannot be
    /// read (a subagent's transcript, a test pane).
    fn files(&self) -> Option<Arc<dyn crate::files::Files>> {
        None
    }
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
    /// How much of the end of the log the first read takes (the keeper's default).
    pub tail_start: u64,
    /// The most of it a read takes after "load earlier" (the keeper's ceiling).
    pub tail_max: u64,
    /// How often the agent's skill folders are listed again (see [`super::skills`]).
    pub skills_every: Duration,
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
            tail_start: 192 * 1024,
            tail_max: 64 * 1024 * 1024,
            skills_every: Duration::from_secs(60),
        }
    }
}

enum Input {
    /// A mapped log line (without its offset).
    Line(String),
    /// The file shrank or was replaced, or the pane's agent writes another file now: rebuild.
    Reset,
    /// The skills the agent's folders hold now.
    DiskSkills(Vec<SlashCommand>),
    /// Where the tail read began; more than 0 means earlier turns exist.
    Head(u64),
    /// The commands listed at the head of the log, which a tail read did not reach.
    HeadCommands(Vec<SlashCommand>),
    /// A wider read of the log begins (or begins again): its lines are mapped beside what is shown and
    /// replace it when the read is whole. `keep_head`: the read's `Head` came just before.
    WideStart {
        keep_head: bool,
    },
    /// Something the worker should publish (a wider read was asked for).
    Refresh,
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
    /// How much of the end of the log a read from scratch takes; 4x wider for each `load_earlier`.
    tail: AtomicU64,
    /// A wider read was asked for and is not shown yet.
    widening: AtomicBool,
    /// The follow must end and start over from the end of the log, with `tail`.
    restart: AtomicBool,
    /// Where the part of the log that is shown begins (0: at its start).
    head: AtomicU64,
    /// The subagents as the log last described them (with the ids their transcripts are found by).
    subagents: Mutex<Vec<SubagentInfo>>,
    /// The background tasks as the log last described them.
    tasks: Mutex<Vec<BackgroundTask>>,
    /// When the conversation that is shown was saved (unix milliseconds), while what is shown is a saved copy and
    /// the log has not answered yet; 0 when it is not.
    cached_at_ms: AtomicU64,
}

/// Whether the log has turns that are not shown, and whether they can be had.
fn earlier_state(shared: &Shared, tail_max: u64) -> EarlierHistory {
    if shared.head.load(Ordering::Acquire) == 0 {
        EarlierHistory::None
    } else if shared.widening.load(Ordering::Acquire) {
        EarlierHistory::Loading
    } else if shared.tail.load(Ordering::Acquire) >= tail_max {
        EarlierHistory::TooLong
    } else {
        EarlierHistory::Available
    }
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
    on_change: Arc<dyn Fn() + Send + Sync>,
    /// The subagent this session reads, by name; `None` for an agent's own log.
    subagent: Option<String>,
    /// Subagent transcripts opened from this session, oldest first; they close with it.
    subs: Mutex<Vec<(String, ObservedHandle)>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Inner {
    fn shutdown(&self) {
        let subs: Vec<_> = self.subs.lock().drain(..).collect();
        for (_, sub) in subs {
            sub.detach();
        }
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
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        host: Arc<KeeperHost>,
        machine: &str,
        pane: &str,
        kind: &'static ObservedKind,
        io: Arc<dyn PaneIo>,
        config: ObservedConfig,
        on_change: Arc<dyn Fn() + Send + Sync>,
        cache: Arc<Cache>,
    ) -> Result<ObservedHandle, String> {
        Self::open_as(
            host, machine, pane, kind, io, config, on_change, None, cache,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn open_as(
        host: Arc<KeeperHost>,
        machine: &str,
        pane: &str,
        kind: &'static ObservedKind,
        io: Arc<dyn PaneIo>,
        config: ObservedConfig,
        on_change: Arc<dyn Fn() + Send + Sync>,
        subagent: Option<String>,
        cache: Arc<Cache>,
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
            tail: AtomicU64::new(config.tail_start),
            widening: AtomicBool::new(false),
            restart: AtomicBool::new(false),
            head: AtomicU64::new(0),
            subagents: Mutex::new(Vec::new()),
            tasks: Mutex::new(Vec::new()),
            cached_at_ms: AtomicU64::new(0),
        });
        let (skills_quit, skills_rx) = crossbeam_channel::bounded::<()>(0);
        let worker = Worker {
            kind,
            pane: pane.to_owned(),
            io: io.clone(),
            config: config.clone(),
            shared: shared.clone(),
            on_change: on_change.clone(),
            mapper: (kind.new_mapper)(),
            transcript: ObservedTranscript::default(),
            link: ObservedLink::Locating(
                if subagent.is_some() {
                    "Looking for the subagent’s transcript"
                } else {
                    "Looking for the agent’s log"
                }
                .to_owned(),
            ),
            caught_up: false,
            failed: false,
            stop: stop.clone(),
            wide: None,
            sent: Vec::new(),
            problem: None,
            arrived: HashMap::new(),
            last_state: None,
            read_only: subagent.is_some(),
            head_commands: None,
            disk_skills: Vec::new(),
            _skills_quit: skills_quit,
        };
        let key = cache.key(Kind::Observed, machine, pane);
        let follower = Follower {
            kind,
            io: io.clone(),
            host: host.clone(),
            config: config.clone(),
            shared: shared.clone(),
            inputs: inputs.clone(),
            stop: stop_rx,
            cache,
            key,
            window: Arc::new(Mutex::new(Window::default())),
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
        // Detached: it ends when the worker (and with it the sender it watches) is gone, and a scan of another
        // machine's folders must never hold up closing the chat.
        if let (None, Some(layout)) = (&subagent, super::skills::Layout::of(kind.id)) {
            let (io, inputs, every) = (io.clone(), inputs.clone(), config.skills_every);
            spawn(
                format!("herdr-observed-skills-{pane}"),
                Box::new(move || scan_skills(&*io, &inputs, &skills_rx, every, layout)),
            )?;
        }
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
                on_change,
                subagent,
                subs: Mutex::new(Vec::new()),
            }),
        })
    }

    /// Whether this session reads a subagent's transcript (read-only: it is steered through its parent).
    pub fn is_subagent(&self) -> bool {
        self.inner.subagent.is_some()
    }

    fn writable(&self) -> Result<(), Refusal> {
        match self.inner.subagent {
            Some(_) => Err(Refusal::Blocked(SUBAGENT_READ_ONLY.into())),
            None => Ok(()),
        }
    }

    /// Starts reading the transcript of the subagent named `name` (as the log names it in
    /// `observed.subagents`) as a read-only chat of its own, with the same mapper as its parent's log. An open
    /// one is returned as it is; at most [`MAX_SUBAGENT_CHATS`] are open (the oldest closes), and all close with
    /// this session. A transcript not written yet is an empty chat that waits (`locating`), not an error.
    pub fn open_subagent(&self, name: &str) -> Result<ObservedHandle, String> {
        if self.is_subagent() {
            return Err("A subagent’s own subagents are not shown.".into());
        }
        if let Some(open) = self.subagent(name) {
            return Ok(open);
        }
        if !self
            .inner
            .shared
            .subagents
            .lock()
            .iter()
            .any(|s| s.name == name)
        {
            return Err("The agent’s log no longer names that subagent.".into());
        }
        let kind = super::kinds::subagent_kind_for(self.inner.kind.id)
            .ok_or("This agent’s subagents have no transcript this app can read.")?;
        let mut config = self.inner.config.clone();
        if kind.id == "codex" {
            // Its first line says where its own part begins: the whole file is read, not its end.
            config.tail_start = config.tail_max;
        }
        let io = Arc::new(SubagentIo {
            parent: self.inner.io.clone(),
            shared: self.inner.shared.clone(),
            kind: self.inner.kind.id,
            name: name.to_owned(),
        });
        let handle = Self::open_as(
            self.inner.host.clone(),
            &self.inner.machine,
            &self.inner.pane,
            kind,
            io,
            config,
            self.inner.on_change.clone(),
            Some(name.to_owned()),
            // A subagent's transcript is a pane's second log under the pane's own id: it has no copy of its own.
            Arc::new(Cache::disabled()),
        )?;
        let mut subs = self.inner.subs.lock();
        subs.retain(|(_, h)| h.is_open());
        while subs.len() >= MAX_SUBAGENT_CHATS {
            let (_, oldest) = subs.remove(0);
            oldest.detach();
        }
        subs.push((name.to_owned(), handle.clone()));
        drop(subs);
        (self.inner.on_change)();
        Ok(handle)
    }

    /// The open transcript of the subagent named `name`.
    pub fn subagent(&self, name: &str) -> Option<ObservedHandle> {
        self.inner
            .subs
            .lock()
            .iter()
            .find(|(n, h)| n == name && h.is_open())
            .map(|(_, h)| h.clone())
    }

    /// Stops reading a subagent's transcript. The subagent is not touched.
    pub fn close_subagent(&self, name: &str) {
        let closed: Vec<_> = {
            let mut subs = self.inner.subs.lock();
            let (gone, kept) = subs.drain(..).partition(|(n, _)| n == name);
            *subs = kept;
            gone
        };
        for (_, h) in &closed {
            h.detach();
        }
        if !closed.is_empty() {
            (self.inner.on_change)();
        }
    }

    /// Asks the agent to stop the background task `key` (`observed.background[].key`, `stoppable`): a message
    /// typed into the pane in the agent's own words for it (its stop tool), as the person would, refused like
    /// any message while a question waits or the terminal needs the person. Nothing else is sent.
    pub fn stop_background(&self, key: &str) -> Result<(), Refusal> {
        self.writable()?;
        let tasks = self.inner.shared.tasks.lock().clone();
        let task = tasks
            .iter()
            .find(|t| t.key() == key)
            .ok_or(Refusal::NothingWaiting)?;
        if !task.status.is_active() {
            return Err(Refusal::NothingWaiting);
        }
        let text = stop_text(self.inner.kind.id, task)
            .ok_or_else(|| Refusal::Blocked("This task is stopped in the terminal.".into()))?;
        self.send(&text).map(|_| ())
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
        self.writable()?;
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
        self.writable()?;
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
        self.writable()?;
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
        self.writable()?;
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
    /// log line) or from omp's `blobs/` folder. At most 16 MiB, the cap a picture is shown at.
    pub fn log_picture(&self, source: &str) -> Result<Vec<u8>, String> {
        const LIMIT: usize = 16 * 1024 * 1024;
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

    /// Whether the log has turns that are not shown (see [`EarlierHistory`]).
    pub fn earlier(&self) -> EarlierHistory {
        earlier_state(&self.inner.shared, self.inner.config.tail_max)
    }

    /// Reads older turns: the log is read again from its end with a tail 4x as wide (up to
    /// `ObservedConfig::tail_max`), beside what is shown, which is replaced in one step when the wider read is
    /// whole. What is shown keeps its item keys, so a list holds its place and the older rows arrive above
    /// those in view. Nothing blocks: the follower thread starts the read. Whether one began (not while one
    /// runs, not at the log's start, not past the widest).
    pub fn load_earlier(&self) -> bool {
        let shared = &self.inner.shared;
        if !shared.alive.load(Ordering::Acquire)
            || shared.log_path.lock().is_none()
            || self.earlier() != EarlierHistory::Available
            || shared.widening.swap(true, Ordering::AcqRel)
        {
            return false;
        }
        let tail = shared.tail.load(Ordering::Acquire);
        shared.tail.store(
            tail.saturating_mul(4).min(self.inner.config.tail_max),
            Ordering::Release,
        );
        // The flag first: a follow that ends for any reason starts over instead of resuming.
        shared.restart.store(true, Ordering::Release);
        if let Some(child) = shared.child.lock().as_ref() {
            child.kill();
        }
        let _ = self.inner.inputs.send(Input::Refresh);
        true
    }

    /// Stops reading. The agent in the pane is not touched.
    pub fn detach(&self) {
        self.inner.shutdown();
    }
}

/// The message that asks an agent of kind `kind` to stop `task`, in its own words; `None` when the task offers no
/// stop by message or its id is not a plain token.
fn stop_text(kind: &str, task: &BackgroundTask) -> Option<String> {
    if task.stop != StopRoute::Message {
        return None;
    }
    let id = [task.id.as_str()];
    match kind {
        "omp" => super::omp::stop_message(id),
        "claude" => super::claude::stop_message(id),
        "codex" => super::codex::stop_message(id),
        _ => None,
    }
}

/// The pane as a subagent's chat sees it: the parent's pane for whether it is still there, the parent's log
/// for where the transcript is and whether it runs, and no hand on the terminal (it is steered through its
/// parent).
struct SubagentIo {
    parent: Arc<dyn PaneIo>,
    /// The parent session's shared state: its log path and its subagents as last described.
    shared: Arc<Shared>,
    /// The parent's kind id.
    kind: &'static str,
    name: String,
}

impl SubagentIo {
    fn info(&self) -> Option<SubagentInfo> {
        self.shared
            .subagents
            .lock()
            .iter()
            .find(|s| s.name == self.name)
            .cloned()
    }
}

impl PaneIo for SubagentIo {
    fn state(&self) -> PaneState {
        match self.parent.state() {
            PaneState::Agent { cwd, .. } => {
                let running = self.info().is_some_and(|s| {
                    matches!(s.status.as_str(), "running" | "inProgress" | "in_progress")
                });
                PaneState::Agent {
                    status: if running {
                        AgentStatus::Working
                    } else {
                        AgentStatus::Idle
                    },
                    cwd,
                    title: Some(self.name.clone()),
                }
            }
            other => other,
        }
    }

    fn locate(&self, _: &dyn super::model::Locator) -> Location {
        let Some(info) = self.info() else {
            return Location::Unlinked("The agent’s log no longer names this subagent.".to_owned());
        };
        let locator = SubagentLocator {
            kind: self.kind,
            parent_log: self.shared.log_path.lock().clone(),
            info,
        };
        // The parent's pane knows the machine: its files and its herdr.
        self.parent.locate(&locator)
    }

    fn read_screen(&self) -> Result<String, String> {
        Err(SUBAGENT_READ_ONLY.to_owned())
    }

    fn send_input(&self, _: &str, _: &[String]) -> Result<(), String> {
        Err(SUBAGENT_READ_ONLY.to_owned())
    }

    fn send_keys(&self, _: &[String]) -> Result<(), String> {
        Err(SUBAGENT_READ_ONLY.to_owned())
    }

    fn read_file(&self, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
        self.parent.read_file(path, limit)
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
            earlier: EarlierHistory::None,
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

/// A line that runs one of the agent's slash commands (`/compact`, `/skill:tdd the parser`), not a path the
/// person starts a sentence with (`/etc/hosts is wrong`).
fn is_slash_command(text: &str) -> bool {
    let word = text.split_whitespace().next().unwrap_or("");
    word.strip_prefix('/').is_some_and(|name| {
        name.chars().next().is_some_and(|c| c.is_alphanumeric()) && !name.contains('/')
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
    /// A wider read of the log under way. Shown in the meantime: what was there before, so nothing flickers
    /// or jumps while the older turns arrive.
    wide: Option<Wide>,
    /// Messages typed into the pane that the log has not shown yet, with when to give up waiting.
    sent: Vec<(String, Instant)>,
    problem: Option<(String, Instant)>,
    /// Question tool call id -> when it first appeared (ms since the session began).
    arrived: HashMap<String, u64>,
    last_state: Option<PaneState>,
    /// A subagent's transcript: nothing in it can be stopped from here.
    read_only: bool,
    /// The commands the head of the log listed (see [`LogMapper::adopt_commands`]), kept for a wider read's
    /// fresh mapper.
    head_commands: Option<Vec<SlashCommand>>,
    /// The skills the agent's folders hold (see [`super::skills`]): listed after the log's own commands, which win
    /// on the same name.
    disk_skills: Vec<SlashCommand>,
    /// Dropped with the worker: the skill scan sees it go and ends.
    _skills_quit: Sender<()>,
}

/// A wider read of the log, mapped from scratch beside what is shown.
struct Wide {
    mapper: Box<dyn LogMapper>,
    transcript: ObservedTranscript,
    head: Option<u64>,
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
            Input::Line(line) if self.wide.is_some() => {
                if let Some(wide) = &mut self.wide {
                    for update in wide.mapper.map(&line) {
                        wide.transcript.apply(update);
                    }
                }
                false
            }
            Input::Line(line) => {
                let mut wrote = false;
                for update in self.mapper.map(&line) {
                    wrote = true;
                    self.apply(update);
                }
                if wrote && self.caught_up {
                    // A slash command is run by the agent's own program, which writes what it did (omp's
                    // `/compact` a compaction, its `/clear` a reset) and often not the line typed: the log
                    // moving on after it is the answer. A command that writes nothing (a dialog in the
                    // terminal) is still called out.
                    self.sent.retain(|(text, _)| !is_slash_command(text));
                }
                self.confirm_sent();
                true
            }
            Input::Reset => {
                self.shared.cached_at_ms.store(0, Ordering::Release);
                self.mapper.reset();
                self.transcript.apply(Update::Cleared);
                self.caught_up = false;
                self.wide = None;
                self.head_commands = None;
                // The log a typed message was to be checked against is gone; a new one is what the message did
                // (`/clear`, `/new`, `/resume`), and nothing in it echoes the command.
                self.sent.clear();
                true
            }
            Input::DiskSkills(skills) => {
                self.disk_skills = skills;
                true
            }
            Input::HeadCommands(commands) => {
                for update in self.mapper.adopt_commands(commands.clone()) {
                    self.apply(update);
                }
                self.head_commands = Some(commands);
                true
            }
            Input::Head(offset) => {
                if let Some(wide) = &mut self.wide {
                    wide.head = Some(offset);
                    return false;
                }
                self.shared.head.store(offset, Ordering::Release);
                true
            }
            Input::WideStart { keep_head } => {
                let head = self
                    .wide
                    .as_ref()
                    .and_then(|w| w.head)
                    .filter(|_| keep_head);
                self.wide = Some(Wide {
                    mapper: (self.kind.new_mapper)(),
                    transcript: ObservedTranscript::default(),
                    head,
                });
                true
            }
            Input::Refresh => true,
            Input::CaughtUp => {
                self.shared.cached_at_ms.store(0, Ordering::Release);
                if let Some(wide) = self.wide.take() {
                    // The older turns are shown when all of them are there.
                    self.mapper = wide.mapper;
                    self.transcript.adopt(wide.transcript);
                    if let Some(commands) = self.head_commands.clone() {
                        for update in self.mapper.adopt_commands(commands) {
                            self.apply(update);
                        }
                    }
                    if let Some(head) = wide.head {
                        self.shared.head.store(head, Ordering::Release);
                    }
                    self.shared.widening.store(false, Ordering::Release);
                    self.confirm_sent();
                }
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
        // A copy shows what was asked once: nothing in it can still be answered.
        let cached_ms = self.shared.cached_at_ms.load(Ordering::Acquire);
        let waiting: Vec<Waiting> = match (&pending, self.kind.ask) {
            (Some(p), Some(_)) if cached_ms == 0 => vec![question_waiting(
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
        let subagents = self.mapper.subagents();
        let tasks = self.mapper.background_tasks();
        let ms = |t: Option<i64>| t.and_then(|t| u64::try_from(t).ok());
        let info = ObservedInfo {
            pane_id: self.pane.clone(),
            kind: self.kind.id.to_owned(),
            label: self.kind.label.to_owned(),
            log_path: self.shared.log_path.lock().clone(),
            link,
            turn_ended: self.mapper.turn_ended(),
            subagents: subagents
                .iter()
                .map(|s| {
                    // A subagent started in the background is also a task: its times and its stop are the task's.
                    let task = tasks.iter().find(|t| {
                        t.kind == super::model::BackgroundKind::Agent
                            && t.tool_call_id.is_some()
                            && t.tool_call_id == s.call_id
                    });
                    SubagentView {
                        name: s.name.clone(),
                        agent: s.agent.clone(),
                        status: s.status.clone(),
                        assignment: s.assignment.clone(),
                        tool_count: s.tool_count,
                        recent_tools: s.recent_tools.clone(),
                        started_ms: ms(s.started_ms.or(task.and_then(|t| t.started_ms))),
                        ended_ms: ms(s.ended_ms.or(task.and_then(|t| t.ended_ms))),
                        task: task.map(BackgroundTask::key),
                    }
                })
                .collect(),
            background: tasks
                .iter()
                .map(|t| BackgroundView {
                    key: t.key(),
                    id: t.id.clone(),
                    kind: format!("{:?}", t.kind).to_lowercase(),
                    status: format!("{:?}", t.status).to_lowercase(),
                    title: t.title.clone(),
                    detail: t.detail.clone(),
                    active: t.status.is_active(),
                    started_ms: ms(t.started_ms),
                    ended_ms: ms(t.ended_ms),
                    stoppable: t.status.is_active()
                        && !self.read_only
                        && stop_text(self.kind.id, t).is_some(),
                })
                .collect(),
            proposed_plan: self.mapper.proposed_plan().map(|p| ProposedPlanView {
                title: p.title,
                markdown: p.markdown,
            }),
            earlier: earlier_state(&self.shared, self.config.tail_max),
            problem: self.problem.as_ref().map(|(text, _)| text.clone()),
            answers_questions: self.kind.ask.is_some(),
        };
        *self.shared.subagents.lock() = subagents;
        *self.shared.tasks.lock() = tasks;
        let mut snapshot = self.transcript.snapshot(ObservedMeta {
            phase,
            agent: self.kind.id.to_owned(),
            cwd,
            fallback_title: fallback,
            waiting,
            running: status == Some(AgentStatus::Working),
            info,
        });
        let named: HashSet<String> = snapshot.commands.iter().map(|c| c.name.clone()).collect();
        snapshot.commands.extend(
            self.disk_skills
                .iter()
                .filter(|c| !named.contains(&c.name))
                .cloned(),
        );
        snapshot.cached_at_ms = Some(cached_ms).filter(|&ms| ms != 0);
        snapshot
    }
}

/// Lists the agent's skill folders on the pane's machine now and every `every`, and tells the worker when what
/// they hold changed. Ends when the worker is gone (`quit` disconnects, or a send fails).
fn scan_skills(
    io: &dyn PaneIo,
    inputs: &Sender<Input>,
    quit: &Receiver<()>,
    every: Duration,
    layout: super::skills::Layout,
) {
    let mut scan = super::skills::SkillScan::new(layout);
    let mut told: Option<Vec<SlashCommand>> = None;
    loop {
        if let PaneState::Agent { cwd: Some(cwd), .. } = io.state()
            && let Some(files) = io.files()
            && let Ok(found) = scan.scan(&*files, &cwd)
            && told.as_ref() != Some(&found)
        {
            if inputs.send(Input::DiskSkills(found.clone())).is_err() {
                return;
            }
            told = Some(found);
        }
        if !matches!(quit.recv_timeout(every), Err(RecvTimeoutError::Timeout)) {
            return;
        }
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
    /// What is kept of this chat between runs.
    cache: Arc<Cache>,
    key: Key,
    /// The records of the followed log as far as a copy keeps them (see [`super::copy`]).
    window: Arc<Mutex<Window>>,
}

/// How one `follow` ended.
enum Followed {
    /// The session was stopped.
    Stopped,
    /// The pane's agent writes another log now: this follow was ended for it.
    Moved,
    /// A saved copy was shown and the pane's log could not be found again: it was of something else.
    Unconfirmed,
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

    /// Follows the pane's log until the session ends, then writes what is waiting to be saved: the copy the next
    /// open starts from.
    fn run(self) {
        self.follow_loop();
        self.cache.flush();
    }

    fn follow_loop(&self) {
        let mut attempt = 0usize;
        let mut locate_delay = self.config.locate_every;
        let mut followed: Option<String> = None;
        let mut offset: Option<u64> = None;
        // The head of the followed log was looked at for the commands it lists (once per log).
        let mut head_listed = false;
        // Where the saved copy that is shown began, until the follow that resumes it has started.
        let mut from_copy = self.show_copy(&mut followed, &mut offset);
        loop {
            // A copy knows its log. Looking for it first would put the machine's answers (Claude takes up to four
            // commands for one) in front of the first paint; `watch` checks it as soon as the follow runs.
            let location = match (&from_copy, &followed) {
                (Some(_), Some(path)) => Location::Located(path.clone()),
                _ => self.io.locate(self.kind.locator),
            };
            match location {
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
                            self.start_over();
                        }
                        followed = Some(path.clone());
                        offset = None;
                        head_listed = false;
                        *self.shared.log_path.lock() = Some(path.clone());
                        self.window.lock().begin(&path);
                    }
                    if self.shared.restart.swap(false, Ordering::AcqRel) {
                        // A wider read: from the end of the file, not from where the last one stopped.
                        offset = None;
                    }
                    self.say(ObservedLink::Following);
                    let resumed = from_copy.take();
                    match self.follow_once(&path, &mut offset, &mut head_listed, resumed) {
                        Followed::Stopped => return,
                        // The next look finds the other file and opens it.
                        Followed::Moved => {
                            attempt = 0;
                            continue;
                        }
                        // Nothing here is the pane's log any more: what the copy showed goes, and the pane is looked
                        // for as if the chat had never been open.
                        Followed::Unconfirmed => {
                            followed = None;
                            offset = None;
                            head_listed = false;
                            *self.shared.log_path.lock() = None;
                            self.window.lock().begin("");
                            self.cache.forget(&self.key);
                            self.start_over();
                            attempt = 0;
                            continue;
                        }
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
                    if self.shared.restart.load(Ordering::Acquire) {
                        continue;
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

    /// What was shown belongs to a log that is not followed any more: the next is read from its end.
    fn start_over(&self) {
        self.shared.widening.store(false, Ordering::Release);
        self.shared
            .tail
            .store(self.config.tail_start, Ordering::Release);
        let _ = self.inputs.send(Input::Reset);
    }

    /// Hands the worker the copy saved for this pane, if there is one this kind of agent can continue, and sets
    /// `followed` and `offset` to resume from its end; returns the byte the copy begins at (what a `follow` of the
    /// file's tail would have said in its `S`). A copy is shown as soon as it is read; whether it still is the
    /// pane's chat is settled by the follow that resumes it (the keeper says `R` for a file that is not the one the
    /// offset came from) and by the look for the pane's log made with it.
    fn show_copy(&self, followed: &mut Option<String>, offset: &mut Option<u64>) -> Option<u64> {
        let bytes = self.cache.get(&self.key)?;
        let Some(saved) = Saved::decode(&bytes, self.kind.id) else {
            self.cache.forget(&self.key);
            return None;
        };
        let start = saved.start;
        self.shared
            .cached_at_ms
            .store(saved.saved_ms.max(1), Ordering::Release);
        *self.shared.log_path.lock() = Some(saved.path.clone());
        let _ = self.inputs.send(Input::Head(saved.start));
        for (_, json) in &saved.records {
            let _ = self.inputs.send(Input::Line(json.clone()));
        }
        *followed = Some(saved.path.clone());
        *offset = Some(saved.end);
        *self.window.lock() = Window::from_saved(saved);
        Some(start)
    }

    /// Writes the window `debounce` from now, as it is then.
    fn save_soon(&self) {
        let window = self.window.clone();
        let kind = self.kind.id;
        self.cache.save_soon(&self.key, move || {
            Box::new(move || window.lock().encode(kind, unix_ms()))
        });
    }

    /// One `follow` command, read to its end; meanwhile the pane's log is looked for again
    /// ([`watch`](Self::watch)).
    fn follow_once(
        &self,
        path: &str,
        offset: &mut Option<u64>,
        head_listed: &mut bool,
        from_copy: Option<u64>,
    ) -> Followed {
        // A read from the end that is a wider one (or the retry of one) is mapped from scratch beside what is
        // shown; one that resumes goes on where it was.
        let tail = offset
            .is_none()
            .then(|| self.shared.tail.load(Ordering::Acquire));
        if offset.is_none() && self.shared.widening.load(Ordering::Acquire) {
            let _ = self.inputs.send(Input::WideStart { keep_head: false });
        }
        let mut conn: Attach = match self.host.follow(path, *offset, tail) {
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
        // A wider read was asked for while this one was starting: nobody could end it yet.
        if self.shared.restart.load(Ordering::Acquire) {
            conn.proc.kill();
        }
        let Some(stdout) = conn.stdout.take() else {
            return Followed::Ended {
                got_records: false,
                fatal: None,
            };
        };
        let mut lines = AttachLines::new(BufReader::new(stdout), conn.zipped);
        let moved = AtomicBool::new(false);
        let unconfirmed = AtomicBool::new(false);
        let (done, quit) = crossbeam_channel::bounded::<()>(0);
        let proc = conn.proc.clone();
        // A resumed copy is the pane's chat only if the pane's log is this file: that is asked now, not after a wait.
        let verify_now = from_copy.is_some();
        // The commands a tail listed before it are looked for once it caught up; a copy begins where its tail did.
        let head_at = from_copy.filter(|&at| at > 0 && offset.is_some());
        let read = std::thread::scope(|scope| {
            scope.spawn(|| self.watch(path, &proc, &quit, &moved, verify_now, &unconfirmed));
            // Dropped when the read ends, however it ends: the watcher stops looking.
            let _done = done;
            self.read_records(&mut lines, path, offset, head_listed, head_at)
        });
        *self.shared.child.lock() = None;
        self.save_soon();
        let Some(got_records) = read else {
            return Followed::Stopped;
        };
        if self.stop.try_recv().is_ok() {
            conn.close();
            return Followed::Stopped;
        }
        let exit = conn.proc.wait_exit(Duration::from_secs(3));
        conn.close();
        if moved.load(Ordering::Acquire) {
            return Followed::Moved;
        }
        if unconfirmed.load(Ordering::Acquire) {
            return Followed::Unconfirmed;
        }
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

    /// Hands the records of one `follow` to the worker until the command ends: whether any came, or `None`
    /// when the worker is gone.
    fn read_records<R: std::io::BufRead>(
        &self,
        lines: &mut AttachLines<R>,
        path: &str,
        offset: &mut Option<u64>,
        head_listed: &mut bool,
        // Where the tail this read resumes began, when it began past the start of the file.
        mut head_at: Option<u64>,
    ) -> Option<bool> {
        let mut got_records = false;
        // The window is recorded even while a wider read is under way: that read starts from scratch (`S`), which
        // restarts the window, so what it holds is always one unbroken run of the file.
        let recording = self.key.usable();
        let mut unsaved = 0usize;
        while let Ok(Some(line)) = lines.next_line() {
            got_records = true;
            match record(&line) {
                Record::Data { end, json } => {
                    *offset = Some(end);
                    self.inputs.send(Input::Line(json.to_owned())).ok()?;
                    if recording {
                        self.window.lock().push(end, json);
                        unsaved += 1;
                        if unsaved >= SAVE_EVERY_RECORDS {
                            unsaved = 0;
                            self.save_soon();
                        }
                    }
                }
                Record::Head(at) => {
                    head_at = Some(at).filter(|&at| at > 0);
                    self.window.lock().restart(at);
                    let _ = self.inputs.send(Input::Head(at));
                }
                Record::Reset(at) => {
                    *offset = Some(at);
                    self.window.lock().restart(at);
                    // `S` came just before: a wider read keeps the head it said.
                    let widening = self.shared.widening.load(Ordering::Acquire);
                    if !widening {
                        head_at = None;
                    }
                    let _ = self.inputs.send(if widening {
                        Input::WideStart { keep_head: true }
                    } else {
                        Input::Reset
                    });
                }
                Record::CaughtUp => {
                    let _ = self.inputs.send(Input::CaughtUp);
                    if recording {
                        self.save_soon();
                    }
                    if let Some(at) = head_at.take()
                        && !std::mem::replace(head_listed, true)
                        && let Some(commands) = self.head_commands(path, at)
                    {
                        let _ = self.inputs.send(Input::HeadCommands(commands));
                    }
                }
                Record::Failed(why) => {
                    let _ = self
                        .inputs
                        .send(Input::Problem(format!("The log could not be read: {why}")));
                }
                Record::Other => {}
            }
        }
        Some(got_records)
    }

    /// Looks for the pane's log again while one is followed, every `locate_every`: the agent in the pane may
    /// write another file now (`/clear`, `/new` and `/resume` start another session) while the followed one
    /// only stops growing. Ends the follow when it does; a look that finds nothing changes nothing, except the
    /// first look of a follow that resumes a saved copy (`verify_now`, made at once): a pane whose log is not
    /// found then is not the chat the copy was of.
    fn watch(
        &self,
        path: &str,
        proc: &crate::ssh::Proc,
        quit: &Receiver<()>,
        moved: &AtomicBool,
        verify_now: bool,
        unconfirmed: &AtomicBool,
    ) {
        let mut wait = if verify_now {
            Duration::ZERO
        } else {
            self.config.locate_every
        };
        let mut first = verify_now;
        while let Err(RecvTimeoutError::Timeout) = quit.recv_timeout(wait) {
            wait = self.config.locate_every;
            match self.io.locate(self.kind.locator) {
                Location::Located(now) if now != path => {
                    moved.store(true, Ordering::Release);
                    proc.kill();
                    return;
                }
                Location::NotYet(_) | Location::Unlinked(_) if first => {
                    unconfirmed.store(true, Ordering::Release);
                    proc.kill();
                    return;
                }
                _ => {}
            }
            first = false;
        }
    }

    /// The commands the agent listed in the first [`HEAD_COMMANDS_BYTES`] of the log (everything before
    /// `before`, where the tail read began), mapped by a mapper of their own; `None` for an agent that lists
    /// none there, a head that lists none, or a read that failed (the list stays what the tail said).
    fn head_commands(&self, path: &str, before: u64) -> Option<Vec<SlashCommand>> {
        let mut mapper = (self.kind.new_mapper)();
        if !mapper.lists_commands_at_head() {
            return None;
        }
        let mut conn = self
            .host
            .read_log(path, 0, before.min(HEAD_COMMANDS_BYTES))
            .ok()?;
        let stdout = conn.stdout.take()?;
        let mut lines = AttachLines::new(BufReader::new(stdout), conn.zipped);
        let mut found = None;
        while let Ok(Some(line)) = lines.next_line() {
            if let Record::Data { json, .. } = record(&line) {
                for update in mapper.map(json) {
                    if let Update::Commands(commands) = update {
                        found = Some(commands);
                    }
                }
            }
        }
        let _ = conn.proc.wait_exit(Duration::from_secs(3));
        conn.close();
        found
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

    #[test]
    fn a_slash_command_is_a_first_word_of_slash_and_name_never_a_path() {
        for yes in [
            "/compact",
            "/skill:tdd the parser",
            "  /model sonnet",
            "/review-pr 12",
        ] {
            assert!(is_slash_command(yes), "{yes}");
        }
        for no in [
            "/etc/hosts is wrong",
            "/",
            "/ alone",
            "fix /compact",
            "hello",
            "",
        ] {
            assert!(!is_slash_command(no), "{no}");
        }
    }
}
