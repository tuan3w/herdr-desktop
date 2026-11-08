//! `worktree.list` and `worktree.create` against the fake herdr (in-memory repositories; nothing real is touched).

use std::time::Duration;

use herdr_core::link::LocalWire;
use herdr_core::testing::{FakeHerdr, FakeRepo, FakeWorktrees, Script};
use herdr_core::worktree::{self, MAX_BRANCH_BYTES, Problem, branch_error};
use serde_json::json;
use tempfile::tempdir;

const PATIENCE: Duration = Duration::from_secs(5);

fn served(
    repos: Vec<FakeRepo>,
) -> (
    tempfile::TempDir,
    FakeHerdr,
    std::sync::Arc<FakeWorktrees>,
    LocalWire,
) {
    let dir = tempdir().unwrap();
    let fake = FakeWorktrees::new(repos);
    let herdr = FakeHerdr::start(dir.path(), Script::new().worktrees(fake.clone())).unwrap();
    let wire = LocalWire::new(herdr.socket_path());
    (dir, herdr, fake, wire)
}

fn repo() -> FakeRepo {
    FakeRepo::new("/src/api").linked("/src/api-checkout", "feature/checkout")
}

#[test]
fn list_gives_every_checkout_with_its_branch() {
    let (_dir, herdr, _fake, wire) = served(vec![repo()]);
    // A folder inside a linked checkout belongs to the same repository.
    let list = worktree::list(&wire, "/src/api-checkout/src", PATIENCE).unwrap();
    assert_eq!(list.repo_root, "/src/api");
    let branches: Vec<_> = list
        .worktrees
        .iter()
        .map(|w| (w.path.as_str(), w.branch.as_deref(), w.is_linked))
        .collect();
    assert_eq!(
        branches,
        [
            ("/src/api", Some("main"), false),
            ("/src/api-checkout", Some("feature/checkout"), true)
        ]
    );
    assert_eq!(
        herdr.requests_of("worktree.list")[0].params,
        json!({"cwd": "/src/api-checkout/src"})
    );
}

#[test]
fn a_detached_checkout_has_no_branch() {
    let dir = tempdir().unwrap();
    let herdr = FakeHerdr::start(
        dir.path(),
        Script::new().on(
            "worktree.list",
            json!({"type": "worktree_list", "source": {"repo_key": "k", "repo_name": "r", "repo_root": "/r", "source_checkout_path": "/r"},
                   "worktrees": [{"path": "/r", "branch": null, "label": "r", "is_bare": false, "is_detached": true,
                                  "is_prunable": true, "is_linked_worktree": false}]}),
        ),
    )
    .unwrap();
    let list = worktree::list(&LocalWire::new(herdr.socket_path()), "/r", PATIENCE).unwrap();
    assert_eq!(list.worktrees[0].branch, None);
    assert!(list.worktrees[0].is_detached && list.worktrees[0].is_prunable);
}

#[test]
fn create_sends_exactly_cwd_branch_and_focus_false_then_the_list_shows_it() {
    let (_dir, herdr, _fake, wire) = served(vec![repo()]);
    let made = worktree::create(
        &wire,
        "/src/api",
        Some("worktree/brave-meadow-45e8"),
        PATIENCE,
    )
    .unwrap();
    assert_eq!(
        herdr.requests_of("worktree.create")[0].params,
        json!({"cwd": "/src/api", "branch": "worktree/brave-meadow-45e8", "focus": false})
    );
    assert_eq!(
        made.worktree.branch.as_deref(),
        Some("worktree/brave-meadow-45e8")
    );
    assert!(made.worktree.is_linked);
    assert_eq!(made.worktree.path, "/src/api-brave-meadow-45e8");
    assert!(
        made.workspace_id.starts_with('w')
            && made.pane_id.ends_with(":p1")
            && !made.tab_id.is_empty()
    );

    let list = worktree::list(&wire, "/src/api", PATIENCE).unwrap();
    assert_eq!(list.worktrees.len(), 3);
}

#[test]
fn create_without_a_branch_omits_it_and_herdr_names_it() {
    let (_dir, herdr, _fake, wire) = served(vec![repo()]);
    let made = worktree::create(&wire, "/src/api", None, PATIENCE).unwrap();
    assert_eq!(
        herdr.requests_of("worktree.create")[0].params,
        json!({"cwd": "/src/api", "focus": false})
    );
    assert!(made.worktree.branch.is_some());
}

#[test]
fn trust_repository_is_never_sent() {
    let (_dir, herdr, _fake, wire) = served(vec![repo()]);
    worktree::list(&wire, "/src/api", PATIENCE).unwrap();
    worktree::create(&wire, "/src/api", Some("a"), PATIENCE).unwrap();
    for r in herdr.requests() {
        assert!(r.params.get("trust_repository").is_none(), "{r:?}");
    }
}

