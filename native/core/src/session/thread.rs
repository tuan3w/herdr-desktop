//! One attached session: a thread that owns the connection to the keeper and the reducer, and publishes
//! immutable [`SessionSnapshot`]s.
//!
//! The thread is the only place the reducer is touched. Lines from the keeper, the person's actions and
//! timers all arrive as [`Input`]s on one channel; a burst is drained before one snapshot is published, so
//! a hundred streamed words cost one commit upstream. The UI never waits for this thread's I/O: actions
//! are answered when the reducer has decided (never when the agent has), and nothing here blocks on the
//! network except the keeper's own socket write.

use std::io::BufReader;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, bounded, unbounded};
use parking_lot::Mutex;

use super::adapter::{Action, Begin, Driver, RecordInfo, Sent};
use super::error::{KeeperError, Refusal, exit};
use super::host::{Attach, KeeperHost};
use super::lines::AttachLines;
use super::types::{FieldAnswer, SessionPhase, SessionSnapshot};

/// How long a caller waits for the session thread to take an action.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the command that carried the connection gets to say why it ended.
const WHY_ENDED: Duration = Duration::from_secs(3);

/// What an action of the person did with a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendOutcome {
    /// It went to the agent.
    Sent,
    /// The agent is working: the message waits and goes when the turn ends.
    Queued,
}

/// A queued message taken back out to be edited.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unqueued {
    /// What it said.
    pub text: String,
    /// The files that went with it.
    pub files: Vec<String>,
}

/// How a session is opened (see [`SessionHandle::open`]).
pub(super) struct Opening<'a> {
    pub host: &'a KeeperHost,
    pub machine: &'a str,
    pub id: &'a str,
    pub begin: Begin,
    pub agent: &'a str,
    pub cwd: &'a str,
    /// Lists the machine's keepers: where the record of an attached keeper is read from.
    pub listing: Listing,
    pub on_change: Arc<dyn Fn() + Send + Sync>,
}

pub(super) type Listing =
    Arc<dyn Fn() -> Result<Vec<super::records::KeeperInfo>, KeeperError> + Send + Sync>;

/// Tells the caller of an action its result: run once the snapshot that shows the action is published.
type Reply = Box<dyn FnOnce() + Send>;

type Call = Box<dyn FnOnce(&mut Driver, u64) -> (Vec<Action>, Reply) + Send>;

enum Input {
    Call(Call),
    Line(String),
    Closed,
    Record(Option<RecordInfo>),
    Retry,
    Stop,
}

struct Shared {
    snapshot: Mutex<Arc<SessionSnapshot>>,
    alive: AtomicBool,
}

/// A running session: the person's side of the conversation. Cloning shares it; the thread stops and the
/// connection closes (the agent keeps running in its keeper) when the last clone is dropped or
/// [`detach`](Self::detach) is called.
#[derive(Clone)]
pub struct SessionHandle {
    inner: Arc<Inner>,
}

struct Inner {
    machine: String,
    id: String,
    inputs: Sender<Input>,
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.inputs.send(Input::Stop);
        if let Some(thread) = self.thread.lock().take() {
            // Never joins itself: the thread holds no handle.
            let _ = thread.join();
        }
    }
}

impl SessionHandle {
    /// Opens the connection to keeper `id` on `host` and starts the thread. `on_change` is called from the
    /// thread after every published snapshot; it must not block.
    pub(super) fn open(opening: Opening<'_>) -> Result<SessionHandle, KeeperError> {
        let Opening {
            host,
            machine,
            id,
            begin,
            agent,
            cwd,
            listing,
            on_change,
        } = opening;
        let conn = host.attach(id)?;
        let started = Instant::now();
        let (driver, first) = Driver::new(begin, agent, cwd, 0);
        let (tx, rx) = unbounded();
        let shared = Arc::new(Shared {
            snapshot: Mutex::new(Arc::new(placeholder(agent, cwd))),
            alive: AtomicBool::new(true),
        });
        let mut worker = Worker {
            driver,
            conn,
            started,
            inputs: tx.clone(),
            shared: shared.clone(),
            listing,
            on_change,
            id: id.to_owned(),
            ended: false,
            replies: Vec::new(),
        };
        worker.start_reader();
        let thread = std::thread::Builder::new()
            .name(format!("herdr-session-{id}"))
            .spawn(move || worker.run(first, &rx))
            .map_err(|e| KeeperError::Other(format!("Could not start a thread: {e}")))?;
        Ok(SessionHandle {
            inner: Arc::new(Inner {
                machine: machine.to_owned(),
                id: id.to_owned(),
                inputs: tx,
                shared,
                thread: Mutex::new(Some(thread)),
            }),
        })
    }

