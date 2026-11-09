//! Every machine's keeper and every attached session, in one place.
//!
//! The hub owns what survives a screen: the machines' [`KeeperHost`]s, the last listing of each (a poller
//! refreshes it every 30 s while the window is in use, every 5 min while it is not), the attached
//! sessions (at most four per machine) and the list of keepers this app started, which are the only ones
//! it will end. It feeds the board with [`SessionRow`]s so a session that needs the person is counted
//! with the terminal agents that do.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crossbeam_channel::{RecvTimeoutError, Sender, unbounded};
use parking_lot::{Mutex, RwLock};

use super::adapter::Begin;
use super::error::KeeperError;
use super::host::KeeperHost;
use super::records::{KeeperInfo, KeeperState, PastSessions, Route};
use super::thread::{Opening, SessionHandle};
use super::types::SessionPhase;
use crate::board::{SessionRow, folder_name};
use crate::cache::Cache;
use crate::observed::kinds::ObservedKind;
use crate::observed::session::{ObservedConfig, ObservedHandle, PaneIo};
use crate::schema::AgentStatus;

/// Sessions attached at once on one machine (herdr-mobile's limit: each is a process and a connection).
pub const MAX_ATTACHED: usize = 4;

/// Saves the list of keepers this app started.
pub type OwnedSink = Arc<dyn Fn(&[String]) + Send + Sync>;

/// Observed sessions (agents in panes, read from their logs) open at once on one machine: each is a `follow`
/// process and a connection.
pub const MAX_OBSERVED: usize = 4;

/// What the hub needs to know.
pub struct HubConfig {
    /// How often the listings are refreshed while the window is in use.
    pub poll_foreground: Duration,
    /// How often while it is not.
    pub poll_background: Duration,
    /// The keepers this app started in earlier runs (`machine/id`).
    pub owned: Vec<String>,
    /// Called with the whole list of owned keepers whenever it changes, to be saved.
    pub on_owned: OwnedSink,
    /// Timing of observed sessions.
    pub observed: ObservedConfig,
    /// Called from a hub or session thread when anything the screens show changed. Must not block.
    pub on_change: Arc<dyn Fn() + Send + Sync>,
    /// What is kept on disk between runs (saved conversations); a disabled cache keeps nothing.
    pub cache: Arc<Cache>,
    /// How long a chat the person left stays attached, so coming back to it costs nothing (a tab closed, a project
    /// switched). It goes sooner when a new one needs its place.
    pub linger: Duration,
    /// The same while the window is hidden.
    pub linger_background: Duration,
    /// How often lingering sessions are looked at for being past `linger`.
    pub reap_every: Duration,
    /// How old a listing may be and still stand in for a `keeper list` when a session is attached.
    pub listing_fresh: Duration,
}

impl HubConfig {
    /// A configuration with herdr-mobile's poll timing, nothing owned and nothing listening.
    pub fn new(on_change: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            poll_foreground: Duration::from_secs(30),
            poll_background: Duration::from_secs(300),
            owned: Vec::new(),
            on_owned: Arc::new(|_| {}),
            observed: ObservedConfig::default(),
            on_change,
            cache: Arc::new(Cache::disabled()),
            linger: Duration::from_secs(10 * 60),
            linger_background: Duration::from_secs(90),
            reap_every: Duration::from_secs(15),
            listing_fresh: Duration::from_secs(60),
        }
    }
}

/// A machine's keeper and what was last heard from it.
struct Entry {
    host: Arc<KeeperHost>,
    /// The last listing; `None` before the first answer or after the machine stopped answering.
    listing: Mutex<Option<Vec<KeeperInfo>>>,
    /// When `listing` was read; `None` while it is `None`.
    listed_at: Mutex<Option<Instant>>,
    /// How old `listing` may be and still be believed (`HubConfig::listing_fresh`).
    fresh: Duration,
    /// The poller found the script missing: it will not install it on its own.
    not_installed: AtomicBool,
}

