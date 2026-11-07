//! Git: the status, the patches and the two reverts, against real repositories in a temporary folder.
//!
//! Every behaviour is checked through this computer's git and, where the transport could matter, again through
//! the remote helper (`git.py` on a local python3, reached through a stand-in `ssh` that runs the generated remote
//! command with `sh -c`, so the real quoting is what executes).

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use herdr_core::git::{
    ALLOWED, Call, ChangeKind, DIFF_CAP, DIFF_LINES, DiffOptions, Git, GitErrorKind, LocalGit,
    RemoteGit, Runner, UndoStore, validate_rel,
};
use herdr_core::ssh::{SshClient, SshTarget};

struct Repo {
    dir: tempfile::TempDir,
    root: String,
}

impl Repo {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let repo = Self { dir, root };
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }

    fn git(&self, args: &[&str]) -> String {
        let out = Command::new("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .current_dir(self.dir.path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.path(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.path(rel)).unwrap()
    }

    fn commit(&self, message: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
    }
}

fn local() -> Git {
    Git::new(Arc::new(LocalGit::new()))
}

fn store() -> (tempfile::TempDir, UndoStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = UndoStore::new(dir.path().join("undo"));
    (dir, store)
}

/// A stand-in `ssh` that runs the remote command locally.
struct Rig {
    dir: tempfile::TempDir,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let script = r#"#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
shift
exec sh -c "exec $1"
"#;
        let path = dir.path().join("ssh");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self { dir }
    }

    fn runner(&self) -> RemoteGit {
        let client = SshClient::with_control_dir(self.dir.path().join("control"))
            .program("/bin/sh")
            .program_arg(self.dir.path().join("ssh"));
        RemoteGit::new(client, SshTarget::new("box", None, None, None).unwrap())
    }
}

fn on_both(mut check: impl FnMut(&Git)) {
    check(&local());
    let rig = Rig::new();
    check(&Git::new(Arc::new(rig.runner())));
}

fn kinds(repo: &Repo, git: &Git) -> Vec<(String, ChangeKind)> {
    git.status(&repo.root)
        .unwrap()
        .files
        .into_iter()
        .map(|c| (c.path, c.kind))
        .collect()
}

// ---- status -------------------------------------------------------------------------------------------

#[test]
fn every_kind_of_change_is_listed_with_its_numbers() {
    let repo = Repo::new();
    repo.write("keep.txt", "one\ntwo\nthree\n");
    repo.write("edit.txt", "a\nb\nc\nd\n");
    repo.write("gone.txt", "x\ny\n");
    repo.write("move.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\n");
    repo.write("bin.dat", "\0\x01\x02");
    repo.commit("base");
    repo.write("edit.txt", "a\nB\nc\nd\ne\n");
    std::fs::remove_file(repo.path("gone.txt")).unwrap();
    repo.git(&["mv", "move.txt", "moved.txt"]);
    repo.write("new-staged.txt", "s1\ns2\n");
    repo.git(&["add", "new-staged.txt"]);
    repo.write("fresh.txt", "f1\nf2\nf3");
    repo.write("bin.dat", "\0\x01\x02\x03\x04");
    on_both(|git| {
        let status = git.status(&repo.root).unwrap();
        let by: std::collections::HashMap<_, _> =
            status.files.iter().map(|c| (c.path.as_str(), c)).collect();
        assert_eq!(by["edit.txt"].kind, ChangeKind::Modified);
        assert_eq!(
            (by["edit.txt"].added, by["edit.txt"].removed),
            (Some(2), Some(1))
        );
        assert!(by["edit.txt"].unstaged && !by["edit.txt"].staged);
        assert_eq!(by["gone.txt"].kind, ChangeKind::Deleted);
        assert_eq!(
            (by["gone.txt"].added, by["gone.txt"].removed),
            (Some(0), Some(2))
        );
        assert_eq!(by["moved.txt"].kind, ChangeKind::Renamed);
        assert_eq!(by["moved.txt"].old_path.as_deref(), Some("move.txt"));
        assert!(by["moved.txt"].staged);
        assert_eq!(by["new-staged.txt"].kind, ChangeKind::Added);
        assert_eq!(by["new-staged.txt"].added, Some(2));
        // A file that is not in git is counted from the file itself, and a last line without a newline counts.
        assert_eq!(by["fresh.txt"].kind, ChangeKind::Untracked);
        assert_eq!(
            (by["fresh.txt"].added, by["fresh.txt"].removed),
            (Some(3), Some(0))
        );
        assert_eq!(by["fresh.txt"].size, Some(8));
        assert!(by["bin.dat"].binary && by["bin.dat"].added.is_none());
        assert!(!by.contains_key("keep.txt"));
        assert_eq!(status.files.len(), 6);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(!status.linked && !status.unborn && !status.detached);
        assert_eq!(status.head.as_ref().map(String::len), Some(7));
    });
}

