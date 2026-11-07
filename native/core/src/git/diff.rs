//! A file's patch: read into hunks and groups of changes, cut to what a view can take, and sliced into the reverse
//! patch of one group.
//!
//! A *group* is a maximal run of added and removed lines (what the diff view steps through with `n` and `p`, and
//! what a note and a revert are about). Two groups in one hunk are separated by unchanged lines. The view reads the
//! same patch text and cuts it the same way, so group `i` here is change `i` there; `native/app/src/highlight` reads
//! `--- ` and `+++ ` lines only before the first hunk for the same reason.

use super::parse::ChangeKind;

/// How many diff lines of a group are kept as its quote.
pub const GROUP_QUOTE: usize = 24;

/// One run of changed lines inside a patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    /// Its place among the file's groups, from 0: what the view's `Change n of m` counts.
    pub index: u32,
    /// Which hunk of the patch holds it, from 0.
    pub hunk: u32,
    /// Lines it adds.
    pub added: u32,
    /// Lines it removes.
    pub removed: u32,
    /// Where it starts in the file as it is now (for a group that only removes, the line that took the place of
    /// what was removed).
    pub line: u32,
    /// Where it ends in the file as it is now (`line` when it only removes).
    pub end_line: u32,
    /// Where it starts in the file as it was.
    pub old_line: u32,
    /// Its changed lines as the patch has them (`+` or `-` first), at most [`GROUP_QUOTE`].
    pub lines: Vec<String>,
    /// How many more changed lines there were.
    pub more: u32,
}

/// A file's patch as shown, with what a screen asks about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiff {
    /// The file, relative to the root.
    pub path: String,
    /// Where a moved file came from.
    pub old_path: Option<String>,
    /// What happened to it.
    pub kind: ChangeKind,
    /// The unified patch (`diff --git` header and hunks), cut when `truncated`.
    pub patch: String,
    /// Lines the shown patch adds.
    pub added: u32,
    /// Lines the shown patch removes.
    pub removed: u32,
    /// git calls it binary: there is no patch to show.
    pub binary: bool,
    /// It has merge conflicts: the patch is empty and nothing here resolves them.
    pub conflicted: bool,
    /// The patch had more than the byte or line limit and was cut at a line.
    pub truncated: bool,
    /// Lines of the shown patch.
    pub lines: u32,
    /// The groups of changes in the shown patch, in order.
    pub groups: Vec<Group>,
    /// Changes whenever the shown patch does; a revert refuses when it is not the one the person saw.
    pub fingerprint: String,
    /// Unchanged lines asked for around each change.
    pub context: u32,
}

/// One line of a hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Line {
    Ctx(String),
    Add(String),
    Del(String),
    /// `\ No newline at end of file`: it belongs to the line before it.
    NoEol,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hunk {
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    /// What follows the second `@@` (the function name git found).
    pub tail: String,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Patch {
    pub hunks: Vec<Hunk>,
    pub binary: bool,
}

/// Where the first hunk header's numbers are: `@@ -12,9 +12,12 @@ name`.
fn hunk_header(line: &str) -> Option<Hunk> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, tail) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |s: &str| -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let (old_start, old_count) = range(old)?;
    let (new_start, new_count) = range(new)?;
    Some(Hunk {
        old_start,
        old_count,
        new_start,
        new_count,
        tail: tail.trim_start().to_owned(),
        lines: Vec::new(),
    })
}

/// Reads one file's patch. A second `diff --git` header ends it: a patch here is one file's.
pub(crate) fn parse_patch(text: &str) -> Patch {
    let mut patch = Patch::default();
    let mut seen_header = false;
    // Split on newlines only: a carriage return is part of a CRLF file's line, and a reverse patch must keep it.
    for line in text.split_terminator('\n') {
        // Inside a hunk every line starts with a space, `+`, `-` or `\`, so these two cannot be body lines.
        if line.starts_with("@@ ") {
            if let Some(hunk) = hunk_header(line) {
                patch.hunks.push(hunk);
            }
            continue;
        }
        if line.starts_with("diff --git ") {
            if seen_header {
                break;
            }
            seen_header = true;
            continue;
        }
        let Some(hunk) = patch.hunks.last_mut() else {
            if line.starts_with("Binary files ") || line == "GIT binary patch" {
                patch.binary = true;
            }
            continue;
        };
        match line.as_bytes().first() {
            Some(b'+') => hunk.lines.push(Line::Add(line[1..].to_owned())),
            Some(b'-') => hunk.lines.push(Line::Del(line[1..].to_owned())),
            Some(b'\\') => hunk.lines.push(Line::NoEol),
            Some(b' ') => hunk.lines.push(Line::Ctx(line[1..].to_owned())),
            None => hunk.lines.push(Line::Ctx(String::new())),
            // Anything else inside a hunk is not part of it.
            Some(_) => {}
        }
    }
    patch
}

