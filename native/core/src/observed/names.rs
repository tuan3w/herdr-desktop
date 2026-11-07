//! What the session log of an omp agent tells the board: a port of herdr-mobile's `pane_session_names.dart`
//! and `pane_name.dart`, for panes herdr says write one (`agent_session` of kind `path`).
//!
//!  * **A name**, for a pane whose terminal title says nothing (omp titles its terminal `π > <folder>` until
//!    it has a title for the session): the session's title, else the last thing the person said.
//!    [`better_title`] is the rule the board applies; [`PaneSessionNames`] fetches what it needs.
//!  * **When it was last active**, for an idle pane: the file's modification time, the moment its last turn
//!    ended. herdr gives no status timestamps, so an agent that was already idle when the app first looked
//!    has no time of its own, and the Idle section could not be put in order.
//!
//! How it reads:
//!
//!  * **Only where needed.** A pane whose title already names its work and that is not idle is never read;
//!    one the person named (herdr's label) is not read for a name. An idle pane with a good title costs one
//!    `stat`.
//!  * **Only what herdr names.** The log is the one the pane reports; a pane that reports none, as when
//!    herdr's omp integration is not installed on the host, is not guessed at from its folder, since
//!    several agents share one.
//!  * **Cheap and bounded.** A `stat`, and for a name two slices of the file ([`HEAD_BYTES`] at the head,
//!    [`TAIL_BYTES`] at the tail), not the log. Once when a pane first needs it and once more each time its
//!    status changes (a turn that ends is when a title, a last message and a new time appear), at most
//!    `max_concurrent` at once, none while `can_read` is false (the app is in the background or the machine
//!    is down). A failed read is tried again after `retry_after`. Nothing is polled.
//!  * **Quiet.** [`Finished::changed`] is true only when a name or a time really changed.
//!
//! Everything lives in memory: after a restart the board shows the terminal titles, and the order it can
//! observe, until the reads land.
//!
//! The Dart class ran its reads itself (async, a clock, a change notifier). Here the state machine is
//! synchronous and owns no thread and no clock: [`PaneSessionNames::sync`] says which reads to start (the
//! caller does them, off the UI thread, with [`read_session_slices`]) and [`PaneSessionNames::finish`]
//! takes the outcome of one. Time is the caller's, in milliseconds since the Unix epoch.

use std::collections::{HashMap, HashSet};

use crate::board::folder_name;
use crate::files::{FileError, Files};
use crate::schema::{AgentInfo, AgentStatus, PaneInfo, clean_terminal_title};

use super::locate::{is_readable_log_path, kind_of, log_path_of};

/// Bytes read from the start of a log: where omp keeps its title record.
pub const HEAD_BYTES: u64 = 16 * 1024;

/// Bytes read from the end of a log: a later title change and the last message of the person.
pub const TAIL_BYTES: u64 = 64 * 1024;

/// What an agent's pane is called when the pane's own title says nothing.
///
/// Read from the agent's session log, never typed into the agent. The agent's own title for the session is
/// shown as it is. A name taken from the last thing the person said is shown in quotes: it is what was
/// asked, not the agent's name for the work, and it may be many turns old.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneName {
    /// The title, or the person's last message.
    pub text: String,
    /// True when `text` is the person's last message, not the agent's title.
    pub from_prompt: bool,
}

impl PaneName {
    /// The agent's own title for the session.
    pub fn title(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            from_prompt: false,
        }
    }

    /// The person's last message.
    pub fn prompt(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            from_prompt: true,
        }
    }

    /// What the board shows: a prompt in curly quotes.
    pub fn shown(&self) -> String {
        if self.from_prompt {
            format!("\u{201C}{}\u{201D}", self.text)
        } else {
            self.text.clone()
        }
    }
}

/// What an omp session log says the session is called, and what the person said last: the two things the
/// board can name an agent by (`OmpSessionName`, the result of the omp mapper's `parseOmpSessionName`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LogName {
    /// The session's title record, when it has one.
    pub title: Option<String>,
    /// The first line of what the person typed last (a slash command or a system note is not one).
    pub last_prompt: Option<String>,
}

/// True when `title` tells the person nothing about what the agent is doing: empty, the agent's own name,
/// `terminal`, or the folder or workspace it runs in. omp titles its terminal `π > <session title>` and,
/// before it has a title, `π > <folder>`, so a board of such panes reads as one name repeated.
pub fn is_generic_pane_title(
    title: &str,
    agent: Option<&str>,
    folder: Option<&str>,
    workspace: Option<&str>,
) -> bool {
    let t = title.trim().to_lowercase();
    if t.is_empty() || t == "terminal" {
        return true;
    }
    let same = |other: Option<&str>| {
        other.is_some_and(|o| !o.trim().is_empty() && o.trim().to_lowercase() == t)
    };
    same(agent) || same(folder) || same(workspace)
}

/// What the pane is called in the snapshot: the name the person gave it, else the terminal title with agent
/// chrome removed (`Pane.title`). Empty when it has neither.
pub fn pane_title(agent: &AgentInfo, pane: Option<&PaneInfo>) -> String {
    if let Some(label) = given_label(pane) {
        return label.to_owned();
    }
    agent
        .terminal_title_stripped
        .as_deref()
        .or(agent.terminal_title.as_deref())
        .or_else(|| {
            pane.and_then(|p| {
                p.terminal_title_stripped
                    .as_deref()
                    .or(p.terminal_title.as_deref())
            })
        })
        .map(clean_terminal_title)
        .unwrap_or_default()
}