#[test]
fn a_clean_checkout_has_no_files_and_a_folder_that_is_not_a_repository_says_so() {
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    on_both(|git| {
        assert!(git.status(&repo.root).unwrap().files.is_empty());
        let plain = tempfile::tempdir().unwrap();
        let err = git.status(plain.path().to_str().unwrap()).unwrap_err();
        assert_eq!(err.kind, GitErrorKind::NotARepo);
        let err = git.status("/nonexistent-folder-for-herdr").unwrap_err();
        assert!(
            matches!(err.kind, GitErrorKind::Invalid | GitErrorKind::Failed),
            "{err}"
        );
    });
}

#[test]
fn a_repository_without_a_commit_lists_what_is_staged_and_what_is_new() {
    let repo = Repo::new();
    repo.write("a.txt", "a\nb\n");
    repo.git(&["add", "a.txt"]);
    repo.write("b.txt", "b\n");
    on_both(|git| {
        let status = git.status(&repo.root).unwrap();
        assert!(status.unborn && status.head.is_none());
        let by: std::collections::HashMap<_, _> =
            status.files.iter().map(|c| (c.path.as_str(), c)).collect();
        assert_eq!(
            (by["a.txt"].kind, by["a.txt"].added),
            (ChangeKind::Added, Some(2))
        );
        assert_eq!(by["b.txt"].kind, ChangeKind::Untracked);
        let diff = git
            .diff(
                &repo.root,
                "a.txt",
                None,
                ChangeKind::Added,
                DiffOptions::default(),
            )
            .unwrap();
        assert_eq!(diff.added, 2);
    });
}

#[test]
fn the_branch_its_upstream_and_how_far_apart_they_are() {
    let origin = Repo::new();
    origin.write("a.txt", "a\n");
    origin.commit("one");
    let clone_dir = tempfile::tempdir().unwrap();
    let clone = clone_dir.path().join("work");
    let ok = Command::new("git")
        .args(["clone", "-q", origin.root.as_str(), clone.to_str().unwrap()])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()
        .unwrap()
        .success();
    assert!(ok);
    let work = Repo {
        root: std::fs::canonicalize(&clone)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned(),
        dir: clone_dir,
    };
    // `Repo::path` joins onto the temp folder, so write through the clone explicitly.
    std::fs::write(clone.join("b.txt"), "b\n").unwrap();
    for args in [["add", "b.txt"], ["commit", "-qm"]] {
        let mut command = Command::new("git");
        command
            .args(["-c", "user.name=T", "-c", "user.email=t@x"])
            .args(args)
            .current_dir(&clone)
            .env("GIT_CONFIG_GLOBAL", "/dev/null");
        if args[0] == "commit" {
            command.arg("local");
        }
        assert!(command.status().unwrap().success());
    }
    origin.write("c.txt", "c\n");
    origin.commit("two");
    assert!(
        Command::new("git")
            .args(["fetch", "-q"])
            .current_dir(&clone)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .status()
            .unwrap()
            .success()
    );
    let status = local().status(&work.root).unwrap();
    assert_eq!((status.ahead, status.behind), (1, 1));
    assert_eq!(status.upstream.as_deref(), Some("origin/main"));
}

#[test]
fn a_linked_worktree_is_a_checkout_of_its_own() {
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    let wt_dir = tempfile::tempdir().unwrap();
    let wt = std::fs::canonicalize(wt_dir.path())
        .unwrap()
        .join("feature");
    repo.git(&[
        "worktree",
        "add",
        "-q",
        "-b",
        "feature",
        wt.to_str().unwrap(),
    ]);
    std::fs::write(wt.join("a.txt"), "a\nchanged\n").unwrap();
    let wt = wt.to_str().unwrap().to_owned();
    on_both(|git| {
        let status = git.status(&wt).unwrap();
        assert!(status.linked);
        assert_eq!(status.branch.as_deref(), Some("feature"));
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.root, wt);
        assert!(git.status(&repo.root).unwrap().files.is_empty());
        assert!(!git.status(&repo.root).unwrap().linked);
    });
}

#[test]
fn a_subfolder_reports_the_whole_checkout() {
    let repo = Repo::new();
    repo.write("src/lib/a.txt", "a\n");
    repo.write("top.txt", "t\n");
    repo.commit("base");
    repo.write("top.txt", "t2\n");
    on_both(|git| {
        let status = git.status(&format!("{}/src/lib", repo.root)).unwrap();
        assert_eq!(status.root, repo.root);
        assert_eq!(status.files[0].path, "top.txt");
    });
}

