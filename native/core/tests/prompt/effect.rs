//! The consequence of a finished tool call: what the supervisor is told it did outside the machine.

use herdr_core::prompt::{EffectKind, tool_effect};

use EffectKind::{Delete, Infra, Install, Publish, Push};

/// (command, expected). `None` is a call that folds: it changed nothing a supervisor must hear about.
const CASES: &[(&str, Option<(EffectKind, &str)>)] = &[
    // Push: the text names a remote and a ref only when the command does.
    (
        "git push origin main",
        Some((Push, "Pushed to origin/main")),
    ),
    ("git push", Some((Push, "Pushed to a remote"))),
    (
        "git push -u origin feature/x",
        Some((Push, "Pushed to origin/feature/x")),
    ),
    ("git push origin", Some((Push, "Pushed to origin"))),
    (
        "git push --force-with-lease origin main",
        Some((Push, "Force-pushed to origin/main")),
    ),
    (
        "git push -f origin main",
        Some((Push, "Force-pushed to origin/main")),
    ),
    (
        "git -C repo push origin main",
        Some((Push, "Pushed to origin/main")),
    ),
    (
        "git push origin HEAD:main",
        Some((Push, "Pushed to origin/main")),
    ),
    ("git push origin :old", Some((Push, "Pushed to a remote"))),
    (
        "git push origin --delete old",
        Some((Push, "Pushed to a remote")),
    ),
    (
        "git push https://u:tok@host/r.git main",
        Some((Push, "Pushed to a remote")),
    ),
    ("git push --dry-run origin main", None),
    ("git push -n origin main", None),
    // Delete.
    (
        "rm -rf node_modules",
        Some((Delete, "Deleted node_modules")),
    ),
    ("rm file", Some((Delete, "Deleted file"))),
    ("rm a b c", Some((Delete, "Deleted 3 files"))),
    ("rm -r a b", Some((Delete, "Deleted 2 paths"))),
    ("rm *.log", Some((Delete, "Deleted files"))),
    ("rm -rf $DIR", Some((Delete, "Deleted files"))),
    ("find . -name x -delete", Some((Delete, "Deleted files"))),
    (
        "curl -X DELETE https://x/y",
        Some((Delete, "Sent a DELETE request")),
    ),
    // Install.
    (
        "cargo install ripgrep",
        Some((Install, "Installed ripgrep")),
    ),
    (
        "npm install left-pad lodash",
        Some((Install, "Installed left-pad, lodash")),
    ),
    ("pnpm add -D vitest", Some((Install, "Installed vitest"))),
    ("npm i", Some((Install, "Installed dependencies"))),
    ("yarn add react", Some((Install, "Installed react"))),
    ("bun add zod", Some((Install, "Installed zod"))),
    (
        "pip install requests",
        Some((Install, "Installed requests")),
    ),
    (
        "pip3 install -r req.txt",
        Some((Install, "Installed packages")),
    ),
    (
        "python3 -m pip install rich",
        Some((Install, "Installed rich")),
    ),
    ("cargo add serde", Some((Install, "Installed serde"))),
    ("brew install jq", Some((Install, "Installed jq"))),
    (
        "sudo apt-get install -y curl",
        Some((Install, "Installed curl")),
    ),
    ("gem install rake", Some((Install, "Installed rake"))),
    ("go install ./cmd/x", Some((Install, "Installed ./cmd/x"))),
    ("npm install --dry-run left-pad", None),
    // Publish and infrastructure.
    (
        "gh pr merge 12 --squash",
        Some((Publish, "Merged a pull request")),
    ),
    ("npm publish", Some((Publish, "Published a package"))),
    ("cargo publish", Some((Publish, "Published a crate"))),
    ("docker push me/app:1", Some((Publish, "Pushed an image"))),
    ("kubectl apply -f x", Some((Infra, "Ran kubectl apply"))),
    (
        "terraform apply -auto-approve",
        Some((Infra, "Ran terraform apply")),
    ),
    ("kubectl apply -f x --dry-run=client", None),
    // Chains take the most consequential effect present.
    (
        "cargo test && git push origin main",
        Some((Push, "Pushed to origin/main")),
    ),
    (
        "git push origin main; rm -rf build",
        Some((Push, "Pushed to origin/main")),
    ),
    (
        "rm -rf build && npm install",
        Some((Delete, "Deleted build")),
    ),
    (
        "npm install && npm publish",
        Some((Publish, "Published a package")),
    ),
    ("git status | git push", Some((Push, "Pushed to a remote"))),
    ("git push --dry-run && cargo build", None),
    (
        "cd app\ngit push origin main",
        Some((Push, "Pushed to origin/main")),
    ),
    (
        "git push origin main 2>&1 | tail -3",
        Some((Push, "Pushed to origin/main")),
    ),
    (
        "FOO=1 git push origin main",
        Some((Push, "Pushed to origin/main")),
    ),
    (
        "bash -c 'git push origin main'",
        Some((Push, "Pushed to origin/main")),
    ),
    // Quoted or printed text is not a command.
    ("echo 'git push origin main'", None),
    ("echo git push", None),
    (r#"git commit -m "rm -rf everything, then git push""#, None),
    (r#"rg "npm install" src"#, None),
    ("cat install.sh", None),
    // Read-only and local work folds.
    ("npm test", None),
    ("cargo build", None),
    ("git status", None),
    ("git log --oneline", None),
    ("git diff", None),
    ("ls -la", None),
    ("grep -rn push src", None),
    ("find . -name '*.rs'", None),
    ("curl https://x", None),
    ("mkdir out && mv a out/", None),
    ("git commit -m wip", None),
    ("git reset --hard", None),
    ("ssh host ls", None),
    ("", None),
];

#[test]
fn a_finished_command_is_classified_by_what_it_does_outside() {
    let mut wrong = Vec::new();
    for (cmd, want) in CASES {
        let got = tool_effect(Some("execute"), Some(cmd)).map(|e| (e.kind, e.text));
        let want = want.map(|(k, t)| (k, t.to_string()));
        if got != want {
            wrong.push(format!("{cmd:?}: want {want:?}, got {got:?}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {}:\n{}",
        wrong.len(),
        CASES.len(),
        wrong.join("\n")
    );
}

#[test]
fn the_table_covers_every_kind_and_enough_rows() {
    assert!(CASES.len() >= 40);
    for kind in [Push, Delete, Install, Publish, Infra] {
        assert!(
            CASES.iter().any(|(_, w)| w.is_some_and(|(k, _)| k == kind)),
            "{kind:?}"
        );
    }
}

#[test]
fn only_a_command_has_an_effect() {
    for kind in [
        Some("edit"),
        Some("read"),
        Some("fetch"),
        Some("search"),
        Some("think"),
        Some("move"),
    ] {
        assert_eq!(
            tool_effect(kind, Some("git push origin main")),
            None,
            "{kind:?}"
        );
    }
    assert!(tool_effect(None, Some("git push origin main")).is_some());
    assert_eq!(tool_effect(Some("execute"), None), None);
}