/// The name the person gave the pane (`pane.rename`), when there is one.
fn given_label(pane: Option<&PaneInfo>) -> Option<&str> {
    pane.and_then(|p| p.label.as_deref())
        .map(str::trim)
        .filter(|l| !l.is_empty())
}

/// What decides that a title says nothing about the work here (`FleetAgent.isGenericTitle`): kept with a
/// read job, which judges a log's title when it lands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TitleCheck {
    /// The person named the pane: that name is never generic.
    named: bool,
    agent: Option<String>,
    folder: String,
    workspace: Option<String>,
}

impl TitleCheck {
    /// The check for a pane. `workspace_label` is its workspace's label.
    pub fn of(agent: &AgentInfo, pane: Option<&PaneInfo>, workspace_label: Option<&str>) -> Self {
        let cwd = agent
            .cwd
            .as_deref()
            .or_else(|| pane.and_then(|p| p.cwd.as_deref()));
        Self {
            named: given_label(pane).is_some(),
            agent: agent.agent.clone(),
            folder: folder_name(cwd),
            workspace: workspace_label.map(str::to_owned),
        }
    }

    /// True when `title` says nothing about the work here: see [`is_generic_pane_title`]. A name the person
    /// gave the pane is never generic.
    pub fn is_generic(&self, title: &str) -> bool {
        !self.named
            && is_generic_pane_title(
                title,
                self.agent.as_deref(),
                Some(&self.folder),
                self.workspace.as_deref(),
            )
    }
}

/// The pane's own title says nothing about the work (and the person did not name it): `hasGenericTitle`.
pub fn has_generic_title(
    agent: &AgentInfo,
    pane: Option<&PaneInfo>,
    workspace_label: Option<&str>,
) -> bool {
    TitleCheck::of(agent, pane, workspace_label).is_generic(&pane_title(agent, pane))
}

/// What the board shows instead of the pane's own title: the name read from the session log, only when that
/// title says nothing. `None` means show the pane's own title (`FleetAgent.betterTitle`). `name` is
/// [`PaneSessionNames::name_for`] of the pane's log.
pub fn better_title(
    agent: &AgentInfo,
    pane: Option<&PaneInfo>,
    workspace_label: Option<&str>,
    name: Option<&PaneName>,
) -> Option<String> {
    if has_generic_title(agent, pane, workspace_label) {
        name.map(PaneName::shown)
    } else {
        None
    }
}

/// The name a log gives a pane: its title, unless that says nothing here, else the person's last message.
pub fn name_from_log(log: &LogName, check: &TitleCheck) -> Option<PaneName> {
    match (&log.title, &log.last_prompt) {
        (Some(title), _) if !check.is_generic(title) => Some(PaneName::title(title)),
        (_, Some(prompt)) => Some(PaneName::prompt(prompt)),
        _ => None,
    }
}

/// The head and the tail of a session log, as read from the machine, and when the file was last written
/// (seconds since the Unix epoch; `None` when the machine does not say). Empty slices when the text was not
/// asked for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Slices {
    /// The first [`HEAD_BYTES`] of the log.
    pub head: Vec<u8>,
    /// The last [`TAIL_BYTES`] of the log.
    pub tail: Vec<u8>,
    /// The tail starts in the middle of the file: its first line is a fragment.
    pub tail_starts_mid_line: bool,
    /// When the file was last written.
    pub modified: Option<i64>,
}

impl Slices {
    /// The outcome of a read of these slices: `parse` turns the decoded head, the decoded tail and
    /// `tail_starts_mid_line` into what the log says (the omp mapper's session-name parser). Bytes that are
    /// not UTF-8 are replaced, as the log is the agent's own and not ours to reject.
    pub fn done(&self, parse: impl FnOnce(&str, &str, bool) -> LogName) -> ReadDone {
        ReadDone {
            modified: self.modified,
            log: parse(
                &String::from_utf8_lossy(&self.head),
                &String::from_utf8_lossy(&self.tail),
                self.tail_starts_mid_line,
            ),
        }
    }
}

/// Reads `path` on the machine: its modification time always, its text only when `text` (a pane that needs
/// a name). A `stat`, then at most two reads: the head and, unless the whole file is the head, the tail.
pub fn read_session_slices(files: &dyn Files, path: &str, text: bool) -> Result<Slices, FileError> {
    let stat = files.stat(path)?;
    let (size, modified) = (stat.size, stat.modified);
    if !text || size == 0 {
        return Ok(Slices {
            modified,
            ..Slices::default()
        });
    }
    let head = files.read(path, 0, size.min(HEAD_BYTES) as usize)?.data;
    let tail_start = size.saturating_sub(TAIL_BYTES);
    let tail = if tail_start == 0 && size <= HEAD_BYTES {
        head.clone()
    } else {
        files
            .read(path, tail_start, (size - tail_start) as usize)?
            .data
    };
    Ok(Slices {
        head,
        tail,
        tail_starts_mid_line: tail_start > 0,
        modified,
    })
}