    /// The machine this session runs on.
    pub fn machine(&self) -> &str {
        &self.inner.machine
    }

    /// The keeper's id, which names the session.
    pub fn id(&self) -> &str {
        &self.inner.id
    }

    /// The conversation as it stands. Cheap: an `Arc` clone.
    pub fn snapshot(&self) -> Arc<SessionSnapshot> {
        self.inner.shared.snapshot.lock().clone()
    }

    /// Whether the thread still runs (it ends when the session ends or the connection is lost).
    pub fn is_open(&self) -> bool {
        self.inner.shared.alive.load(Ordering::Acquire)
    }

    fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Driver, u64) -> (T, Vec<Action>) + Send + 'static,
    ) -> Result<T, Refusal> {
        let (tx, rx) = bounded(1);
        let call: Call = Box::new(move |driver, now| {
            let (value, actions) = f(driver, now);
            let reply: Reply = Box::new(move || {
                let _ = tx.send(value);
            });
            (actions, reply)
        });
        self.inner
            .inputs
            .send(Input::Call(call))
            .map_err(|_| Refusal::Stopped)?;
        rx.recv_timeout(CALL_TIMEOUT).map_err(|_| Refusal::Stopped)
    }

    /// Sends a message, or queues it while the agent works. `files` are absolute paths on the agent's
    /// machine; pictures are read here and travel inside the message.
    pub fn send(&self, text: &str, files: &[String]) -> Result<SendOutcome, Refusal> {
        let (text, files) = (text.to_owned(), files.to_vec());
        self.call(move |d, now| match d.send(&text, &files, now) {
            Ok((sent, actions)) => (
                Ok(match sent {
                    Sent::Now => SendOutcome::Sent,
                    Sent::Queued => SendOutcome::Queued,
                }),
                actions,
            ),
            Err(r) => (Err(r), Vec::new()),
        })?
    }

    /// Takes a queued message back (to edit it); `None` when it already went.
    pub fn unqueue(&self, id: u64) -> Result<Option<Unqueued>, Refusal> {
        self.call(move |d, _| {
            (
                d.unqueue(id).map(|(text, files)| Unqueued { text, files }),
                Vec::new(),
            )
        })
    }

    /// Lets held queued messages go (the person said so).
    pub fn release_queue(&self) -> Result<bool, Refusal> {
        self.call(|d, _| (d.release_queue(), Vec::new()))
    }

    /// Asks the agent to stop. Every request still open is answered as cancelled.
    pub fn cancel(&self) -> Result<(), Refusal> {
        self.call(|d, now| ((), d.cancel(now)))
    }

    /// Answers the permission request the person was shown. Refused (nothing sent) when `request_id` is
    /// not the one that waits, when `digest` is not that request's current fingerprint, when the option
    /// does not exist, or within 400 ms of the request appearing.
    pub fn answer_permission(
        &self,
        request_id: &str,
        digest: &str,
        option_id: &str,
    ) -> Result<(), Refusal> {
        let (request_id, digest, option_id) = (
            request_id.to_owned(),
            digest.to_owned(),
            option_id.to_owned(),
        );
        self.call(move |d, now| split(d.answer_permission(&request_id, &digest, &option_id, now)))?
    }

    /// Withdraws the request the person was shown: a permission is cancelled, a question declined. Same
    /// refusals as [`answer_permission`](Self::answer_permission).
    pub fn dismiss(&self, request_id: &str, digest: &str) -> Result<(), Refusal> {
        let (request_id, digest) = (request_id.to_owned(), digest.to_owned());
        self.call(move |d, now| split(d.dismiss(&request_id, &digest, now)))?
    }

    /// Answers the question the person was shown, every field at once. A field that does not pass says
    /// why and leaves the question as it was.
    pub fn answer_question(
        &self,
        request_id: &str,
        digest: &str,
        answers: &[FieldAnswer],
    ) -> Result<(), Refusal> {
        let (request_id, digest, answers) =
            (request_id.to_owned(), digest.to_owned(), answers.to_vec());
        self.call(move |d, now| split(d.answer_question(&request_id, &digest, &answers, now)))?
    }

    /// Changes a setting of the session (the model, the mode, the thinking level) to `value`.
    pub fn set_option(&self, option_id: &str, value: &str) -> Result<(), Refusal> {
        let (option_id, value) = (option_id.to_owned(), value.to_owned());
        self.call(move |d, now| split(d.set_option(&option_id, &value, now)))?
    }

    /// Signs in with the method `method_id` the agent offered (see `AcpInfo::auth`) and handles itself;
    /// when the agent accepts, the session it refused opens again. A method done in a terminal on the
    /// agent's machine is refused with the arguments to run it with.
    pub fn authenticate(&self, method_id: &str) -> Result<(), Refusal> {
        let method_id = method_id.to_owned();
        self.call(move |d, now| split(d.authenticate(&method_id, now)))?
    }

    /// Opens the refused session again after the person signed in some other way (in a terminal).
    pub fn reopen(&self) -> Result<(), Refusal> {
        self.call(|d, now| split(d.reopen(now)))?
    }

    /// Closes the connection. The keeper and its agent keep running; attach again to carry on.
    pub fn detach(&self) {
        let _ = self.inner.inputs.send(Input::Stop);
        if let Some(thread) = self.inner.thread.lock().take() {
            let _ = thread.join();
        }
    }
}

