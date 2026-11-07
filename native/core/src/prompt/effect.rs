//! What a finished command did outside the machine, in one line a supervisor can read.
//!
//! [`command_risk`] answers "is this worth a second tap"; this answers "what must the person hear about
//! afterwards". It reuses that classifier for the kind and adds installs. Local work (edits, builds, tests,
//! reads) has no effect: it folds. A missed effect shows a plain folded command; a false "Pushed" is a lie, so
//! every rule here prefers `None`, and a line carries only what the command text states (a remote and a ref, a
//! countable list of files), never an invented number.

use super::risk::{Risk, command_risk};

/// What a command changed beyond the machine it ran on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectKind {
    /// `git push`.
    Push,
    /// Files or remote data removed.
    Delete,
    /// A package installed.
    Install,
    /// Released or merged where other people see it.
    Publish,
    /// Somebody else's machines or cloud changed.
    Infra,
    /// Reserved for effects that fit no other class.
    Other,
}

/// One consequence: its class and a short line built from the command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolEffect {
    pub kind: EffectKind,
    pub text: String,
}

/// A word of a command and whether any part of it was quoted.
struct Word {
    text: String,
    quoted: bool,
}

/// Splits `cmd` into simple commands at `;`, `&&`, `||`, `|`, `&`, parentheses and newlines that are outside
/// quotes, each as shell words with quotes removed. `2>&1` keeps its `&`.
fn segments(cmd: &str) -> Vec<Vec<Word>> {
    let cmd = cmd.replace("\\\n", " ");
    let chars: Vec<char> = cmd.chars().collect();
    let mut out = Vec::new();
    let mut words: Vec<Word> = Vec::new();
    let mut cur = String::new();
    let (mut has, mut quoted) = (false, false);
    let mut i = 0;
    macro_rules! end_word {
        () => {
            if has {
                words.push(Word {
                    text: std::mem::take(&mut cur),
                    quoted,
                });
            }
            #[allow(unused_assignments)]
            {
                has = false;
                quoted = false;
            }
        };
    }
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                has = true;
                quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    cur.push(chars[i]);
                    i += 1;
                }
            }
            '"' => {
                has = true;
                quoted = true;
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\'
                        && i + 1 < chars.len()
                        && matches!(chars[i + 1], '"' | '\\' | '$' | '`')
                    {
                        i += 1;
                    }
                    cur.push(chars[i]);
                    i += 1;
                }
            }
            '\\' if i + 1 < chars.len() => {
                has = true;
                i += 1;
                cur.push(chars[i]);
            }
            c if c.is_whitespace() && c != '\n' => {
                end_word!();
            }
            ';' | '\n' | '|' | '(' | ')' | '&' => {
                let redirect = c == '&'
                    && (i > 0 && matches!(chars[i - 1], '>' | '<')
                        || chars.get(i + 1) == Some(&'>'));
                if redirect {
                    has = true;
                    cur.push(c);
                } else {
                    end_word!();
                    if !words.is_empty() {
                        out.push(std::mem::take(&mut words));
                    }
                }
            }
            c => {
                has = true;
                cur.push(c);
            }
        }
        i += 1;
    }
    end_word!();
    if !words.is_empty() {
        out.push(words);
    }
    out
}

/// Programs that only print or read what they are given: a command named in their arguments does not run.
const PRINTERS: &[&str] = &[
    "echo", "printf", "cat", "grep", "egrep", "fgrep", "rg", "ag", "ls", "head", "tail", "wc",
    "less", "more", "man", "which", "type", "test", "[", "read", "export", "set", "alias", "sed",
    "awk", "diff", "file", "stat", "tree", "bat",
];

/// Words that run what follows them: skipped to reach the program.
const WRAPPERS: &[&str] = &[
    "sudo", "doas", "time", "nohup", "command", "exec", "nice", "env", "builtin",
];

const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh"];