/// One pane of the fleet as [`PaneSessionNames`] looks at it.
#[derive(Debug, Clone)]
pub struct Subject {
    /// The machine's id.
    pub machine: String,
    /// The pane's id.
    pub pane: String,
    /// Which agent program runs in the pane.
    pub kind: Option<String>,
    /// The session log the pane reports (`log_path_of`).
    pub log_path: Option<String>,
    /// The status the app shows: a finished agent the person reviewed is already `Idle`.
    pub status: AgentStatus,
    /// Whether the machine is online now.
    pub live: bool,
    /// Whether the pane's own title says nothing about the work.
    pub generic_title: bool,
    /// How to tell a title read from the log says nothing either.
    pub check: TitleCheck,
}

impl Subject {
    /// The subject for a pane of `machine`. `status` is the status shown (see [`Subject::status`]).
    pub fn of(
        machine: &str,
        live: bool,
        status: AgentStatus,
        agent: &AgentInfo,
        pane: Option<&PaneInfo>,
        workspace_label: Option<&str>,
    ) -> Self {
        let check = TitleCheck::of(agent, pane, workspace_label);
        Self {
            machine: machine.to_owned(),
            pane: agent.pane_id.clone(),
            kind: kind_of(agent).map(str::to_owned),
            log_path: log_path_of(agent).map(str::to_owned),
            status,
            live,
            generic_title: check.is_generic(&pane_title(agent, pane)),
            check,
        }
    }

    /// The log to read for this pane, when it should be read at all: omp's, on a machine that is up, for a
    /// pane that needs a name or is idle (and so needs a time), at a path worth reading.
    fn wanted_path(&self) -> Option<&str> {
        let path = self.log_path.as_deref()?;
        (self.kind.as_deref() == Some("omp")
            && self.live
            && (self.generic_title || self.status == AgentStatus::Idle)
            && is_readable_log_path(path))
        .then_some(path)
    }
}

/// A read for the caller to make: `read_session_slices(files, path, needs_name)` on `machine`'s files, then
/// [`PaneSessionNames::finish`] with what it gave.
#[derive(Debug, Clone)]
pub struct ReadJob {
    /// The machine's id.
    pub machine: String,
    /// The pane's id.
    pub pane: String,
    /// The log to read.
    pub path: String,
    /// Whether the text is wanted (the pane's title says nothing); otherwise only the time is.
    pub needs_name: bool,
    status: AgentStatus,
    check: TitleCheck,
}

/// What a read gave.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadDone {
    /// When the file was last written, in seconds since the Unix epoch.
    pub modified: Option<i64>,
    /// What the log says (ignored for a job that did not need a name).
    pub log: LogName,
}

/// A read that failed: the machine did not answer, or the file is gone. Quiet and retried after the
/// delay.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadFailed;

/// What [`PaneSessionNames::finish`] says.
#[derive(Debug, Clone, Default)]
pub struct Finished {
    /// A name or a time really changed: tell the listeners.
    pub changed: bool,
    /// The reads to start next: the pane may have changed again meanwhile, and a slot is free.
    pub start: Vec<ReadJob>,
}

#[derive(Debug)]
struct Entry {
    path: String,
    status: AgentStatus,
    name: Option<PaneName>,
    modified: Option<i64>,
    failed: bool,
    at: i64,
}

type Key = (String, String);

/// The names and last-active times read from omp session logs, per pane.
#[derive(Debug)]
pub struct PaneSessionNames {
    max_concurrent: usize,
    retry_after_ms: i64,
    entries: HashMap<Key, Entry>,
    wanted: HashMap<Key, ReadJob>,
    queue: Vec<Key>,
    running: HashSet<Key>,
}

impl Default for PaneSessionNames {
    /// Two reads at once, a failed read retried after five minutes.
    fn default() -> Self {
        Self::new(2, 5 * 60 * 1000)
    }
}

impl PaneSessionNames {
    /// Reads in flight at once is at most `max_concurrent`, over all machines; a failed read is not
    /// repeated before `retry_after_ms`.
    pub fn new(max_concurrent: usize, retry_after_ms: i64) -> Self {
        Self {
            max_concurrent,
            retry_after_ms,
            entries: HashMap::new(),
            wanted: HashMap::new(),
            queue: Vec::new(),
            running: HashSet::new(),
        }
    }

    /// The name read for `pane`, or `None` when there is none (or it was read from another log than `path`).
    pub fn name_for(&self, machine: &str, pane: &str, path: Option<&str>) -> Option<&PaneName> {
        self.entry(machine, pane, path)?.name.as_ref()
    }

    /// When `pane`'s session file was last written (read for an idle pane), in seconds since the Unix
    /// epoch, or `None` when that is not known (or it was read from another log than `path`).
    pub fn last_active_for(&self, machine: &str, pane: &str, path: Option<&str>) -> Option<i64> {
        self.entry(machine, pane, path)?.modified
    }

    fn entry(&self, machine: &str, pane: &str, path: Option<&str>) -> Option<&Entry> {
        let e = self.entries.get(&(machine.to_owned(), pane.to_owned()))?;
        (Some(e.path.as_str()) == path).then_some(e)
    }

