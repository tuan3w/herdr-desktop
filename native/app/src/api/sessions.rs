//! The `Sessions` module: chats with ACP agents (omp, Claude Code, Codex, pi) that a keeper process owns
//! on a machine, so the agent outlives this window and the ssh connection.
//!
//! The shape is the same as `Herdr`: functions that talk to a machine are `async` (they run on blocking
//! threads and settle a promise); `view`, `items` and `itemIds` are synchronous pulls after
//! `Herdr.onChange` says something changed, and never touch a signal. Sessions bump that same change
//! counter, so a screen subscribes once. Nothing here is pushed into TSX.
//!
//! Safety, as everywhere in this app: nothing is ever approved by a timer, a default or a notification.
//! `answerPermission` and `answerQuestion` send only for the request the person was shown (same
//! `requestId` and `digest`), refuse within 400 ms of it appearing, and say what they refused as an
//! `ActionResult`, not an exception. Risky answers are two steps in the UI (`WaitingView.risk`,
//! `PermissionChoiceView.standing`). A session this app did not start is never killed by it.

use std::sync::Arc;

use herdr_core::observed::session::ObservedHandle;
use herdr_core::session::{
    KeeperError, Pasted, Refusal, SendOutcome, SessionHandle, SessionSnapshot,
};
use nsh_core::prelude::*;

use super::session_views::{
    ActionResult, AgentRoute, FieldAnswerInput, PastSessionsView, PictureInput, ResumeSession,
    SessionInfo, SessionItem, SessionRef, SessionView, StartSession, UnqueuedView,
};
use super::{engine, run};

fn text(e: KeeperError) -> String {
    e.message()
}

/// The ids of chats read from a terminal's log start with this, then the pane id: `pane:w1:p2`. Every
/// function that takes a session id takes either kind.
const PANE_ID: &str = "pane:";

/// The ids of a subagent's transcript read from a terminal agent's log: `sub:<paneId>#<name>`. A pane id never
/// holds `#`; the name is the subagent's as the parent's log gives it.
const SUB_ID: &str = "sub:";

/// The pane and subagent name of a subagent chat's id.
fn sub_id(id: &str) -> Option<(&str, &str)> {
    id.strip_prefix(SUB_ID)?.split_once('#')
}

/// A session of either kind: a keeper's, or an agent in a terminal pane read from its log.
enum Chat {
    Keeper(SessionHandle),
    Observed(ObservedHandle),
}

impl Chat {
    fn find(machine: &str, id: &str) -> Result<Option<Chat>, String> {
        let engine = engine()?;
        if let Some((pane, name)) = sub_id(id) {
            return Ok(engine
                .sessions()
                .observed(machine, pane)
                .and_then(|parent| parent.subagent(name))
                .map(Chat::Observed));
        }
        Ok(match id.strip_prefix(PANE_ID) {
            Some(pane) => engine
                .sessions()
                .observed(machine, pane)
                .map(Chat::Observed),
            None => engine.sessions().handle(machine, id).map(Chat::Keeper),
        })
    }

    fn snapshot(&self) -> Arc<SessionSnapshot> {
        match self {
            Chat::Keeper(h) => h.snapshot(),
            Chat::Observed(h) => h.snapshot(),
        }
    }
}

/// What a terminal's chat cannot do: the person does it in the terminal.
fn in_the_terminal(what: &str) -> Refusal {
    Refusal::Blocked(format!("{what} in the terminal."))
}

/// Runs an action of the person on the open chat on a blocking thread.
async fn act<T: Send + 'static>(
    machine: String,
    id: String,
    f: impl FnOnce(&Chat) -> Result<T, Refusal> + Send + 'static,
    ok: impl FnOnce(T) -> ActionResult + Send + 'static,
) -> Result<ActionResult, String> {
    run(move |_| {
        let Some(chat) = Chat::find(&machine, &id)? else {
            return Ok(Refusal::Stopped.into());
        };
        Ok(match f(&chat) {
            Ok(value) => ok(value),
            Err(refusal) => refusal.into(),
        })
    })
    .await
}

