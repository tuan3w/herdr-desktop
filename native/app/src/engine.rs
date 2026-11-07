//! The engine: one per process, between `herdr-core`'s machine links and the TSX screens.
//!
//! It owns a [`MachineLink`] per machine, the persisted state (machines, reviewed marks, settings), the
//! preview cache and the pane watches, and runs four kinds of thread, none of them the UI's:
//!
//! * the **forwarder** turns link updates into at most one tick per 16 ms (and keeps the reviewed marks
//!   and the dated episodes in step with what the links report);
//! * the **scheduler** decides when a watched pane is read again (at most every 50 ms per pane, never an
//!   unwatched one);
//! * a small **pool** does those reads and the card previews, so a slow ssh machine never holds up a fast
//!   one and no thread is spawned per pane;
//! * one **pump** per link hands that machine's pane activity to the scheduler.
//!
//! The UI is told "something changed" and pulls with synchronous calls ([`Fleet::board`],
//! [`Fleet::pane_summary`], ...); nothing here pushes data into TSX. [`Engine`] owns the threads; [`Fleet`]
//! is the shared state they and the callers use.

mod alerts;
mod answer;
mod files;
mod forward;
mod machines;
mod mutate;
mod names;
mod observed;
mod panes;
mod preview;
mod sessions;
mod words;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{Sender, unbounded};
use herdr_core::board::{Board, BoardExtras, FirstSeen, LogNames};
use herdr_core::link::{
    LinkConfig, LinkNote, LinkState, LocalWire, MachineLink, Profile, SystemClock, Update,
    default_socket_path,
};
use herdr_core::prompt::PromptInfo;
use herdr_core::recents::Recents;
use herdr_core::schema::{AgentStatus, PaneInfo, Snapshot, clean_terminal_title};
use herdr_core::session::SessionHub;
use herdr_core::ssh::{SshClient, SshTarget, SshWire, classify_ssh};
use herdr_core::store::{Machine, MachineId, Machines, ReviewKey, Reviewed, Settings, Store};
use herdr_core::wire::{Fatal, Wire, WireError};
use parking_lot::{Mutex, RwLock};
use serde_json::Value;

use crate::feed::{FeedProvider, FeedState, PaneFeed, PaneSource};
use crate::fixture::Fixture;

pub use answer::AnswerOutcome;
pub use machines::{Connection, MachineInput};
pub use mutate::{Created, Split, StartAgent};
pub use panes::WatchHandle;
pub use preview::Preview;
pub use words::{compact, status_line, window_title};

/// The setting that holds the pinned projects' keys.
const PINNED_KEY: &str = "projects.pinned";

/// How long a request to herdr may take before it counts as failed.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The shortest gap between two ticks to the UI.
const TICK_GAP: Duration = Duration::from_millis(16);

/// Threads that read panes.
const POOL: usize = 4;

/// What starts an [`Engine`].
pub struct Config {
    /// Where machines, reviewed marks and settings live; empty means a fresh temporary directory.
    pub data_dir: PathBuf,
    /// A scripted herdr that replaces the real local one (the test seam; see [`crate::fixture`]).
    pub fixture: Option<Fixture>,
    /// Called from the forwarder thread for every tick: "something changed, pull". Must not block.
    pub on_tick: Arc<dyn Fn() + Send + Sync>,
}

/// Messages to the forwarder besides link updates.
enum Note {
    /// Something other than a link changed (a mark, a setting, a preview): tick.
    Bump,
    Stop,
}

/// Work for the pool.
enum Job {
    /// Read a watched pane's screen.
    Feed(Arc<panes::Watch>),
    /// Read the rows and question a card shows.
    Preview {
        machine: MachineId,
        pane: String,
        stamp: preview::Stamp,
    },
    Stop,
}

/// The running engine: [`Fleet`] plus the threads that serve it. Dropping it stops them.
pub struct Engine {
    fleet: Arc<Fleet>,
    threads: Vec<JoinHandle<()>>,
    notifier: crate::notify::Notifier,
    recording: Option<Arc<crate::notify::RecordingSink>>,
    desktop: Option<Arc<crate::notify::DesktopSink>>,
}

impl Deref for Engine {
    type Target = Fleet;

    fn deref(&self) -> &Fleet {
        &self.fleet
    }
}

