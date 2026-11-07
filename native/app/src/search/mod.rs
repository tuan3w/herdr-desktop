//! The `Search` module: the command palette's ranking, called from TSX.
//!
//! `open` freezes what is searched (the board, the machines, the commands TSX registers, the recents) into a
//! [`herdr_core::search::Catalog`]; `query` ranks against that frozen copy and `close` drops it. Rows never reorder while
//! the palette is open: only what a row says about itself changes, and TSX reads that live. A query is a synchronous pure
//! read (it touches no signal), as `Herdr.board` is. The ranking itself, the fold and the empty state are
//! `herdr_core::search`, tested without a window; this file is the door.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use herdr_core::search::{
    AgentSrc, Catalog, CommandKind, CommandSrc, Focus, MachineSrc, ProjectSrc, Query, Scope,
    Sources, Status, Suggest, View, utf16_pairs,
};
use nsh_core::prelude::*;
use parking_lot::Mutex;

use crate::api::{AgentState, BoardData, Herdr, LinkStateName, engine};

/// Palettes kept at once: one is open, a second can be while the first is closing.
const KEPT: usize = 4;

static NEXT: AtomicU32 = AtomicU32::new(1);
static SESSIONS: Mutex<Vec<(u32, Arc<Session>)>> = Mutex::new(Vec::new());

struct Session {
    catalog: Catalog,
    focus: Focus,
}

/// What a command is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum SpecKind {
    /// Something to run.
    Command,
    /// A setting to open or flip.
    Setting,
    /// A theme to switch to.
    Theme,
}

/// When a command is suggested on the empty palette.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum SuggestWhen {
    /// Among the first suggestions.
    Always,
    /// First of all, while an agent needs the person.
    NeedsYou,
}

/// A command the palette can run. The app owns what running it does; here it is only found.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct CommandSpec {
    /// What `runAction` takes. Unique.
    pub id: String,
    /// What the row says: also matched, and what a screen reader says.
    pub label: String,
    /// The muted word beside it (`Go`, `Pane`, `Look`).
    pub group: String,
    /// Other words that find it.
    #[prop(default)]
    pub keywords: Vec<String>,
    /// Natural phrases that find it (`new session`, `mark done`), shown as `Title (phrase)` when one won.
    #[prop(default)]
    pub verbs: Vec<String>,
    /// A command, a setting or a theme.
    pub kind: SpecKind,
    /// It cannot run now: it still matches and lists last.
    #[prop(default)]
    pub disabled: bool,
    /// Whether the empty palette suggests it.
    #[prop(skip_none)]
    pub suggest: Option<SuggestWhen>,
}

/// Where the person is, for the ranking and the empty state.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct SearchFocus {
    /// The agent in front (`BoardRow.key`): the empty palette does not offer it again unless it needs you.
    #[prop(skip_none)]
    pub row: Option<String>,
    /// Its project (`BoardProject.key`): its agents and the project rank higher.
    #[prop(skip_none)]
    pub project: Option<String>,
    /// Its machine: rows on it rank a little higher.
    #[prop(skip_none)]
    pub machine: Option<String>,
}

/// What a scope searches (`All`: everything; the others are the prefixes `@ # > "`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ScopeName {
    /// Agents, projects, commands, machines, settings, themes and up to three message lines.
    All,
    /// Chats and terminal agents.
    Agents,
    /// Projects.
    Projects,
    /// Commands, settings, themes and machines.
    Commands,
    /// Lines of the last message and the last rows of a pane.
    Messages,
}

impl From<ScopeName> for Scope {
    fn from(scope: ScopeName) -> Self {
        match scope {
            ScopeName::All => Self::All,
            ScopeName::Agents => Self::Agents,
            ScopeName::Projects => Self::Projects,
            ScopeName::Commands => Self::Commands,
            ScopeName::Messages => Self::Messages,
        }
    }
}

/// One query.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct SearchRequest {
    /// As typed, without the scope's prefix character. May hold `on:<machine>`, `in:<project>`, `is:<state>`.
    pub query: String,
    /// What to search.
    pub scope: ScopeName,
    /// At most this many rows (the palette asks for 50; browsing one scope for 200).
    pub limit: u32,
}

/// What a result is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum HitKind {
    /// A chat or a terminal agent.
    Agent,
    /// A project.
    Project,
    /// A command of the app.
    Command,
    /// A machine.
    Machine,
    /// A setting.
    Setting,
    /// A theme.
    Theme,
    /// A line of what an agent said or showed.
    Message,
}

/// The view an agent opens in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum HitView {
    /// The chat.
    Chat,
    /// The terminal mirror.
    Terminal,
}

