use super::samples::ALL;
use super::*;
use std::time::{Duration, Instant};

fn roles(spans: &[Span], text: &str) -> Vec<(String, Role)> {
    spans
        .iter()
        .map(|s| (text[s.range()].to_string(), s.role))
        .collect()
}

fn has(spans: &[Span], text: &str, word: &str, role: Role) -> bool {
    spans
        .iter()
        .any(|s| s.role == role && &text[s.range()] == word)
}

fn well_formed(spans: &[Span], text: &str) {
    let mut end = 0;
    for s in spans {
        assert!(s.start >= end, "overlap or disorder at {s:?}");
        assert!(
            s.start < s.end && (s.end as usize) <= text.len(),
            "bad span {s:?}"
        );
        assert!(
            text.is_char_boundary(s.start as usize) && text.is_char_boundary(s.end as usize),
            "not on a boundary {s:?}"
        );
        assert_ne!(s.role, Role::Plain, "plain spans are gaps");
        end = s.end;
    }
}

#[test]
fn every_language_has_a_query_that_compiles() {
    for lang in Lang::ALL {
        if ts::supports(lang)
            && let Err(e) = Grammar::try_build(lang)
        {
            panic!("{e}");
        }
    }
}

#[test]
fn every_sample_is_coloured_and_well_formed() {
    for (fence, file, text) in ALL {
        let syntax = Syntax::resolve(Some(fence), Some(file), text);
        assert_ne!(syntax, Syntax::Plain, "{fence} has no syntax");
        let spans = highlight_syntax(&syntax, text);
        well_formed(&spans, text);
        let coloured: u32 = spans
            .iter()
            .filter(|s| s.role != Role::Punctuation)
            .map(|s| s.end - s.start)
            .sum();
        assert!(
            coloured as usize * 100 / text.len() >= 25,
            "{fence}: only {coloured} of {} bytes coloured",
            text.len()
        );
        let kinds: std::collections::HashSet<_> = spans.iter().map(|s| s.role).collect();
        // A diff has four kinds of line and JSON has no types or functions to tell apart.
        let least = if matches!(*fence, "diff" | "json") {
            4
        } else {
            6
        };
        assert!(
            kinds.len() >= least,
            "{fence}: only {} kinds of token: {kinds:?}",
            kinds.len()
        );
    }
}

#[test]
fn growing_a_block_gives_what_one_pass_gives() {
    for (fence, file, text) in ALL {
        let syntax = Syntax::resolve(Some(fence), Some(file), text);
        let whole = highlight_syntax(&syntax, text);
        for step in [1usize, 7, 61, 400] {
            let mut h = Highlighter::new(&syntax);
            let mut at = 0;
            while at < text.len() {
                let mut end = (at + step).min(text.len());
                while !text.is_char_boundary(end) {
                    end += 1;
                }
                let prefix = &text[..end];
                let update = h.update(prefix);
                well_formed(update.spans, prefix);
                at = end;
            }
            assert_eq!(
                roles(h.spans(), text),
                roles(&whole, text),
                "{fence}: streamed in steps of {step} differs from one pass"
            );
        }
    }
}