#[test]
fn an_untrusted_repository_is_reported_not_overridden() {
    let (_dir, herdr, _fake, wire) = served(vec![FakeRepo::new("/src/web").untrusted()]);
    let list = worktree::list(&wire, "/src/web", PATIENCE).unwrap_err();
    assert_eq!(list.problem, Problem::Untrusted);
    let create = worktree::create(&wire, "/src/web", Some("a"), PATIENCE).unwrap_err();
    assert_eq!(create.problem, Problem::Untrusted);
    assert!(!create.is_retryable());
    assert!(
        herdr
            .requests()
            .iter()
            .all(|r| r.params.get("trust_repository").is_none())
    );
}

#[test]
fn failures_are_classified() {
    let (_dir, _herdr, fake, wire) = served(vec![repo()]);
    assert_eq!(
        worktree::list(&wire, "/elsewhere", PATIENCE)
            .unwrap_err()
            .problem,
        Problem::NotARepo
    );
    // A branch that exists is herdr's refusal, in herdr's words.
    let exists =
        worktree::create(&wire, "/src/api", Some("feature/checkout"), PATIENCE).unwrap_err();
    assert_eq!(exists.problem, Problem::Refused);
    assert!(exists.message.contains("already exists"));
    fake.fail_next_create("hook_failed", "the worktree.created hook exited 1");
    assert_eq!(
        worktree::create(&wire, "/src/api", None, PATIENCE)
            .unwrap_err()
            .message,
        "the worktree.created hook exited 1"
    );
}

#[test]
fn a_herdr_without_worktrees_is_unsupported() {
    let dir = tempdir().unwrap();
    let herdr = FakeHerdr::start(dir.path(), Script::new()).unwrap();
    let wire = LocalWire::new(herdr.socket_path());
    assert_eq!(
        worktree::list(&wire, "/r", PATIENCE).unwrap_err().problem,
        Problem::Unsupported
    );
    assert_eq!(
        worktree::create(&wire, "/r", None, PATIENCE)
            .unwrap_err()
            .problem,
        Problem::Unsupported
    );
}

#[test]
fn a_machine_that_cannot_be_reached_is_retryable_not_unsupported() {
    let dir = tempdir().unwrap();
    let wire = LocalWire::new(dir.path().join("nothing-listens.sock"));
    let error = worktree::list(&wire, "/r", PATIENCE).unwrap_err();
    assert!(
        error.is_retryable() || error.problem == Problem::Fatal,
        "{error:?}"
    );
    assert_ne!(error.problem, Problem::Unsupported);
}

/// Names git or a shell would treat as more than a name: none reaches herdr, none is quietly cleaned.
#[test]
fn a_bad_branch_is_rejected_with_a_reason_and_nothing_is_sent() {
    let long = "a".repeat(MAX_BRANCH_BYTES + 1);
    let bad = [
        "",
        "a;touch x",
        "$(x)",
        "`id`",
        "a|b",
        "a&b",
        "a>b",
        "a\"b",
        "a'b",
        "--force",
        "-b",
        "a b",
        " a",
        "a\nb",
        "a\rb",
        "a\tb",
        "a\0b",
        "a\u{7f}b",
        "feature/é",
        "ブランチ",
        "a\u{202e}b",
        "a..b",
        "..",
        "a@{1}",
        "@",
        "a~1",
        "a^",
        "a:b",
        "a?b",
        "a*b",
        "a[b",
        "a\\b",
        "x.lock",
        "feature.lock/x",
        "/a",
        "a/",
        "a//b",
        "a.",
        ".hidden",
        "a/.hidden",
        long.as_str(),
    ];
    let (_dir, herdr, _fake, wire) = served(vec![repo()]);
    for name in bad {
        assert!(branch_error(name).is_some(), "{name:?} should be rejected");
        let error = worktree::create(&wire, "/src/api", Some(name), PATIENCE).unwrap_err();
        assert_eq!(error.problem, Problem::Invalid, "{name:?}");
        assert!(!error.message.is_empty());
    }
    assert!(herdr.requests_of("worktree.create").is_empty());
}

#[test]
fn ordinary_branches_are_accepted_and_travel_only_as_a_json_parameter() {
    let ok = [
        "feature/x",
        "worktree/brave-meadow-45e8",
        "fix_1.2",
        "release-1.0.0",
        "a",
        "user/jane/topic+1",
        &"a".repeat(MAX_BRANCH_BYTES),
    ];
    let (_dir, herdr, _fake, wire) = served(vec![repo()]);
    for name in ok {
        assert_eq!(branch_error(name), None, "{name:?}");
        worktree::create(&wire, "/src/api", Some(name), PATIENCE).unwrap();
    }
    let sent = herdr.requests_of("worktree.create");
    assert_eq!(sent.len(), ok.len());
    for (request, name) in sent.iter().zip(ok) {
        assert_eq!(request.params["branch"], json!(name));
    }
}