/// Agent sessions: the chats the keepers on every machine hold. `probe` and `start` fill the New session
/// form; `list` and `Herdr.board()` show what exists; `attach` opens one and `view`/`items` read it.
#[module]
pub struct Sessions;

#[module]
impl Sessions {
    /// The agents `machine` can run, for the New session form. Installs the helper on a remote machine
    /// the first time (a small python file under `~/.herdr-mobile/desktop`); throws with the reason and
    /// what to do when the machine has no python3 or cannot be reached.
    pub async fn probe(machine: String) -> Result<Vec<AgentRoute>, String> {
        run(move |engine| {
            engine
                .sessions()
                .probe(&machine)
                .map(|all| all.into_iter().map(Into::into).collect())
                .map_err(text)
        })
        .await
    }

    /// The sessions `machine`'s keeper holds now: running ones, and ones whose agent exited within a day
    /// (`state: "exited"`, with `exitReason`). Refreshed by the app every 30 s while the window is in use
    /// (5 min while it is not); call this when a screen opens for the freshest answer.
    pub async fn list(machine: String) -> Result<Vec<SessionInfo>, String> {
        run(move |engine| {
            let hub = engine.sessions();
            let all = hub.list(&machine).map_err(text)?;
            Ok(all
                .into_iter()
                .map(|k| {
                    let attached = hub.handle(&machine, &k.id).is_some();
                    let owned = hub.owns(&machine, &k.id);
                    SessionInfo::new(k, attached, owned)
                })
                .collect())
        })
        .await
    }

    /// What `agent` remembers on `machine` (its own store of past sessions, newest first), in `cwd` or
    /// everywhere. Runs the agent briefly; it can take seconds. Reopen one with `resume`.
    pub async fn history(
        machine: String,
        agent: String,
        cwd: Option<String>,
    ) -> Result<PastSessionsView, String> {
        run(move |engine| {
            engine
                .sessions()
                .history(&machine, &agent, cwd.as_deref())
                .map(Into::into)
                .map_err(text)
        })
        .await
    }

    /// Starts a session: a keeper runs `agent` in `cwd` on the machine, and this app attaches to it. At
    /// most four sessions are open per machine (throws when there are). The keeper outlives this app;
    /// this app may end it with `kill` because it started it. Resolves once the agent answered
    /// `initialize`; the session is then `connecting` for a moment until it has opened.
    pub async fn start(machine: String, input: StartSession) -> Result<SessionRef, String> {
        run(move |engine| {
            let handle = engine
                .sessions()
                .start(&machine, &input.agent, &input.cwd)
                .map_err(text)?;
            Ok(SessionRef {
                id: handle.id().to_owned(),
                machine,
            })
        })
        .await
    }

    /// Reopens a past session (`Continue`): starts a new keeper in the same folder and asks the agent to
    /// load the conversation, which it replays into the transcript. Needs `canLoad` from `history`.
    pub async fn resume(machine: String, input: ResumeSession) -> Result<SessionRef, String> {
        run(move |engine| {
            let handle = engine
                .sessions()
                .resume(&machine, &input.agent, &input.cwd, &input.session_id)
                .map_err(text)?;
            Ok(SessionRef {
                id: handle.id().to_owned(),
                machine,
            })
        })
        .await
    }

    /// Opens a session the keeper holds: the conversation replays into the transcript (`view().phase` is
    /// `connecting` until it has). Attaching one that is open already returns it. Also the way back after
    /// `connectionLost`. Throws for an agent that exited (use `resume`) or a session that is gone.
    pub async fn attach(machine: String, id: String) -> Result<SessionRef, String> {
        run(move |engine| {
            engine.sessions().attach(&machine, &id).map_err(text)?;
            Ok(SessionRef { machine, id })
        })
        .await
    }