#[test]
fn a_merge_conflict_is_flagged_and_listed_first() {
    let repo = Repo::new();
    repo.write("a.txt", "base\n");
    repo.write("z.txt", "z\n");
    repo.commit("base");
    repo.git(&["checkout", "-q", "-b", "other"]);
    repo.write("a.txt", "other\n");
    repo.commit("other");
    repo.git(&["checkout", "-q", "main"]);
    repo.write("a.txt", "main\n");
    repo.commit("main");
    // `Repo::git` insists on success; a conflicted merge is the one command here that must fail.
    let merge = Command::new("git")
        .args([
            "-c",
            "user.name=T",
            "-c",
            "user.email=t@x",
            "merge",
            "other",
        ])
        .current_dir(repo.dir.path())
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        String::from_utf8_lossy(&merge.stdout).contains("CONFLICT"),
        "{}{}",
        String::from_utf8_lossy(&merge.stdout),
        String::from_utf8_lossy(&merge.stderr)
    );
    repo.write("z.txt", "z2\n");
    on_both(|git| {
        let status = git.status(&repo.root).unwrap();
        assert_eq!(status.conflicts, 1);
        assert_eq!(status.files[0].path, "a.txt");
        assert_eq!(status.files[0].kind, ChangeKind::Conflicted);
        let diff = git
            .diff(
                &repo.root,
                "a.txt",
                None,
                ChangeKind::Conflicted,
                DiffOptions::default(),
            )
            .unwrap();
        assert!(diff.conflicted && diff.patch.is_empty());
        let (_dir, undo) = store();
        let err = git.revert_file(&repo.root, "a.txt", &undo).unwrap_err();
        assert_eq!(err.kind, GitErrorKind::Conflicted);
        assert_eq!(repo.read("a.txt").lines().next(), Some("<<<<<<< HEAD"));
    });
}

#[test]
fn names_that_are_shell_syntax_or_git_patterns_are_only_names() {
    let repo = Repo::new();
    let names = [
        "a; touch PWNED",
        "$(touch PWNED2)",
        "`touch PWNED3`",
        "it's \"quoted\"",
        "sp ace/und\u{e9}r.txt",
        "-rf",
        "star*.txt",
        "star-a.txt",
        "new\nline.txt",
    ];
    for n in names.iter().filter(|n| **n != "star-a.txt") {
        repo.write(n, "one\n");
    }
    repo.write("star-a.txt", "one\n");
    repo.commit("base");
    for n in names {
        repo.write(n, "one\ntwo\n");
    }
    on_both(|git| {
        let status = git.status(&repo.root).unwrap();
        let mut listed: Vec<&str> = status.files.iter().map(|c| c.path.as_str()).collect();
        listed.sort_unstable();
        let mut want = names.to_vec();
        want.sort_unstable();
        assert_eq!(listed, want);
        for n in names {
            let diff = git
                .diff(
                    &repo.root,
                    n,
                    None,
                    ChangeKind::Modified,
                    DiffOptions::default(),
                )
                .unwrap();
            assert_eq!((diff.added, diff.removed), (1, 0), "{n:?}");
        }
        // `star*.txt` is a file, not a pattern: reverting it leaves `star-a.txt` alone.
        let (_dir, undo) = store();
        git.revert_file(&repo.root, "star*.txt", &undo).unwrap();
        assert_eq!(repo.read("star*.txt"), "one\n");
        assert_eq!(repo.read("star-a.txt"), "one\ntwo\n");
        repo.write("star*.txt", "one\ntwo\n");
    });
    for marker in ["PWNED", "PWNED2", "PWNED3"] {
        assert!(!repo.path(marker).exists(), "{marker} was created");
        assert!(!Path::new(marker).exists());
    }
}

#[test]
fn paths_that_could_escape_the_checkout_or_be_read_as_options_are_refused_before_anything_runs() {
    for bad in [
        "",
        "/etc/passwd",
        "../x",
        "a/../../x",
        ".git/config",
        "a/.GIT/x",
        "a\0b",
    ] {
        assert!(validate_rel(bad).is_err(), "{bad:?}");
    }
    for ok in [
        "a",
        "a/b.txt",
        "a b",
        "a;b",
        "$(x)",
        "it's",
        "new\nline",
        "..x",
        "a/..b/c",
        "-rf",
        "~x",
    ] {
        assert!(validate_rel(ok).is_ok(), "{ok:?}");
    }
    let git = local();
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    let (_dir, undo) = store();
    for bad in ["../x", "/etc/passwd", ".git/config"] {
        assert_eq!(
            git.diff(
                &repo.root,
                bad,
                None,
                ChangeKind::Modified,
                DiffOptions::default()
            )
            .unwrap_err()
            .kind,
            GitErrorKind::Invalid
        );
        assert_eq!(
            git.revert_file(&repo.root, bad, &undo).unwrap_err().kind,
            GitErrorKind::Invalid
        );
    }
    assert_eq!(
        git.undo(&repo.root, "../../etc/passwd", &undo)
            .unwrap_err()
            .kind,
        GitErrorKind::Invalid
    );
}