#[test]
fn growing_a_block_keeps_what_was_drawn() {
    // Appending text recolours nothing above the last few lines: what is on screen stays. (A
    // construct that opens and closes can legitimately recolour lines above it; those are counted.)
    let mut recoloured = 0usize;
    let mut updates = 0usize;
    for (fence, file, text) in ALL {
        let syntax = Syntax::resolve(Some(fence), Some(file), text);
        let mut h = Highlighter::new(&syntax);
        let mut before: Vec<Span> = Vec::new();
        let mut prev = String::new();
        let mut at = 0;
        while at < text.len() {
            let mut end = (at + 23).min(text.len());
            while !text.is_char_boundary(end) {
                end += 1;
            }
            let prefix = &text[..end];
            let after = h.update(prefix).spans.to_vec();
            if !prev.is_empty() {
                // Everything above the last three lines of the previous text.
                let mut limit = prev.len();
                for _ in 0..3 {
                    limit = prev[..limit].rfind('\n').unwrap_or(0);
                }
                let above = |spans: &[Span]| -> Vec<Span> {
                    spans
                        .iter()
                        .filter(|s| (s.end as usize) <= limit)
                        .copied()
                        .collect()
                };
                updates += 1;
                if above(&before) != above(&after) {
                    recoloured += 1;
                    if std::env::var_os("HL_VERBOSE").is_some() {
                        eprintln!(
                            "{fence}: recoloured above byte {limit} when {:?} arrived",
                            &prefix[prev.len()..]
                        );
                    }
                }
            }
            before = after;
            prev = prefix.to_string();
            at = end;
        }
    }
    assert!(
        recoloured * 100 <= updates * 8,
        "{recoloured} of {updates} updates recoloured text above the last three lines"
    );
}

#[test]
fn an_edit_in_the_middle_gives_what_one_pass_gives() {
    for (fence, file, text) in ALL {
        let syntax = Syntax::resolve(Some(fence), Some(file), text);
        let mut h = Highlighter::new(&syntax);
        h.update(text);
        // Cut a line out of the middle, then put it back.
        let lines: Vec<&str> = text.split_inclusive('\n').collect();
        let mid = lines.len() / 2;
        let edited: String = lines
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != mid)
            .map(|(_, l)| *l)
            .collect();
        let spans = h.update(&edited).spans.to_vec();
        assert_eq!(
            roles(&spans, &edited),
            roles(&highlight_syntax(&syntax, &edited), &edited),
            "{fence}: after removing a line"
        );
        let spans = h.update(text).spans.to_vec();
        assert_eq!(
            roles(&spans, text),
            roles(&highlight_syntax(&syntax, text), text),
            "{fence}: after putting it back"
        );
    }
}

#[test]
fn a_block_still_being_written_is_read_as_it_stands() {
    let open = [
        ("ts", "const s = `hello ${name"),
        ("ts", "function f(a: number) {\n  return a +"),
        ("rust", "fn main() {\n    let s = \"never closed"),
        ("python", "def f(x):\n    \"\"\"never closed\n    return x"),
        ("go", "func main() {\n\tfmt.Println(\"a\","),
        ("bash", "echo \"never closed $(date"),
        ("json", "{\"a\": [1, 2,"),
        ("html", "<div class=\"a\"><span"),
        ("css", ".a { color: "),
        ("md", "# Title\n\n```rust\nfn main() {"),
        ("c", "/* never closed\nint x;"),
    ];
    for (fence, text) in open {
        let syntax = Syntax::resolve(Some(fence), None, text);
        let spans = highlight_syntax(&syntax, text);
        well_formed(&spans, text);
        assert!(
            !spans.is_empty(),
            "{fence}: nothing coloured in an open block"
        );
    }
    // The part before the open construct looks the same whether or not it is open.
    let closed = "const a = 1;\nconst b = `x`;\n";
    let opened = "const a = 1;\nconst b = `x`;\nconst c = `never";
    let a = highlight(Lang::TypeScript, closed);
    let b = highlight(Lang::TypeScript, opened);
    assert_eq!(roles(&a, closed), roles(&b[..a.len()], opened));
}

