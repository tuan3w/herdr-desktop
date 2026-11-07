//! Quick open: finding a project's files by a few typed letters, on this computer and on a remote machine.
//!
//! The remote side is the real `fs.py` on a local python3 behind a stand-in `ssh` that runs the generated command with
//! `sh -c` (as `tests/files.rs` does), so the real quoting is what executes. Behaviour both machines share is checked
//! against both; what only this computer does (modified times, the ignored-files walk) against this one.

use std::fs::{self, File, FileTimes};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use herdr_core::files::{
    FileErrorKind, Files, LocalFiles, Quick, QuickHit, QuickSearch, RemoteFiles, TreeLimits,
    keep_path,
};
use herdr_core::ssh::{SshClient, SshTarget};

/// A stand-in `ssh` that runs the remote command locally.
struct Rig {
    dir: tempfile::TempDir,
    home: PathBuf,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let script = format!(
            r#"#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
shift
HOME="{home}" exec sh -c "exec $1"
"#,
            home = home.display()
        );
        fs::write(dir.path().join("ssh"), script).unwrap();
        Self { dir, home }
    }

    fn remote(&self) -> Arc<dyn Files> {
        let client = SshClient::with_control_dir(self.dir.path().join("control"))
            .program("/bin/sh")
            .program_arg(self.dir.path().join("ssh"));
        Arc::new(RemoteFiles::new(
            client,
            SshTarget::new("box", None, None, None).unwrap(),
        ))
    }
}

fn local() -> Arc<dyn Files> {
    Arc::new(LocalFiles::new())
}

/// Runs `check` once against this computer and once against a remote machine, each with its own folder.
fn on_both(check: impl Fn(&Arc<dyn Files>, &Path)) {
    let work = tempfile::tempdir().unwrap();
    check(&local(), work.path());
    let work = tempfile::tempdir().unwrap();
    check(&Rig::new().remote(), work.path());
}

fn s(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn make(root: &Path, files: &[&str]) {
    for file in files {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, file).unwrap();
    }
}

fn find(files: &Arc<dyn Files>, root: &Path, query: &str) -> QuickSearch {
    Quick::new().search("m", files, s(root), query, 50).unwrap()
}

fn paths(found: &QuickSearch) -> Vec<&str> {
    found.hits.iter().map(|h| h.path.as_str()).collect()
}

/// The text a hit's marks cover, read back through UTF-16 the way a JavaScript string is indexed.
fn marked(hit: &QuickHit) -> Vec<String> {
    let units: Vec<u16> = hit.path.encode_utf16().collect();
    hit.marks
        .chunks(2)
        .map(|pair| String::from_utf16(&units[pair[0] as usize..pair[1] as usize]).unwrap())
        .collect()
}

fn set_modified(path: &Path, seconds: u64) {
    let at = SystemTime::UNIX_EPOCH + Duration::from_secs(seconds);
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(FileTimes::new().set_modified(at))
        .unwrap();
}

#[test]
fn a_folder_and_a_name_fragment_find_the_file() {
    on_both(|files, work| {
        make(
            work,
            &[
                "components/palette.tsx",
                "ui/palette.tsx",
                "docs/pal.md",
                "lib/nav.ts",
            ],
        );
        for query in ["ui/pal", "ui pal"] {
            let found = find(files, work, query);
            assert_eq!(paths(&found), ["ui/palette.tsx"], "{query}");
        }
        let found = find(files, work, "comp pal");
        assert_eq!(paths(&found), ["components/palette.tsx"]);
        assert_eq!(found.hits[0].name, "palette.tsx");
        assert_eq!(found.hits[0].dir, "components");
        let found = find(files, work, "pal");
        assert_eq!(found.total, 3);
        assert_eq!(found.indexed, 4);
        assert!(!found.truncated);
    });
}

