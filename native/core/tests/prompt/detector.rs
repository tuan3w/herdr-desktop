//! `detect`: the positive and negative screens, the labels, the window and the
//! dashed-rule dialogs of Claude Code 2.1.

use herdr_core::prompt::{self, Risk, clean_preview_row, is_dashed_rule};

use super::common::{any_confirm, detect, fmt, found, replies, risks, subject};

/// A reply as the Dart table writes it: label, keys, needs a second tap.
type Reply = (&'static str, &'static [&'static str], bool);

struct Case {
    name: &'static str,
    screen: &'static str,
    replies: &'static [Reply],
    question: Option<&'static str>,
    subject: &'static str,
    risks: Option<&'static [Option<Risk>]>,
}

const ENTER: &[&str] = &["enter"];
const STANDING: Option<Risk> = Some(Risk::StandingGrant);

const POSITIVES: &[Case] = &[
    Case {
        name: "Claude Code bash permission",
        screen: r#"
 Bash command

   git push origin main
   Push to remote

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for git push commands in /home/u/proj
   3. No, and tell Claude what to do differently (esc)
"#,
        replies: &[
            ("1. Yes", &["1", "enter"], true),
            ("2. Yes, don't ask again", &["2", "enter"], true),
            ("3. No", &["3", "enter"], false),
        ],
        question: Some("Do you want to proceed?"),
        subject: "git push origin main\nPush to remote",
        risks: Some(&[Some(Risk::Pushes), STANDING, None]),
    },
    Case {
        name: "Claude Code boxed permission with footer hints",
        screen: r#"
╭──────────────────────────────────────────────╮
│ Bash command                                 │
│                                              │
│   npm test                                   │
│   Run the tests                              │
│                                              │
│ Do you want to proceed?                      │
│ ❯ 1. Yes                                     │
│   2. Yes, and don't ask again for npm commands │
│   3. No, and tell Claude what to do differently (esc) │
╰──────────────────────────────────────────────╯
  Esc to cancel · Tab to amend · ctrl+e to explain
"#,
        replies: &[
            ("1. Yes", &["1", "enter"], false),
            ("2. Yes, don't ask again", &["2", "enter"], true),
            ("3. No", &["3", "enter"], false),
        ],
        question: Some("Do you want to proceed?"),
        subject: "npm test\nRun the tests",
        risks: None,
    },
    Case {
        name: "Claude Code file edit with two options and the cursor on the second",
        screen: r#"
 Edit file
 lib/main.dart

 Do you want to make this edit to main.dart?
   1. Yes
 ❯ 2. No, and tell Claude what to do differently (esc)
"#,
        replies: &[
            ("1. Yes", &["1", "enter"], false),
            ("2. No", &["2", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "Claude Code edit with a shift+tab option hint",
        screen: r#"
 Do you want to make this edit to a.dart?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)
"#,
        replies: &[
            ("1. Yes", &["1", "enter"], false),
            (
                "2. Yes, allow all edits during this…",
                &["2", "enter"],
                true,
            ),
            ("3. No", &["3", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "Claude Code trust prompt",
        screen: r#"
 Do you trust the files in this folder?

/home/u/proj

 ❯ 1. Yes, proceed
   2. No, exit

 Enter to confirm · Esc to exit
"#,
        replies: &[
            ("1. Yes, proceed", &["1", "enter"], false),
            ("2. No, exit", &["2", "enter"], false),
        ],
        question: Some("Do you trust the files in this folder?"),
        subject: "/home/u/proj",
        risks: None,
    },
    Case {
        name: "Claude Code question with option descriptions",
        screen: r#"
 ☐ Database
 Which database should we use?
 ❯ 1. PostgreSQL
      Relational, strong consistency
   2. SQLite
      Embedded, zero setup
   3. Other

 Enter to select · ↑/↓ to navigate · Esc to cancel
"#,
        replies: &[
            ("1. PostgreSQL", &["1", "enter"], false),
            ("2. SQLite", &["2", "enter"], false),
            ("3. Other", &["3", "enter"], false),
        ],
        question: Some("Which database should we use?"),
        subject: "",
        risks: None,
    },
    Case {
        name: "Codex approval: pointer, hotkey hints, command under the question",
        screen: r#"
  Would you like to run the following command?

  Reason: needs network access

  $ git push

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
"#,
        replies: &[
            ("1. Yes, proceed", &["1", "enter"], true),
            ("2. Yes, don't ask again", &["2", "enter"], true),
            ("3. No", &["3", "enter"], false),
        ],
        question: Some("Would you like to run the following command?"),
        subject: "$ git push",
        risks: Some(&[Some(Risk::Pushes), STANDING, None]),
    },
    Case {
        name: "wrapped option text stays one option",
        screen: r#"
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for
     git commit commands in /x
  3. No
"#,
        replies: &[
            ("1. Yes", &["1", "enter"], false),
            ("2. Yes, don't ask again", &["2", "enter"], true),
            ("3. No", &["3", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "five options (worst case for chips)",
        screen: r#"
Which model?
❯ 1. opus
  2. sonnet
  3. haiku
  4. gpt-5
  5. none
"#,
        replies: &[
            ("1. opus", &["1", "enter"], false),
            ("2. sonnet", &["2", "enter"], false),
            ("3. haiku", &["3", "enter"], false),
            ("4. gpt-5", &["4", "enter"], false),
            ("5. none", &["5", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "numbered menu with ) separators and no pointer but a question",
        screen: r#"
Choose an action:
1) Retry
2) Skip
3) Abort
"#,
        replies: &[
            ("1. Retry", &["1", "enter"], false),
            ("2. Skip", &["2", "enter"], false),
            ("3. Abort", &["3", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "output before the menu does not matter, only what is at the bottom",
        screen: r#"
1. an old list
2. from earlier output
Done editing, now:
Do you want to proceed?
❯ 1. Yes
  2. No
"#,
        replies: &[
            ("1. Yes", &["1", "enter"], false),
            ("2. No", &["2", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    // ---- destructive handling
    Case {
        name: "destructive command above marks the affirmative options, never No",
        screen: r#"
 Bash command
   rm -rf build/
   Remove the build directory

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in /x
   3. No, and tell Claude what to do differently (esc)
"#,
        replies: &[
            ("1. Yes", &["1", "enter"], true),
            ("2. Yes, don't ask again", &["2", "enter"], true),
            ("3. No", &["3", "enter"], false),
        ],
        question: None,
        subject: "rm -rf build/\nRemove the build directory",
        risks: Some(&[Some(Risk::DeletesFiles), STANDING, None]),
    },
    Case {
        name: "destructive option text",
        screen: r#"
Which cleanup?
❯ 1. Delete all branches
  2. Keep them
"#,
        replies: &[
            ("1. Delete all branches", &["1", "enter"], true),
            ("2. Keep them", &["2", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "force push",
        screen: r#"
 git push --force origin main
 Do you want to proceed?
 ❯ 1. Yes
   2. No
"#,
        replies: &[
            ("1. Yes", &["1", "enter"], true),
            ("2. No", &["2", "enter"], false),
        ],
        question: None,
        subject: "git push --force origin main",
        risks: Some(&[Some(Risk::ForcePushes), None]),
    },
    // ---- inline prompts
    Case {
        name: "[y/N] (overwrite counts as destructive)",
        screen: "Overwrite config.json? [y/N]\n",
        replies: &[
            ("Yes", &["y", "enter"], true),
            ("No", &["n", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "(y/n)",
        screen: "Install dependencies? (y/n) ",
        replies: &[
            ("Yes", &["y", "enter"], false),
            ("No", &["n", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "[Y/n]",
        screen: "Proceed with installation [Y/n]: ",
        replies: &[
            ("Yes", &["y", "enter"], false),
            ("No", &["n", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "uppercase (Y/N)",
        screen: "Apply the patch (Y/N)?",
        replies: &[
            ("Yes", &["y", "enter"], false),
            ("No", &["n", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "ssh host key (yes/no) needs the whole word",
        screen: "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
        replies: &[
            ("Yes", &["y", "e", "s", "enter"], false),
            ("No", &["n", "o", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "destructive row above an inline prompt marks only Yes",
        screen: "This will DROP TABLE users and delete every row.\nContinue? [y/N]",
        replies: &[
            ("Yes", &["y", "enter"], true),
            ("No", &["n", "enter"], false),
        ],
        question: Some("This will DROP TABLE users and delete every row.\nContinue? [y/N]"),
        subject: "",
        risks: None,
    },
    Case {
        name: "inline prompt followed by a hint row",
        screen: "Remove 3 files? [y/N]\n  (esc to cancel)",
        replies: &[
            ("Yes", &["y", "enter"], true),
            ("No", &["n", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    // ---- press enter
    Case {
        name: "Press Enter to continue",
        screen: "Installed.\nPress Enter to continue",
        replies: &[("Enter", ENTER, false)],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "press any key",
        screen: "Update complete\nPress any key to continue...",
        replies: &[("Enter", ENTER, false)],
        question: None,
        subject: "",
        risks: None,
    },
    // ---- un-numbered menus
    Case {
        name: "pointer menu, cursor on first",
        screen: r#"
Allow this tool call?
❯ Allow once
  Allow always
  Deny
"#,
        replies: &[
            ("Allow once", ENTER, false),
            ("Allow always", &["down", "enter"], true),
            ("Deny", &["down", "down", "enter"], false),
        ],
        question: Some("Allow this tool call?"),
        subject: "",
        risks: None,
    },
    Case {
        name: "pointer menu, cursor in the middle walks both ways",
        screen: r#"
Allow this tool call?
  Allow once
❯ Allow always
  Deny
"#,
        replies: &[
            ("Allow once", &["up", "enter"], false),
            ("Allow always", ENTER, true),
            ("Deny", &["down", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "pointer menu with a destructive question",
        screen: r#"
Allow bash: rm -rf node_modules?
❯ Allow once
  Deny
"#,
        replies: &[
            ("Allow once", ENTER, true),
            ("Deny", &["down", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
    Case {
        name: "radio menu",
        screen: r#"
Pick a mode?
○ Fast
● Careful
○ Thorough
"#,
        replies: &[
            ("Fast", &["up", "enter"], false),
            ("Careful", ENTER, false),
            ("Thorough", &["down", "enter"], false),
        ],
        question: None,
        subject: "",
        risks: None,
    },
];

const NEGATIVES: &[(&str, &str)] = &[
    ("empty", ""),
    ("only blank rows", "\n   \n\n"),
    ("shell prompt", "user@host:~/proj$ "),
    (
        "a README list that scrolled past",
        "Here are the steps:\n1. Install\n2. Build\n3. Run\nAll done, tell me if you want changes.\n",
    ),
    (
        "a README list at the bottom without a question",
        "I made these changes\n1. Install\n2. Build\n3. Run\n",
    ),
    (
        "a list with a quote marker and no question",
        "Notes\n> 1. Install\n  2. Build\n",
    ),
    (
        "a long prose paragraph then a list",
        "There are a few things worth knowing before we continue with the refactor.\n1. First thing\n2. Second thing\n",
    ),
    ("list not starting at 1", "Which?\n2. two\n3. three\n"),
    ("gap in numbering", "Which?\n1. one\n3. three\n"),
    ("a single option", "Do you want to proceed?\n❯ 1. Yes\n"),
    ("two pointers", "Which?\n❯ 1. one\n❯ 2. two\n"),
    ("question without options", "Do you want to proceed?"),
    (
        "a press-enter hint that is not last",
        "Press Enter to continue\nand then some more output\n",
    ),
    (
        "a y/n that is not last",
        "Overwrite? [y/N]\ny\nOverwritten 3 files.\n",
    ),
    (
        "(yes/no) in prose",
        "Should I document the (yes/no) syntax in the README for new users",
    ),
    (
        "Claude working footer only",
        "✻ Thinking… (esc to interrupt)",
    ),
    (
        "codex confirm dialog without a menu",
        "Press enter to confirm or esc to cancel",
    ),
    (
        "menu followed by an unrelated line",
        "Do you want to proceed?\n❯ 1. Yes\n  2. No\nCompiling the project for production now with all optimisations\n",
    ),
    (
        "more than nine options",
        "Pick one?\n❯ 1. a\n  2. b\n  3. c\n  4. d\n  5. e\n  6. f\n  7. g\n  8. h\n  9. i\n  10. j\n",
    ),
    (
        "unaligned bullet rows are not a pointer menu",
        "Next steps:\n❯ run the tests\n deploy\n",
    ),
    (
        "tall prose under a pointer",
        "Summary:\n❯ This sentence is far too long to be a choice in a menu and so it is prose text\n  Second\n",
    ),
    ("radio without a selection", "Pick?\n○ A\n○ B\n"),
    ("radio with two selected", "Pick?\n● A\n● B\n"),
];

#[test]
fn positive_screens_offer_the_documented_answers() {
    for c in POSITIVES {
        let p = detect(c.screen).unwrap_or_else(|| panic!("{}: no prompt found", c.name));
        let want: Vec<String> = c
            .replies
            .iter()
            .map(|(l, k, confirm)| fmt(l, k, *confirm))
            .collect();
        assert_eq!(replies(&p), want, "{}", c.name);
        if let Some(q) = c.question {
            assert_eq!(p.question, q, "{}", c.name);
        }
        assert!(!p.question.is_empty(), "{}", c.name);
        assert_eq!(subject(&p), c.subject, "{}", c.name);
        if let Some(r) = c.risks {
            assert_eq!(risks(&p), r, "{}", c.name);
        }
        for r in &p.options {
            assert!(
                r.risk.is_none() || r.needs_confirm(),
                "{}: {}: a reason needs the confirm",
                c.name,
                r.label
            );
        }
    }
}

#[test]
fn screens_that_only_look_like_prompts_have_none() {
    for (name, screen) in NEGATIVES {
        assert_eq!(detect(screen), None, "no prompt: {name}");
    }
}

#[test]
fn long_labels_are_capped_with_a_mark() {
    let long = "very long option text ".repeat(6);
    let p = found(&format!("Which?\n❯ 1. {long}\n  2. short\n"));
    let label = &p.options[0].label;
    assert!(label.encode_utf16().count() <= 40, "{label}");
    assert!(label.ends_with('…'), "{label}");
}

// The window is what keeps old output out of a prompt's reading. What it drops
// of a command's own rows must not make the command look whole: the rows left
// (5 of a 12-row command) fit the card, and `rm -rf /` was in the first of them.
#[test]
fn rows_the_window_dropped_from_a_long_command_make_it_long_not_whole() {
    let screen = |command: &[String]| {
        let mut rows = vec![" Bash command".to_owned()];
        rows.extend(command.iter().map(|r| format!("   {r}")));
        rows.extend(
            [
                " Do you want to proceed?",
                " ❯ 1. Yes",
                "   2. Yes, then B",
                "   3. Yes, then C",
                "   4. Yes, then D",
                "   5. Yes, then E",
                "   6. No",
            ]
            .map(str::to_owned),
        );
        rows.join("\n")
    };
    // 12 rows fit exactly when the command has 4: nothing was dropped.
    let four: Vec<String> = ["echo one", "echo two", "echo three", "echo four"]
        .map(str::to_owned)
        .to_vec();
    let whole = found(&screen(&four));
    assert_eq!(
        subject(&whole).split('\n').collect::<Vec<_>>(),
        ["echo one", "echo two", "echo three", "echo four"]
    );
    assert!(!whole.options[0].needs_confirm());
    // 12 command rows: the window keeps the last 5 of them and the question.
    let mut twelve = vec!["rm -rf /".to_owned()];
    twelve.extend((2..=12).map(|i| format!("step {i}")));
    let cut = found(&screen(&twelve));
    assert!(!subject(&cut).contains("rm -rf"));
    assert_eq!(cut.options[0].risk, Some(Risk::LongCommand));
    assert!(
        !cut.options.last().unwrap().needs_confirm(),
        "declining is always safe"
    );
}

#[test]
fn a_vietnamese_question_and_options_survive() {
    let p = found("Bạn có muốn tiếp tục không?\n❯ 1. Có\n  2. Không, hãy làm khác đi\n");
    assert_eq!(p.question, "Bạn có muốn tiếp tục không?");
    let labels: Vec<&str> = p.options.iter().map(|r| r.label.as_str()).collect();
    assert_eq!(labels, ["1. Có", "2. Không, hãy làm khác đi"]);
}

#[test]
fn a_menu_inside_a_box_with_side_bars_reads_the_same_as_without() {
    let plain = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
    let boxed = plain
        .trim_end()
        .split('\n')
        .map(|l| format!("│ {l:<30} │"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(detect(&boxed), detect(plain));
    assert!(detect(plain).is_some());
}

#[test]
fn detection_is_a_pure_function_of_its_rows() {
    let s = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
    assert_eq!(detect(s), detect(s));
    assert_eq!(detect(s).unwrap().digest, detect(s).unwrap().digest);
}

// ---------------------------------------------------------------- subject

const MENU: &str = " Do you want to proceed?\n ❯ 1. Yes\n   2. No\n";

fn subject_of(above: &str) -> String {
    subject(&found(&format!("{above}{MENU}"))).to_owned()
}

#[test]
fn claude_mcp_tool_use_shows_the_call_and_its_description() {
    let p = found(
        r#"
 Tool use

   playwright - navigate (MCP)(url: "https://example.com")
   Navigate the browser to a URL

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for playwright - navigate commands in /x
   3. No, and tell Claude what to do differently (esc)
"#,
    );
    assert_eq!(p.question, "Do you want to proceed?");
    assert_eq!(
        subject(&p),
        "playwright - navigate (MCP)(url: \"https://example.com\")\nNavigate the browser to a URL"
    );
    assert_eq!(risks(&p), [None, STANDING, None]);
}

#[test]
fn claude_fetch_shows_the_url_and_what_claude_wants_with_it() {
    let p = found(
        r#"
 Fetch

   https://example.com/docs
   Claude wants to fetch content from example.com

 Do you want to allow Claude to fetch this content?
 ❯ 1. Yes
   2. No, and tell Claude what to do differently (esc)
"#,
    );
    assert_eq!(
        p.question,
        "Do you want to allow Claude to fetch this content?"
    );
    assert_eq!(
        subject(&p),
        "https://example.com/docs\nClaude wants to fetch content from example.com"
    );
    assert!(!any_confirm(&p));
}

#[test]
fn a_long_command_whose_header_scrolled_out_still_gets_a_subject_capped_at_six_rows_and_marked() {
    let mut screen = vec![" Bash command".to_owned()];
    screen.extend((1..=9).map(|i| format!("   part {i}")));
    screen.extend(
        [
            " Do you want to proceed?",
            " ❯ 1. Yes",
            "   2. No",
            "   3. Not now",
        ]
        .map(str::to_owned),
    );
    let p = found(&screen.join("\n"));
    // Twelve rows fit: "Bash command" and "part 1" are gone; the block now
    // starts at the top of what is visible. Eight rows, six shown, the last of
    // them marked.
    let mut shown: Vec<String> = (2..=6).map(|i| format!("part {i}")).collect();
    shown.push("part 7…".to_owned());
    assert_eq!(subject(&p), shown.join("\n"));
    assert_eq!(risks(&p), [Some(Risk::LongCommand), None, None]);
    assert_eq!(
        p.options
            .iter()
            .map(|r| r.needs_confirm())
            .collect::<Vec<_>>(),
        [true, false, false]
    );
}

#[test]
fn exactly_six_rows_are_shown_whole_and_are_not_long() {
    let mut screen = vec![" Bash command".to_owned()];
    screen.extend((1..=6).map(|i| format!("   part {i}")));
    screen.extend([" Do you want to proceed?", " ❯ 1. Yes", "   2. No"].map(str::to_owned));
    let p = found(&screen.join("\n"));
    let whole: Vec<String> = (1..=6).map(|i| format!("part {i}")).collect();
    assert_eq!(subject(&p), whole.join("\n"));
    assert!(!any_confirm(&p));
}

#[test]
fn a_row_over_160_characters_is_cut_with_a_mark_and_the_answer_says_the_command_is_long() {
    let p = found(&format!(
        " Bash command\n   echo {}\n   Print it\n{MENU}",
        "a".repeat(300)
    ));
    let rows: Vec<&str> = subject(&p).split('\n').collect();
    assert_eq!(rows[0].encode_utf16().count(), 160);
    assert!(rows[0].ends_with('…'));
    assert_eq!(rows.last(), Some(&"Print it"));
    assert_eq!(risks(&p), [Some(Risk::LongCommand), None]);
}

#[test]
fn a_row_as_long_as_the_previews_allow_was_probably_cut_there_marked_and_long() {
    // The previews keep 160 characters of a row, indentation included.
    let p = found(&format!(" Bash command\n   {}\n{MENU}", "a".repeat(157)));
    assert_eq!(subject(&p), format!("{}…", "a".repeat(157)));
    assert_eq!(risks(&p), [Some(Risk::LongCommand), None]);
    // A row that fits with room to spare is not.
    let short = found(&format!(" Bash command\n   {}\n{MENU}", "a".repeat(120)));
    assert_eq!(subject(&short), "a".repeat(120));
    assert!(!any_confirm(&short));
}

#[test]
fn a_dangerous_tail_the_card_cannot_show_still_gates_with_its_own_reason() {
    // In the cut part of one row.
    let row = found(&format!(
        " Bash command\n   echo {} && git -C . push -f\n{MENU}",
        "a".repeat(300)
    ));
    assert!(!subject(&row).split('\n').next().unwrap().contains("push"));
    assert_eq!(risks(&row), [Some(Risk::ForcePushes), None]);
    // In a row past the sixth.
    let mut screen = vec![" Bash command".to_owned()];
    screen.extend((1..=7).map(|i| format!("   part {i}")));
    screen.extend(
        [
            "   rm -rf /srv/data",
            " Do you want to proceed?",
            " ❯ 1. Yes",
            "   2. No",
        ]
        .map(str::to_owned),
    );
    let rows = found(&screen.join("\n"));
    assert!(!subject(&rows).contains("rm"));
    assert_eq!(risks(&rows), [Some(Risk::DeletesFiles), None]);
}

#[test]
fn a_standing_grant_on_a_long_command_names_the_standing_grant() {
    let p = found(&format!(
        " Bash command\n   echo {}\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for echo commands\n   3. No",
        "a".repeat(300)
    ));
    assert_eq!(risks(&p), [Some(Risk::LongCommand), STANDING, None]);
}

#[test]
fn each_subject_row_is_cut_at_160_characters_but_risk_reads_the_whole_row() {
    let p = found(&format!(
        " Bash command\n   echo {} && rm -rf /tmp/x\n   Clean up\n{MENU}",
        "a".repeat(300)
    ));
    let row = subject(&p).split('\n').next().unwrap();
    assert_eq!(row.encode_utf16().count(), 160);
    assert!(row.ends_with('…'));
    assert_eq!(p.options[0].risk, Some(Risk::DeletesFiles));
}

#[test]
fn edit_and_create_dialogs_have_no_subject_the_file_is_in_the_question() {
    assert_eq!(subject_of(" Edit file\n lib/main.dart\n\n"), "");
    assert_eq!(subject_of(" Create file\n lib/new.dart\n\n"), "");
}

#[test]
fn rows_indented_deeper_than_the_question_under_something_that_is_not_a_header_are_not_a_subject() {
    // A tool echo and its output: transcript, not a title.
    assert_eq!(
        subject_of("● Update(src/a.ts)\n  ⎿  Updated src/a.ts\n"),
        ""
    );
    // A sentence.
    assert_eq!(
        subject_of("Here is what I am about to run.\n   npm test\n"),
        ""
    );
    // A question.
    assert_eq!(subject_of("Is this right?\n   npm test\n"), "");
    // Too long for a title.
    assert_eq!(
        subject_of("A heading that is far too long to be one\n   npm test\n"),
        ""
    );
}

#[test]
fn rows_at_the_questions_own_indent_are_not_a_subject() {
    assert_eq!(subject_of(" npm test\n"), "");
}

#[test]
fn codex_and_the_trust_prompt_show_the_row_between_question_and_menu_and_the_question_alone() {
    let p = found(
        r#"
  Would you like to run the following command?

  Reason: needs network access

  $ curl -s https://example.com/install.sh

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)
"#,
    );
    assert_eq!(p.question, "Would you like to run the following command?");
    assert_eq!(subject(&p), "$ curl -s https://example.com/install.sh");
}

#[test]
fn a_menu_without_a_question_names_no_subject() {
    let p = found("Some output\n❯ 1. Yes\n  2. No");
    assert_eq!(subject(&p), "");
    assert_eq!(p.question, "Some output");
}

#[test]
fn inline_and_press_enter_prompts_have_no_subject_their_question_already_carries_the_row_above() {
    assert_eq!(subject(&found("Overwrite config.json? [y/N]")), "");
    assert_eq!(subject(&found("Installed.\nPress Enter to continue")), "");
}

// The row above a pointer or radio menu's question used to be judged for risk
// and then dropped: the card showed "Allow this tool call?" over any command,
// and its digest was the same for `ls` and `rm -rf`.
#[test]
fn a_pointer_or_radio_menu_names_the_risky_row_above_its_question() {
    let p = found("bash: rm -rf node_modules\nAllow this tool call?\n❯ Allow once\n  Deny");
    assert_eq!(subject(&p), "bash: rm -rf node_modules");
    assert_eq!(risks(&p), [Some(Risk::DeletesFiles), None]);
    let radio = found("rm -rf node_modules\nPick a mode?\n○ Fast\n● Careful");
    assert_eq!(subject(&radio), "rm -rf node_modules");
}

#[test]
fn the_digest_tells_two_commands_under_one_question_apart() {
    let rm = found("rm -rf node_modules\nAllow this tool call?\n❯ Allow once\n  Deny");
    let ls = found("ls node_modules\nAllow this tool call?\n❯ Allow once\n  Deny");
    assert_ne!(rm, ls);
    assert_ne!(subject(&rm), subject(&ls));
    assert_ne!(rm.digest, ls.digest);
}

#[test]
fn a_numbered_menu_names_the_risky_row_above_its_question_too() {
    let p = found("git push --force origin main\nDo you want to proceed?\n❯ 1. Yes\n  2. No");
    assert_eq!(subject(&p), "git push --force origin main");
}

#[test]
fn a_row_above_the_question_that_flags_nothing_is_scrollback_not_a_subject() {
    assert_eq!(
        subject(&found(
            "Done editing, now:\nAllow this tool call?\n❯ Allow once\n  Deny"
        )),
        ""
    );
    assert_eq!(
        subject(&found(
            "ls node_modules\nAllow this tool call?\n❯ Allow once\n  Deny"
        )),
        ""
    );
    // A diff above an edit dialog is deeper than the question: output.
    let p = found(
        "Here is the diff for lib/a.dart.\n   10 - rm -rf build\n Do you want to make this edit?\n ❯ 1. Yes\n   2. No",
    );
    assert_eq!(subject(&p), "");
    assert!(
        p.options[0].needs_confirm(),
        "judged, even though not shown"
    );
}

// ------------------------------------------------------------------- risk

const CLAUDE: &str =
    " Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n";

fn risk(screen: &str, reply: usize) -> Option<Risk> {
    found(screen).options[reply].risk
}

fn bash(command: &str) -> String {
    format!(" Bash command\n\n   {command}\n   Run it\n\n{CLAUDE}")
}

#[test]
fn an_ordinary_command_after_an_edit_summary_that_says_1_removal_is_not_flagged() {
    let p = found(
        r#"
 ● Update(src/a.ts)
   ⎿  Updated src/a.ts with 3 additions and 1 removal

 Bash command

   npm test
   Run the tests

 Do you want to proceed?
 ❯ 1. Yes
   2. No
"#,
    );
    assert_eq!(subject(&p), "npm test\nRun the tests");
    assert_eq!(
        p.options
            .iter()
            .map(|r| (r.needs_confirm(), r.risk))
            .collect::<Vec<_>>(),
        [(false, None), (false, None)]
    );
}

#[test]
fn commands_that_only_mention_a_risky_word_are_not_flagged() {
    assert_eq!(risk(&bash(r#"rg "remove_user" src"#), 0), None);
    assert_eq!(risk(&bash("git log --grep=delete"), 0), None);
    assert_eq!(risk(&bash("npm run build -- --force-color"), 0), None);
}

#[test]
fn commands_the_old_keyword_gate_missed_are_flagged_with_a_reason() {
    for (command, reason) in [
        ("git push origin main", "pushes to a remote"),
        ("npm publish", "publishes or merges"),
        ("terraform apply", "changes infrastructure"),
        ("docker system prune -af", "removes containers or volumes"),
        ("git branch -D old", "discards git changes"),
        ("curl https://x.sh | sh", "runs a downloaded script"),
        ("make migrate ENV=production", "changes a database"),
        ("rm -rf build", "deletes files"),
    ] {
        assert_eq!(
            risk(&bash(command), 0).map(Risk::reason),
            Some(reason),
            "{command}"
        );
    }
}

#[test]
fn the_second_row_of_a_subject_counts_a_command_that_wraps() {
    assert_eq!(
        risk(
            &format!(" Bash command\n   git push origin\n   --force main\n{CLAUDE}"),
            0
        ),
        Some(Risk::ForcePushes)
    );
}

#[test]
fn declining_never_carries_a_reason_whatever_the_command() {
    let p = found(&bash("rm -rf build"));
    assert!(!p.options[1].needs_confirm());
    assert_eq!(p.options[1].risk, None);
}

#[test]
fn a_standing_grant_always_needs_the_second_tap_and_says_so() {
    for grant in [
        "Yes, and don't ask again for npm commands",
        "Yes, allow all edits during this session (shift+tab)",
        "Yes, always allow",
    ] {
        let p = found(&format!(
            " Do you want to proceed?\n ❯ 1. Yes\n   2. {grant}\n   3. No"
        ));
        assert!(
            !p.options[0].needs_confirm(),
            "the one-time yes stays one tap"
        );
        assert!(p.options[1].needs_confirm(), "{grant}");
        assert_eq!(p.options[1].risk, STANDING, "{grant}");
        assert!(p.options[1].standing_grant, "{grant}");
    }
}

#[test]
fn a_standing_grant_on_a_risky_command_names_the_standing_grant_first() {
    let screen = bash("git push origin main").replacen(
        "2. No, and tell Claude what to do differently (esc)",
        "2. Yes, and don't ask again for git push",
        1,
    );
    let p = found(&screen);
    assert_eq!(p.options[0].risk, Some(Risk::Pushes));
    assert_eq!(p.options[1].risk, STANDING);
}

#[test]
fn only_the_rows_around_the_question_count_not_the_scrollback() {
    // The risky row is three rows above the question and no header sits on it.
    assert_eq!(
        risk(
            "git push origin main\nsome output\nmore output\nDo you want to proceed?\n❯ 1. Yes\n  2. No",
            0
        ),
        None
    );
    // Right above the question it counts.
    assert_eq!(
        risk(
            "some output\ngit push --force origin main\nDo you want to proceed?\n❯ 1. Yes\n  2. No",
            0
        ),
        Some(Risk::ForcePushes)
    );
}

#[test]
fn a_risky_option_text_flags_that_option_alone() {
    let p = found("Which cleanup?\n❯ 1. Delete all branches\n  2. Keep them");
    assert_eq!(risks(&p), [Some(Risk::DeletesOrOverwrites), None]);
}

#[test]
fn a_question_that_says_it_overwrites_or_deletes_gates_yes_even_over_plain_options() {
    let p = found("Do you want to overwrite config.json?\n❯ 1. Yes\n  2. No");
    assert_eq!(risks(&p), [Some(Risk::DeletesOrOverwrites), None]);
    assert_eq!(
        p.options
            .iter()
            .map(|r| r.needs_confirm())
            .collect::<Vec<_>>(),
        [true, false]
    );
    let remove = found(" Do you want to remove the 3 stale branches?\n ❯ 1. Yes\n   2. No");
    assert_eq!(remove.options[0].risk, Some(Risk::DeletesOrOverwrites));
}

#[test]
fn a_file_name_that_contains_a_risky_word_is_not_a_risky_question() {
    let p = found("Do you want to make this edit to delete_user.dart?\n❯ 1. Yes\n  2. No");
    assert!(!any_confirm(&p));
}

#[test]
fn with_no_subject_the_row_above_the_question_is_read_as_a_sentence_too() {
    assert_eq!(
        risk(
            "I will delete the old build output.\nDo you want to proceed?\n❯ 1. Yes\n  2. No",
            0
        ),
        Some(Risk::DeletesOrOverwrites)
    );
    // Two rows up is not read.
    assert_eq!(
        risk(
            "I will delete the old build output.\nnpm test\nDo you want to proceed?\n❯ 1. Yes\n  2. No",
            0
        ),
        None
    );
}

#[test]
fn a_subject_row_is_a_command_its_description_does_not_flag_its_command_does() {
    assert_eq!(
        risk(
            &format!(
                " Bash command\n   ls build\n   Remove old output from the listing\n\n{CLAUDE}"
            ),
            0
        ),
        None
    );
    assert_eq!(
        risk(
            &format!(" Bash command\n   rm -rf build\n   List the build directory\n\n{CLAUDE}"),
            0
        ),
        Some(Risk::DeletesFiles)
    );
}

#[test]
fn a_command_reason_in_the_subject_beats_a_sentence_reason_in_the_question() {
    let p = found(
        " Bash command\n   git push origin main\n   Push\n\n Do you want to delete the remote?\n ❯ 1. Yes\n   2. No",
    );
    assert_eq!(p.options[0].risk, Some(Risk::Pushes));
}

#[test]
fn a_pointer_menu_question_that_says_it_deletes_gates_the_affirmative_options() {
    let p = found("Which files should be deleted?\n❯ Allow once\n  Deny");
    assert_eq!(risks(&p), [Some(Risk::DeletesOrOverwrites), None]);
}

#[test]
fn the_pointer_menu_reads_the_question_and_the_row_above_it_as_a_command() {
    let p = found("Bash: git push origin main\nAllow this command?\n❯ Allow once\n  Deny");
    assert_eq!(risks(&p), [Some(Risk::Pushes), None]);
    // Two rows up is out of scope.
    let far = found("rm -rf build/\nnpm test\nAllow this command?\n❯ Allow once\n  Deny");
    assert!(!any_confirm(&far));
}

#[test]
fn allow_always_in_a_pointer_menu_is_a_standing_grant() {
    let p = found("Allow this tool call?\n❯ Allow once\n  Allow always\n  Deny");
    assert_eq!(risks(&p), [None, STANDING, None]);
}

#[test]
fn inline_prompts_read_the_last_row_and_the_one_before_it_for_yes_only() {
    let p = found("Running: git push origin main\nContinue? [y/N]");
    assert_eq!(risks(&p), [Some(Risk::Pushes), None]);
    let far = found("rm -rf build\nsome output\nmore output\nContinue? [y/N]");
    assert!(!any_confirm(&far));
}

// -------------------------------------------------------------- the model

#[test]
fn a_subject_takes_part_in_equality() {
    let mut a = found("Do you want to proceed?\n❯ 1. Yes\n  2. No");
    let mut b = a.clone();
    a.subject = Some("x".into());
    b.subject = Some("y".into());
    assert_ne!(a, b);
    assert_ne!(prompt::prompt_digest(&a), prompt::prompt_digest(&b));
}

#[test]
fn a_risk_takes_part_in_equality() {
    let a = found("Do you want to proceed?\n❯ 1. Yes\n  2. No");
    let mut b = a.clone();
    b.options[0].risk = Some(Risk::Pushes);
    assert_ne!(a, b);
}

// ----------------------------------------- Claude Code 2.1 (dashed rules)

// The layout of a real 2.1.293 screen (tests/fixtures/prompts/claude/): the
// command sits between two dashed rules, at the same indent as the question,
// under a description.
fn dialog(header: &str, command: &str, note: &str) -> String {
    let rule = "╌".repeat(53);
    format!(
        "{header}\n Tip: auto mode handles these prompts for you\n Create empty file x.txt\n{rule}\n{command}\n{rule}\n{note} Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again for: touch\n   3. No\n"
    )
}

const DEFAULT_HEADER: &str = " Bash command";
const DEFAULT_COMMAND: &str = " touch /tmp/x.txt";

#[test]
fn the_command_is_the_subject_without_the_description_and_the_tip() {
    let p = found(&dialog(DEFAULT_HEADER, DEFAULT_COMMAND, ""));
    assert_eq!(p.question, "Do you want to proceed?");
    assert_eq!(subject(&p), "touch /tmp/x.txt");
}

#[test]
fn a_note_between_the_rule_and_the_question_does_not_hide_it() {
    let p = found(&dialog(
        DEFAULT_HEADER,
        DEFAULT_COMMAND,
        " This command requires approval\n",
    ));
    assert_eq!(subject(&p), "touch /tmp/x.txt");
}

#[test]
fn a_subagents_title_after_the_dot_is_still_a_title() {
    let p = found(&dialog(
        " Bash command · from the general-purpose agent",
        DEFAULT_COMMAND,
        "",
    ));
    assert_eq!(subject(&p), "touch /tmp/x.txt");
}

#[test]
fn a_dangerous_command_is_judged_from_the_subject_and_needs_its_second_tap() {
    let p = found(&dialog(DEFAULT_HEADER, " rm -rf /tmp/build", ""));
    assert!(p.options[0].needs_confirm());
}

#[test]
fn a_dialog_about_a_file_keeps_its_diff_out_of_the_subject() {
    let rule = "╌".repeat(53);
    let p = found(&format!(
        " Edit file\n note.txt\n{rule}\n 1 -rm -rf /\n 2 +hello there\n{rule}\n Do you want to make this edit to note.txt?\n ❯ 1. Yes\n   2. No\n"
    ));
    assert_eq!(subject(&p), "");
    assert!(
        !p.options[0].needs_confirm(),
        "the removed text is not a command"
    );
}

#[test]
fn a_command_row_of_dashes_behind_the_bar_is_the_command_not_a_rule_that_hides_the_rows_above_it() {
    let rule = "╌".repeat(53);
    let inner = "╌".repeat(8);
    let p = found(&format!(
        " Bash command\n Create a file\n{rule}\n │ rm -rf ~/work; cat <<'EOF'\n │ Done\n │ {inner}\n │ EOF\n │ echo ok\n{rule}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
    ));
    assert!(subject(&p).contains("rm -rf ~/work"));
    assert!(
        p.options[0].needs_confirm(),
        "the dangerous row is judged, whatever follows"
    );
}

#[test]
fn a_preview_never_shows_the_stand_in_of_a_rule() {
    assert!(is_dashed_rule(&clean_preview_row(&"╌".repeat(30)).unwrap()));
    assert_eq!(clean_preview_row("╌╌╌"), None, "a short run is not a rule");
    assert!(!is_dashed_rule(
        &clean_preview_row("──────────").unwrap_or_default()
    ));
}

// ------------------------------------------------------------ Codex tools

#[test]
fn a_codex_command_that_wraps_is_read_whole_after_its_reason() {
    let p = found(
        r#"
  Would you like to run the following command?

  Environment: local

  Reason: need network

  $ rm -rf ~/work &&
    echo done

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
"#,
    );
    assert!(subject(&p).contains("rm -rf ~/work"));
    assert!(subject(&p).contains("echo done"));
    assert!(!subject(&p).contains("Reason"));
}

#[test]
fn a_digit_alone_answers_a_codex_question_because_an_enter_after_it_would_answer_the_next_one() {
    let p = found(
        r#"
  Question 1/2 (2 unanswered)
  Which room is the desk in?

  › 1. Office (Recommended)  The desk is in the office.
    2. Bedroom               The desk is in the bedroom.

  tab to add notes | enter to submit answer | esc to interrupt
"#,
    );
    assert_eq!(
        p.question, "1 of 2 · Which room is the desk in?",
        "the card is one question of a form"
    );
    let keys: Vec<&[String]> = p.options.iter().map(|r| r.keys.as_slice()).collect();
    assert_eq!(keys, [["1"], ["2"]]);
}

#[test]
fn clean_preview_row_strips_side_bars_keeps_indentation_drops_rules_and_blanks() {
    assert_eq!(
        clean_preview_row("│   hello   │").as_deref(),
        Some("  hello")
    );
    assert_eq!(clean_preview_row("╭────────╮"), None);
    assert_eq!(clean_preview_row("   "), None);
    assert_eq!(
        clean_preview_row("trailing   ").as_deref(),
        Some("trailing")
    );
    assert_eq!(clean_preview_row("---"), None);
    assert_eq!(clean_preview_row("- item").as_deref(), Some("- item"));
}
