//! The one file that uses herdr-mobile's session code: the vendored reducer (`vendored`) and the `acp` crate.
//!
//! `herdr-tui`'s reducer (`session::Session`, `transcript::Transcript`, `queue::Queue`) is pure: events and
//! the time go in, effects come out. [`Driver`] wraps the three the way herdr-tui's `main.rs` drives them
//! (the turn bookkeeping, the queue rules, the answer guards), speaks only this module's plain types and
//! strings, and turns the transcript into [`SessionSnapshot`]s. When a ratatui-free crate is carved out of
//! herdr-mobile and depended on, only this file changes (`docs/ARCHITECTURE.md`).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use super::vendored::acp::{self, Id, Message, SessionUpdate};
use super::vendored::question::{self, Act, Form, Kind};
use super::vendored::queue::{self, Queue};
use super::vendored::risk as mode_risk;
use super::vendored::session::{self, Effect, Event, Phase, Record, Refused, Session, Start};
use super::vendored::transcript::{self, Entry, Transcript};
use super::vendored::{KEEPER_SCRIPT, ROUTES};

use super::copy::{Saved, Since, Window};
use super::error::Refusal;
use super::outgoing::{self, Outgoing, Pasted};
use super::records::Route;
use super::types::{
    AcpInfo, Ask, AuthMethodView, CommandKind, DiffView, FieldAnswer, FieldChoice, FieldKind,
    ImageRef, Item, ItemKind, Location, ModeRisk, ObservedInfo, OptionChoice, Part, PartKind,
    PermissionChoice, PermissionView, PlanStatus, PlanStep, QuestionField, QuestionView,
    QueuedMessage, Role, SessionOption, SessionPhase, SessionSnapshot, SlashCommand, ToolStatus,
    ToolView, TurnUsageView, Unsent, UsageView, Waiting,
};
use crate::observed::model::{Block, PictureRef, Update};
use crate::prompt;

/// The agents the keeper can start, in the order the start form lists them.
pub(super) fn routes() -> Vec<Route> {
    #[derive(serde::Deserialize)]
    struct Raw {
        id: String,
        label: String,
    }
    serde_json::from_str::<Vec<Raw>>(ROUTES)
        .unwrap_or_default()
        .into_iter()
        .map(|r| Route {
            id: r.id,
            label: r.label,
        })
        .collect()
}

/// Writes the keeper script this build carries to `<home>/.herdr-mobile/desktop/keeper-desktop.py`
/// (atomic: a temp file, then a rename; 0700) unless that file holds exactly it, and returns the path.
/// A separate name from the phone's `keeper-<hash>.py`, which the phone's app deletes when it installs
/// another version.
pub(super) fn ensure_script(home: &Path) -> std::io::Result<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    let dir = home.join(".herdr-mobile/desktop");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    let path = dir.join("keeper-desktop.py");
    if std::fs::read_to_string(&path).is_ok_and(|have| have == KEEPER_SCRIPT) {
        return Ok(path);
    }
    // Two hosts of one home (the hub's and one made for a command) may write at once: a name of their own each,
    // or one renames the other's file away and its own rename fails with ENOENT.
    static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = dir.join(format!(
        "keeper-desktop.py.{}.{}.tmp",
        std::process::id(),
        WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o700)
        .open(&tmp)?;
    file.write_all(KEEPER_SCRIPT.as_bytes())?;
    drop(file);
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o700))?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Requests in one turn's answer window, in milliseconds: an answer sooner than this after a request
/// appeared was meant for what was on screen before.
pub(super) const ANSWER_GUARD_MS: u64 = session::ANSWER_GUARD_MS;

/// The keeper tells a client that sent `_meta.herdr.since` that only the turns from there on follow.
const HERDR_REPLAY: &str = "_herdr/replay";

/// How a session begins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Begin {
    /// Load the keeper's session (a replay of the conversation so far).
    Attach,
    /// A new keeper with no session yet: create one in this folder.
    Create { cwd: String },
    /// A new keeper that holds no session: ask the agent to load this old one (`Continue`).
    Resume { cwd: String, session_id: String },
}

/// What the keeper's record says, for [`Driver::on_record`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RecordInfo {
    pub session_id: Option<String>,
    pub cwd: String,
    pub exited: Option<String>,
}

/// What the thread that owns the connection has to do next.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Action {
    /// Write this line (no newline) to the keeper.
    Write(String),
    /// Read the keeper's record and answer with [`Driver::on_record`].
    ReadRecord,
    /// Call [`Driver::on_retry`] after this long.
    RetryIn(Duration),
}

/// What [`Driver::send`] did with a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Sent {
    /// It went to the agent.
    Now,
    /// The agent is working: it waits in the queue and goes when the turn ends.
    Queued,
}

/// One session's reducer, transcript and queue, driven by the owner of the connection.
pub(super) struct Driver {
    session: Session,
    transcript: Transcript,
    queue: Queue,
    agent: String,
    cwd: String,
    /// `Resume`: the record the keeper cannot give yet, answered here.
    resume: Option<(String, String)>,
    /// The person pressed Stop: the queue goes on after the turn.
    stop_requested: bool,
    turn_started: bool,
    turn_started_ms: u64,
    /// The turn is one the person watched (not one replayed at the start).
    turn_live: bool,
    dropped_turns: u64,
    lost: bool,
    ended_by: Option<String>,
    unsent: Option<Unsent>,
    unsent_seq: u64,
    revision: u64,
    items: ItemCache,
    /// The conversation's lines as the keeper sent them (and the app's own prompts), for the saved copy. Shared with
    /// the thread that writes it.
    window: Arc<Mutex<Window>>,
    /// A saved copy is on screen until the keeper has replayed what is new.
    held: Option<Held>,
    /// Something was recorded since the last [`take_dirty`](Self::take_dirty).
    dirty: bool,
    /// The prompts this driver sent, to give each one's recorded message an id of its own.
    sent_prompts: u64,
}

/// What a saved copy being shown needs while the keeper's answer is still coming. The copy is what
/// `Driver::transcript` shows; the answer builds `shadow` and replaces the copy only once it is whole, so the
/// screen never shows half a replay or a message twice.
struct Held {
    shadow: Transcript,
    /// Where the keeper is asked to continue from (see [`Saved::since`]); `None` asks for the whole replay.
    since: Option<Since>,
    /// When the copy on screen was saved, in unix milliseconds.
    saved_ms: u64,
    /// The session the copy was made of: a `since` is only asked of the keeper for that same session.
    saved_sid: Option<String>,
    /// The keeper said it is continuing (`_herdr/replay`), so `since` was taken.
    saw_notice: bool,
    /// A `session/load` was sent and its first update has not come yet.
    fresh: bool,
}

impl Driver {
    /// A driver and the actions that begin the session. `copy` is what was saved of this conversation last time; it
    /// is shown until the keeper's replay is whole, and only for an attach (a new keeper has no log to continue).
    pub(super) fn new(
        begin: Begin,
        agent: &str,
        cwd: &str,
        now_ms: u64,
        copy: Option<Saved>,
    ) -> (Driver, Vec<Action>) {
        let copy = copy.filter(|_| matches!(begin, Begin::Attach));
        let (start, resume, cwd) = match begin {
            Begin::Attach => (Start::Attach, None, cwd.to_owned()),
            Begin::Create { cwd } => (Start::Create { cwd: cwd.clone() }, None, cwd),
            Begin::Resume { cwd, session_id } => {
                (Start::Attach, Some((session_id, cwd.clone())), cwd)
            }
        };
        let (session, effects) = Session::begin(start, None);
        let mut driver = Driver {
            session,
            transcript: Transcript::default(),
            queue: Queue::default(),
            agent: agent.to_owned(),
            cwd,
            resume,
            stop_requested: false,
            turn_started: false,
            turn_started_ms: 0,
            turn_live: false,
            dropped_turns: 0,
            lost: false,
            ended_by: None,
            unsent: None,
            unsent_seq: 0,
            revision: 0,
            items: ItemCache::default(),
            window: Arc::new(Mutex::new(Window::default())),
            held: None,
            dirty: false,
            sent_prompts: 0,
        };
        if let Some(copy) = copy {
            driver.seed(copy);
        }
        let actions = driver.run(effects, now_ms);
        (driver, actions)
    }

    /// Shows a saved copy: the transcript the lines make is what the screen has until the keeper's replay is whole.
    fn seed(&mut self, copy: Saved) {
        let since = copy.since();
        for line in &copy.lines {
            apply_saved(&mut self.transcript, line);
        }
        let mut shadow = Transcript::default();
        if let Some(since) = &since {
            for line in &copy.lines[..since.index] {
                apply_saved(&mut shadow, line);
            }
        }
        *self.window.lock() = Window::from_saved(&copy);
        self.held = Some(Held {
            shadow,
            since,
            saved_ms: copy.header.saved_ms,
            saved_sid: copy.header.sid,
            saw_notice: false,
            fresh: false,
        });
    }

    /// The recorder of the conversation's lines, for the thread that saves them.
    pub(super) fn window(&self) -> Arc<Mutex<Window>> {
        self.window.clone()
    }

