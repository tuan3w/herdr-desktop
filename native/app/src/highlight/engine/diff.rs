//! The rows of a diff: from two texts or from a unified patch, syntax-highlighted on both sides,
//! with the words that changed inside a changed line marked, long unchanged stretches folded, and the
//! rows paired for a split view. Plain data, tested without a window.

use std::collections::HashSet;
use std::ops::Range;

use similar::{ChangeTag, DiffOp, TextDiff};

use super::lines::{self, Kind, Line, Options};
use super::{Syntax, highlight_syntax};

/// A row of a unified diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    Line(Line),
    /// Unchanged lines that are not shown: press to show them. `id` names the fold across rebuilds.
    Fold {
        id: u32,
        hidden: u32,
    },
    /// `@@ -12,9 +12,12 @@ fn name` of a patch.
    Hunk(String),
}

/// A diff as unified rows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Unified {
    pub rows: Vec<Row>,
    /// The row where each group of changes starts (what the next-change keys move to).
    pub changes: Vec<usize>,
    pub added: u32,
    pub removed: u32,
}

/// A row of a split diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pair {
    Lines(Option<Line>, Option<Line>),
    Fold { id: u32, hidden: u32 },
    Hunk(String),
}

#[derive(Clone, Copy, Debug)]
pub struct DiffOptions {
    pub lines: Options,
    /// Unchanged lines kept around a change.
    pub context: usize,
}

impl Default for DiffOptions {
    fn default() -> Self {
        DiffOptions {
            lines: Options::default(),
            context: 3,
        }
    }
}

/// The diff of two texts. `expanded` holds the ids of folds the person opened.
pub fn between(
    old: &str,
    new: &str,
    syntax: &Syntax,
    options: DiffOptions,
    expanded: &HashSet<u32>,
) -> Unified {
    let old_lines = lines::lines(old, &highlight_syntax(syntax, old), 1, options.lines);
    let new_lines = lines::lines(new, &highlight_syntax(syntax, new), 1, options.lines);
    let diff = TextDiff::from_lines(old, new);
    let mut all: Vec<Row> = Vec::new();
    for op in diff.ops() {
        push_op(&mut all, *op, &old_lines, &new_lines);
    }
    finish(all, options.context, expanded)
}

/// A line of the old or the new side with its diff kind and numbers.
fn tagged(line: &Line, kind: Kind, old: Option<usize>, new: Option<usize>) -> Line {
    Line {
        kind,
        old: old.map(|n| n as u32 + 1),
        new: new.map(|n| n as u32 + 1),
        ..line.clone()
    }
}

fn push_op(out: &mut Vec<Row>, op: DiffOp, old: &[Line], new: &[Line]) {
    match op {
        DiffOp::Equal {
            old_index,
            new_index,
            len,
        } => {
            for i in 0..len {
                if let Some(line) = new.get(new_index + i) {
                    out.push(Row::Line(tagged(
                        line,
                        Kind::Context,
                        Some(old_index + i),
                        Some(new_index + i),
                    )));
                }
            }
        }
        DiffOp::Delete {
            old_index, old_len, ..
        } => {
            for i in 0..old_len {
                if let Some(line) = old.get(old_index + i) {
                    out.push(Row::Line(tagged(
                        line,
                        Kind::Remove,
                        Some(old_index + i),
                        None,
                    )));
                }
            }
        }
        DiffOp::Insert {
            new_index, new_len, ..
        } => {
            for i in 0..new_len {
                if let Some(line) = new.get(new_index + i) {
                    out.push(Row::Line(tagged(
                        line,
                        Kind::Add,
                        None,
                        Some(new_index + i),
                    )));
                }
            }
        }
        DiffOp::Replace {
            old_index,
            old_len,
            new_index,
            new_len,
        } => {
            let mut removed: Vec<Line> = (0..old_len)
                .filter_map(|i| {
                    old.get(old_index + i)
                        .map(|l| tagged(l, Kind::Remove, Some(old_index + i), None))
                })
                .collect();
            let mut added: Vec<Line> = (0..new_len)
                .filter_map(|i| {
                    new.get(new_index + i)
                        .map(|l| tagged(l, Kind::Add, None, Some(new_index + i)))
                })
                .collect();
            // Lines of one side pair with the other index by index; the words that differ get a stronger tint.
            for i in 0..removed.len().min(added.len()) {
                let (a, b) = word_changes(&removed[i].text, &added[i].text);
                lines::emphasise(&mut removed[i], &a);
                lines::emphasise(&mut added[i], &b);
            }
            out.extend(removed.into_iter().map(Row::Line));
            out.extend(added.into_iter().map(Row::Line));
        }
    }
}

