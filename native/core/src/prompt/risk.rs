//! Why a command, a question or an option deserves a second tap.
//!
//! A hint, never the only safeguard: the card always shows the command, and a
//! list of patterns will always have gaps. The rules look at the text of the
//! thing being approved (the command block, the question, the option) and never
//! at the scrollback around it: a diff that mentions "remove" says nothing about
//! the command below it.
//!
//! Rules are ordered by consequence and the first match names the reason. Each
//! one matches a command the way it is typed (`git push`, `rm -r`), not a bare
//! word, so `rg "remove_user"` and `git log --grep=delete` pass.

use std::sync::LazyLock;

use regex::Regex;

use super::mode::{ModeRisk, assess_mode};
use super::re::{Matcher, rx, rx_i};

/// A reason to ask for a second tap. [`Risk::reason`] is the few words shown on
/// the confirming button.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Risk {
    /// `git push --force`, `-f`, `+ref`.
    ForcePushes,
    /// `git push`.
    Pushes,
    /// `rm`, `find -delete`, `git clean` and friends.
    DeletesFiles,
    /// `dd of=`, `mkfs`.
    OverwritesDisk,
    /// `git reset --hard`, `branch -D`, `stash drop`, history rewrites.
    DiscardsGitChanges,
    /// `npm publish`, `gh pr merge`, `docker push` and friends.
    PublishesOrMerges,
    /// `terraform apply`, `kubectl delete`, cloud CLIs that change things.
    ChangesInfrastructure,
    /// `ssh`, `scp`, `rsync` to a host.
    RunsOnAnotherMachine,
    /// `curl ... | sh` and its variants.
    RunsDownloadedScript,
    /// `curl -X DELETE`.
    SendsDeleteRequest,
    /// SQL that changes data, migrations.
    ChangesDatabase,
    /// `sudo`, `doas`.
    RunsAsRoot,
    /// `systemctl stop`, `kill`, `pkill`, `shutdown`.
    StopsProcesses,
    /// `chmod -R`, `chown -R`.
    ChangesPermissions,
    /// A write into `~/.ssh`.
    ChangesSshKeys,
    /// `docker rm`, `docker prune`, `compose down -v`.
    RemovesContainers,
    /// Words of a question or an option: "Delete all branches".
    DeletesOrOverwrites,
    /// A write lands in a shell start-up file.
    ChangesShellStartup,
    /// A write lands in `/etc`.
    ChangesSystemFiles,
    /// A write lands in `.git/hooks`.
    ChangesGitHooks,
    /// A write lands in a `.env` file.
    ChangesSecrets,
    /// The option grants something that outlives this answer.
    StandingGrant,
    /// The subject was cut and may hide something.
    LongCommand,
}

impl Risk {
    /// The reason in a few words, as shown on the confirming button.
    pub fn reason(self) -> &'static str {
        match self {
            Self::ForcePushes => "force-pushes",
            Self::Pushes => "pushes to a remote",
            Self::DeletesFiles => "deletes files",
            Self::OverwritesDisk => "overwrites a disk",
            Self::DiscardsGitChanges => "discards git changes",
            Self::PublishesOrMerges => "publishes or merges",
            Self::ChangesInfrastructure => "changes infrastructure",
            Self::RunsOnAnotherMachine => "runs on another machine",
            Self::RunsDownloadedScript => "runs a downloaded script",
            Self::SendsDeleteRequest => "sends a DELETE request",
            Self::ChangesDatabase => "changes a database",
            Self::RunsAsRoot => "runs as root",
            Self::StopsProcesses => "stops processes",
            Self::ChangesPermissions => "changes permissions",
            Self::ChangesSshKeys => "changes ssh keys",
            Self::RemovesContainers => "removes containers or volumes",
            Self::DeletesOrOverwrites => "deletes or overwrites",
            Self::ChangesShellStartup => "changes shell start-up",
            Self::ChangesSystemFiles => "changes system files",
            Self::ChangesGitHooks => "changes git hooks",
            Self::ChangesSecrets => "changes secrets",
            Self::StandingGrant => "standing permission",
            Self::LongCommand => "long command, check it all",
        }
    }
}

struct Rule {
    re: Matcher,
    risk: Risk,
}

fn rule(pattern: &str, risk: Risk) -> Rule {
    Rule {
        re: Matcher::new(pattern, false),
        risk,
    }
}

/// The first reason in `rules` for `text`, whitespace folded into single spaces.
fn first(rules: &[Rule], text: &str) -> Option<Risk> {
    static WS: LazyLock<Regex> = LazyLock::new(|| rx(r"\s+"));
    let flat = WS.replace_all(text, " ");
    rules.iter().find(|r| r.re.is_match(&flat)).map(|r| r.risk)
}

