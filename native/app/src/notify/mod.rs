//! Desktop notifications: tell the person, while the window is away, that an agent needs them.
//!
//! The rules are [`policy`] (pure, tested with a moving instant); delivery is the desktop's own service:
//! `freedesktop` (notifications over the session bus, with answer buttons) everywhere but macOS, and
//! `applescript` on macOS (title and body only: it cannot show buttons or hear a click). This module is
//! the thread between them and the engine:
//!
//! * the engine tells it "something changed" ([`Input::Tick`]) and "the window left or came back"
//!   ([`Input::Away`]);
//! * it asks the engine's [`Source`] what the board shows and which switches are on, steps the
//!   [`Policy`] and carries the result to the [`Sink`];
//! * a press on a notification (body or button) comes back from the sink as an [`Input`]: a click is
//!   handed to whoever listens for it ([`Notifier::subscribe`], the UI), and an answer button goes
//!   through [`Source::answer`], the same path as the answer dock, which re-reads the pane and sends only
//!   if the question is still the one shown.
//!
//! Nothing here approves anything on its own: no timer and no default sends an answer.

mod applescript;
#[cfg(not(target_os = "macos"))]
mod freedesktop;
pub mod policy;
mod recording;

use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, unbounded};
use herdr_core::link::Clock;
use parking_lot::Mutex;

#[cfg(target_os = "macos")]
pub use applescript::AppleScriptSink as DesktopSink;
#[cfg(not(target_os = "macos"))]
pub use freedesktop::DesktopSink;
pub use policy::{Item, Kind, Notification, Question, Sent, Target};
pub use recording::{RecordedNotification, RecordingSink};

use policy::{Cmd, Frame, Policy, Press};

/// The longest the thread sleeps with nothing due: settings and the window's state arrive as inputs, so
/// this only bounds how long a missed wake-up could matter.
const IDLE: Duration = Duration::from_secs(3600);

/// What reaches the notifier thread.
#[derive(Debug)]
pub enum Input {
    /// Something changed: look again.
    Tick,
    /// The window left (`true`) or came back.
    Away(bool),
    /// Something was pressed on notification `id`: `default` for its body, `answer:n` for a button.
    Pressed {
        /// Our id of the notification.
        id: u64,
        /// The freedesktop action key.
        action: String,
    },
    /// The person dismissed (or the desktop expired) notification `id`.
    Gone(u64),
    /// An answer from notification `id` ended.
    Answered {
        /// Our id of the notification.
        id: u64,
        /// How it ended.
        sent: Sent,
    },
    /// The engine is stopping: withdraw everything and end.
    Stop,
}

/// The engine, as the notifier sees it.
pub trait Source: Send + Sync + 'static {
    /// The two switches: `Notify me when an agent needs me` and `Also when an agent finishes`.
    fn settings(&self) -> Settings;
    /// The agents in a state worth telling about, in board order. Asking may start reads of the questions.
    fn items(&self) -> Vec<Item>;
    /// Sends option `index` of the question `digest` to a pane if the pane still shows it.
    fn answer(&self, machine: &str, pane: &str, digest: &str, index: usize) -> Sent;
}

/// The notification switches.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Settings {
    /// `Notify me when an agent needs me`.
    pub needs_you: bool,
    /// `Also when an agent finishes`.
    pub also_done: bool,
}

/// What the running notification service can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Support {
    /// It shows buttons and calls back when one is pressed or the body is clicked.
    pub actions: bool,
    /// It renders markup in the body, so the text must be escaped.
    pub markup: bool,
}

/// Where notifications go.
pub trait Sink: Send + Sync + 'static {
    /// Shows `n`, or replaces the one with the same id. The error says why nothing was shown.
    fn show(&self, n: &Notification) -> Result<(), String>;
    /// Withdraws notification `id` if it is still there.
    fn close(&self, id: u64);
}

/// Who wants to know that a notification was clicked.
#[derive(Default)]
struct Listeners {
    next: Mutex<u64>,
    all: Mutex<Vec<(u64, async_channel::Sender<Target>)>>,
}

/// The running notifier: a thread and the people listening for clicks.
pub struct Notifier {
    listeners: Arc<Listeners>,
}

/// The ends of the channel that feeds the thread; the sink needs the sender before the thread starts.
pub fn channel() -> (Sender<Input>, Receiver<Input>) {
    unbounded()
}