    /// Closes the connection to a session. The keeper and its agent keep running; attach again later. For a
    /// chat read from a terminal (`pane:...`) it stops reading the log, as `stopObserving`.
    pub fn detach(machine: String, id: String) -> Result<(), String> {
        let engine = engine()?;
        if let Some((pane, name)) = sub_id(&id) {
            if let Some(parent) = engine.sessions().observed(&machine, pane) {
                parent.close_subagent(name);
            }
            return Ok(());
        }
        match id.strip_prefix(PANE_ID) {
            Some(pane) => engine.sessions().stop_observing(&machine, pane),
            None => engine.sessions().detach(&machine, &id),
        }
        Ok(())
    }

    /// Ends a session for good: its agent and its record. Only a session this app started (or one whose
    /// agent has already exited, where only a record is dismissed) is the app's to end; anything else
    /// throws. Confirm with the person first. An agent in a terminal is ended in the terminal: throws.
    pub async fn kill(machine: String, id: String) -> Result<(), String> {
        if id.starts_with(PANE_ID) {
            return Err("An agent that runs in a terminal is ended in the terminal.".to_owned());
        }
        run(move |engine| engine.sessions().kill(&machine, &id).map_err(text)).await
    }

    /// Whether the agent in `pane` can be read as a chat (`Show chat`): omp, Claude Code or Codex, and its log
    /// can be told. Cheap and synchronous: it reads what herdr last said. `observe` has the final word.
    pub fn can_observe(machine: String, pane: String) -> Result<bool, String> {
        Ok(engine()?.observed_kind(&machine, &pane).is_some())
    }

    /// Starts reading the log of the agent in `pane` as a chat (`Show chat`); the id is `pane:<paneId>` and every
    /// function here takes it. Reading changes nothing in the pane. The chat is `connecting` until the log has
    /// been read, and an agent that has not written its log yet is an empty chat (`observed.link` is
    /// `locating`, with words). At most four are open per machine. Throws for a pane that cannot be one.
    pub async fn observe(machine: String, pane: String) -> Result<SessionRef, String> {
        run(move |engine| {
            engine.observe(&machine, &pane)?;
            Ok(SessionRef {
                id: format!("{PANE_ID}{pane}"),
                machine,
            })
        })
        .await
    }

    /// Starts reading the transcript of subagent `name` (`observed.subagents[].name`) of the chat read from
    /// `pane` (which must be open: `observe`) as a read-only chat of its own; the id is `sub:<paneId>#<name>` and
    /// `view`, `items` and `itemIds` take it. Nothing in it can be sent, stopped or answered: a subagent is
    /// steered through its parent. A transcript not written yet is an empty chat (`observed.link` is `locating`).
    /// At most two are open per chat (the oldest closes); `detach` closes one, and all close with the chat.
    pub async fn open_subagent(
        machine: String,
        pane: String,
        name: String,
    ) -> Result<SessionRef, String> {
        run(move |engine| {
            let parent = engine
                .sessions()
                .observed(&machine, &pane)
                .ok_or("The agent’s chat is not open.")?;
            parent.open_subagent(&name)?;
            Ok(SessionRef {
                id: format!("{SUB_ID}{pane}#{name}"),
                machine,
            })
        })
        .await
    }

    /// Asks the agent of a chat read from a terminal to stop its background task `key` (`observed.background[]`
    /// with `stoppable`): a message in the agent's own words for it (its stop tool) is typed into the pane, as
    /// the person would, and shows in the chat. Refused like a message (`blocked`) while a question waits or the
    /// terminal needs the person. Confirm a task that ran a while with the person first (press, then press again).
    pub async fn stop_background(
        machine: String,
        id: String,
        key: String,
    ) -> Result<ActionResult, String> {
        act(
            machine,
            id,
            move |chat| match chat {
                Chat::Observed(h) => h.stop_background(&key),
                Chat::Keeper(_) => Err(Refusal::Blocked(
                    "This session has no background tasks to stop.".into(),
                )),
            },
            |()| ActionResult::done(),
        )
        .await
    }

