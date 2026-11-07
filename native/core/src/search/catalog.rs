//! The catalog: what the palette searches, made once when it opens from a frozen copy of the board, the machines, the
//! commands and the recents, and what each kind of query asks of it.
//!
//! Three kinds of answer share one list type. A typed query is ranked by the [`Index`]. An empty query on `All` is the
//! sections of the empty state (what needs you, pinned, recent, projects, suggested), fixed at open. An empty query on one
//! scope browses that scope in a sensible order. None of them changes while the palette is open: the order is the
//! catalog's, and only what a row says about itself (its shape, its age) is read live by whoever draws it.

use std::collections::{HashMap, HashSet};

use super::frecency::{boost, frecency, half_life_days};
use super::index::{Field, Index, Item, Mode, Request};
use super::{Focus, Kind, KindSet};
use crate::recents::Entry as Visit;

/// What an agent is doing, as the palette needs to know it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Blocked,
    Done,
    Working,
    Idle,
    Unknown,
}

/// Which view an agent opens in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    Chat,
    Terminal,
}

/// An agent of the board (a chat or a terminal), flattened to what search reads.
#[derive(Debug, Clone)]
pub struct AgentSrc {
    /// `BoardRow.key`.
    pub key: String,
    pub name: String,
    pub project_key: String,
    pub project_name: String,
    /// The checkout's name, set only when the project has several (a name that tells worktrees apart).
    pub checkout: Option<String>,
    /// The last folder of its cwd.
    pub folder: Option<String>,
    pub machine: String,
    pub machine_name: String,
    /// The agent kind: `omp`, `claude`.
    pub kind: String,
    pub chat: bool,
    pub status: Status,
    pub reviewed: bool,
    pub offline: bool,
    pub since_secs: Option<u64>,
    pub last_message: Option<String>,
    /// The last rows of its pane, oldest first.
    pub preview: Vec<String>,
}

/// A project of the board.
#[derive(Debug, Clone)]
pub struct ProjectSrc {
    pub key: String,
    pub name: String,
    pub machine: String,
    pub machine_name: String,
    pub pinned: bool,
    pub checkouts: Vec<String>,
    pub agents: usize,
    pub needs_you: usize,
    pub to_review: usize,
}

/// A machine and how its link is, in words.
#[derive(Debug, Clone)]
pub struct MachineSrc {
    pub id: String,
    pub name: String,
    pub state: String,
}

/// What a registered command is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Command,
    Setting,
    Theme,
}

/// When a command is suggested on the empty state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Suggest {
    /// Among the first suggestions whatever the person did before.
    Always,
    /// First of all, while some agent needs the person.
    NeedsYou,
}

/// A command of the app: registered when the palette opens, run by the app by its id.
#[derive(Debug, Clone)]
pub struct CommandSrc {
    pub id: String,
    pub label: String,
    pub group: String,
    pub keywords: Vec<String>,
    pub verbs: Vec<String>,
    pub kind: CommandKind,
    pub disabled: bool,
    pub suggest: Option<Suggest>,
}

/// Everything the catalog is made from.
pub struct Sources<'a> {
    pub agents: &'a [AgentSrc],
    pub projects: &'a [ProjectSrc],
    pub machines: &'a [MachineSrc],
    pub commands: &'a [CommandSrc],
    pub visits: &'a [Visit],
    pub now_ms: u64,
    /// More than one machine: only then is a machine named in a row.
    pub several_machines: bool,
    /// The agent in front (`BoardRow.key`) and where it is.
    pub here: Option<&'a str>,
    pub focus: Focus,
}

/// What can be listed.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// Unique across kinds: `agent:<row key>`, `project:<key>`, `command:<id>`, `machine:<id>`, `setting:<id>`,
    /// `theme:<id>`, `message:<row key>#<n>`.
    pub id: String,
    pub kind: Kind,
    /// What the app opens or runs: the row key, the project key, the command id.
    pub target: String,
    pub title: String,
    /// The muted line, in order: project, checkout, machine for an agent.
    pub parts: Vec<String>,
    pub state: Option<Status>,
    pub view: Option<View>,
    /// Synonyms, as written (`Title (alias)` shows the one that won).
    pub aliases: Vec<String>,
    /// For the browse order and the empty state: smaller is more urgent.
    attention: u8,
    frecency: f64,
    since_secs: u64,
}