impl Engine {
    /// Opens the data directory, starts a link per machine and the threads.
    pub fn start(config: Config) -> Result<Engine, String> {
        let store = Store::open(&config.data_dir)
            .map_err(|e| format!("cannot open {}: {e}", config.data_dir.display()))?;
        let mut warnings = Vec::new();
        let mut keep = |warning: Option<String>| warnings.extend(warning);
        let stored_machines = store.machines();
        keep(stored_machines.warning);
        let stored_reviewed = store.reviewed();
        keep(stored_reviewed.warning);
        let stored_settings = store.settings();
        keep(stored_settings.warning);
        let stored_recents = store.recents();
        keep(stored_recents.warning);

        let ssh = match SshClient::new(store.dir()) {
            Ok(client) => Some(client),
            Err(e) => {
                warnings.push(format!("ssh machines are unavailable: {e}"));
                None
            }
        };
        let local_socket = config
            .fixture
            .as_ref()
            .map_or_else(default_socket_path, |f| f.socket_path().to_path_buf());

        let (updates, update_rx) = unbounded();
        let (notes, note_rx) = unbounded();
        let (sched, sched_rx) = unbounded();
        let (jobs, job_rx) = unbounded();
        let (notify_tx, notify_rx) = crate::notify::channel();
        // A scripted herdr never reaches the owner's desktop: its notifications are recorded.
        let (sink, recording, desktop): (Arc<dyn crate::notify::Sink>, _, _) =
            if config.fixture.is_some() {
                let recording = Arc::new(crate::notify::RecordingSink::new(notify_tx.clone()));
                (recording.clone(), Some(recording), None)
            } else {
                let desktop = Arc::new(crate::notify::DesktopSink::new(notify_tx.clone()));
                (desktop.clone(), None, Some(desktop))
            };

        let fleet_cell = sessions::FleetCell::default();
        let sessions = sessions::build_hub(
            stored_settings
                .value
                .get::<Vec<String>>(sessions::OWNED_KEY)
                .unwrap_or_default(),
            notes.clone(),
            fleet_cell.clone(),
        );

        let fleet = Arc::new(Fleet {
            links: RwLock::new(Vec::new()),
            machines: Mutex::new(stored_machines.value),
            reviewed: Mutex::new(stored_reviewed.value),
            first_seen: Mutex::new(FirstSeen::new()),
            settings: Mutex::new(stored_settings.value),
            recents: Mutex::new(stored_recents.value),
            previews: preview::Previews::default(),
            watches: panes::Watches::default(),
            answering: Mutex::new(HashSet::new()),
            revision: AtomicU64::new(1),
            warnings,
            on_tick: config.on_tick,
            media: Arc::new(herdr_core::files::MediaCache::new(
                store.dir().join("cache").join("media"),
                herdr_core::files::MEDIA_CAP,
            )),
            store,
            local_socket,
            ssh,
            updates,
            notes,
            notify: notify_tx.clone(),
            sched,
            jobs,
            sessions,
            log_names: RwLock::new(LogNames::new()),
            pane_names: Mutex::new(herdr_core::observed::names::PaneSessionNames::default()),
            me: fleet_cell.clone(),
            // Last: dropped after the links, whose threads may still be talking to it.
            fixture: config.fixture,
        });

        let _ = fleet_cell.set(Arc::downgrade(&fleet));

        // Copies of remote pictures from an earlier run are only a cache: start empty.
        let _ = std::fs::remove_dir_all(fleet.files_cache());
        // Part files of copies that were running when the last run ended are not copies; the finished ones stay (within the cap).
        fleet.media.start();

        let mut threads = Vec::new();
        let spawn = |name: String, body: Box<dyn FnOnce() + Send>| {
            std::thread::Builder::new()
                .name(name)
                .spawn(body)
                .map_err(|e| format!("cannot start a thread: {e}"))
        };
        {
            let fleet = fleet.clone();
            threads.push(spawn(
                "herdr-forward".to_owned(),
                Box::new(move || forward::run(&fleet, &update_rx, &note_rx)),
            )?);
        }
        {
            let fleet = fleet.clone();
            threads.push(spawn(
                "herdr-schedule".to_owned(),
                Box::new(move || panes::schedule(&fleet, &sched_rx)),
            )?);
        }
        for n in 0..POOL {
            let fleet = fleet.clone();
            let jobs = job_rx.clone();
            threads.push(spawn(
                format!("herdr-read-{n}"),
                Box::new(move || panes::work(&fleet, &jobs)),
            )?);
        }

        let all = fleet.machines.lock().all();
        for machine in &all {
            fleet.start_link(machine);
            fleet.sync_keeper_host(machine, false);
        }
        let (notifier, handle) = crate::notify::Notifier::start(
            notify_tx.clone(),
            notify_rx,
            Arc::new(alerts::FleetSource(Arc::downgrade(&fleet))),
            sink,
            Arc::new(SystemClock),
        )?;
        threads.push(handle);
        Ok(Engine {
            fleet,
            threads,
            notifier,
            recording,
            desktop,
        })
    }