    /// Whether something was recorded since the last call.
    pub(super) fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }

    /// What goes out: a `session/load` over a saved copy asks the keeper for only the turns from the copy's last
    /// stamp on (`_meta.herdr.since`), and starts watching what comes back.
    fn outgoing(&mut self, mut m: Message) -> Message {
        let Some(held) = self.held.as_mut() else {
            return m;
        };
        let Message::Request { method, params, .. } = &mut m else {
            return m;
        };
        if method.as_str() != acp::method::SESSION_LOAD {
            return m;
        }
        held.fresh = true;
        held.saw_notice = false;
        let same_session = held.saved_sid.is_none()
            || params.get("sessionId").and_then(serde_json::Value::as_str)
                == held.saved_sid.as_deref();
        if !same_session {
            held.since = None;
        }
        if let (Some(since), Some(object)) = (&held.since, params.as_object_mut()) {
            object.insert(
                "_meta".to_owned(),
                serde_json::json!({"herdr": {"since": {"epoch": since.epoch, "turn": since.turn}}}),
            );
        }
        m
    }

    /// Carries out effects the way `herdr-tui` does; reading the record may answer at once.
    fn run(&mut self, effects: Vec<Effect>, now_ms: u64) -> Vec<Action> {
        let mut actions = Vec::new();
        let mut pending = VecDeque::from(effects);
        while let Some(effect) = pending.pop_front() {
            match effect {
                Effect::Send(m) => actions.push(Action::Write(self.outgoing(m).to_line())),
                Effect::ReadRecord => match &self.resume {
                    Some((session_id, cwd)) => {
                        let record = Record {
                            session_id: Some(session_id.clone()),
                            cwd: cwd.clone(),
                            exited: None,
                        };
                        pending.extend(self.session.handle(
                            Event::Record(Some(record)),
                            now_ms,
                            &mut self.transcript,
                        ));
                    }
                    None => actions.push(Action::ReadRecord),
                },
                Effect::RetryIn(d) => actions.push(Action::RetryIn(d)),
                Effect::RestoreInput(text, files) => {
                    self.unsent_seq += 1;
                    let (files, pictures) = outgoing::split(&files);
                    self.unsent = Some(Unsent {
                        seq: self.unsent_seq,
                        text,
                        files,
                        pictures,
                    });
                }
                Effect::RestoreQueued {
                    id,
                    text,
                    files,
                    why,
                } => self.queue.hold_front(
                    queue::Queued {
                        id,
                        text,
                        files,
                        held: None,
                    },
                    why,
                ),
            }
        }
        actions
    }

    /// One line from the keeper. A line that is not JSON-RPC (an agent's stray output) is not ours.
    pub(super) fn on_line(&mut self, line: &str, now_ms: u64) -> Vec<Action> {
        let Ok(message) = Message::parse(line) else {
            return Vec::new();
        };
        // The keeper says what its log gave up; the reducer does not read it.
        if let Message::Response {
            outcome: Ok(result),
            ..
        } = &message
            && let Some(n) = result
                .pointer("/_meta/herdr/droppedTurns")
                .and_then(serde_json::Value::as_u64)
        {
            self.dropped_turns = n;
        }
        self.record(line, &message);
        // Items this line makes are timed now, by whether the session was open before it: the lines of a
        // history replay and the response that ends it can arrive in one burst, and none of what the replay
        // brings is news.
        let live = self.session.ready();
        let effects = self.handle_message(message, now_ms);
        if self.held.is_some() && self.session.ready() {
            self.show_replay();
        }
        // A copy on screen is not the session's transcript: it has no times to give.
        if self.held.is_none() {
            self.items
                .stamp(self.transcript.items(), now_ms, live, self.working());
        }
        self.run(effects, now_ms)
    }

    /// Hands the message to the reducer. While a saved copy is shown the reducer builds the conversation in the
    /// shadow transcript instead, so the screen keeps the copy until the replay is whole.
    fn handle_message(&mut self, message: Message, now_ms: u64) -> Vec<Effect> {
        if let Some(held) = self.held.as_mut() {
            std::mem::swap(&mut self.transcript, &mut held.shadow);
        }
        let effects = self
            .session
            .handle(Event::Message(message), now_ms, &mut self.transcript);
        if let Some(held) = self.held.as_mut() {
            std::mem::swap(&mut self.transcript, &mut held.shadow);
        }
        effects
    }

    /// The keeper answered the load: what the replay built replaces the copy on screen.
    fn show_replay(&mut self) {
        // A replay with no update in it (the log is empty) leaves nothing of the copy standing either.
        self.replay_begins();
        let Some(held) = self.held.take() else {
            return;
        };
        self.transcript = held.shadow;
        self.items = ItemCache::default();
        self.dirty = true;
    }

    /// The first update of a replay is here (or the load answered without any). With the keeper continuing from
    /// the copy's stamp, the lines past it are what the keeper sends again; any other replay is the whole
    /// conversation, and the copy, on screen and recorded, gives way to it.
    fn replay_begins(&mut self) {
        let Some(held) = self.held.as_mut() else {
            return;
        };
        if !std::mem::take(&mut held.fresh) {
            return;
        }
        match (&held.since, held.saw_notice) {
            (Some(since), true) => self.window.lock().truncate(since.index),
            _ => {
                held.shadow = Transcript::default();
                self.window.lock().clear();
            }
        }
    }

    /// Keeps a line of the conversation for the saved copy, and notes the keeper's `_herdr/replay`.
    fn record(&mut self, line: &str, message: &Message) {
        let Message::Notification { method, params } = message else {
            return;
        };
        if method == HERDR_REPLAY {
            if let Some(held) = self.held.as_mut()
                && let Some(since) = &held.since
                && params.get("from").and_then(serde_json::Value::as_u64) == Some(since.turn)
            {
                held.saw_notice = true;
            }
            return;
        }
        if method != acp::method::SESSION_UPDATE {
            return;
        }
        let sid = params.get("sessionId").and_then(serde_json::Value::as_str);
        if sid.is_none() || sid != self.session.session_id() {
            return;
        }
        // A notice is live news, not part of any replay. The substring test keeps the parse for the rare line.
        if line.contains("\"notice\"")
            && matches!(
                params.get("update").and_then(SessionUpdate::from_value),
                Some(SessionUpdate::Notice { .. })
            )
        {
            return;
        }
        self.replay_begins();
        self.window
            .lock()
            .push(sid.unwrap_or_default(), line.to_owned());
        self.dirty = self.dirty || self.held.is_none();
    }

    /// The person's own prompt is about to go out. The keeper does not send a prompt back to the client that
    /// sent it, so the copy would never hold what is typed in this app; it is recorded here, as the keeper
    /// records it for everyone else.
    pub(super) fn note_sent(&mut self, line: &str) {
        if !line.contains(acp::method::SESSION_PROMPT) {
            return;
        }
        let Ok(Message::Request { method, params, .. }) = Message::parse(line) else {
            return;
        };
        if method != acp::method::SESSION_PROMPT {
            return;
        }
        let (Some(sid), Some(blocks)) = (
            params.get("sessionId").and_then(serde_json::Value::as_str),
            params.get("prompt").and_then(serde_json::Value::as_array),
        ) else {
            return;
        };
        self.sent_prompts += 1;
        let message_id = format!("desktop-{}", self.sent_prompts);
        let mut window = self.window.lock();
        for block in blocks.iter().filter(|b| b.is_object()) {
            let kind = block.get("type").and_then(serde_json::Value::as_str);
            // The keeper's own filter for what it logs of a prompt (keeper.py `begin_turn`).
            let content = if kind != Some("text") && block.to_string().len() > 20_000 {
                serde_json::json!({"type": "text", "text": format!("[{} omitted]", kind.unwrap_or("attachment"))})
            } else {
                block.clone()
            };
            let recorded = serde_json::json!({"jsonrpc": "2.0", "method": acp::method::SESSION_UPDATE,
                "params": {"sessionId": sid, "update": {"sessionUpdate": "user_message_chunk",
                    "content": content, "messageId": message_id}}});
            window.push(sid, recorded.to_string());
        }
        drop(window);
        self.dirty = true;
    }

    /// The keeper's record, or `None` when it cannot be read.
    pub(super) fn on_record(&mut self, record: Option<RecordInfo>, now_ms: u64) -> Vec<Action> {
        let record = record.map(|r| Record {
            session_id: r.session_id,
            cwd: if r.cwd.is_empty() { "/".into() } else { r.cwd },
            exited: r.exited,
        });
        let effects = self
            .session
            .handle(Event::Record(record), now_ms, &mut self.transcript);
        self.run(effects, now_ms)
    }

    /// The retry the driver asked for is due.
    pub(super) fn on_retry(&mut self, now_ms: u64) -> Vec<Action> {
        let effects = self
            .session
            .handle(Event::Retry, now_ms, &mut self.transcript);
        self.run(effects, now_ms)
    }

    /// The connection closed. `reason` is what the command that carried it said, when it said.
    pub(super) fn on_closed(&mut self, reason: Option<String>, agent_gone: bool, now_ms: u64) {
        let was_ended = matches!(self.session.phase(), Phase::Ended(_));
        let effects = self
            .session
            .handle(Event::Closed, now_ms, &mut self.transcript);
        debug_assert!(effects.is_empty());
        if !was_ended {
            self.ended_by = reason;
            self.lost = !agent_gone;
        }
    }

    /// Turn bookkeeping that follows every batch of events: say what a turn did when it ends, settle the
    /// queue, and send the next queued message when nothing runs and nothing asks.
    pub(super) fn tick(&mut self, now_ms: u64) -> Vec<Action> {
        // The copy on screen is not the session: no turn is running in it, and nothing can be sent against it.
        if self.held.is_some() {
            return Vec::new();
        }
        let actions = self.settle(now_ms);
        // Items made by the batch just handled get their time; what the history replay brought gets none.
        let live = self.session.ready();
        self.items
            .stamp(self.transcript.items(), now_ms, live, self.working());
        actions
    }

    fn settle(&mut self, now_ms: u64) -> Vec<Action> {
        let mut actions = Vec::new();
        loop {
            let working = self.working();
            if working {
                if !self.turn_started {
                    self.turn_live = self.session.ready();
                    self.turn_started = true;
                    self.turn_started_ms = now_ms;
                }
            } else if self.turn_started {
                self.turn_started = false;
                // A turn that ended while the history was replaying is not news.
                if self.turn_live && self.session.ready() {
                    self.transcript
                        .done(now_ms.saturating_sub(self.turn_started_ms) / 1000);
                }
                self.settle_queue();
            }
            match self.pump_queue(now_ms) {
                Some(more) => actions.extend(more),
                None => return actions,
            }
        }
    }

    fn working(&self) -> bool {
        self.transcript.running() || self.session.prompting()
    }

    fn settle_queue(&mut self) {
        let reason = self.transcript.take_stop();
        let mine = std::mem::take(&mut self.stop_requested);
        if self.queue.is_empty() {
            return;
        }
        match queue::after_turn(mine, reason.as_deref()) {
            queue::Disposition::Merge => self.queue.merge_waiting(),
            queue::Disposition::Hold(why) => self.queue.hold_all(why),
            queue::Disposition::Go => {}
        }
    }

    /// Sends the oldest queued message when nothing is running and nothing asks. A held message blocks the
    /// ones behind it, so a refusal never reorders the queue.
    fn pump_queue(&mut self, now_ms: u64) -> Option<Vec<Action>> {
        if !self.session.ready()
            || self.working()
            || !self.session.waiting().is_empty()
            || self.queue.has_held()
        {
            return None;
        }
        let q = self.queue.pop_waiting()?;
        match self
            .session
            .send_queued(q.id, &q.text, &q.files, &mut self.transcript)
        {
            Ok(effects) => {
                self.begin_turn(now_ms);
                Some(self.run(effects, now_ms))
            }
            Err(_) => {
                self.queue.requeue_front(q);
                None
            }
        }
    }

    /// The person sends a message. While the agent works, or behind messages that already wait, it joins
    /// the queue.
    pub(super) fn send(
        &mut self,
        text: &str,
        with: Outgoing,
        now_ms: u64,
    ) -> Result<(Sent, Vec<Action>), Refusal> {
        if matches!(self.session.phase(), Phase::Ended(_)) {
            return Err(Refusal::Ended);
        }
        let attachments = with.files;
        if self.session.ready() && (self.working() || self.queue.has_waiting()) {
            if self.queue.is_full() {
                return Err(Refusal::QueueFull(queue::MAX));
            }
            self.queue.push(text.to_owned(), attachments);
            return Ok((Sent::Queued, Vec::new()));
        }
        let effects = self
            .session
            .send(text, &attachments, &mut self.transcript)
            .map_err(refusal)?;
        self.unsent = None;
        self.begin_turn(now_ms);
        Ok((Sent::Now, self.run(effects, now_ms)))
    }

    /// A prompt just went out: the turn begins now, not when the next tick sees the agent working. A turn
    /// the agent answers while the thread is still draining one burst of lines would otherwise never be
    /// seen to run, and would end with no summary and no settled queue.
    fn begin_turn(&mut self, now_ms: u64) {
        if !self.turn_started {
            self.turn_live = true;
            self.turn_started = true;
            self.turn_started_ms = now_ms;
        }
    }

    /// Takes a queued message out (to edit it): its text and files.
    pub(super) fn unqueue(&mut self, id: u64) -> Option<(String, Vec<String>, Vec<Pasted>)> {
        let q = self.queue.take(id)?;
        let (files, pictures) = outgoing::split(&q.files);
        Some((q.text, files, pictures))
    }

    /// Held messages go again (the person said so).
    pub(super) fn release_queue(&mut self) -> bool {
        self.queue.release()
    }

    /// The person asks the agent to stop; every request still open is answered as cancelled.
    pub(super) fn cancel(&mut self, now_ms: u64) -> Vec<Action> {
        if self.working() {
            self.stop_requested = true;
        }
        let effects = self.session.cancel(&mut self.transcript);
        self.run(effects, now_ms)
    }

    /// The request that waits first, if its id and fingerprint are the ones the person saw.
    fn shown(&self, request_id: &str, digest: &str) -> Result<Id, Refusal> {
        if matches!(self.session.phase(), Phase::Ended(_)) {
            return Err(Refusal::Ended);
        }
        // A request is never in a copy; this keeps an answer from ever being aimed at one.
        if self.held.is_some() {
            return Err(Refusal::NotReady);
        }
        let head = self
            .session
            .waiting()
            .first()
            .ok_or(Refusal::NothingWaiting)?;
        let wanted: Id = serde_json::from_str(request_id).map_err(|_| Refusal::Changed)?;
        if head.id != wanted || waiting_digest(head) != digest {
            return Err(Refusal::Changed);
        }
        Ok(wanted)
    }

    /// The person answers the permission request they were shown with option `option_id`.
    pub(super) fn answer_permission(
        &mut self,
        request_id: &str,
        digest: &str,
        option_id: &str,
        now_ms: u64,
    ) -> Result<Vec<Action>, Refusal> {
        let shown = self.shown(request_id, digest)?;
        let index = self
            .session
            .waiting()
            .first()
            .and_then(session::Waiting::permission)
            .ok_or(Refusal::NoSuchOption)?
            .options
            .iter()
            .position(|o| o.id == option_id)
            .ok_or(Refusal::NoSuchOption)?;
        let effects = self
            .session
            .answer_for(&shown, index, now_ms, &mut self.transcript)
            .map_err(refusal)?;
        Ok(self.run(effects, now_ms))
    }

    /// Withdraws the request the person was shown (a permission is cancelled, a question declined).
    pub(super) fn dismiss(
        &mut self,
        request_id: &str,
        digest: &str,
        now_ms: u64,
    ) -> Result<Vec<Action>, Refusal> {
        let shown = self.shown(request_id, digest)?;
        // Withdrawing a permission ends the turn by the person's own hand: the queue goes on.
        if self.session.permission_waiting() {
            self.stop_requested = true;
        }
        let effects = self
            .session
            .dismiss_for(&shown, now_ms, &mut self.transcript)
            .map_err(refusal)?;
        Ok(self.run(effects, now_ms))
    }

    /// The person answers the question they were shown, every field at once. The answer is checked on a
    /// copy first, so a field that does not pass leaves the question as it was.
    pub(super) fn answer_question(
        &mut self,
        request_id: &str,
        digest: &str,
        answers: &[FieldAnswer],
        now_ms: u64,
    ) -> Result<Vec<Action>, Refusal> {
        let shown = self.shown(request_id, digest)?;
        let form = self
            .session
            .waiting()
            .first()
            .and_then(session::Waiting::question)
            .ok_or(Refusal::NoSuchOption)?
            .clone();
        if answers.len() > form.fields.len() {
            return Err(Refusal::Invalid("More answers than fields".into()));
        }
        // The fields are walked one at a time, as the person would; each step is a deliberate act of a
        // person who has the whole form in front of them, so the timer that keeps a stray key from
        // confirming the next field runs on a clock that moves on between steps.
        let steps = question_steps(&form, answers);
        let mut dry = form.clone();
        for (n, act) in steps.iter().enumerate() {
            let at = now_ms + n as u64 * (ANSWER_GUARD_MS + 100);
            if let Err(why) = dry.act(act.clone(), at) {
                let label = dry.field().map_or("", |f| f.label());
                return Err(Refusal::Invalid(format!("{label}: {why}")));
            }
        }
        let mut effects = Vec::new();
        for (n, act) in steps.into_iter().enumerate() {
            let at = now_ms + n as u64 * (ANSWER_GUARD_MS + 100);
            effects = self
                .session
                .question_for(&shown, act, at, &mut self.transcript)
                .map_err(refusal)?;
        }
        Ok(self.run(effects, now_ms))
    }

    /// Changes one setting of the session (the model, the mode, the thinking level).
    pub(super) fn set_option(
        &mut self,
        option_id: &str,
        value: &str,
        now_ms: u64,
    ) -> Result<Vec<Action>, Refusal> {
        let option = self
            .transcript
            .option(option_id)
            .ok_or(Refusal::NoSuchOption)?;
        let choice = if option.boolean {
            match value {
                "true" => "On".to_owned(),
                "false" => "Off".to_owned(),
                _ => return Err(Refusal::NoSuchOption),
            }
        } else {
            option
                .choices
                .iter()
                .find(|(v, _)| v == value)
                .map(|(_, name)| name.clone())
                .ok_or(Refusal::NoSuchOption)?
        };
        let (id, what) = (option.id.clone(), option.name.clone());
        let effects = self
            .session
            .set_config(&id, value, &what, &choice, &self.transcript)
            .map_err(refusal)?;
        Ok(self.run(effects, now_ms))
    }

    /// The person signs in with a method the agent handles itself; the session that was refused then
    /// opens again.
    pub(super) fn authenticate(
        &mut self,
        method_id: &str,
        now_ms: u64,
    ) -> Result<Vec<Action>, Refusal> {
        let effects = self.session.authenticate(method_id).map_err(refusal)?;
        Ok(self.run(effects, now_ms))
    }

    /// The person signed in some other way (in a terminal): open the refused session again.
    pub(super) fn reopen(&mut self, now_ms: u64) -> Result<Vec<Action>, Refusal> {
        let effects = self.session.reopen().map_err(refusal)?;
        Ok(self.run(effects, now_ms))
    }

    /// Where the session stands.
    pub(super) fn phase(&self) -> SessionPhase {
        match self.session.phase() {
            Phase::Initializing | Phase::WaitingForSession | Phase::Opening => {
                SessionPhase::Connecting
            }
            Phase::AuthRequired => SessionPhase::AuthRequired,
            Phase::Ended(why) => {
                SessionPhase::Ended(self.ended_by.clone().unwrap_or_else(|| why.clone()))
            }
            Phase::Ready => match self.session.waiting().first().map(|w| &w.ask) {
                Some(session::Ask::Permission(_)) => SessionPhase::BlockedOnPermission,
                Some(session::Ask::Question(_)) => SessionPhase::BlockedOnQuestion,
                None if self.working() => SessionPhase::Working,
                None => SessionPhase::Idle,
            },
        }
    }

    /// The conversation as it stands. Items that did not change are the same `Arc` as in the last one.
    pub(super) fn snapshot(&mut self) -> SessionSnapshot {
        self.revision += 1;
        let items = self.items_snapshot();
        let waiting = self
            .session
            .waiting()
            .iter()
            .map(waiting_view)
            .collect::<Vec<_>>();
        SessionSnapshot {
            revision: self.revision,
            phase: self.phase(),
            agent: self.agent.clone(),
            cwd: self.cwd.clone(),
            title: self.transcript.title().map(str::to_owned),
            items,
            dropped_items: self.transcript.dropped(),
            earlier_notice: (self.dropped_turns > 0).then(|| earlier_text(self.dropped_turns)),
            waiting,
            queue: self
                .queue
                .entries()
                .iter()
                .map(|q| {
                    let (files, pictures) = outgoing::split(&q.files);
                    QueuedMessage {
                        id: q.id,
                        text: q.text.clone(),
                        files,
                        pictures,
                        held: q.held.clone(),
                    }
                })
                .collect(),
            commands: self
                .transcript
                .commands()
                .iter()
                .map(|c| SlashCommand {
                    name: c.name.clone(),
                    description: c.description.clone(),
                    hint: c.hint.clone(),
                    kind: CommandKind::Command,
                })
                .collect(),
            options: self.transcript.options().iter().map(option_view).collect(),
            plan: self
                .transcript
                .plan()
                .iter()
                .map(|p| PlanStep {
                    content: p.content.clone(),
                    status: match p.status {
                        acp::PlanStatus::Pending => PlanStatus::Pending,
                        acp::PlanStatus::InProgress => PlanStatus::InProgress,
                        acp::PlanStatus::Completed => PlanStatus::Completed,
                    },
                })
                .collect(),
            mode: self.transcript.mode().map(str::to_owned),
            context_percent: self.transcript.context(),
            running: self.held.is_none() && self.working(),
            accepts_pictures: self.session.accepts_pictures(),
            connection_lost: self.lost,
            // The conversation shown is the saved one until the keeper's replay is whole; after the connection ended
            // there is no update coming, and the strip that says why is the one to read.
            cached_at_ms: self
                .held
                .as_ref()
                .filter(|_| !matches!(self.session.phase(), Phase::Ended(_)))
                .map(|h| h.saved_ms),
            unsent: self.unsent.clone(),
            observed: None,
            acp: self.acp_info(),
        }
    }

    /// What ACP told about the agent and the session besides the transcript.
    fn acp_info(&self) -> AcpInfo {
        let agent = self.session.agent();
        let usage = self.transcript.usage();
        let turn = self.transcript.turn_usage();
        AcpInfo {
            agent_name: agent.name.clone(),
            agent_title: agent.title.clone(),
            agent_version: agent.version.clone(),
            can_resume: agent.resume,
            can_list: agent.list,
            can_close: agent.close,
            can_logout: agent.logout,
            accepts_audio: agent.audio,
            accepts_embedded: agent.embedded_context,
            auth: if matches!(self.session.phase(), Phase::AuthRequired) {
                agent
                    .auth_methods
                    .iter()
                    .map(|m| AuthMethodView {
                        id: m.id.clone(),
                        name: m.name.clone(),
                        description: m.description.clone(),
                        terminal_args: m.terminal_args.clone(),
                    })
                    .collect()
            } else {
                Vec::new()
            },
            usage: usage.map(|u| UsageView {
                used: u.used,
                size: u.size,
                cost: u.cost.clone(),
            }),
            turn_usage: turn.map(|t| TurnUsageView {
                input: t.input,
                output: t.output,
                total: t.total,
                thought: t.thought,
                cached_read: t.cached_read,
                cached_write: t.cached_write,
            }),
            updated_at: self.transcript.updated_at().map(str::to_owned),
            turn_started_ms: (self.turn_started && self.turn_live).then_some(self.turn_started_ms),
        }
    }

    fn items_snapshot(&mut self) -> Arc<Vec<Arc<Item>>> {
        self.items.snapshot(self.transcript.items(), None, &|id| id)
    }
}