/// What a scope searches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    All,
    Agents,
    Projects,
    Commands,
    Messages,
}

impl Scope {
    fn kinds(self) -> KindSet {
        match self {
            Self::All => KindSet::of(&[
                Kind::Agent,
                Kind::Project,
                Kind::Command,
                Kind::Machine,
                Kind::Setting,
                Kind::Theme,
                Kind::Message,
            ]),
            Self::Agents => KindSet::of(&[Kind::Agent]),
            Self::Projects => KindSet::of(&[Kind::Project]),
            Self::Commands => {
                KindSet::of(&[Kind::Command, Kind::Setting, Kind::Theme, Kind::Machine])
            }
            Self::Messages => KindSet::of(&[Kind::Message]),
        }
    }
}

/// One row of an answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// Index into [`Catalog::entries`].
    pub entry: usize,
    /// The section heading, set only on an empty query.
    pub group: Option<&'static str>,
    /// Runs `[start, end)` of characters of the title that matched.
    pub marks: Vec<(u32, u32)>,
    /// The synonym that won, when the title did not.
    pub alias: Option<String>,
}

/// An answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub rows: Vec<Row>,
    /// Matches in all, before the limit.
    pub total: usize,
    /// The filters (`on:gpu`) the query held and the catalog understood.
    pub filters: Vec<String>,
    /// The rows are the empty state's sections, not matches.
    pub sections: bool,
}

/// A query.
#[derive(Debug, Clone)]
pub struct Query {
    pub text: String,
    pub scope: Scope,
    pub limit: usize,
}

/// Messages shown on `All`: a taste of the scope, never most of the list.
const MESSAGES_ON_ALL: usize = 3;

/// Longest line of a message hit, in characters.
const LINE_CHARS: usize = 160;