impl Entry {
    /// The listing, when it is recent enough to stand in for asking the machine.
    fn fresh_listing(&self) -> Option<Vec<KeeperInfo>> {
        let at = (*self.listed_at.lock())?;
        if at.elapsed() > self.fresh {
            return None;
        }
        self.listing.lock().clone()
    }

    /// Keeper `id`'s record from a recent listing, when it is there and its agent is alive. Anything else (not listed,
    /// exited, no recent listing) is for a fresh `keeper list` to say, in the words the screens already have.
    fn fresh_info(&self, id: &str) -> Option<KeeperInfo> {
        self.fresh_listing()?
            .into_iter()
            .find(|k| k.id == id)
            .filter(KeeperInfo::alive)
    }

    /// What a session's thread reads its keeper's record from: the recent listing when it already names the
    /// ACP session (`session_id`), else the machine's answer now.
    fn listing_for(&self, id: &str) -> Result<Vec<KeeperInfo>, KeeperError> {
        if let Some(all) = self.fresh_listing()
            && all.iter().any(|k| k.id == id && k.session_id.is_some())
        {
            return Ok(all);
        }
        self.host.list()
    }
}

/// How long a state has lasted, as far as this app has seen: an episode already there when a machine's
/// sessions were first seen has no date.
#[derive(Default)]
struct Episodes {
    seen: HashMap<(String, String), (AgentStatus, Option<Instant>)>,
    machines: HashSet<String>,
}

/// Which table a lingering session is in, with its machine and id (a pane id for an observed one).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Slot {
    Keeper(String, String),
    Observed(String, String),
}

impl Slot {
    fn machine(&self) -> &str {
        match self {
            Slot::Keeper(m, _) | Slot::Observed(m, _) => m,
        }
    }
}

struct Inner {
    entries: RwLock<HashMap<String, Arc<Entry>>>,
    attached: Mutex<HashMap<(String, String), SessionHandle>>,
    observed: Mutex<HashMap<(String, String), ObservedHandle>>,
    /// Sessions the person left that are still attached, and since when. Lock order: this one first, then
    /// `attached` or `observed`, never the other way round.
    lingering: Mutex<HashMap<Slot, Instant>>,
    owned: Mutex<BTreeSet<String>>,
    episodes: Mutex<Episodes>,
    background: AtomicBool,
    config: HubConfig,
}

/// The hub. Dropping it stops the poller and detaches every session (their agents keep running).
pub struct SessionHub {
    inner: Arc<Inner>,
    poll: Sender<Poll>,
    poller: Mutex<Option<JoinHandle<()>>>,
}

enum Poll {
    Machine(String),
    Stop,
}

impl SessionHub {
    /// A hub with no machines.
    pub fn new(config: HubConfig) -> Self {
        let owned = config.owned.iter().cloned().collect();
        let inner = Arc::new(Inner {
            entries: RwLock::new(HashMap::new()),
            attached: Mutex::new(HashMap::new()),
            observed: Mutex::new(HashMap::new()),
            lingering: Mutex::new(HashMap::new()),
            owned: Mutex::new(owned),
            episodes: Mutex::new(Episodes::default()),
            background: AtomicBool::new(false),
            config,
        });
        let (poll, polls) = unbounded();
        let poller = {
            let inner = inner.clone();
            std::thread::Builder::new()
                .name("herdr-session-poll".to_owned())
                .spawn(move || {
                    // Absolute deadlines: a burst of `Poll::Machine` must not push the regular poll or the reaping off.
                    let started = Instant::now();
                    let (mut last_poll, mut last_reap) = (started, started);
                    loop {
                        let interval = if inner.background.load(Ordering::Relaxed) {
                            inner.config.poll_background
                        } else {
                            inner.config.poll_foreground
                        };
                        let due = (last_poll + interval).min(last_reap + inner.config.reap_every);
                        match polls.recv_deadline(due) {
                            Ok(Poll::Stop) | Err(RecvTimeoutError::Disconnected) => return,
                            Ok(Poll::Machine(machine)) => inner.poll(Some(&machine)),
                            Err(RecvTimeoutError::Timeout) => {
                                let now = Instant::now();
                                if now >= last_reap + inner.config.reap_every {
                                    inner.reap(now);
                                    last_reap = now;
                                }
                                if now >= last_poll + interval {
                                    inner.poll(None);
                                    last_poll = Instant::now();
                                }
                            }
                        }
                    }
                })
                .ok()
        };
        Self {
            inner,
            poll,
            poller: Mutex::new(poller),
        }
    }