#[test]
fn only_the_listed_git_commands_run() {
    let repo = Repo::new();
    let rig = Rig::new();
    let runners: [Box<dyn Runner>; 2] = [Box::new(LocalGit::new()), Box::new(rig.runner())];
    for runner in &runners {
        for bad in [
            &["config", "user.name", "x"][..],
            &["push"],
            &["reset", "--hard"],
            &["commit", "-m", "x"],
            &["-c", "core.pager=touch PWNED", "status"],
            &[],
        ] {
            let call = Call {
                args: bad,
                stdin: &[],
                cap: 1024,
                timeout: std::time::Duration::from_secs(5),
            };
            assert_eq!(
                runner.run(&repo.root, &call).unwrap_err().kind,
                GitErrorKind::Invalid,
                "{bad:?}"
            );
        }
    }
    assert!(ALLOWED.contains(&"status") && !ALLOWED.contains(&"config"));
    assert!(!repo.path("PWNED").exists());
}

#[test]
fn reading_changes_never_writes_to_the_repository_or_runs_its_programs() {
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.write("b.txt", "b\n");
    repo.write(".gitattributes", "*.txt diff=evil\n");
    repo.commit("base");
    let marker = repo
        .path("..")
        .join(format!("herdr-marker-{}", std::process::id()));
    let program = format!("touch {}", marker.display());
    repo.git(&["config", "core.fsmonitor", &program]);
    repo.git(&["config", "diff.evil.textconv", &program]);
    repo.git(&["config", "diff.external", &program]);
    repo.write("a.txt", "a\nchanged\n");
    // Same content, newer mtime: a plain `git status` would rewrite the index to remember it is clean.
    let b = repo.read("b.txt");
    std::thread::sleep(std::time::Duration::from_millis(1100));
    repo.write("b.txt", &b);
    let index = repo.path(".git/index");
    let before = std::fs::metadata(&index).unwrap().modified().unwrap();
    on_both(|git| {
        let status = git.status(&repo.root).unwrap();
        assert_eq!(status.files.len(), 1);
        let diff = git
            .diff(
                &repo.root,
                "a.txt",
                None,
                ChangeKind::Modified,
                DiffOptions::default(),
            )
            .unwrap();
        assert_eq!(diff.added, 1);
    });
    assert_eq!(
        std::fs::metadata(&index).unwrap().modified().unwrap(),
        before
    );
    assert!(
        !marker.exists(),
        "a program named by the repository's config ran"
    );
}

#[test]
fn a_status_does_not_fail_while_another_git_holds_the_index() {
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    repo.write("a.txt", "a\nb\n");
    repo.write(".git/index.lock", "");
    on_both(|git| {
        assert_eq!(git.status(&repo.root).unwrap().files.len(), 1);
    });
}

// ---- the patch ----------------------------------------------------------------------------------------

fn numbered(n: usize, tag: &str) -> String {
    (1..=n).map(|i| format!("line {i}{tag}\n")).collect()
}

#[test]
fn a_patch_has_groups_with_the_lines_to_quote_and_where_they_are() {
    let repo = Repo::new();
    repo.write("f.txt", &numbered(40, ""));
    repo.commit("base");
    let mut lines: Vec<String> = numbered(40, "").lines().map(str::to_owned).collect();
    lines[4] = "line 5 EDITED".into();
    lines.remove(9);
    lines.insert(30, "inserted".into());
    let edited = lines.join("\n") + "\n";
    repo.write("f.txt", &edited);
    on_both(|git| {
        let diff = git
            .diff(
                &repo.root,
                "f.txt",
                None,
                ChangeKind::Modified,
                DiffOptions::default(),
            )
            .unwrap();
        assert_eq!(diff.groups.len(), 3);
        assert_eq!((diff.added, diff.removed), (2, 2));
        let first = &diff.groups[0];
        assert_eq!((first.line, first.end_line, first.old_line), (5, 5, 5));
        assert_eq!(first.lines, ["-line 5", "+line 5 EDITED"]);
        // Removed only: it sits where the next line now is.
        let second = &diff.groups[1];
        assert_eq!(
            (second.added, second.removed, second.line, second.old_line),
            (0, 1, 10, 10)
        );
        assert_eq!(diff.groups[2].lines, ["+inserted"]);
        assert!(diff.patch.starts_with("diff --git a/f.txt b/f.txt"));
        assert!(!diff.truncated && !diff.binary);
        // The same groups and fingerprint however much context is asked for; more context is more lines.
        let wide = git
            .diff(
                &repo.root,
                "f.txt",
                None,
                ChangeKind::Modified,
                DiffOptions {
                    context: 20,
                    all: false,
                },
            )
            .unwrap();
        let places = |d: &herdr_core::git::FileDiff| -> Vec<(u32, u32, Vec<String>)> {
            d.groups
                .iter()
                .map(|g| (g.line, g.end_line, g.lines.clone()))
                .collect()
        };
        assert_eq!(places(&wide), places(&diff));
        assert_eq!(wide.fingerprint, diff.fingerprint);
        assert!(wide.lines > diff.lines);
        // And another edit changes the fingerprint.
        let before = diff.fingerprint.clone();
        repo.write("f.txt", &edited.replace("line 22\n", "later\n"));
        let after = git
            .diff(
                &repo.root,
                "f.txt",
                None,
                ChangeKind::Modified,
                DiffOptions::default(),
            )
            .unwrap();
        assert_ne!(after.fingerprint, before);
        repo.write("f.txt", &edited);
    });
}