/// The items of the last snapshot, so a new one reuses what did not change.
#[derive(Default)]
struct ItemCache {
    /// The last snapshot's items, each with the transcript id it was made from (its own `id` is the key
    /// the screens see, which an observed session can keep apart from the transcript's: see
    /// [`ObservedTranscript::adopt`]).
    prev: Vec<(u64, Arc<Item>)>,
    times: Times,
}

/// When live items began and ended, on the session's clock. Only a driver of an agent session stamps;
/// an observed session's items have no times.
#[derive(Default)]
struct Times {
    started: HashMap<u64, u64>,
    ended: HashMap<u64, u64>,
    /// The newest item id looked at: ids ascend, so only newer ones are new.
    seen: Option<u64>,
    /// Tool calls that have not finished, and the message or thought being written: they end when
    /// something happens.
    open_tools: Vec<u64>,
    trailing: Option<u64>,
}

fn tool_open(status: acp::ToolStatus) -> bool {
    matches!(
        status,
        acp::ToolStatus::Pending | acp::ToolStatus::InProgress
    )
}

impl ItemCache {
    /// Gives the items made since the last call their start, and ends what ended: a tool call that
    /// finished, a message or a thought that the next item followed (or the turn ended on). `live` is
    /// false while the history replays: what it brings has no time. `working`: a turn runs.
    fn stamp(
        &mut self,
        source: &VecDeque<transcript::Item>,
        now_ms: u64,
        live: bool,
        working: bool,
    ) {
        let t = &mut self.times;
        if let Some(first) = source.front().map(|i| i.id) {
            // Forget what scrolled off the front, in batches.
            if t.started.len() > source.len() * 2 + 64 {
                t.started.retain(|id, _| *id >= first);
                t.ended.retain(|id, _| *id >= first);
                t.open_tools.retain(|id| *id >= first);
            }
        }
        let fresh: Vec<&transcript::Item> = source
            .iter()
            .rev()
            .take_while(|i| t.seen.is_none_or(|seen| i.id > seen))
            .collect();
        for item in fresh.into_iter().rev() {
            t.seen = Some(item.id);
            if !live {
                continue;
            }
            if let Some(prev) = t.trailing.take() {
                t.ended.insert(prev, now_ms);
            }
            t.started.insert(item.id, now_ms);
            match &item.entry {
                Entry::Tool(tool) if tool_open(tool.status) => t.open_tools.push(item.id),
                Entry::Message {
                    role: transcript::Role::Agent | transcript::Role::Thought,
                    ..
                } => t.trailing = Some(item.id),
                // A call that came finished, a note, the person's message: no duration.
                _ => {
                    t.ended.insert(item.id, now_ms);
                }
            }
        }
        t.open_tools.retain(|id| {
            let finished = source.binary_search_by_key(id, |i| i.id).ok().is_none_or(
                |at| !matches!(&source[at].entry, Entry::Tool(tool) if tool_open(tool.status)),
            );
            if finished {
                t.ended.insert(*id, now_ms);
            }
            !finished
        });
        if !working && let Some(prev) = t.trailing.take() {
            t.ended.insert(prev, now_ms);
        }
    }

