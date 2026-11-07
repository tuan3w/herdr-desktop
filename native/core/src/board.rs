//! The board: every agent on every machine, grouped by the project it works in.
//!
//! [`Board::from`] is a pure function of the machines' snapshots and states, the sessions, the
//! reviewed marks, the pins and the dated episodes. State is not the layout (projects are, see
//! [`crate::project`]); it is what every row and every project header shows. Its [`Counts`] are the
//! one source for the status line, the window title (`(2) Herdr Desktop`), notifications and the
//! triage walk, so they never disagree. The naming rules are herdr-mobile's (`agents_grouping.dart`).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::link::LinkState;
use crate::observed::names::{PaneName, better_title};
use crate::project::{Checkout, Directory, Place, Project, checkouts_of, order_rows};
use crate::schema::{AgentInfo, AgentStatus, PaneInfo, Snapshot, clean_terminal_title};
use crate::store::{MachineId, ReviewKey, Reviewed};

/// What counts as recent: past it an agent's time is old news, and one with no known time is
/// placed above it.
const RECENT_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);

/// When each agent's current state episode was first seen. herdr gives no timestamps, so the app
/// dates an episode when it first sees it; an episode already there when a machine was first seen
/// has no date (`None`), because it may be minutes or months old.
#[derive(Debug, Default)]
pub struct FirstSeen {
    episodes: HashMap<(MachineId, String), Episode>,
    machines: HashSet<MachineId>,
}

#[derive(Debug)]
struct Episode {
    seq: u64,
    status: AgentStatus,
    since: Option<Instant>,
}

impl FirstSeen {
    /// An empty record.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records what a machine's snapshot shows, at `now`. Call it once per new snapshot. A new
    /// episode is a change of `state_change_seq` or of status; agents that left the snapshot are forgotten.
    pub fn observe(&mut self, machine: &str, snapshot: &Snapshot, now: Instant) {
        let first_sight = self.machines.insert(machine.to_owned());
        let mut present = HashSet::with_capacity(snapshot.agents.len());
        for agent in &snapshot.agents {
            present.insert(agent.pane_id.as_str());
            let key = (machine.to_owned(), agent.pane_id.clone());
            let same = self
                .episodes
                .get(&key)
                .is_some_and(|e| e.seq == agent.state_change_seq && e.status == agent.agent_status);
            if !same {
                self.episodes.insert(
                    key,
                    Episode {
                        seq: agent.state_change_seq,
                        status: agent.agent_status,
                        since: (!first_sight).then_some(now),
                    },
                );
            }
        }
        self.episodes
            .retain(|(m, pane), _| m != machine || present.contains(pane.as_str()));
    }

    /// Forgets a machine that was removed.
    pub fn forget_machine(&mut self, machine: &str) {
        self.machines.remove(machine);
        self.episodes.retain(|(m, _), _| m != machine);
    }

    fn since(&self, machine: &str, agent: &AgentInfo) -> Option<Instant> {
        let episode = self
            .episodes
            .get(&(machine.to_owned(), agent.pane_id.clone()))?;
        (episode.seq == agent.state_change_seq && episode.status == agent.agent_status)
            .then_some(episode.since)
            .flatten()
    }
}

/// One agent on the board.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRow {
    pub machine: MachineId,
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    /// The agent's kind as herdr shows it (`omp`, `claude`); empty when herdr names none.
    pub agent: String,
    /// What the person calls it: the pane's label, else the terminal title, else the folder.
    pub name: String,
    /// The status shown: a finished agent the person has reviewed is `Idle`.
    pub status: AgentStatus,
    /// When this state began, as far as known (see [`FirstSeen`]).
    pub since: Option<Instant>,
    /// Its machine is not connected: this is the last known state, dimmed and never counted as needing you.
    pub offline: bool,
    pub cwd: Option<String>,
    /// herdr's number for this state episode; with the machine and pane it names what "reviewed" refers to.
    pub state_change_seq: u64,
    /// A finished state the person has looked at (shown as `Idle`).
    pub reviewed: bool,
    /// A session of the keeper (ACP chat) rather than a terminal pane: `pane_id` is then the keeper's id
    /// and `workspace_id`, `tab_id` and `state_change_seq` are empty or zero.
    pub session: bool,
    /// The key of the [`Project`] this agent belongs to.
    pub project: String,
    /// The folder of the checkout it works in, when its project has checkouts (see [`Project::checkouts`]).
    pub checkout: Option<String>,
    /// For a session: the first line of what the agent said last, when known.
    pub last_message: Option<String>,
}