    /// Registers (or replaces) a machine's keeper and lists it soon. Sessions attached to a replaced
    /// host are detached.
    pub fn set_host(&self, machine: &str, host: Arc<KeeperHost>) {
        self.detach_machine(machine);
        self.inner.entries.write().insert(
            machine.to_owned(),
            Arc::new(Entry {
                host,
                listing: Mutex::new(None),
                listed_at: Mutex::new(None),
                fresh: self.inner.config.listing_fresh,
                not_installed: AtomicBool::new(false),
            }),
        );
        let _ = self.poll.send(Poll::Machine(machine.to_owned()));
    }

    /// Whether `machine` has a keeper registered.
    pub fn has_host(&self, machine: &str) -> bool {
        self.inner.entries.read().contains_key(machine)
    }

    /// Forgets a machine: detaches its sessions and drops what was listed.
    pub fn remove_host(&self, machine: &str) {
        self.detach_machine(machine);
        self.inner.entries.write().remove(machine);
        let mut episodes = self.inner.episodes.lock();
        episodes.machines.remove(machine);
        episodes.seen.retain(|(m, _), _| m != machine);
        drop(episodes);
        (self.inner.config.on_change)();
    }

    fn detach_machine(&self, machine: &str) {
        self.inner
            .lingering
            .lock()
            .retain(|slot, _| slot.machine() != machine);
        let gone: Vec<SessionHandle> = {
            let mut attached = self.inner.attached.lock();
            let keys: Vec<_> = attached
                .keys()
                .filter(|(m, _)| m == machine)
                .cloned()
                .collect();
            keys.iter().filter_map(|k| attached.remove(k)).collect()
        };
        for handle in gone {
            handle.detach();
        }
        let watched: Vec<ObservedHandle> = {
            let mut observed = self.inner.observed.lock();
            let keys: Vec<_> = observed
                .keys()
                .filter(|(m, _)| m == machine)
                .cloned()
                .collect();
            keys.iter().filter_map(|k| observed.remove(k)).collect()
        };
        for handle in watched {
            handle.detach();
        }
    }

    fn entry(&self, machine: &str) -> Result<Arc<Entry>, KeeperError> {
        self.inner.entry(machine)
    }

    /// The agents `machine` can run.
    pub fn probe(&self, machine: &str) -> Result<Vec<Route>, KeeperError> {
        self.entry(machine)?.host.probe()
    }

    /// The keepers on `machine` now (running, or exited within a day), newest first.
    pub fn list(&self, machine: &str) -> Result<Vec<KeeperInfo>, KeeperError> {
        let entry = self.entry(machine)?;
        let all = entry.host.list()?;
        entry.not_installed.store(false, Ordering::Relaxed);
        self.inner.store_listing(&entry, Some(all.clone()));
        Ok(all)
    }

    /// What `agent` remembers on `machine`.
    pub fn history(
        &self,
        machine: &str,
        agent: &str,
        cwd: Option<&str>,
    ) -> Result<PastSessions, KeeperError> {
        self.entry(machine)?.host.history(agent, cwd)
    }