    /// Stops reading a pane's log (`Show terminal`). The agent is not touched.
    pub fn stop_observing(machine: String, pane: String) -> Result<(), String> {
        engine()?.sessions().stop_observing(&machine, &pane);
        Ok(())
    }

    /// Reads older turns of a chat read from a terminal (`view().observed.earlier` is `available`): the log is
    /// read again from its end with a tail 4x as wide, up to 64 MB, beside the rows shown, and replaces them in
    /// one step when it is whole (`earlier` is `loading` meanwhile). The rows shown keep their `id`, and the
    /// older ones arrive above them: a list that keys by `id` holds its place. Returns at once; whether a read
    /// began (`false` while one runs, at the log's start, past the widest, or for a chat that is not observed).
    pub fn load_earlier(machine: String, id: String) -> Result<bool, String> {
        Ok(match Chat::find(&machine, &id)? {
            Some(Chat::Observed(chat)) => chat.load_earlier(),
            _ => false,
        })
    }

    /// The bytes of a picture of a chat read from a terminal, as base64 (`ImageView.source` names it): fetched
    /// when the person asks, because the log does not carry them. Throws with words for the person when the
    /// picture is gone, too large (over 16 MiB) or the link fails.
    pub async fn log_picture(
        machine: String,
        id: String,
        source: String,
    ) -> Result<String, String> {
        run(move |_| {
            let Some(Chat::Observed(chat)) = Chat::find(&machine, &id)? else {
                return Err("This chat has no pictures to fetch.".to_owned());
            };
            let bytes = chat.log_picture(&source)?;
            Ok(herdr_core::ssh::base64(&bytes))
        })
        .await
    }

    /// The session as it stands, without the rows of the conversation (see `items`); `undefined` when it
    /// is not attached. Cheap: pull it after every `Herdr.onChange`, and compare `revision`.
    pub fn view(machine: String, id: String) -> Result<Option<SessionView>, String> {
        Ok(Chat::find(&machine, &id)?.map(|c| SessionView::from(&*c.snapshot())))
    }

    /// `count` rows of the conversation from row `start` (oldest first), as of now. A virtual list pulls
    /// only the rows it draws. `[]` when the session is not attached or `start` is past the end.
    pub fn items(
        machine: String,
        id: String,
        start: u32,
        count: u32,
    ) -> Result<Vec<SessionItem>, String> {
        let Some(chat) = Chat::find(&machine, &id)? else {
            return Ok(Vec::new());
        };
        let snapshot = chat.snapshot();
        Ok(snapshot
            .items
            .iter()
            .skip(start as usize)
            .take(count as usize)
            .map(|item| SessionItem::from(item.as_ref()))
            .collect())
    }

    /// The `id` of every row, oldest first: the keys of a list. A row's `rev` (in `items`) changes when
    /// its content does. `[]` when the session is not attached.
    pub fn item_ids(machine: String, id: String) -> Result<Vec<u64>, String> {
        let Some(chat) = Chat::find(&machine, &id)? else {
            return Ok(Vec::new());
        };
        Ok(chat.snapshot().items.iter().map(|i| i.id).collect())
    }