/// The byte ranges that differ between two lines, in each: none when the lines share too little
/// for a highlight to say anything.
pub fn word_changes(a: &str, b: &str) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
    let diff = TextDiff::configure().diff_unicode_words(a, b);
    let (mut left, mut right) = (Vec::new(), Vec::new());
    let (mut ai, mut bi) = (0usize, 0usize);
    for change in diff.iter_all_changes() {
        let len = change.value().len();
        match change.tag() {
            ChangeTag::Equal => {
                ai += len;
                bi += len;
            }
            ChangeTag::Delete => {
                if !change.value().trim().is_empty() {
                    left.push(ai..ai + len);
                }
                ai += len;
            }
            ChangeTag::Insert => {
                if !change.value().trim().is_empty() {
                    right.push(bi..bi + len);
                }
                bi += len;
            }
        }
    }
    let share = |ranges: &[Range<usize>], total: usize| {
        ranges.iter().map(|r| r.len()).sum::<usize>() * 100 >= total.max(1) * 70
    };
    if share(&left, a.len()) || share(&right, b.len()) {
        return (Vec::new(), Vec::new());
    }
    (merge(left), merge(right))
}

/// Ranges that touch or are one blank apart are one.
fn merge(ranges: Vec<Range<usize>>) -> Vec<Range<usize>> {
    let mut out: Vec<Range<usize>> = Vec::new();
    for r in ranges {
        match out.last_mut() {
            Some(last) if r.start <= last.end + 1 => last.end = r.end.max(last.end),
            _ => out.push(r),
        }
    }
    out
}

/// Folds long unchanged stretches, counts, and notes where the changes start.
fn finish(all: Vec<Row>, context: usize, expanded: &HashSet<u32>) -> Unified {
    let mut out = Unified::default();
    for row in &all {
        if let Row::Line(l) = row {
            match l.kind {
                Kind::Add => out.added += 1,
                Kind::Remove => out.removed += 1,
                Kind::Context => {}
            }
        }
    }
    let is_context = |row: &Row| matches!(row, Row::Line(l) if l.kind == Kind::Context);
    let mut i = 0;
    let mut in_change = false;
    while i < all.len() {
        if is_context(&all[i]) {
            let start = i;
            while i < all.len() && is_context(&all[i]) {
                i += 1;
            }
            let run = i - start;
            let first = start == 0;
            let last = i == all.len();
            let keep_head = if first { 0 } else { context };
            let keep_tail = if last { 0 } else { context };
            let id = start as u32;
            if run > keep_head + keep_tail + 1 && !expanded.contains(&id) && !(first && last) {
                out.rows
                    .extend(all[start..start + keep_head].iter().cloned());
                out.rows.push(Row::Fold {
                    id,
                    hidden: (run - keep_head - keep_tail) as u32,
                });
                out.rows.extend(all[i - keep_tail..i].iter().cloned());
            } else {
                out.rows.extend(all[start..i].iter().cloned());
            }
            in_change = false;
        } else {
            if !in_change {
                out.changes.push(out.rows.len());
                in_change = true;
            }
            out.rows.push(all[i].clone());
            i += 1;
        }
    }
    out
}