    /// Starts a keeper for `agent` in `cwd` on `machine`, attaches to it and opens a new session in it.
    /// The keeper is this app's from now on (it may end it).
    pub fn start(
        &self,
        machine: &str,
        agent: &str,
        cwd: &str,
    ) -> Result<SessionHandle, KeeperError> {
        self.check_room(machine, None)?;
        let entry = self.entry(machine)?;
        let info = entry.host.start(agent, cwd)?;
        self.own(machine, &info.id);
        self.relist(machine);
        self.open(
            machine,
            &entry,
            &info.id,
            Begin::Create {
                cwd: info.cwd.clone(),
            },
            &info.agent,
            &info.cwd,
        )
    }

    /// Reopens a past session: starts a new keeper in `cwd` and asks the agent to load `session_id`
    /// (`Continue`). The agent replays the conversation; from then on it is an ordinary session.
    pub fn resume(
        &self,
        machine: &str,
        agent: &str,
        cwd: &str,
        session_id: &str,
    ) -> Result<SessionHandle, KeeperError> {
        if session_id.is_empty() || session_id.chars().any(char::is_control) {
            return Err(KeeperError::Invalid("That is not a session id.".into()));
        }
        self.check_room(machine, None)?;
        let entry = self.entry(machine)?;
        let info = entry.host.start(agent, cwd)?;
        self.own(machine, &info.id);
        self.relist(machine);
        self.open(
            machine,
            &entry,
            &info.id,
            Begin::Resume {
                cwd: info.cwd.clone(),
                session_id: session_id.to_owned(),
            },
            &info.agent,
            &info.cwd,
        )
    }

    /// Attaches to keeper `id` on `machine`: the agent's conversation replays into the transcript. An
    /// already attached session is returned as it is.
    pub fn attach(&self, machine: &str, id: &str) -> Result<SessionHandle, KeeperError> {
        self.inner
            .unlinger(&Slot::Keeper(machine.to_owned(), id.to_owned()));
        if let Some(handle) = self.handle(machine, id) {
            return Ok(handle);
        }
        self.check_room(machine, Some(id))?;
        let entry = self.entry(machine)?;
        // A recent listing says what `keeper list` would, without an ssh round trip before anything can be shown.
        let info = match entry.fresh_info(id) {
            Some(info) => info,
            None => {
                let info = entry
                    .host
                    .list()?
                    .into_iter()
                    .find(|k| k.id == id)
                    .ok_or_else(|| {
                        KeeperError::Gone("That session doesn’t exist on the machine.".into())
                    })?;
                if !info.alive() {
                    return Err(KeeperError::AgentExited(
                        info.exit_reason
                            .unwrap_or_else(|| "The agent of this session has exited.".into()),
                    ));
                }
                info
            }
        };
        self.open(machine, &entry, id, Begin::Attach, &info.agent, &info.cwd)
    }

    /// The attached session, when it is attached and its connection is open.
    pub fn handle(&self, machine: &str, id: &str) -> Option<SessionHandle> {
        let mut attached = self.inner.attached.lock();
        let key = (machine.to_owned(), id.to_owned());
        match attached.get(&key) {
            Some(h) if h.is_open() => Some(h.clone()),
            Some(_) => {
                // A closed session is dropped from the table so a new attach can replace it.
                attached.remove(&key);
                None
            }
            None => None,
        }
    }

    /// Closes the connection to a session now. The keeper and its agent keep running.
    pub fn detach(&self, machine: &str, id: &str) {
        self.inner
            .unlinger(&Slot::Keeper(machine.to_owned(), id.to_owned()));
        let handle = self
            .inner
            .attached
            .lock()
            .remove(&(machine.to_owned(), id.to_owned()));
        if let Some(handle) = handle {
            handle.detach();
            (self.inner.config.on_change)();
        }
    }

    /// The person left the session (its tab closed, its project switched). It stays attached for `linger`, so coming back
    /// costs nothing, and goes sooner when another session needs its place. Nothing blocks here: the UI thread never
    /// waits for a connection to close.
    pub fn release(&self, machine: &str, id: &str) {
        if self.handle(machine, id).is_some() {
            self.inner.lingering.lock().insert(
                Slot::Keeper(machine.to_owned(), id.to_owned()),
                Instant::now(),
            );
        }
    }

