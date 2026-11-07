//! The text hygiene around the detector (what a `pane.read` becomes before it is
//! read as a prompt), and the safety properties the desktop relies on.

use herdr_core::prompt::{self, Risk, strip_ansi};

use super::common::{any_confirm, detect, found, risks};

// ------------------------------------------------------------- strip_ansi

#[test]
fn strip_ansi_removes_colour_cursor_and_terminated_title_sequences() {
    assert_eq!(strip_ansi("\x1B[1;31mred\x1B[0m\x1B[K"), "red");
    assert_eq!(strip_ansi("\x1B[2 qcursor"), "cursor");
    assert_eq!(strip_ansi("\x1B]0;title\x07done"), "done");
    assert_eq!(strip_ansi("\x1B]0;title\x1B\\done"), "done");
}

#[test]
fn an_unterminated_title_keeps_everything_after_it_and_its_esc() {
    let path = "/tmp/ok\x1B]0;/../../.ssh/authorized_keys";
    assert_eq!(strip_ansi(path), path);
}

#[test]
fn a_title_does_not_run_across_lines_to_a_bell_further_down() {
    let text = "a\x1B]0;never closed\nrm -rf build\n\x07";
    assert!(strip_ansi(text).contains("rm -rf build"));
}

#[test]
fn a_bracket_that_starts_no_sequence_does_not_eat_the_letter_after_it() {
    assert_eq!(strip_ansi("rm\x1B[31 -rf"), "rm\x1B[31 -rf");
}

// ------------------------------------------------------------ preview rows

#[test]
fn a_long_line_is_cut_on_a_character_boundary_never_inside_an_emoji() {
    let rows = prompt::preview_rows(&format!("{}😀tail", "a".repeat(159)), 160, 12);
    assert_eq!(rows, ["a".repeat(159)]);
}

#[test]
fn a_preview_row_keeps_the_text_after_a_title_that_never_ends() {
    assert_eq!(
        prompt::preview_rows("building \x1B]0;partial title", 160, 12),
        ["building ]0;partial title"]
    );
    assert_eq!(
        prompt::preview_rows("\x1B[32mdone\x1B[0m", 160, 12),
        ["done"]
    );
}

#[test]
fn preview_rows_resolve_progress_tabs_bars_rules_and_blanks() {
    let text = "downloading  10%\rdownloading  60%\rdownloading 100%\n\t\tindented\n│ boxed │\n╭─────╮\n\n   \nlast";
    assert_eq!(
        prompt::preview_rows(text, 160, 12),
        ["downloading 100%", "        indented", "boxed", "last"]
    );
}

#[test]
fn preview_rows_keep_only_the_last_rows_oldest_first() {
    let text: String = (0..15).map(|i| format!("row {i}\n\n")).collect();
    let want: Vec<String> = (7..15).map(|i| format!("row {i}")).collect();
    assert_eq!(prompt::preview_rows(&text, 160, 8), want);
}

#[test]
fn a_pane_read_with_escapes_and_a_progress_bar_still_yields_the_prompt() {
    let read = "\x1B[2mbuilding\x1B[0m\r\nbuilding 40%\rbuilding 100%\r\n\x1B[1m Do you want to proceed?\x1B[0m\r\n \x1B[36m❯\x1B[0m 1. Yes\r\n   2. No\r\n";
    let rows = prompt::preview_rows(&read.replace("\r\n", "\n"), 160, 24);
    let p = prompt::detect(&rows).expect("a prompt");
    assert_eq!(p.question, "Do you want to proceed?");
    assert_eq!(p.options.len(), 2);
}

// ------------------------------------------------------------- safety

#[test]
fn ordinary_shell_output_is_not_a_prompt() {
    for screen in [
        "$ ls\nCargo.toml  src  target\n$ ",
        "running 3 tests\ntest a ... ok\ntest b ... ok\ntest c ... ok\n\ntest result: ok. 3 passed; 0 failed",
        "error[E0425]: cannot find value `x` in this scope\n --> src/main.rs:2:5\n  |\n2 |     x\n  |     ^ not found in this scope",
        "Compiling herdr-core v0.1.0\n    Finished `dev` profile in 2.3s",
        "1. Install\n2. Build\n3. Run",
        "user@host:~/proj$ git status\nOn branch main\nnothing to commit, working tree clean\n",
    ] {
        assert_eq!(detect(screen), None, "{screen}");
    }
}

#[test]
fn a_question_that_changes_between_two_reads_has_another_digest() {
    let first = found("Delete these files?\n❯ 1. Yes\n  2. No");
    let same = found("Delete these files?\n  1. Yes\n❯ 2. No");
    let other = found("Delete everything?\n❯ 1. Yes\n  2. No");
    assert_eq!(
        first.digest, same.digest,
        "the cursor is not part of what is asked"
    );
    assert_ne!(first.digest, other.digest);
    let command = |c: &str| {
        found(&format!(
            " Bash command\n   {c}\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
        ))
    };
    assert_ne!(command("echo hi").digest, command("rm -rf /").digest);
}

#[test]
fn a_standing_grant_is_flagged_and_the_one_time_answer_is_not() {
    let p = found(
        "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for this command\n  3. No",
    );
    assert!(!p.options[0].standing_grant);
    assert!(p.options[1].standing_grant);
    assert_eq!(p.options[1].risk, Some(Risk::StandingGrant));
    assert!(!p.options[2].standing_grant);
    let pointer = found("Allow this tool call?\n❯ Allow once\n  Allow always\n  Deny");
    assert_eq!(
        pointer
            .options
            .iter()
            .map(|r| r.standing_grant)
            .collect::<Vec<_>>(),
        [false, true, false]
    );
}

#[test]
fn dangerous_commands_are_flagged_and_a_plain_one_is_not() {
    let yes_risk = |command: &str| {
        let p = found(&format!(
            " Bash command\n   {command}\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
        ));
        assert_eq!(
            p.options[1].risk, None,
            "declining is never gated: {command}"
        );
        p.options[0].risk
    };
    assert_eq!(yes_risk("rm -rf build"), Some(Risk::DeletesFiles));
    assert_eq!(
        yes_risk("git push --force origin main"),
        Some(Risk::ForcePushes)
    );
    assert_eq!(
        yes_risk("sudo apt-get install -y ripgrep"),
        Some(Risk::RunsAsRoot)
    );
    assert_eq!(yes_risk("cargo test"), None);
    assert_eq!(yes_risk("ls -la src"), None);
}

#[test]
fn a_gated_answer_stays_gated_whatever_the_cursor_does() {
    // A reply that needs a second tap carries its reason wherever the pointer is,
    // so moving the highlight on screen never turns it into a one-tap answer.
    let at_first = found("Allow bash: rm -rf node_modules?\n❯ Allow once\n  Deny");
    let at_last = found("Allow bash: rm -rf node_modules?\n  Allow once\n❯ Deny");
    assert_eq!(risks(&at_first), risks(&at_last));
    assert!(any_confirm(&at_last));
}

#[test]
fn a_non_ascii_letter_after_a_risky_word_does_not_hide_it() {
    // The rules read word characters as ASCII, as on the phone: `force` followed
    // by `é` still ends at a word boundary, so the warning shows.
    assert_eq!(
        prompt::prose_risk("force\u{e9} quit"),
        Some(Risk::DeletesOrOverwrites)
    );
    assert_eq!(prompt::prose_risk("forc\u{e9} quit"), None);
}
