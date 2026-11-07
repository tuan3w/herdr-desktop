//! Finding the session log of the agent in a pane: a port of herdr-mobile's `session_log_locator.dart`,
//! `claude_locator.dart` and `codex_locator.dart`.
//!
//! omp tells herdr the path of its log (`agent_session` of kind `path`). Claude Code and Codex name a
//! session by id only (and only once herdr's hook is installed), so their folders under the agent user's
//! home are looked into. Every file access goes through [`LocateCtx::files`] and nothing is put in a shell;
//! every path built from a log, a pid or a session id is validated first ([`is_readable_log_path`], the
//! uuid checks).
//!
//! A file or folder that is not there (or not for this user to read) is an answer; a machine that cannot be
//! reached is not, and a [`Location`] has no error variant, so it is [`Location::NotYet`] with the reason:
//! the caller asks again later, where the Dart code threw and its poller retried.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::model::{LocateCtx, Location, Locator};
use crate::files::{EntryKind, FileError, FileErrorKind, Files, PATH_MAX};
use crate::schema::{AgentInfo, AgentSession, AgentSessionKind};
use crate::wire::ErrorKind;

/// How long `pane.process_info` may take.
const PROCESS_INFO_TIMEOUT: Duration = Duration::from_secs(10);

/// A log path worth reading: absolute, a `.jsonl`, no control characters and no `..` segment.
///
/// The length limit is in bytes (the machine's `PATH_MAX`; the Dart code counted UTF-16 units), which only
/// differs for non-ASCII paths and is the stricter of the two.
pub fn is_readable_log_path(path: &str) -> bool {
    path.starts_with('/')
        && path.ends_with(".jsonl")
        && path.len() <= PATH_MAX
        && !path.chars().any(|c| (c as u32) < 0x20 || c == '\u{7f}')
        && !path.split('/').any(|s| s == "..")
}

/// Which agent program runs in the pane (`omp`, `claude`, ...): what the agent says about its session,
/// else what herdr detected. `FleetAgent.kindOf`.
pub fn kind_of(agent: &AgentInfo) -> Option<&str> {
    match agent.agent_session.as_ref() {
        Some(s) if !s.agent.is_empty() => Some(&s.agent),
        _ => agent.agent.as_deref(),
    }
}

/// The session the agent reports about itself. herdr's field is the host agent's own and its shape is not
/// ours to rely on: one without a value is none (`AgentSessionRef.tryParse`).
pub fn session_of(agent: &AgentInfo) -> Option<&AgentSession> {
    agent.agent_session.as_ref().filter(|s| !s.value.is_empty())
}

/// The session log the agent appends its transcript to, when it names one: a `kind: path` session that is
/// a `.jsonl` file. `None` otherwise (the pane then has no observed chat). `FleetAgent.logPathOf`.
pub fn log_path_of(agent: &AgentInfo) -> Option<&str> {
    let s = session_of(agent)?;
    (s.kind == AgentSessionKind::Path && s.value.ends_with(".jsonl")).then_some(s.value.as_str())
}

/// Why a look could not be completed (a machine that does not answer), as the words for a
/// [`Location::NotYet`].
struct Transient(String);

impl From<FileError> for Transient {
    fn from(e: FileError) -> Self {
        Self(e.message)
    }
}

type Found<T> = Result<T, Transient>;

fn settle(found: Found<Location>) -> Location {
    found.unwrap_or_else(|Transient(why)| {
        Location::NotYet(format!(
            "Could not look for the session log on the machine: {why}"
        ))
    })
}

/// A file or folder that is not there (or not for this user to read) is an answer; a dropped link is not.
fn absent(e: &FileError) -> bool {
    matches!(
        e.kind,
        FileErrorKind::NotFound
            | FileErrorKind::Denied
            | FileErrorKind::NotADirectory
            | FileErrorKind::IsADirectory
    )
}

/// The agent user's home folder on the machine, without a trailing slash (`/` is the empty string, so
/// `{home}/.claude` is still absolute). Asked of the machine when the context does not know it: `~` is
/// expanded by the machine and a listing says to what.
fn home_of(ctx: &LocateCtx<'_>) -> Found<String> {
    let home = match ctx.home {
        Some(h) => h.to_owned(),
        None => ctx.files.list("~")?.path,
    };
    Ok(home.trim_end_matches('/').to_owned())
}

/// Whether `path` is a file.
fn is_file(files: &dyn Files, path: &str) -> Found<bool> {
    match files.stat(path) {
        Ok(stat) => Ok(stat.kind == EntryKind::File),
        Err(e) if absent(&e) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// omp tells herdr the path of its log (`kind: path`).
#[derive(Debug, Clone, Copy, Default)]
pub struct OmpLocator;

impl OmpLocator {
    /// Shown verbatim.
    pub const UNLINKED_WHY: &'static str = "This agent does not name a session log.";
}

impl Locator for OmpLocator {
    fn may_locate(&self, agent: &AgentInfo) -> bool {
        log_path_of(agent).is_some()
    }

    fn locate(&self, ctx: &LocateCtx<'_>) -> Location {
        match log_path_of(ctx.agent) {
            Some(path) if is_readable_log_path(path) => Location::Located(path.to_owned()),
            _ => Location::Unlinked(Self::UNLINKED_WHY.to_owned()),
        }
    }
}

/// `pane.process_info`'s row for one foreground process of a pane.
struct PaneProcess {
    pid: i64,
    name: String,
    argv0: Option<String>,
    cmdline: Option<String>,
}

impl PaneProcess {
    /// `None` for a row without an integer pid and a string name: herdr's own fields, not ours to rely on.
    fn parse(row: &Value) -> Option<Self> {
        let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            pid: row.get("pid")?.as_i64()?,
            name: row.get("name")?.as_str()?.to_owned(),
            argv0: text("argv0"),
            cmdline: text("cmdline"),
        })
    }

    /// The foreground process is Claude Code itself: its `argv0` (or the first word of its command line) is
    /// `claude`. herdr's `name` is the version string for it (`2.1.293`), and the foreground list also holds
    /// helper processes (MCP servers) that may have `claude` somewhere in a path.
    fn is_claude(&self) -> bool {
        fn base(s: &str) -> &str {
            s.split('/').rfind(|x| !x.is_empty()).unwrap_or("")
        }
        if self.pid < 1 {
            return false;
        }
        let first = self
            .cmdline
            .as_deref()
            .and_then(|c| c.split_whitespace().next())
            .unwrap_or("");
        base(self.argv0.as_deref().unwrap_or("")) == "claude"
            || base(first) == "claude"
            || self.name == "claude"
    }
}