    /// Ends a session for good: its agent and its record. Only a keeper this app started, or one whose
    /// agent has already exited (nothing to stop, only a record to dismiss), is the app's to end.
    pub fn kill(&self, machine: &str, id: &str) -> Result<(), KeeperError> {
        let entry = self.entry(machine)?;
        let key = format!("{machine}/{id}");
        if !self.inner.owned.lock().contains(&key) {
            let exited = entry
                .host
                .list()?
                .into_iter()
                .find(|k| k.id == id)
                .is_some_and(|k| !k.alive());
            if !exited {
                return Err(KeeperError::NotOwned(
                    "This session was not started by this app. End it where it was started.".into(),
                ));
            }
        }
        self.detach(machine, id);
        entry.host.kill(id)?;
        {
            let mut owned = self.inner.owned.lock();
            if owned.remove(&key) {
                (self.inner.config.on_owned)(&owned.iter().cloned().collect::<Vec<_>>());
            }
        }
        self.inner.poll(Some(machine));
        Ok(())
    }

    /// Starts reading the log of the agent in pane `pane` of `machine` as a chat (`Show chat`). Reading
    /// the log changes nothing in the pane. An already open one is returned as it is; at most
    /// [`MAX_OBSERVED`] are open per machine.
    pub fn observe(
        &self,
        machine: &str,
        pane: &str,
        kind: &'static ObservedKind,
        io: Arc<dyn PaneIo>,
    ) -> Result<ObservedHandle, KeeperError> {
        self.inner
            .unlinger(&Slot::Observed(machine.to_owned(), pane.to_owned()));
        if let Some(handle) = self.observed(machine, pane) {
            return Ok(handle);
        }
        let entry = self.entry(machine)?;
        // Room first, outside the table's lock: a lingering chat gives its place up instead of refusing this one.
        loop {
            let open = {
                let mut observed = self.inner.observed.lock();
                observed.retain(|_, h| h.is_open());
                observed.keys().filter(|(m, _)| m == machine).count()
            };
            if open < MAX_OBSERVED || !self.inner.evict_lingering(machine, true) {
                break;
            }
        }
        let mut observed = self.inner.observed.lock();
        observed.retain(|_, h| h.is_open());
        if observed.keys().filter(|(m, _)| m == machine).count() >= MAX_OBSERVED {
            return Err(KeeperError::TooMany(format!(
                "{MAX_OBSERVED} chats from terminals are open on this machine already. Close one first."
            )));
        }
        let handle = ObservedHandle::open(
            entry.host.clone(),
            machine,
            pane,
            kind,
            io,
            self.inner.config.observed.clone(),
            self.inner.config.on_change.clone(),
            self.inner.config.cache.clone(),
        )
        .map_err(KeeperError::Other)?;
        observed.insert((machine.to_owned(), pane.to_owned()), handle.clone());
        drop(observed);
        (self.inner.config.on_change)();
        Ok(handle)
    }

    /// The open observed session of a pane.
    pub fn observed(&self, machine: &str, pane: &str) -> Option<ObservedHandle> {
        let mut observed = self.inner.observed.lock();
        let key = (machine.to_owned(), pane.to_owned());
        match observed.get(&key) {
            Some(h) if h.is_open() => Some(h.clone()),
            Some(_) => {
                observed.remove(&key);
                None
            }
            None => None,
        }
    }

    /// Stops reading a pane's log now (`Show terminal`). The agent is not touched.
    pub fn stop_observing(&self, machine: &str, pane: &str) {
        self.inner
            .unlinger(&Slot::Observed(machine.to_owned(), pane.to_owned()));
        let handle = self
            .inner
            .observed
            .lock()
            .remove(&(machine.to_owned(), pane.to_owned()));
        if let Some(handle) = handle {
            handle.detach();
            (self.inner.config.on_change)();
        }
    }