/// A unified patch (`git diff`, one file or several) as rows, with the syntax each file's name gives.
pub fn patch(text: &str, options: DiffOptions) -> Vec<(String, Unified)> {
    let mut files: Vec<(String, Vec<PatchLine>)> = Vec::new();
    let mut current: Option<(String, Vec<PatchLine>)> = None;
    let mut old_name = String::new();
    let (mut old_no, mut new_no) = (0u32, 0u32);
    let all: Vec<&str> = text.lines().collect();
    for (at, raw) in all.iter().copied().enumerate() {
        // `--- ` and `+++ ` open a file only before its first hunk (or when `@@` follows the pair, a patch without
        // `diff --git` lines): inside a hunk `--- x` is the removed line `-- x`, `+++ x` the added line `++ x`.
        let before_hunk = current.as_ref().is_none_or(|f| f.1.is_empty());
        let pair = |first: &str, second: &str| {
            raw.starts_with(first)
                && all.get(at + 1).is_some_and(|l| l.starts_with(second))
                && all.get(at + 2).is_some_and(|l| l.starts_with("@@"))
        };
        let old_header = raw.starts_with("--- ") && (before_hunk || pair("--- ", "+++ "));
        let new_header = raw.starts_with("+++ ")
            && (before_hunk
                || (at > 0
                    && all[at - 1].starts_with("--- ")
                    && all.get(at + 1).is_some_and(|l| l.starts_with("@@"))));
        if let Some(rest) = raw.strip_prefix("diff --git ") {
            if let Some(file) = current.take() {
                files.push(file);
            }
            let name = rest.rsplit(" b/").next().unwrap_or(rest).to_string();
            current = Some((name, Vec::new()));
        } else if old_header {
            if !before_hunk && let Some(file) = current.take() {
                files.push(file);
            }
            old_name = raw["--- ".len()..].trim_start_matches("a/").to_string();
            if current.is_none() {
                current = Some((String::new(), Vec::new()));
            }
        } else if new_header {
            let rest = &raw["+++ ".len()..];
            if let Some(file) = current.as_mut() {
                if file.0.is_empty() || file.0 == "/dev/null" {
                    file.0 = rest.trim_start_matches("b/").to_string();
                }
                if file.0 == "dev/null" || rest == "/dev/null" {
                    file.0 = old_name.clone();
                }
            }
        } else if raw.starts_with("@@") {
            let (o, n) = hunk_starts(raw);
            old_no = o;
            new_no = n;
            if let Some(file) = current.as_mut() {
                file.1.push(PatchLine::Hunk(raw.to_string()));
            }
        } else if let Some(file) = current.as_mut() {
            if file.1.is_empty() {
                continue; // `index`, `new file mode` and the like before the first hunk
            }
            let body = &raw[raw.char_indices().nth(1).map_or(raw.len(), |(i, _)| i)..];
            match raw.as_bytes().first() {
                Some(b'+') => {
                    file.1.push(PatchLine::Code(
                        Kind::Add,
                        None,
                        Some(new_no),
                        body.to_string(),
                    ));
                    new_no += 1;
                }
                Some(b'-') => {
                    file.1.push(PatchLine::Code(
                        Kind::Remove,
                        Some(old_no),
                        None,
                        body.to_string(),
                    ));
                    old_no += 1;
                }
                Some(b' ') | None => {
                    file.1.push(PatchLine::Code(
                        Kind::Context,
                        Some(old_no),
                        Some(new_no),
                        body.to_string(),
                    ));
                    old_no += 1;
                    new_no += 1;
                }
                _ => {} // `\ No newline at end of file`
            }
        }
    }
    if let Some(file) = current.take() {
        files.push(file);
    }
    files
        .into_iter()
        .map(|(name, rows)| {
            let syntax = Syntax::resolve(None, Some(&name), "");
            let unified = patch_rows(rows, &syntax, options);
            (name, unified)
        })
        .collect()
}

enum PatchLine {
    Hunk(String),
    Code(Kind, Option<u32>, Option<u32>, String),
}

fn hunk_starts(header: &str) -> (u32, u32) {
    let nums: Vec<u32> = header
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    (
        nums.first().copied().unwrap_or(1),
        nums.get(2).copied().unwrap_or(1),
    )
}