/// Finds the log of a Claude Code pane.
///
/// Claude writes `~/.claude/projects/{cwd with every non-alphanumeric character replaced by "-"}/{sessionId}.jsonl`
/// (the file is named by the session id and does not exist until the first message). herdr's hook reports
/// the session id and the transcript path, but only once its integration is installed and the session
/// started or resumed after that. Without it, the running process tells: `~/.claude/sessions/{pid}.json`
/// maps a `claude` pid to its session id.
#[derive(Debug, Default)]
pub struct ClaudeLocator {
    /// Session ids whose project folders were all looked into without finding the file.
    scanned: Mutex<HashSet<String>>,
}

impl ClaudeLocator {
    /// Shown verbatim.
    pub const UNLINKED_WHY: &'static str = "herdr does not know which session this Claude Code runs. Install herdr's hook (the terminal's ⋯ menu has \"Read as chat…\", or run \"herdr integration install claude\" on the machine), then resume the session.";

    /// A session that has no file yet.
    pub const NOT_YET_WHY: &'static str = "Claude has not written this session yet.";

    /// The most project folders looked into for a session id.
    pub const MAX_PROJECTS: usize = 200;

    /// The biggest `sessions/<pid>.json` read.
    pub const MAX_PID_FILE: usize = 64 * 1024;

    /// A locator that has scanned nothing yet.
    pub fn new() -> Self {
        Self::default()
    }

    fn locate_inner(&self, ctx: &LocateCtx<'_>) -> Found<Location> {
        let cwd = ctx
            .agent
            .cwd
            .as_deref()
            .or_else(|| ctx.pane.and_then(|p| p.cwd.as_deref()));
        // The running process is the truth about which session the pane runs: the session herdr reports is
        // the one the hook saw last, and stays after the agent in the pane was exited and started again.
        if let Some(found) = self.by_process(ctx, cwd)? {
            return Ok(found);
        }
        if let Some(session) = session_of(ctx.agent) {
            match session.kind {
                AgentSessionKind::Path if is_readable_log_path(&session.value) => {
                    // herdr reports the path when the session starts; the file comes with the first message.
                    return Ok(if is_file(ctx.files, &session.value)? {
                        Location::Located(session.value.clone())
                    } else {
                        Location::NotYet(Self::NOT_YET_WHY.to_owned())
                    });
                }
                AgentSessionKind::Id if is_session_id(&session.value) => {
                    return self.by_id(ctx, &session.value, cwd);
                }
                _ => {}
            }
        }
        Ok(Location::Unlinked(Self::UNLINKED_WHY.to_owned()))
    }

    /// The log of the session the `claude` process in the pane runs (`~/.claude/sessions/<pid>.json` names
    /// it), or `None` when that cannot be told (an old herdr, no such process, no file of its own).
    fn by_process(&self, ctx: &LocateCtx<'_>, pane_cwd: Option<&str>) -> Found<Option<Location>> {
        let running = match ctx.wire.request(
            "pane.process_info",
            json!({"pane_id": ctx.agent.pane_id}),
            PROCESS_INFO_TIMEOUT,
        ) {
            Ok(v) => v,
            // An old herdr (unsupported) or one that refuses: the report is all there is.
            Err(e) if matches!(e.kind, ErrorKind::Api { .. }) => return Ok(None),
            Err(e) => return Err(Transient(e.message)),
        };
        let rows = running
            .pointer("/process_info/foreground_processes")
            .and_then(Value::as_array);
        let home = home_of(ctx)?;
        for p in rows.into_iter().flatten().filter_map(PaneProcess::parse) {
            if !p.is_claude() {
                continue;
            }
            let json = read_pid_file(
                ctx.files,
                &format!("{home}/.claude/sessions/{}.json", p.pid),
            )?;
            // The file must be this process's own: a stale one of a crashed process whose pid was reused
            // names another session.
            let Some(json) = json else { continue };
            if json.get("kind").and_then(Value::as_str) != Some("interactive")
                || json.get("pid").and_then(Value::as_i64) != Some(p.pid)
            {
                continue;
            }
            let Some(id) = json
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|id| is_session_id(id))
            else {
                continue;
            };
            let cwd = json.get("cwd").and_then(Value::as_str).or(pane_cwd);
            return self.by_id(ctx, id, cwd).map(Some);
        }
        Ok(None)
    }