    /// The person left the chat of a pane's log (its tab closed, its project switched): it keeps reading for `linger`
    /// (see [`release`](Self::release)).
    pub fn release_observed(&self, machine: &str, pane: &str) {
        if self.observed(machine, pane).is_some() {
            self.inner.lingering.lock().insert(
                Slot::Observed(machine.to_owned(), pane.to_owned()),
                Instant::now(),
            );
        }
    }

    /// Whether this app started keeper `id` on `machine`.
    pub fn owns(&self, machine: &str, id: &str) -> bool {
        self.inner.owned.lock().contains(&format!("{machine}/{id}"))
    }

    /// A keeper was made: list the machine again soon so the board shows it, without waiting for the poll.
    fn relist(&self, machine: &str) {
        let _ = self.poll.send(Poll::Machine(machine.to_owned()));
    }

    fn own(&self, machine: &str, id: &str) {
        let mut owned = self.inner.owned.lock();
        if owned.insert(format!("{machine}/{id}")) {
            (self.inner.config.on_owned)(&owned.iter().cloned().collect::<Vec<_>>());
        }
    }

    /// Fails when `machine` has [`MAX_ATTACHED`] open sessions already (other than `id`) and none of them is only
    /// lingering: a lingering one is closed instead, the one left longest first.
    fn check_room(&self, machine: &str, id: Option<&str>) -> Result<(), KeeperError> {
        loop {
            let open = {
                let mut attached = self.inner.attached.lock();
                attached.retain(|_, h| h.is_open());
                attached
                    .keys()
                    .filter(|(m, k)| m == machine && Some(k.as_str()) != id)
                    .count()
            };
            if open < MAX_ATTACHED {
                return Ok(());
            }
            if !self.inner.evict_lingering(machine, false) {
                return Err(KeeperError::TooMany(format!(
                    "{MAX_ATTACHED} sessions are open on this machine already. Close one first."
                )));
            }
        }
    }

    fn open(
        &self,
        machine: &str,
        entry: &Arc<Entry>,
        id: &str,
        begin: Begin,
        agent: &str,
        cwd: &str,
    ) -> Result<SessionHandle, KeeperError> {
        let (listed, id_owned) = (entry.clone(), id.to_owned());
        let on_change = self.inner.config.on_change.clone();
        let handle = SessionHandle::open(Opening {
            host: &entry.host,
            machine,
            id,
            begin,
            agent,
            cwd,
            listing: Arc::new(move || listed.listing_for(&id_owned)),
            on_change,
            cache: self.inner.config.cache.clone(),
        })?;
        self.inner
            .attached
            .lock()
            .insert((machine.to_owned(), id.to_owned()), handle.clone());
        (self.inner.config.on_change)();
        Ok(handle)
    }

    /// The sessions the board counts: every live keeper listed, with an attached session's own phase
    /// where it is open.
    pub fn rows(&self) -> Vec<SessionRow> {
        self.inner.rows(Instant::now())
    }

    /// The window is hidden or shown again: the listings are refreshed less often while hidden.
    pub fn set_background(&self, background: bool) {
        let was = self.inner.background.swap(background, Ordering::Relaxed);
        if was && !background {
            // Looked at again: do not show five-minute-old sessions for another 30 s.
            for machine in self.inner.entries.read().keys() {
                let _ = self.poll.send(Poll::Machine(machine.clone()));
            }
        }
    }

    /// Detaches every session and stops the poller. Agents keep running in their keepers.
    pub fn shutdown(&self) {
        let _ = self.poll.send(Poll::Stop);
        if let Some(poller) = self.poller.lock().take() {
            let _ = poller.join();
        }
        let all: Vec<SessionHandle> = self.inner.attached.lock().drain().map(|(_, h)| h).collect();
        for handle in all {
            handle.detach();
        }
        let watched: Vec<ObservedHandle> =
            self.inner.observed.lock().drain().map(|(_, h)| h).collect();
        for handle in watched {
            handle.detach();
        }
        self.inner.lingering.lock().clear();
    }
}