fn split(r: Result<Vec<Action>, Refusal>) -> (Result<(), Refusal>, Vec<Action>) {
    match r {
        Ok(actions) => (Ok(()), actions),
        Err(e) => (Err(e), Vec::new()),
    }
}

/// What a snapshot shows before the first line from the keeper.
fn placeholder(agent: &str, cwd: &str) -> SessionSnapshot {
    SessionSnapshot {
        revision: 0,
        phase: SessionPhase::Connecting,
        agent: agent.to_owned(),
        cwd: cwd.to_owned(),
        title: None,
        items: Arc::new(Vec::new()),
        dropped_items: 0,
        earlier_notice: None,
        waiting: Vec::new(),
        queue: Vec::new(),
        commands: Vec::new(),
        options: Vec::new(),
        plan: Vec::new(),
        mode: None,
        context_percent: None,
        running: false,
        accepts_pictures: false,
        connection_lost: false,
        unsent: None,
        observed: None,
        acp: super::types::AcpInfo::default(),
    }
}

struct Worker {
    driver: Driver,
    conn: Attach,
    started: Instant,
    inputs: Sender<Input>,
    shared: Arc<Shared>,
    listing: Listing,
    on_change: Arc<dyn Fn() + Send + Sync>,
    id: String,
    /// The connection is closed; only the last snapshot remains to publish.
    ended: bool,
    /// Callers waiting for the snapshot that shows what they did.
    replies: Vec<Reply>,
}