#[test]
fn every_word_must_match_and_a_name_match_beats_a_folder_match() {
    on_both(|files, work| {
        make(
            work,
            &[
                "pal/other.rs",
                "src/palette.rs",
                "src/a/b/c/readme.md",
                "src/readme.md",
                "x/readme.txt",
            ],
        );
        assert_eq!(paths(&find(files, work, "pal"))[0], "src/palette.rs");
        // A word that matches nothing excludes the file, however well the other matches.
        assert!(find(files, work, "pal zzz").hits.is_empty());
        // Equal matches: the shorter path first.
        let found = find(files, work, "readme.md");
        assert_eq!(paths(&found), ["src/readme.md", "src/a/b/c/readme.md"]);
    });
}

#[test]
fn a_name_without_its_diacritics_is_found() {
    on_both(|files, work| {
        make(work, &["docs/Định.md", "docs/other.md"]);
        let found = find(files, work, "dinh");
        assert_eq!(paths(&found), ["docs/Định.md"]);
        assert_eq!(found.hits[0].marks, [5, 9]);
        assert_eq!(marked(&found.hits[0]), ["Định"]);
    });
}

#[test]
fn marks_count_utf16_units_even_after_an_emoji_and_an_accent() {
    on_both(|files, work| {
        make(work, &["📁 docs/😀 café-plan.md", "📁 docs/zzz.md"]);
        let found = find(files, work, "cafe plan");
        assert_eq!(paths(&found), ["📁 docs/😀 café-plan.md"]);
        // `📁 docs/` is 8 units and `😀 ` 3 more: `café` starts at 11, the dash is 15, `plan` is 16..20.
        assert_eq!(found.hits[0].marks, [11, 15, 16, 20]);
        assert_eq!(marked(&found.hits[0]), ["café", "plan"]);
        // A word that matches only in a folder marks the folder.
        let found = find(files, work, "docs zzz");
        assert_eq!(marked(&found.hits[0]), ["docs", "zzz"]);
        assert_eq!(found.hits[0].marks[..2], [3, 7]);
    });
}

#[test]
fn hidden_folders_and_files_are_not_listed_except_project_ones() {
    on_both(|files, work| {
        make(
            work,
            &[
                ".git/config",
                ".cache/data.txt",
                ".env",
                ".github/workflows/ci.yml",
                ".gitignore",
                ".oxlintrc.json",
                "web/.env.example",
                "node_modules/left-pad/index.js",
                "src/main.rs",
            ],
        );
        // `make` fills each file with its own name, which as a .gitignore would hide itself.
        fs::write(work.join(".gitignore"), "").unwrap();
        let mut listed: Vec<String> = find(files, work, "")
            .hits
            .into_iter()
            .map(|h| h.path)
            .collect();
        listed.sort();
        assert_eq!(
            listed,
            [
                ".github/workflows/ci.yml",
                ".gitignore",
                ".oxlintrc.json",
                "src/main.rs",
                "web/.env.example",
            ]
        );
        assert!(keep_path(".github/x.yml") && !keep_path(".git/HEAD"));
    });
}

#[test]
fn a_gitignored_file_comes_second_flagged_and_only_for_a_longer_query() {
    let work = tempfile::tempdir().unwrap();
    make(
        work.path(),
        &[
            ".gitignore",
            "secret.log",
            "out/secret-build.txt",
            "notes/the-secret-plan.md",
            "src/main.rs",
            "node_modules/secret/index.js",
            ".git/secret",
        ],
    );
    fs::write(work.path().join(".gitignore"), "secret.log\nout/\n").unwrap();
    let files = local();
    let quick = Quick::new();
    let first = quick.search("m", &files, s(work.path()), "se", 50).unwrap();
    assert!(first.hits.iter().all(|h| !h.ignored), "{:?}", paths(&first));

    let found = quick
        .search("m", &files, s(work.path()), "secret", 50)
        .unwrap();
    assert_eq!(
        found
            .hits
            .iter()
            .map(|h| (h.path.as_str(), h.ignored))
            .collect::<Vec<_>>(),
        [
            ("notes/the-secret-plan.md", false),
            ("secret.log", true),
            ("out/secret-build.txt", true),
        ],
        "never node_modules or .git, and not before a file git does not ignore"
    );
    assert_eq!(found.total, 3);
    // The index itself never held the ignored files.
    assert_eq!(found.indexed, 3);
    assert!(found.hits[1].marks == [0, 6] && found.hits[1].dir.is_empty());
    // A limit cuts the ignored ones first.
    let one = quick
        .search("m", &files, s(work.path()), "secret", 1)
        .unwrap();
    assert_eq!(paths(&one), ["notes/the-secret-plan.md"]);
    assert_eq!(one.total, 3);
}