    /// The log of session `id`: in the folder its working directory names, else in whichever project folder
    /// holds it (a symlinked or renamed cwd).
    fn by_id(&self, ctx: &LocateCtx<'_>, id: &str, cwd: Option<&str>) -> Found<Location> {
        let home = home_of(ctx)?;
        let projects = format!("{home}/.claude/projects");
        if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
            let guess = format!("{projects}/{}/{id}.jsonl", project_folder(cwd));
            if is_readable_log_path(&guess) && is_file(ctx.files, &guess)? {
                return Ok(Location::Located(guess));
            }
        }
        // One full look for a session that has no file yet, not one per poll: after it only the folder its
        // working directory names is looked at.
        if self.scanned.lock().contains(id) {
            return Ok(Location::NotYet(Self::NOT_YET_WHY.to_owned()));
        }
        let mut dirs = match ctx.files.list(&projects) {
            Ok(listing) => listing
                .entries
                .into_iter()
                .filter(|e| e.kind == EntryKind::Dir)
                .collect::<Vec<_>>(),
            Err(e) if absent(&e) => return Ok(Location::NotYet(Self::NOT_YET_WHY.to_owned())),
            Err(e) => return Err(e.into()),
        };
        // Newest first; a folder with no time counts as the oldest.
        dirs.sort_by_key(|e| std::cmp::Reverse(e.modified.unwrap_or(0)));
        for dir in dirs.iter().take(Self::MAX_PROJECTS) {
            let path = format!("{projects}/{}/{id}.jsonl", dir.name);
            if is_readable_log_path(&path) && is_file(ctx.files, &path)? {
                return Ok(Location::Located(path));
            }
        }
        self.scanned.lock().insert(id.to_owned());
        Ok(Location::NotYet(Self::NOT_YET_WHY.to_owned()))
    }
}

impl Locator for ClaudeLocator {
    fn may_locate(&self, agent: &AgentInfo) -> bool {
        kind_of(agent) == Some("claude")
    }

    fn locate(&self, ctx: &LocateCtx<'_>) -> Location {
        settle(self.locate_inner(ctx))
    }
}

/// `^[0-9a-f-]{36}$`
fn is_session_id(s: &str) -> bool {
    s.len() == 36
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// The folder Claude keeps the sessions of a working directory in: every character that is not an ASCII
/// letter or digit becomes `-`. Claude does this in JavaScript, per UTF-16 unit, so a character outside the
/// basic plane (an emoji) is two dashes.
fn project_folder(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            out.extend(std::iter::repeat_n('-', c.len_utf16()));
        }
    }
    out
}

/// `sessions/<pid>.json` as an object; `None` when it is absent, too big, or not a JSON object.
fn read_pid_file(files: &dyn Files, path: &str) -> Found<Option<Value>> {
    match files.read(path, 0, ClaudeLocator::MAX_PID_FILE + 1) {
        Ok(chunk) if chunk.data.len() > ClaudeLocator::MAX_PID_FILE => Ok(None),
        Ok(chunk) => Ok(
            serde_json::from_str::<Value>(&String::from_utf8_lossy(&chunk.data))
                .ok()
                .filter(Value::is_object),
        ),
        Err(e) if absent(&e) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Finds the log of a Codex pane.
///
/// Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-<local time>-<id>.jsonl` when the first prompt is
/// sent; the date folder and the name's stamp are the HOST's local time at creation, and `<id>` is a UUIDv7
/// whose first 48 bits are the creation time in milliseconds UTC. herdr's hook reports the thread id only
/// (not the path), and only once its integration is installed and the session started or resumed after
/// that. Without a session reference the pane cannot be linked: Codex keeps no map from a process to its
/// thread.
///
/// One instance serves one machine: the folder a session was found in is remembered by its id (a session's
/// file never moves).
#[derive(Debug, Default)]
pub struct CodexLocator {
    found: Mutex<HashMap<String, String>>,
}

impl CodexLocator {
    /// Shown verbatim.
    pub const UNLINKED_WHY: &'static str = "herdr does not know which session this Codex runs. Install herdr's hook (the terminal's ⋯ menu has \"Read as chat…\", or run \"herdr integration install codex\" on the machine; Codex asks you to trust it), then run \"codex resume\".";

    /// A session Codex compressed.
    pub const COMPRESSED_WHY: &'static str =
        "Codex compressed this session after a week idle. Resume it in Codex to read it here.";

    /// A session that has no file yet.
    pub const NOT_YET_WHY: &'static str = "Codex has not written this session yet.";

    /// The most directory listings made looking for a session by walking the date folders newest first.
    pub const MAX_LISTS: usize = 40;

    /// A locator that has found nothing yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The log of thread `id` (a main session's or a subagent's). `home` is the agent user's home folder
    /// when known (the machine says when not).
    pub fn locate_by_id(&self, files: &dyn Files, home: Option<&str>, id: &str) -> Location {
        settle(self.by_id(files, home, id))
    }

    fn by_id(&self, files: &dyn Files, home: Option<&str>, id: &str) -> Found<Location> {
        if !is_uuid(id) {
            return Ok(Location::NotYet(Self::NOT_YET_WHY.to_owned()));
        }
        if let Some(cached) = self.found.lock().get(id) {
            return Ok(Location::Located(cached.clone()));
        }
        let home = match home {
            Some(h) => h.to_owned(),
            None => files.list("~")?.path,
        };
        let root = format!("{}/.codex/sessions", home.trim_end_matches('/'));
        let mut compressed = false;
        let mut path = None;
        // A v7 id says its day (the version digit is the 15th character); only an id that does not is
        // looked for by walking.
        if id.as_bytes()[14] == b'7' {
            let ms = i64::from_str_radix(&id.replace('-', "")[..12], 16).unwrap_or(0);
            for shift in [-1_i64, 0, 1] {
                let (y, m, d) = civil_from_ms(ms + shift * 86_400_000);
                let dir = format!("{root}/{y:04}/{m:02}/{d:02}");
                path = in_day(files, &dir, id, &mut compressed)?;
                if path.is_some() {
                    break;
                }
            }
        } else {
            path = walk(files, &root, id, &mut compressed)?;
        }
        if let Some(path) = path.filter(|p| is_readable_log_path(p)) {
            self.found.lock().insert(id.to_owned(), path.clone());
            return Ok(Location::Located(path));
        }
        Ok(if compressed {
            Location::Unlinked(Self::COMPRESSED_WHY.to_owned())
        } else {
            Location::NotYet(Self::NOT_YET_WHY.to_owned())
        })
    }
}

impl Locator for CodexLocator {
    fn may_locate(&self, agent: &AgentInfo) -> bool {
        session_of(agent).is_some() && kind_of(agent) == Some("codex")
    }

    fn locate(&self, ctx: &LocateCtx<'_>) -> Location {
        let Some(session) = session_of(ctx.agent) else {
            return Location::Unlinked(Self::UNLINKED_WHY.to_owned());
        };
        match session.kind {
            AgentSessionKind::Path if is_readable_log_path(&session.value) => {
                Location::Located(session.value.clone())
            }
            AgentSessionKind::Id => self.locate_by_id(ctx.files, ctx.home, &session.value),
            _ => Location::Unlinked(Self::UNLINKED_WHY.to_owned()),
        }
    }
}

/// `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`
fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(&b),
        })
}