#[test]
fn two_thousand_lines_highlight_within_the_budget() {
    // `cargo test` builds without optimisation, where tree-sitter runs ten to twenty times slower.
    let factor = if cfg!(debug_assertions) { 25.0 } else { 1.0 };
    for (fence, file, sample) in ALL {
        let syntax = Syntax::resolve(Some(fence), Some(file), sample);
        let mut text = String::new();
        while text.matches('\n').count() < 2000 {
            text.push_str(sample);
            if !text.ends_with('\n') {
                text.push('\n');
            }
        }
        let _ = highlight_syntax(&syntax, sample); // the grammar and its query are loaded once
        // The best of three: a busy machine (tests run in parallel) must not fail a guard on a spike.
        let mut spans = Vec::new();
        let mut ms = f64::MAX;
        for _ in 0..3 {
            let start = Instant::now();
            spans = highlight_syntax(&syntax, &text);
            ms = ms.min(start.elapsed().as_secs_f64() * 1000.0);
        }
        assert!(!spans.is_empty());
        // Markdown and HTML repaint wholesale (languages inside languages): twice the budget.
        let budget = match syntax {
            Syntax::Text(_) => 120.0,
            Syntax::Tree(Lang::Markdown | Lang::Html) => 60.0,
            // The Kotlin and Swift grammars parse slowly (Kotlin 19 ms of its 26): a higher budget.
            Syntax::Tree(Lang::Kotlin | Lang::Swift) => 45.0,
            _ => 30.0,
        } * factor;
        assert!(
            ms < budget,
            "{fence}: 2000 lines took {ms:.1} ms (budget {budget:.0})"
        );
    }
}

#[test]
fn a_streamed_update_costs_next_to_nothing() {
    let factor = if cfg!(debug_assertions) { 25.0 } else { 1.0 };
    let (fence, file, sample) = ALL.iter().find(|(f, _, _)| *f == "ts").unwrap();
    let syntax = Syntax::resolve(Some(fence), Some(file), sample);
    let mut text = String::new();
    while text.matches('\n').count() < 2000 {
        text.push_str(sample);
    }
    let mut h = Highlighter::new(&syntax);
    h.update(&text);
    text.push_str("const more = [1, 2, 3].map((x) => x * 2);\n");
    let start = Instant::now();
    h.update(&text);
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    assert!(
        ms < 3.0 * factor,
        "appending a line to 2000 lines took {ms:.2} ms"
    );
}

#[test]
fn comments_strings_and_markers_are_told_apart() {
    let ts = "/** Doc. */\n// TODO(maria): later\nconst s = \"a\\n\\u00e9b\";\nconst raw = 'x';\n";
    let spans = highlight(Lang::TypeScript, ts);
    assert!(has(&spans, ts, "/** Doc. */", Role::DocComment));
    assert!(
        spans
            .iter()
            .any(|s| s.role == Role::Todo && ts[s.range()].starts_with("TODO(maria):"))
    );
    // Touching escapes join into one run.
    assert!(
        spans
            .iter()
            .any(|s| s.role == Role::Escape && ts[s.range()] == *"\\n\\u00e9")
    );
    let rs = "let a = r\"no \\n escape\";\nlet b = \"yes \\n escape\";\n";
    let spans = highlight(Lang::Rust, rs);
    assert_eq!(
        spans.iter().filter(|s| s.role == Role::Escape).count(),
        1,
        "{:?}",
        roles(&spans, rs)
    );
    let sh = "echo 'single \\n quoted'\n";
    assert!(
        highlight(Lang::Bash, sh)
            .iter()
            .all(|s| s.role != Role::Escape)
    );
}

