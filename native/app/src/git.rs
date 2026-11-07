//! `Git`: what the agents changed in a checkout, as the Changes tab asks for it.
//!
//! The work is `herdr_core::git`; this file is the door TSX uses. Everything that touches a machine is `async` and
//! runs on the runtime's blocking threads (a slow repository or ssh must never hold the UI). TSX polls `status` while
//! a Changes tab is in front and again when an agent's turn ends: nothing here watches by itself, so a hidden tab
//! costs nothing.

use std::path::{Path, PathBuf};
use std::process::Command;

use herdr_core::board::real_path;
use herdr_core::git::{self, ChangeKind, DiffOptions, GitErrorKind};
use nsh_core::prelude::*;

use crate::api::engine;
use crate::fixture::{TEST_FLAG, test_seam_open};

/// What happened to a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ChangeKindName {
    /// Changed content, mode or type.
    Modified,
    /// New to git: added, copied, or intent-to-add.
    Added,
    /// Gone from the working tree.
    Deleted,
    /// Moved, with or without edits.
    Renamed,
    /// New and not added to git.
    Untracked,
    /// Both sides changed it and nobody resolved it.
    Conflicted,
}

impl From<ChangeKind> for ChangeKindName {
    fn from(kind: ChangeKind) -> Self {
        match kind {
            ChangeKind::Modified => Self::Modified,
            ChangeKind::Added => Self::Added,
            ChangeKind::Deleted => Self::Deleted,
            ChangeKind::Renamed => Self::Renamed,
            ChangeKind::Untracked => Self::Untracked,
            ChangeKind::Conflicted => Self::Conflicted,
        }
    }
}

impl From<ChangeKindName> for ChangeKind {
    fn from(kind: ChangeKindName) -> Self {
        match kind {
            ChangeKindName::Modified => Self::Modified,
            ChangeKindName::Added => Self::Added,
            ChangeKindName::Deleted => Self::Deleted,
            ChangeKindName::Renamed => Self::Renamed,
            ChangeKindName::Untracked => Self::Untracked,
            ChangeKindName::Conflicted => Self::Conflicted,
        }
    }
}

/// Why a checkout has nothing to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum ProblemName {
    /// The folder is not in a git repository.
    NotARepo,
    /// `git` is not installed where it was needed.
    GitMissing,
    /// The machine could not be reached or did not answer.
    Unreachable,
    /// git ran and said no; `message` has its words.
    Failed,
}

/// One changed file.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ChangeView {
    /// Relative to the repository root.
    pub path: String,
    /// Where a moved file came from.
    #[prop(skip_none)]
    pub old_path: Option<String>,
    /// What happened to it.
    pub kind: ChangeKindName,
    /// Something of it is in git's index.
    pub staged: bool,
    /// Lines added since the last commit; absent for a binary file or one too big to count.
    #[prop(skip_none)]
    pub added: Option<u32>,
    /// Lines removed since the last commit.
    #[prop(skip_none)]
    pub removed: Option<u32>,
    /// git treats it as binary: there are no lines to show.
    pub binary: bool,
    /// Another repository inside this one (a submodule or a nested checkout).
    pub submodule: bool,
    /// Its size in bytes when known.
    #[prop(skip_none)]
    pub size: Option<f64>,
    /// Changes whenever the file's change does: what a `reviewed` mark is saved against.
    pub fingerprint: String,
}

/// A checkout and what changed in it; or why that is not known (`problem`, with `message`).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct StatusView {
    /// Set when there is nothing to show and why; the other fields are then empty.
    #[prop(skip_none)]
    pub problem: Option<ProblemName>,
    /// What to tell the person when `problem` is set; empty otherwise.
    pub message: String,
    /// The repository's working-tree root: pass it to every other call.
    pub root: String,
    /// The branch checked out; absent when HEAD is detached.
    #[prop(skip_none)]
    pub branch: Option<String>,
    /// HEAD is not on a branch.
    pub detached: bool,
    /// No commit exists yet.
    pub unborn: bool,
    /// The first 7 characters of HEAD's commit.
    #[prop(skip_none)]
    pub head: Option<String>,
    /// The branch it follows.
    #[prop(skip_none)]
    pub upstream: Option<String>,
    /// Commits here that the upstream does not have.
    pub ahead: u32,
    /// Commits there that are not here.
    pub behind: u32,
    /// A linked worktree, not the repository's main checkout.
    pub linked: bool,
    /// Changed files: conflicts first, then by path.
    pub files: Vec<ChangeView>,
    /// There were more changed files than are listed.
    pub truncated: bool,
    /// How many listed files have unresolved merge conflicts.
    pub conflicts: u32,
}