impl Worker {
    fn now_ms(&self) -> u64 {
        u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Reads the keeper's lines on a thread of its own; it ends with the connection.
    fn start_reader(&mut self) {
        let Some(stdout) = self.conn.stdout.take() else {
            return;
        };
        let tx = self.inputs.clone();
        let zipped = self.conn.zipped;
        let spawned = std::thread::Builder::new()
            .name(format!("herdr-session-read-{}", self.id))
            .spawn(move || {
                let mut lines = AttachLines::new(BufReader::new(stdout), zipped);
                while let Ok(Some(line)) = lines.next_line() {
                    if tx.send(Input::Line(line)).is_err() {
                        return;
                    }
                }
                let _ = tx.send(Input::Closed);
            });
        if spawned.is_err() {
            let _ = self.inputs.send(Input::Closed);
        }
    }

    fn run(mut self, first: Vec<Action>, rx: &Receiver<Input>) {
        self.act(first);
        self.publish();
        while let Ok(input) = rx.recv() {
            if !self.handle(input) {
                break;
            }
            // A burst is one snapshot: everything already queued is taken before publishing.
            while let Ok(more) = rx.try_recv() {
                if !self.handle(more) {
                    self.finish();
                    return;
                }
            }
            let now = self.now_ms();
            let actions = self.driver.tick(now);
            self.act(actions);
            self.publish();
        }
        self.finish();
    }

    fn finish(&mut self) {
        self.conn.close();
        self.shared.alive.store(false, Ordering::Release);
    }

    /// Handles one input; `false` stops the thread.
    fn handle(&mut self, input: Input) -> bool {
        let now = self.now_ms();
        let actions = match input {
            Input::Stop => return false,
            Input::Call(call) => {
                let (actions, reply) = call(&mut self.driver, now);
                self.replies.push(reply);
                actions
            }
            Input::Line(line) if !self.ended => self.driver.on_line(&line, now),
            Input::Record(record) if !self.ended => self.driver.on_record(record, now),
            Input::Retry if !self.ended => self.driver.on_retry(now),
            Input::Closed => {
                self.closed(now);
                Vec::new()
            }
            Input::Line(_) | Input::Record(_) | Input::Retry => Vec::new(),
        };
        self.act(actions);
        true
    }

    /// The connection ended: say why, in the keeper's words when the command that carried it had any.
    fn closed(&mut self, now: u64) {
        if self.ended {
            return;
        }
        self.ended = true;
        let (reason, agent_gone) = match self.conn.proc.wait_exit(WHY_ENDED) {
            Some(exit_status) => match exit_status.code {
                Some(
                    code @ (exit::GONE
                    | exit::EXITED
                    | exit::AGENT_FAILED
                    | exit::NOT_INSTALLED
                    | exit::NO_PYTHON),
                ) => (
                    Some(
                        KeeperError::from_exit(code, &exit_status.stderr, "reach the session")
                            .message(),
                    ),
                    matches!(code, exit::GONE | exit::EXITED),
                ),
                _ => (None, false),
            },
            None => (None, false),
        };
        self.driver.on_closed(reason, agent_gone, now);
        self.conn.stdin = None;
        self.shared.alive.store(false, Ordering::Release);
    }

    fn act(&mut self, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Write(line) => {
                    if self.conn.write_line(&line).is_err() {
                        let _ = self.inputs.send(Input::Closed);
                    }
                }
                Action::ReadRecord => {
                    let listing = self.listing.clone();
                    let id = self.id.clone();
                    let tx = self.inputs.clone();
                    let spawned = std::thread::Builder::new()
                        .name(format!("herdr-session-record-{id}"))
                        .spawn(move || {
                            let record = listing().ok().and_then(|all| {
                                all.into_iter().find(|k| k.id == id).map(|k| {
                                    let alive = k.alive();
                                    RecordInfo {
                                        session_id: k.session_id,
                                        cwd: k.cwd,
                                        exited: (!alive).then(|| {
                                            k.exit_reason
                                                .unwrap_or_else(|| "the agent exited".into())
                                        }),
                                    }
                                })
                            });
                            let _ = tx.send(Input::Record(record));
                        });
                    if spawned.is_err() {
                        let _ = self.inputs.send(Input::Record(None));
                    }
                }
                Action::RetryIn(after) => {
                    let tx = self.inputs.clone();
                    let _ = std::thread::Builder::new()
                        .name("herdr-session-retry".to_owned())
                        .spawn(move || {
                            std::thread::sleep(after.max(Duration::from_millis(1)));
                            let _ = tx.send(Input::Retry);
                        });
                }
            }
        }
    }

    fn publish(&mut self) {
        let snapshot = Arc::new(self.driver.snapshot());
        *self.shared.snapshot.lock() = snapshot;
        for reply in self.replies.drain(..) {
            reply();
        }
        (self.on_change)();
    }
}