#[test]
fn what_the_text_is_comes_from_the_fence_the_file_the_shebang_or_the_text() {
    assert_eq!(Lang::detect(Some("tsx"), None, ""), Some(Lang::Tsx));
    assert_eq!(
        Lang::detect(Some("rust,no_run"), None, ""),
        Some(Lang::Rust)
    );
    assert_eq!(
        Lang::detect(Some("{.python .numberLines}"), None, ""),
        Some(Lang::Python)
    );
    assert_eq!(Lang::detect(Some("language-go"), None, ""), Some(Lang::Go));
    assert_eq!(
        Lang::detect(Some("ts title=\"a.ts\""), None, ""),
        Some(Lang::TypeScript)
    );
    assert_eq!(
        Lang::detect(None, Some("/a/b/Dockerfile"), ""),
        Some(Lang::Dockerfile)
    );
    assert_eq!(
        Lang::detect(None, Some("src/main.rs"), ""),
        Some(Lang::Rust)
    );
    assert_eq!(
        Lang::detect(None, None, "#!/usr/bin/env python3\nprint(1)"),
        Some(Lang::Python)
    );
    assert_eq!(
        Lang::detect(None, None, "#!/bin/bash -e\nls"),
        Some(Lang::Bash)
    );
    assert_eq!(
        Lang::detect(None, None, "diff --git a/x b/x\n--- a/x"),
        Some(Lang::Diff)
    );
    assert_eq!(
        Lang::detect(None, None, "{\n  \"a\": 1\n}"),
        Some(Lang::Json)
    );
    assert_eq!(
        Lang::detect(Some("text"), None, "diff --git a b"),
        None,
        "text means do not colour"
    );
    assert_eq!(
        Lang::detect(None, None, "just some words in a sentence."),
        None
    );
    // The long tail goes to TextMate, by fence or file.
    assert!(matches!(
        Syntax::resolve(Some("elixir"), None, ""),
        Syntax::Text(_)
    ));
    assert!(matches!(
        Syntax::resolve(None, Some("main.hs"), ""),
        Syntax::Text(_)
    ));
    assert_eq!(
        Syntax::resolve(Some("no-such-language"), None, "x"),
        Syntax::Plain
    );
}

#[test]
fn the_roles_are_a_closed_list_with_one_name_each() {
    let names: std::collections::HashSet<_> = Role::ALL.iter().map(|r| r.name()).collect();
    assert_eq!(names.len(), Role::COUNT);
    for (i, role) in Role::ALL.iter().enumerate() {
        assert_eq!(*role as usize, i);
        assert_eq!(Role::from_u8(i as u8), *role);
    }
}

#[test]
fn markdown_colours_the_code_it_holds() {
    let md = "# T\n\n```rust\nfn main() {}\n```\n\n```text\nfn nope() {}\n```\n";
    let spans = highlight(Lang::Markdown, md);
    assert!(has(&spans, md, "main", Role::FunctionDef));
    assert!(!has(&spans, md, "nope", Role::FunctionDef));
}

#[test]
fn the_long_tail_is_coloured_by_textmate() {
    let ex = "defmodule Greeter do\n  def hello(name), do: \"hi #{name}\"\nend\n";
    let syntax = Syntax::resolve(Some("elixir"), None, ex);
    let spans = highlight_syntax(&syntax, ex);
    well_formed(&spans, ex);
    assert!(
        spans
            .iter()
            .any(|s| s.role == Role::Keyword || s.role == Role::Control)
    );
    assert!(spans.iter().any(|s| s.role == Role::String));
}

// ---- lines and diffs ---------------------------------------------------------------------------

mod rows {
    use super::*;
    use crate::highlight::diff::{self, DiffOptions, Pair, Row};
    use crate::highlight::lines::{self, Kind, Options};
    use std::collections::HashSet;

    fn syntax() -> Syntax {
        Syntax::Tree(Lang::TypeScript)
    }

    #[test]
    fn tabs_stay_tabs_and_whitespace_shows_on_request() {
        let text = "\tlet a = 1;  \n";
        let plain = lines::lines(text, &[], 1, Options { whitespace: false });
        // A tab stays one character, so a copied selection holds the file's own bytes.
        assert_eq!(plain[0].text, "\tlet a = 1;  ");
        let shown = lines::lines(text, &[], 1, Options { whitespace: true });
        assert_eq!(shown[0].text, "\u{2192}       let a = 1;\u{b7}\u{b7}");
        assert!(shown[0].runs.iter().filter(|r| r.whitespace).count() >= 2);
    }