    /// Looks at the fleet: queues a read for every pane that needs one, forgets the panes that are gone and
    /// returns the reads that may start now. Cheap; call it whenever the fleet changed. `now_ms` is the
    /// time in milliseconds, `can_read` whether reads may run (not in the background, not while the
    /// machine is down).
    pub fn sync(&mut self, fleet: &[Subject], can_read: bool, now_ms: i64) -> Vec<ReadJob> {
        let mut seen: HashSet<Key> = HashSet::new();
        for s in fleet {
            let key = (s.machine.clone(), s.pane.clone());
            seen.insert(key.clone());
            let Some(path) = s.wanted_path() else {
                self.wanted.remove(&key);
                continue;
            };
            let fresh = self.entries.get(&key).is_some_and(|e| {
                e.path == path
                    && e.status == s.status
                    && (!e.failed || now_ms - e.at < self.retry_after_ms)
            });
            if fresh || self.running.contains(&key) {
                continue;
            }
            self.wanted.insert(
                key.clone(),
                ReadJob {
                    machine: s.machine.clone(),
                    pane: s.pane.clone(),
                    path: path.to_owned(),
                    needs_name: s.generic_title,
                    status: s.status,
                    check: s.check.clone(),
                },
            );
            if !self.queue.contains(&key) {
                self.queue.push(key);
            }
        }
        self.entries.retain(|k, _| seen.contains(k));
        self.wanted.retain(|k, _| seen.contains(k));
        let wanted = &self.wanted;
        self.queue.retain(|k| wanted.contains_key(k));
        self.pump(can_read)
    }

    fn pump(&mut self, can_read: bool) -> Vec<ReadJob> {
        let mut start = Vec::new();
        while can_read && self.running.len() < self.max_concurrent && !self.queue.is_empty() {
            let key = self.queue.remove(0);
            let Some(job) = self.wanted.get(&key) else {
                continue;
            };
            start.push(job.clone());
            self.running.insert(key);
        }
        start
    }