impl AgentRow {
    /// Stable across refreshes: machine id and pane id (for a session, `session:` and the keeper id).
    pub fn key(&self) -> String {
        if self.session {
            format!("{}/session:{}", self.machine, self.pane_id)
        } else {
            format!("{}/{}", self.machine, self.pane_id)
        }
    }

    /// The mark that makes this agent's finished state reviewed. A session is never `Done` (see
    /// [`SessionRow`]), so its mark is never made.
    pub fn review_key(&self) -> ReviewKey {
        ReviewKey::new(&self.machine, &self.pane_id, self.state_change_seq)
    }

    /// How long the agent has been in this state, if known.
    pub fn age(&self, now: Instant) -> Option<Duration> {
        self.since.map(|t| now.saturating_duration_since(t))
    }
}

/// The numbers every surface shows. Each agent is in exactly one of `needs_you`, `to_review`,
/// `working`, `idle`, `offline`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    /// Blocked on the person, machine connected.
    pub needs_you: usize,
    /// Finished and not reviewed, machine connected.
    pub to_review: usize,
    pub working: usize,
    /// Idle or unknown.
    pub idle: usize,
    /// Agents whose machine is not connected (last known state listed, dimmed).
    pub offline: usize,
    /// Switched-on machines that are not connected: the status line's `1 not connected`.
    pub machines_not_connected: usize,
}

/// The board: projects (pinned first, then by name), the two inboxes that notifications and the
/// triage walk read, and the counts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Board {
    /// Every project that has an agent, in a stable order (see [`Board::from`]).
    pub projects: Vec<Project>,
    /// Agents blocked on the person, longest waiting first; rows of machines that are not connected
    /// come last, dimmed. The triage walk and the `Needs you` strip.
    pub needs_you: Vec<AgentRow>,
    /// Finished and not reviewed, newest first; offline rows last. What `3 to review` selects and
    /// what `Also when an agent finishes` notifies about.
    pub to_review: Vec<AgentRow>,
    pub counts: Counts,
}

impl Board {
    /// Builds the board. Machines that are `Off` are left out entirely; every other machine that
    /// is not `Online` lists its last known agents as offline.
    ///
    /// Projects are ordered so that nothing moves under the pointer when agents change state:
    /// pinned ones first, then by name (case-insensitive), then machine and key. Only the person
    /// reorders them (a pin); counts and states never do. Within a project see [`order_rows`].
    pub fn from(
        machines: &[(MachineId, Arc<Snapshot>, LinkState)],
        extras: BoardExtras<'_>,
        reviewed: &Reviewed,
        first_seen: &FirstSeen,
        now: Instant,
    ) -> Board {
        let mut counts = Counts::default();
        let mut rows: Vec<(AgentRow, Place)> = Vec::new();
        let mut directories: HashMap<&MachineId, Directory> = HashMap::new();
        for (machine, snapshot, state) in machines {
            if *state == LinkState::Off {
                continue;
            }
            let offline = *state != LinkState::Online;
            if offline {
                counts.machines_not_connected += 1;
            }
            let directory = Directory::of(machine, snapshot);
            for agent in &snapshot.agents {
                let mut row = row_of(
                    machine,
                    snapshot,
                    agent,
                    offline,
                    reviewed,
                    first_seen,
                    extras.names,
                );
                let place = directory.place_of_agent(&agent.workspace_id, row.cwd.as_deref());
                row.project.clone_from(&place.key);
                row.checkout = place.checkout.as_ref().map(|c| c.path.clone());
                rows.push((row, place));
            }
            directories.insert(machine, directory);
        }
        // A session is an agent like any other to the person: the same projects and the same counts,
        // so a count never disagrees with the list it counts. Its machine's link decides `offline`.
        for session in extras.sessions {
            let Some((_, _, state)) = machines.iter().find(|(m, _, _)| *m == session.machine)
            else {
                continue;
            };
            let Some(directory) = directories.get(&session.machine) else {
                continue;
            };
            let place = directory.place_of_folder(Some(&session.cwd));
            let mut row = session_row(session, *state != LinkState::Online);
            row.project.clone_from(&place.key);
            row.checkout = place.checkout.as_ref().map(|c| c.path.clone());
            rows.push((row, place));
        }

        let mut needs_you = Vec::new();
        let mut to_review = Vec::new();
        let mut by_project: HashMap<String, (Place, Vec<AgentRow>, Vec<Checkout>)> = HashMap::new();
        for (row, place) in rows {
            if row.offline {
                counts.offline += 1;
            }
            let live = usize::from(!row.offline);
            match row.status {
                AgentStatus::Blocked => {
                    counts.needs_you += live;
                    needs_you.push(row.clone());
                }
                AgentStatus::Done => {
                    counts.to_review += live;
                    to_review.push(row.clone());
                }
                AgentStatus::Working => counts.working += live,
                AgentStatus::Idle | AgentStatus::Unknown => counts.idle += live,
            }
            let entry = by_project
                .entry(row.project.clone())
                .or_insert_with(|| (place.clone(), Vec::new(), Vec::new()));
            entry.2.extend(place.checkout);
            entry.1.push(row);
        }

        needs_you.sort_by(|a, b| {
            a.offline
                .cmp(&b.offline)
                .then_with(|| longest_waiting(a, b))
        });
        to_review.sort_by(|a, b| {
            a.offline
                .cmp(&b.offline)
                .then_with(|| newest_first(a, b, now))
        });

        let mut projects: Vec<Project> = by_project
            .into_iter()
            .map(|(key, (place, mut rows, checkouts))| {
                order_rows(&mut rows, now);
                let count = |status: AgentStatus| {
                    rows.iter()
                        .filter(|r| !r.offline && r.status == status)
                        .count()
                };
                Project {
                    pinned: extras.pins.contains(&key),
                    machine: rows[0].machine.clone(),
                    checkouts: checkouts_of(checkouts),
                    offline: rows.iter().any(|r| r.offline),
                    needs_you: count(AgentStatus::Blocked),
                    to_review: count(AgentStatus::Done),
                    working: count(AgentStatus::Working),
                    name: place.name,
                    key,
                    rows,
                }
            })
            .collect();
        projects.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.machine.cmp(&b.machine))
                .then_with(|| a.key.cmp(&b.key))
        });

        Board {
            projects,
            needs_you,
            to_review,
            counts,
        }
    }

    /// Every row, project by project in board order.
    pub fn rows(&self) -> impl Iterator<Item = &AgentRow> {
        self.projects.iter().flat_map(|p| p.rows.iter())
    }

    /// Every agent that needs the person right now and can be answered: the triage walk's order.
    pub fn triage(&self) -> impl Iterator<Item = &AgentRow> {
        self.needs_you.iter().filter(|r| !r.offline)
    }
}