    /// Items that did not change are the same `Arc` as in the last one. `images` are the pictures of
    /// messages by message id.
    fn snapshot(
        &mut self,
        source: &VecDeque<transcript::Item>,
        images: Option<&HashMap<String, Vec<ImageRef>>>,
        key: &dyn Fn(u64) -> u64,
    ) -> Arc<Vec<Arc<Item>>> {
        let mut out = Vec::with_capacity(source.len());
        let mut at = 0;
        let timed = !self.times.started.is_empty();
        for item in source {
            // Ids ascend and only the oldest are dropped, so the previous snapshot is walked once.
            while self.prev.get(at).is_some_and(|(src, _)| *src < item.id) {
                at += 1;
            }
            let view_id = key(item.id);
            let (started, ended) = if timed {
                (
                    self.times.started.get(&item.id).copied(),
                    self.times.ended.get(&item.id).copied(),
                )
            } else {
                (None, None)
            };
            match self.prev.get(at) {
                Some((src, prev))
                    if *src == item.id
                        && prev.id == view_id
                        && prev.rev == item.rev
                        && prev.started_ms == started
                        && prev.ended_ms == ended =>
                {
                    out.push(prev.clone());
                }
                _ => {
                    let mut view = item_view(item);
                    view.id = view_id;
                    view.started_ms = started;
                    view.ended_ms = ended;
                    if let (
                        Some(images),
                        ItemKind::Message {
                            message_id: Some(id),
                            images: slot,
                            ..
                        },
                    ) = (images, &mut view.kind)
                        && let Some(found) = images.get(id)
                    {
                        slot.clone_from(found);
                    }
                    out.push(Arc::new(view));
                }
            }
        }
        self.prev = source
            .iter()
            .map(|i| i.id)
            .zip(out.iter().cloned())
            .collect();
        Arc::new(out)
    }
}

/// `Earlier messages are no longer kept on the machine (3 turns).`
fn earlier_text(turns: u64) -> String {
    format!(
        "Earlier messages are no longer kept on the machine ({turns} turn{}).",
        if turns == 1 { "" } else { "s" }
    )
}

/// Applies one saved line to a transcript the way the reducer does a live one (`Session::notification`): the
/// updates of the conversation, not the notices, which are live news and no part of a replay.
fn apply_saved(transcript: &mut Transcript, line: &str) {
    let Ok(Message::Notification { method, params }) = Message::parse(line) else {
        return;
    };
    if method != acp::method::SESSION_UPDATE {
        return;
    }
    if let Some(update) = params.get("update").and_then(SessionUpdate::from_value)
        && !matches!(update, SessionUpdate::Notice { .. })
    {
        transcript.apply(update);
    }
}

fn refusal(r: Refused) -> Refusal {
    match r {
        Refused::NotReady => Refusal::NotReady,
        Refused::Busy => Refusal::Busy,
        Refused::TooSoon => Refusal::TooSoon,
        Refused::NoSuchOption => Refusal::NoSuchOption,
        Refused::NothingWaiting => Refusal::NothingWaiting,
        Refused::Changed => Refusal::Changed,
        Refused::Ended => Refusal::Ended,
        Refused::Invalid(why) => Refusal::Invalid(why),
    }
}

fn part_view(p: &acp::Part) -> Part {
    Part {
        kind: match p.kind {
            acp::PartKind::Image => PartKind::Image,
            acp::PartKind::Audio => PartKind::Audio,
            acp::PartKind::Link => PartKind::File,
            acp::PartKind::Resource => PartKind::Resource,
        },
        name: p.name.clone(),
        uri: p.uri.clone(),
        mime: p.mime.clone(),
        size: p.size,
        data: p.data.clone(),
    }
}