/// The changed runs of a patch, as the view counts them: a hunk header and an unchanged line each end a run.
pub(crate) fn groups_of(patch: &Patch) -> Vec<Group> {
    let mut out: Vec<Group> = Vec::new();
    for (h, hunk) in patch.hunks.iter().enumerate() {
        let (mut old, mut new) = (hunk.old_start, hunk.new_start);
        let mut open = false;
        for line in &hunk.lines {
            match line {
                Line::Ctx(_) => {
                    open = false;
                    old += 1;
                    new += 1;
                }
                Line::NoEol => {}
                Line::Add(_) | Line::Del(_) => {
                    if !open {
                        open = true;
                        out.push(Group {
                            index: out.len() as u32,
                            hunk: h as u32,
                            added: 0,
                            removed: 0,
                            line: new,
                            end_line: new,
                            old_line: old,
                            lines: Vec::new(),
                            more: 0,
                        });
                    }
                    let group = out.last_mut().expect("a group was just opened");
                    let (sign, text) = match line {
                        Line::Add(t) => {
                            group.added += 1;
                            group.end_line = new;
                            new += 1;
                            ('+', t)
                        }
                        Line::Del(t) => {
                            group.removed += 1;
                            old += 1;
                            ('-', t)
                        }
                        _ => unreachable!("only changed lines get here"),
                    };
                    if group.lines.len() < GROUP_QUOTE {
                        group.lines.push(format!("{sign}{text}"));
                    } else {
                        group.more += 1;
                    }
                }
            }
        }
    }
    out
}

/// Changes when a changed line, its text or its place does, and not with the amount of unchanged context around it:
/// what a revert compares to know the file is still as the person saw it.
pub(crate) fn patch_fingerprint(patch: &Patch) -> String {
    let mut parts: Vec<Vec<u8>> = Vec::new();
    for hunk in &patch.hunks {
        let (mut old, mut new) = (hunk.old_start, hunk.new_start);
        for line in &hunk.lines {
            match line {
                Line::Ctx(_) => {
                    old += 1;
                    new += 1;
                }
                Line::Add(t) => {
                    parts.push(format!("+{new}:{t}").into_bytes());
                    new += 1;
                }
                Line::Del(t) => {
                    parts.push(format!("-{old}:{t}").into_bytes());
                    old += 1;
                }
                Line::NoEol => parts.push(b"\\".to_vec()),
            }
        }
    }
    let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
    super::fingerprint(&refs)
}

/// The lines of `text` up to `max`, and whether anything was cut. The cut falls at the end of a line.
pub(crate) fn cut_lines(text: &str, max: usize) -> (&str, bool) {
    let mut seen = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            seen += 1;
            if seen == max {
                let end = i + 1;
                return (&text[..end], end < text.len());
            }
        }
    }
    (text, false)
}

/// Text cut to its last whole line (a patch read up to a byte limit ends mid-line).
pub(crate) fn whole_lines(text: &str) -> &str {
    match text.rfind('\n') {
        Some(i) => &text[..=i],
        None => "",
    }
}

