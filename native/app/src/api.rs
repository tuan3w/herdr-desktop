//! The `Herdr` module: what the TSX screens call. Every function here is a thin door onto
//! [`crate::engine`]; the rules live there.
//!
//! Synchronous functions return their value at once and never touch a signal (they run inside the JS
//! call): TSX pulls the board, a pane's header and the machine list with them after each tick. Anything
//! that talks to a machine is `async`: it runs on the runtime's blocking threads and settles a promise,
//! so the UI thread never waits for a socket or for ssh.

mod hub;
mod session_acp_views;
mod session_views;
mod sessions;
mod views;
mod worktrees;

use std::sync::Arc;

use nsh_core::JsonValue;
use nsh_core::prelude::*;
use parking_lot::RwLock;
use serde_json::Value;

use crate::engine::{Config, Engine};
use crate::feed;
use crate::fixture::{self, Fixture, TEST_FLAG};
pub use session_acp_views::*;
pub use session_views::*;
pub use sessions::Sessions;
pub use views::*;
pub use worktrees::*;

static ENGINE: RwLock<Option<Arc<Engine>>> = RwLock::new(None);

/// The program a terminal tab runs instead of the herdr client while the test seam is open (`Herdr.testSetProgram`).
static TEST_PROGRAM: parking_lot::Mutex<Option<String>> = parking_lot::Mutex::new(None);

/// The running engine, or why there is none.
pub(crate) fn engine() -> Result<Arc<Engine>, String> {
    ENGINE
        .read()
        .clone()
        .ok_or_else(|| "Herdr.configure has not been called".to_owned())
}

/// The scripted herdr of the test seam, or why there is none.
fn fixture_of(engine: &Engine) -> Result<&Fixture, String> {
    engine.fixture().ok_or_else(|| {
        format!("The test seam is closed: set {TEST_FLAG}=1 and configure a fixture")
    })
}

/// Runs `f` with the engine on a blocking thread and settles with its result.
async fn run<T: Send + 'static>(
    f: impl FnOnce(Arc<Engine>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let engine = engine()?;
    blocking(move || f(engine))
        .await
        .map_err(|e| format!("the task stopped: {e}"))?
}

/// The scripted herdr to run against: only when a fixture is named and the seam is open. In production the
/// seam is closed, so a stray option can never swap the owner's herdr for a script.
fn open_fixture(name: Option<&str>, seam_open: bool) -> Result<Option<Fixture>, String> {
    match name {
        Some(name) if seam_open => Fixture::load(name).map(Some),
        Some(name) => {
            eprintln!("herdr-desktop: ignoring fixture `{name}`: {TEST_FLAG} is not 1");
            Ok(None)
        }
        None => Ok(None),
    }
}

/// Parses the keys `review` and `unreview` take: `<machine>|<paneId>|<episode>`, the `reviewKey` of a row.
fn review_keys(keys: &[String]) -> Result<Vec<herdr_core::store::ReviewKey>, String> {
    keys.iter()
        .map(|key| {
            let (machine_and_pane, seq) = key
                .rsplit_once('|')
                .ok_or_else(|| format!("`{key}` is not a review key"))?;
            let (machine, pane) = machine_and_pane
                .split_once('|')
                .ok_or_else(|| format!("`{key}` is not a review key"))?;
            let seq = seq
                .parse()
                .map_err(|_| format!("`{key}` is not a review key"))?;
            Ok(herdr_core::store::ReviewKey::new(machine, pane, seq))
        })
        .collect()
}

/// What the app keeps on this computer (`Herdr.cacheUsage`).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct StorageView {
    /// Bytes the saved conversations and board snapshots take on disk.
    pub bytes: f64,
    /// How many of them there are.
    pub entries: f64,
    /// Whether they are kept and read (`Herdr.setCacheEnabled`).
    pub enabled: bool,
    /// Bytes of the copies of other machines' videos and sounds.
    pub media_bytes: f64,
}

/// Everything the app knows about herdr: machines, agents, panes. Call `configure` once at start; the
/// rest pulls state (`board`, `paneMeta`, `machineStatuses`) after `onChange` says something changed, and
/// acts on it (`answer`, `sendKeys`, `startAgent`). Nothing here returns raw herdr JSON.
#[module]
pub struct Herdr;