/// The rollout of thread `id` in the day folder `dir`; a rollout Codex compressed (`.jsonl.zst`) only
/// sets `compressed`.
fn in_day(files: &dyn Files, dir: &str, id: &str, compressed: &mut bool) -> Found<Option<String>> {
    let Some(entries) = list(files, dir)? else {
        return Ok(None);
    };
    for e in entries {
        if !e.name.starts_with("rollout-") {
            continue;
        }
        if e.name.ends_with(&format!("-{id}.jsonl")) {
            return Ok(Some(format!("{dir}/{}", e.name)));
        }
        if e.name.ends_with(&format!("-{id}.jsonl.zst")) {
            *compressed = true;
        }
    }
    Ok(None)
}

/// Date folders newest first, at most [`CodexLocator::MAX_LISTS`] listings in all.
fn walk(files: &dyn Files, root: &str, id: &str, compressed: &mut bool) -> Found<Option<String>> {
    let mut lists = 1;
    for y in numbered(files, root)? {
        if lists >= CodexLocator::MAX_LISTS {
            return Ok(None);
        }
        lists += 1;
        for m in numbered(files, &format!("{root}/{y}"))? {
            if lists >= CodexLocator::MAX_LISTS {
                return Ok(None);
            }
            lists += 1;
            for d in numbered(files, &format!("{root}/{y}/{m}"))? {
                if lists >= CodexLocator::MAX_LISTS {
                    return Ok(None);
                }
                lists += 1;
                if let Some(found) = in_day(files, &format!("{root}/{y}/{m}/{d}"), id, compressed)?
                {
                    return Ok(Some(found));
                }
            }
        }
    }
    Ok(None)
}

/// The all-digit folder names of `dir` (one to four digits), biggest first.
fn numbered(files: &dyn Files, dir: &str) -> Found<Vec<String>> {
    let mut names: Vec<String> = list(files, dir)?
        .unwrap_or_default()
        .into_iter()
        .filter(|e| {
            e.kind == EntryKind::Dir
                && (1..=4).contains(&e.name.len())
                && e.name.bytes().all(|b| b.is_ascii_digit())
        })
        .map(|e| e.name)
        .collect();
    names.sort_by(|a, b| b.cmp(a));
    Ok(names)
}