    #[test]
    fn spans_follow_their_text_past_a_tab_and_through_line_breaks() {
        let text = "const a = 1;\n\tconst b = 2;\n";
        let spans = highlight(Lang::TypeScript, text);
        let l = lines::lines(text, &spans, 1, Options::default());
        assert_eq!(l.len(), 2);
        assert_eq!(l[1].new, Some(2));
        let kw = l[1]
            .runs
            .iter()
            .find(|r| r.role == Role::Keyword)
            .expect("a keyword on line 2");
        assert_eq!(&l[1].text[kw.start as usize..kw.end as usize], "const");
        assert_eq!(kw.start, 1, "after the tab, which is one byte");
    }

    #[test]
    fn a_trailing_line_break_does_not_start_a_line() {
        assert_eq!(lines::lines("a\nb\n", &[], 1, Options::default()).len(), 2);
        assert_eq!(lines::lines("a\nb", &[], 1, Options::default()).len(), 2);
        assert_eq!(lines::lines("", &[], 1, Options::default()).len(), 0);
    }

    #[test]
    fn marks_read_numbers_and_ranges() {
        assert_eq!(lines::parse_marks("3,7-9, x, 12"), vec![3, 7, 8, 9, 12]);
    }

    #[test]
    fn a_diff_counts_pairs_words_and_folds_the_unchanged_middle() {
        let old: String = (1..=30).map(|i| format!("const v{i} = {i};\n")).collect();
        let new = old
            .replace("const v3 = 3;", "const v3 = 33;")
            .replace("const v28 = 28;", "const w28 = 28;");
        let u = diff::between(
            &old,
            &new,
            &syntax(),
            DiffOptions::default(),
            &HashSet::new(),
        );
        assert_eq!((u.added, u.removed), (2, 2));
        assert_eq!(u.changes.len(), 2, "two groups of changes");
        let fold = u.rows.iter().find_map(|r| {
            if let Row::Fold { id, hidden } = r {
                Some((*id, *hidden))
            } else {
                None
            }
        });
        assert_eq!(
            fold.map(|f| f.1),
            Some(18),
            "30 lines minus the two changes and 3 lines of context around each, 2 before the first change need no fold"
        );
        // The changed word is marked on both sides, the rest of the line is not.
        let removed = u
            .rows
            .iter()
            .find_map(|r| {
                if let Row::Line(l) = r {
                    (l.kind == Kind::Remove && l.text.contains("v3 ")).then_some(l)
                } else {
                    None
                }
            })
            .expect("the removed line");
        let emphasised: Vec<&str> = removed
            .runs
            .iter()
            .filter(|r| r.emphasis)
            .map(|r| &removed.text[r.start as usize..r.end as usize])
            .collect();
        assert_eq!(emphasised, vec!["3"]);
        // Opening the fold shows every line.
        let open: HashSet<u32> = fold.into_iter().map(|f| f.0).collect();
        let all = diff::between(&old, &new, &syntax(), DiffOptions::default(), &open);
        assert!(all.rows.iter().all(|r| !matches!(r, Row::Fold { .. })));
        assert_eq!(all.rows.len(), 32);
    }

    #[test]
    fn lines_that_changed_almost_entirely_get_no_word_marks() {
        let (a, b) = diff::word_changes("alpha beta gamma", "one two three");
        assert!(a.is_empty() && b.is_empty());
    }

