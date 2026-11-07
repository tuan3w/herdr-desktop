//! What the cards, the reply sheet and the notification buttons ask of the
//! detector: which replies allow, which decline, which are one tap, and whether
//! a changed question is told from the one that was shown.

use std::fs;
use std::path::Path;

use herdr_core::prompt::{
    self, PromptInfo, QuickReply, Risk, answerable_from_notification, is_negative_reply,
};

use super::common::{detect, found, subject};

/// The prompt the detector finds in a captured screen.
fn captured(name: &str) -> PromptInfo {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/prompts")
        .join(format!("{name}.txt"));
    let text = fs::read_to_string(path).unwrap();
    let screen: Vec<&str> = text
        .lines()
        .skip_while(|r| r.starts_with("# ") && r.contains(':'))
        .collect();
    prompt::detect(&prompt::preview_rows(&screen.join("\n"), 160, 24)).expect("a prompt")
}

fn labels(replies: &[&QuickReply]) -> Vec<String> {
    replies.iter().map(|r| r.label.clone()).collect()
}

/// The card's groups: the replies that allow, and the ones that decline.
fn groups(p: &PromptInfo) -> (Vec<&QuickReply>, Vec<&QuickReply>) {
    p.options.iter().partition(|r| !is_negative_reply(r))
}

fn reply(label: &str, keys: &[&str], risk: Option<Risk>) -> QuickReply {
    QuickReply {
        label: label.to_owned(),
        keys: keys.iter().map(|k| (*k).to_owned()).collect(),
        risk,
        standing_grant: risk == Some(Risk::StandingGrant),
    }
}

fn info(question: &str, subject: Option<&str>, options: Vec<QuickReply>) -> PromptInfo {
    let mut p = PromptInfo {
        question: question.to_owned(),
        subject: subject.map(str::to_owned),
        options,
        digest: String::new(),
    };
    p.digest = prompt::prompt_digest(&p);
    p
}

#[test]
fn a_captured_claude_dialog_splits_into_allowing_then_declining_replies() {
    let p = captured("claude/approvalfull-bash-multiline-dontask");
    let (allow, refuse) = groups(&p);
    assert_eq!(
        labels(&allow),
        [
            "1. Yes",
            "2. Yes, don't ask again",
            "3. Yes, and switch to auto mode · auto…"
        ]
    );
    assert_eq!(labels(&refuse), ["4. No"]);
    let standing: Vec<&str> = p
        .options
        .iter()
        .filter(|r| r.standing_grant)
        .map(|r| r.label.as_str())
        .collect();
    assert_eq!(
        standing,
        [
            "2. Yes, don't ask again",
            "3. Yes, and switch to auto mode · auto…"
        ]
    );
}

#[test]
fn a_captured_codex_dialog_has_one_plain_allow_and_the_refusal() {
    let p = captured("codex/approval-command");
    let (allow, refuse) = groups(&p);
    assert_eq!(
        labels(&allow),
        ["1. Yes, proceed", "2. Yes, don't ask again"]
    );
    assert_eq!(labels(&refuse), ["3. No"]);
    assert_eq!(p.options.len(), 3);
    assert_eq!(p.options.iter().filter(|r| r.standing_grant).count(), 1);
}

#[test]
fn a_detected_claude_screen_puts_its_command_on_the_card_and_names_the_reason() {
    let p = found(
        r#"
 Bash command

   npm publish --access public
   Publish the package

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for npm commands in /x
   3. No, and tell Claude what to do differently (esc)
"#,
    );
    assert_eq!(
        subject(&p),
        "npm publish --access public\nPublish the package"
    );
    assert_eq!(p.options[0].risk, Some(Risk::PublishesOrMerges));
}

#[test]
fn a_command_the_card_had_to_cut_gates_yes() {
    let mut screen = vec![" Bash command".to_owned()];
    screen.extend((1..=9).map(|i| format!("   part {i}")));
    screen.extend([" Do you want to proceed?", " ❯ 1. Yes", "   2. No"].map(str::to_owned));
    let p = found(&screen.join("\n"));
    assert_eq!(p.options[0].risk, Some(Risk::LongCommand));
    assert_eq!(p.options.last().unwrap().risk, None);
}