/// The entries of `dir`; `None` when it is not there, not readable, or not a folder.
fn list(files: &dyn Files, dir: &str) -> Found<Option<Vec<crate::files::Entry>>> {
    match files.list(dir) {
        Ok(listing) => Ok(Some(listing.entries)),
        Err(e)
            if matches!(
                e.kind,
                FileErrorKind::NotFound | FileErrorKind::Denied | FileErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

/// The UTC calendar date `ms` milliseconds after the Unix epoch fall on (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_ms(ms: i64) -> (i64, u32, u32) {
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::*;
    use crate::files::{Chunk, Entry, Listing, Stat};
    use crate::wire::{EventStream, Wire, WireError};

    /// A machine's files in memory that notes every `list` and `stat` it is asked.
    #[derive(Default)]
    struct MemFs {
        files: BTreeMap<String, Vec<u8>>,
        dirs: BTreeMap<String, Option<i64>>,
        calls: Mutex<Vec<String>>,
        unreachable: bool,
    }

    impl MemFs {
        fn new() -> Self {
            let mut fs = Self::default();
            fs.dir("/home/dev", None);
            fs
        }

        fn dir(&mut self, path: &str, modified: Option<i64>) -> &mut Self {
            let mut at = String::new();
            for part in path.split('/').filter(|s| !s.is_empty()) {
                at = format!("{at}/{part}");
                self.dirs.entry(at.clone()).or_insert(None);
            }
            self.dirs.insert(path.to_owned(), modified);
            self
        }

        fn file(&mut self, path: &str, body: &str) -> &mut Self {
            let (parent, _) = path.rsplit_once('/').expect("an absolute path");
            self.dir(parent, None);
            self.files.insert(path.to_owned(), body.as_bytes().to_vec());
            self
        }

        fn lists(&self) -> usize {
            self.calls
                .lock()
                .iter()
                .filter(|c| c.starts_with("list"))
                .count()
        }

        fn refused<T>(&self) -> Result<T, FileError> {
            Err(FileError::new(FileErrorKind::Unreachable, "link lost"))
        }
    }

    impl Files for MemFs {
        fn list(&self, dir: &str) -> Result<Listing, FileError> {
            self.calls.lock().push(format!("list {dir}"));
            if self.unreachable {
                return self.refused();
            }
            if self.files.contains_key(dir) {
                return Err(FileError::new(FileErrorKind::NotADirectory, dir));
            }
            if !self.dirs.contains_key(dir) {
                return Err(FileError::new(FileErrorKind::NotFound, dir));
            }
            let below = format!("{}/", dir.trim_end_matches('/'));
            let child = |p: &str| {
                p.strip_prefix(&below)
                    .filter(|rest| !rest.contains('/') && !rest.is_empty())
                    .map(str::to_owned)
            };
            let mut entries = Vec::new();
            for (p, modified) in &self.dirs {
                if let Some(name) = child(p) {
                    entries.push(Entry {
                        name,
                        kind: EntryKind::Dir,
                        size: 0,
                        modified: *modified,
                        readable: true,
                        link: false,
                    });
                }
            }
            for (p, body) in &self.files {
                if let Some(name) = child(p) {
                    entries.push(Entry {
                        name,
                        kind: EntryKind::File,
                        size: body.len() as u64,
                        modified: None,
                        readable: true,
                        link: false,
                    });
                }
            }
            Ok(Listing {
                path: dir.to_owned(),
                entries,
                truncated: false,
                skipped: 0,
            })
        }

        fn stat(&self, path: &str) -> Result<Stat, FileError> {
            self.calls.lock().push(format!("stat {path}"));
            if self.unreachable {
                return self.refused();
            }
            if let Some(body) = self.files.get(path) {
                return Ok(Stat {
                    kind: EntryKind::File,
                    size: body.len() as u64,
                    modified: None,
                    readable: true,
                });
            }
            match self.dirs.get(path) {
                Some(modified) => Ok(Stat {
                    kind: EntryKind::Dir,
                    size: 0,
                    modified: *modified,
                    readable: true,
                }),
                None => Err(FileError::new(FileErrorKind::NotFound, path)),
            }
        }

        fn read(&self, path: &str, start: u64, len: usize) -> Result<Chunk, FileError> {
            self.calls.lock().push(format!("read {path}"));
            let Some(body) = self.files.get(path) else {
                return Err(FileError::new(FileErrorKind::NotFound, path));
            };
            let from = (start as usize).min(body.len());
            let to = (from + len).min(body.len());
            Ok(Chunk {
                size: body.len() as u64,
                modified: None,
                data: body[from..to].to_vec(),
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

    /// What herdr answers `pane.process_info` with.
    enum Processes {
        Rows(Vec<Value>),
        /// An old herdr: the request is refused as invalid.
        Unsupported,
        /// The connection is down.
        Down,
    }

    impl Wire for Processes {
        fn request(&self, method: &str, params: Value, _: Duration) -> Result<Value, WireError> {
            assert_eq!(method, "pane.process_info");
            assert_eq!(params, json!({"pane_id": "w1:p1"}));
            match self {
                Self::Rows(rows) => Ok(json!({"process_info": {"foreground_processes": rows}})),
                Self::Unsupported => Err(WireError::api("invalid_request", "unknown method")),
                Self::Down => Err(WireError::retryable("broken pipe")),
            }
        }

        fn events(&self, _: &[Value]) -> Result<Box<dyn EventStream>, WireError> {
            Err(WireError::retryable("no events here"))
        }
    }

    const SID: &str = "3f1c9a52-7d0e-4b6a-9a11-0c5d2e8b7f41";

    fn agent(kind: &str, session: Option<(&str, &str)>) -> AgentInfo {
        AgentInfo {
            pane_id: "w1:p1".into(),
            workspace_id: "w1".into(),
            tab_id: "w1:t1".into(),
            agent: Some(kind.into()),
            cwd: Some("/work/app".into()),
            agent_session: session.map(|(k, value)| AgentSession {
                agent: kind.into(),
                kind: match k {
                    "path" => AgentSessionKind::Path,
                    "id" => AgentSessionKind::Id,
                    _ => AgentSessionKind::Unknown,
                },
                value: value.into(),
                ..AgentSession::default()
            }),
            ..AgentInfo::default()
        }
    }

    fn locate(locator: &dyn Locator, fs: &MemFs, wire: &Processes, agent: &AgentInfo) -> Location {
        locator.locate(&LocateCtx {
            agent,
            pane: None,
            files: fs,
            wire,
            home: Some("/home/dev"),
        })
    }

    fn located(l: Location) -> String {
        match l {
            Location::Located(p) => p,
            other => panic!("expected a located log, got {other:?}"),
        }
    }

    fn unlinked(l: Location) -> String {
        match l {
            Location::Unlinked(why) => why,
            other => panic!("expected an unlinked pane, got {other:?}"),
        }
    }

    fn claude_log(id: &str) -> String {
        format!("/home/dev/.claude/projects/-work-app/{id}.jsonl")
    }

    fn pid_file(pid: i64, id: &str, kind: &str) -> String {
        format!(r#"{{"pid":{pid},"sessionId":"{id}","cwd":"/work/app","kind":"{kind}"}}"#)
    }

    fn claude(fs: &MemFs, wire: &Processes, a: &AgentInfo) -> Location {
        locate(&ClaudeLocator::new(), fs, wire, a)
    }

    #[test]
    fn omp_names_its_log_and_only_a_readable_one_is_used() {
        let ok = "/home/dev/.omp/agent/sessions/-src-app/2026-10-07_abc123.jsonl";
        let omp = |value| agent("omp", Some(("path", value)));
        assert_eq!(
            located(locate(
                &OmpLocator,
                &MemFs::new(),
                &Processes::Unsupported,
                &omp(ok)
            )),
            ok
        );
        assert!(OmpLocator.may_locate(&omp(ok)));
        assert!(!OmpLocator.may_locate(&agent("omp", None)));
        assert!(!OmpLocator.may_locate(&agent("omp", Some(("id", "abc")))));
        assert_eq!(
            unlinked(locate(
                &OmpLocator,
                &MemFs::new(),
                &Processes::Unsupported,
                &omp("/home/dev/../x.jsonl")
            )),
            "This agent does not name a session log."
        );
    }

    #[test]
    fn a_log_path_is_absolute_a_jsonl_short_and_free_of_odd_characters() {
        for good in ["/a.jsonl", "/home/dev/x y/é.jsonl", "/home/dev/..x/a.jsonl"] {
            assert!(is_readable_log_path(good), "{good}");
        }
        let long = format!("/{}.jsonl", "a".repeat(4096));
        for bad in [
            "relative/s.jsonl",
            "/home/dev/../root/secret.jsonl",
            "/home/dev/notes.txt",
            "/home/dev/x\n.jsonl",
            "/home/dev/x\u{0}.jsonl",
            "/home/dev/x\u{7f}.jsonl",
            "/home/dev/..",
            "",
            long.as_str(),
        ] {
            assert!(!is_readable_log_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn claude_a_path_from_herdr_is_the_log_once_the_file_exists_and_not_yet_before_the_first_message()
     {
        let a = agent("claude", Some(("path", &claude_log(SID))));
        let before = claude(&MemFs::new(), &Processes::Rows(vec![]), &a);
        assert_eq!(before, Location::NotYet(ClaudeLocator::NOT_YET_WHY.into()));

        let mut fs = MemFs::new();
        fs.file(&claude_log(SID), "{}\n");
        assert_eq!(
            located(claude(&fs, &Processes::Rows(vec![]), &a)),
            claude_log(SID)
        );
    }

    #[test]
    fn claude_a_session_whose_folders_were_all_looked_into_is_not_scanned_again_on_the_next_poll() {
        let mut fs = MemFs::new();
        fs.dir("/home/dev/.claude/projects/-other", None);
        let a = agent("claude", Some(("id", SID)));
        let locator = ClaudeLocator::new();
        let wire = Processes::Rows(vec![]);
        locate(&locator, &fs, &wire, &a);
        fs.calls.lock().clear();

        assert!(matches!(
            locate(&locator, &fs, &wire, &a),
            Location::NotYet(_)
        ));
        assert_eq!(fs.lists(), 0);
    }

    #[test]
    fn claude_a_path_with_dot_dot_or_a_control_character_is_refused_not_followed() {
        for bad in [
            "/home/dev/../etc/x.jsonl",
            "/home/dev/a\nb.jsonl",
            "relative.jsonl",
        ] {
            let a = agent("claude", Some(("path", bad)));
            unlinked(claude(&MemFs::new(), &Processes::Rows(vec![]), &a));
        }
    }

    #[test]
    fn claude_the_running_process_wins_over_a_session_herdr_reported_earlier() {
        let other = "9d2e0c11-4a52-4f0e-8a3b-77aa11bb22cc";
        let stale = claude_log(other);
        let mut fs = MemFs::new();
        fs.file(&stale, "{}\n").file(&claude_log(SID), "{}\n").file(
            "/home/dev/.claude/sessions/4242.json",
            &pid_file(4242, SID, "interactive"),
        );
        let wire = Processes::Rows(vec![
            json!({"pid": 4242, "name": "2.1.293", "argv0": "claude"}),
        ]);

        let found = claude(&fs, &wire, &agent("claude", Some(("path", &stale))));

        assert_eq!(located(found), claude_log(SID));
    }

    #[test]
    fn claude_with_no_process_to_ask_the_reported_session_is_used() {
        let mut fs = MemFs::new();
        fs.file(&claude_log(SID), "{}\n");
        let found = claude(
            &fs,
            &Processes::Unsupported,
            &agent("claude", Some(("path", &claude_log(SID)))),
        );
        assert_eq!(located(found), claude_log(SID));
    }

    #[test]
    fn claude_an_id_is_found_in_the_folder_its_working_directory_names() {
        let mut fs = MemFs::new();
        fs.file(&claude_log(SID), "{}\n");
        let found = claude(
            &fs,
            &Processes::Rows(vec![]),
            &agent("claude", Some(("id", SID))),
        );
        assert_eq!(located(found), claude_log(SID));
    }

    #[test]
    fn claude_an_id_is_found_by_scanning_the_project_folders_when_the_cwd_names_another_one() {
        let mut fs = MemFs::new();
        fs.dir("/home/dev/.claude/projects/-other", None);
        let renamed = format!("/home/dev/.claude/projects/-private-work-app/{SID}.jsonl");
        fs.file(&renamed, "{}\n");
        let found = claude(
            &fs,
            &Processes::Rows(vec![]),
            &agent("claude", Some(("id", SID))),
        );
        assert_eq!(located(found), renamed);
    }

    #[test]
    fn claude_the_newest_project_folder_is_looked_into_first() {
        let mut fs = MemFs::new();
        let old = format!("/home/dev/.claude/projects/-old/{SID}.jsonl");
        let new = format!("/home/dev/.claude/projects/-new/{SID}.jsonl");
        fs.dir("/home/dev/.claude/projects/-old", Some(100))
            .dir("/home/dev/.claude/projects/-new", Some(200));
        fs.file(&old, "{}\n").file(&new, "{}\n");
        fs.dir("/home/dev/.claude/projects/-old", Some(100))
            .dir("/home/dev/.claude/projects/-new", Some(200));
        let found = claude(
            &fs,
            &Processes::Rows(vec![]),
            &agent("claude", Some(("id", SID))),
        );
        assert_eq!(located(found), new);
    }

    #[test]
    fn claude_an_id_whose_file_is_not_there_yet_is_not_yet_not_a_failure() {
        let mut fs = MemFs::new();
        fs.dir("/home/dev/.claude/projects/-work-app", None);
        let found = claude(
            &fs,
            &Processes::Rows(vec![]),
            &agent("claude", Some(("id", SID))),
        );
        assert_eq!(found, Location::NotYet(ClaudeLocator::NOT_YET_WHY.into()));
    }

    #[test]
    fn claude_without_a_session_reference_the_running_claude_process_names_its_session() {
        let mut fs = MemFs::new();
        fs.file(
            "/home/dev/.claude/sessions/4242.json",
            &pid_file(4242, SID, "interactive"),
        )
        .file(&claude_log(SID), "{}\n");
        let wire = Processes::Rows(vec![
            json!({"pid": 1, "name": "zsh"}),
            // An MCP helper with .claude in its path, and Claude itself, whose name herdr gives as the version.
            json!({"pid": 99, "name": "node", "argv0": "node",
                   "cmdline": "node /home/dev/.claude/plugins/x/server.js"}),
            json!({"pid": 4242, "name": "2.1.293", "argv0": "claude", "cmdline": "claude --resume"}),
        ]);
        assert_eq!(
            located(claude(&fs, &wire, &agent("claude", None))),
            claude_log(SID)
        );
    }

    #[test]
    fn claude_a_process_is_claude_by_argv0_command_word_or_name_and_not_by_a_path() {
        let is = |row: Value| PaneProcess::parse(&row).is_some_and(|p| p.is_claude());
        assert!(is(
            json!({"pid": 5, "name": "2.1.2", "argv0": "/usr/local/bin/claude"})
        ));
        assert!(is(
            json!({"pid": 5, "name": "node", "cmdline": "  /opt/bin/claude --x"})
        ));
        assert!(is(json!({"pid": 5, "name": "claude"})));
        assert!(!is(
            json!({"pid": 5, "name": "node", "cmdline": "node /home/dev/.claude/s.js"})
        ));
        assert!(!is(json!({"pid": 0, "name": "claude"})));
        assert!(
            !is(json!({"name": "claude"})),
            "a row without a pid is not a process"
        );
    }

    #[test]
    fn claude_no_reference_and_no_pid_file_says_how_to_link_it() {
        let wire = Processes::Rows(vec![json!({"pid": 4242, "name": "claude"})]);
        let why = unlinked(claude(&MemFs::new(), &wire, &agent("claude", None)));
        assert!(why.contains("herdr integration install claude"));
    }

    #[test]
    fn claude_an_old_herdr_without_pane_process_info_is_unlinked_not_an_error() {
        unlinked(claude(
            &MemFs::new(),
            &Processes::Unsupported,
            &agent("claude", None),
        ));
    }

    #[test]
    fn claude_a_pid_file_that_is_not_an_interactive_session_belongs_to_another_pid_or_has_a_bad_id_is_not_used()
     {
        for body in [
            pid_file(7, SID, "interactive"),
            pid_file(4242, SID, "sdk"),
            pid_file(4242, "../../x", "interactive"),
            "not json".to_owned(),
            "[1]".to_owned(),
        ] {
            let mut fs = MemFs::new();
            fs.file("/home/dev/.claude/sessions/4242.json", &body);
            let wire = Processes::Rows(vec![json!({"pid": 4242, "name": "claude"})]);
            unlinked(claude(&fs, &wire, &agent("claude", None)));
        }
    }

    #[test]
    fn claude_a_pid_file_over_its_cap_is_not_read_as_a_session() {
        let mut fs = MemFs::new();
        let padding = " ".repeat(ClaudeLocator::MAX_PID_FILE);
        fs.file(
            "/home/dev/.claude/sessions/4242.json",
            &format!("{}{padding}", pid_file(4242, SID, "interactive")),
        );
        let wire = Processes::Rows(vec![json!({"pid": 4242, "name": "claude"})]);
        unlinked(claude(&fs, &wire, &agent("claude", None)));
    }

    #[test]
    fn claude_a_working_directory_becomes_a_project_folder_name_as_claude_makes_it() {
        assert_eq!(project_folder("/work/app"), "-work-app");
        assert_eq!(project_folder("/home/dev/my.proj_2"), "-home-dev-my-proj-2");
        assert_eq!(project_folder("/h/é"), "-h--");
        assert_eq!(
            project_folder("/h/😀"),
            "-h---",
            "two UTF-16 units, two dashes"
        );
    }

    #[test]
    fn claude_a_machine_that_does_not_answer_is_not_yet_with_the_reason() {
        let mut fs = MemFs::new();
        fs.unreachable = true;
        let found = claude(
            &fs,
            &Processes::Rows(vec![]),
            &agent("claude", Some(("id", SID))),
        );
        let Location::NotYet(why) = found else {
            panic!("expected not yet, got {found:?}");
        };
        assert!(why.contains("link lost"), "{why}");
        let down = claude(&MemFs::new(), &Processes::Down, &agent("claude", None));
        assert!(matches!(down, Location::NotYet(w) if w.contains("broken pipe")));
    }

    #[test]
    fn claude_the_board_offers_the_chat_for_any_claude_pane() {
        let locator = ClaudeLocator::new();
        assert!(locator.may_locate(&agent("claude", None)));
        assert!(!locator.may_locate(&agent("omp", None)));
    }

    // 2026-09-06T14:03:17.xxxZ, a UUIDv7.
    const CODEX_ID: &str = "01a07707-d5c0-7b3a-8c11-5d0e2f9a4b67";

    fn rollout(stamp: &str, ext: &str) -> String {
        format!("rollout-{stamp}-{CODEX_ID}.{ext}")
    }

    fn codex(fs: &MemFs, locator: &CodexLocator, id: &str) -> Location {
        locate(
            locator,
            fs,
            &Processes::Unsupported,
            &agent("codex", Some(("id", id))),
        )
    }

    #[test]
    fn codex_a_v7_id_is_found_in_the_day_folder_of_its_creation_time() {
        let path = format!(
            "/home/dev/.codex/sessions/2026/09/06/{}",
            rollout("2026-09-06T21-03-17", "jsonl")
        );
        let mut fs = MemFs::new();
        fs.file(&path, "{}\n");
        assert_eq!(located(codex(&fs, &CodexLocator::new(), CODEX_ID)), path);
        assert!(fs.lists() <= 2, "no scan: {} listings", fs.lists());
    }

    #[test]
    fn codex_and_in_the_next_day_folder_when_the_host_clock_is_ahead_of_utc() {
        let path = format!(
            "/home/dev/.codex/sessions/2026/09/07/{}",
            rollout("2026-09-07T05-03-17", "jsonl")
        );
        let mut fs = MemFs::new();
        fs.file(&path, "{}\n");
        assert_eq!(located(codex(&fs, &CodexLocator::new(), CODEX_ID)), path);
    }

    #[test]
    fn codex_and_in_the_previous_day_folder_when_the_host_clock_is_behind_utc() {
        let path = format!(
            "/home/dev/.codex/sessions/2026/09/05/{}",
            rollout("2026-09-05T23-03-17", "jsonl")
        );
        let mut fs = MemFs::new();
        fs.file(&path, "{}\n");
        assert_eq!(located(codex(&fs, &CodexLocator::new(), CODEX_ID)), path);
    }

    #[test]
    fn codex_an_id_that_is_not_v7_is_found_by_walking_the_date_folders_newest_first_within_40_listings()
     {
        let old = "00000000-0000-4000-8000-0123456789ab";
        let mut fs = MemFs::new();
        fs.file(
            &format!(
                "/home/dev/.codex/sessions/2025/03/02/rollout-2025-03-02T10-00-00-{old}.jsonl"
            ),
            "{}\n",
        );
        for d in 1..=9 {
            fs.file(
                &format!("/home/dev/.codex/sessions/2026/09/0{d}/rollout-2026-09-0{d}-other.jsonl"),
                "{}\n",
            );
        }
        let found = codex(&fs, &CodexLocator::new(), old);
        assert!(located(found).ends_with(&format!("-{old}.jsonl")));
        assert!(fs.lists() <= CodexLocator::MAX_LISTS);
    }

    #[test]
    fn codex_a_walk_gives_up_after_40_listings() {
        let mut fs = MemFs::new();
        for d in 1..=60 {
            fs.dir(&format!("/home/dev/.codex/sessions/2026/09/{d:02}"), None);
        }
        let found = codex(
            &fs,
            &CodexLocator::new(),
            "00000000-0000-4000-8000-0123456789ab",
        );
        assert!(matches!(found, Location::NotYet(_)));
        assert_eq!(fs.lists(), CodexLocator::MAX_LISTS);
    }

    #[test]
    fn codex_a_session_only_found_compressed_says_to_resume_it() {
        let mut fs = MemFs::new();
        fs.file(
            &format!(
                "/home/dev/.codex/sessions/2026/09/06/{}",
                rollout("2026-09-06T21-03-17", "jsonl.zst")
            ),
            "x",
        );
        let why = unlinked(codex(&fs, &CodexLocator::new(), CODEX_ID));
        assert!(why.contains("Resume it in Codex"));
    }

    #[test]
    fn codex_nothing_yet_is_not_yet_because_codex_writes_the_file_with_the_first_prompt() {
        let mut fs = MemFs::new();
        fs.dir("/home/dev/.codex/sessions", None);
        assert_eq!(
            codex(&fs, &CodexLocator::new(), CODEX_ID),
            Location::NotYet(CodexLocator::NOT_YET_WHY.into())
        );
    }

    #[test]
    fn codex_a_pane_with_no_session_reference_cannot_be_linked_and_says_how() {
        let locator = CodexLocator::new();
        let a = agent("codex", None);
        assert!(!locator.may_locate(&a));
        assert!(locator.may_locate(&agent("codex", Some(("id", CODEX_ID)))));
        let why = unlinked(locate(&locator, &MemFs::new(), &Processes::Unsupported, &a));
        assert!(why.contains("herdr integration install codex"));
    }

    #[test]
    fn codex_a_reported_path_is_the_log_and_an_unreadable_one_is_unlinked() {
        let ok = "/home/dev/.codex/sessions/2026/09/06/rollout-x.jsonl";
        let at = |value| {
            locate(
                &CodexLocator::new(),
                &MemFs::new(),
                &Processes::Unsupported,
                &agent("codex", Some(("path", value))),
            )
        };
        assert_eq!(located(at(ok)), ok);
        unlinked(at("/home/dev/../x.jsonl"));
    }

    #[test]
    fn codex_an_id_that_is_not_a_uuid_never_reaches_a_path() {
        let fs = MemFs::new();
        let found = codex(&fs, &CodexLocator::new(), "../../etc/passwd");
        assert!(matches!(found, Location::NotYet(_)));
        assert!(fs.calls.lock().is_empty());
    }

    #[test]
    fn codex_a_found_file_is_remembered_so_the_second_look_lists_nothing() {
        let path = format!(
            "/home/dev/.codex/sessions/2026/09/06/{}",
            rollout("2026-09-06T21-03-17", "jsonl")
        );
        let mut fs = MemFs::new();
        fs.file(&path, "{}\n");
        let locator = CodexLocator::new();
        codex(&fs, &locator, CODEX_ID);
        fs.calls.lock().clear();
        assert_eq!(located(codex(&fs, &locator, CODEX_ID)), path);
        assert!(fs.calls.lock().is_empty());
    }

    #[test]
    fn codex_dates_come_from_the_ids_milliseconds_in_utc() {
        assert_eq!(civil_from_ms(0), (1970, 1, 1));
        assert_eq!(civil_from_ms(0x01a0_7707_d5c0), (2026, 9, 6));
        assert_eq!(civil_from_ms(951_782_400_000 + 86_399_999), (2000, 2, 29));
        assert_eq!(civil_from_ms(951_782_400_000 + 86_400_000), (2000, 3, 1));
    }

    #[test]
    fn the_kind_of_a_pane_is_what_its_session_says_else_what_herdr_detected() {
        let mut a = agent("omp", None);
        assert_eq!(kind_of(&a), Some("omp"));
        a.agent_session = Some(AgentSession {
            agent: "claude".into(),
            kind: AgentSessionKind::Id,
            value: SID.into(),
            ..AgentSession::default()
        });
        assert_eq!(kind_of(&a), Some("claude"));
        a.agent_session.as_mut().unwrap().agent.clear();
        assert_eq!(kind_of(&a), Some("omp"));
        a.agent_session.as_mut().unwrap().value.clear();
        assert!(session_of(&a).is_none(), "a session with no value is none");
    }
}
