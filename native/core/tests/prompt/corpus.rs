//! The corpus: screens captured from agents (herdr-mobile's
//! `tool/capture-prompt.sh`), one file per screen under
//! `tests/fixtures/prompts/<agent>/`, each with the answer the detector is
//! expected to give in `<name>.expected` beside it. The captures are of scratch
//! sessions in throw-away folders and carry no personal data.
//!
//! `UPDATE_EXPECTED=1 cargo test --test prompt corpus` writes the expected files
//! from what the detector says now. Read each one against its screen before
//! committing: a wrong answer written down is still wrong.

use std::fs;
use std::path::{Path, PathBuf};

use herdr_core::prompt::{self, PromptInfo};
use regex::Regex;

/// Rows the app asks herdr for.
const READ_ROWS: usize = 24;

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/prompts")
}

fn files(dir: &Path, suffix: &str, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            files(&path, suffix, out);
        } else if path.to_string_lossy().ends_with(suffix) {
            out.push(path);
        }
    }
}

fn all(suffix: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    files(&dir(), suffix, &mut out);
    out.sort();
    out
}

/// A fixture split into its `# key: value` header and the screen under it.
fn split_fixture(text: &str) -> (Vec<(String, String)>, String) {
    let header = Regex::new(r"^# ([a-z_]+): ?(.*)$").unwrap();
    let lines: Vec<&str> = text.split('\n').collect();
    let mut head = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some(m) = header.captures(lines[i]) else {
            break;
        };
        head.push((m[1].to_owned(), m[2].to_owned()));
        i += 1;
    }
    (head, lines[i..].join("\n"))
}

/// What the detector made of a screen, as text that diffs well.
fn render(prompt: Option<&PromptInfo>) -> String {
    let Some(p) = prompt else {
        return "no prompt\n".to_owned();
    };
    let mut out = String::from("question:\n");
    for line in p.question.split('\n') {
        out.push_str(&format!("  {line}\n"));
    }
    if let Some(subject) = &p.subject {
        out.push_str("subject:\n");
        for line in subject.split('\n') {
            out.push_str(&format!("  {line}\n"));
        }
    }
    out.push_str("replies:\n");
    for r in &p.options {
        let confirm = if r.needs_confirm() {
            r.risk.map_or("yes", |k| k.reason())
        } else {
            "no"
        };
        out.push_str(&format!(
            "  {} | keys: {} | confirm: {confirm}\n",
            r.label,
            r.keys.join(" ")
        ));
    }
    out
}

#[test]
fn the_corpus_is_not_empty() {
    assert!(
        !all(".txt").is_empty(),
        "no fixtures under {}",
        dir().display()
    );
}

#[test]
fn every_expected_file_belongs_to_a_fixture() {
    let stems: Vec<PathBuf> = all(".txt").iter().map(|f| f.with_extension("")).collect();
    let orphans: Vec<PathBuf> = all(".expected")
        .into_iter()
        .filter(|e| !stems.contains(&e.with_extension("")))
        .collect();
    assert!(
        orphans.is_empty(),
        "delete these or restore their .txt: {orphans:?}"
    );
}

#[test]
fn every_captured_screen_reads_as_its_expected_file_says() {
    let update = std::env::var("UPDATE_EXPECTED").is_ok_and(|v| v == "1");
    let mut wrong = Vec::new();
    for file in all(".txt") {
        let id = file.strip_prefix(dir()).unwrap().display().to_string();
        let (header, screen) = split_fixture(&fs::read_to_string(&file).unwrap());
        let agent = file
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let declared = header
            .iter()
            .find(|(k, _)| k == "agent")
            .map(|(_, v)| v.as_str());
        assert_eq!(
            declared,
            Some(agent.as_str()),
            "{id}: filed under the wrong agent"
        );

        let actual =
            render(prompt::detect(&prompt::preview_rows(&screen, 160, READ_ROWS)).as_ref());
        let expected_file = file.with_extension("expected");
        if update {
            fs::write(&expected_file, &actual).unwrap();
            continue;
        }
        match fs::read_to_string(&expected_file) {
            Ok(expected) if expected == actual => {}
            Ok(expected) => wrong.push(format!(
                "{id}:\n--- expected\n{expected}--- actual\n{actual}"
            )),
            Err(_) => wrong.push(format!(
                "{id}: {} is missing; the detector says:\n{actual}",
                expected_file.display()
            )),
        }
    }
    assert!(
        wrong.is_empty(),
        "{} fixtures differ:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}