/// One run of changed lines in a patch: what a note and a revert are about.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct GroupView {
    /// Its place among the file's groups, from 0: the diff view's `Change n of m`.
    pub index: u32,
    /// Lines it adds.
    pub added: u32,
    /// Lines it removes.
    pub removed: u32,
    /// Where it starts in the file as it is now.
    pub line: u32,
    /// Where it ends in the file as it is now.
    pub end_line: u32,
    /// Its changed lines as the patch has them, `+` or `-` first.
    pub lines: Vec<String>,
    /// How many more changed lines there were.
    pub more: u32,
}

/// One file's patch.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct DiffView {
    /// The file, relative to the root.
    pub path: String,
    /// The unified patch (cut when `truncated`).
    pub patch: String,
    /// Lines the shown patch adds.
    pub added: u32,
    /// Lines the shown patch removes.
    pub removed: u32,
    /// git calls it binary: there is no patch.
    pub binary: bool,
    /// It has merge conflicts: there is no patch.
    pub conflicted: bool,
    /// The patch was cut at a limit; ask again with `all` for more.
    pub truncated: bool,
    /// Lines of the shown patch.
    pub lines: u32,
    /// The groups of changes in the shown patch, in order.
    pub groups: Vec<GroupView>,
    /// Changes whenever the file's changed lines do; pass it back to `revertGroup`.
    pub fingerprint: String,
}

/// A revert that can be taken back for ten minutes.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct RevertView {
    /// What `undo` takes.
    pub id: String,
}

fn change_view(c: git::Change) -> ChangeView {
    ChangeView {
        path: c.path,
        old_path: c.old_path,
        kind: c.kind.into(),
        staged: c.staged,
        added: c.added,
        removed: c.removed,
        binary: c.binary,
        submodule: c.submodule,
        size: c.size.map(|s| s as f64),
        fingerprint: c.fingerprint,
    }
}

fn empty_status(problem: ProblemName, message: String) -> StatusView {
    StatusView {
        problem: Some(problem),
        message,
        root: String::new(),
        branch: None,
        detached: false,
        unborn: false,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        linked: false,
        files: Vec::new(),
        truncated: false,
        conflicts: 0,
    }
}

/// Runs `work` on a blocking thread and settles with its result.
async fn run<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    blocking(work)
        .await
        .map_err(|e| format!("the task stopped: {e}"))?
}

/// What the Changes tab reads and does: the files an agent changed in a checkout, a file's patch, and taking a file or
/// one group of changes back. A path is relative to the root `status` returned; `machine` is a machine's id.
/// Reading takes no lock the agent could collide with and runs no program a repository's config names (`docs/ARCHITECTURE.md`).
/// A failure throws with the words to show.
#[module]
pub struct Git;

#[module]
impl Git {
    /// The checkout `cwd` is in and every file changed since the last commit, staged or not. A folder that is not a
    /// repository, a machine that is not reachable and a missing `git` resolve with `problem` set instead of throwing:
    /// the tab explains them, they are not errors.
    pub async fn status(machine: String, cwd: String) -> Result<StatusView, String> {
        let engine = engine()?;
        run(move || {
            let git = engine.git_of(&machine)?;
            Ok(match git.status(&cwd) {
                Ok(s) => StatusView {
                    problem: None,
                    message: String::new(),
                    root: s.root,
                    branch: s.branch,
                    detached: s.detached,
                    unborn: s.unborn,
                    head: s.head,
                    upstream: s.upstream,
                    ahead: s.ahead,
                    behind: s.behind,
                    linked: s.linked,
                    files: s.files.into_iter().map(change_view).collect(),
                    truncated: s.truncated,
                    conflicts: s.conflicts as u32,
                },
                Err(e) => match e.kind {
                    GitErrorKind::NotARepo => empty_status(ProblemName::NotARepo, e.message),
                    GitErrorKind::GitMissing => empty_status(ProblemName::GitMissing, e.message),
                    GitErrorKind::Unreachable => empty_status(ProblemName::Unreachable, e.message),
                    _ => empty_status(ProblemName::Failed, e.message),
                },
            })
        })
        .await
    }