    /// Sends a message, or queues it while the agent works (`queued`; it goes when the turn ends).
    ///
    /// `files` are absolute paths on the agent's machine (files and folders: what `@` and `+` named). Each is
    /// read here, on this call's thread, whatever machine it is on: a picture file travels inside the message
    /// when the agent sees pictures, a text file of at most 32 KB travels as its text when the agent takes
    /// embedded context, anything else (a folder, a big or binary file) goes as a link the agent opens itself.
    /// `pictures` are pictures of THIS computer from `Compose.preparePictures` / `preparePaths`, each with the
    /// number its `[Image n]` has in `text`; they travel inside the message, and an agent that cannot see is
    /// given a link (this computer's agent) or the call fails with `invalid` and the reason (another machine's:
    /// it cannot open this one's files). Upload a local file to a remote machine with `Files` first.
    ///
    /// In a chat read from a terminal the message is typed into the pane's own composer and Enter is pressed
    /// (the agent takes it at once), and the log shows when it arrived; it is refused (`blocked`, nothing
    /// typed) while a question waits or the terminal needs the person, and `files` are not supported there
    /// (`invalid`: attach in the terminal).
    pub async fn send(
        machine: String,
        id: String,
        text: String,
        files: Vec<String>,
        pictures: Vec<PictureInput>,
    ) -> Result<ActionResult, String> {
        let engine = engine()?;
        let local = engine.is_local_machine(&machine)?;
        let fs = engine.files_of(&machine)?;
        let pasted: Vec<Pasted> = pictures
            .into_iter()
            .map(|p| Pasted {
                path: p.path,
                name: p.name,
                number: p.number,
            })
            .collect();
        act(
            machine,
            id,
            move |chat| match chat {
                Chat::Keeper(h) => {
                    let with = h.prepare(fs.as_ref(), local, &files, &pasted)?;
                    h.send(&text, with)
                }
                Chat::Observed(h) if files.is_empty() && pasted.is_empty() => h.send(&text),
                Chat::Observed(_) => {
                    Err(Refusal::Invalid("Attach files in the terminal.".to_owned()))
                }
            },
            |outcome| match outcome {
                SendOutcome::Sent => ActionResult::done(),
                SendOutcome::Queued => ActionResult::queued(),
            },
        )
        .await
    }

    /// Takes a queued message back to edit it (`undefined` when it already went, and always for a chat read
    /// from a terminal: it has no queue here).
    pub async fn unqueue(
        machine: String,
        id: String,
        queued: u32,
    ) -> Result<Option<UnqueuedView>, String> {
        run(move |_| {
            let Some(Chat::Keeper(handle)) = Chat::find(&machine, &id)? else {
                return Ok(None);
            };
            Ok(handle
                .unqueue(u64::from(queued))
                .ok()
                .flatten()
                .map(|u| UnqueuedView {
                    text: u.text,
                    files: u.files,
                    pictures: u.pictures.iter().map(PictureInput::from).collect(),
                }))
        })
        .await
    }

    /// Lets held queued messages go (the person pressed Enter on an empty box).
    pub async fn release_queue(machine: String, id: String) -> Result<ActionResult, String> {
        act(
            machine,
            id,
            |chat| match chat {
                Chat::Keeper(h) => h.release_queue(),
                Chat::Observed(_) => Ok(false),
            },
            |_| ActionResult::done(),
        )
        .await
    }

    /// Asks the agent to stop the turn. Every request still open is answered as cancelled, and queued
    /// messages carry on after the turn. In a chat read from a terminal it presses Esc in the pane, only
    /// while the agent works (`nothingWaiting` otherwise).
    pub async fn cancel(machine: String, id: String) -> Result<ActionResult, String> {
        act(
            machine,
            id,
            |chat| match chat {
                Chat::Keeper(h) => h.cancel(),
                Chat::Observed(h) => h.stop(),
            },
            |()| ActionResult::done(),
        )
        .await
    }

    /// Answers the permission request the person was shown with one of its choices. Sends only if
    /// `requestId` is the request that waits, `digest` is its current fingerprint and the choice exists;
    /// otherwise nothing is sent and the result says why (`changed`, `noSuchOption`, `tooSoon`...). A
    /// risky or standing choice is two steps in the UI before this is called. A chat read from a terminal
    /// has none: its approvals are the terminal's prompts, answered with `Herdr.answer` on its pane.
    pub async fn answer_permission(
        machine: String,
        id: String,
        request_id: String,
        digest: String,
        option_id: String,
    ) -> Result<ActionResult, String> {
        act(
            machine,
            id,
            move |chat| match chat {
                Chat::Keeper(h) => h.answer_permission(&request_id, &digest, &option_id),
                Chat::Observed(_) => Err(in_the_terminal(
                    "Answer approvals with the pane's own prompt, or",
                )),
            },
            |()| ActionResult::done(),
        )
        .await
    }