fn basename(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn is_assignment(w: &Word) -> bool {
    !w.quoted
        && w.text.split_once('=').is_some_and(|(k, _)| {
            !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

/// Ranks the classes: the one a person most needs to hear wins in a chain.
fn weight(kind: EffectKind) -> u8 {
    match kind {
        EffectKind::Publish => 5,
        EffectKind::Push => 4,
        EffectKind::Infra => 3,
        EffectKind::Delete => 2,
        EffectKind::Install => 1,
        EffectKind::Other => 0,
    }
}

/// A dry run changes nothing.
fn is_dry_run(args: &[&str]) -> bool {
    args.iter()
        .any(|a| a.starts_with("--dry-run") || matches!(*a, "--check" | "--noop"))
}

/// Drops redirections (`2>&1`, `> out.txt`): they are not arguments.
fn without_redirects(words: &[Word]) -> Vec<&Word> {
    let mut out = Vec::new();
    let mut skip = false;
    for w in words {
        let op = !w.quoted
            && w.text
                .trim_start_matches(|c: char| c.is_ascii_digit() || c == '&')
                .starts_with(['>', '<']);
        if skip {
            skip = false;
        } else if op {
            skip = w
                .text
                .trim_start_matches(|c: char| c.is_ascii_digit() || c == '&')
                .chars()
                .all(|c| matches!(c, '>' | '<'));
        } else {
            out.push(w);
        }
    }
    out
}

fn classify_words(words: &[Word], depth: u8) -> Option<ToolEffect> {
    let words: Vec<&Word> = without_redirects(words);
    let words = words.as_slice();
    let mut at = 0;
    while at < words.len() {
        let w = &words[at];
        if is_assignment(w)
            || WRAPPERS.contains(&basename(&w.text))
            || (at > 0
                && !w.quoted
                && w.text.starts_with('-')
                && WRAPPERS.contains(&basename(&words[at - 1].text)))
        {
            at += 1;
        } else {
            break;
        }
    }
    let words = &words[at..];
    let program = basename(&words.first()?.text).to_string();
    if PRINTERS.contains(&program.as_str()) {
        return None;
    }
    if SHELLS.contains(&program.as_str()) {
        let c = words.iter().position(|w| {
            !w.quoted
                && w.text.starts_with('-')
                && !w.text.starts_with("--")
                && w.text.contains('c')
        })?;
        return depth
            .checked_sub(1)
            .and_then(|d| classify(&words.get(c + 1)?.text, d));
    }
    let args: Vec<&str> = words[1..].iter().map(|w| w.text.as_str()).collect();
    if is_dry_run(&args) || (program == "git" && args.contains(&"-n")) {
        return None;
    }
    if let Some(install) = install_effect(&program, &args) {
        return Some(install);
    }
    // The classifier reads text: quoted words are folded into one placeholder so that what is merely typed in
    // an argument ("git push" in a commit message) is not a command.
    let flat = words
        .iter()
        .map(|w| {
            if w.quoted && w.text.contains(char::is_whitespace) {
                "Q"
            } else {
                w.text.as_str()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    match command_risk(&flat)? {
        Risk::Pushes | Risk::ForcePushes => Some(effect(EffectKind::Push, push_text(&args))),
        Risk::DeletesFiles => Some(effect(EffectKind::Delete, delete_text(&program, &args))),
        Risk::SendsDeleteRequest => {
            Some(effect(EffectKind::Delete, "Sent a DELETE request".into()))
        }
        Risk::PublishesOrMerges => Some(effect(EffectKind::Publish, publish_text(&program, &args))),
        Risk::ChangesInfrastructure => Some(effect(EffectKind::Infra, infra_text(&program, &args))),
        _ => None,
    }
}

fn effect(kind: EffectKind, text: String) -> ToolEffect {
    ToolEffect { kind, text }
}

fn simple(word: &str) -> bool {
    !word.is_empty()
        && word.len() <= 60
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._/-@:+".contains(c))
}

/// `git push` text. Only a remote that is a plain name (not a URL, which may carry a credential) and a plain
/// ref are named.
fn push_text(args: &[&str]) -> String {
    const BOOL: &[&str] = &[
        "-f",
        "--force",
        "-u",
        "--set-upstream",
        "--tags",
        "--follow-tags",
        "--no-verify",
        "-v",
        "--verbose",
        "--atomic",
        "--progress",
        "-q",
        "--quiet",
    ];
    let generic = || "Pushed to a remote".to_string();
    let Some(push) = args.iter().position(|a| *a == "push") else {
        return generic();
    };
    let rest = &args[push + 1..];
    let force = rest
        .iter()
        .any(|a| matches!(*a, "-f" | "--force") || a.starts_with("--force-with-lease"));
    let mut pos = Vec::new();
    for a in rest {
        if a.starts_with('-') {
            if !(BOOL.contains(a) || a.starts_with("--force-with-lease")) {
                return generic();
            }
        } else {
            pos.push(*a);
        }
    }
    let verb = if force { "Force-pushed" } else { "Pushed" };
    let Some(remote) = pos
        .first()
        .filter(|r| simple(r) && !r.contains(':') && !r.contains('@'))
    else {
        return generic();
    };
    match pos.get(1..) {
        Some([]) | None => format!("{verb} to {remote}"),
        Some([r#ref]) => {
            let r#ref = r#ref.trim_start_matches('+');
            let dst = match r#ref.split_once(':') {
                Some(("", _)) => return generic(),
                Some((_, dst)) => dst,
                None => r#ref,
            };
            if simple(dst) && !dst.contains(':') {
                format!("{verb} to {remote}/{dst}")
            } else {
                generic()
            }
        }
        Some(_) => format!("{verb} to {remote}"),
    }
}

fn delete_text(program: &str, args: &[&str]) -> String {
    const BOOL: &[&str] = &[
        "-r",
        "-R",
        "-f",
        "-rf",
        "-fr",
        "-Rf",
        "-fR",
        "-v",
        "-i",
        "--recursive",
        "--force",
        "-d",
    ];
    let generic = || "Deleted files".to_string();
    if !matches!(program, "rm" | "rmdir" | "unlink") {
        return generic();
    }
    let mut targets = Vec::new();
    let mut recursive = program == "rmdir";
    let mut after_dashes = false;
    for a in args {
        if !after_dashes && *a == "--" {
            after_dashes = true;
        } else if !after_dashes && a.starts_with('-') {
            if !BOOL.contains(a) {
                return generic();
            }
            recursive |= a.contains('r') || a.contains('R') || *a == "-d";
        } else if simple(a) {
            targets.push(*a);
        } else {
            return generic();
        }
    }
    match targets.as_slice() {
        [] => generic(),
        [one] => format!("Deleted {one}"),
        many if recursive => format!("Deleted {} paths", many.len()),
        many => format!("Deleted {} files", many.len()),
    }
}

fn publish_text(program: &str, args: &[&str]) -> String {
    let sub = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .copied()
        .unwrap_or("");
    match (program, sub) {
        ("gh", "pr") => "Merged a pull request",
        ("gh", "release") => "Changed a GitHub release",
        ("gh", "repo") => "Changed a GitHub repository",
        ("gh", "workflow") => "Started a GitHub workflow",
        ("cargo", _) => "Published a crate",
        ("gem", _) => "Published a gem",
        ("docker", _) => "Pushed an image",
        ("helm", _) => "Pushed a chart",
        ("mvn", _) => "Deployed a package",
        ("npm" | "pnpm" | "yarn" | "bun" | "twine" | "poetry", _) => "Published a package",
        _ => "Published",
    }
    .to_string()
}

fn infra_text(program: &str, args: &[&str]) -> String {
    match args.iter().find(|a| !a.starts_with('-')) {
        Some(sub) if sub.chars().all(|c| c.is_ascii_lowercase() || c == '-') && simple(program) => {
            format!("Ran {program} {sub}")
        }
        _ => "Changed infrastructure".to_string(),
    }
}

/// `npm|pnpm|yarn|bun add|install|i`, `pip install`, `cargo install|add`, `brew|apt|apt-get install`,
/// `gem install`, `go install`.
fn install_effect(program: &str, args: &[&str]) -> Option<ToolEffect> {
    const BOOL: &[&str] = &[
        "-g",
        "--global",
        "-D",
        "--save-dev",
        "-E",
        "--exact",
        "-S",
        "--save",
        "--dev",
        "-y",
        "--yes",
        "--user",
        "-U",
        "--upgrade",
        "--locked",
        "--force",
        "-f",
        "--no-save",
        "--save-exact",
        "-q",
        "--quiet",
    ];
    // `python -m pip`: the module is the program.
    let (program, args) = match (program, args) {
        (p, ["-m", "pip" | "pip3", rest @ ..]) if p.starts_with("python") => ("pip", rest),
        _ => (program, args),
    };
    let verbs: &[&str] = match program {
        "npm" | "pnpm" | "yarn" | "bun" => &["add", "install", "i"],
        "pip" | "pip3" | "brew" | "apt" | "apt-get" | "gem" | "go" => &["install"],
        "cargo" => &["install", "add"],
        _ => return None,
    };
    if program == "go" && args.first() != Some(&"install") {
        return None;
    }
    let mut it = args.iter().filter(|a| !a.starts_with('+'));
    if !it.next().is_some_and(|v| verbs.contains(v)) {
        return None;
    }
    let rest: Vec<&str> = it.copied().collect();
    let flags_known = rest
        .iter()
        .filter(|a| a.starts_with('-'))
        .all(|a| BOOL.contains(a));
    let pkgs: Vec<&str> = rest
        .iter()
        .filter(|a| !a.starts_with('-'))
        .copied()
        .collect();
    let text = if !flags_known || !pkgs.iter().all(|p| simple(p)) {
        "Installed packages".to_string()
    } else if pkgs.is_empty() {
        match program {
            "npm" | "pnpm" | "yarn" | "bun" => "Installed dependencies".to_string(),
            _ => "Installed packages".to_string(),
        }
    } else if pkgs.len() <= 3 {
        format!("Installed {}", pkgs.join(", "))
    } else {
        format!("Installed {} packages", pkgs.len())
    };
    Some(effect(EffectKind::Install, text))
}

fn classify(cmd: &str, depth: u8) -> Option<ToolEffect> {
    segments(cmd)
        .iter()
        .filter_map(|s| classify_words(s, depth))
        .max_by_key(|e| weight(e.kind))
}

/// The consequence of a command a tool call ran, or `None` when it only read or changed local files.
///
/// `kind` is the tool's kind as the agent states it: only `execute` (or none stated) runs a command. The
/// caller decides the call is finished and did not fail: a push that failed did not push.
pub fn tool_effect(kind: Option<&str>, subject: Option<&str>) -> Option<ToolEffect> {
    if kind.is_some_and(|k| k != "execute") {
        return None;
    }
    classify(subject?, 3)
}