    /// One file's patch since the last commit, with its groups of changes. `kind` and `oldPath` are the file's as
    /// `status` listed them. `context` is the unchanged lines kept around each change (3 by default); `all` lifts the
    /// size limits (`truncated` says when they applied).
    pub async fn diff(
        machine: String,
        root: String,
        path: String,
        old_path: Option<String>,
        kind: ChangeKindName,
        context: u32,
        all: bool,
    ) -> Result<DiffView, String> {
        let engine = engine()?;
        run(move || {
            let d = engine
                .git_of(&machine)?
                .diff(
                    &root,
                    &path,
                    old_path.as_deref(),
                    kind.into(),
                    DiffOptions { context, all },
                )
                .map_err(|e| e.message)?;
            Ok(DiffView {
                path: d.path,
                patch: d.patch,
                added: d.added,
                removed: d.removed,
                binary: d.binary,
                conflicted: d.conflicted,
                truncated: d.truncated,
                lines: d.lines,
                groups: d
                    .groups
                    .into_iter()
                    .map(|g| GroupView {
                        index: g.index,
                        added: g.added,
                        removed: g.removed,
                        line: g.line,
                        end_line: g.end_line,
                        lines: g.lines,
                        more: g.more,
                    })
                    .collect(),
                fingerprint: d.fingerprint,
            })
        })
        .await
    }

    /// Takes a file back to how the last commit has it: edits gone, a deleted file back, a new file removed, a moved
    /// file moved back. What was removed is kept for ten minutes (`undo`); a change too big to keep is refused, and so
    /// is a file with merge conflicts.
    pub async fn revert_file(
        machine: String,
        root: String,
        path: String,
    ) -> Result<RevertView, String> {
        let engine = engine()?;
        run(move || {
            let undo = engine.changes_undo();
            engine
                .git_of(&machine)?
                .revert_file(&root, &path, &undo)
                .map(|u| RevertView { id: u.id })
                .map_err(|e| e.message)
        })
        .await
    }

    /// Takes one group of changes of a modified or moved file back. `fingerprint` is the one the diff the person looked
    /// at carried: when the file's changes are not those any more, or the reverse patch does not apply cleanly, nothing
    /// happens and the error says so.
    pub async fn revert_group(
        machine: String,
        root: String,
        path: String,
        group: u32,
        fingerprint: String,
    ) -> Result<RevertView, String> {
        let engine = engine()?;
        run(move || {
            let undo = engine.changes_undo();
            engine
                .git_of(&machine)?
                .revert_group(&root, &path, group as usize, &fingerprint, &undo)
                .map(|u| RevertView { id: u.id })
                .map_err(|e| e.message)
        })
        .await
    }

    /// Brings back what a revert removed, if the files are still as the revert left them and it was under ten minutes ago.
    pub async fn undo(machine: String, root: String, id: String) -> Result<(), String> {
        let engine = engine()?;
        run(move || {
            let undo = engine.changes_undo();
            engine
                .git_of(&machine)?
                .undo(&root, &id, &undo)
                .map_err(|e| e.message)
        })
        .await
    }

    /// `path` as the file system names it (links resolved), for a folder on this computer; any other machine's
    /// path comes back as it was given, since only that machine can resolve it. Git reports a checkout by its real
    /// path while an agent's folder may be a link to it (`/var` is `/private/var` on macOS), so the two are compared
    /// after this. A path that does not exist is returned as given.
    pub fn canonical_path(machine: String, path: String) -> Result<String, String> {
        Ok(if engine()?.is_local_machine(&machine)? {
            real_path(&path)
        } else {
            path
        })
    }

