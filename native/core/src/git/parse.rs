//! Reading what `git status --porcelain=v2 -z` and `git diff --numstat -z` print.

/// What happened to a file, in the groups the Changes list shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeKind {
    /// Changed content, mode or type.
    Modified,
    /// New to git: added, copied, or intent-to-add.
    Added,
    /// Gone from the working tree (or staged for removal).
    Deleted,
    /// Moved, with or without edits (git's own detection of a staged move).
    Renamed,
    /// New and not added to git.
    Untracked,
    /// Both sides changed it and nobody resolved it.
    Conflicted,
}

/// One changed file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    /// Relative to the repository root, as git lists it.
    pub path: String,
    /// Where a renamed file came from.
    pub old_path: Option<String>,
    /// What happened to it.
    pub kind: ChangeKind,
    /// Something of it is in git's index (`git add` was run).
    pub staged: bool,
    /// Its working-tree file differs from the index.
    pub unstaged: bool,
    /// Lines added since the last commit (`None` when it could not be counted: a binary file, a very big one).
    pub added: Option<u32>,
    /// Lines removed since the last commit.
    pub removed: Option<u32>,
    /// git treats it as binary: there are no lines to show.
    pub binary: bool,
    /// A submodule: its change is a new commit, not text.
    pub submodule: bool,
    /// Its size on disk when known (an untracked or binary file).
    pub size: Option<u64>,
    /// Changes whenever the file's change does; what a `reviewed` mark is saved against.
    pub fingerprint: String,
}

/// What a checkout is on and what changed in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// The repository's working-tree root (absolute).
    pub root: String,
    /// The branch checked out; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// HEAD is not on a branch.
    pub detached: bool,
    /// No commit exists yet.
    pub unborn: bool,
    /// The first 7 characters of HEAD's commit.
    pub head: Option<String>,
    /// The branch it follows (`origin/main`).
    pub upstream: Option<String>,
    /// Commits here that the upstream does not have.
    pub ahead: u32,
    /// Commits there that are not here.
    pub behind: u32,
    /// A linked worktree of a repository, not its main checkout.
    pub linked: bool,
    /// Changed files: conflicts first, then by path.
    pub files: Vec<Change>,
    /// There were more changed files than are listed (`FILES_MAX`, or the output limit).
    pub truncated: bool,
    /// How many files listed have unresolved merge conflicts.
    pub conflicts: usize,
}

/// One entry of the status before it is joined with the numbers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub staged: bool,
    pub unstaged: bool,
    pub submodule: bool,
    /// The blob ids of the file in HEAD and in the index (`0000…` when it has none).
    pub head_id: String,
    pub index_id: String,
}

/// The header lines and entries of `git status --porcelain=v2 --branch -z`.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RawStatus {
    pub oid: String,
    pub head: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub entries: Vec<Entry>,
}

/// Reads the status. A record that is not understood is skipped: a newer git adding a line must not break the tab.
pub(crate) fn parse_status(bytes: &[u8]) -> RawStatus {
    let mut out = RawStatus::default();
    let text = String::from_utf8_lossy(bytes);
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        if let Some(rest) = record.strip_prefix("# ") {
            header(&mut out, rest);
            continue;
        }
        let kind = record.as_bytes()[0];
        match kind {
            b'1' => {
                // 1 XY sub mH mI mW hH hI path
                let f: Vec<&str> = record.splitn(9, ' ').collect();
                if f.len() == 9 {
                    out.entries.push(entry(f[1], f[2], f[6], f[7], f[8], None));
                }
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
                let f: Vec<&str> = record.splitn(10, ' ').collect();
                let orig = records.next();
                if f.len() == 10 {
                    out.entries
                        .push(entry(f[1], f[2], f[6], f[7], f[9], orig.map(str::to_owned)));
                }
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let f: Vec<&str> = record.splitn(11, ' ').collect();
                if f.len() == 11 {
                    out.entries.push(Entry {
                        path: f[10].to_owned(),
                        old_path: None,
                        kind: ChangeKind::Conflicted,
                        staged: false,
                        unstaged: true,
                        submodule: f[2].starts_with('S'),
                        head_id: f[7].to_owned(),
                        index_id: f[8].to_owned(),
                    });
                }
            }
            b'?' => {
                if let Some(path) = record.strip_prefix("? ") {
                    out.entries.push(Entry {
                        path: path.to_owned(),
                        old_path: None,
                        kind: ChangeKind::Untracked,
                        staged: false,
                        unstaged: true,
                        submodule: false,
                        head_id: String::new(),
                        index_id: String::new(),
                    });
                }
            }
            // `!` is an ignored file (never asked for); anything else is a record from a newer git.
            _ => {}
        }
    }
    out
}

fn header(out: &mut RawStatus, line: &str) {
    if let Some(oid) = line.strip_prefix("branch.oid ") {
        out.oid = oid.to_owned();
    } else if let Some(head) = line.strip_prefix("branch.head ") {
        out.head = head.to_owned();
    } else if let Some(upstream) = line.strip_prefix("branch.upstream ") {
        out.upstream = Some(upstream.to_owned());
    } else if let Some(ab) = line.strip_prefix("branch.ab ") {
        for word in ab.split(' ') {
            if let Some(n) = word.strip_prefix('+') {
                out.ahead = n.parse().unwrap_or(0);
            } else if let Some(n) = word.strip_prefix('-') {
                out.behind = n.parse().unwrap_or(0);
            }
        }
    }
}

fn entry(
    xy: &str,
    sub: &str,
    head_id: &str,
    index_id: &str,
    path: &str,
    orig: Option<String>,
) -> Entry {
    let mut chars = xy.chars();
    let (x, y) = (chars.next().unwrap_or('.'), chars.next().unwrap_or('.'));
    let kind = if orig.is_some() {
        if x == 'C' || y == 'C' {
            ChangeKind::Added
        } else {
            ChangeKind::Renamed
        }
    } else if x == 'D' || y == 'D' {
        ChangeKind::Deleted
    } else if x == 'A' || y == 'A' {
        ChangeKind::Added
    } else {
        ChangeKind::Modified
    };
    Entry {
        path: path.to_owned(),
        // A copy is a new file as far as a review goes; only a move names where it came from.
        old_path: if kind == ChangeKind::Renamed {
            orig
        } else {
            None
        },
        kind,
        staged: x != '.',
        unstaged: y != '.',
        submodule: sub.starts_with('S'),
        head_id: head_id.to_owned(),
        index_id: index_id.to_owned(),
    }
}

/// One line of `git diff --numstat -z`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Numstat {
    pub path: String,
    /// `None` for a binary file.
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// Reads `--numstat -z`: `added TAB removed TAB path NUL`, and for a rename `added TAB removed TAB NUL old NUL new NUL`.
pub(crate) fn parse_numstat(bytes: &[u8]) -> Vec<Numstat> {
    let text = String::from_utf8_lossy(bytes);
    let tokens: Vec<&str> = text.split('\0').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let record = tokens[i];
        if record.is_empty() {
            i += 1;
            continue;
        }
        let mut parts = record.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            i += 1;
            continue;
        };
        let (added, removed) = (a.parse().ok(), r.parse().ok());
        if path.is_empty() {
            // A rename: the next two tokens are the old and the new name.
            if let Some(new) = tokens.get(i + 2) {
                out.push(Numstat {
                    path: (*new).to_owned(),
                    added,
                    removed,
                });
            }
            i += 3;
        } else {
            out.push(Numstat {
                path: path.to_owned(),
                added,
                removed,
            });
            i += 1;
        }
    }
    out
}