/// What names panes besides herdr: the names the agents' own session logs give (shown only where the pane's
/// title says nothing), by machine and pane id.
pub type LogNames = BTreeMap<(MachineId, String), PaneName>;

/// What the board takes besides the machines' snapshots.
#[derive(Clone, Copy)]
pub struct BoardExtras<'a> {
    /// Agent sessions of the keepers, counted with the terminal agents.
    pub sessions: &'a [SessionRow],
    /// Names read from session logs.
    pub names: &'a LogNames,
    /// Keys of the projects the person pinned (see [`Project::key`]): they list first.
    pub pins: &'a BTreeSet<String>,
}

impl BoardExtras<'static> {
    /// Nothing besides herdr's own snapshots.
    pub const NONE: BoardExtras<'static> = BoardExtras {
        sessions: &[],
        names: &BTreeMap::new(),
        pins: &NO_PINS,
    };
}

static NO_PINS: BTreeSet<String> = BTreeSet::new();

/// An agent session of the keeper (an ACP chat), as the board needs it. Built by the session hub from
/// what the keepers report and what attached sessions know first-hand.
///
/// A session is `Blocked` while a request waits for the person, `Working` during a turn and `Idle`
/// otherwise; it is never `Done`: the keeper's `unseen_done` is for the phone (a viewer never clears
/// it), so showing it would leave a finished session in "to review" for good.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRow {
    pub machine: MachineId,
    /// The keeper's id.
    pub id: String,
    /// The agent's route id (`omp`).
    pub agent: String,
    /// What the person calls it: the agent's title, else the folder.
    pub name: String,
    pub cwd: String,
    /// `Blocked`, `Working` or `Idle`.
    pub status: AgentStatus,
    /// When this state began, as far as known.
    pub since: Option<Instant>,
    /// The first line of what the agent said last, when the session is open here and it has said something.
    pub last_message: Option<String>,
}

fn session_row(session: &SessionRow, offline: bool) -> AgentRow {
    AgentRow {
        machine: session.machine.clone(),
        pane_id: session.id.clone(),
        workspace_id: String::new(),
        tab_id: String::new(),
        agent: session.agent.clone(),
        name: session.name.clone(),
        status: session.status,
        since: session.since,
        offline,
        cwd: (!session.cwd.is_empty()).then(|| session.cwd.clone()),
        state_change_seq: 0,
        reviewed: false,
        session: true,
        project: String::new(),
        checkout: None,
        last_message: session.last_message.clone(),
    }
}