    /// Takes the outcome of a read `sync` (or an earlier `finish`) started, then looks at the fleet again
    /// ([`PaneSessionNames::sync`]) for the next reads.
    pub fn finish(
        &mut self,
        job: &ReadJob,
        outcome: Result<ReadDone, ReadFailed>,
        fleet: &[Subject],
        can_read: bool,
        now_ms: i64,
    ) -> Finished {
        let key = (job.machine.clone(), job.pane.clone());
        let (name, modified, failed) = match outcome {
            Ok(done) => (
                job.needs_name
                    .then(|| name_from_log(&done.log, &job.check))
                    .flatten(),
                done.modified,
                false,
            ),
            Err(ReadFailed) => (None, None, true),
        };
        self.running.remove(&key);
        let before = self.entries.insert(
            key.clone(),
            Entry {
                path: job.path.clone(),
                status: job.status,
                name: name.clone(),
                modified,
                failed,
                at: now_ms,
            },
        );
        self.wanted.remove(&key);
        let changed = before.as_ref().and_then(|b| b.name.as_ref()) != name.as_ref()
            || before.as_ref().and_then(|b| b.modified) != modified;
        Finished {
            changed,
            start: self.sync(fleet, can_read, now_ms),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;
    use crate::files::{Chunk, EntryKind, FileErrorKind, Listing, Stat};
    use crate::schema::{AgentSession, AgentSessionKind};

    const LOG: &str = "/home/dev/.omp/agent/sessions/-src-app/2026-10-07_abc123.jsonl";
    const OTHER_LOG: &str = "/home/dev/.omp/agent/sessions/-src-app/other.jsonl";

    /// What a read of a log gives, as the test scripts it (the omp mapper's parser has its own tests).
    #[derive(Clone, Default)]
    struct Says {
        title: Option<&'static str>,
        prompt: Option<&'static str>,
        modified: Option<i64>,
    }

    fn says(title: Option<&'static str>, prompt: Option<&'static str>) -> Says {
        Says {
            title,
            prompt,
            modified: None,
        }
    }

    struct Pane<'a> {
        id: &'a str,
        title: &'a str,
        agent: &'a str,
        status: AgentStatus,
        path: Option<&'a str>,
        label: Option<&'a str>,
        session_agent: &'a str,
    }

    impl<'a> Pane<'a> {
        fn new(id: &'a str) -> Self {
            Self {
                id,
                title: "app",
                agent: "omp",
                status: AgentStatus::Idle,
                path: Some(LOG),
                label: None,
                session_agent: "omp",
            }
        }

        fn subject(&self) -> Subject {
            let agent = AgentInfo {
                pane_id: self.id.into(),
                workspace_id: "w1".into(),
                tab_id: "w1:t1".into(),
                agent: Some(self.agent.into()),
                cwd: Some("/src/app".into()),
                terminal_title: Some(self.title.into()),
                agent_session: self.path.map(|p| AgentSession {
                    agent: self.session_agent.into(),
                    kind: AgentSessionKind::Path,
                    value: p.into(),
                    ..AgentSession::default()
                }),
                ..AgentInfo::default()
            };
            let pane = PaneInfo {
                pane_id: self.id.into(),
                label: self.label.map(str::to_owned),
                ..PaneInfo::default()
            };
            Subject::of("a", true, self.status, &agent, Some(&pane), None)
        }
    }

    /// The board's side of the Dart harness: a fleet, a reader that records what it was asked and gives
    /// what the test scripted, a clock and the listeners' count.
    struct Rig {
        names: PaneSessionNames,
        fleet: Vec<Subject>,
        can_read: bool,
        now: i64,
        says: Box<dyn Fn(&str) -> Says>,
        /// Whether a started read waits (the Dart `gate`).
        gate: bool,
        reads: Vec<String>,
        texts: Vec<bool>,
        started: VecDeque<ReadJob>,
        fail: bool,
        heard: usize,
    }

    impl Rig {
        fn new() -> Self {
            Self {
                names: PaneSessionNames::default(),
                fleet: Vec::new(),
                can_read: true,
                now: 0,
                says: Box::new(|_| Says::default()),
                gate: false,
                reads: Vec::new(),
                texts: Vec::new(),
                started: VecDeque::new(),
                fail: false,
                heard: 0,
            }
        }

        fn show(&mut self, panes: &[Pane<'_>]) {
            self.fleet = panes.iter().map(Pane::subject).collect();
        }

        fn begin(&mut self, jobs: Vec<ReadJob>) {
            for job in jobs {
                self.reads.push(job.path.clone());
                self.texts.push(job.needs_name);
                self.started.push_back(job);
            }
        }

        fn sync(&mut self) {
            let jobs = self.names.sync(&self.fleet, self.can_read, self.now);
            self.begin(jobs);
        }

        /// Lets every started read land (unless the gate holds them), and the reads they free.
        fn settle(&mut self) {
            while !self.gate {
                let Some(job) = self.started.pop_front() else {
                    break;
                };
                let outcome = if self.fail {
                    Err(ReadFailed)
                } else {
                    let s = (self.says)(&job.path);
                    Ok(ReadDone {
                        modified: s.modified,
                        log: LogName {
                            title: s.title.map(str::to_owned),
                            last_prompt: s.prompt.map(str::to_owned),
                        },
                    })
                };
                let done = self
                    .names
                    .finish(&job, outcome, &self.fleet, self.can_read, self.now);
                self.heard += usize::from(done.changed);
                self.begin(done.start);
            }
        }

        fn name(&self, pane: &str, path: &str) -> Option<PaneName> {
            self.names.name_for("a", pane, Some(path)).cloned()
        }

        fn sync_and_settle(&mut self) {
            self.sync();
            self.settle();
        }
    }

    fn rig(panes: &[Pane<'_>], says: impl Fn(&str) -> Says + 'static) -> Rig {
        let mut r = Rig::new();
        r.says = Box::new(says);
        r.show(panes);
        r
    }

    #[test]
    fn an_omp_pane_titled_with_its_folder_is_read_and_named_by_the_session_title() {
        let mut r = rig(&[Pane::new("p1")], |_| {
            says(
                Some("Fix the retry test"),
                Some("ignored when there is a title"),
            )
        });
        r.sync_and_settle();

        assert_eq!(r.reads, [LOG]);
        assert_eq!(
            r.name("p1", LOG),
            Some(PaneName::title("Fix the retry test"))
        );
        assert_eq!(r.heard, 1);
    }

    #[test]
    fn with_no_title_the_persons_last_message_names_it_in_quotes() {
        let mut r = rig(&[Pane::new("p1")], |_| {
            says(None, Some("Add a regression test for the parser"))
        });
        r.sync_and_settle();

        let name = r.name("p1", LOG).expect("a name");
        assert!(name.from_prompt);
        assert_eq!(
            name.shown(),
            "\u{201C}Add a regression test for the parser\u{201D}"
        );
    }

    #[test]
    fn a_log_title_that_is_only_the_folder_is_no_title_the_last_message_is_used() {
        let mut r = rig(&[Pane::new("p1")], |_| {
            says(Some("app"), Some("Upgrade eslint"))
        });
        r.sync_and_settle();

        assert_eq!(r.name("p1", LOG), Some(PaneName::prompt("Upgrade eslint")));
    }

    #[test]
    fn a_log_with_neither_gives_no_name_and_nothing_is_announced() {
        let mut r = rig(&[Pane::new("p1")], |_| Says::default());
        r.sync_and_settle();

        assert_eq!(r.reads.len(), 1);
        assert_eq!(r.name("p1", LOG), None);
        assert_eq!(r.heard, 0);
    }

    fn never_read(panes: &[Pane<'_>]) {
        let mut r = rig(panes, |_| Says::default());
        r.sync_and_settle();
        assert!(r.reads.is_empty());
    }

    #[test]
    fn never_read_for_a_working_pane_whose_own_title_already_names_its_work() {
        let mut p = Pane::new("p1");
        p.title = "Add mobile keyboard autocomplete";
        p.status = AgentStatus::Working;
        never_read(&[p]);
    }

    #[test]
    fn never_read_for_a_pane_that_reports_no_session_however_generic_its_title() {
        let mut p = Pane::new("p1");
        p.path = None;
        never_read(&[p]);
    }

    #[test]
    fn never_read_for_another_agent_than_omp() {
        let mut p = Pane::new("p1");
        p.agent = "claude";
        p.session_agent = "claude";
        never_read(&[p]);
    }

    #[test]
    fn never_read_for_an_odd_path() {
        for bad in [
            "relative/session.jsonl",
            "/home/dev/../root/secret.jsonl",
            "/home/dev/notes.txt",
            "/home/dev/x\n.jsonl",
            "/home/dev/x\u{0}.jsonl",
        ] {
            let mut p = Pane::new("p1");
            p.path = Some(bad);
            never_read(&[p]);
        }
    }

    #[test]
    fn never_read_while_the_machine_is_down() {
        let mut r = rig(&[Pane::new("p1")], |_| Says::default());
        r.fleet[0].live = false;
        r.sync_and_settle();
        assert!(r.reads.is_empty());
    }

    const AT: i64 = 1_767_259_800;

    #[test]
    fn an_idle_pane_with_a_good_title_costs_one_stat_the_time_none_of_the_text() {
        let mut p = Pane::new("p1");
        p.title = "Add mobile keyboard autocomplete";
        let mut r = rig(&[p], |_| Says {
            title: Some("ignored: not asked for"),
            modified: Some(AT),
            ..Says::default()
        });
        r.sync_and_settle();

        assert_eq!(r.texts, [false]);
        assert_eq!(r.names.last_active_for("a", "p1", Some(LOG)), Some(AT));
        assert_eq!(r.name("p1", LOG), None, "its own title is the name");
        assert_eq!(r.heard, 1, "the time is news");
    }

    #[test]
    fn a_pane_the_person_named_is_read_for_the_time_only() {
        let mut p = Pane::new("p1");
        p.label = Some("app");
        p.title = "app";
        let mut r = rig(&[p], |_| Says {
            modified: Some(AT),
            ..Says::default()
        });
        r.sync_and_settle();

        assert_eq!(r.texts, [false]);
        assert_eq!(r.names.last_active_for("a", "p1", Some(LOG)), Some(AT));
    }

    #[test]
    fn a_pane_that_needs_a_name_gets_the_text_and_the_time_in_one_read() {
        let mut r = rig(&[Pane::new("p1")], |_| Says {
            title: Some("Fix the retry test"),
            modified: Some(AT),
            ..Says::default()
        });
        r.sync_and_settle();

        assert_eq!(r.reads.len(), 1);
        assert_eq!(r.texts, [true]);
        assert_eq!(
            r.name("p1", LOG),
            Some(PaneName::title("Fix the retry test"))
        );
        assert_eq!(r.names.last_active_for("a", "p1", Some(LOG)), Some(AT));
    }

    #[test]
    fn a_time_read_from_another_log_is_not_given_to_a_pane_that_moved_to_a_new_one() {
        let mut r = rig(&[Pane::new("p1")], |_| Says {
            modified: Some(AT),
            ..Says::default()
        });
        r.sync_and_settle();

        assert_eq!(r.names.last_active_for("a", "p1", Some(OTHER_LOG)), None);
        assert_eq!(r.names.last_active_for("a", "p1", None), None);
    }

    #[test]
    fn a_host_that_does_not_say_when_gives_no_time_and_nothing_is_announced() {
        let mut p = Pane::new("p1");
        p.title = "Add mobile keyboard autocomplete";
        let mut r = rig(&[p], |_| Says::default());
        r.sync_and_settle();

        assert_eq!(r.reads.len(), 1);
        assert_eq!(r.names.last_active_for("a", "p1", Some(LOG)), None);
        assert_eq!(r.heard, 0);
    }

    #[test]
    fn read_again_when_the_panes_status_changes_not_on_every_sync() {
        let mut working = Pane::new("p1");
        working.status = AgentStatus::Working;
        let mut r = rig(&[working], |_| says(None, Some("First ask")));
        r.sync_and_settle();
        r.sync_and_settle();
        r.sync_and_settle();
        assert_eq!(r.reads.len(), 1, "same status: the read stands");

        r.says = Box::new(|_| says(None, Some("Second ask")));
        r.show(&[Pane::new("p1")]);
        r.sync_and_settle();

        assert_eq!(r.reads.len(), 2);
        assert_eq!(r.name("p1", LOG), Some(PaneName::prompt("Second ask")));
    }

    #[test]
    fn a_name_read_from_another_log_is_not_shown_for_a_pane_that_moved_to_a_new_one() {
        let mut r = rig(&[Pane::new("p1")], |_| says(None, Some("Old session")));
        r.sync_and_settle();

        assert_eq!(r.name("p1", OTHER_LOG), None);
    }

    #[test]
    fn a_failed_read_is_quiet_and_is_retried_only_after_the_retry_delay() {
        let mut r = rig(&[Pane::new("p1")], |_| says(Some("Back again"), None));
        r.fail = true;
        r.sync_and_settle();
        assert_eq!(r.reads.len(), 1);
        assert_eq!(r.heard, 0, "quiet");
        r.sync_and_settle();
        assert_eq!(r.reads.len(), 1, "not hammered");

        r.fail = false;
        r.now += 5 * 60 * 1000 + 1000;
        r.sync_and_settle();
        assert_eq!(r.reads.len(), 2);
        assert_eq!(r.name("p1", LOG), Some(PaneName::title("Back again")));
    }

    #[test]
    fn a_failed_read_is_still_held_back_just_before_the_delay_ends() {
        let mut r = rig(&[Pane::new("p1")], |_| says(Some("T"), None));
        r.fail = true;
        r.sync_and_settle();
        r.fail = false;
        r.now += 5 * 60 * 1000 - 1;
        r.sync_and_settle();
        assert_eq!(r.reads.len(), 1);
    }

    #[test]
    fn nothing_is_read_in_the_background_or_while_the_machine_is_down_reads_resume_with_the_foreground()
     {
        let mut r = rig(&[Pane::new("p1")], |_| says(Some("Named"), None));
        r.can_read = false;
        r.sync_and_settle();
        assert!(r.reads.is_empty());

        r.can_read = true;
        r.sync_and_settle();
        assert_eq!(r.reads.len(), 1);
    }

    #[test]
    fn at_most_max_concurrent_reads_run_at_once_the_rest_wait_their_turn() {
        let paths = [
            "/home/dev/s1.jsonl",
            "/home/dev/s2.jsonl",
            "/home/dev/s3.jsonl",
            "/home/dev/s4.jsonl",
        ];
        let ids = ["p1", "p2", "p3", "p4"];
        let panes: Vec<Pane<'_>> = ids
            .iter()
            .zip(paths)
            .map(|(id, path)| {
                let mut p = Pane::new(id);
                p.path = Some(path);
                p
            })
            .collect();
        let mut r = rig(&panes, |_| says(Some("T"), None));
        r.gate = true;

        r.sync_and_settle();
        assert_eq!(r.reads.len(), 2, "two in flight, two queued");

        r.gate = false;
        r.settle();
        assert_eq!(r.reads.len(), 4);
        for (id, path) in ids.iter().zip(paths) {
            assert_eq!(r.name(id, path), Some(PaneName::title("T")));
        }
    }

    #[test]
    fn panes_that_are_gone_are_forgotten() {
        let mut r = rig(&[Pane::new("p1")], |_| says(Some("Named"), None));
        r.sync_and_settle();
        assert!(r.name("p1", LOG).is_some());

        r.fleet.clear();
        r.sync();
        assert_eq!(r.name("p1", LOG), None);
    }

    #[test]
    fn a_pane_that_stops_needing_a_read_while_it_waits_is_dropped_from_the_queue() {
        let mut p2 = Pane::new("p2");
        p2.path = Some(OTHER_LOG);
        let mut r = rig(&[Pane::new("p1"), p2, Pane::new("p3")], |_| {
            says(Some("T"), None)
        });
        r.names = PaneSessionNames::new(1, 1000);
        r.gate = true;
        r.sync_and_settle();
        assert_eq!(r.reads.len(), 1, "one slot");

        // p2 ends up on a pane that needs nothing.
        let mut named = Pane::new("p2");
        named.title = "Add mobile keyboard autocomplete";
        named.status = AgentStatus::Working;
        let mut p3 = Pane::new("p3");
        p3.path = Some("/home/dev/s3.jsonl");
        r.show(&[Pane::new("p1"), named, p3]);
        r.sync();
        r.gate = false;
        r.settle();

        assert!(!r.reads.iter().any(|p| p == OTHER_LOG), "{:?}", r.reads);
        assert_eq!(r.reads.len(), 2);
    }

    #[test]
    fn a_title_that_says_nothing_is_empty_terminal_or_the_agent_the_folder_or_the_workspace() {
        let generic = |t| is_generic_pane_title(t, Some("omp"), Some("payments-api"), Some("Work"));
        for t in [
            "",
            "  ",
            "terminal",
            "Terminal",
            "omp",
            "OMP",
            "payments-api",
            " work ",
        ] {
            assert!(generic(t), "{t:?}");
        }
        for t in ["Fix the retry test", "payments", "omp > x"] {
            assert!(!generic(t), "{t:?}");
        }
        assert!(
            !is_generic_pane_title("x", Some(""), Some(" "), None),
            "an empty name matches nothing"
        );
    }

    #[test]
    fn the_board_shows_the_log_name_only_for_a_pane_whose_title_says_nothing() {
        let agent = |title: &str, cwd: &str| AgentInfo {
            pane_id: "p1".into(),
            agent: Some("omp".into()),
            cwd: Some(cwd.into()),
            terminal_title: Some(title.into()),
            ..AgentInfo::default()
        };
        let named = PaneName::title("Fix the retry test");
        let better = |a: &AgentInfo, pane: Option<&PaneInfo>, ws: Option<&str>| {
            better_title(a, pane, ws, Some(&named))
        };
        // omp's own chrome around the folder: still only the folder.
        let fresh = agent("\u{3c0} app", "/src/app");
        assert_eq!(
            better(&fresh, None, None),
            Some("Fix the retry test".into())
        );
        assert!(has_generic_title(&fresh, None, None));
        // The workspace's label says nothing either.
        let in_workspace = agent("Backend", "/src/app");
        assert_eq!(
            better(&in_workspace, None, Some("backend")).as_deref(),
            Some("Fix the retry test")
        );
        assert_eq!(better(&in_workspace, None, None), None);
        // A real title, and a name the person gave the pane, are never replaced.
        assert_eq!(
            better(&agent("Add autocomplete", "/src/app"), None, None),
            None
        );
        let labelled = PaneInfo {
            label: Some(" app ".into()),
            ..PaneInfo::default()
        };
        assert_eq!(better(&fresh, Some(&labelled), None), None);
        assert_eq!(pane_title(&fresh, Some(&labelled)), "app");
        // No name read: the pane's own title shows.
        assert_eq!(better_title(&fresh, None, None, None), None);
        // A prompt is shown in quotes.
        let asked = PaneName::prompt("Upgrade eslint");
        assert_eq!(
            better_title(&fresh, None, None, Some(&asked)).as_deref(),
            Some("\u{201C}Upgrade eslint\u{201D}")
        );
    }

    /// A single file on a machine, to see how much of it is read.
    struct OneFile {
        body: Vec<u8>,
        modified: Option<i64>,
        reads: parking_lot::Mutex<Vec<(u64, usize)>>,
    }

    impl OneFile {
        fn of(len: usize, modified: Option<i64>) -> Self {
            let body = (0..len).map(|i| b'a' + (i % 26) as u8).collect();
            Self {
                body,
                modified,
                reads: parking_lot::Mutex::default(),
            }
        }
    }

    impl Files for OneFile {
        fn list(&self, dir: &str) -> Result<Listing, FileError> {
            Err(FileError::new(FileErrorKind::NotADirectory, dir))
        }

        fn stat(&self, path: &str) -> Result<Stat, FileError> {
            if path == LOG {
                Ok(Stat {
                    kind: EntryKind::File,
                    size: self.body.len() as u64,
                    modified: self.modified,
                    readable: true,
                })
            } else {
                Err(FileError::new(FileErrorKind::NotFound, path))
            }
        }

        fn read(&self, _: &str, start: u64, len: usize) -> Result<Chunk, FileError> {
            self.reads.lock().push((start, len));
            let from = (start as usize).min(self.body.len());
            let to = (from + len).min(self.body.len());
            Ok(Chunk {
                size: self.body.len() as u64,
                modified: self.modified,
                data: self.body[from..to].to_vec(),
            })
        }

        fn put(&self, _: &str, _: u64, _: &[u8]) -> Result<(), FileError> {
            Err(FileError::new(FileErrorKind::Other, "read only"))
        }

        fn commit(&self, _: &str, _: bool) -> Result<(), FileError> {
            Err(FileError::new(FileErrorKind::Other, "read only"))
        }

        fn discard(&self, _: &str) -> Result<(), FileError> {
            Err(FileError::new(FileErrorKind::Other, "read only"))
        }
    }

    #[test]
    fn a_read_for_the_time_alone_reads_none_of_the_file() {
        let f = OneFile::of(1000, Some(AT));
        let s = read_session_slices(&f, LOG, false).expect("slices");
        assert_eq!(
            s,
            Slices {
                modified: Some(AT),
                ..Slices::default()
            }
        );
        assert!(f.reads.lock().is_empty());
        let empty = OneFile::of(0, None);
        assert_eq!(
            read_session_slices(&empty, LOG, true).expect("slices"),
            Slices::default()
        );
        assert!(empty.reads.lock().is_empty());
    }

    #[test]
    fn a_small_log_is_read_once_and_is_its_own_tail() {
        let f = OneFile::of(1000, None);
        let s = read_session_slices(&f, LOG, true).expect("slices");
        assert_eq!(
            (s.head.len(), s.tail.len(), s.tail_starts_mid_line),
            (1000, 1000, false)
        );
        assert_eq!(s.head, s.tail);
        assert_eq!(*f.reads.lock(), [(0, 1000)]);
    }

    #[test]
    fn a_big_log_gives_its_first_16_kb_and_its_last_64_kb_with_the_tail_cut_mid_line() {
        let size = 200 * 1024;
        let f = OneFile::of(size, None);
        let s = read_session_slices(&f, LOG, true).expect("slices");
        assert_eq!(s.head.len() as u64, HEAD_BYTES);
        assert_eq!(s.tail.len() as u64, TAIL_BYTES);
        assert!(s.tail_starts_mid_line);
        assert_eq!(s.tail, f.body[size - TAIL_BYTES as usize..]);
        assert_eq!(
            *f.reads.lock(),
            [
                (0, HEAD_BYTES as usize),
                (size as u64 - TAIL_BYTES, TAIL_BYTES as usize)
            ]
        );
    }

    #[test]
    fn a_log_between_head_and_tail_size_reads_its_tail_from_the_start_of_the_file() {
        let f = OneFile::of(32 * 1024, None);
        let s = read_session_slices(&f, LOG, true).expect("slices");
        assert_eq!(s.tail.len(), 32 * 1024);
        assert!(!s.tail_starts_mid_line, "the tail is the whole file");
    }

    #[test]
    fn a_log_that_cannot_be_read_is_an_error_not_an_empty_name() {
        let f = OneFile::of(10, None);
        let e = read_session_slices(&f, "/home/dev/x.jsonl", true).expect_err("not found");
        assert_eq!(e.kind, FileErrorKind::NotFound);
    }

    #[test]
    fn slices_are_decoded_with_bad_bytes_replaced_and_handed_to_the_parser() {
        let s = Slices {
            head: b"head\xff".to_vec(),
            tail: b"tail".to_vec(),
            tail_starts_mid_line: true,
            modified: Some(AT),
        };
        let done = s.done(|head, tail, mid| LogName {
            title: Some(head.to_owned()),
            last_prompt: Some(format!("{tail} {mid}")),
        });
        assert_eq!(done.modified, Some(AT));
        assert_eq!(done.log.title.as_deref(), Some("head\u{fffd}"));
        assert_eq!(done.log.last_prompt.as_deref(), Some("tail true"));
    }
}