pub struct Catalog {
    entries: Vec<Entry>,
    index: Index,
    /// The empty state: section heading and the entries in it.
    sections: Vec<(&'static str, Vec<usize>)>,
}

impl Catalog {
    pub fn new(src: &Sources) -> Self {
        let visits: HashMap<&str, &Visit> =
            src.visits.iter().map(|v| (v.key.as_str(), v)).collect();
        let freq = |key: &str, kind: Kind| {
            visits
                .get(key)
                .map_or(0.0, |v| frecency(v, src.now_ms, half_life_days(kind)))
        };
        let mut entries = Vec::new();
        let mut items = Vec::new();
        let mut add = |entry: Entry, item: Item| {
            entries.push(entry);
            items.push(item);
        };

        let projects_by_key: HashMap<&str, &ProjectSrc> =
            src.projects.iter().map(|p| (p.key.as_str(), p)).collect();
        for a in src.agents {
            let id = format!("agent:{}", a.key);
            let f = freq(&id, Kind::Agent);
            let mut parts = vec![a.project_name.clone()];
            parts.extend(a.checkout.clone());
            if src.several_machines {
                parts.push(a.machine_name.clone());
            }
            let mut fields = vec![Field::name(a.project_name.clone(), 0.6)];
            fields.extend(a.checkout.iter().map(|c| Field::name(c.clone(), 0.5)));
            fields.extend(a.folder.iter().map(|c| Field::name(c.clone(), 0.4)));
            fields.push(Field::name(a.machine_name.clone(), 0.4));
            fields.push(Field::name(a.kind.clone(), 0.3));
            fields.extend(a.last_message.iter().map(|m| Field::text(m.clone(), 0.2)));
            let mut tags = vec![if a.chat { "chat" } else { "terminal" }];
            tags.push(match (a.status, a.reviewed, a.offline) {
                (_, _, true) | (Status::Idle | Status::Unknown, _, _) => "idle",
                (Status::Blocked, _, _) => "needs",
                (Status::Done, false, _) => "review",
                (Status::Done, true, _) => "idle",
                (Status::Working, _, _) => "working",
            });
            if projects_by_key
                .get(a.project_key.as_str())
                .is_some_and(|p| p.pinned)
            {
                tags.push("pinned");
            }
            add(
                Entry {
                    id,
                    kind: Kind::Agent,
                    target: a.key.clone(),
                    title: a.name.clone(),
                    parts,
                    state: Some(a.status),
                    view: Some(if a.chat { View::Chat } else { View::Terminal }),
                    aliases: Vec::new(),
                    attention: attention(a),
                    frecency: f,
                    since_secs: a.since_secs.unwrap_or(0),
                },
                Item {
                    kind: Kind::Agent,
                    title: a.name.clone(),
                    title_mode: Mode::Name,
                    fields,
                    aliases: Vec::new(),
                    frecency: f,
                    project: Some(a.project_key.clone()),
                    machine: Some(a.machine.clone()),
                    machine_name: a.machine_name.clone(),
                    project_name: a.project_name.clone(),
                    tags,
                    disabled: false,
                },
            );
        }

        for p in src.projects {
            let id = format!("project:{}", p.key);
            let f = freq(&id, Kind::Project);
            let mut parts = vec![count(p.agents, "agent")];
            if p.needs_you > 0 {
                parts.push(format!(
                    "{} need{} you",
                    p.needs_you,
                    if p.needs_you == 1 { "s" } else { "" }
                ));
            }
            if src.several_machines {
                parts.push(p.machine_name.clone());
            }
            let mut tags = Vec::new();
            if p.pinned {
                tags.push("pinned");
            }
            if p.needs_you > 0 {
                tags.push("needs");
            }
            if p.to_review > 0 {
                tags.push("review");
            }
            add(
                Entry {
                    id,
                    kind: Kind::Project,
                    target: p.key.clone(),
                    title: p.name.clone(),
                    parts,
                    state: None,
                    view: None,
                    aliases: Vec::new(),
                    attention: if p.needs_you > 0 { 0 } else { 3 },
                    frecency: f,
                    since_secs: 0,
                },
                Item {
                    kind: Kind::Project,
                    title: p.name.clone(),
                    title_mode: Mode::Name,
                    fields: p
                        .checkouts
                        .iter()
                        .map(|c| Field::name(c.clone(), 0.5))
                        .chain([Field::name(p.machine_name.clone(), 0.4)])
                        .collect(),
                    aliases: Vec::new(),
                    frecency: f,
                    project: Some(p.key.clone()),
                    machine: Some(p.machine.clone()),
                    machine_name: p.machine_name.clone(),
                    project_name: p.name.clone(),
                    tags,
                    disabled: false,
                },
            );
        }

        for m in src.machines {
            let id = format!("machine:{}", m.id);
            let f = freq(&id, Kind::Machine);
            add(
                Entry {
                    id,
                    kind: Kind::Machine,
                    target: m.id.clone(),
                    title: m.name.clone(),
                    parts: vec![m.state.clone()],
                    state: None,
                    view: None,
                    aliases: Vec::new(),
                    attention: 3,
                    frecency: f,
                    since_secs: 0,
                },
                Item {
                    kind: Kind::Machine,
                    title: m.name.clone(),
                    title_mode: Mode::Name,
                    fields: vec![Field::name("machine computer ssh connect", 0.3)],
                    aliases: Vec::new(),
                    frecency: f,
                    project: None,
                    machine: Some(m.id.clone()),
                    machine_name: m.name.clone(),
                    project_name: String::new(),
                    tags: Vec::new(),
                    disabled: false,
                },
            );
        }

        for c in src.commands {
            let (kind, prefix) = match c.kind {
                CommandKind::Command => (Kind::Command, "command"),
                CommandKind::Setting => (Kind::Setting, "setting"),
                CommandKind::Theme => (Kind::Theme, "theme"),
            };
            // Visits are kept under one key per command, whatever it is (`Herdr.visit("command:<id>")`).
            let f = freq(&format!("command:{}", c.id), kind);
            let aliases: Vec<String> = c.verbs.iter().chain(&c.keywords).cloned().collect();
            add(
                Entry {
                    id: format!("{prefix}:{}", c.id),
                    kind,
                    target: c.id.clone(),
                    title: c.label.clone(),
                    parts: vec![c.group.clone()],
                    state: None,
                    view: None,
                    aliases: aliases.clone(),
                    attention: u8::from(c.disabled) + 3,
                    frecency: f,
                    since_secs: 0,
                },
                Item {
                    kind,
                    title: c.label.clone(),
                    title_mode: Mode::Name,
                    fields: vec![Field::name(c.group.clone(), 0.2)],
                    aliases,
                    frecency: f,
                    project: None,
                    machine: None,
                    machine_name: String::new(),
                    project_name: String::new(),
                    tags: Vec::new(),
                    disabled: c.disabled,
                },
            );
        }

        for a in src.agents {
            let mut seen = HashSet::new();
            let lines: Vec<String> = a
                .last_message
                .iter()
                .map(String::as_str)
                .chain(a.preview.iter().map(String::as_str))
                .filter_map(line)
                .filter(|l| seen.insert(l.clone()))
                .collect();
            for (n, text) in lines.into_iter().enumerate() {
                let mut parts = vec![a.name.clone(), a.project_name.clone()];
                parts.dedup();
                add(
                    Entry {
                        id: format!("message:{}#{n}", a.key),
                        kind: Kind::Message,
                        target: a.key.clone(),
                        title: text.clone(),
                        parts,
                        state: Some(a.status),
                        view: Some(if a.chat { View::Chat } else { View::Terminal }),
                        aliases: Vec::new(),
                        attention: 3,
                        frecency: 0.0,
                        since_secs: 0,
                    },
                    Item {
                        kind: Kind::Message,
                        title: text,
                        title_mode: Mode::Text,
                        fields: Vec::new(),
                        aliases: Vec::new(),
                        frecency: 0.0,
                        project: Some(a.project_key.clone()),
                        machine: Some(a.machine.clone()),
                        machine_name: a.machine_name.clone(),
                        project_name: a.project_name.clone(),
                        tags: Vec::new(),
                        disabled: false,
                    },
                );
            }
        }

        let sections = sections(src, &entries);
        Self {
            index: Index::new(&items),
            entries,
            sections,
        }
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn answer(&self, q: &Query, focus: &Focus) -> Answer {
        if q.text.trim().is_empty() {
            return match q.scope {
                Scope::All => self.empty_state(q.limit),
                scope => self.browse(scope, q.limit),
            };
        }
        let req = Request {
            query: q.text.clone(),
            kinds: q.scope.kinds(),
            focus: focus.clone(),
            limit: q.limit,
            caps: if q.scope == Scope::All {
                vec![(Kind::Message, MESSAGES_ON_ALL)]
            } else {
                Vec::new()
            },
        };
        let page = self.index.search(&req);
        let rows = page
            .hits
            .iter()
            .map(|h| Row {
                entry: h.item,
                group: None,
                marks: h.marks.clone(),
                alias: h
                    .alias
                    .and_then(|a| self.entries[h.item].aliases.get(a).cloned()),
            })
            .collect();
        Answer {
            rows,
            total: page.total,
            filters: page.filters,
            sections: false,
        }
    }

    fn empty_state(&self, limit: usize) -> Answer {
        let rows: Vec<Row> = self
            .sections
            .iter()
            .flat_map(|(group, entries)| {
                entries.iter().map(|&entry| Row {
                    entry,
                    group: Some(*group),
                    marks: Vec::new(),
                    alias: None,
                })
            })
            .take(limit)
            .collect();
        Answer {
            total: rows.len(),
            rows,
            filters: Vec::new(),
            sections: true,
        }
    }

    /// Everything of a scope, the most urgent first, then the most used, then as given.
    fn browse(&self, scope: Scope, limit: usize) -> Answer {
        let kinds = scope.kinds();
        let mut at: Vec<usize> = (0..self.entries.len())
            .filter(|&i| kinds.has(self.entries[i].kind))
            .collect();
        // Among the agents that need you, the one waiting longest is first; otherwise the most used.
        let waited = |e: &Entry| std::cmp::Reverse(if e.attention == 0 { e.since_secs } else { 0 });
        at.sort_by(|&a, &b| {
            let (ea, eb) = (&self.entries[a], &self.entries[b]);
            ea.attention
                .cmp(&eb.attention)
                .then(waited(ea).cmp(&waited(eb)))
                .then(boost(eb.frecency).total_cmp(&boost(ea.frecency)))
                .then(a.cmp(&b))
        });
        let total = at.len();
        let rows = at
            .into_iter()
            .take(limit)
            .map(|entry| Row {
                entry,
                group: None,
                marks: Vec::new(),
                alias: None,
            })
            .collect();
        Answer {
            rows,
            total,
            filters: Vec::new(),
            sections: false,
        }
    }
}

/// The empty state: what needs the person, pinned projects, what was visited, projects, a few commands.
fn sections(src: &Sources, entries: &[Entry]) -> Vec<(&'static str, Vec<usize>)> {
    let by_id: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), i))
        .collect();
    let mut shown: HashSet<usize> = HashSet::new();
    let mut out: Vec<(&'static str, Vec<usize>)> = Vec::new();
    let mut section = |heading: &'static str, rows: Vec<usize>, shown: &mut HashSet<usize>| {
        let rows: Vec<usize> = rows.into_iter().filter(|r| shown.insert(*r)).collect();
        if !rows.is_empty() {
            out.push((heading, rows));
        }
    };

    // Needs you: longest waiting first; offline machines do not count, as they do not anywhere else.
    let mut needs: Vec<&AgentSrc> = src
        .agents
        .iter()
        .filter(|a| a.status == Status::Blocked && !a.offline)
        .collect();
    needs.sort_by_key(|a| std::cmp::Reverse(a.since_secs.unwrap_or(0)));
    let any_needs = !needs.is_empty();
    section(
        "Needs you",
        needs
            .iter()
            .filter_map(|a| by_id.get(format!("agent:{}", a.key).as_str()).copied())
            .take(3)
            .collect(),
        &mut shown,
    );

    section(
        "Pinned",
        src.projects
            .iter()
            .filter(|p| p.pinned)
            .filter_map(|p| by_id.get(format!("project:{}", p.key).as_str()).copied())
            .take(3)
            .collect(),
        &mut shown,
    );

    // Recent: the agents visited, newest first. The one in front is where you are, unless it needs you.
    let visited_agents: Vec<usize> = src
        .visits
        .iter()
        .filter(|v| v.key.starts_with("agent:"))
        .filter_map(|v| by_id.get(v.key.as_str()).copied())
        .filter(|&i| {
            let e = &entries[i];
            src.here != Some(e.target.as_str()) || e.state == Some(Status::Blocked)
        })
        .take(6)
        .collect();
    if visited_agents.is_empty() {
        // Nothing visited yet: the agents that matter most, so the first open is not empty.
        let mut all: Vec<usize> = (0..entries.len())
            .filter(|&i| entries[i].kind == Kind::Agent)
            .collect();
        all.sort_by_key(|&i| (entries[i].attention, i));
        section("Agents", all.into_iter().take(6).collect(), &mut shown);
    } else {
        section("Recent", visited_agents, &mut shown);
    }

    let visited_projects: Vec<usize> = src
        .visits
        .iter()
        .filter(|v| v.key.starts_with("project:"))
        .filter_map(|v| by_id.get(v.key.as_str()).copied())
        .take(3)
        .collect();
    section("Projects", visited_projects, &mut shown);

    // Suggested: the command for what waits, the ones used most, then the defaults.
    let id_of = |c: &CommandSrc| by_id.get(format!("command:{}", c.id).as_str()).copied();
    let waiting: Vec<usize> = src
        .commands
        .iter()
        .filter(|c| any_needs && c.suggest == Some(Suggest::NeedsYou) && !c.disabled)
        .filter_map(id_of)
        .collect();
    let mut used: Vec<usize> = src
        .commands
        .iter()
        .filter(|c| c.kind == CommandKind::Command && !c.disabled)
        .filter_map(id_of)
        .filter(|&i| entries[i].frecency > 0.0)
        .collect();
    used.sort_by(|&a, &b| entries[b].frecency.total_cmp(&entries[a].frecency));
    let defaults = src
        .commands
        .iter()
        .filter(|c| c.suggest == Some(Suggest::Always) && !c.disabled)
        .filter_map(id_of);
    let suggested: Vec<usize> = waiting.into_iter().chain(used).chain(defaults).collect();
    section(
        "Suggested",
        suggested.into_iter().take(3).collect(),
        &mut shown,
    );
    out
}