impl Drop for SessionHub {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Inner {
    fn entry(&self, machine: &str) -> Result<Arc<Entry>, KeeperError> {
        self.entries.read().get(machine).cloned().ok_or_else(|| {
            KeeperError::NoMachine("That machine has no agent sessions channel.".into())
        })
    }

    /// Stores a listing and says so when it differs from the last one.
    fn store_listing(&self, entry: &Entry, listing: Option<Vec<KeeperInfo>>) {
        *entry.listed_at.lock() = listing.as_ref().map(|_| Instant::now());
        let mut slot = entry.listing.lock();
        if *slot != listing {
            *slot = listing;
            drop(slot);
            (self.config.on_change)();
        }
    }

    /// The session is wanted again (or ended on purpose): it is not lingering any more.
    fn unlinger(&self, slot: &Slot) {
        self.lingering.lock().remove(slot);
    }

    /// Closes the session that has lingered longest on `machine` (an observed one when `observed`), on a thread of its
    /// own. False when none lingers there.
    fn evict_lingering(&self, machine: &str, observed: bool) -> bool {
        let handle = {
            let mut lingering = self.lingering.lock();
            let Some(oldest) = lingering
                .iter()
                .filter(|(s, _)| {
                    s.machine() == machine && matches!(s, Slot::Observed(..)) == observed
                })
                .min_by_key(|(_, since)| **since)
                .map(|(s, _)| s.clone())
            else {
                return false;
            };
            lingering.remove(&oldest);
            self.take(&oldest)
        };
        if let Some(handle) = handle {
            handle.close();
        }
        true
    }

    /// Closes every lingering session that has lingered past the limit (shorter while the window is hidden).
    fn reap(&self, now: Instant) {
        let limit = if self.background.load(Ordering::Relaxed) {
            self.config.linger_background
        } else {
            self.config.linger
        };
        let closing: Vec<Closing> = {
            let mut lingering = self.lingering.lock();
            let expired: Vec<Slot> = lingering
                .iter()
                .filter(|(_, since)| now.saturating_duration_since(**since) >= limit)
                .map(|(s, _)| s.clone())
                .collect();
            expired
                .iter()
                .filter_map(|slot| {
                    lingering.remove(slot);
                    self.take(slot)
                })
                .collect()
        };
        for handle in closing {
            handle.close();
        }
    }

    /// Takes a session out of its table (call with `lingering` locked: that order, never the reverse).
    fn take(&self, slot: &Slot) -> Option<Closing> {
        match slot {
            Slot::Keeper(m, id) => self
                .attached
                .lock()
                .remove(&(m.clone(), id.clone()))
                .map(Closing::Keeper),
            Slot::Observed(m, pane) => self
                .observed
                .lock()
                .remove(&(m.clone(), pane.clone()))
                .map(Closing::Observed),
        }
    }
}

/// A session on its way out of the hub.
enum Closing {
    Keeper(SessionHandle),
    Observed(ObservedHandle),
}

impl Closing {
    /// Closes it on a thread of its own: closing joins the session's threads and waits for its ssh child.
    fn close(self) {
        let _ = std::thread::Builder::new()
            .name("herdr-reap".to_owned())
            .spawn(move || match self {
                Closing::Keeper(h) => h.detach(),
                Closing::Observed(h) => h.detach(),
            });
    }
}

impl Inner {
    /// Lists one machine, or every machine. A machine that does not answer shows no sessions (they would
    /// be stale); one without the script is left alone.
    fn poll(&self, only: Option<&str>) {
        let entries: Vec<(String, Arc<Entry>)> = self
            .entries
            .read()
            .iter()
            .filter(|(m, _)| only.is_none_or(|o| o == m.as_str()))
            .map(|(m, e)| (m.clone(), e.clone()))
            .collect();
        for (_, entry) in entries {
            if entry.not_installed.load(Ordering::Relaxed) && only.is_none() {
                continue;
            }
            match entry.host.list_if_installed() {
                Ok(all) => {
                    entry.not_installed.store(false, Ordering::Relaxed);
                    self.store_listing(&entry, Some(all));
                }
                Err(KeeperError::NotInstalled(_)) => {
                    entry.not_installed.store(true, Ordering::Relaxed);
                    self.store_listing(&entry, None);
                }
                Err(_) => self.store_listing(&entry, None),
            }
        }
    }