#[test]
fn the_digest_follows_what_a_question_shows_not_where_the_cursor_is() {
    let yes = reply("1. Yes", &["enter"], None);
    let no = reply("2. No", &["down", "enter"], None);
    let base = info("Proceed?", Some("ls"), vec![yes.clone(), no.clone()]);
    let cursor_moved = info(
        "Proceed?",
        Some("ls"),
        vec![
            reply("1. Yes", &["up", "enter"], None),
            reply("2. No", &["enter"], None),
        ],
    );
    assert_eq!(cursor_moved.digest, base.digest);
    assert_ne!(
        info("Proceed?", Some("rm -rf /"), vec![yes.clone(), no.clone()]).digest,
        base.digest
    );
    assert_ne!(
        info("Proceed?", Some("ls"), vec![no.clone(), yes.clone()]).digest,
        base.digest
    );
    assert_ne!(
        info("Proceed?ls", None, vec![yes.clone(), no.clone()]).digest,
        base.digest,
        "the question and the command are told apart"
    );
    assert_eq!(base.digest.len(), 16);
    assert!(
        base.digest
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
        "{}",
        base.digest
    );
}

#[test]
fn the_digest_alone_cannot_tell_a_plain_chip_from_the_same_chip_gated() {
    // Why an answer re-reads the pane and checks the reply itself, not only the
    // digest: a question can become riskier without changing a word it shows.
    let plain = info(
        "Do you want to proceed?",
        Some("git push"),
        vec![
            reply("1. Yes", &["1", "enter"], None),
            reply("2. No", &["2", "enter"], None),
        ],
    );
    let gated = info(
        "Do you want to proceed?",
        Some("git push"),
        vec![
            reply("1. Yes", &["1", "enter"], Some(Risk::LongCommand)),
            reply("2. No", &["2", "enter"], None),
        ],
    );
    assert_eq!(gated.digest, plain.digest);
    assert!(gated.options[0].needs_confirm());
    assert!(!plain.options[0].needs_confirm());
}

// -------------------------------------------------- notification buttons

const LS: &str = " Bash command\n   ls -la\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for ls commands\n   3. No, and tell Claude what to do differently (esc)\n";
const PUSH: &str = " Bash command\n   git push origin main\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for git push commands\n   3. No, and tell Claude what to do differently (esc)\n";
const RM: &str = " Bash command\n   rm -rf build\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for rm commands\n   3. No, and tell Claude what to do differently (esc)\n";

fn buttons(screen: &str) -> Vec<String> {
    found(screen)
        .options
        .iter()
        .filter(|r| answerable_from_notification(r))
        .map(|r| r.label.clone())
        .collect()
}

#[test]
fn a_notification_carries_only_options_that_need_no_second_tap_never_a_standing_grant() {
    assert_eq!(
        buttons(LS),
        ["1. Yes", "3. No"],
        "\"don't ask again\" is never one tap"
    );
}

#[test]
fn an_option_the_card_makes_you_confirm_is_not_a_notification_button() {
    assert_eq!(buttons(PUSH), ["3. No"]);
}

#[test]
fn a_question_the_app_does_not_understand_has_no_buttons() {
    assert_eq!(detect("building...\nstill building\n"), None);
}

#[test]
fn a_command_too_long_to_be_shown_whole_gets_no_yes_button() {
    let long: Vec<String> = (0..5)
        .map(|_| format!("   echo {}", "x".repeat(150)))
        .collect();
    let screen = format!(
        " Bash command\n{}\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n",
        long.join("\n")
    );
    let p = found(&screen);
    assert!(subject(&p).contains(&format!("echo {}", "x".repeat(150))));
    assert!(p.options[0].needs_confirm());
    assert_eq!(buttons(&screen), ["2. No"]);
}

#[test]
fn a_question_that_changed_to_another_command_has_another_digest() {
    // Same words around it, another command: "Yes" would now approve rm.
    assert_ne!(found(LS).digest, found(RM).digest);
    assert_eq!(found(LS).digest, found(LS).digest);
}