/// Highlights a patch's two sides as the pseudo-files they make and returns its rows.
fn patch_rows(rows: Vec<PatchLine>, syntax: &Syntax, options: DiffOptions) -> Unified {
    let (mut old_text, mut new_text) = (String::new(), String::new());
    for row in &rows {
        if let PatchLine::Code(kind, _, _, body) = row {
            if *kind != Kind::Add {
                old_text.push_str(body);
                old_text.push('\n');
            }
            if *kind != Kind::Remove {
                new_text.push_str(body);
                new_text.push('\n');
            }
        }
    }
    let old_lines = lines::lines(
        &old_text,
        &highlight_syntax(syntax, &old_text),
        1,
        options.lines,
    );
    let new_lines = lines::lines(
        &new_text,
        &highlight_syntax(syntax, &new_text),
        1,
        options.lines,
    );
    let (mut oi, mut ni) = (0usize, 0usize);
    let mut out = Unified::default();
    let mut in_change = false;
    for row in rows {
        match row {
            PatchLine::Hunk(h) => {
                out.rows.push(Row::Hunk(h));
                in_change = false;
            }
            PatchLine::Code(kind, old_no, new_no, _) => {
                let line = match kind {
                    Kind::Add => {
                        let l = new_lines.get(ni).cloned();
                        ni += 1;
                        l
                    }
                    Kind::Remove => {
                        let l = old_lines.get(oi).cloned();
                        oi += 1;
                        l
                    }
                    Kind::Context => {
                        let l = new_lines.get(ni).cloned();
                        oi += 1;
                        ni += 1;
                        l
                    }
                };
                let Some(mut line) = line else { continue };
                line.kind = kind;
                line.old = old_no;
                line.new = new_no;
                if kind == Kind::Context {
                    in_change = false;
                } else {
                    if !in_change {
                        out.changes.push(out.rows.len());
                        in_change = true;
                    }
                    if kind == Kind::Add {
                        out.added += 1;
                    } else {
                        out.removed += 1;
                    }
                }
                out.rows.push(Row::Line(line));
            }
        }
    }
    pair_words(&mut out.rows);
    out
}

/// Marks changed words in every run of removed lines followed by added lines, pairing index by index.
pub fn pair_words(rows: &mut [Row]) {
    let mut i = 0;
    while i < rows.len() {
        let kind = |r: &Row| {
            if let Row::Line(l) = r {
                Some(l.kind)
            } else {
                None
            }
        };
        if kind(&rows[i]) == Some(Kind::Remove) {
            let start = i;
            while i < rows.len() && kind(&rows[i]) == Some(Kind::Remove) {
                i += 1;
            }
            let mid = i;
            while i < rows.len() && kind(&rows[i]) == Some(Kind::Add) {
                i += 1;
            }
            let (removed, added) = (mid - start, i - mid);
            for k in 0..removed.min(added) {
                let (Row::Line(a), Row::Line(b)) = (rows[start + k].clone(), rows[mid + k].clone())
                else {
                    continue;
                };
                let (ra, rb) = word_changes(&a.text, &b.text);
                if let Row::Line(l) = &mut rows[start + k] {
                    lines::emphasise(l, &ra);
                }
                if let Row::Line(l) = &mut rows[mid + k] {
                    lines::emphasise(l, &rb);
                }
            }
        } else {
            i += 1;
        }
    }
}

/// The rows of a split view: removed and added lines of a change side by side, index by index.
pub fn split(rows: &[Row]) -> Vec<Pair> {
    let mut out = Vec::with_capacity(rows.len());
    let mut i = 0;
    while i < rows.len() {
        match &rows[i] {
            Row::Fold { id, hidden } => {
                out.push(Pair::Fold {
                    id: *id,
                    hidden: *hidden,
                });
                i += 1;
            }
            Row::Hunk(h) => {
                out.push(Pair::Hunk(h.clone()));
                i += 1;
            }
            Row::Line(l) if l.kind == Kind::Context => {
                out.push(Pair::Lines(Some(l.clone()), Some(l.clone())));
                i += 1;
            }
            Row::Line(_) => {
                let mut removed: Vec<Line> = Vec::new();
                let mut added: Vec<Line> = Vec::new();
                while let Some(Row::Line(l)) = rows.get(i) {
                    match l.kind {
                        Kind::Remove if added.is_empty() => removed.push(l.clone()),
                        Kind::Add => added.push(l.clone()),
                        _ => break,
                    }
                    i += 1;
                }
                for k in 0..removed.len().max(added.len()) {
                    out.push(Pair::Lines(removed.get(k).cloned(), added.get(k).cloned()));
                }
            }
        }
    }
    out
}
