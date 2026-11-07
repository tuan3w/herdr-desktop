//! The operations of the Changes tab, over any [`Runner`].

use std::collections::HashMap;
use std::sync::Arc;

use super::diff::{
    FileDiff, cut_lines, groups_of, parse_patch, patch_fingerprint, reverse_group, whole_lines,
};
use super::parse::{Change, ChangeKind, Entry, Numstat, Status, parse_numstat, parse_status};
use super::{
    BACKUP_CAP, Call, DIFF_CAP, DIFF_CAP_ALL, DIFF_LINES, DIFF_LINES_ALL, FILES_MAX, GIT_TIMEOUT,
    GitError, GitErrorKind, HASH_MAX, PROBE_MAX, Probe, Raw, Runner, STATUS_CAP, UndoStore,
    fingerprint, validate_dir, validate_rel,
};

/// How a file's diff is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiffOptions {
    /// Unchanged lines around each change (git's `-U`).
    pub context: u32,
    /// `Show all`: the bigger limits.
    pub all: bool,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            context: 3,
            all: false,
        }
    }
}

/// A revert that can be taken back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Undone {
    /// What `undo` takes.
    pub id: String,
}

/// What a checkout has changed, and the two ways to take a change back. One value per machine; cheap to clone.
#[derive(Clone)]
pub struct Git {
    runner: Arc<dyn Runner>,
}

/// The standard flags of every patch we read: plain text, the usual `a/` and `b/`, no program a config names.
const PATCH_FLAGS: &[&str] = &[
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
];

fn kind_word(kind: ChangeKind) -> &'static [u8] {
    match kind {
        ChangeKind::Modified => b"modified",
        ChangeKind::Added => b"added",
        ChangeKind::Deleted => b"deleted",
        ChangeKind::Renamed => b"renamed",
        ChangeKind::Untracked => b"untracked",
        ChangeKind::Conflicted => b"conflicted",
    }
}