    /// Starts watching a pane (see [`Fleet::watch`]).
    pub fn watch(&self, machine: &str, pane: &str, source: PaneSource) -> Option<WatchHandle> {
        self.fleet.watch(machine, pane, source)
    }

    /// The provider `PaneScreen` opens its feeds through; install it with [`crate::feed::set_provider`].
    pub fn feed_provider(&self) -> Arc<dyn FeedProvider> {
        Arc::new(Provider(Arc::downgrade(&self.fleet)))
    }

    /// Who hears a click on a notification (the UI brings the window forward and shows the agent).
    pub fn notifier(&self) -> &crate::notify::Notifier {
        &self.notifier
    }

    /// The notifications of a scripted herdr, which are recorded instead of shown; `None` for the real
    /// one.
    pub fn recorded_notifications(&self) -> Option<&Arc<crate::notify::RecordingSink>> {
        self.recording.as_ref()
    }

    /// What the desktop's notification service can do, or why there is none (no session bus, nothing
    /// owning `org.freedesktop.Notifications`). A scripted herdr reports a full-featured service. Blocks
    /// on the bus: call it off the UI thread.
    pub fn notification_support(&self) -> Result<crate::notify::Support, String> {
        match &self.desktop {
            Some(desktop) => desktop.support(),
            None => Ok(crate::notify::Support {
                actions: true,
                markup: true,
            }),
        }
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.fleet.end_seam_sessions();
        self.fleet.stop();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

/// Opens pane feeds for `PaneScreen`. Holds the fleet weakly: a feed outliving its engine just stops.
struct Provider(Weak<Fleet>);

impl FeedProvider for Provider {
    fn open(&self, machine: &str, pane: &str, source: PaneSource) -> Option<Box<dyn PaneFeed>> {
        let fleet = self.0.upgrade()?;
        let handle = fleet.watch(machine, pane, source)?;
        Some(Box::new(handle))
    }
}

/// The state every thread and caller shares. See the module docs.
pub struct Fleet {
    links: RwLock<Vec<(MachineId, Arc<MachineLink>)>>,
    machines: Mutex<Machines>,
    reviewed: Mutex<Reviewed>,
    first_seen: Mutex<FirstSeen>,
    settings: Mutex<Settings>,
    recents: Mutex<Recents>,
    previews: preview::Previews,
    watches: panes::Watches,
    /// Panes with an answer on its way, so a double press sends once.
    answering: Mutex<HashSet<(MachineId, String)>>,
    revision: AtomicU64,
    warnings: Vec<String>,
    on_tick: Arc<dyn Fn() + Send + Sync>,
    store: Store,
    /// Copies of other machines' videos and sounds while they play (`<dataDir>/cache/media`, capped).
    media: Arc<herdr_core::files::MediaCache>,
    local_socket: PathBuf,
    ssh: Option<SshClient>,
    /// Agent sessions: each machine's keeper, the listings and the attached conversations.
    sessions: SessionHub,
    /// What the agents' own session logs call their panes, for panes whose title says nothing.
    log_names: RwLock<LogNames>,
    /// Which panes' session logs are read for a name, and what they said.
    pane_names: Mutex<herdr_core::observed::names::PaneSessionNames>,
    /// This fleet, for the threads it starts on its own.
    me: sessions::FleetCell,
    updates: Sender<Update>,
    notes: Sender<Note>,
    /// Tells the notifier thread what changed (see [`crate::notify`]).
    notify: Sender<crate::notify::Input>,
    sched: Sender<panes::Sched>,
    jobs: Sender<Job>,
    fixture: Option<Fixture>,
}

/// How a machine's link is doing, in the words the machine list uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// The first attempt is in flight.
    Connecting,
    /// Connected and live.
    Online,
    /// Lost; retrying.
    Offline,
    /// Needs the person (see the detail), no retries until [`Fleet::reconnect`].
    Attention,
    /// Switched off.
    Off,
}

/// One machine's link, as the machine list and the sidebar show it.
#[derive(Debug, Clone, PartialEq)]
pub struct MachineHealth {
    /// The machine's id.
    pub id: MachineId,
    /// What the person calls it.
    pub name: String,
    /// How the link is doing.
    pub state: LinkKind,
    /// Why it is offline or needs attention, ready to show.
    pub detail: Option<String>,
    /// While offline: how long until the next attempt.
    pub retry_in: Option<Duration>,
    /// herdr's version on that machine.
    pub herdr_version: Option<String>,
    /// herdr speaks a newer protocol than this app was written for.
    pub newer_herdr: bool,
    /// How long ago the machine last said anything.
    pub heard_ago: Option<Duration>,
    /// Agents the last snapshot lists.
    pub agents: usize,
    /// Agents blocked on the person (0 unless the machine is online).
    pub needs_you: usize,
}

/// The board with everything a screen shows of it.
#[derive(Debug, Clone)]
pub struct BoardState {
    /// The sections and counts.
    pub board: Board,
    /// The previews of the rows that have one, by [`herdr_core::board::AgentRow::key`].
    pub previews: HashMap<String, Preview>,
    /// Machine names by id.
    pub machine_names: HashMap<MachineId, String>,
    /// The status line (`2 need you · 3 to review · 3 working · heard just now`).
    pub status_line: String,
    /// The window title (`(2) Herdr Desktop`).
    pub title: String,
    /// The instant the ages were taken at.
    pub now: Instant,
}

impl BoardState {
    /// Every row shown, project by project.
    pub fn rows(&self) -> impl Iterator<Item = &herdr_core::board::AgentRow> {
        self.board.rows()
    }
}

/// What a screen shows of one pane (a tab's header, the answer dock).
#[derive(Debug, Clone, PartialEq)]
pub struct PaneSummary {
    /// What the person calls it.
    pub name: String,
    /// The agent's kind (`omp`, `claude`); empty for a plain terminal.
    pub agent: String,
    /// Its folder.
    pub cwd: Option<String>,
    /// What it is doing (`Unknown` for a plain terminal).
    pub status: AgentStatus,
    /// The pane's workspace.
    pub workspace_id: String,
    /// The pane's tab.
    pub tab_id: String,
    /// The workspace's name.
    pub workspace_label: String,
    /// The tab's name.
    pub tab_label: String,
    /// The machine's name.
    pub machine_name: String,
    /// Whether what the pane shows can be trusted.
    pub feed: FeedState,
    /// The question, while the agent is blocked on one.
    pub prompt: Option<PromptInfo>,
}

impl Fleet {
    /// What the store said was wrong with a file it had to set aside, if anything.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// The change counter: strictly increasing, one step per tick.
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Relaxed)
    }

    /// Tells the UI something changed that no link reported.
    pub(crate) fn bump(&self) {
        let _ = self.notes.send(Note::Bump);
    }

    /// Asks every thread to stop; [`Engine`] joins them.
    fn stop(&self) {
        let _ = self.notes.send(Note::Stop);
        let _ = self.notify.send(crate::notify::Input::Stop);
        let _ = self.sched.send(panes::Sched::Stop);
        for _ in 0..POOL {
            let _ = self.jobs.send(Job::Stop);
        }
    }

    /// How many panes are being watched (diagnostics and tests: an unwatched pane is never read).
    pub fn watching(&self) -> usize {
        self.watches.len()
    }

    /// The data directory.
    pub fn data_dir(&self) -> &Path {
        self.store.dir()
    }

    // ---- links ----------------------------------------------------------------------------------

    /// Starts the link of `machine` and a pump that hands its pane activity to the scheduler.
    fn start_link(&self, machine: &Machine) -> Arc<MachineLink> {
        let wire: Arc<dyn Wire> = if machine.is_local() {
            Arc::new(LocalWire::new(&self.local_socket))
        } else {
            self.remote_wire(machine)
        };
        let mut config = LinkConfig::new(machine.id.clone(), wire);
        config.enabled = machine.enabled;
        let link = Arc::new(MachineLink::start(config, self.updates.clone()));

        let activity = link.activity();
        let sched = self.sched.clone();
        let started = std::thread::Builder::new()
            .name(format!("herdr-pump-{}", machine.id))
            .spawn(move || {
                // Ends when the link is dropped: its sender side goes with it.
                while let Ok(a) = activity.recv() {
                    let message = panes::Sched::Activity {
                        machine: a.machine,
                        pane: a.pane_id,
                    };
                    if sched.send(message).is_err() {
                        break;
                    }
                }
            });
        if let Err(e) = started {
            eprintln!(
                "herdr-desktop: cannot start the activity pump of {}: {e}",
                machine.id
            );
        }
        self.links.write().push((machine.id.clone(), link.clone()));
        link
    }

    /// The wire of a remote machine, or why the machine cannot be reached at all.
    fn ssh_wire(&self, machine: &Machine) -> Result<SshWire, String> {
        let client = self.ssh.clone().ok_or_else(|| {
            "ssh is unavailable: its control directory could not be created".to_owned()
        })?;
        let target = SshTarget::new(
            &machine.dest,
            machine.port,
            machine.session.as_deref(),
            None,
        )
        .map_err(|e| e.to_string())?;
        Ok(SshWire::new(client, target))
    }

    /// The wire of a remote machine: the system `ssh`, or what a test scripted for its destination, or
    /// a rejection that says why the machine cannot be reached at all.
    pub(crate) fn remote_wire(&self, machine: &Machine) -> Arc<dyn Wire> {
        if let Some(stderr) = self
            .fixture
            .as_ref()
            .and_then(|f| f.ssh_fault(&machine.dest))
        {
            return Arc::new(ScriptedSsh {
                dest: machine.dest.clone(),
                stderr,
            });
        }
        match self.ssh_wire(machine) {
            Ok(wire) => Arc::new(wire),
            Err(message) => Arc::new(RejectedWire(message)),
        }
    }

    /// The link of `machine`.
    pub(crate) fn link(&self, machine: &str) -> Option<Arc<MachineLink>> {
        self.links
            .read()
            .iter()
            .find(|(id, _)| id == machine)
            .map(|(_, link)| link.clone())
    }

    /// The machine and its link.
    fn entry(&self, id: &str) -> Option<(Machine, Arc<MachineLink>)> {
        let machine = self.machines.lock().get(id)?;
        Some((machine, self.link(id)?))
    }

    /// Every machine with its link, in list order.
    fn entries(&self) -> Vec<(Machine, Arc<MachineLink>)> {
        let all = self.machines.lock().all();
        let links = self.links.read();
        all.into_iter()
            .filter_map(|m| {
                let link = links.iter().find(|(id, _)| *id == m.id)?.1.clone();
                Some((m, link))
            })
            .collect()
    }

    /// The window is hidden or shown again: links space their retries and polls out while hidden.
    pub fn set_background(&self, background: bool) {
        let profile = if background {
            Profile::Background
        } else {
            Profile::Foreground
        };
        for (_, link) in self.links.read().iter() {
            link.set_profile(profile);
        }
        self.sessions.set_background(background);
        // The window is away for the person too: notifications are posted only then.
        let _ = self.notify.send(crate::notify::Input::Away(background));
    }

    /// Retries a machine now, leaving `Attention`.
    pub fn reconnect(&self, machine: &str) -> Result<(), String> {
        let link = self.link(machine).ok_or_else(|| unknown(machine))?;
        link.reconnect_now();
        Ok(())
    }

    // ---- the board --------------------------------------------------------------------------------

    /// The board now, with each row's preview. Rows whose episode has no preview yet start a read on the
    /// pool (at most a bounded number at a time); when it lands the UI is ticked and pulls again.
    pub fn board(&self) -> BoardState {
        let now = Instant::now();
        self.sync_log_names();
        let entries = self.entries();
        let inputs: Vec<(MachineId, Arc<Snapshot>, LinkState)> = entries
            .iter()
            .map(|(m, link)| (m.id.clone(), link.snapshot(), link.state()))
            .collect();
        let board = {
            let reviewed = self.reviewed.lock();
            let first_seen = self.first_seen.lock();
            let sessions = self.sessions.rows();
            let names = self.log_names.read();
            let pins = self.pinned_projects();
            Board::from(
                &inputs,
                BoardExtras {
                    sessions: &sessions,
                    names: &names,
                    pins: &pins,
                },
                &reviewed,
                &first_seen,
                now,
            )
        };

        let mut data = BoardState {
            previews: HashMap::new(),
            machine_names: entries
                .iter()
                .map(|(m, _)| (m.id.clone(), m.name.clone()))
                .collect(),
            status_line: String::new(),
            title: window_title(board.counts.needs_you),
            board,
            now,
        };
        let mut previews = HashMap::new();
        // A session is no pane: there is nothing to read for a preview.
        for row in data.rows().filter(|row| !row.offline && !row.session) {
            let stamp = stamp_of(row);
            if let Some(preview) = self.previews.view(&row.machine, &row.pane_id, stamp) {
                previews.insert(row.key(), preview);
            }
            if self.previews.claim(&row.machine, &row.pane_id, stamp, now) {
                let _ = self.jobs.send(Job::Preview {
                    machine: row.machine.clone(),
                    pane: row.pane_id.clone(),
                    stamp,
                });
            }
        }
        data.previews = previews;
        let heard = entries
            .iter()
            .filter(|(_, link)| link.state() == LinkState::Online)
            .filter_map(|(_, link)| link.heard_ago())
            .max()
            .map(words::heard);
        let review_offline = data.board.to_review.iter().filter(|r| r.offline).count();
        data.status_line = status_line(&data.board.counts, review_offline, heard.as_deref());
        data
    }

    /// Every machine's link state.
    pub fn machine_statuses(&self) -> Vec<MachineHealth> {
        let now = Instant::now();
        self.entries()
            .into_iter()
            .map(|(machine, link)| {
                let status = link.status();
                let snapshot = link.snapshot();
                let (state, detail) = match &status.state {
                    LinkState::Connecting => (LinkKind::Connecting, None),
                    LinkState::Online => (LinkKind::Online, None),
                    LinkState::Offline => (LinkKind::Offline, status.error.clone()),
                    LinkState::Attention(reason) => (LinkKind::Attention, Some(reason.clone())),
                    LinkState::Off => (LinkKind::Off, None),
                };
                let online = state == LinkKind::Online;
                MachineHealth {
                    id: machine.id,
                    name: machine.name,
                    state,
                    detail,
                    retry_in: status.retry_at.map(|at| at.saturating_duration_since(now)),
                    herdr_version: status.herdr_version.clone(),
                    newer_herdr: status.notes.contains(&LinkNote::NewerHerdr),
                    heard_ago: link.heard_ago(),
                    agents: snapshot.agents.len(),
                    needs_you: if online {
                        snapshot
                            .agents
                            .iter()
                            .filter(|a| a.agent_status == AgentStatus::Blocked)
                            .count()
                    } else {
                        0
                    },
                }
            })
            .collect()
    }

    /// What a screen shows of one pane; `None` for an unknown machine. A pane that is not in the
    /// snapshot any more has `feed == Gone` (or `Stale` while the machine is not connected, because
    /// then the snapshot is not news).
    pub fn pane_summary(&self, machine: &str, pane_id: &str) -> Option<PaneSummary> {
        let (info, link) = self.entry(machine)?;
        let snapshot = link.snapshot();
        let state = link.state();
        let feed = pane_feed_state(&state, &snapshot, pane_id);
        let pane = snapshot.pane(pane_id);
        let agent = snapshot.agent(pane_id);
        let label = |ws: &str| {
            snapshot
                .workspace(ws)
                .map(|w| w.label.clone())
                .unwrap_or_default()
        };
        let (workspace_id, tab_id) = match (pane, agent) {
            (Some(p), _) => (p.workspace_id.as_str(), p.tab_id.as_str()),
            (None, Some(a)) => (a.workspace_id.as_str(), a.tab_id.as_str()),
            (None, None) => ("", ""),
        };
        let tab_label = snapshot
            .tabs
            .iter()
            .find(|t| t.tab_id == tab_id)
            .map(|t| t.label.clone())
            .unwrap_or_default();

        let mut meta = PaneSummary {
            name: pane_id.to_owned(),
            agent: String::new(),
            cwd: pane.and_then(|p| p.cwd.clone()),
            status: AgentStatus::Unknown,
            workspace_id: workspace_id.to_owned(),
            tab_id: tab_id.to_owned(),
            workspace_label: label(workspace_id),
            tab_label,
            machine_name: info.name,
            feed,
            prompt: None,
        };
        match (agent, pane) {
            (Some(agent), _) => {
                let mini = Snapshot {
                    panes: pane.cloned().into_iter().collect(),
                    agents: vec![agent.clone()],
                    ..Snapshot::default()
                };
                let row = {
                    let reviewed = self.reviewed.lock();
                    let first_seen = self.first_seen.lock();
                    // Online whatever the link says: the row's name and status do not depend on it.
                    Board::from(
                        &[(machine.to_owned(), Arc::new(mini), LinkState::Online)],
                        herdr_core::board::BoardExtras::NONE,
                        &reviewed,
                        &first_seen,
                        Instant::now(),
                    )
                };
                if let Some(row) = row.rows().next() {
                    meta.name = row.name.clone();
                    meta.agent = row.agent.clone();
                    meta.cwd = row.cwd.clone();
                    meta.status = row.status;
                    if feed == FeedState::Live && row.status == AgentStatus::Blocked {
                        let stamp = stamp_of(row);
                        meta.prompt = self.previews.prompt(machine, pane_id, stamp);
                        if self.previews.claim(machine, pane_id, stamp, Instant::now()) {
                            let _ = self.jobs.send(Job::Preview {
                                machine: machine.to_owned(),
                                pane: pane_id.to_owned(),
                                stamp,
                            });
                        }
                    }
                }
            }
            (None, Some(pane)) => meta.name = terminal_name(pane),
            (None, None) => {}
        }
        Some(meta)
    }

    // ---- marks and settings -----------------------------------------------------------------------

    /// Marks finished episodes as looked at. Persisted; the board drops them from "to review".
    pub fn review(&self, keys: &[ReviewKey]) -> Result<(), String> {
        self.change_reviewed(|reviewed| {
            keys.iter()
                .fold(false, |any, k| reviewed.review(k.clone()) | any)
        })
    }

    /// Takes the marks back (the `Undo` of a bulk review).
    pub fn unreview(&self, keys: &[ReviewKey]) -> Result<(), String> {
        self.change_reviewed(|reviewed| {
            keys.iter().fold(false, |any, k| reviewed.unreview(k) | any)
        })
    }

    fn change_reviewed(&self, change: impl FnOnce(&mut Reviewed) -> bool) -> Result<(), String> {
        let mut reviewed = self.reviewed.lock();
        if change(&mut reviewed) {
            self.store
                .save_reviewed(&reviewed)
                .map_err(|e| format!("cannot save the reviewed marks: {e}"))?;
            drop(reviewed);
            self.bump();
        }
        Ok(())
    }

    /// The keys of the projects the person pinned (they list first on the home and in the sidebar).
    fn pinned_projects(&self) -> BTreeSet<String> {
        self.setting(PINNED_KEY)
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// Pins a project (`Project::key`) or takes the pin back. Persisted; the board is rebuilt.
    pub fn pin_project(&self, key: &str, pinned: bool) -> Result<(), String> {
        let mut pins = self.pinned_projects();
        if pinned {
            pins.insert(key.to_owned());
        } else {
            pins.remove(key);
        }
        self.set_setting(PINNED_KEY, serde_json::json!(pins))
    }

    /// A setting, or `None` when it was never set.
    pub fn setting(&self, key: &str) -> Option<Value> {
        self.settings.lock().get::<Value>(key)
    }

    /// Stores a setting and persists the file.
    pub fn set_setting(&self, key: &str, value: Value) -> Result<(), String> {
        let mut settings = self.settings.lock();
        if value.is_null() {
            settings.remove(key);
        } else {
            settings.set(key, value).map_err(|e| e.to_string())?;
        }
        self.store
            .save_settings(&settings)
            .map_err(|e| format!("cannot save the settings: {e}"))?;
        drop(settings);
        self.bump();
        Ok(())
    }

    // ---- what was visited ---------------------------------------------------------------------------

    /// Notes a visit to `key` (`agent:<row key>`, `project:<key>`) now and persists the list. The board does not
    /// change, so nobody is ticked.
    pub fn visit(&self, key: &str) -> Result<(), String> {
        let mut recents = self.recents.lock();
        recents.visit(key, now_ms());
        self.store
            .save_recents(&recents)
            .map_err(|e| format!("cannot save the recent visits: {e}"))
    }

    /// Forgets a destination (an agent that was closed, `Clear history`).
    pub fn forget(&self, key: &str) -> Result<(), String> {
        let mut recents = self.recents.lock();
        if recents.forget(key) {
            self.store
                .save_recents(&recents)
                .map_err(|e| format!("cannot save the recent visits: {e}"))?;
        }
        Ok(())
    }

    /// The visited destinations, newest first, with the figures a ranking needs.
    pub fn recents(&self) -> Vec<(String, u64, u64, f64)> {
        let now = now_ms();
        self.recents
            .lock()
            .entries()
            .iter()
            .map(|e| (e.key.clone(), e.last(), e.count, e.frecency(now)))
            .collect()
    }

    /// The visited destinations as stored (newest first): the palette's ranking weighs each kind's visits its own way.
    pub fn recent_entries(&self) -> Vec<herdr_core::recents::Entry> {
        self.recents.lock().entries().to_vec()
    }

    // ---- the test seam ----------------------------------------------------------------------------

    /// The scripted herdr, when the engine was started with one.
    pub fn fixture(&self) -> Option<&Fixture> {
        self.fixture.as_ref()
    }
}