/// The first reason `text`, taken as a shell command, deserves a second look.
pub fn command_risk(text: &str) -> Option<Risk> {
    static RULES: LazyLock<Vec<Rule>> = LazyLock::new(command_rules);
    first(&RULES, text)
}

/// The same for a natural-language question or option label ("Remove 3
/// files?", "Delete all branches").
pub fn prose_risk(text: &str) -> Option<Risk> {
    static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
        vec![rule(
            concat!(
                r"\b(?:delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|overwrit(?:e|es|ten|ing)|wip(?:e|es|ed|ing)|",
                r"destroy(?:s|ed|ing)?|eras(?:e|es|ed|ing)|purg(?:e|es|ed|ing)|truncat(?:e|es|ed|ing)|",
                r"drop(?:s|ped|ping)?|discard(?:s|ed|ing)?|force)\b"
            ),
            Risk::DeletesOrOverwrites,
        )]
    });
    first(&RULES, text)
}

/// A command or a sentence: what an option label or a one-line question may be.
pub fn risk_of(text: &str) -> Option<Risk> {
    command_risk(text).or_else(|| prose_risk(text))
}

/// Whether an option grants something that outlives this answer ("Yes, and
/// don't ask again for ...", "Allow always", "allow all edits during this
/// session") or switches the session to a mode that asks for less ("Yes, and
/// bypass permissions", "Yes, auto-accept edits"). One tap is too easy for a
/// permission that stays. The mode words are the ones [`assess_mode`] reads, so
/// the label of an option and the mode it names are judged alike; "manually
/// approve edits" asks for more, not less, and passes.
pub fn grants_standing_permission(option_text: &str) -> bool {
    static STANDING: LazyLock<Regex> = LazyLock::new(|| {
        rx_i(
            r"(?:don.?t|do\s+not|never)\s+ask\s+again|\balways\b|\ballow\s+all\b|(?:this|the\s+rest\s+of\s+(?:the|this))\s+session|\ball\s+edits\b",
        )
    });
    STANDING.is_match(option_text) || assess_mode(None, Some(option_text)).risk != ModeRisk::None
}

/// Where a command word can start: the beginning, after a space, a separator, a
/// pipe, a subshell, a brace, a quote or a backslash. `--rm` and `a-rm` do not
/// start one; `\rm`, `"rm"`, `eval "rm -rf /"` and `docker exec c 'rm -rf /'` do.
/// A quote opens a word, so a command that is only quoted text
/// (`git commit -m "rm -rf is dangerous"`) is flagged too: a wrong hold costs a
/// tap, a missed one costs the person's files.
const START: &str = r#"(?:^|[\s;&|(`{"'\\])"#;

/// The quote that may close a quoted command word (`"rm" -rf /`).
const CLOSE: &str = r#"["']?"#;

/// A command word typed with its directory too (`/bin/rm`, `/usr/bin/git`).
fn cmd() -> String {
    format!(r"{START}(?:[\w.~-]*/)*")
}

/// `git`, then the global options that may come before the subcommand (`-C
/// <dir>`, `-c k=v`, `--no-pager`, `--git-dir <dir>`): `git -C repo push` is
/// `git push`.
///
/// The alternatives are mutually exclusive: an option that takes a value is
/// matched only with its value, and the plain-option form refuses to match those
/// names. With both able to match `-C`, a run of `-C -C -C ...` could be split in
/// exponentially many ways and a failed match took minutes.
fn git() -> String {
    const VALUED: &str = r"(?:-[Cc]|--(?:git-dir|work-tree|namespace))";
    format!(r"\bgit(?:\s+(?:{VALUED}\s+\S+|(?!{VALUED}(?:\s|$))-[\w-]+(?:=\S+)?))*")
}