impl Notifier {
    /// Starts the thread; it ends when it gets [`Input::Stop`] (join the handle after sending it).
    pub fn start(
        tx: Sender<Input>,
        rx: Receiver<Input>,
        source: Arc<dyn Source>,
        sink: Arc<dyn Sink>,
        clock: Arc<dyn Clock>,
    ) -> Result<(Self, JoinHandle<()>), String> {
        let listeners = Arc::new(Listeners::default());
        let worker = Worker {
            tx,
            rx,
            source,
            sink,
            clock,
            listeners: listeners.clone(),
            policy: Policy::new(),
            away: false,
        };
        let handle = std::thread::Builder::new()
            .name("herdr-notify".to_owned())
            .spawn(move || worker.run())
            .map_err(|e| format!("cannot start a thread: {e}"))?;
        Ok((Self { listeners }, handle))
    }

    /// Hears every click on a notification: its id (for [`Notifier::unsubscribe`]) and the channel.
    pub fn subscribe(&self) -> (u64, async_channel::Receiver<Target>) {
        let (tx, rx) = async_channel::unbounded();
        let mut next = self.listeners.next.lock();
        *next += 1;
        let id = *next;
        self.listeners.all.lock().push((id, tx));
        (id, rx)
    }

    /// Stops hearing clicks.
    pub fn unsubscribe(&self, id: u64) {
        self.listeners.all.lock().retain(|(i, _)| *i != id);
    }
}

struct Worker {
    tx: Sender<Input>,
    rx: Receiver<Input>,
    source: Arc<dyn Source>,
    sink: Arc<dyn Sink>,
    clock: Arc<dyn Clock>,
    listeners: Arc<Listeners>,
    policy: Policy,
    away: bool,
}

impl Worker {
    fn run(mut self) {
        loop {
            let wait = self
                .policy
                .next_wake()
                .map_or(IDLE, |at| at.saturating_duration_since(self.clock.now()));
            match self.rx.recv_timeout(wait) {
                Ok(Input::Stop) | Err(RecvTimeoutError::Disconnected) => {
                    for id in self.policy.close_all() {
                        self.sink.close(id);
                    }
                    return;
                }
                Ok(Input::Away(away)) => self.away = away,
                Ok(Input::Pressed { id, action }) => self.pressed(id, &action),
                Ok(Input::Gone(id)) => self.policy.gone(id),
                Ok(Input::Answered { id, sent }) => {
                    let cmds = self.policy.answered(id, &sent);
                    self.apply(cmds);
                }
                Ok(Input::Tick) | Err(RecvTimeoutError::Timeout) => {}
            }
            self.step();
        }
    }

    fn step(&mut self) {
        let settings = self.source.settings();
        // Off, or the window in front: only the transitions matter, so the board is not read.
        let items = if Policy::wants_items(self.away, settings.needs_you) {
            self.source.items()
        } else {
            Vec::new()
        };
        let frame = Frame {
            away: self.away,
            needs_you: settings.needs_you,
            also_done: settings.also_done,
            items: &items,
        };
        let cmds = self.policy.step(self.clock.now(), &frame);
        self.apply(cmds);
    }

    fn apply(&self, cmds: Vec<Cmd>) {
        for cmd in cmds {
            match cmd {
                Cmd::Show(n) => {
                    if let Err(e) = self.sink.show(&n) {
                        eprintln!("herdr-desktop: cannot show a notification: {e}");
                    }
                }
                Cmd::Close(id) => self.sink.close(id),
            }
        }
    }

    fn pressed(&mut self, id: u64, action: &str) {
        match self.policy.press(id, action) {
            Press::Nothing => {}
            Press::Open(target) => {
                self.listeners
                    .all
                    .lock()
                    .retain(|(_, tx)| tx.try_send(target.clone()).is_ok());
            }
            Press::Answer {
                id,
                machine,
                pane,
                digest,
                index,
            } => {
                // The answer path may wait on a slow machine: it must not hold up the other
                // notifications, so it runs on its own thread and reports back.
                let source = self.source.clone();
                let tx = self.tx.clone();
                let spawned = std::thread::Builder::new()
                    .name("herdr-notify-answer".to_owned())
                    .spawn(move || {
                        let sent = source.answer(&machine, &pane, &digest, index);
                        let _ = tx.send(Input::Answered { id, sent });
                    });
                if let Err(e) = spawned {
                    let sent = Sent::No(format!("Could not send the answer: {e}"));
                    let cmds = self.policy.answered(id, &sent);
                    self.apply(cmds);
                }
            }
        }
    }
}