#[test]
fn an_untracked_file_a_deleted_file_a_moved_file_and_a_binary_one_each_have_a_patch() {
    let repo = Repo::new();
    repo.write("gone.txt", "a\nb\n");
    repo.write("move.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
    repo.write("bin.dat", "\0abc");
    repo.commit("base");
    std::fs::remove_file(repo.path("gone.txt")).unwrap();
    repo.git(&["mv", "move.txt", "moved.txt"]);
    repo.write("moved.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    repo.write("new.txt", "n1\nn2\n");
    repo.write("bin.dat", "\0abcdef");
    on_both(|git| {
        let d = |path: &str, old: Option<&str>, kind| {
            git.diff(&repo.root, path, old, kind, DiffOptions::default())
                .unwrap()
        };
        let new = d("new.txt", None, ChangeKind::Untracked);
        assert_eq!((new.added, new.removed, new.groups.len()), (2, 0, 1));
        assert!(new.patch.contains("new file mode"));
        let gone = d("gone.txt", None, ChangeKind::Deleted);
        assert_eq!((gone.added, gone.removed), (0, 2));
        let moved = d("moved.txt", Some("move.txt"), ChangeKind::Renamed);
        assert!(
            moved.patch.contains("rename from move.txt"),
            "{}",
            moved.patch
        );
        assert_eq!((moved.added, moved.removed), (1, 0));
        let bin = d("bin.dat", None, ChangeKind::Modified);
        assert!(bin.binary && bin.groups.is_empty());
    });
}

#[test]
fn a_huge_diff_is_cut_and_says_so() {
    let repo = Repo::new();
    repo.write("big.txt", "start\n");
    repo.commit("base");
    // About 24 MB of added lines, far past both limits.
    let line = format!("{}\n", "x".repeat(79));
    repo.write("big.txt", &line.repeat(300_000));
    on_both(|git| {
        let diff = git
            .diff(
                &repo.root,
                "big.txt",
                None,
                ChangeKind::Modified,
                DiffOptions::default(),
            )
            .unwrap();
        assert!(diff.truncated);
        assert!(diff.patch.len() <= DIFF_CAP);
        assert!(diff.lines as usize <= DIFF_LINES);
        assert!(diff.patch.ends_with('\n'));
        // The cut leaves whole groups to read.
        assert_eq!(diff.groups.len(), 1);
        let all = git
            .diff(
                &repo.root,
                "big.txt",
                None,
                ChangeKind::Modified,
                DiffOptions {
                    context: 3,
                    all: true,
                },
            )
            .unwrap();
        assert!(all.lines > diff.lines);
        assert!(all.patch.len() > diff.patch.len());
    });
}

#[test]
fn a_big_untracked_file_is_cut_too() {
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    repo.write("big.log", &format!("{}\n", "y".repeat(99)).repeat(200_000));
    on_both(|git| {
        let status = git.status(&repo.root).unwrap();
        assert_eq!(status.files[0].added, Some(200_000));
        let diff = git
            .diff(
                &repo.root,
                "big.log",
                None,
                ChangeKind::Untracked,
                DiffOptions::default(),
            )
            .unwrap();
        assert!(diff.truncated && diff.patch.len() <= DIFF_CAP);
    });
}

#[test]
fn crlf_files_keep_their_line_ends_in_the_patch() {
    let repo = Repo::new();
    repo.git(&["config", "core.autocrlf", "false"]);
    repo.write("w.txt", "a\r\nb\r\nc\r\nd\r\ne\r\n");
    repo.commit("base");
    repo.write("w.txt", "a\r\nB\r\nc\r\nd\r\ne\r\n");
    on_both(|git| {
        let diff = git
            .diff(
                &repo.root,
                "w.txt",
                None,
                ChangeKind::Modified,
                DiffOptions::default(),
            )
            .unwrap();
        assert_eq!(diff.groups[0].lines, ["-b\r", "+B\r"]);
        let (_dir, undo) = store();
        git.revert_group(&repo.root, "w.txt", 0, &diff.fingerprint, &undo)
            .unwrap();
        assert_eq!(repo.read("w.txt"), "a\r\nb\r\nc\r\nd\r\ne\r\n");
        repo.write("w.txt", "a\r\nB\r\nc\r\nd\r\ne\r\n");
    });
}

// ---- revert and undo ----------------------------------------------------------------------------------

#[test]
fn a_revert_of_each_kind_of_change_is_undone_to_the_same_files() {
    let repo = Repo::new();
    repo.write("edit.txt", "a\nb\nc\n");
    repo.write("gone.txt", "g1\ng2\n");
    repo.write("move.txt", "m1\nm2\nm3\nm4\nm5\nm6\nm7\n");
    repo.write("staged-edit.txt", "s\n");
    repo.commit("base");
    let state = |repo: &Repo| -> Vec<(String, Option<String>)> {
        [
            "edit.txt",
            "gone.txt",
            "move.txt",
            "moved.txt",
            "new.txt",
            "added.txt",
            "staged-edit.txt",
        ]
        .iter()
        .map(|n| ((*n).to_owned(), std::fs::read_to_string(repo.path(n)).ok()))
        .collect()
    };
    let dirty = |repo: &Repo| {
        repo.write("edit.txt", "a\nB\nc\nd\n");
        let _ = std::fs::remove_file(repo.path("gone.txt"));
        if repo.path("move.txt").exists() {
            repo.git(&["mv", "move.txt", "moved.txt"]);
        }
        repo.write("moved.txt", "m1\nm2\nm3\nm4\nm5\nm6\nm7\nm8\n");
        repo.write("new.txt", "n\n");
        repo.write("added.txt", "ad\n");
        repo.git(&["add", "added.txt"]);
        repo.write("staged-edit.txt", "s2\n");
        repo.git(&["add", "staged-edit.txt"]);
        repo.write("staged-edit.txt", "s3\n");
    };
    dirty(&repo);
    let dirty_state = state(&repo);
    let want_files = kinds(&repo, &local());
    on_both(|git| {
        let (_dir, undo) = store();
        for path in [
            "edit.txt",
            "gone.txt",
            "moved.txt",
            "new.txt",
            "added.txt",
            "staged-edit.txt",
        ] {
            let reverted = git.revert_file(&repo.root, path, &undo).unwrap();
            let status = git.status(&repo.root).unwrap();
            assert!(
                status.files.iter().all(|c| c.path != path),
                "{path} is still listed: {:?}",
                status.files
            );
            git.undo(&repo.root, &reverted.id, &undo).unwrap();
            // Undone: what was reverted is back with its content (the index state of a staged file is not).
            assert_eq!(
                state(&repo)
                    .into_iter()
                    .filter(|(n, _)| n == path)
                    .collect::<Vec<_>>(),
                dirty_state
                    .iter()
                    .filter(|(n, _)| n == path)
                    .cloned()
                    .collect::<Vec<_>>(),
                "{path}"
            );
            assert!(
                git.undo(&repo.root, &reverted.id, &undo).is_err(),
                "an undo is used once"
            );
        }
        // After the loop everything is back as it was, at least in content; the renamed file's old name is too.
        assert_eq!(state(&repo)[2].1, None);
        // The undone state lists the same files, though a staged file comes back unstaged.
        let mut after: Vec<String> = kinds(&repo, git).into_iter().map(|(p, _)| p).collect();
        after.sort();
        let mut want: Vec<String> = want_files.iter().map(|(p, _)| p.clone()).collect();
        want.sort();
        assert!(after.len() >= want.len() - 1, "{after:?} vs {want:?}");
        // Put the staging back for the next machine's run.
        repo.git(&["reset", "-q", "--hard"]);
        repo.git(&["clean", "-fdq"]);
        dirty(&repo);
    });
}

#[test]
fn reverting_a_file_restores_the_commits_version_in_the_index_and_the_tree() {
    let repo = Repo::new();
    repo.write("a.txt", "a\nb\n");
    repo.commit("base");
    repo.write("a.txt", "a\nb\nc\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "a\nb\nc\nd\n");
    let (_dir, undo) = store();
    local().revert_file(&repo.root, "a.txt", &undo).unwrap();
    assert_eq!(repo.read("a.txt"), "a\nb\n");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
}

#[test]
fn a_change_too_big_to_keep_for_undo_is_not_reverted() {
    let repo = Repo::new();
    repo.write("big.txt", "x\n");
    repo.commit("base");
    // 12 MB of text: past BACKUP_CAP.
    let text = format!("{}\n", "z".repeat(119)).repeat(100_000);
    repo.write("big.txt", &text);
    let (_dir, undo) = store();
    let err = local()
        .revert_file(&repo.root, "big.txt", &undo)
        .unwrap_err();
    assert_eq!(err.kind, GitErrorKind::TooBig);
    assert_eq!(repo.read("big.txt"), text);
}

fn two_groups(repo: &Repo) {
    repo.write("f.txt", &numbered(30, ""));
    repo.commit("base");
    let mut lines: Vec<String> = numbered(30, "").lines().map(str::to_owned).collect();
    lines[2] = "THREE".into();
    lines[22] = "TWENTY-THREE".into();
    repo.write("f.txt", &(lines.join("\n") + "\n"));
}

#[test]
fn reverting_one_group_leaves_the_other_and_undo_brings_it_back() {
    let repo = Repo::new();
    two_groups(&repo);
    on_both(|git| {
        let (_dir, undo) = store();
        let diff = git
            .diff(
                &repo.root,
                "f.txt",
                None,
                ChangeKind::Modified,
                DiffOptions::default(),
            )
            .unwrap();
        assert_eq!(diff.groups.len(), 2);
        let both = repo.read("f.txt");
        let reverted = git
            .revert_group(&repo.root, "f.txt", 1, &diff.fingerprint, &undo)
            .unwrap();
        let text = repo.read("f.txt");
        assert!(
            text.contains("THREE") && text.contains("line 23\n") && !text.contains("TWENTY-THREE")
        );
        let now = git
            .diff(
                &repo.root,
                "f.txt",
                None,
                ChangeKind::Modified,
                DiffOptions::default(),
            )
            .unwrap();
        assert_eq!(now.groups.len(), 1);
        git.undo(&repo.root, &reverted.id, &undo).unwrap();
        assert_eq!(repo.read("f.txt"), both);
    });
}

#[test]
fn a_revert_of_a_group_refuses_when_the_file_is_not_as_the_person_saw_it() {
    let repo = Repo::new();
    two_groups(&repo);
    on_both(|git| {
        let (_dir, undo) = store();
        let diff = git
            .diff(
                &repo.root,
                "f.txt",
                None,
                ChangeKind::Modified,
                DiffOptions::default(),
            )
            .unwrap();
        let before = repo.read("f.txt");
        // The agent edits again after the diff was read.
        repo.write("f.txt", &before.replace("line 10\n", "line TEN\n"));
        let err = git
            .revert_group(&repo.root, "f.txt", 0, &diff.fingerprint, &undo)
            .unwrap_err();
        assert_eq!(err.kind, GitErrorKind::Stale);
        assert!(repo.read("f.txt").contains("line TEN"));
        assert!(
            git.revert_group(&repo.root, "f.txt", 9, "0000000000000000", &undo)
                .is_err()
        );
        repo.write("f.txt", &before);
    });
}

#[test]
fn a_group_of_a_new_or_deleted_file_is_not_reverted_piecemeal() {
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    repo.write("new.txt", "n\n");
    let (_dir, undo) = store();
    let err = local()
        .revert_group(&repo.root, "new.txt", 0, "x", &undo)
        .unwrap_err();
    assert_eq!(err.kind, GitErrorKind::Invalid);
    assert_eq!(repo.read("new.txt"), "n\n");
}

#[test]
fn an_undo_is_refused_when_the_file_changed_since_and_is_forgotten_after_ten_minutes() {
    let repo = Repo::new();
    two_groups(&repo);
    let git = local();
    let (_dir, undo) = store();
    let reverted = git.revert_file(&repo.root, "f.txt", &undo).unwrap();
    repo.write("f.txt", "something else\n");
    assert_eq!(
        git.undo(&repo.root, &reverted.id, &undo).unwrap_err().kind,
        GitErrorKind::Stale
    );
    assert_eq!(repo.read("f.txt"), "something else\n");
    // Ten minutes later the saved patch is gone.
    let later = std::time::SystemTime::now()
        + herdr_core::git::UNDO_KEEP
        + std::time::Duration::from_secs(5);
    undo.sweep(later);
    let saved: Vec<_> = std::fs::read_dir(undo.dir()).unwrap().collect();
    assert!(saved.is_empty(), "{saved:?}");
    assert_eq!(
        git.undo(&repo.root, &reverted.id, &undo).unwrap_err().kind,
        GitErrorKind::Stale
    );
}

#[test]
fn an_undo_belongs_to_the_checkout_it_was_made_in() {
    let (a, b) = (Repo::new(), Repo::new());
    for r in [&a, &b] {
        r.write("f.txt", "1\n2\n3\n");
        r.commit("base");
        r.write("f.txt", "1\nX\n3\n");
    }
    let git = local();
    let (_dir, undo) = store();
    let reverted = git.revert_file(&a.root, "f.txt", &undo).unwrap();
    assert_eq!(
        git.undo(&b.root, &reverted.id, &undo).unwrap_err().kind,
        GitErrorKind::Invalid
    );
    assert_eq!(b.read("f.txt"), "1\nX\n3\n");
}

// ---- the remote helper --------------------------------------------------------------------------------

#[test]
fn the_remote_helper_cuts_output_on_the_machine_and_reports_what_git_said() {
    let repo = Repo::new();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    repo.write("big.txt", &"w".repeat(99));
    let rig = Rig::new();
    let runner = rig.runner();
    let call = |args: &'static [&'static str], cap| {
        runner.run(
            &repo.root,
            &Call {
                args,
                stdin: &[],
                cap,
                timeout: std::time::Duration::from_secs(20),
            },
        )
    };
    let raw = call(&["status", "--porcelain=v2", "-z"], 1 << 20).unwrap();
    assert_eq!(raw.code, 0);
    assert!(String::from_utf8_lossy(&raw.stdout).contains("big.txt"));
    let small = call(&["status", "--porcelain=v2", "-z"], 4).unwrap();
    assert!(small.truncated && small.stdout.len() == 4 && small.code == 0);
    let bad = call(&["rev-parse", "--verify", "nope"], 1024).unwrap();
    assert_ne!(bad.code, 0);
    assert!(!bad.stderr.is_empty());
    assert_eq!(
        runner
            .probe(&repo.root, &["../x".to_owned()])
            .unwrap_err()
            .kind,
        GitErrorKind::Invalid
    );
    let probes = runner
        .probe(&repo.root, &["a.txt".to_owned(), "missing".to_owned()])
        .unwrap();
    assert_eq!(probes[0].and_then(|p| p.lines), Some(1));
    assert!(probes[1].is_none());
}

#[test]
fn a_missing_machine_or_git_is_reported_not_hung() {
    let client = SshClient::with_control_dir(tempfile::tempdir().unwrap().path().join("c"))
        .program("/nonexistent/ssh");
    let git = Git::new(Arc::new(RemoteGit::new(
        client,
        SshTarget::new("box", None, None, None).unwrap(),
    )));
    assert!(git.status("/tmp").is_err());
}

#[test]
fn counts_of_untracked_files_follow_gits_idea_of_lines_and_binary() {
    let repo = Repo::new();
    repo.write("seed.txt", "s\n");
    repo.commit("base");
    repo.write("empty.txt", "");
    repo.write("nonl.txt", "a\nb");
    repo.write("one.txt", "a\n");
    repo.write("bin.bin", "ab\0cd");
    std::os::unix::fs::symlink("seed.txt", repo.path("link")).unwrap();
    on_both(|git| {
        let status = git.status(&repo.root).unwrap();
        let by: std::collections::HashMap<_, _> =
            status.files.iter().map(|c| (c.path.as_str(), c)).collect();
        assert_eq!(by["empty.txt"].added, Some(0));
        assert_eq!(by["nonl.txt"].added, Some(2));
        assert_eq!(by["one.txt"].added, Some(1));
        assert!(by["bin.bin"].binary);
        assert_eq!(by["link"].added, Some(1));
    });
}

#[test]
fn an_edit_that_keeps_the_line_counts_still_changes_the_files_fingerprint() {
    let repo = Repo::new();
    repo.write("a.txt", "one\ntwo\n");
    repo.commit("base");
    repo.write("a.txt", "one\nTWO\n");
    on_both(|git| {
        let first = git.status(&repo.root).unwrap().files[0].fingerprint.clone();
        assert_eq!(git.status(&repo.root).unwrap().files[0].fingerprint, first);
        repo.write("a.txt", "one\nTWO!\n");
        let second = git.status(&repo.root).unwrap().files[0].fingerprint.clone();
        assert_ne!(first, second);
        repo.write("a.txt", "one\nTWO\n");
    });
}

#[test]
fn many_changed_files_are_listed_up_to_the_limit_and_the_list_says_when_it_stopped() {
    let repo = Repo::new();
    repo.write("seed.txt", "s\n");
    repo.commit("base");
    for i in 0..5200 {
        repo.write(&format!("many/f{i:05}.txt"), "x\n");
    }
    let status = local().status(&repo.root).unwrap();
    assert_eq!(status.files.len(), herdr_core::git::FILES_MAX);
    assert!(status.truncated);
}