#[module]
impl Herdr {
    /// The version of the Rust core.
    pub fn core_version() -> String {
        herdr_core::version().to_owned()
    }

    /// Figures about the live pane path and the process, read now, for the developer panel. Works without an
    /// engine (`watchedPanes` is then 0).
    pub fn metrics() -> crate::metrics::Metrics {
        let mut metrics = crate::metrics::read();
        if let Ok(engine) = engine() {
            metrics.watched_panes = engine.watching() as u32;
        }
        metrics
    }

    /// Starts the engine: opens the data directory, connects to every machine that is switched on and
    /// installs the feed `PaneScreen` reads panes through. Calling it again replaces the engine (the old
    /// one stops first). Throws when the data directory cannot be opened or a fixture cannot be loaded.
    pub fn configure(options: ConfigureOptions) -> Result<(), String> {
        let fixture = open_fixture(options.fixture.as_deref(), fixture::test_seam_open())?;
        let engine = Engine::start(Config {
            data_dir: options.data_dir.into(),
            fixture,
            on_tick: Arc::new(hub::notify),
        })?;
        feed::set_provider(engine.feed_provider());
        // The previous engine stops when its last reference goes, after the lock is released.
        let previous = ENGINE.write().replace(Arc::new(engine));
        drop(previous);
        Ok(())
    }

    /// What the store said was wrong with a file it had to set aside (corrupt, or written by a newer
    /// app); empty when all is well. Show it once.
    pub fn warnings() -> Result<Vec<String>, String> {
        Ok(engine()?.warnings().to_vec())
    }

    /// This computer first, then the machines that were added.
    pub fn machines() -> Result<Vec<MachineView>, String> {
        Ok(engine()?.machines().into_iter().map(Into::into).collect())
    }

    /// Adds a machine (no `id`) or changes one, and returns it as stored. Throws with the text to show
    /// next to the field when the name or destination is not acceptable.
    pub fn save_machine(input: MachineInput) -> Result<MachineView, String> {
        engine()?.save_machine(input.into_engine()?).map(Into::into)
    }

    /// Removes a machine and everything remembered about it. Throws for this computer.
    pub fn remove_machine(id: String) -> Result<(), String> {
        engine()?.remove_machine(&id)
    }

    /// Connects once to the machine described, without adding it: resolves with `Connected · herdr
    /// 0.9.5 · 3 workspaces`, or the reason and what to do (for example, run `ssh <destination>` once
    /// in a terminal to trust the host). An empty destination tests this computer.
    pub async fn test_connection(input: MachineInput) -> Result<TestResult, String> {
        let input = input.into_engine()?;
        run(move |engine| Ok(engine.test_connection(&input).into())).await
    }

    /// The host aliases of `~/.ssh/config`, for the destination field's suggestions.
    pub fn ssh_hosts() -> Vec<String> {
        herdr_core::ssh::default_config_path()
            .map(|path| herdr_core::ssh::config_hosts(&path))
            .unwrap_or_default()
    }