#[test]
fn a_hidden_file_is_found_by_the_second_pass_and_a_remote_machine_has_none() {
    let work = tempfile::tempdir().unwrap();
    make(work.path(), &[".env", "src/environment.rs"]);
    let found = find(&local(), work.path(), "env");
    assert_eq!(paths(&found), ["src/environment.rs", ".env"]);
    assert!(found.hits[1].ignored && !found.hits[0].ignored);

    let rig = Rig::new();
    let found = find(&rig.remote(), work.path(), "env");
    assert_eq!(paths(&found), ["src/environment.rs"]);
}

#[test]
fn a_walk_that_hits_a_limit_says_it_was_cut() {
    on_both(|files, work| {
        make(work, &["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
        let cut = |limits: TreeLimits| {
            Quick::new()
                .with_limits(limits)
                .search("m", files, s(work), "", 50)
                .unwrap()
        };
        let by_paths = cut(TreeLimits {
            paths: 3,
            ..TreeLimits::INDEX
        });
        assert!(by_paths.truncated);
        assert_eq!(by_paths.indexed, 3);
        let by_bytes = cut(TreeLimits {
            bytes: 12,
            ..TreeLimits::INDEX
        });
        assert!(by_bytes.truncated);
        assert_eq!(by_bytes.indexed, 2);
        let whole = cut(TreeLimits::INDEX);
        assert!(!whole.truncated);
        assert_eq!(whole.indexed, 5);
    });
    // A walk that is out of time keeps what it has and says so.
    let work = tempfile::tempdir().unwrap();
    make(work.path(), &["a.txt", "b.txt"]);
    let found = Quick::new()
        .with_limits(TreeLimits {
            time: Duration::ZERO,
            ..TreeLimits::INDEX
        })
        .search("m", &local(), s(work.path()), "", 50)
        .unwrap();
    assert!(found.truncated);
}

#[test]
fn an_empty_query_lists_the_newest_files_first() {
    let work = tempfile::tempdir().unwrap();
    make(
        work.path(),
        &["old.txt", "mid/middle.txt", "new.txt", "older.txt"],
    );
    for (file, at) in [
        ("old.txt", 1_000),
        ("mid/middle.txt", 2_000),
        ("new.txt", 3_000),
        ("older.txt", 500),
    ] {
        set_modified(&work.path().join(file), at);
    }
    let found = Quick::new()
        .search("m", &local(), s(work.path()), "  ", 3)
        .unwrap();
    assert_eq!(paths(&found), ["new.txt", "mid/middle.txt", "old.txt"]);
    assert_eq!(found.total, 4);
    assert!(found.hits.iter().all(|h| h.marks.is_empty()));
}

#[test]
fn a_link_out_of_the_root_is_never_followed() {
    let outside = tempfile::tempdir().unwrap();
    make(outside.path(), &["secret/passwords.txt", "loose.txt"]);
    let work = tempfile::tempdir().unwrap();
    make(work.path(), &["src/real.rs"]);
    symlink(outside.path().join("secret"), work.path().join("escape")).unwrap();
    symlink(
        outside.path().join("loose.txt"),
        work.path().join("loose-link.txt"),
    )
    .unwrap();
    symlink(
        work.path().join("src/real.rs"),
        work.path().join("inside-link.rs"),
    )
    .unwrap();
    symlink(work.path().join("src"), work.path().join("src-link")).unwrap();
    let found = find(&local(), work.path(), "");
    let mut listed = paths(&found);
    listed.sort_unstable();
    assert_eq!(listed, ["inside-link.rs", "src/real.rs"]);
}

#[test]
fn a_root_that_is_not_a_folder_is_an_error_not_an_empty_list() {
    on_both(|files, work| {
        make(work, &["file.txt"]);
        let quick = Quick::new();
        let missing = work.join("nowhere");
        let err = quick.warm("m", files, s(&missing)).unwrap_err();
        assert_eq!(err.kind, FileErrorKind::NotFound);
        let err = quick
            .warm("m", files, s(&work.join("file.txt")))
            .unwrap_err();
        assert_eq!(err.kind, FileErrorKind::NotADirectory);
        let err = quick.warm("m", files, "relative/path").unwrap_err();
        assert_eq!(err.kind, FileErrorKind::Invalid);
        assert_eq!(quick.warm("m", files, s(work)).unwrap(), 1);
    });
}

#[test]
fn an_old_index_answers_at_once_and_a_new_walk_replaces_it() {
    let work = tempfile::tempdir().unwrap();
    make(work.path(), &["first.txt"]);
    let files = local();
    let quick = Quick::new().with_refresh_after(Duration::ZERO);
    assert_eq!(quick.warm("m", &files, s(work.path())).unwrap(), 1);
    make(work.path(), &["second.txt"]);
    // The next ask is answered from what is in memory and starts the refresh behind it.
    let started = Instant::now();
    loop {
        let found = quick
            .search("m", &files, s(work.path()), "second", 50)
            .unwrap();
        if !found.hits.is_empty() {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the refresh never landed"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn two_roots_and_two_machines_keep_their_own_indexes() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    make(a.path(), &["only-in-a.txt"]);
    make(b.path(), &["only-in-b.txt"]);
    let files = local();
    let quick = Quick::new();
    let in_a = quick.search("m", &files, s(a.path()), "only", 50).unwrap();
    let in_b = quick.search("m", &files, s(b.path()), "only", 50).unwrap();
    assert_eq!(paths(&in_a), ["only-in-a.txt"]);
    assert_eq!(paths(&in_b), ["only-in-b.txt"]);
}

// ---- a remote machine ---------------------------------------------------------------------

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()
        .expect("git is installed");
    assert!(status.success(), "git {args:?}");
}

#[test]
fn a_checkout_on_a_remote_machine_lists_what_git_lists() {
    let rig = Rig::new();
    let work = tempfile::tempdir().unwrap();
    git(work.path(), &["init", "-q"]);
    make(
        work.path(),
        &[
            "src/tracked.rs",
            "src/removed.rs",
            "src/untracked.rs",
            "build/ignored-output.txt",
            "dist/kept-by-git.txt",
        ],
    );
    fs::write(work.path().join(".gitignore"), "build/\n").unwrap();
    git(
        work.path(),
        &[
            "add",
            "src/tracked.rs",
            "src/removed.rs",
            "dist/kept-by-git.txt",
        ],
    );
    fs::remove_file(work.path().join("src/removed.rs")).unwrap();
    let found = find(&rig.remote(), work.path(), "");
    let mut listed = paths(&found);
    listed.sort_unstable();
    assert_eq!(
        listed,
        [
            ".gitignore",
            "dist/kept-by-git.txt",
            "src/tracked.rs",
            "src/untracked.rs",
        ],
        "a deleted tracked file and an ignored one are not listed; a tracked `dist/` is"
    );
}

#[test]
fn a_remote_folder_that_is_not_a_checkout_skips_junk_folders_and_names_with_newlines_survive() {
    let rig = Rig::new();
    let work = tempfile::tempdir().unwrap();
    make(
        work.path(),
        &[
            "src/a.rs",
            "target/debug/x.rs",
            "node_modules/p/index.js",
            "dist/bundle.js",
            "build/out.o",
            "pkg/__pycache__/a.pyc",
            "line\nbreak.txt",
            "ünï/日本語.md",
        ],
    );
    let found = find(&rig.remote(), work.path(), "");
    let mut listed = paths(&found);
    listed.sort_unstable();
    assert_eq!(listed, ["line\nbreak.txt", "src/a.rs", "ünï/日本語.md"]);
}

/// Names a shell would act on, as folders on the remote machine and as the root asked about.
const HOSTILE: [&str; 7] = [
    "; rm -rf ~ ;",
    "`touch PWNED`",
    "$(touch PWNED)",
    "line one\nline two",
    "it's a 'quote'",
    "\"double\" && touch PWNED",
    "& touch PWNED &",
];

#[test]
fn a_root_that_is_a_shell_command_lists_its_files_and_runs_nothing() {
    let rig = Rig::new();
    let remote = rig.remote();
    let work = tempfile::tempdir().unwrap();
    for name in HOSTILE {
        make(&work.path().join(name), &["inner.txt"]);
    }
    for name in HOSTILE {
        let root = work.path().join(name);
        let quick = Quick::new();
        let found = quick.search("m", &remote, s(&root), "inner", 50).unwrap();
        assert_eq!(paths(&found), ["inner.txt"], "{name:?}");
    }
    // A root that names nothing is not found, and still runs nothing.
    let marker = rig.dir.path().join("MARKER");
    for root in [
        format!("/x'; touch {}; echo '", marker.display()),
        format!("/$(touch {})", marker.display()),
        format!("/`touch {}`", marker.display()),
        format!("/x\ntouch {}", marker.display()),
    ] {
        let err = Quick::new().warm("m", &remote, &root).unwrap_err();
        assert_eq!(err.kind, FileErrorKind::NotFound, "{root:?}");
    }
    for place in [
        work.path().to_path_buf(),
        std::env::current_dir().unwrap(),
        rig.home.clone(),
    ] {
        assert!(
            !place.join("PWNED").exists(),
            "{} holds a file a crafted name created",
            place.display()
        );
    }
    assert!(!marker.exists(), "a crafted root ran its command");
}

/// Real ssh to `$HERDR_DESKTOP_SSH_TEST` (for example `me@localhost`): quick open over a checkout and a plain folder.
/// `cargo test --test files_quick -- --ignored`.
#[test]
#[ignore = "needs a reachable ssh destination in HERDR_DESKTOP_SSH_TEST"]
fn real_ssh_lists_a_checkout_and_a_plain_folder() {
    let Some(dest) = std::env::var("HERDR_DESKTOP_SSH_TEST")
        .ok()
        .filter(|d| !d.is_empty())
    else {
        panic!("HERDR_DESKTOP_SSH_TEST is not set");
    };
    let data = tempfile::tempdir().unwrap();
    let client = SshClient::new(data.path()).unwrap();
    let files: Arc<dyn Files> = Arc::new(RemoteFiles::new(
        client,
        SshTarget::new(&dest, None, None, None).unwrap(),
    ));
    let plain = tempfile::tempdir().unwrap();
    make(
        plain.path(),
        &["it's; $(odd)/palette.tsx", "node_modules/x.js"],
    );
    let found = find(&files, plain.path(), "pal");
    assert_eq!(paths(&found), ["it's; $(odd)/palette.tsx"]);
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q"]);
    make(repo.path(), &["src/palette.rs", "ignored.log"]);
    fs::write(repo.path().join(".gitignore"), "ignored.log\n").unwrap();
    let found = find(&files, repo.path(), "");
    let mut listed = paths(&found);
    listed.sort_unstable();
    assert_eq!(listed, [".gitignore", "src/palette.rs"]);
}