/// `git <command> <flags> <patch flags> [tree] <paths>`: the arguments of a patch of tracked files.
fn tracked<'a>(
    command: &[&'a str],
    flags: &[&'a str],
    tree: &'a str,
    paths: &[&'a str],
) -> Vec<&'a str> {
    let mut args: Vec<&str> = command.to_vec();
    args.extend_from_slice(flags);
    args.extend_from_slice(PATCH_FLAGS);
    if !tree.is_empty() {
        args.push(tree);
    }
    args.extend_from_slice(paths);
    args
}

/// git's way of saying the repository has no commit to compare with.
fn no_head(raw: &Raw) -> bool {
    raw.stderr.contains("bad revision")
        || raw.stderr.contains("unknown revision")
        || raw.stderr.contains("ambiguous argument 'HEAD'")
        || raw.stderr.contains("Not a valid object name HEAD")
        || raw.stderr.contains("not a valid object name")
}

fn failed(raw: &Raw) -> GitError {
    let last = raw
        .stderr
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("git failed")
        .trim();
    GitError::new(
        GitErrorKind::Failed,
        last.trim_start_matches("fatal: ").to_owned(),
    )
}

impl Git {
    /// Git through `runner`.
    pub fn new(runner: Arc<dyn Runner>) -> Self {
        Self { runner }
    }

    fn call(&self, dir: &str, args: &[&str], stdin: &[u8], cap: usize) -> Result<Raw, GitError> {
        self.runner.run(
            dir,
            &Call {
                args,
                stdin,
                cap,
                timeout: GIT_TIMEOUT,
            },
        )
    }

    /// Runs a command that must succeed and returns its output.
    fn must(
        &self,
        dir: &str,
        args: &[&str],
        stdin: &[u8],
        cap: usize,
    ) -> Result<Vec<u8>, GitError> {
        let raw = self.call(dir, args, stdin, cap)?;
        if raw.code == 0 {
            Ok(raw.stdout)
        } else {
            Err(failed(&raw))
        }
    }

    /// The root of the repository `dir` is in, and whether it is a linked worktree.
    fn root_of(&self, dir: &str) -> Result<(String, bool), GitError> {
        validate_dir(dir)?;
        let mut raw = self.call(
            dir,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-dir",
                "--git-common-dir",
            ],
            &[],
            64 * 1024,
        )?;
        if raw.code == 129 {
            // A git older than 2.31 does not know `--path-format`.
            raw = self.call(
                dir,
                &[
                    "rev-parse",
                    "--show-toplevel",
                    "--git-dir",
                    "--git-common-dir",
                ],
                &[],
                64 * 1024,
            )?;
        }
        if raw.code != 0 {
            let said = raw.stderr.to_lowercase();
            return Err(if said.contains("not a git repository") {
                GitError::new(
                    GitErrorKind::NotARepo,
                    "This folder is not in a git repository",
                )
            } else if said.contains("work tree") || said.contains("bare") {
                GitError::new(
                    GitErrorKind::NotARepo,
                    "This is a bare repository: it has no files to review",
                )
            } else {
                failed(&raw)
            });
        }
        let text = String::from_utf8_lossy(&raw.stdout);
        let mut lines = text.lines();
        let (Some(top), Some(git_dir), Some(common)) = (lines.next(), lines.next(), lines.next())
        else {
            return Err(GitError::new(
                GitErrorKind::Failed,
                "git did not say where the repository is",
            ));
        };
        Ok((top.to_owned(), git_dir != common))
    }

    /// What `dir`'s checkout is on and every file it has changed since the last commit (staged or not), with counts.
    pub fn status(&self, dir: &str) -> Result<Status, GitError> {
        let (root, linked) = self.root_of(dir)?;
        let (status, numstat) = std::thread::scope(|scope| {
            let numstat = scope.spawn(|| {
                self.call(
                    &root,
                    &[
                        &["diff-index", "--numstat", "-z", "--find-renames", "HEAD"][..],
                        PATCH_FLAGS,
                    ]
                    .concat(),
                    &[],
                    STATUS_CAP,
                )
            });
            let status = self.call(
                &root,
                &[
                    "status",
                    "--porcelain=v2",
                    "--branch",
                    "-z",
                    "--untracked-files=all",
                ],
                &[],
                STATUS_CAP,
            );
            (status, numstat.join())
        });
        let status = status?;
        if status.code != 0 {
            return Err(failed(&status));
        }
        let mut parsed = parse_status(&status.stdout);
        let mut truncated = status.truncated;
        if truncated {
            // The last record may be cut in the middle.
            parsed.entries.pop();
        }
        let unborn = parsed.oid == "(initial)";
        let numstat = match numstat {
            Ok(Ok(raw)) if raw.code == 0 => Some(raw),
            _ if unborn => {
                let args = [&["diff", "--cached", "--numstat", "-z"][..], PATCH_FLAGS].concat();
                self.call(&root, &args, &[], STATUS_CAP)
                    .ok()
                    .filter(|r| r.code == 0)
            }
            _ => None,
        };
        let counts: HashMap<String, Numstat> = numstat
            .map(|raw| parse_numstat(&raw.stdout))
            .unwrap_or_default()
            .into_iter()
            .map(|n| (n.path.clone(), n))
            .collect();

        let mut entries = parsed.entries;
        if entries.len() > FILES_MAX {
            entries.truncate(FILES_MAX);
            truncated = true;
        }
        let mut files = self.changes(&root, entries, &counts);
        files.sort_by(|a, b| {
            (a.kind != ChangeKind::Conflicted)
                .cmp(&(b.kind != ChangeKind::Conflicted))
                .then_with(|| a.path.cmp(&b.path))
        });
        let conflicts = files
            .iter()
            .filter(|c| c.kind == ChangeKind::Conflicted)
            .count();
        let detached = parsed.head == "(detached)";
        Ok(Status {
            root,
            branch: (!detached && !parsed.head.is_empty()).then_some(parsed.head),
            detached,
            unborn,
            head: (!unborn && parsed.oid.len() >= 7).then(|| parsed.oid[..7].to_owned()),
            upstream: parsed.upstream,
            ahead: parsed.ahead,
            behind: parsed.behind,
            linked,
            files,
            truncated,
            conflicts,
        })
    }

    /// Joins the status entries with their numbers and fingerprints.
    fn changes(
        &self,
        root: &str,
        entries: Vec<Entry>,
        counts: &HashMap<String, Numstat>,
    ) -> Vec<Change> {
        // Untracked files have no diff to count, and a binary one has no lines: look at the files themselves.
        let probed: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                !e.path.ends_with('/')
                    && (e.kind == ChangeKind::Untracked
                        || counts.get(&e.path).is_some_and(|n| n.added.is_none()))
            })
            .map(|(i, _)| i)
            .take(PROBE_MAX)
            .collect();
        let paths: Vec<String> = probed.iter().map(|&i| entries[i].path.clone()).collect();
        let mut probes: HashMap<usize, Probe> = HashMap::new();
        if let Ok(answers) = self.runner.probe(root, &paths) {
            for (&i, answer) in probed.iter().zip(answers) {
                if let Some(p) = answer {
                    probes.insert(i, p);
                }
            }
        }

        let mut out: Vec<Change> = entries
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let probe = probes.get(&i);
                let numbers = counts.get(&e.path);
                let nested = e.path.ends_with('/');
                let (mut added, mut removed, mut binary) = (None, None, false);
                if let Some(n) = numbers {
                    (added, removed, binary) = (n.added, n.removed, n.added.is_none());
                }
                if let Some(p) = probe {
                    binary = p.binary;
                    if e.kind == ChangeKind::Untracked && !p.binary {
                        (added, removed) = (p.lines, p.lines.map(|_| 0));
                    }
                }
                Change {
                    path: e.path.clone(),
                    old_path: e.old_path.clone(),
                    kind: e.kind,
                    staged: e.staged,
                    unstaged: e.unstaged,
                    added,
                    removed,
                    binary,
                    submodule: e.submodule || nested,
                    size: probe.map(|p| p.size),
                    fingerprint: String::new(),
                }
            })
            .collect();

        // The content of the working-tree file is what tells an edit from the one before it: the line counts do not.
        let hashable: Vec<usize> = out
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                !matches!(c.kind, ChangeKind::Deleted | ChangeKind::Conflicted)
                    && !c.submodule
                    && !c.path.contains('\n')
                    && !c.path.starts_with('"')
                    && c.size.is_none_or(|s| s <= HASH_MAX)
                    && u64::from(c.added.unwrap_or(0)) + u64::from(c.removed.unwrap_or(0))
                        <= 200_000
            })
            .map(|(i, _)| i)
            .collect();
        let mut hashes: HashMap<usize, String> = HashMap::new();
        if !hashable.is_empty() {
            let mut stdin = Vec::new();
            for &i in &hashable {
                stdin.extend_from_slice(out[i].path.as_bytes());
                stdin.push(b'\n');
            }
            if let Ok(bytes) =
                self.must(root, &["hash-object", "--stdin-paths"], &stdin, STATUS_CAP)
            {
                let text = String::from_utf8_lossy(&bytes);
                let ids: Vec<&str> = text.lines().collect();
                if ids.len() == hashable.len() {
                    for (&i, id) in hashable.iter().zip(ids) {
                        hashes.insert(i, id.to_owned());
                    }
                }
            }
        }
        for (i, change) in out.iter_mut().enumerate() {
            let (head, index) = (&entries[i].head_id, &entries[i].index_id);
            change.fingerprint = fingerprint(&[
                kind_word(change.kind),
                head.as_bytes(),
                index.as_bytes(),
                hashes.get(&i).map_or("", String::as_str).as_bytes(),
                change
                    .added
                    .map_or("-".to_owned(), |n| n.to_string())
                    .as_bytes(),
                change
                    .removed
                    .map_or("-".to_owned(), |n| n.to_string())
                    .as_bytes(),
            ]);
        }
        out
    }

    /// The patch of one file of `root` (as `status` listed it: `old_path` for a moved file) since the last commit.
    pub fn diff(
        &self,
        root: &str,
        path: &str,
        old_path: Option<&str>,
        kind: ChangeKind,
        options: DiffOptions,
    ) -> Result<FileDiff, GitError> {
        validate_dir(root)?;
        validate_rel(path.trim_end_matches('/'))?;
        if let Some(old) = old_path {
            validate_rel(old)?;
        }
        let (cap, max_lines) = if options.all {
            (DIFF_CAP_ALL, DIFF_LINES_ALL)
        } else {
            (DIFF_CAP, DIFF_LINES)
        };
        let empty = |binary: bool, conflicted: bool| FileDiff {
            path: path.to_owned(),
            old_path: old_path.map(str::to_owned),
            kind,
            patch: String::new(),
            added: 0,
            removed: 0,
            binary,
            conflicted,
            truncated: false,
            lines: 0,
            groups: Vec::new(),
            fingerprint: fingerprint(&[b"empty"]),
            context: options.context,
        };
        if kind == ChangeKind::Conflicted {
            return Ok(empty(false, true));
        }
        if path.ends_with('/') {
            // A folder git lists whole: another repository inside this one.
            return Ok(empty(false, false));
        }
        let raw = self.patch_of(root, path, old_path, kind, options.context, cap)?;
        let text = String::from_utf8_lossy(&raw.stdout);
        let mut truncated = raw.truncated;
        let text = if truncated {
            whole_lines(&text)
        } else {
            &text[..]
        };
        let (text, cut) = cut_lines(text, max_lines);
        truncated |= cut;
        let patch = parse_patch(text);
        let groups = groups_of(&patch);
        let (mut added, mut removed) = (0, 0);
        for g in &groups {
            added += g.added;
            removed += g.removed;
        }
        Ok(FileDiff {
            path: path.to_owned(),
            old_path: old_path.map(str::to_owned),
            kind,
            patch: text.to_owned(),
            added,
            removed,
            binary: patch.binary,
            conflicted: false,
            truncated,
            lines: text.split_terminator('\n').count() as u32,
            fingerprint: patch_fingerprint(&patch),
            groups,
            context: options.context,
        })
    }

    /// The raw patch of a file; `-U` is the context and `cap` the bytes read.
    fn patch_of(
        &self,
        root: &str,
        path: &str,
        old_path: Option<&str>,
        kind: ChangeKind,
        context: u32,
        cap: usize,
    ) -> Result<Raw, GitError> {
        let unified = format!("-U{}", context.min(100_000));
        if kind == ChangeKind::Untracked {
            // Not in git: compare with nothing. `--no-index` exits 1 when the files differ, which is the usual case.
            let args = [
                &["diff", "--no-index", unified.as_str()][..],
                PATCH_FLAGS,
                &["--", "/dev/null", path],
            ]
            .concat();
            let raw = self.call(root, &args, &[], cap)?;
            return if raw.code <= 1 {
                Ok(raw)
            } else {
                Err(failed(&raw))
            };
        }
        let renames = if kind == ChangeKind::Renamed {
            "--find-renames"
        } else {
            "--no-renames"
        };
        let mut paths = vec!["--", path];
        if let Some(old) = old_path.filter(|_| kind == ChangeKind::Renamed) {
            paths.push(old);
        }
        let flags = [unified.as_str(), renames];
        let raw = self.call(
            root,
            &tracked(&["diff-index", "-p"], &flags, "HEAD", &paths),
            &[],
            cap,
        )?;
        if raw.code == 0 {
            return Ok(raw);
        }
        // No commit yet: what is staged is all there is to compare.
        if no_head(&raw) {
            let raw = self.call(
                root,
                &tracked(&["diff", "--cached"], &flags, "", &paths),
                &[],
                cap,
            )?;
            if raw.code == 0 {
                return Ok(raw);
            }
            return Err(failed(&raw));
        }
        Err(failed(&raw))
    }

    /// The one entry git lists for `path` now: what a destructive request is decided from, not what a screen said.
    fn entry_of(&self, root: &str, path: &str) -> Result<Entry, GitError> {
        validate_dir(root)?;
        validate_rel(path)?;
        let raw = self.must(
            root,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--untracked-files=all",
                "--",
                path,
            ],
            &[],
            STATUS_CAP,
        )?;
        parse_status(&raw)
            .entries
            .into_iter()
            .find(|e| e.path == path)
            .ok_or_else(|| {
                GitError::new(
                    GitErrorKind::Stale,
                    format!("{path} has no changes any more"),
                )
            })
    }

    /// Takes `path` back to how the last commit has it: edits gone, a deleted file back, a new file removed, a moved
    /// file moved back. What was removed is saved first (see [`UndoStore`]); a change too big to save is refused.
    pub fn revert_file(
        &self,
        root: &str,
        path: &str,
        undo: &UndoStore,
    ) -> Result<Undone, GitError> {
        let entry = self.entry_of(root, path)?;
        if entry.kind == ChangeKind::Conflicted {
            return Err(GitError::new(
                GitErrorKind::Conflicted,
                format!(
                    "{path} has merge conflicts: resolve them first, a revert would lose both sides"
                ),
            ));
        }
        if entry.path.ends_with('/') || entry.submodule {
            return Err(GitError::new(
                GitErrorKind::Invalid,
                format!("{path} is another repository: revert it from there"),
            ));
        }
        let backup = self.backup(root, &entry)?;
        let id = undo.save(root, backup.as_bytes())?;
        let steps: Vec<Vec<&str>> = match entry.kind {
            ChangeKind::Untracked => vec![vec!["clean", "-f", "-q", "--", path]],
            ChangeKind::Added => vec![vec!["rm", "-f", "-q", "--", path]],
            ChangeKind::Renamed => {
                let old = entry.old_path.as_deref().unwrap_or(path);
                vec![
                    vec!["checkout", "HEAD", "--", old],
                    vec!["rm", "-f", "-q", "--", path],
                ]
            }
            _ => vec![vec!["checkout", "HEAD", "--", path]],
        };
        for args in steps {
            if let Err(e) = self.must(root, &args, &[], 64 * 1024) {
                undo.forget(&id);
                return Err(e);
            }
        }
        Ok(Undone { id })
    }

    /// Everything that reverting `entry` removes, as one patch `git apply` takes going forward.
    fn backup(&self, root: &str, entry: &Entry) -> Result<String, GitError> {
        let raw = if entry.kind == ChangeKind::Untracked {
            let args = [
                &["diff", "--no-index", "--binary", "--full-index"][..],
                PATCH_FLAGS,
                &["--", "/dev/null", entry.path.as_str()],
            ]
            .concat();
            let raw = self.call(root, &args, &[], BACKUP_CAP)?;
            if raw.code > 1 {
                return Err(failed(&raw));
            }
            raw
        } else {
            let mut paths = vec!["--", entry.path.as_str()];
            if let Some(old) = &entry.old_path {
                paths.push(old);
            }
            let flags = ["--binary", "--full-index", "--no-renames"];
            let mut raw = self.call(
                root,
                &tracked(&["diff-index", "-p"], &flags, "HEAD", &paths),
                &[],
                BACKUP_CAP,
            )?;
            if raw.code != 0 && no_head(&raw) {
                raw = self.call(
                    root,
                    &tracked(&["diff", "--cached"], &flags, "", &paths),
                    &[],
                    BACKUP_CAP,
                )?;
            }
            if raw.code != 0 {
                return Err(failed(&raw));
            }
            raw
        };
        if raw.truncated {
            return Err(GitError::new(
                GitErrorKind::TooBig,
                format!(
                    "The change to {} is too big to keep a copy of for undo (over {} MB), so it is not reverted from here",
                    entry.path,
                    BACKUP_CAP / (1024 * 1024)
                ),
            ));
        }
        if raw.stdout.is_empty() {
            return Err(GitError::new(
                GitErrorKind::Stale,
                format!("{} has no changes to revert", entry.path),
            ));
        }
        String::from_utf8(raw.stdout).map_err(|_| {
            GitError::new(
                GitErrorKind::Failed,
                "That change is not text git can hand back, so it is not reverted from here",
            )
        })
    }

    /// Takes one group of changes of a modified or moved file back. `fingerprint` is the one the diff the person
    /// looked at carried: when the file's changes are not those any more, nothing happens. The reverse patch must
    /// pass `git apply -R --check` before it is applied, and what is removed is saved first.
    pub fn revert_group(
        &self,
        root: &str,
        path: &str,
        group: usize,
        seen: &str,
        undo: &UndoStore,
    ) -> Result<Undone, GitError> {
        let entry = self.entry_of(root, path)?;
        match entry.kind {
            ChangeKind::Conflicted => {
                return Err(GitError::new(
                    GitErrorKind::Conflicted,
                    format!("{path} has merge conflicts: resolve them first"),
                ));
            }
            ChangeKind::Added | ChangeKind::Deleted | ChangeKind::Untracked => {
                return Err(GitError::new(
                    GitErrorKind::Invalid,
                    format!("{path} is new or deleted: revert the whole file"),
                ));
            }
            _ => {}
        }
        let raw = self.patch_of(
            root,
            path,
            entry.old_path.as_deref(),
            entry.kind,
            3,
            DIFF_CAP_ALL,
        )?;
        if raw.truncated {
            return Err(GitError::new(
                GitErrorKind::TooBig,
                format!("The change to {path} is too big to take back a piece of safely"),
            ));
        }
        let text = String::from_utf8_lossy(&raw.stdout).into_owned();
        let patch = parse_patch(&text);
        if patch.binary || patch.hunks.is_empty() {
            return Err(GitError::new(
                GitErrorKind::Invalid,
                format!("{path} has no lines to take back: revert the whole file"),
            ));
        }
        if patch_fingerprint(&patch) != seen {
            return Err(GitError::new(
                GitErrorKind::Stale,
                format!("{path} changed since you looked at it: look again, nothing was reverted"),
            ));
        }
        let groups = groups_of(&patch);
        let reverse = reverse_group(&patch, &groups, path, group).ok_or_else(|| {
            GitError::new(
                GitErrorKind::Stale,
                format!("{path} has no change number {}", group + 1),
            )
        })?;
        let apply = ["apply", "-R", "--whitespace=nowarn"];
        let check = self.call(
            root,
            &[&apply[..], &["--check", "-"]].concat(),
            reverse.as_bytes(),
            64 * 1024,
        )?;
        if check.code != 0 {
            return Err(GitError::new(
                GitErrorKind::Stale,
                format!(
                    "That change no longer applies cleanly to {path}: look again, nothing was reverted"
                ),
            ));
        }
        let id = undo.save(root, reverse.as_bytes())?;
        if let Err(e) = self.must(
            root,
            &[&apply[..], &["-"]].concat(),
            reverse.as_bytes(),
            64 * 1024,
        ) {
            undo.forget(&id);
            return Err(e);
        }
        Ok(Undone { id })
    }

    /// Brings back what a revert removed. Refused, with nothing changed, when the files have changed since.
    pub fn undo(&self, root: &str, id: &str, undo: &UndoStore) -> Result<(), GitError> {
        validate_dir(root)?;
        let saved = undo.load(id)?;
        if saved.root != root {
            return Err(GitError::new(
                GitErrorKind::Invalid,
                "That revert was in another checkout",
            ));
        }
        let apply = ["apply", "--whitespace=nowarn"];
        let check = self.call(
            root,
            &[&apply[..], &["--check", "-"]].concat(),
            &saved.patch,
            64 * 1024,
        )?;
        if check.code != 0 {
            return Err(GitError::new(
                GitErrorKind::Stale,
                "That cannot be undone any more: the file has changed since it was reverted",
            ));
        }
        self.must(
            root,
            &[&apply[..], &["-"]].concat(),
            &saved.patch,
            64 * 1024,
        )?;
        undo.forget(id);
        Ok(())
    }
}