fn item_view(item: &transcript::Item) -> Item {
    Item {
        id: item.id,
        rev: item.rev,
        started_ms: None,
        ended_ms: None,
        kind: match &item.entry {
            Entry::Message {
                role,
                message_id,
                text,
                parts,
            } => ItemKind::Message {
                role: match role {
                    transcript::Role::User => Role::User,
                    transcript::Role::Agent => Role::Agent,
                    transcript::Role::Thought => Role::Thought,
                },
                message_id: message_id.clone(),
                text: text.clone(),
                images: Vec::new(),
                parts: parts.iter().map(part_view).collect(),
            },
            Entry::Tool(t) => ItemKind::Tool(ToolView {
                id: t.id.clone(),
                title: t.title.clone(),
                name: t.name.clone(),
                kind: t.kind.clone(),
                status: match t.status {
                    acp::ToolStatus::Pending => ToolStatus::Pending,
                    acp::ToolStatus::InProgress => ToolStatus::InProgress,
                    acp::ToolStatus::Completed => ToolStatus::Completed,
                    acp::ToolStatus::Failed => ToolStatus::Failed,
                },
                subject: t.subject.clone(),
                input: t.input.clone(),
                locations: t
                    .locations
                    .iter()
                    .map(|l| Location {
                        path: l.path.clone(),
                        line: l.line,
                    })
                    .collect(),
                head: t.output.head.clone(),
                tail: t.output.tail.clone(),
                omitted: t.output.omitted,
                parts: t.parts.iter().map(part_view).collect(),
                terminal: t.terminal,
                cwd: t.cwd.clone(),
                exit_code: t.exit.as_ref().and_then(|e| e.code),
                exit_signal: t.exit.as_ref().and_then(|e| e.signal.clone()),
                diffs: t
                    .diffs
                    .iter()
                    .map(|d| {
                        let hunk = super::vendored::diff::hunk(d);
                        DiffView {
                            path: d.path.clone(),
                            old: d.old.clone(),
                            new: d.new.clone(),
                            added: hunk.added,
                            removed: hunk.removed,
                        }
                    })
                    .collect(),
            }),
            Entry::Note(text) => ItemKind::Note(text.clone()),
            Entry::Notice {
                severity,
                title,
                text,
            } => ItemKind::Notice {
                severity: severity.clone(),
                title: title.clone(),
                text: text.clone(),
            },
            Entry::Done { text, ok } => ItemKind::Done {
                text: text.clone(),
                ok: *ok,
            },
        },
    }
}

fn option_view(o: &acp::ConfigOption) -> SessionOption {
    let is_mode = o.is("mode");
    SessionOption {
        id: o.id.clone(),
        name: o.name.clone(),
        category: o.category.clone(),
        current: if o.boolean {
            o.on.map(|on| on.to_string())
        } else {
            o.current.clone()
        },
        boolean: o.boolean,
        description: o.description.clone(),
        choices: if o.boolean {
            [("true", "On"), ("false", "Off")]
                .iter()
                .map(|(value, name)| OptionChoice {
                    value: (*value).to_owned(),
                    name: (*name).to_owned(),
                    risk: ModeRisk::None,
                })
                .collect()
        } else {
            o.choices
                .iter()
                .map(|(value, name)| OptionChoice {
                    value: value.clone(),
                    name: name.clone(),
                    risk: if is_mode {
                        match mode_risk::assess(value, name) {
                            mode_risk::Risk::None => ModeRisk::None,
                            mode_risk::Risk::Elevated => ModeRisk::Elevated,
                            mode_risk::Risk::Dangerous => ModeRisk::Dangerous,
                        }
                    } else {
                        ModeRisk::None
                    },
                })
                .collect()
        },
    }
}

/// A fingerprint of what the person was shown, so an answer to something else is refused.
fn waiting_digest(w: &session::Waiting) -> String {
    let mut h = Fnv::new();
    h.write(&serde_json::to_string(&w.id).unwrap_or_default());
    match &w.ask {
        session::Ask::Permission(r) => {
            h.write("permission");
            if let Some(t) = &r.tool_call {
                h.write(t.title.as_deref().unwrap_or(""));
                h.write(&t.subject().unwrap_or_default());
            }
            for o in &r.options {
                h.write(&o.id);
                h.write(&o.name);
                h.write(o.kind.as_deref().unwrap_or(""));
            }
        }
        session::Ask::Question(f) => {
            h.write("question");
            h.write(&f.message);
            for field in &f.fields {
                h.write(&field.name);
                h.write(field.label());
            }
        }
    }
    h.finish()
}

/// FNV-1a 64: a stable fingerprint, not a defence against an adversary (the keeper is the person's own).
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn write(&mut self, text: &str) {
        for b in text.bytes().chain([0xff]) {
            self.0 = (self.0 ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
        }
    }

    fn finish(&self) -> String {
        format!("{:016x}", self.0)
    }
}

fn waiting_view(w: &session::Waiting) -> Waiting {
    Waiting {
        request_id: serde_json::to_string(&w.id).unwrap_or_default(),
        digest: waiting_digest(w),
        arrived_ms: w.arrived_ms,
        ask: match &w.ask {
            session::Ask::Permission(r) => {
                let tool = r.tool_call.as_ref();
                let subject = tool.and_then(acp::ToolCall::subject);
                let kind = tool.and_then(|t| t.kind.clone());
                Ask::Permission(PermissionView {
                    title: tool
                        .and_then(|t| t.title.clone())
                        .unwrap_or_else(|| "The agent asks to continue".to_owned()),
                    risk: permission_risk(kind.as_deref(), subject.as_deref()),
                    kind,
                    subject,
                    choices: r
                        .options
                        .iter()
                        .map(|o| PermissionChoice {
                            id: o.id.clone(),
                            name: o.name.clone(),
                            kind: o.kind.clone(),
                            standing: o.is_standing()
                                || prompt::grants_standing_permission(&o.name),
                        })
                        .collect(),
                })
            }
            session::Ask::Question(form) => Ask::Question(question_view(form)),
        },
    }
}

/// Why this call deserves a second look, by the same rules the terminal prompts use.
fn permission_risk(kind: Option<&str>, subject: Option<&str>) -> Option<String> {
    let subject = subject?;
    let found = match kind {
        Some("edit" | "delete" | "move") => prompt::path_risk(subject),
        _ => prompt::command_risk(subject),
    };
    found.map(|r| r.reason().to_owned())
}

fn question_view(form: &Form) -> QuestionView {
    let content = form.content();
    QuestionView {
        message: form.message.clone(),
        description: form.description.clone(),
        fields: form
            .fields
            .iter()
            .map(|f| {
                let current = content.get(&f.name);
                let mut field = QuestionField {
                    name: f.name.clone(),
                    label: f.label().to_owned(),
                    description: f.description.clone(),
                    required: f.required,
                    secret: f.secret,
                    kind: FieldKind::Unsupported,
                    integer: false,
                    choices: Vec::new(),
                    text: String::new(),
                    choice: None,
                    ticked: Vec::new(),
                };
                let index_of = |options: &[question::Choice], v: &serde_json::Value| {
                    options
                        .iter()
                        .position(|c| Some(c.value.as_str()) == v.as_str())
                };
                let choices = |options: &[question::Choice]| {
                    options
                        .iter()
                        .map(|c| FieldChoice {
                            value: c.value.clone(),
                            title: c.title.clone(),
                        })
                        .collect::<Vec<_>>()
                };
                match &f.kind {
                    Kind::Text { .. } => {
                        field.kind = FieldKind::Text;
                        field.text = current
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                    }
                    Kind::Number { integer, .. } => {
                        field.kind = FieldKind::Number;
                        field.integer = *integer;
                        field.text = current.map(ToString::to_string).unwrap_or_default();
                    }
                    Kind::One(options) => {
                        field.kind = FieldKind::Choice;
                        field.choices = choices(options);
                        field.choice = current.and_then(|v| index_of(options, v));
                    }
                    Kind::Many { options, .. } => {
                        field.kind = FieldKind::Multi;
                        field.choices = choices(options);
                        field.ticked = current
                            .and_then(serde_json::Value::as_array)
                            .map(|a| a.iter().filter_map(|v| index_of(options, v)).collect())
                            .unwrap_or_default();
                    }
                    Kind::Bool => {
                        field.kind = FieldKind::Bool;
                        field.choice =
                            Some(usize::from(current != Some(&serde_json::Value::Bool(true))));
                    }
                    Kind::Unknown(_) => {}
                }
                field
            })
            .collect(),
    }
}