    #[test]
    fn the_numbers_of_a_diff_are_each_sides_own() {
        let u = diff::between(
            "a\nb\nc\n",
            "a\nx\nc\nd\n",
            &Syntax::Plain,
            DiffOptions::default(),
            &HashSet::new(),
        );
        let lines: Vec<_> = u
            .rows
            .iter()
            .filter_map(|r| {
                if let Row::Line(l) = r {
                    Some((l.kind, l.old, l.new))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            lines,
            vec![
                (Kind::Context, Some(1), Some(1)),
                (Kind::Remove, Some(2), None),
                (Kind::Add, None, Some(2)),
                (Kind::Context, Some(3), Some(3)),
                (Kind::Add, None, Some(4))
            ]
        );
    }

    #[test]
    fn a_patch_is_read_with_its_hunks_files_and_syntax() {
        let patch = super::ALL.iter().find(|(f, _, _)| *f == "diff").unwrap().2;
        let files = diff::patch(patch, DiffOptions::default());
        assert!(!files.is_empty());
        let (name, u) = &files[0];
        assert_eq!(name, "src/ledger.rs");
        assert_eq!((u.added, u.removed), (4, 3));
        assert!(
            u.rows
                .iter()
                .any(|r| matches!(r, Row::Hunk(h) if h.starts_with("@@ -12,9")))
        );
        // The new side's lines carry its numbers.
        let first_add = u.rows.iter().find_map(|r| {
            if let Row::Line(l) = r {
                (l.kind == Kind::Add).then_some(l.new)
            } else {
                None
            }
        });
        assert_eq!(first_add, Some(Some(13)));
        // Highlighted as Rust: a keyword somewhere.
        assert!(u.rows.iter().any(
            |r| matches!(r, Row::Line(l) if l.runs.iter().any(|run| run.role == Role::Keyword))
        ));
    }

    #[test]
    fn a_removed_or_added_line_that_looks_like_a_file_header_is_still_a_line() {
        // `-- comment` removed is `--- comment` in the patch; `++ x` added is `+++ x`.
        let patch = "diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,3 +1,3 @@\n--- old comment\n+++ new comment\n keep\n";
        let files = diff::patch(patch, DiffOptions::default());
        assert_eq!(files.len(), 1);
        let (name, u) = &files[0];
        assert_eq!(name, "q.sql");
        assert_eq!((u.added, u.removed), (1, 1));
        // A patch without `diff --git` lines still splits files at the pair that precedes a hunk.
        let two = "--- a/one\n+++ b/one\n@@ -1 +1 @@\n-a\n+b\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-c\n+d\n";
        let files = diff::patch(two, DiffOptions::default());
        assert_eq!(files.len(), 2);
        assert_eq!(files[1].0, "two");
    }

    #[test]
    fn split_pairs_removed_and_added_lines_side_by_side() {
        let u = diff::between(
            "a\nb\nc\n",
            "a\nx\ny\nc\n",
            &Syntax::Plain,
            DiffOptions::default(),
            &HashSet::new(),
        );
        let pairs = diff::split(&u.rows);
        let shape: Vec<_> = pairs
            .iter()
            .map(|p| match p {
                Pair::Lines(a, b) => (a.as_ref().map(|l| l.kind), b.as_ref().map(|l| l.kind)),
                _ => (None, None),
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                (Some(Kind::Context), Some(Kind::Context)),
                (Some(Kind::Remove), Some(Kind::Add)),
                (None, Some(Kind::Add)),
                (Some(Kind::Context), Some(Kind::Context))
            ]
        );
    }
}

/// `cargo test --release bake_off -- --ignored --nocapture`: what each language costs, for the engine's record.
#[test]
#[ignore]
fn bake_off() {
    println!(
        "{:<11} {:>9} {:>10} {:>10} {:>9}",
        "language", "first use", "2000 lines", "append 1", "spans"
    );
    for (fence, file, sample) in ALL {
        let syntax = Syntax::resolve(Some(fence), Some(file), sample);
        let t = Instant::now();
        let _ = highlight_syntax(&syntax, "x");
        let first = t.elapsed().as_secs_f64() * 1000.0;
        let mut text = String::new();
        while text.matches('\n').count() < 2000 {
            text.push_str(sample);
            if !text.ends_with('\n') {
                text.push('\n');
            }
        }
        let t = Instant::now();
        let spans = highlight_syntax(&syntax, &text);
        let full = t.elapsed().as_secs_f64() * 1000.0;
        let mut h = Highlighter::new(&syntax);
        h.update(&text);
        let more = format!("{text}let appended = 1;\n");
        let t = Instant::now();
        h.update(&more);
        let append = t.elapsed().as_secs_f64() * 1000.0;
        println!(
            "{fence:<11} {first:>7.1}ms {full:>8.1}ms {append:>8.2}ms {:>9}",
            spans.len()
        );
    }
}

/// `cargo test --release engines -- --ignored --nocapture`: tree-sitter against the TextMate grammars on the
/// same samples: how many of the semantic distinctions each engine tells apart, and what 2,000 lines cost.
#[test]
#[ignore]
fn engines() {
    const DISTINCTIONS: [Role; 22] = [
        Role::FunctionDef,
        Role::Function,
        Role::Method,
        Role::Type,
        Role::TypeBuiltin,
        Role::Constant,
        Role::Number,
        Role::Property,
        Role::Parameter,
        Role::SelfValue,
        Role::Decorator,
        Role::Escape,
        Role::Interpolation,
        Role::Namespace,
        Role::Control,
        Role::Modifier,
        Role::Todo,
        Role::DocComment,
        Role::Regexp,
        Role::Tag,
        Role::Attribute,
        Role::Macro,
    ];
    println!(
        "{:<11} {:>12} {:>12} {:>10} {:>10}",
        "language", "tree-sitter", "TextMate", "ts 2000", "tm 2000"
    );
    let (mut sum_ts, mut sum_tm) = (0, 0);
    for (fence, file, sample) in ALL {
        let Syntax::Tree(_) = Syntax::resolve(Some(fence), Some(file), sample) else {
            continue;
        };
        let ts = Syntax::resolve(Some(fence), Some(file), sample);
        let tm = Syntax::Text((*fence).to_string());
        let kinds = |s: &Syntax| {
            let spans = highlight_syntax(s, sample);
            let set: std::collections::HashSet<Role> = spans.iter().map(|s| s.role).collect();
            DISTINCTIONS.iter().filter(|r| set.contains(r)).count()
        };
        let (a, b) = (kinds(&ts), kinds(&tm));
        sum_ts += a;
        sum_tm += b;
        let mut big = String::new();
        while big.matches('\n').count() < 2000 {
            big.push_str(sample);
            if !big.ends_with('\n') {
                big.push('\n');
            }
        }
        let t = Instant::now();
        let _ = highlight_syntax(&ts, &big);
        let t_ts = t.elapsed().as_secs_f64() * 1000.0;
        let _ = highlight_syntax(&tm, "x");
        let t = Instant::now();
        let _ = highlight_syntax(&tm, &big);
        let t_tm = t.elapsed().as_secs_f64() * 1000.0;
        println!("{fence:<11} {a:>10}/22 {b:>10}/22 {t_ts:>8.1}ms {t_tm:>8.1}ms");
    }
    println!("{:<11} {:>10}   {:>10}", "total", sum_ts, sum_tm);
}

#[test]
fn an_unfinished_annotation_does_not_hang_the_kotlin_grammar() {
    // tree-sitter-kotlin-ng loops (for over a minute, deaf to a progress callback) on a property followed
    // by a final line that is a lone `@`; the highlighter leaves that unfinished line out.
    let mut h = Highlighter::new(&Syntax::Tree(Lang::Kotlin));
    for hang in [
        "fun f() {\n    val a = 1\n    @",
        "val a = 1\n@Foo",
        "val a = f()\n@file",
    ] {
        let start = Instant::now();
        let spans = h.update(hang).spans.len();
        assert!(start.elapsed() < Duration::from_secs(3), "{hang:?} hung");
        let _ = spans;
    }
    let next = "fun f() {\n    val a = 1\n    return a\n}\n";
    let spans = h.update(next).spans.to_vec();
    assert!(spans.iter().any(|s| s.role == Role::FunctionDef));
}