    /// Test seam: builds a synthetic repository in the data directory and returns its path. `kind` is `project` (every
    /// kind of change: edits in two places, a deletion, a staged move, new files, a binary one), `clean`, `many` (520
    /// changed files), `big` (a 5,000-line change), `conflict` or `plain` (a folder that is not a repository). Throws
    /// unless `HERDR_DESKTOP_TEST=1`.
    pub fn test_repo(kind: String) -> Result<String, String> {
        let dir = test_repo_dir()?;
        build_repo(&dir, &kind)?;
        dir.into_os_string()
            .into_string()
            .map_err(|_| "the data directory is not text".to_owned())
    }

    /// Test seam: writes `text` to `path` (relative) inside the test repository, as an agent editing a file would;
    /// an empty `text` removes the file. Throws unless `HERDR_DESKTOP_TEST=1`, and for a path that leaves the repository.
    pub fn test_write(path: String, text: String) -> Result<(), String> {
        let file = test_path(&path)?;
        if text.is_empty() {
            std::fs::remove_file(&file).map_err(|e| e.to_string())
        } else {
            put(&test_repo_dir()?, &path, text)
        }
    }

    /// Test seam: the text of `path` (relative) in the test repository, `null` when there is no such file.
    pub fn test_read(path: String) -> Result<Option<String>, String> {
        Ok(std::fs::read_to_string(test_path(&path)?).ok())
    }
}

fn test_repo_dir() -> Result<PathBuf, String> {
    if !test_seam_open() {
        return Err(format!("The test seam is closed: set {TEST_FLAG}=1"));
    }
    Ok(engine()?.test_tree_dir().with_file_name("test-repo"))
}

/// `rel` inside the test repository, never outside it.
fn test_path(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.starts_with('/') || rel.split('/').any(|p| p == ".." || p == ".git") {
        return Err(format!("`{rel}` is not a file of the test repository"));
    }
    Ok(test_repo_dir()?.join(rel))
}

// ---- the test seam's repositories: synthetic code, built with the real git ------------------------------

