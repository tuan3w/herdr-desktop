//! The board: every agent on every machine, sorted into what needs the person, what is running,
//! what finished and awaits a look, and what is at rest.
//!
//! [`Board::from`] is a pure function of the machines' snapshots and states, the reviewed marks and
//! the dated episodes. Its [`Counts`] are the one source for the status line, the window title
//! (`(2) Herdr Desktop`), notifications and the triage walk, so they never disagree. The ordering
//! and naming rules are herdr-mobile's (`agents_grouping.dart`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::link::LinkState;
use crate::schema::{AgentInfo, AgentStatus, PaneInfo, Snapshot, clean_terminal_title};
use crate::store::{MachineId, ReviewKey, Reviewed};

/// How many idle agents the board shows; the rest fold behind [`Board::more_idle`]. Idle is
/// inventory, not a decision: a board with 27 of them buried everything else.
pub const IDLE_SHOWN: usize = 5;

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
}

impl AgentRow {
    /// Stable across refreshes: machine id and pane id.
    pub fn key(&self) -> String {
        format!("{}/{}", self.machine, self.pane_id)
    }

    /// The mark that makes this agent's finished state reviewed.
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
    /// Idle or unknown, all of them (the board shows [`IDLE_SHOWN`]).
    pub idle: usize,
    /// Agents whose machine is not connected (last known state listed, dimmed).
    pub offline: usize,
    /// Switched-on machines that are not connected: the status line's `1 not connected`.
    pub machines_not_connected: usize,
}

/// The board, top to bottom: `needs_you`, `to_review`, `working`, `idle`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Board {
    /// Longest waiting first; rows of machines that are not connected come last, dimmed.
    pub needs_you: Vec<AgentRow>,
    /// Finished and not reviewed, newest first; offline rows last.
    pub to_review: Vec<AgentRow>,
    pub working: Vec<AgentRow>,
    /// The newest [`IDLE_SHOWN`] idle (and unknown) agents.
    pub idle: Vec<AgentRow>,
    /// Idle agents beyond the ones shown.
    pub more_idle: usize,
    pub counts: Counts,
}

impl Board {
    /// Builds the board. Machines that are `Off` are left out entirely; every other machine that
    /// is not `Online` lists its last known agents as offline.
    pub fn from(
        machines: &[(MachineId, Arc<Snapshot>, LinkState)],
        reviewed: &Reviewed,
        first_seen: &FirstSeen,
        now: Instant,
    ) -> Board {
        let mut counts = Counts::default();
        let mut needs_you = Vec::new();
        let mut to_review = Vec::new();
        let mut working = Vec::new();
        let mut idle = Vec::new();
        let mut unknown = Vec::new();

        for (machine, snapshot, state) in machines {
            if *state == LinkState::Off {
                continue;
            }
            let offline = *state != LinkState::Online;
            if offline {
                counts.machines_not_connected += 1;
            }
            for agent in &snapshot.agents {
                let row = row_of(machine, snapshot, agent, offline, reviewed, first_seen);
                if offline {
                    counts.offline += 1;
                }
                match row.status {
                    AgentStatus::Blocked => {
                        counts.needs_you += usize::from(!offline);
                        needs_you.push(row);
                    }
                    AgentStatus::Done => {
                        counts.to_review += usize::from(!offline);
                        to_review.push(row);
                    }
                    AgentStatus::Working => {
                        counts.working += usize::from(!offline);
                        working.push(row);
                    }
                    AgentStatus::Idle => {
                        counts.idle += usize::from(!offline);
                        idle.push(row);
                    }
                    AgentStatus::Unknown => {
                        counts.idle += usize::from(!offline);
                        unknown.push(row);
                    }
                }
            }
        }

        needs_you.sort_by(|a, b| {
            a.offline
                .cmp(&b.offline)
                .then_with(|| longest_waiting(a, b))
        });
        for rows in [&mut to_review, &mut working, &mut idle] {
            rows.sort_by(|a, b| {
                a.offline
                    .cmp(&b.offline)
                    .then_with(|| newest_first(a, b, now))
            });
        }
        unknown.sort_by(|a, b| a.offline.cmp(&b.offline).then_with(|| by_place(a, b)));
        // Unknown has no state to date: it follows the idle rows, by place.
        idle.extend(unknown);
        let more_idle = idle.len().saturating_sub(IDLE_SHOWN);
        idle.truncate(IDLE_SHOWN);

        Board {
            needs_you,
            to_review,
            working,
            idle,
            more_idle,
            counts,
        }
    }

    /// Every agent that needs the person right now and can be answered: the triage walk's order.
    pub fn triage(&self) -> impl Iterator<Item = &AgentRow> {
        self.needs_you.iter().filter(|r| !r.offline)
    }
}

fn row_of(
    machine: &MachineId,
    snapshot: &Snapshot,
    agent: &AgentInfo,
    offline: bool,
    reviewed: &Reviewed,
    first_seen: &FirstSeen,
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
        name: name_of(agent, pane, &kind, cwd.as_deref()),
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
fn longest_waiting(a: &AgentRow, b: &AgentRow) -> std::cmp::Ordering {
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
fn newest_first(a: &AgentRow, b: &AgentRow, now: Instant) -> std::cmp::Ordering {
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