/// A name as git writes it in a header: plain, or quoted with escapes when it holds a quote, a backslash or a
/// control character.
pub(crate) fn header_name(name: &str) -> String {
    let plain = name
        .chars()
        .all(|c| !c.is_control() && c != '"' && c != '\\');
    if plain {
        return name.to_owned();
    }
    let mut out = String::from("\"");
    for c in name.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("\\{b:03o}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The patch that, applied in reverse to the working tree, undoes group `group` alone and nothing else, and the same
/// patch's forward form is its undo.
///
/// The hunk that holds the group is rewritten: the group's own lines stay as they are, every other group's added
/// line becomes an unchanged line (it is in the file and stays), and every other group's removed line is dropped (it
/// is not in the file). The numbers in the header are recomputed. `None` when the group does not exist.
pub(crate) fn reverse_group(
    patch: &Patch,
    groups: &[Group],
    path: &str,
    index: usize,
) -> Option<String> {
    let group = groups.get(index)?;
    let hunk = patch.hunks.get(group.hunk as usize)?;
    // Which of the hunk's changed runs is ours: groups of one hunk are in order.
    let ours = groups[..index]
        .iter()
        .filter(|g| g.hunk == group.hunk)
        .count();
    let mut body: Vec<(char, &str)> = Vec::new();
    let (mut run, mut in_run) = (0usize, false);
    let mut keep_marker = false;
    for line in &hunk.lines {
        match line {
            Line::Ctx(t) => {
                in_run = false;
                keep_marker = true;
                body.push((' ', t));
            }
            Line::NoEol => {
                if keep_marker {
                    body.push(('\\', " No newline at end of file"));
                }
            }
            Line::Add(t) | Line::Del(t) => {
                if !in_run {
                    in_run = true;
                    run += 1;
                }
                let mine = run == ours + 1;
                match line {
                    Line::Add(_) if mine => {
                        keep_marker = true;
                        body.push(('+', t));
                    }
                    Line::Add(_) => {
                        keep_marker = true;
                        body.push((' ', t));
                    }
                    _ if mine => {
                        keep_marker = true;
                        body.push(('-', t));
                    }
                    _ => keep_marker = false,
                }
            }
        }
    }
    let old_count = body.iter().filter(|(s, _)| *s != '+' && *s != '\\').count() as u32;
    let new_count = body.iter().filter(|(s, _)| *s != '-' && *s != '\\').count() as u32;
    // The first line of the region in the file as it is now. The two sides share everything before it, so it is
    // also the first line of the old side; an empty side is named by the line before it, as git does.
    let first = if hunk.new_count == 0 {
        hunk.new_start + 1
    } else {
        hunk.new_start
    };
    let side = |count: u32| {
        if count == 0 {
            first.saturating_sub(1)
        } else {
            first
        }
    };
    let name = header_name(&format!("a/{path}"));
    let name_b = header_name(&format!("b/{path}"));
    let mut out = format!(
        "diff --git {name} {name_b}\n--- {name}\n+++ {name_b}\n@@ -{},{old_count} +{},{new_count} @@",
        side(old_count),
        side(new_count),
    );
    if !hunk.tail.is_empty() {
        out.push(' ');
        out.push_str(&hunk.tail);
    }
    out.push('\n');
    for (sign, text) in body {
        out.push(sign);
        out.push_str(text);
        out.push('\n');
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO: &str = "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,9 +1,9 @@ fn x\n a\n-b\n+B\n c\n d\n e\n f\n-g\n+G\n h\n i\n";

    #[test]
    fn groups_split_at_unchanged_lines_and_count_their_lines() {
        let patch = parse_patch(TWO);
        let groups = groups_of(&patch);
        assert_eq!(groups.len(), 2);
        assert_eq!(
            (groups[0].added, groups[0].removed, groups[0].line),
            (1, 1, 2)
        );
        assert_eq!((groups[1].line, groups[1].old_line), (7, 7));
        assert_eq!(groups[0].lines, ["-b", "+B"]);
    }

    #[test]
    fn a_removed_line_that_looks_like_a_file_header_is_still_a_line() {
        let patch = parse_patch(
            "diff --git a/q b/q\n--- a/q\n+++ b/q\n@@ -1,2 +1,1 @@\n--- a comment\n ok\n",
        );
        let groups = groups_of(&patch);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].lines, ["--- a comment"]);
    }

    #[test]
    fn reversing_one_group_leaves_the_other_alone() {
        let patch = parse_patch(TWO);
        let groups = groups_of(&patch);
        let first = reverse_group(&patch, &groups, "f", 0).unwrap();
        // The second group's added line stays as an unchanged line and its removed line is gone.
        assert!(first.contains("\n-b\n+B\n"));
        assert!(first.contains("\n G\n"));
        assert!(!first.contains("-g"));
        assert!(first.contains("@@ -1,8 +1,8 @@ fn x"));
        let second = reverse_group(&patch, &groups, "f", 1).unwrap();
        assert!(second.contains("\n B\n") && second.contains("\n-g\n+G\n"));
    }

    #[test]
    fn a_patch_is_cut_at_a_line() {
        assert_eq!(cut_lines("a\nb\nc\n", 2), ("a\nb\n", true));
        assert_eq!(cut_lines("a\nb\n", 2), ("a\nb\n", false));
        assert_eq!(whole_lines("a\nb\nc"), "a\nb\n");
    }

    #[test]
    fn names_with_quotes_are_quoted_the_way_git_does() {
        assert_eq!(header_name("a/x y"), "a/x y");
        assert_eq!(header_name("a/q\"t"), "\"a/q\\\"t\"");
        assert_eq!(header_name("a/n\nl"), "\"a/n\\nl\"");
    }
}