/// One row of the palette.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct SearchHit {
    /// Unique across kinds: `agent:<BoardRow.key>`, `project:<key>`, `command:<id>`, `machine:<id>`, `setting:<id>`,
    /// `theme:<id>`, `message:<BoardRow.key>#<n>`.
    pub id: String,
    /// What it is.
    pub kind: HitKind,
    /// What the app opens or runs: the row key, the project key, the command id, the machine id.
    pub target: String,
    /// The row's name (for a message, the line).
    pub title: String,
    /// The synonym that found it when the title did not: the row says `Title (alias)`.
    #[prop(skip_none)]
    pub alias: Option<String>,
    /// The muted line, in order: project, checkout and machine for an agent; the group of a command.
    pub parts: Vec<String>,
    /// The matched letters of `title`: pairs `[start, end)` as indices into the JS string, flattened.
    pub marks: Vec<u32>,
    /// An agent's state when the palette opened (the row reads the live one from the board).
    #[prop(skip_none)]
    pub state: Option<AgentState>,
    /// Which view an agent opens in.
    #[prop(skip_none)]
    pub view: Option<HitView>,
    /// The empty palette's section this row is under; unset for a typed query.
    #[prop(skip_none)]
    pub group: Option<String>,
}

/// The answer to a query.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct SearchPage {
    /// Best first, at most `limit`.
    pub hits: Vec<SearchHit>,
    /// Matches in all.
    pub total: u32,
    /// The filters in the query that were understood (`on:gpu`).
    pub filters: Vec<String>,
    /// The rows are the empty palette's sections, not matches.
    pub sections: bool,
    /// Microseconds the ranking took.
    pub took_us: u32,
}

#[module]
impl Search {
    /// Freezes what a palette searches: the board, the machines, the recents and `commands`. Returns the session to
    /// pass to `query` and `close`. Throws when the engine is not running.
    pub fn open(commands: Vec<CommandSpec>, focus: SearchFocus) -> Result<u32, String> {
        let engine = engine()?;
        let board = Herdr::board()?;
        let machines = Herdr::machine_statuses()?;
        let several = engine.machines().iter().filter(|m| m.enabled).count() > 1;
        let visits = engine.recent_entries();
        let (agents, projects) = board_sources(&board);
        let machines: Vec<MachineSrc> = machines
            .iter()
            .map(|m| MachineSrc {
                id: m.id.clone(),
                name: m.name.clone(),
                state: link_words(m.state).to_owned(),
            })
            .collect();
        let commands: Vec<CommandSrc> = commands.into_iter().map(Into::into).collect();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let focus_row = focus.row;
        let focus = Focus {
            project: focus.project,
            machine: focus.machine,
        };
        let catalog = Catalog::new(&Sources {
            agents: &agents,
            projects: &projects,
            machines: &machines,
            commands: &commands,
            visits: &visits,
            now_ms,
            several_machines: several,
            here: focus_row.as_deref(),
            focus: focus.clone(),
        });
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let mut sessions = SESSIONS.lock();
        sessions.push((id, Arc::new(Session { catalog, focus })));
        let extra = sessions.len().saturating_sub(KEPT);
        sessions.drain(..extra);
        Ok(id)
    }

    /// Ranks the frozen catalog of `session` for `request`: the same query always gives the same rows in the same
    /// order. An empty query on `all` is the empty palette's sections (what needs you, pinned, recent, projects,
    /// suggested); on one scope it browses that scope, the most urgent first.
    pub fn query(session: u32, request: SearchRequest) -> Result<SearchPage, String> {
        let session = SESSIONS
            .lock()
            .iter()
            .find(|(id, _)| *id == session)
            .map(|(_, s)| s.clone())
            .ok_or_else(|| "the palette is closed".to_owned())?;
        let started = Instant::now();
        let answer = session.catalog.answer(
            &Query {
                text: request.query,
                scope: request.scope.into(),
                limit: request.limit as usize,
            },
            &session.focus,
        );
        let entries = session.catalog.entries();
        let hits = answer
            .rows
            .into_iter()
            .map(|row| {
                let e = &entries[row.entry];
                SearchHit {
                    id: e.id.clone(),
                    kind: e.kind.into(),
                    target: e.target.clone(),
                    title: e.title.clone(),
                    alias: row.alias,
                    parts: e.parts.clone(),
                    marks: utf16_pairs(&e.title, &row.marks),
                    state: e.state.map(Into::into),
                    view: e.view.map(Into::into),
                    group: row.group.map(str::to_owned),
                }
            })
            .collect();
        Ok(SearchPage {
            hits,
            total: answer.total as u32,
            filters: answer.filters,
            sections: answer.sections,
            took_us: started.elapsed().as_micros().min(u128::from(u32::MAX)) as u32,
        })
    }