fn sh(dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
        .args(["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

fn put(dir: &Path, rel: &str, bytes: impl AsRef<[u8]>) -> Result<(), String> {
    let path: PathBuf = dir.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

const AUTH_BASE: &str = "import { hash, verify } from \"./crypto\";
import type { User } from \"./user\";

export interface Credentials {
  email: string;
  password: string;
}

const MAX_ATTEMPTS = 5;

export async function login(creds: Credentials): Promise<User> {
  const user = await findUser(creds.email);
  if (!user) {
    throw new Error(\"unknown user\");
  }
  const ok = await verify(creds.password, user.passwordHash);
  if (!ok) {
    throw new Error(\"wrong password\");
  }
  return user;
}

export function logout(session: Session): void {
  session.destroy();
}

export async function register(creds: Credentials): Promise<User> {
  const passwordHash = await hash(creds.password);
  return createUser({ email: creds.email, passwordHash });
}

export function isAdmin(user: User): boolean {
  return user.roles.includes(\"admin\");
}
";

const AUTH_NEW: &str = "import { hash, verify } from \"./crypto\";
import type { User } from \"./user\";
import { RateLimiter } from \"./rate-limit\";

export interface Credentials {
  email: string;
  password: string;
}

const MAX_ATTEMPTS = 5;
const limiter = new RateLimiter(MAX_ATTEMPTS, 60_000);

export async function login(creds: Credentials): Promise<User> {
  if (!limiter.allow(creds.email)) {
    throw new Error(\"too many attempts, try again in a minute\");
  }
  const user = await findUser(creds.email);
  if (!user) {
    throw new Error(\"unknown user\");
  }
  const ok = await verify(creds.password, user.passwordHash);
  if (!ok) {
    throw new Error(\"wrong password\");
  }
  limiter.reset(creds.email);
  return user;
}

export function logout(session: Session): void {
  session.destroy();
}

export async function register(creds: Credentials): Promise<User> {
  const passwordHash = await hash(creds.password);
  return createUser({ email: creds.email.toLowerCase(), passwordHash });
}

export function isAdmin(user: User): boolean {
  return user.roles.includes(\"admin\") || user.roles.includes(\"owner\");
}
";

fn project(dir: &Path) -> Result<(), String> {
    put(dir, "src/auth.ts", AUTH_BASE)?;
    put(
        dir,
        "src/session.ts",
        "export class Session {\n  private expires: number;\n\n  constructor(readonly id: string, ttlMs = 3_600_000) {\n    this.expires = Date.now() + ttlMs;\n  }\n\n  get alive(): boolean {\n    return Date.now() < this.expires;\n  }\n\n  destroy(): void {\n    this.expires = 0;\n  }\n}\n",
    )?;
    put(
        dir,
        "src/legacy.ts",
        "// Kept for the v1 API until the clients are gone.\nexport function legacyLogin(user: string, pass: string) {\n  return user === \"admin\" && pass === \"admin\";\n}\n",
    )?;
    put(
        dir,
        "src/token.ts",
        "import { sign } from \"./crypto\";\n\nexport const TTL = 3600;\n\nexport function issue(userId: string): string {\n  return sign({ sub: userId, exp: Date.now() / 1000 + TTL });\n}\n\nexport function revoke(token: string): void {\n  blocklist.add(token);\n}\n\nexport function isRevoked(token: string): boolean {\n  return blocklist.has(token);\n}\n\nconst blocklist = new Set<string>();\n",
    )?;
    put(
        dir,
        "README.md",
        "# Accounts service\n\nSign-in, sessions and tokens for the web app.\n\n## Running\n\n```sh\nnpm start\n```\n",
    )?;
    put(
        dir,
        "assets/logo.png",
        [0x89, b'P', b'N', b'G', 0, 1, 2, 3, 4, 5],
    )?;
    sh(dir, &["add", "-A"])?;
    sh(dir, &["commit", "-q", "-m", "Accounts service"])?;

    put(dir, "src/auth.ts", AUTH_NEW)?;
    put(
        dir,
        "src/session.ts",
        "export class Session {\n  private expires: number;\n\n  constructor(readonly id: string, ttlMs = 1_800_000) {\n    this.expires = Date.now() + ttlMs;\n  }\n\n  get alive(): boolean {\n    return Date.now() < this.expires;\n  }\n\n  touch(ttlMs = 1_800_000): void {\n    this.expires = Date.now() + ttlMs;\n  }\n\n  destroy(): void {\n    this.expires = 0;\n  }\n}\n",
    )?;
    std::fs::remove_file(dir.join("src/legacy.ts")).map_err(|e| e.to_string())?;
    sh(dir, &["mv", "src/token.ts", "src/tokens.ts"])?;
    put(
        dir,
        "src/tokens.ts",
        "import { sign } from \"./crypto\";\n\nexport const TTL = 900;\n\nexport function issue(userId: string): string {\n  return sign({ sub: userId, exp: Date.now() / 1000 + TTL });\n}\n\nexport function revoke(token: string): void {\n  blocklist.add(token);\n}\n\nexport function isRevoked(token: string): boolean {\n  return blocklist.has(token);\n}\n\nconst blocklist = new Set<string>();\n",
    )?;
    put(
        dir,
        "README.md",
        "# Accounts service\n\nSign-in, sessions and tokens for the web app.\n\n## Running\n\n```sh\nnpm start\n```\n\n## Limits\n\nFive sign-in attempts per email per minute.\n",
    )?;
    put(
        dir,
        "src/rate-limit.ts",
        "export class RateLimiter {\n  private hits = new Map<string, number[]>();\n\n  constructor(private max: number, private windowMs: number) {}\n\n  allow(key: string): boolean {\n    const now = Date.now();\n    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);\n    recent.push(now);\n    this.hits.set(key, recent);\n    return recent.length <= this.max;\n  }\n\n  reset(key: string): void {\n    this.hits.delete(key);\n  }\n}\n",
    )?;
    put(
        dir,
        "docs/notes.md",
        "# Notes\n\n- rate limit is per email, not per address\n",
    )?;
    put(
        dir,
        "assets/logo.png",
        [0x89, b'P', b'N', b'G', 0, 1, 2, 3, 4, 5, 6, 7],
    )?;
    Ok(())
}

fn many(dir: &Path) -> Result<(), String> {
    for i in 0..520 {
        put(
            dir,
            &format!("src/gen/module{:03}.ts", i),
            format!("export const id{i} = {i};\nexport const name{i} = \"module-{i}\";\n"),
        )?;
    }
    put(dir, "README.md", "# Many\n")?;
    sh(dir, &["add", "-A"])?;
    sh(dir, &["commit", "-q", "-m", "Generated modules"])?;
    for i in 0..520 {
        let tail = if i % 3 == 0 { "// reviewed\n" } else { "" };
        put(
            dir,
            &format!("src/gen/module{:03}.ts", i),
            format!(
                "export const id{i} = {};\nexport const name{i} = \"module-{i}\";\n{tail}",
                i + 1
            ),
        )?;
    }
    put(dir, "README.md", "# Many\n\nGenerated.\n")?;
    put(dir, "src/gen/index.ts", "export * from \"./module000\";\n")?;
    Ok(())
}

fn big(dir: &Path) -> Result<(), String> {
    let line = |i: usize, tag: &str| format!("  const value_{i} = compute(input, {i}); // {tag}\n");
    let body = |tag: &str| (0..5000).map(|i| line(i, tag)).collect::<String>();
    put(
        dir,
        "src/big.ts",
        format!(
            "export function run(input: number) {{\n{}}}\n",
            body("before")
        ),
    )?;
    put(dir, "src/small.ts", "export const small = 1;\n")?;
    sh(dir, &["add", "-A"])?;
    sh(dir, &["commit", "-q", "-m", "Big file"])?;
    put(dir, "src/small.ts", "export const small = 2;\n")?;
    put(
        dir,
        "src/big.ts",
        format!(
            "export function run(input: number) {{\n{}}}\n",
            body("after")
        ),
    )
}

fn conflict(dir: &Path) -> Result<(), String> {
    put(dir, "src/a.ts", "export const limit = 5;\n")?;
    put(dir, "src/b.ts", "export const name = \"b\";\n")?;
    sh(dir, &["add", "-A"])?;
    sh(dir, &["commit", "-q", "-m", "base"])?;
    sh(dir, &["checkout", "-q", "-b", "other"])?;
    put(dir, "src/a.ts", "export const limit = 10;\n")?;
    sh(dir, &["commit", "-qam", "other"])?;
    sh(dir, &["checkout", "-q", "main"])?;
    put(dir, "src/a.ts", "export const limit = 20;\n")?;
    sh(dir, &["commit", "-qam", "main"])?;
    // The merge stops on the conflict: that is the state this repository is for.
    let _ = sh(dir, &["merge", "other"]);
    put(dir, "src/b.ts", "export const name = \"bee\";\n")
}

/// Rebuilds the test repository `kind` from nothing in `dir`.
fn build_repo(dir: &Path, kind: &str) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    if kind == "plain" {
        return put(dir, "notes.txt", "not a repository\n");
    }
    sh(dir, &["init", "-q", "-b", "main"])?;
    match kind {
        "project" => project(dir),
        "many" => many(dir),
        "big" => big(dir),
        "conflict" => conflict(dir),
        "clean" => {
            put(dir, "README.md", "# Clean\n")?;
            sh(dir, &["add", "-A"])?;
            sh(dir, &["commit", "-q", "-m", "Clean"])
        }
        other => Err(format!("`{other}` is not a test repository")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_to_a_folder_names_the_folder_git_reports() {
        // macOS's `/var` is a link to `/private/var`; git names a checkout by its real path, an agent may not.
        let dir = tempfile::tempdir().expect("temp dir");
        let real = dir.path().join("real");
        std::fs::create_dir_all(real.join("sub")).expect("folders");
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let expected = std::fs::canonicalize(&real).expect("canonical");
        let expected = expected.to_str().expect("text");
        assert_eq!(real_path(link.to_str().expect("text")), expected);
        assert_eq!(
            real_path(link.join("sub").to_str().expect("text")),
            format!("{expected}/sub")
        );
    }

    #[test]
    fn a_folder_that_does_not_exist_is_returned_as_it_was_given() {
        assert_eq!(real_path("/no/such/folder/here"), "/no/such/folder/here");
        assert_eq!(real_path(""), "");
    }
}