/// The acts that carry `answers` through the form, field by field.
fn question_steps(form: &Form, answers: &[FieldAnswer]) -> Vec<Act> {
    let content = form.content();
    let mut steps = Vec::new();
    for (i, f) in form.fields.iter().enumerate() {
        let answer = answers.get(i).cloned().unwrap_or_default();
        match &f.kind {
            Kind::Text { .. } | Kind::Number { .. } => {
                let start = content
                    .get(&f.name)
                    .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                    .unwrap_or_default();
                steps.push(Act::Enter(answer.text.unwrap_or(start)));
            }
            Kind::One(_) | Kind::Bool => {
                if let Some(c) = answer.choice {
                    steps.push(Act::Pick(c));
                }
                steps.push(Act::Enter(String::new()));
            }
            Kind::Many { options, .. } => {
                if let Some(want) = &answer.ticked {
                    let now: Vec<usize> = content
                        .get(&f.name)
                        .and_then(serde_json::Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| {
                                    options
                                        .iter()
                                        .position(|c| Some(c.value.as_str()) == v.as_str())
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    // `Pick` toggles a tick: flip what differs.
                    for n in 0..options.len() {
                        if want.contains(&n) != now.contains(&n) {
                            steps.push(Act::Pick(n));
                        }
                    }
                }
                steps.push(Act::Enter(String::new()));
            }
            Kind::Unknown(_) => steps.push(Act::Enter(String::new())),
        }
    }
    if form.fields.is_empty() {
        steps.push(Act::Enter(String::new()));
    }
    steps
}

/// What an observed session shows besides its transcript: where the session stands, decided by the owner of
/// the pane and the log.
pub(crate) struct ObservedMeta {
    pub phase: SessionPhase,
    pub agent: String,
    pub cwd: String,
    /// The title when the log has none.
    pub fallback_title: Option<String>,
    pub waiting: Vec<Waiting>,
    pub running: bool,
    pub info: ObservedInfo,
}

/// The transcript of an observed session: the vendored reducer fed with the [`Update`]s a log mapper makes.
/// The log is the truth, so a message line mapped again replaces the message, and a cleared log empties it.
pub(crate) struct ObservedTranscript {
    transcript: Transcript,
    /// Pictures of messages, by message id (the reducer holds text only).
    images: HashMap<String, Vec<ImageRef>>,
    items: ItemCache,
    revision: u64,
    /// The key a screen sees for each transcript item, by the item's transcript id. The transcript's own
    /// ids restart when a wider read replaces it ([`adopt`](Self::adopt)); these do not, so a list keeps
    /// its place by them.
    keys: HashMap<u64, u64>,
    /// The next key for an item newer than every one shown, and the lowest given so far (older items
    /// that a wider read brings count down from it).
    next_key: u64,
    low_key: u64,
    /// The agent's commands as its mapper said them, kind included (the reducer's ACP commands have none).
    commands: Vec<SlashCommand>,
}

/// Where keys begin: far from 0 so older items can take keys below the first.
const KEY_BASE: u64 = 1 << 32;

impl Default for ObservedTranscript {
    fn default() -> Self {
        Self {
            transcript: Transcript::default(),
            images: HashMap::new(),
            items: ItemCache::default(),
            revision: 0,
            keys: HashMap::new(),
            next_key: KEY_BASE,
            low_key: KEY_BASE,
            commands: Vec::new(),
        }
    }
}

/// What makes an item the same item in another read of the log: a message by its id, a tool call by its id.
fn identity(entry: &Entry) -> Option<String> {
    match entry {
        Entry::Message {
            role,
            message_id: Some(id),
            ..
        } => Some(format!("m{role:?}:{id}")),
        Entry::Tool(t) => Some(format!("t:{}", t.id)),
        _ => None,
    }
}

impl ObservedTranscript {
    /// Gives every item without a key the next one.
    fn assign_keys(&mut self) {
        for item in self.transcript.items() {
            self.keys.entry(item.id).or_insert_with(|| {
                self.next_key += 1;
                self.next_key - 1
            });
        }
        if let Some(first) = self.transcript.items().front().map(|i| i.id) {
            self.keys.retain(|id, _| *id >= first);
        }
    }

    /// A wider read of the same log replaces what is shown. What was shown keeps its keys (the list holds its
    /// place by them); the older items it brings take keys below the first, so they arrive above the rows in
    /// view. Items are told apart by their message or tool call id and lined up from the first one the old
    /// and the new have in common; the old read stopped where the new one began to catch up, so the new one
    /// is the old plus what came after.
    pub(crate) fn adopt(&mut self, wide: ObservedTranscript) {
        self.assign_keys();
        let old: Vec<(Option<String>, u64)> = self
            .transcript
            .items()
            .iter()
            .map(|i| (identity(&i.entry), self.keys[&i.id]))
            .collect();
        let new: Vec<(u64, Option<String>)> = wide
            .transcript
            .items()
            .iter()
            .map(|i| (i.id, identity(&i.entry)))
            .collect();
        let mut reuse: Vec<Option<u64>> = vec![None; new.len()];
        let anchor = old.iter().position(|(id, _)| id.is_some());
        if let Some(at) = anchor
            && let Some(found) = new.iter().position(|(_, id)| *id == old[at].0)
        {
            for (i, (id, key)) in old.iter().enumerate() {
                if let Some(n) = (i + found).checked_sub(at)
                    && let Some((_, theirs)) = new.get(n)
                    && theirs == id
                {
                    reuse[n] = Some(*key);
                }
            }
        }
        let first = reuse.iter().position(Option::is_some).unwrap_or(0);
        let mut keys = HashMap::with_capacity(new.len());
        for (src, _) in new.iter().take(first).rev() {
            self.low_key -= 1;
            keys.insert(*src, self.low_key);
        }
        for (n, (src, _)) in new.iter().enumerate().skip(first) {
            let key = reuse[n].unwrap_or_else(|| {
                self.next_key += 1;
                self.next_key - 1
            });
            keys.insert(*src, key);
        }
        self.transcript = wide.transcript;
        self.images = wide.images;
        self.commands = wide.commands;
        self.keys = keys;
        self.items = ItemCache::default();
    }

    /// Applies what one log line changed.
    pub(crate) fn apply(&mut self, update: Update) {
        match update {
            Update::Message { role, id, blocks } => {
                let mut text = String::new();
                let mut images = Vec::new();
                for block in blocks {
                    match block {
                        Block::Text(t) => text.push_str(&t),
                        Block::Image(image) => images.push(image_ref(&image.mime, &image.source)),
                    }
                }
                let role = match role {
                    super::types::Role::User => transcript::Role::User,
                    super::types::Role::Agent => transcript::Role::Agent,
                    super::types::Role::Thought => transcript::Role::Thought,
                };
                if images.is_empty() {
                    self.images.remove(&id);
                } else {
                    self.images.insert(id.clone(), images);
                }
                self.transcript.upsert_message(role, &id, text);
            }
            Update::ToolStart(mut call) | Update::ToolPatch(mut call) => {
                // The reducer knows four states; a call the interruption left without a result is a failed one.
                if call.get("status").and_then(serde_json::Value::as_str) == Some("cancelled") {
                    call["status"] = "failed".into();
                }
                if let Some(call) = acp::ToolCall::from_value(&call) {
                    self.transcript.apply(SessionUpdate::ToolCallUpdate(call));
                }
            }
            Update::Plan(steps) => {
                let entries: Vec<_> = steps
                    .iter()
                    .map(|s| {
                        serde_json::json!({"content": s.content, "status": match s.status {
                            PlanStatus::Pending => "pending",
                            PlanStatus::InProgress => "in_progress",
                            PlanStatus::Completed => "completed",
                        }})
                    })
                    .collect();
                self.session_update(
                    &serde_json::json!({"sessionUpdate": "plan", "entries": entries}),
                );
            }
            Update::Title(title) => {
                self.session_update(
                    &serde_json::json!({"sessionUpdate": "session_info_update", "title": title}),
                );
            }
            Update::Commands(commands) => self.commands = commands,
            Update::Cleared => {
                self.transcript.clear();
                self.images.clear();
                self.keys.clear();
            }
        }
    }

    fn session_update(&mut self, update: &serde_json::Value) {
        if let Some(u) = SessionUpdate::from_value(update) {
            self.transcript.apply(u);
        }
    }

    /// The texts of the last `n` messages of the person, newest first.
    pub(crate) fn recent_user_texts(&self, n: usize) -> Vec<String> {
        self.transcript
            .items()
            .iter()
            .rev()
            .filter_map(|i| match &i.entry {
                Entry::Message {
                    role: transcript::Role::User,
                    text,
                    ..
                } => Some(text.clone()),
                _ => None,
            })
            .take(n)
            .collect()
    }

    /// The conversation as it stands, with `meta` around it.
    pub(crate) fn snapshot(&mut self, meta: ObservedMeta) -> SessionSnapshot {
        self.revision += 1;
        self.assign_keys();
        let keys = &self.keys;
        let items = self
            .items
            .snapshot(self.transcript.items(), Some(&self.images), &|id| {
                keys.get(&id).copied().unwrap_or(id)
            });
        SessionSnapshot {
            revision: self.revision,
            phase: meta.phase,
            agent: meta.agent,
            cwd: meta.cwd,
            title: self
                .transcript
                .title()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
                .or(meta.fallback_title),
            items,
            dropped_items: self.transcript.dropped(),
            earlier_notice: None,
            waiting: meta.waiting,
            queue: Vec::new(),
            commands: self.commands.clone(),
            options: Vec::new(),
            plan: self
                .transcript
                .plan()
                .iter()
                .map(|p| PlanStep {
                    content: p.content.clone(),
                    status: match p.status {
                        acp::PlanStatus::Pending => PlanStatus::Pending,
                        acp::PlanStatus::InProgress => PlanStatus::InProgress,
                        acp::PlanStatus::Completed => PlanStatus::Completed,
                    },
                })
                .collect(),
            mode: None,
            context_percent: None,
            running: meta.running,
            accepts_pictures: false,
            connection_lost: false,
            cached_at_ms: None,
            unsent: None,
            observed: Some(meta.info),
            acp: AcpInfo::default(),
        }
    }
}

/// How a picture is named to a screen: its cache key, and an opaque `source` that [`picture_ref`] reads back.
fn image_ref(mime: &str, source: &PictureRef) -> ImageRef {
    let (src, bytes) = match source {
        PictureRef::Keeper { start, hash, bytes } => (format!("keeper:{start}:{hash}"), *bytes),
        PictureRef::Omp { sha256, bytes } => (format!("omp:{sha256}"), *bytes),
    };
    ImageRef {
        key: source.key(),
        mime: mime.to_owned(),
        bytes,
        source: src,
    }
}

/// The picture a screen's `source` string names; `None` for anything that is not one.
pub(crate) fn picture_ref(source: &str) -> Option<PictureRef> {
    let mut parts = source.split(':');
    match (parts.next()?, parts.next(), parts.next(), parts.next()) {
        ("keeper", Some(start), Some(hash), None) => Some(PictureRef::Keeper {
            start: start.parse().ok()?,
            hash: hash.to_owned(),
            bytes: None,
        }),
        ("omp", Some(sha), None, None) => Some(PictureRef::Omp {
            sha256: sha.to_owned(),
            bytes: None,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A driver whose session is open, with nothing sent yet.
    fn open() -> Driver {
        let (mut d, first) = Driver::new(
            Begin::Create {
                cwd: "/work".into(),
            },
            "omp",
            "/work",
            0,
            None,
        );
        assert!(matches!(first.as_slice(), [Action::Write(_)]));
        d.on_line(
            r#"{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{}}}"#,
            0,
        );
        d.on_line(r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}"#, 0);
        assert_eq!(d.phase(), SessionPhase::Idle);
        d
    }

    fn request(d: &mut Driver, id: &str, method: &str, params: serde_json::Value, at: u64) {
        let line = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        d.on_line(&line.to_string(), at);
    }

    #[test]
    fn a_form_is_answered_all_at_once_and_a_bad_field_leaves_it_as_it_was() {
        let mut d = open();
        request(
            &mut d,
            "q1",
            "elicitation/create",
            json!({"sessionId": "s1", "mode": "form", "message": "Details?", "requestedSchema": {
            "type": "object", "required": ["name"],
            "properties": {
                "name": {"type": "string", "title": "Name"},
                "count": {"type": "integer", "title": "How many", "minimum": 1},
                "kind": {"type": "string", "enum": ["a", "b", "c"]},
                "tags": {"type": "array", "items": {"type": "string", "enum": ["x", "y", "z"]}},
                "sure": {"type": "boolean", "default": true}
            }}}),
            0,
        );
        assert_eq!(d.phase(), SessionPhase::BlockedOnQuestion);
        let snapshot = d.snapshot();
        let w = &snapshot.waiting[0];
        let Ask::Question(form) = &w.ask else {
            panic!("a question")
        };
        let kinds: Vec<_> = form.fields.iter().map(|f| f.kind).collect();
        assert_eq!(
            kinds,
            [
                FieldKind::Text,
                FieldKind::Number,
                FieldKind::Choice,
                FieldKind::Multi,
                FieldKind::Bool
            ]
        );
        assert_eq!(form.fields[4].choice, Some(0), "the agent's default is yes");

        let good = |count: &str| {
            vec![
                FieldAnswer {
                    text: Some("Ada".into()),
                    ..FieldAnswer::default()
                },
                FieldAnswer {
                    text: Some(count.into()),
                    ..FieldAnswer::default()
                },
                FieldAnswer {
                    choice: Some(2),
                    ..FieldAnswer::default()
                },
                FieldAnswer {
                    ticked: Some(vec![0, 2]),
                    ..FieldAnswer::default()
                },
                FieldAnswer {
                    choice: Some(1),
                    ..FieldAnswer::default()
                },
            ]
        };
        // A number that does not pass is refused, naming the field, and nothing was sent or advanced.
        let refused = d.answer_question(&w.request_id, &w.digest, &good("0"), 1_000);
        assert_eq!(
            refused,
            Err(Refusal::Invalid("How many: At least 1".into()))
        );
        assert_eq!(d.phase(), SessionPhase::BlockedOnQuestion);

        // Too soon after the question appeared: nothing is confirmed.
        assert_eq!(
            d.answer_question(&w.request_id, &w.digest, &good("3"), 100),
            Err(Refusal::TooSoon)
        );

        let actions = d
            .answer_question(&w.request_id, &w.digest, &good("3"), 1_000)
            .expect("accepted");
        let [Action::Write(line)] = actions.as_slice() else {
            panic!("one answer goes out: {actions:?}")
        };
        let sent: serde_json::Value = serde_json::from_str(line).expect("json");
        assert_eq!(sent["id"], "q1");
        assert_eq!(
            sent["result"],
            json!({"action": "accept", "content": {
                "name": "Ada", "count": 3, "kind": "c", "tags": ["x", "z"], "sure": false}})
        );
        assert_eq!(d.phase(), SessionPhase::Idle);
    }

    #[test]
    fn a_command_that_pushes_or_deletes_says_why_and_a_standing_grant_is_marked() {
        let mut d = open();
        request(
            &mut d,
            "p1",
            "session/request_permission",
            json!({"sessionId": "s1",
                "toolCall": {"toolCallId": "t1", "title": "Run git push", "kind": "execute",
                    "rawInput": {"command": "git push --force origin main"}},
                "options": [
                    {"optionId": "once", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
                    {"optionId": "no", "name": "Reject", "kind": "reject_once"}]}),
            0,
        );
        let snapshot = d.snapshot();
        let Ask::Permission(view) = &snapshot.waiting[0].ask else {
            panic!("a permission")
        };
        assert_eq!(
            view.subject.as_deref(),
            Some("git push --force origin main")
        );
        assert!(view.risk.is_some(), "a force push deserves a second look");
        let standing: Vec<_> = view.choices.iter().map(|c| c.standing).collect();
        assert_eq!(standing, [false, true, false]);
    }

    #[test]
    fn a_request_that_changed_under_the_persons_eyes_is_refused() {
        let mut d = open();
        let ask = |d: &mut Driver, id: &str, title: &str, at: u64| {
            request(
                d,
                id,
                "session/request_permission",
                json!({"sessionId": "s1", "toolCall": {"toolCallId": id, "title": title},
                    "options": [{"optionId": "ok", "name": "Allow once", "kind": "allow_once"}]}),
                at,
            );
        };
        ask(&mut d, "p1", "Run ls", 0);
        let shown = d.snapshot().waiting[0].clone();
        // The first was answered elsewhere; another took its place before the person pressed.
        d.on_line(
            r#"{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":"p1"}}"#,
            10,
        );
        ask(&mut d, "p2", "Run rm -rf /", 20);
        assert_eq!(
            d.answer_permission(&shown.request_id, &shown.digest, "ok", 5_000),
            Err(Refusal::Changed)
        );
        assert_eq!(d.phase(), SessionPhase::BlockedOnPermission);
    }

    #[test]
    fn unchanged_items_keep_their_identity_from_one_snapshot_to_the_next() {
        let mut d = open();
        let chunk = |text: &str| {
            json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1",
                "update": {"sessionUpdate": "agent_message_chunk", "messageId": text,
                    "content": {"type": "text", "text": text}}}})
            .to_string()
        };
        d.on_line(&chunk("first"), 0);
        let before = d.snapshot();
        d.on_line(&chunk("second"), 0);
        let after = d.snapshot();
        assert_eq!(after.items.len(), 2);
        assert!(Arc::ptr_eq(&before.items[0], &after.items[0]));
        assert!(after.revision > before.revision);
    }

    fn update_line(update: serde_json::Value) -> String {
        json!({"jsonrpc": "2.0", "method": "session/update",
            "params": {"sessionId": "s1", "update": update}})
        .to_string()
    }

    fn tool_view(d: &mut Driver) -> ToolView {
        d.snapshot()
            .items
            .iter()
            .find_map(|i| match &i.kind {
                ItemKind::Tool(t) => Some(t.clone()),
                _ => None,
            })
            .expect("a tool call")
    }

    #[test]
    fn a_long_streamed_output_keeps_only_its_head_and_tail_however_long_it_runs() {
        let mut d = open();
        d.on_line(
            &update_line(
                json!({"sessionUpdate": "tool_call", "toolCallId": "t", "title": "make",
                "content": [{"type": "terminal", "terminalId": "t"}]}),
            ),
            1,
        );
        for i in 0..3000 {
            d.on_line(
                &update_line(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t",
                    "_meta": {"terminal_output_delta": {"terminal_id": "t", "data": format!("line {i}\n")}}})),
                2,
            );
        }
        // The line being written shows too, before its newline arrives.
        d.on_line(
            &update_line(
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "t",
                "_meta": {"terminal_output_delta": {"terminal_id": "t", "data": "writ"}}}),
            ),
            3,
        );
        let t = tool_view(&mut d);
        assert_eq!((t.head.len(), t.tail.len()), (12, 12));
        assert_eq!(t.head[0], "line 0");
        assert_eq!(t.tail.last().map(String::as_str), Some("writ"));
        assert_eq!(t.tail[10], "line 2999");
        assert_eq!(t.omitted, 3001 - 24);
        assert!(
            d.transcript.bytes() < 4000,
            "the whole output is not held: {}",
            d.transcript.bytes()
        );
    }

    #[test]
    fn what_the_agent_puts_in_content_is_its_own_account_and_wins_over_the_stream() {
        let mut d = open();
        d.on_line(
            &update_line(
                json!({"sessionUpdate": "tool_call", "toolCallId": "t", "title": "x",
                "rawOutput": "raw result",
                "_meta": {"terminal_output": {"terminal_id": "t", "data": "streamed\n"}}}),
            ),
            1,
        );
        assert_eq!(
            tool_view(&mut d).head,
            ["streamed"],
            "the stream beats the raw result"
        );
        d.on_line(
            &update_line(json!({"sessionUpdate": "tool_call_update", "toolCallId": "t",
                "content": [{"type": "content", "content": {"type": "text", "text": "final account"}}]})),
            2,
        );
        assert_eq!(tool_view(&mut d).head, ["final account"]);
    }

    #[test]
    fn a_notice_in_a_history_replay_is_not_news_but_a_live_one_is() {
        let (mut d, _) = Driver::new(Begin::Attach, "omp", "/work", 0, None);
        d.on_line(
            r#"{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{}}}"#,
            0,
        );
        d.on_record(
            Some(RecordInfo {
                session_id: Some("s1".into()),
                cwd: "/work".into(),
                exited: None,
            }),
            0,
        );
        let notice = update_line(
            json!({"sessionUpdate": "notice", "severity": "error", "title": "Out of credit"}),
        );
        d.on_line(&notice, 1);
        d.on_line(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#, 2);
        assert_eq!(d.phase(), SessionPhase::Idle);
        let count = |d: &mut Driver| {
            d.snapshot()
                .items
                .iter()
                .filter(|i| matches!(i.kind, ItemKind::Notice { .. }))
                .count()
        };
        assert_eq!(count(&mut d), 0, "the replayed notice was dropped");
        d.on_line(&notice, 3);
        assert_eq!(count(&mut d), 1);
    }

    #[test]
    fn a_stopped_turn_leaves_its_open_calls_cancelled_and_a_normal_end_leaves_them_without_a_result()
     {
        for (stop, said) in [("cancelled", "cancelled"), ("max_tokens", "no result")] {
            let mut d = open();
            d.send("go", Outgoing::default(), 0).expect("send");
            d.on_line(
                &update_line(
                    json!({"sessionUpdate": "tool_call", "toolCallId": "t", "title": "Run it",
                    "status": "in_progress"}),
                ),
                1,
            );
            d.on_line(
                &json!({"jsonrpc": "2.0", "id": 3, "result": {"stopReason": stop}}).to_string(),
                2,
            );
            let t = tool_view(&mut d);
            assert_eq!(t.status, ToolStatus::Failed);
            assert!(t.title.ends_with(said), "{}", t.title);
        }
    }

    // The saved copy of a conversation: what is shown at once, and what the keeper is asked to send again.

    const LOADED: &str = r#"{"jsonrpc":"2.0","id":2,"result":{}}"#;

    fn chunk_line(kind: &str, id: &str, text: &str, stamp: Option<(&str, u64)>) -> String {
        let mut params = json!({"sessionId": "s1", "update": {"sessionUpdate": kind,
            "messageId": id, "content": {"type": "text", "text": text}}});
        if let Some((epoch, turn)) = stamp {
            params["_meta"] = json!({"herdr": {"epoch": epoch, "turn": turn}});
        }
        json!({"jsonrpc": "2.0", "method": "session/update", "params": params}).to_string()
    }

    /// One turn as the keeper replays it: the first line names the turn and the keeper's run.
    fn turn_lines(epoch: &str, turn: u64) -> Vec<String> {
        vec![
            chunk_line(
                "user_message_chunk",
                &format!("u{turn}"),
                &format!("question {turn}"),
                Some((epoch, turn)),
            ),
            chunk_line(
                "agent_message_chunk",
                &format!("a{turn}"),
                &format!("answer {turn} "),
                None,
            ),
            chunk_line("agent_message_chunk", &format!("a{turn}"), "done", None),
        ]
    }

    fn turns(epoch: &str, from: u64, to: u64) -> Vec<String> {
        (from..=to).flat_map(|t| turn_lines(epoch, t)).collect()
    }

    fn saved_of(lines: Vec<String>) -> Saved {
        let mut window = Window::default();
        for line in lines {
            window.push("s1", line);
        }
        Saved::decode(&window.encode(1_000)).expect("a copy that reads back")
    }

    /// An attach whose keeper has answered `initialize` and whose record names session `sid`, and the `session/load`
    /// it then sent.
    fn attach(copy: Option<Saved>, sid: &str) -> (Driver, serde_json::Value) {
        let (mut d, _) = Driver::new(Begin::Attach, "omp", "/work", 0, copy);
        d.on_line(
            r#"{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{}}}"#,
            0,
        );
        let actions = d.on_record(
            Some(RecordInfo {
                session_id: Some(sid.into()),
                cwd: "/work".into(),
                exited: None,
            }),
            0,
        );
        let load = actions
            .iter()
            .find_map(|a| match a {
                Action::Write(line) => serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .filter(|v| v["method"] == "session/load"),
                _ => None,
            })
            .expect("the session/load");
        (d, load)
    }

    fn feed(d: &mut Driver, lines: &[String]) {
        for line in lines {
            d.on_line(line, 1);
        }
    }

    fn replay_notice(from: u64) -> String {
        json!({"jsonrpc": "2.0", "method": "_herdr/replay",
            "params": {"sessionId": "s1", "from": from}})
        .to_string()
    }

    /// Who said what, in order.
    fn said(d: &mut Driver) -> Vec<(Role, String)> {
        d.snapshot()
            .items
            .iter()
            .filter_map(|i| match &i.kind {
                ItemKind::Message { role, text, .. } => Some((*role, text.clone())),
                _ => None,
            })
            .collect()
    }

    fn recorded(d: &Driver) -> Vec<String> {
        d.window().lock().lines().map(str::to_owned).collect()
    }

    fn since_of(load: &serde_json::Value) -> Option<serde_json::Value> {
        load.pointer("/params/_meta/herdr/since").cloned()
    }

    /// What a full replay of turns 1 to 5 gives, and what it records.
    fn full_replay() -> (Vec<(Role, String)>, Vec<String>) {
        let (mut d, load) = attach(None, "s1");
        assert_eq!(since_of(&load), None, "nothing to continue from");
        feed(&mut d, &turns("e1", 1, 5));
        d.on_line(LOADED, 2);
        let said = said(&mut d);
        assert_eq!(said.len(), 10);
        (said, recorded(&d))
    }

    /// A copy saved in the middle of turn 3: turns 1 and 2 whole and only the first line of turn 3.
    fn copy_in_turn_three(epoch: &str) -> Saved {
        let mut lines = turns(epoch, 1, 2);
        lines.extend(turn_lines(epoch, 3).into_iter().take(1));
        saved_of(lines)
    }

    #[test]
    fn a_replay_that_goes_on_from_the_copys_last_turn_makes_the_same_conversation_as_a_whole_one() {
        let (want, want_recorded) = full_replay();
        let (mut d, load) = attach(Some(copy_in_turn_three("e1")), "s1");
        assert_eq!(
            since_of(&load),
            Some(json!({"epoch": "e1", "turn": 3})),
            "the keeper is asked for turn 3 on"
        );
        d.on_line(&replay_notice(3), 1);
        feed(&mut d, &turns("e1", 3, 5));
        d.on_line(LOADED, 2);
        assert_eq!(said(&mut d), want, "no turn twice, none missing");
        assert_eq!(recorded(&d), want_recorded, "the next copy is the same too");
    }

    #[test]
    fn a_keeper_that_ignored_the_ask_leaves_nothing_of_the_copy_in_the_conversation() {
        // The keeper started again (another run): it does not know the copy's turn and replays everything.
        let (want, _) = full_replay();
        let (mut d, load) = attach(Some(copy_in_turn_three("e1")), "s1");
        assert!(since_of(&load).is_some());
        feed(&mut d, &turns("e2", 1, 5));
        d.on_line(LOADED, 2);
        assert_eq!(said(&mut d), want);
        assert_eq!(
            recorded(&d),
            turns("e2", 1, 5),
            "the copy is the new replay, not both"
        );
    }

    #[test]
    fn the_keeper_is_asked_to_continue_only_from_a_copy_that_is_whole_and_has_a_turn_before_its_stamp()
     {
        let whole = |c: &Saved| since_of(&attach(Some(c.clone()), "s1").1).is_some();
        let base = copy_in_turn_three("e1");
        assert!(whole(&base));

        let mut partial = base.clone();
        partial.header.partial = true;
        assert!(
            !whole(&partial),
            "a copy that lost its front would show less than a full replay"
        );

        let mut gap = base.clone();
        gap.header.gap = true;
        assert!(!whole(&gap));

        assert!(
            !whole(&saved_of(turn_lines("e1", 1))),
            "the stamp is on the first line: nothing is held before it"
        );
        let unstamped = turn_lines("e1", 1).split_off(1);
        assert!(
            !whole(&saved_of(unstamped)),
            "no stamp, nowhere to continue from"
        );

        assert!(
            since_of(&attach(Some(base), "another-session").1).is_none(),
            "a stamp is only good for the session it was counted in"
        );
    }

    #[test]
    fn the_copy_stays_on_screen_until_the_keeper_has_answered_and_then_gives_way() {
        let copy = copy_in_turn_three("e1");
        let (mut d, _) = attach(Some(copy.clone()), "s1");
        let (mut from_copy, _) = attach(None, "s1");
        feed(&mut from_copy, &copy.lines);
        // What the copy would show if it were a live conversation.
        let shown = said(&mut from_copy);
        let before = d.snapshot();
        assert_eq!(said(&mut d), shown);
        assert_eq!(before.cached_at_ms, Some(1_000));
        assert_eq!(before.phase, SessionPhase::Connecting);
        assert!(!before.running);

        d.on_line(&replay_notice(3), 1);
        feed(&mut d, &turns("e1", 3, 4));
        assert_eq!(said(&mut d), shown, "half a replay is not shown");
        assert_eq!(d.snapshot().cached_at_ms, Some(1_000));

        feed(&mut d, &turns("e1", 5, 5));
        d.on_line(LOADED, 2);
        let after = d.snapshot();
        assert_eq!(after.cached_at_ms, None);
        assert_eq!(after.phase, SessionPhase::Idle);
        assert_eq!(said(&mut d).len(), 10);

        // A new keeper has no log to continue: the copy does not apply.
        let (mut created, _) = Driver::new(
            Begin::Create {
                cwd: "/work".into(),
            },
            "omp",
            "/work",
            0,
            Some(copy),
        );
        assert!(said(&mut created).is_empty());
        assert_eq!(created.snapshot().cached_at_ms, None);
    }

    #[test]
    fn what_is_typed_in_the_app_is_in_the_copy_though_the_keeper_never_sends_it_back() {
        let mut d = open();
        let (_, actions) = d
            .send("fix the build", Outgoing::default(), 0)
            .expect("send");
        for action in &actions {
            if let Action::Write(line) = action {
                d.note_sent(line);
            }
        }
        let lines = recorded(&d);
        assert_eq!(lines.len(), 1);
        let copy = Saved {
            header: crate::session::copy::Header {
                v: 1,
                sid: Some("s1".into()),
                saved_ms: 5,
                partial: false,
                gap: false,
            },
            lines,
        };
        let (mut seeded, _) = attach(Some(copy), "s1");
        assert_eq!(said(&mut seeded), said(&mut d));
        assert_eq!(
            said(&mut seeded),
            [(Role::User, "fix the build".to_owned())]
        );
    }

    #[test]
    fn nothing_is_sent_or_answered_against_a_copy() {
        let (mut d, _) = attach(Some(copy_in_turn_three("e1")), "s1");
        assert_eq!(
            d.send("hello", Outgoing::default(), 0),
            Err(Refusal::NotReady)
        );
        assert_eq!(
            d.answer_permission("1", "digest", "allow", 0),
            Err(Refusal::NotReady)
        );
    }
}