    /// Every machine's connection: state, why, when it retries, what version it runs, how many agents.
    pub fn machine_statuses() -> Result<Vec<MachineStatus>, String> {
        Ok(engine()?
            .machine_statuses()
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// Retries a machine now, leaving `attention`.
    pub fn reconnect(machine: String) -> Result<(), String> {
        engine()?.reconnect(&machine)
    }

    /// Tells the machines whether the window is in the background: they space their retries and polls
    /// out while it is.
    pub fn set_background(background: bool) -> Result<(), String> {
        engine()?.set_background(background);
        Ok(())
    }

    /// The board now. Cheap: call it after every `onChange`. A row without a preview yet starts a read;
    /// the next tick brings it.
    pub fn board() -> Result<BoardData, String> {
        let engine = engine()?;
        let state = engine.board();
        Ok(BoardData::new(&state, engine.revision()))
    }

    /// What a pane's header needs; `undefined` for a machine that is not listed. A pane herdr no longer
    /// has comes back with `feedState: "gone"`.
    pub fn pane_meta(machine: String, pane: String) -> Result<Option<PaneMeta>, String> {
        Ok(engine()?.pane_summary(&machine, &pane).map(Into::into))
    }

    /// Calls `listener` with the change counter when anything changed: a snapshot, a link state, a
    /// preview, a reviewed mark, a setting, the machine list. At most one call per 16 ms; the counter
    /// carries no data: pull what you show. Returns the function that stops listening, which also runs
    /// when the owner of the call goes.
    pub fn on_change(#[args(revision)] listener: Callback<u64>, cx: CallCx<'_>) -> Stop {
        let (id, wake) = hub::subscribe();
        cx.start(async move {
            while wake.recv().await.is_ok() {
                // The counter is read when the task runs, so a burst posts the newest value.
                let revision = ENGINE.read().as_ref().map_or(0, |e| e.revision());
                listener.post(revision);
            }
        });
        Stop::new(move || hub::unsubscribe(id))
    }

    /// Calls `listener` when the person clicks a notification: with the agent it was about, or with
    /// nothing set for a summary. The app brings its window forward (`Window.orderFront()`) and shows
    /// what was asked for. Pressing an answer button is not a click: it answers through the same
    /// checked path as the answer dock and never reaches this listener. Returns the function that
    /// stops listening.
    pub fn on_notification_open(
        #[args(open)] listener: Callback<NotificationOpen>,
        cx: CallCx<'_>,
    ) -> Result<Stop, String> {
        let (id, clicks) = engine()?.notifier().subscribe();
        cx.start(async move {
            while let Ok(target) = clicks.recv().await {
                listener.post(target.into());
            }
        });
        Ok(Stop::new(move || {
            if let Some(engine) = ENGINE.read().as_ref() {
                engine.notifier().unsubscribe(id);
            }
        }))
    }

    /// Whether the desktop can show notifications: resolves with what is missing when it cannot (no
    /// notification service on the session bus), and whether answer buttons will show. Settings asks
    /// when the person switches notifications on.
    pub async fn notification_support() -> Result<NotificationSupport, String> {
        run(|engine| Ok(engine.notification_support().into())).await
    }

    /// Keeps a pane's screen being read (for a header or a prompt) without a `PaneScreen`; the pane is
    /// read when herdr says it changed, at most 20 times a second. Returns the function that stops.
    /// Throws for a machine that is not listed.
    pub fn watch_pane(
        machine: String,
        pane: String,
        source: PaneSourceName,
        cx: CallCx<'_>,
    ) -> Result<Stop, String> {
        let engine = engine()?;
        let handle = engine
            .watch(&machine, &pane, source.into())
            .ok_or_else(|| format!("There is no machine {machine}"))?;
        // Held until stopped, or until the owner of the call goes.
        let held = Arc::new(parking_lot::Mutex::new(Some(handle)));
        let release = held.clone();
        let cleanup = cx.on_cleanup(move || drop(release.lock().take()));
        Ok(Stop::new(move || {
            drop(held.lock().take());
            cleanup.release();
        }))
    }

    /// Reads a watched pane now and resolves once every view of it shows the result: after sending keys,
    /// so the mirror does not wait for herdr's next event. `lines` sets how many rows to read from now on.
    /// Nothing happens for a pane no view watches.
    pub async fn read_pane(
        machine: String,
        pane: String,
        source: PaneSourceName,
        lines: Option<u32>,
    ) -> Result<(), String> {
        run(move |engine| engine.read_now(&machine, &pane, source.into(), lines)).await
    }

    /// Types `text` into a pane without pressing anything.
    pub async fn send_text(machine: String, pane: String, text: String) -> Result<(), String> {
        run(move |engine| engine.send_text(&machine, &pane, &text)).await
    }

    /// Presses keys in a pane by herdr's names: `enter`, `esc`, `tab`, `up`, `ctrl+c`, `shift+tab`.
    pub async fn send_keys(machine: String, pane: String, keys: Vec<String>) -> Result<(), String> {
        run(move |engine| engine.send_keys(&machine, &pane, &keys)).await
    }

    /// Types `text`, then presses `keys` (usually `["enter"]`), as one request: the composer's send.
    pub async fn send_input(
        machine: String,
        pane: String,
        text: String,
        keys: Vec<String>,
    ) -> Result<(), String> {
        run(move |engine| engine.send_input(&machine, &pane, &text, &keys)).await
    }

    /// A message to the agent in a pane (`agent.prompt`): herdr checks, as it types, that the agent is not waiting
    /// for an answer or not at its prompt, and presses Enter itself. A refusal throws with what to tell the person
    /// and types nothing. A herdr too old for `agent.prompt` gets the text and Enter as `sendInput` does. Answers to
    /// a dialog are keys: use `sendInput` or `answer` for those.
    pub async fn prompt(machine: String, pane: String, text: String) -> Result<(), String> {
        run(move |engine| engine.prompt(&machine, &pane, &text)).await
    }

    /// The agents herdr on a machine can start (`server.agent_manifests`), by kind. Empty when that herdr cannot say:
    /// offer every kind then.
    pub async fn agent_kinds(machine: String) -> Result<Vec<String>, String> {
        run(move |engine| engine.agent_manifests(&machine)).await
    }

    /// Has herdr install its hook into an agent's own settings on a machine (`integration.install`): `target` is
    /// `omp`, `claude` or `codex`. Resolves with herdr's messages (what it wrote, what to do next).
    pub async fn install_integration(
        machine: String,
        target: String,
    ) -> Result<Vec<String>, String> {
        run(move |engine| engine.install_integration(&machine, &target)).await
    }

    /// Answers the question a blocked agent is waiting on with option `optionIndex` of the prompt whose
    /// `digest` the person saw. The pane is read again first: the keys are sent only if the agent is still
    /// blocked, still shows that exact question and still has that option. Otherwise nothing is sent and
    /// the result says why (`changed`, `notBlocked`, `failed`). A send is never retried.
    pub async fn answer(
        machine: String,
        pane: String,
        digest: String,
        option_index: u32,
    ) -> Result<AnswerResult, String> {
        run(move |engine| {
            Ok(engine
                .answer(&machine, &pane, &digest, option_index as usize)
                .into())
        })
        .await
    }

    /// Marks finished agents as looked at, by `reviewKey`. Persisted; they leave "to review".
    pub fn review(keys: Vec<String>) -> Result<(), String> {
        engine()?.review(&review_keys(&keys)?)
    }

    /// Takes the marks back: the `Undo` of a bulk review.
    pub fn unreview(keys: Vec<String>) -> Result<(), String> {
        engine()?.unreview(&review_keys(&keys)?)
    }

    /// Pins a project (`BoardProject.key`) so it lists first on the home and in the sidebar, or takes the pin back. Persisted.
    pub fn pin_project(key: String, pinned: bool) -> Result<(), String> {
        engine()?.pin_project(&key, pinned)
    }

    /// Notes that the person arrived at a destination: `agent:<BoardRow.key>` or `project:<BoardProject.key>`. Persisted
    /// (`recents.json`: the key, the times of its last ten visits and a count; never what a pane showed).
    pub fn visit(key: String) -> Result<(), String> {
        engine()?.visit(&key)
    }

    /// Takes a destination out of the recent visits.
    pub fn forget(key: String) -> Result<(), String> {
        engine()?.forget(&key)
    }

    /// What was visited, newest first.
    pub fn recents() -> Result<Vec<Recent>, String> {
        Ok(engine()?
            .recents()
            .into_iter()
            .map(|(key, last_visit, count, frecency)| Recent {
                key,
                last_visit,
                count,
                frecency,
            })
            .collect())
    }

    /// A setting, or `null` when it was never set.
    pub fn setting(key: String) -> Result<JsonValue, String> {
        Ok(engine()?.setting(&key).unwrap_or(Value::Null))
    }

    /// Stores a setting (any JSON value; `null` clears it) in the settings file.
    pub fn set_setting(key: String, value: JsonValue) -> Result<(), String> {
        engine()?.set_setting(&key, value)
    }

    /// What the app keeps on this computer, and whether it keeps it: saved conversations and board snapshots (`bytes`,
    /// `entries`) apart from the copies of other machines' videos and sounds (`mediaBytes`).
    pub fn cache_usage() -> Result<StorageView, String> {
        let engine = engine()?;
        let cache = engine.cache();
        let usage = cache.usage();
        Ok(StorageView {
            bytes: usage.bytes as f64,
            entries: usage.entries as f64,
            enabled: cache.enabled(),
            media_bytes: engine.media_cache().used() as f64,
        })
    }

    /// Switches the keeping of saved conversations and board snapshots on or off, and remembers the choice. Off keeps
    /// what is saved until `clearCache`.
    pub fn set_cache_enabled(on: bool) -> Result<(), String> {
        let engine = engine()?;
        engine.cache().set_enabled(on);
        engine.set_setting(crate::engine::CACHE_KEY, Value::Bool(on))
    }

    /// Deletes every saved conversation and board snapshot. The copies of other machines' videos and sounds stay.
    pub fn clear_cache() -> Result<(), String> {
        engine()?.cache().clear();
        Ok(())
    }

    /// A new workspace (with a tab and a pane) in a folder. Never focused in herdr.
    pub async fn create_workspace(
        machine: String,
        label: Option<String>,
        cwd: Option<String>,
    ) -> Result<CreatedView, String> {
        run(move |engine| {
            engine
                .create_workspace(&machine, label.as_deref(), cwd.as_deref())
                .map(Into::into)
        })
        .await
    }

    /// A new tab (with a pane) in a workspace.
    pub async fn create_tab(
        machine: String,
        workspace_id: String,
        label: Option<String>,
        cwd: Option<String>,
    ) -> Result<CreatedView, String> {
        run(move |engine| {
            engine
                .create_tab(&machine, &workspace_id, label.as_deref(), cwd.as_deref())
                .map(Into::into)
        })
        .await
    }

    /// Splits a pane; resolves with the new pane's id.
    pub async fn split_pane(
        machine: String,
        pane: String,
        direction: SplitDirection,
    ) -> Result<String, String> {
        run(move |engine| engine.split_pane(&machine, &pane, direction.into())).await
    }

    /// Closes a pane and what runs in it.
    pub async fn close_pane(machine: String, pane: String) -> Result<(), String> {
        run(move |engine| engine.close_pane(&machine, &pane)).await
    }

    /// Closes a tab and its panes.
    pub async fn close_tab(machine: String, tab: String) -> Result<(), String> {
        run(move |engine| engine.close_tab(&machine, &tab)).await
    }

    /// Closes a workspace and everything in it.
    pub async fn close_workspace(machine: String, workspace: String) -> Result<(), String> {
        run(move |engine| engine.close_workspace(&machine, &workspace)).await
    }

    /// Names a workspace.
    pub async fn rename_workspace(
        machine: String,
        workspace: String,
        label: String,
    ) -> Result<(), String> {
        run(move |engine| engine.rename_workspace(&machine, &workspace, &label)).await
    }

    /// Names a tab.
    pub async fn rename_tab(machine: String, tab: String, label: String) -> Result<(), String> {
        run(move |engine| engine.rename_tab(&machine, &tab, &label)).await
    }

    /// Names a pane; an empty label clears the name.
    pub async fn rename_pane(machine: String, pane: String, label: String) -> Result<(), String> {
        run(move |engine| engine.rename_pane(&machine, &pane, &label)).await
    }

    /// Moves herdr's own focus to a workspace: this changes what is on the owner's herdr screen, so call
    /// it only for something the person asked for.
    pub async fn focus_workspace(machine: String, workspace: String) -> Result<(), String> {
        run(move |engine| engine.focus_workspace(&machine, &workspace)).await
    }

    /// Moves herdr's own focus to a tab (see `focusWorkspace`).
    pub async fn focus_tab(machine: String, tab: String) -> Result<(), String> {
        run(move |engine| engine.focus_tab(&machine, &tab)).await
    }

    /// Moves herdr's own focus to a pane (see `focusWorkspace`).
    pub async fn focus_pane(machine: String, pane: String) -> Result<(), String> {
        run(move |engine| engine.focus_pane(&machine, &pane)).await
    }

    /// Zooms a pane or puts it back (`pane.zoom`); true when herdr changed the zoom (see `Engine::zoom_pane`).
    pub async fn zoom_pane(machine: String, pane: String, on: bool) -> Result<bool, String> {
        run(move |engine| engine.zoom_pane(&machine, &pane, on)).await
    }

    /// Starts an agent in a folder: herdr starts agents in an existing pane at a shell prompt, so a new
    /// tab (or workspace) is made first. When the agent does not start the new shell stays, and the error
    /// says so.
    pub async fn start_agent(machine: String, start: StartAgent) -> Result<CreatedView, String> {
        run(move |engine| engine.start_agent(&machine, &start.into()).map(Into::into)).await
    }

    /// The checkouts of the repository a folder is in, each with its branch (`worktree.list`). Never throws:
    /// `state` says when there is nothing to offer (not a repository, herdr without worktrees, an untrusted
    /// repository, a machine that did not answer).
    pub async fn worktrees(machine: String, cwd: String) -> Result<WorktreeLookup, String> {
        run(move |engine| Ok(WorktreeLookup::of(engine.worktrees(&machine, &cwd)))).await
    }

    /// Makes a worktree for the repository a folder is in (`worktree.create`, never focused) and opens it in herdr
    /// as a workspace. `branch` is checked against git's ref-name rules first and sent only as a parameter; an empty
    /// one lets herdr name it. Throws with what to tell the person; a repository herdr does not trust is refused,
    /// never trusted from here.
    pub async fn create_worktree(
        machine: String,
        cwd: String,
        branch: String,
    ) -> Result<MadeWorktree, String> {
        run(move |engine| {
            let branch = Some(branch.as_str()).filter(|b| !b.is_empty());
            engine
                .create_worktree(&machine, &cwd, branch)
                .map(|made| MadeWorktree {
                    path: made.worktree.path,
                    branch: made.worktree.branch,
                    workspace_id: made.workspace_id,
                })
                .map_err(|e| e.explain())
        })
        .await
    }

    /// Has herdr remove the worktree open as a workspace (`worktree.remove`) and close that workspace. herdr is never
    /// told to force it, and a repository it does not trust is refused, so a worktree with changes comes back as
    /// herdr's own refusal. Throws with what to tell the person.
    pub async fn remove_worktree(machine: String, workspace_id: String) -> Result<(), String> {
        run(move |engine| engine.remove_worktree(&machine, &workspace_id)).await
    }

    /// Test seam: the requests the scripted herdr served, oldest first, optionally of one `method`
    /// (`pane.send_keys`). Throws unless a fixture is running.
    pub fn test_requests(method: Option<String>) -> Result<Vec<TestRequest>, String> {
        let engine = engine()?;
        Ok(fixture_of(&engine)?
            .requests(method.as_deref())
            .into_iter()
            .map(|r| TestRequest {
                method: r.method,
                params: r.params,
            })
            .collect())
    }

    /// Test seam: the synthetic program every terminal tab runs in place of the herdr client (a `/bin/sh -c` line), or
    /// `null` for none. Throws unless `HERDR_DESKTOP_TEST=1`: a stray call can never swap the owner's client for a script.
    pub fn test_set_program(command: Option<String>) -> Result<(), String> {
        if !crate::fixture::test_seam_open() {
            return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
        }
        *TEST_PROGRAM.lock() = command;
        Ok(())
    }

    /// The synthetic program set by `testSetProgram`, `null` outside a test run (the seam is closed there). With the seam
    /// open and none set it is an idle `cat`: a test that opens a terminal tab without choosing a program must never start
    /// the owner's real herdr client (it did once: a screen of the owner's herdr, and keys that could reach it).
    pub fn test_program() -> Option<String> {
        if crate::fixture::test_seam_open() {
            Some(
                TEST_PROGRAM
                    .lock()
                    .clone()
                    .unwrap_or_else(|| "printf 'terminal (test)\\n'; exec cat".to_owned()),
            )
        } else {
            None
        }
    }

    /// Test seam: saves `text` in the cache as a copy of this computer, so a test can see the Storage page count it and
    /// `clearCache` remove it (a real copy is saved seconds after a screen changes). Throws unless
    /// `HERDR_DESKTOP_TEST=1`.
    pub fn test_save_cache(text: String) -> Result<(), String> {
        if !crate::fixture::test_seam_open() {
            return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
        }
        let cache = engine()?.cache();
        let key = cache.key(herdr_core::cache::Kind::Board, "local", "test");
        cache.put(&key, text.as_bytes());
        Ok(())
    }

    /// Test seam: sends an event (`{ event, data }`) to the app as the scripted herdr's subscribers.
    pub fn test_push(event: JsonValue) -> Result<(), String> {
        let engine = engine()?;
        fixture_of(&engine)?.push_event(event);
        Ok(())
    }

    /// Test seam: replaces what the scripted herdr answers to `session.snapshot` and `pane.get`; the
    /// app reads it on its next refresh (push an event such as `pane_agent_status_changed` to cause one).
    pub fn test_set_snapshot(snapshot: JsonValue) -> Result<(), String> {
        let engine = engine()?;
        fixture_of(&engine)?.set_snapshot(snapshot);
        Ok(())
    }

    /// Test seam: replaces the rows the scripted herdr shows for a pane.
    pub fn test_set_screen(pane: String, rows: Vec<String>) -> Result<(), String> {
        let engine = engine()?;
        fixture_of(&engine)?.set_screen(&pane, rows);
        Ok(())
    }

    /// Test seam: scripts what ssh prints when the app tries to reach `dest` (for example `REMOTE HOST
    /// IDENTIFICATION HAS CHANGED!` or `ssh: connect to host x port 22: Connection refused`), instead of
    /// starting ssh, for machines added afterwards; `null` takes the script away. The text is classified
    /// like real ssh output. Throws unless a fixture is running.
    pub fn test_ssh_fault(dest: String, stderr: Option<String>) -> Result<(), String> {
        let engine = engine()?;
        fixture_of(&engine)?.set_ssh_fault(&dest, stderr);
        Ok(())
    }

    /// Test seam: the notifications the app would have shown, oldest first. Throws unless a fixture is
    /// running (a real herdr's notifications go to the desktop).
    pub fn test_notifications() -> Result<Vec<TestNotification>, String> {
        let engine = engine()?;
        let sink = engine.recorded_notifications().ok_or_else(|| {
            format!("The test seam is closed: set {TEST_FLAG}=1 and configure a fixture")
        })?;
        Ok(sink.shown().into_iter().map(Into::into).collect())
    }

    /// Test seam: presses a notification the app "showed": `action` is `default` for its body or
    /// `answer:0` for its first button. Throws unless a fixture is running.
    pub fn test_press_notification(id: u64, action: String) -> Result<(), String> {
        let engine = engine()?;
        let sink = engine.recorded_notifications().ok_or_else(|| {
            format!("The test seam is closed: set {TEST_FLAG}=1 and configure a fixture")
        })?;
        sink.press(id, &action);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fixture_is_ignored_unless_the_test_seam_is_open() {
        assert!(
            open_fixture(Some("mixed"), false)
                .expect("ignored, not an error")
                .is_none()
        );
        assert!(open_fixture(None, true).expect("none asked").is_none());
        assert!(
            open_fixture(Some("no such fixture"), true).is_err(),
            "an open seam names its fixture properly"
        );
    }

    #[test]
    fn review_keys_round_trip_the_row_and_reject_anything_else() {
        let keys =
            review_keys(&["local|w1:p2|7".to_owned(), "m1|w3:p1|12".to_owned()]).expect("valid");
        assert_eq!(
            keys[0],
            herdr_core::store::ReviewKey::new("local", "w1:p2", 7)
        );
        assert_eq!(
            keys[1],
            herdr_core::store::ReviewKey::new("m1", "w3:p1", 12)
        );
        for bad in [
            "",
            "local",
            "local|w1:p2",
            "local|w1:p2|x",
            "local|w1:p2|-1",
        ] {
            assert!(review_keys(&[bad.to_owned()]).is_err(), "{bad:?}");
        }
    }
}