    /// Withdraws the request the person was shown: a permission is cancelled, a question declined. The
    /// same checks as `answerPermission`. In a chat read from a terminal it presses Esc, which cancels the
    /// agent's question tool call, only while its dialog is on the screen.
    pub async fn dismiss(
        machine: String,
        id: String,
        request_id: String,
        digest: String,
    ) -> Result<ActionResult, String> {
        act(
            machine,
            id,
            move |chat| match chat {
                Chat::Keeper(h) => h.dismiss(&request_id, &digest),
                Chat::Observed(h) => h.dismiss(&request_id, &digest),
            },
            |()| ActionResult::done(),
        )
        .await
    }

    /// Answers the question the person was shown, every field at once (one answer per field, in order).
    /// A field that does not pass gives `invalid` with the field and the reason, and leaves the question
    /// as it was. The same checks as `answerPermission`.
    ///
    /// For an agent in a terminal (omp, Claude Code) the answer is pressed into its question dialog, one
    /// screen at a time, and the log must record it (`blocked`, nothing more is sent, when the dialog is not
    /// what was expected: open the terminal). A text answer in a choice field is the agent's "type your own".
    pub async fn answer_question(
        machine: String,
        id: String,
        request_id: String,
        digest: String,
        answers: Vec<FieldAnswerInput>,
    ) -> Result<ActionResult, String> {
        let answers: Vec<herdr_core::session::FieldAnswer> =
            answers.into_iter().map(Into::into).collect();
        act(
            machine,
            id,
            move |chat| match chat {
                Chat::Keeper(h) => h.answer_question(&request_id, &digest, &answers),
                Chat::Observed(h) => h.answer_question(&request_id, &digest, &answers),
            },
            |()| ActionResult::done(),
        )
        .await
    }

    /// Changes a setting of the session (model, mode, thinking level) to one of its choices; `busy` while
    /// a turn runs. A risky mode (`OptionChoiceView.risk`) is two steps in the UI before this is called. A
    /// chat read from a terminal has no settings here: they are changed in the terminal (`blocked`).
    pub async fn set_option(
        machine: String,
        id: String,
        option_id: String,
        value: String,
    ) -> Result<ActionResult, String> {
        act(
            machine,
            id,
            move |chat| match chat {
                Chat::Keeper(h) => h.set_option(&option_id, &value),
                Chat::Observed(_) => Err(in_the_terminal("Change settings")),
            },
            |()| ActionResult::done(),
        )
        .await
    }

    /// Signs in to the agent with one of the methods it offered (`SessionView.acp.auth`, while the phase is
    /// `authRequired`) that the app can carry out; when the agent accepts, the session it refused opens.
    /// A method done in a terminal on the agent's machine gives `invalid` with the arguments to run it
    /// with: after the person did it, call `reopen`.
    pub async fn authenticate(
        machine: String,
        id: String,
        method_id: String,
    ) -> Result<ActionResult, String> {
        act(
            machine,
            id,
            move |chat| match chat {
                Chat::Keeper(h) => h.authenticate(&method_id),
                Chat::Observed(_) => Err(in_the_terminal("Sign in")),
            },
            |()| ActionResult::done(),
        )
        .await
    }

    /// Opens the session the agent refused for want of a sign-in once more, after the person signed in
    /// some other way (a method done in a terminal). `notReady` when the agent asked for no sign-in.
    pub async fn reopen(machine: String, id: String) -> Result<ActionResult, String> {
        act(
            machine,
            id,
            |chat| match chat {
                Chat::Keeper(h) => h.reopen(),
                Chat::Observed(_) => Err(Refusal::NotReady),
            },
            |()| ActionResult::done(),
        )
        .await
    }
}