/// The episode an agent row is in: what a preview is read for. A reviewed `done` is still `done` to
/// herdr.
pub(crate) fn stamp_of(row: &herdr_core::board::AgentRow) -> preview::Stamp {
    let status = if row.reviewed {
        AgentStatus::Done
    } else {
        row.status
    };
    (status, row.state_change_seq)
}

/// Whether a pane's content can be trusted given its machine's link and snapshot.
pub(crate) fn pane_feed_state(state: &LinkState, snapshot: &Snapshot, pane: &str) -> FeedState {
    if *state != LinkState::Online {
        FeedState::Stale
    } else if snapshot.pane(pane).is_none() {
        FeedState::Gone
    } else {
        FeedState::Live
    }
}

/// What a plain terminal pane is called: the person's label, else its title, else its folder.
fn terminal_name(pane: &PaneInfo) -> String {
    let given = pane
        .label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(name) = given {
        return name.to_owned();
    }
    let title = pane
        .terminal_title_stripped
        .as_deref()
        .or(pane.terminal_title.as_deref())
        .map(clean_terminal_title)
        .unwrap_or_default();
    if !title.is_empty() && !title.eq_ignore_ascii_case("terminal") {
        return title;
    }
    let folder = herdr_core::board::folder_name(pane.cwd.as_deref());
    if folder.is_empty() {
        "Terminal".to_owned()
    } else {
        folder
    }
}