fn row_of(
    machine: &MachineId,
    snapshot: &Snapshot,
    agent: &AgentInfo,
    offline: bool,
    reviewed: &Reviewed,
    first_seen: &FirstSeen,
    log_names: &LogNames,
) -> AgentRow {
    let pane = snapshot.pane(&agent.pane_id);
    let is_reviewed = agent.agent_status == AgentStatus::Done
        && reviewed.is_reviewed(&ReviewKey::new(
            machine,
            &agent.pane_id,
            agent.state_change_seq,
        ));
    let kind = agent
        .display_agent
        .as_deref()
        .or(agent.agent.as_deref())
        .unwrap_or_default()
        .to_owned();
    let cwd = agent
        .cwd
        .clone()
        .or_else(|| pane.and_then(|p| p.cwd.clone()));
    AgentRow {
        machine: machine.clone(),
        pane_id: agent.pane_id.clone(),
        workspace_id: agent.workspace_id.clone(),
        tab_id: agent.tab_id.clone(),
        // The name the agent's own session log gives replaces a title that says nothing (only the folder).
        name: log_names
            .get(&(machine.clone(), agent.pane_id.clone()))
            .and_then(|n| {
                let workspace = snapshot
                    .workspace(&agent.workspace_id)
                    .map(|w| w.label.as_str());
                better_title(agent, pane, workspace, Some(n))
            })
            .unwrap_or_else(|| name_of(agent, pane, &kind, cwd.as_deref())),
        agent: kind,
        status: if is_reviewed {
            AgentStatus::Idle
        } else {
            agent.agent_status
        },
        since: first_seen.since(machine, agent),
        offline,
        cwd,
        state_change_seq: agent.state_change_seq,
        reviewed: is_reviewed,
        session: false,
        project: String::new(),
        checkout: None,
        last_message: None,
    }
}

/// The last part of a folder (`/src/payments-api` is `payments-api`); empty for none, `/` for the root.
pub fn folder_name(cwd: Option<&str>) -> String {
    match cwd {
        None | Some("") => String::new(),
        Some(path) => path
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or("/")
            .to_owned(),
    }
}

/// What an agent is called: the name the person gave the pane, else the agent's own name, else
/// the terminal title with agent chrome removed, else the folder, else its kind. A title that says
/// nothing (empty, `terminal`, the agent's own name) is skipped: omp titles a fresh pane `π > <folder>`
/// and a board of those would read as one name repeated.
fn name_of(agent: &AgentInfo, pane: Option<&PaneInfo>, kind: &str, cwd: Option<&str>) -> String {
    let given = |s: Option<&str>| {
        s.map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    if let Some(name) =
        given(pane.and_then(|p| p.label.as_deref())).or_else(|| given(agent.name.as_deref()))
    {
        return name;
    }
    let raw = agent
        .terminal_title_stripped
        .as_deref()
        .or(agent.terminal_title.as_deref())
        .or_else(|| {
            pane.and_then(|p| {
                p.terminal_title_stripped
                    .as_deref()
                    .or(p.terminal_title.as_deref())
            })
        });
    let title = raw.map(clean_terminal_title).unwrap_or_default();
    let generic = title.is_empty()
        || title.eq_ignore_ascii_case("terminal")
        || title.eq_ignore_ascii_case(kind);
    if !generic {
        return title;
    }
    let folder = folder_name(cwd);
    if !folder.is_empty() {
        return folder;
    }
    if kind.is_empty() {
        "Agent".to_owned()
    } else {
        kind.to_owned()
    }
}

fn by_place(a: &AgentRow, b: &AgentRow) -> std::cmp::Ordering {
    a.machine
        .cmp(&b.machine)
        .then_with(|| a.pane_id.cmp(&b.pane_id))
}

/// Dated before undated, the oldest first; ties by place.
pub(crate) fn longest_waiting(a: &AgentRow, b: &AgentRow) -> std::cmp::Ordering {
    match (a.since, b.since) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| by_place(a, b)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => by_place(a, b),
    }
}

/// Newest first in three groups: a state that began within [`RECENT_WINDOW`] (newest first), then
/// those with no known time, then those that began longer ago (newest first). An agent with no
/// date was in its state before the app first looked, and may be 3 minutes old or 3 months; it
/// sits between "known recent" and "known old". Ties by place.
pub(crate) fn newest_first(a: &AgentRow, b: &AgentRow, now: Instant) -> std::cmp::Ordering {
    let bucket = |t: Option<Instant>| match t {
        None => 1,
        Some(t) if now.saturating_duration_since(t) < RECENT_WINDOW => 0,
        Some(_) => 2,
    };
    bucket(a.since)
        .cmp(&bucket(b.since))
        .then_with(|| match (a.since, b.since) {
            (Some(x), Some(y)) => y.cmp(&x),
            _ => std::cmp::Ordering::Equal,
        })
        .then_with(|| by_place(a, b))
}