    fn rows(&self, now: Instant) -> Vec<SessionRow> {
        let entries: Vec<(String, Arc<Entry>)> = self
            .entries
            .read()
            .iter()
            .map(|(m, e)| (m.clone(), e.clone()))
            .collect();
        let attached = self.attached.lock().clone();
        let mut out = Vec::new();
        let mut episodes = self.episodes.lock();
        for (machine, entry) in entries {
            let Some(listing) = entry.listing.lock().clone() else {
                continue;
            };
            let first_sight = episodes.machines.insert(machine.clone());
            let mut present = HashSet::new();
            for info in listing.into_iter().filter(KeeperInfo::alive) {
                let live = attached
                    .get(&(machine.clone(), info.id.clone()))
                    .filter(|h| h.is_open())
                    .map(|h| h.snapshot());
                let (status, title) = match &live {
                    Some(s) if s.phase != SessionPhase::Connecting => (
                        match s.phase {
                            SessionPhase::BlockedOnPermission | SessionPhase::BlockedOnQuestion => {
                                AgentStatus::Blocked
                            }
                            SessionPhase::Working => AgentStatus::Working,
                            _ => AgentStatus::Idle,
                        },
                        s.title.clone().or(info.title.clone()),
                    ),
                    _ => (
                        if info.pending > 0 {
                            AgentStatus::Blocked
                        } else if info.turn_active || info.state == KeeperState::Starting {
                            AgentStatus::Working
                        } else {
                            AgentStatus::Idle
                        },
                        info.title.clone(),
                    ),
                };
                let key = (machine.clone(), info.id.clone());
                present.insert(info.id.clone());
                let since = match episodes.seen.get(&key) {
                    Some((s, since)) if *s == status => *since,
                    _ => {
                        let since = (!first_sight).then_some(now);
                        episodes.seen.insert(key, (status, since));
                        since
                    }
                };
                let name = title
                    .filter(|t| !t.trim().is_empty())
                    .map(|t| t.trim().to_owned())
                    .unwrap_or_else(|| {
                        let folder = folder_name(Some(&info.cwd));
                        if folder.is_empty() {
                            info.agent.clone()
                        } else {
                            folder
                        }
                    });
                out.push(SessionRow {
                    machine: machine.clone(),
                    id: info.id,
                    agent: info.agent,
                    name,
                    cwd: info.cwd,
                    status,
                    since,
                    last_message: live.as_ref().and_then(|s| last_agent_line(&s.items)),
                });
            }
            episodes
                .seen
                .retain(|(m, id), _| *m != machine || present.contains(id));
        }
        out.sort_by(|a, b| a.machine.cmp(&b.machine).then_with(|| a.id.cmp(&b.id)));
        out
    }
}

/// The first non-empty line of what the agent said last, cut to a line a card can show.
fn last_agent_line(items: &[Arc<super::types::Item>]) -> Option<String> {
    use super::types::{ItemKind, Role};
    let text = items.iter().rev().find_map(|item| match &item.kind {
        ItemKind::Message {
            role: Role::Agent,
            text,
            ..
        } if !text.trim().is_empty() => Some(text),
        _ => None,
    })?;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(160).collect())
}