fn command_rules() -> Vec<Rule> {
    let git = git();
    let cmd = cmd();
    let mut rules = vec![
        // Remote and history.
        rule(
            &format!(r"{git}\s+push\b[^;&|]*(?:--force(?:-with-lease)?\b|\s-f\b|\s\+\S)"),
            Risk::ForcePushes,
        ),
        rule(&format!(r"{git}\s+push\b"), Risk::Pushes),
        // Data that does not come back.
        rule(
            &format!(r"{cmd}(?:rm|rmdir|unlink|shred){CLOSE}\s+\S"),
            Risk::DeletesFiles,
        ),
        rule(
            r#"\b(?:ba|z|da|k)?sh(?:\s+-\S+)*?\s+-\w*c\s+["'](?:[^"']*[\s;&|])?(?:[\w.~-]*/)*(?:rm|rmdir|unlink|shred)\s+\S"#,
            Risk::DeletesFiles,
        ),
        rule(
            r"\bxargs\s+(?:-\S+\s+)*(?:sudo\s+)?(?:rm|rmdir|unlink|shred)\b",
            Risk::DeletesFiles,
        ),
        rule(r"\bfind\b[^;&|]*\s-delete\b", Risk::DeletesFiles),
        rule(&format!(r"{git}\s+clean\b"), Risk::DeletesFiles),
        rule(
            &format!(r"{cmd}dd{CLOSE}\s+[^;&|]*\bof="),
            Risk::OverwritesDisk,
        ),
        rule(r"\b(?:mkfs(?:\.\w+)?|wipefs)\b", Risk::OverwritesDisk),
        // Work in a repository.
        rule(
            &format!(r"{git}\s+reset\b[^;&|]*--hard\b"),
            Risk::DiscardsGitChanges,
        ),
        rule(
            &format!(r"{git}\s+checkout\b[^;&|]*\s(?:--\s+)?\.(?:\s|$)"),
            Risk::DiscardsGitChanges,
        ),
        rule(
            &format!(r"{git}\s+restore\b(?![^;&|]*--staged)[^;&|]*\s\.(?:\s|$)"),
            Risk::DiscardsGitChanges,
        ),
    ];
    rules.push(Rule {
        re: Matcher::new(&format!(r"{git}\s+branch\b[^;&|]*\s-D\b"), true),
        risk: Risk::DiscardsGitChanges,
    });
    rules.extend([
        rule(&format!(r"{git}\s+stash\s+(?:drop|clear)\b"), Risk::DiscardsGitChanges),
        rule(&format!(r"{git}\s+(?:filter-branch|filter-repo)\b"), Risk::DiscardsGitChanges),
        rule(&format!(r"{git}\s+reflog\s+(?:expire|delete)\b"), Risk::DiscardsGitChanges),
        // Visible to other people.
        rule(
            concat!(
                r"\b(?:(?:npm|pnpm|yarn|bun)\s+publish|cargo\s+publish|twine\s+upload|poetry\s+publish|",
                r"gem\s+push|mvn\s+deploy|helm\s+push|docker\s+(?:image\s+)?push|",
                r"gh\s+(?:release\s+(?:create|upload|delete)|pr\s+merge|repo\s+(?:create|delete)|workflow\s+run))\b"
            ),
            Risk::PublishesOrMerges,
        ),
        // Somebody else's machines.
        rule(
            concat!(
                r"\b(?:(?:terraform|tofu)\s+(?:apply|destroy|import|taint|untaint|state\s+(?:rm|mv|push))|",
                r"pulumi\s+(?:up|destroy|refresh)|",
                r"kubectl\s+(?:apply|delete|replace|scale|patch|edit|drain|cordon|uncordon|rollout|exec|create|annotate|label|set|taint)|",
                r"helm\s+(?:install|upgrade|uninstall|delete|rollback)|ansible-playbook|",
                r"(?:cdk|sls|serverless|sam|fly|flyctl|wrangler)\s+(?:deploy|destroy|remove|publish))\b"
            ),
            Risk::ChangesInfrastructure,
        ),
        rule(
            r"\b(?:gcloud|az)\b[^;&|]*\s(?:delete|create|deploy|update|reset|resize)\b",
            Risk::ChangesInfrastructure,
        ),
        rule(
            concat!(
                r"\baws\b[^;&|]*\s(?:s3\s+(?:rm|rb|sync|mv)|",
                r"(?:delete|terminate|remove|create|put|update|stop|reboot|deregister|modify|invoke|run|start|attach|detach)-\S+|invoke)\b"
            ),
            Risk::ChangesInfrastructure,
        ),
        rule(r"\b(?:ssh|scp|sftp)\s", Risk::RunsOnAnotherMachine),
        rule(r"\brsync\b[^;&|]*\s\S+:\S", Risk::RunsOnAnotherMachine),
        // Code that was not written here.
        rule(
            concat!(
                r"\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?",
                r"(?:(?:ba|z|da|k)?sh\b|",
                // An interpreter that reads the script from stdin: bare, or with a lone `-`.
                // `| python3 -m json.tool` and `| node script.js` read something else.
                r"(?:python[\d.]*|node|nodejs|deno|perl|ruby|php)(?:\s+-(?=\s|$)|\s*(?:$|[;&|)])))|",
                // A shell, `eval`, `source` or `.` that runs what a download printed:
                // `bash -c "$(curl ...)"`, `source <(curl ...)`.
                r"\b(?:(?:ba|z|da|k)?sh|eval|source)\b[^;&]*(?:[$<]\(|`)\s*(?:curl|wget)\b|",
                r"(?:^|[\s;&|(])\.\s+<\(\s*(?:curl|wget)\b"
            ),
            Risk::RunsDownloadedScript,
        ),
        rule(
            r"\b(?:curl|wget)\b[^;&|]*(?:\s-X\s*|--request[\s=]+|--method[\s=]+)DELETE\b",
            Risk::SendsDeleteRequest,
        ),
        rule(
            r"\bpython[\d.]*\s+(?:-\S+\s+)*-c\s+.*\b(?:rmtree|os\.(?:remove|unlink|rmdir|removedirs))\b",
            Risk::DeletesFiles,
        ),
        // Data somebody else reads.
        rule(
            concat!(
                r"\b(?:drop|truncate|alter)\s+(?:table|database|schema|index|view|column|user|role)\b|",
                r"\bdelete\s+from\b|\binsert\s+into\b|\b(?:flushall|flushdb)\b|",
                r#"\bupdate\s+[\w."`\[\]]+\s+set\b|"#,
                r"\bdb\.[\w.]+\.(?:drop|deleteMany|deleteOne|remove|updateMany|updateOne|insertMany)\b"
            ),
            Risk::ChangesDatabase,
        ),
        rule(
            concat!(
                r"\b(?:make|just|task|rake|npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+[\w:.-]*migrat\w*|",
                r"\bmanage\.py\s+(?:migrate|flush|sqlflush)\b|\bprisma\s+(?:migrate|db\s+(?:push|execute))\b|",
                r"\b(?:rails|rake)\s+db:\w+|",
                r"\b(?:alembic|flyway|liquibase|dbmate|goose|knex|sequelize|typeorm|atlas)\b[^;&|]*\b",
                r"(?:upgrade|migrate|apply|up|down|deploy|reset|rollback|revert)\b"
            ),
            Risk::ChangesDatabase,
        ),
        // The machine itself.
        rule(&format!(r"{cmd}(?:sudo|doas)\b"), Risk::RunsAsRoot),
        rule(
            &format!(
                concat!(
                    r"\bsystemctl\s+(?:stop|restart|disable|mask|kill|reboot|poweroff|halt)\b|",
                    r"\bservice\s+\S+\s+(?:stop|restart)\b|",
                    r"{cmd}(?:shutdown|reboot|poweroff|halt)",
                    r"\b|",
                    // A signal to everything (`kill -9 -1`) is a number too; `kill $PID` and
                    // `kill -s TERM 42` name a process like `kill 42` does.
                    r"\bkill\s+(?:-\S+\s+|[a-z]+\s+)*(?:-?\d|\$)|\b(?:pkill|killall)\b"
                ),
                cmd = cmd
            ),
            Risk::StopsProcesses,
        ),
        rule(r"\b(?:chmod\s+(?:-\S*R\S*|[0-7]*777)|chown\s+-\S*R\S*)\b", Risk::ChangesPermissions),
        rule(r"(?:>>?|\btee\b(?:\s+-\S+)*)\s*\S*\.ssh/\S", Risk::ChangesSshKeys),
        rule(
            concat!(
                r"\bdocker\b[^;&|]*\bprune\b|\bdocker\s+(?:rm|rmi|kill|stop)\s|",
                r"\bdocker\s+(?:volume|network|image|container)\s+rm\b|",
                r"\bdocker[ -]compose\s+down\b[^;&|]*\s-v\b"
            ),
            Risk::RemovesContainers,
        ),
    ]);
    rules
}