pub(crate) fn unknown(machine: &str) -> String {
    format!("There is no machine {machine}")
}

/// The wire of a machine that cannot be reached at all (a destination that fails validation, no ssh):
/// the link shows `Attention` with the reason instead of retrying.
struct RejectedWire(String);

impl Wire for RejectedWire {
    fn request(&self, _: &str, _: Value, _: Duration) -> Result<Value, WireError> {
        Err(WireError::fatal(Fatal::SshMissing, self.0.clone()))
    }

    fn events(&self, _: &[Value]) -> Result<Box<dyn herdr_core::wire::EventStream>, WireError> {
        Err(WireError::fatal(Fatal::SshMissing, self.0.clone()))
    }
}

/// ssh as a test scripted it for a destination ([`Fixture::set_ssh_fault`]): every attempt ends the way
/// the text says, classified like real ssh output, and nothing is spawned.
struct ScriptedSsh {
    dest: String,
    stderr: String,
}

impl Wire for ScriptedSsh {
    fn request(&self, _: &str, _: Value, _: Duration) -> Result<Value, WireError> {
        Err(classify_ssh(Some(255), &self.stderr, &self.dest))
    }

    fn events(&self, _: &[Value]) -> Result<Box<dyn herdr_core::wire::EventStream>, WireError> {
        Err(classify_ssh(Some(255), &self.stderr, &self.dest))
    }
}

/// Milliseconds since the epoch.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