/// How soon an agent wants the person: lower is sooner.
fn attention(a: &AgentSrc) -> u8 {
    if a.offline {
        return 4;
    }
    match (a.status, a.reviewed) {
        (Status::Blocked, _) => 0,
        (Status::Done, false) => 1,
        (Status::Working, _) => 2,
        _ => 3,
    }
}

fn count(n: usize, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
}

/// A line worth finding by its words: trimmed, with letters, cut to a readable length. Box drawing and bars of a TUI
/// are not.
fn line(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.chars().filter(|c| c.is_alphanumeric()).count() < 4 {
        return None;
    }
    Some(t.chars().take(LINE_CHARS).collect())
}

/// Character runs as pairs of UTF-16 offsets into `text`, flattened: what a JS string can index.
pub fn utf16_pairs(text: &str, marks: &[(u32, u32)]) -> Vec<u32> {
    let mut offsets = Vec::with_capacity(text.len() + 1);
    let mut at = 0u32;
    for c in text.chars() {
        offsets.push(at);
        at += c.len_utf16() as u32;
    }
    offsets.push(at);
    let at = |i: u32| offsets.get(i as usize).copied().unwrap_or(at);
    marks.iter().flat_map(|&(s, e)| [at(s), at(e)]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(key: &str, name: &str, status: Status) -> AgentSrc {
        AgentSrc {
            key: key.into(),
            name: name.into(),
            project_key: "p".into(),
            project_name: "payments".into(),
            checkout: None,
            folder: None,
            machine: "local".into(),
            machine_name: "This computer".into(),
            kind: "omp".into(),
            chat: true,
            status,
            reviewed: false,
            offline: false,
            since_secs: Some(10),
            last_message: None,
            preview: Vec::new(),
        }
    }

    fn command(id: &str, label: &str, suggest: Option<Suggest>) -> CommandSrc {
        CommandSrc {
            id: id.into(),
            label: label.into(),
            group: "App".into(),
            keywords: Vec::new(),
            verbs: Vec::new(),
            kind: CommandKind::Command,
            disabled: false,
            suggest,
        }
    }

    fn visit(key: &str, at: u64) -> Visit {
        Visit {
            key: key.into(),
            visits: vec![at],
            count: 1,
        }
    }

    fn build<'a>(
        agents: &'a [AgentSrc],
        commands: &'a [CommandSrc],
        visits: &'a [Visit],
        here: Option<&'a str>,
    ) -> Catalog {
        Catalog::new(&Sources {
            agents,
            projects: &[],
            machines: &[],
            commands,
            visits,
            now_ms: 1_000_000,
            several_machines: false,
            here,
            focus: Focus::default(),
        })
    }

    fn titles(c: &Catalog, a: &Answer) -> Vec<String> {
        a.rows
            .iter()
            .map(|r| c.entries()[r.entry].title.clone())
            .collect()
    }

    fn all(text: &str) -> Query {
        Query {
            text: text.into(),
            scope: Scope::All,
            limit: 50,
        }
    }

    #[test]
    fn the_empty_state_says_what_needs_you_first_then_what_was_visited() {
        let agents = vec![
            agent("a", "payments api", Status::Blocked),
            agent("b", "refactor ledger", Status::Working),
            agent("c", "docs pass", Status::Idle),
        ];
        let commands = vec![
            command(
                "nextAttention",
                "Next agent that needs you",
                Some(Suggest::NeedsYou),
            ),
            command("settings", "Settings", Some(Suggest::Always)),
        ];
        let visits = vec![visit("agent:c", 900_000), visit("agent:b", 800_000)];
        let c = build(&agents, &commands, &visits, Some("b"));
        let a = c.answer(&all(""), &Focus::default());
        assert!(a.sections);
        let groups: Vec<_> = a.rows.iter().map(|r| r.group.unwrap()).collect();
        assert_eq!(
            groups,
            ["Needs you", "Recent", "Suggested", "Suggested"],
            "the agent in front is not listed under Recent"
        );
        assert_eq!(
            titles(&c, &a),
            [
                "payments api",
                "docs pass",
                "Next agent that needs you",
                "Settings"
            ]
        );
    }

    #[test]
    fn nothing_waiting_means_no_needs_you_section_and_no_next_agent_command() {
        let agents = vec![agent("b", "refactor ledger", Status::Working)];
        let commands = vec![command(
            "nextAttention",
            "Next agent that needs you",
            Some(Suggest::NeedsYou),
        )];
        let c = build(&agents, &commands, &[], None);
        let a = c.answer(&all(""), &Focus::default());
        let groups: Vec<_> = a.rows.iter().map(|r| r.group.unwrap()).collect();
        assert_eq!(
            groups,
            ["Agents"],
            "a first open lists the agents, not nothing"
        );
    }

    #[test]
    fn an_agent_in_front_that_needs_you_stays_in_the_list() {
        let agents = vec![agent("a", "payments api", Status::Blocked)];
        let visits = vec![visit("agent:a", 900_000)];
        let c = build(&agents, &[], &visits, Some("a"));
        let a = c.answer(&all(""), &Focus::default());
        assert_eq!(titles(&c, &a), ["payments api"]);
    }

    #[test]
    fn a_scope_browses_the_urgent_first_then_the_most_used() {
        let agents = vec![
            agent("a", "idle one", Status::Idle),
            agent("b", "waiting", Status::Blocked),
            agent("c", "idle often", Status::Idle),
        ];
        let visits = vec![visit("agent:c", 999_000)];
        let c = build(&agents, &[], &visits, None);
        let q = Query {
            text: String::new(),
            scope: Scope::Agents,
            limit: 10,
        };
        assert_eq!(
            titles(&c, &c.answer(&q, &Focus::default())),
            ["waiting", "idle often", "idle one"]
        );
    }

    #[test]
    fn typing_finds_across_kinds_and_a_message_line_carries_the_match() {
        let mut a = agent("a", "payments api", Status::Working);
        a.preview = vec![
            "──────────".into(),
            "Running the migration tests now".into(),
        ];
        let commands = vec![command("settings", "Settings", None)];
        let c = build(&[a], &commands, &[], None);
        let found = c.answer(&all("migration"), &Focus::default());
        assert_eq!(titles(&c, &found), ["Running the migration tests now"]);
        assert_eq!(found.rows[0].marks, vec![(12, 21)]);
        assert_eq!(c.entries()[found.rows[0].entry].kind, Kind::Message);
        assert_eq!(c.entries()[found.rows[0].entry].target, "a");
    }

    #[test]
    fn marks_become_utf16_offsets() {
        // `𝒜` is one character and two UTF-16 units: a mark after it moves by two.
        assert_eq!(utf16_pairs("𝒜bc", &[(1, 3)]), vec![2, 4]);
        assert_eq!(utf16_pairs("abc", &[(0, 1), (2, 3)]), vec![0, 1, 2, 3]);
    }

    #[test]
    fn a_command_found_by_a_synonym_reports_it() {
        let mut split = command("splitHerdrRight", "Split pane right in herdr", None);
        split.verbs = vec!["new terminal".into()];
        let c = build(&[], &[split], &[], None);
        let a = c.answer(&all("terminal"), &Focus::default());
        assert_eq!(a.rows[0].alias.as_deref(), Some("new terminal"));
    }

    #[test]
    fn the_order_is_fixed_by_the_catalog_not_by_the_clock() {
        let agents = vec![
            agent("a", "alpha", Status::Working),
            agent("b", "alpha two", Status::Working),
        ];
        let c = build(&agents, &[], &[], None);
        let first = titles(&c, &c.answer(&all("alpha"), &Focus::default()));
        for _ in 0..3 {
            assert_eq!(
                titles(&c, &c.answer(&all("alpha"), &Focus::default())),
                first
            );
        }
    }
}