/// Why writing to `path` deserves a second look, or `None`. A file write is not
/// a command, so [`command_risk`] has nothing to read: what matters is where it
/// lands. Flags the places a write turns into code that runs later or into
/// access for someone else: ssh keys, shell start-up files, `/etc`, git hooks and
/// `.env` files.
pub fn path_risk(path: &str) -> Option<Risk> {
    static RULES: LazyLock<Vec<(Regex, Risk)>> = LazyLock::new(|| {
        [
            (r"(?:^|/)\.ssh(?:/|$)|(?:^|/)authorized_keys2?$", Risk::ChangesSshKeys),
            (
                concat!(
                    r"(?:^|/)\.(?:bashrc|bash_profile|bash_login|bash_logout|zshrc|zshenv|zprofile|zlogin|profile)$|",
                    r"(?:^|/)\.config/fish/config\.fish$"
                ),
                Risk::ChangesShellStartup,
            ),
            (r"^/etc(?:/|$)", Risk::ChangesSystemFiles),
            (r"(?:^|/)\.git/hooks(?:/|$)", Risk::ChangesGitHooks),
            (r"(?:^|/)\.env(?:\.[\w.-]+)?$", Risk::ChangesSecrets),
        ]
        .into_iter()
        .map(|(p, r)| (rx_i(p), r))
        .collect()
    });
    let p = path.trim().replace('\\', "/");
    RULES
        .iter()
        .find(|(re, _)| re.is_match(&p))
        .map(|(_, r)| *r)
}