    /// Drops what `open` froze. Closing twice, or a session that never was, does nothing.
    pub fn close(session: u32) {
        SESSIONS.lock().retain(|(id, _)| *id != session);
    }
}

/// The command palette's search: `open` once when the palette opens, `query` on every keystroke, `close` when it
/// closes. What a query ranks against is frozen at `open`, so rows never move while the palette is open.
#[module]
pub struct Search;

impl From<herdr_core::search::Kind> for HitKind {
    fn from(kind: herdr_core::search::Kind) -> Self {
        use herdr_core::search::Kind as K;
        match kind {
            K::Agent => Self::Agent,
            K::Project => Self::Project,
            K::Command => Self::Command,
            K::Machine => Self::Machine,
            K::Setting => Self::Setting,
            K::Theme => Self::Theme,
            // Files are found by `Files.search`, never by this catalog; they would be a row of their own kind.
            K::Message | K::File => Self::Message,
        }
    }
}

impl From<View> for HitView {
    fn from(view: View) -> Self {
        match view {
            View::Chat => Self::Chat,
            View::Terminal => Self::Terminal,
        }
    }
}

impl From<Status> for AgentState {
    fn from(status: Status) -> Self {
        match status {
            Status::Blocked => Self::Blocked,
            Status::Done => Self::Done,
            Status::Working => Self::Working,
            Status::Idle => Self::Idle,
            Status::Unknown => Self::Unknown,
        }
    }
}

impl From<AgentState> for Status {
    fn from(state: AgentState) -> Self {
        match state {
            AgentState::Blocked => Self::Blocked,
            AgentState::Done => Self::Done,
            AgentState::Working => Self::Working,
            AgentState::Idle => Self::Idle,
            AgentState::Unknown => Self::Unknown,
        }
    }
}

impl From<CommandSpec> for CommandSrc {
    fn from(c: CommandSpec) -> Self {
        Self {
            id: c.id,
            label: c.label,
            group: c.group,
            keywords: c.keywords,
            verbs: c.verbs,
            kind: match c.kind {
                SpecKind::Command => CommandKind::Command,
                SpecKind::Setting => CommandKind::Setting,
                SpecKind::Theme => CommandKind::Theme,
            },
            disabled: c.disabled,
            suggest: c.suggest.map(|s| match s {
                SuggestWhen::Always => Suggest::Always,
                SuggestWhen::NeedsYou => Suggest::NeedsYou,
            }),
        }
    }
}

/// The words for a link, in a machine row.
fn link_words(state: LinkStateName) -> &'static str {
    match state {
        LinkStateName::Connecting => "connecting",
        LinkStateName::Online => "connected",
        LinkStateName::Offline => "not connected",
        LinkStateName::Attention => "needs attention",
        LinkStateName::Off => "switched off",
    }
}

fn board_sources(board: &BoardData) -> (Vec<AgentSrc>, Vec<ProjectSrc>) {
    let mut agents = Vec::new();
    let mut projects = Vec::new();
    for p in &board.projects {
        projects.push(ProjectSrc {
            key: p.key.clone(),
            name: p.name.clone(),
            machine: p.machine.clone(),
            machine_name: p.machine_name.clone(),
            pinned: p.pinned,
            checkouts: p.checkouts.iter().map(|c| c.name.clone()).collect(),
            agents: p.rows.len(),
            needs_you: p.needs_you,
            to_review: p.to_review,
        });
        for r in &p.rows {
            // A checkout is named only where there are several: with one it is the project.
            let checkout = (p.checkouts.len() > 1)
                .then(|| {
                    p.checkouts
                        .iter()
                        .find(|c| Some(&c.path) == r.checkout.as_ref())
                })
                .flatten()
                .map(|c| c.name.clone());
            agents.push(AgentSrc {
                key: r.key.clone(),
                name: r.name.clone(),
                project_key: p.key.clone(),
                project_name: p.name.clone(),
                checkout,
                folder: r
                    .cwd
                    .as_deref()
                    .and_then(|c| c.trim_end_matches('/').rsplit('/').next())
                    .filter(|f| !f.is_empty())
                    .map(str::to_owned),
                machine: r.machine.clone(),
                machine_name: r.machine_name.clone(),
                kind: r.agent.clone(),
                chat: r.session,
                status: r.status.into(),
                reviewed: r.reviewed,
                offline: r.offline,
                since_secs: r.since_secs,
                last_message: r.last_message.clone(),
                preview: r.preview.clone(),
            });
        }
    }
    (agents, projects)
}
