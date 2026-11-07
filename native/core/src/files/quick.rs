//! Quick open: the files of a project root, found by a few typed letters.
//!
//! [`Quick`] keeps one in-memory index per (machine, root): the paths a walk found (`Files::tree`), folded once, so a
//! keystroke folds only the query. The first ask of a root waits for its walk; later asks answer at once from the
//! index, and the first ask after [`REFRESH_AFTER`] answers from the old index while a worker thread walks again.
//! Ranking is `crate::search`: every word of the query must match (AND), a word that matches the file's name beats one
//! that only matches a folder, shorter paths win ties, and the marks to underline cover the whole relative path in
//! UTF-16 units (what a JavaScript string indexes by).
//!
//! Files that git ignores are not in the index. A query of three letters or more also searches a second, bounded walk
//! with the ignore rules off (`Files::tree_ignored`, this computer only: another machine's answer is its `git
//! ls-files`), and those hits come after every other match, flagged `ignored`.

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

mod mention;

use super::{FileError, Files, TreeEntry, TreeLimits};
use crate::search::{Haystack, Needle, Scorer, runs};

/// How long an index is trusted before the next ask walks again (and answers from the old one meanwhile).
pub const REFRESH_AFTER: Duration = Duration::from_secs(60);

/// The shortest query, in letters, that also searches the files git ignores.
pub const IGNORED_FROM: usize = 3;

/// The roots kept in memory at once: the least recently asked is dropped for the next.
const ROOTS_KEPT: usize = 8;

/// Added to a word that matches the file's name: bigger than any score of a match inside a path.
const NAME_TIER: u32 = 1 << 20;

pub use mention::{Hot, HotPaths, MentionHit, Mentions};

/// One file found by a query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickHit {
    /// Relative to the root, `/` separated.
    pub path: String,
    /// The file's name.
    pub name: String,
    /// The folder part of `path`; empty for a file at the root.
    pub dir: String,
    /// The matched characters of `path` as flat pairs `[start0, end0, start1, end1, ...]` in UTF-16 units, sorted,
    /// adjacent matches merged. Empty for an empty query.
    pub marks: Vec<u32>,
    /// Found only by the second, ignored-files walk: git ignores the file.
    pub ignored: bool,
}

/// What a query found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickSearch {
    /// The best matches first, at most the limit asked: files git does not ignore, then ignored ones.
    pub hits: Vec<QuickHit>,
    /// Every match, whatever the limit.
    pub total: usize,
    /// The paths in the index of the root.
    pub indexed: usize,
    /// The walk that made the index stopped at a limit: some files are not in it.
    pub truncated: bool,
    /// Microseconds the ranking took (not the walk).
    pub took_us: u64,
}

/// A path folded for matching, with the folded file name beside it so a word is tried on the name first.
struct Row {
    path: String,
    /// Byte index in `path` where the file name starts.
    name_at: usize,
    modified: i64,
    path_hay: Haystack,
    name_hay: Haystack,
}

impl Row {
    fn new(entry: TreeEntry) -> Self {
        let name_at = entry.path.rfind('/').map_or(0, |i| i + 1);
        Self {
            path_hay: Haystack::new(&entry.path),
            name_hay: Haystack::new(&entry.path[name_at..]),
            path: entry.path,
            name_at,
            modified: entry.modified,
        }
    }
}

/// The words of a query, folded.
struct Words {
    needles: Vec<Needle>,
    /// A word with a `/` in it can only match across folders, never the name.
    slashed: Vec<bool>,
}

impl Words {
    fn new(query: &str) -> Self {
        let needles: Vec<Needle> = query
            .split_whitespace()
            .map(Needle::new)
            .filter(|n| !n.is_empty())
            .collect();
        let slashed = needles.iter().map(|n| n.text().contains('/')).collect();
        Self { needles, slashed }
    }

    fn letters(&self) -> usize {
        self.needles.iter().map(Needle::len).sum()
    }

    /// The score of `row` when every word matches it.
    fn score(&self, scorer: &mut Scorer, row: &Row) -> Option<u32> {
        let mut total = 0u32;
        for (word, &slashed) in self.needles.iter().zip(&self.slashed) {
            let by_name = if slashed {
                None
            } else {
                scorer.fuzzy(&row.name_hay, word)
            };
            total = total.saturating_add(match by_name {
                Some(score) => NAME_TIER + score,
                None => scorer.fuzzy(&row.path_hay, word)?,
            });
        }
        Some(total)
    }

    /// The flat UTF-16 mark pairs of `row`, from the same choice of name or path that `score` made.
    fn marks(&self, scorer: &mut Scorer, row: &Row) -> Vec<u32> {
        let name_offset = row.path[..row.name_at].chars().count() as u32;
        let mut chars: Vec<u32> = Vec::new();
        let mut in_name: Vec<u32> = Vec::new();
        for (word, &slashed) in self.needles.iter().zip(&self.slashed) {
            in_name.clear();
            if !slashed
                && scorer
                    .fuzzy_marks(&row.name_hay, word, &mut in_name)
                    .is_some()
            {
                chars.extend(in_name.iter().map(|c| c + name_offset));
            } else {
                scorer.fuzzy_marks(&row.path_hay, word, &mut chars);
            }
        }
        chars.sort_unstable();
        chars.dedup();
        utf16_pairs(&row.path, &chars)
    }
}

/// `chars` (sorted, unique character indices of `path`) as flat `[start, end, ...]` runs in UTF-16 units.
fn utf16_pairs(path: &str, chars: &[u32]) -> Vec<u32> {
    if chars.is_empty() {
        return Vec::new();
    }
    let mut offsets: Vec<u32> = Vec::with_capacity(path.len() + 1);
    let mut at = 0u32;
    for c in path.chars() {
        offsets.push(at);
        at += c.len_utf16() as u32;
    }
    offsets.push(at);
    let mut out = Vec::new();
    for (start, end) in runs(chars) {
        let (Some(&s), Some(&e)) = (offsets.get(start as usize), offsets.get(end as usize)) else {
            continue;
        };
        out.extend([s, e]);
    }
    out
}

/// The paths of one root, ready to match.
struct Index {
    rows: Vec<Row>,
    truncated: bool,
    built: Instant,
    /// The second walk: made by the first query long enough to want it, kept with the index.
    ignored: OnceLock<Vec<Row>>,
    /// The folders above the files, made by the first `@` that wants them (`mention.rs`).
    dirs: OnceLock<Vec<Row>>,
}

impl Index {
    fn build(files: &dyn Files, root: &str, limits: &TreeLimits) -> Result<Self, FileError> {
        let tree = files.tree(root, limits)?;
        Ok(Self {
            rows: tree.entries.into_iter().map(Row::new).collect(),
            truncated: tree.truncated,
            built: Instant::now(),
            ignored: OnceLock::new(),
            dirs: OnceLock::new(),
        })
    }

    fn ignored_rows(&self, files: &dyn Files, root: &str) -> &[Row] {
        self.ignored.get_or_init(|| {
            let Ok(tree) = files.tree_ignored(root, &TreeLimits::IGNORED) else {
                return Vec::new();
            };
            let known: HashSet<&str> = self.rows.iter().map(|r| r.path.as_str()).collect();
            tree.entries
                .into_iter()
                .filter(|e| !known.contains(e.path.as_str()))
                .map(Row::new)
                .collect()
        })
    }
}

/// Matches of one group of rows: the best `limit` of them in order, and how many matched in all.
fn best(
    rows: &[Row],
    words: &Words,
    scorer: &mut Scorer,
    limit: usize,
) -> (Vec<(u64, usize)>, usize) {
    let mut ranked: Vec<(u64, usize)> = if words.needles.is_empty() {
        // Nothing typed: the files changed last come first.
        rows.iter()
            .enumerate()
            .map(|(i, r)| (r.modified.max(0) as u64, i))
            .collect()
    } else {
        rows.iter()
            .enumerate()
            .filter_map(|(i, r)| Some((u64::from(words.score(scorer, r)?), i)))
            .collect()
    };
    let total = ranked.len();
    let order = |a: &(u64, usize), b: &(u64, usize)| {
        b.0.cmp(&a.0)
            .then_with(|| rows[a.1].path.len().cmp(&rows[b.1].path.len()))
            .then_with(|| rows[a.1].path.cmp(&rows[b.1].path))
    };
    if ranked.len() > limit {
        ranked.select_nth_unstable_by(limit, order);
        ranked.truncate(limit);
    }
    ranked.sort_unstable_by(order);
    (ranked, total)
}

fn hit(row: &Row, marks: Vec<u32>, ignored: bool) -> QuickHit {
    QuickHit {
        path: row.path.clone(),
        name: row.path[row.name_at..].to_owned(),
        dir: row.path[..row.name_at.saturating_sub(1)].to_owned(),
        marks,
        ignored,
    }
}

fn search_index(
    index: &Index,
    files: &dyn Files,
    root: &str,
    query: &str,
    limit: usize,
) -> QuickSearch {
    let started = Instant::now();
    let words = Words::new(query);
    let mut scorer = Scorer::new(true);
    let (ranked, mut total) = best(&index.rows, &words, &mut scorer, limit);
    let mut hits: Vec<QuickHit> = ranked
        .iter()
        .map(|&(_, i)| {
            let row = &index.rows[i];
            hit(row, words.marks(&mut scorer, row), false)
        })
        .collect();
    if words.letters() >= IGNORED_FROM && hits.len() < limit {
        let rows = index.ignored_rows(files, root);
        let (ranked, more) = best(rows, &words, &mut scorer, limit - hits.len());
        total += more;
        hits.extend(ranked.iter().map(|&(_, i)| {
            let row = &rows[i];
            hit(row, words.marks(&mut scorer, row), true)
        }));
    } else if words.letters() >= IGNORED_FROM {
        total += best(index.ignored_rows(files, root), &words, &mut scorer, 0).1;
    }
    QuickSearch {
        hits,
        total,
        indexed: index.rows.len(),
        truncated: index.truncated,
        took_us: started.elapsed().as_micros() as u64,
    }
}

#[derive(Default)]
struct State {
    index: Option<Arc<Index>>,
    building: bool,
}

/// One root's index and whether a thread is making it.
#[derive(Default)]
struct Slot {
    state: Mutex<State>,
    ready: Condvar,
}

/// Marks a walk as running; whoever drops it (done, failed or panicked) lets the waiting asks go on.
struct Building<'a>(&'a Slot);

impl Building<'_> {
    fn finish(self, index: Option<Arc<Index>>) {
        if let Some(index) = index {
            self.0.state.lock().index = Some(index);
        }
    }
}

impl Drop for Building<'_> {
    fn drop(&mut self) {
        self.0.state.lock().building = false;
        self.0.ready.notify_all();
    }
}

/// The quick-open indexes of every root asked, shared by all callers (the app keeps one for the process).
pub struct Quick {
    roots: Mutex<Vec<(String, String, Arc<Slot>)>>,
    refresh_after: Duration,
    limits: TreeLimits,
}

impl Default for Quick {
    fn default() -> Self {
        Self::new()
    }
}

impl Quick {
    /// An empty set of indexes: walks limited as the contract says, refreshed after [`REFRESH_AFTER`].
    pub fn new() -> Self {
        Self {
            roots: Mutex::new(Vec::new()),
            refresh_after: REFRESH_AFTER,
            limits: TreeLimits::INDEX,
        }
    }

    /// As [`Quick::new`] with other walk limits (tests make a walk stop at a few paths).
    pub fn with_limits(mut self, limits: TreeLimits) -> Self {
        self.limits = limits;
        self
    }

    /// As [`Quick::new`] with another time after which an ask refreshes the index.
    pub fn with_refresh_after(mut self, after: Duration) -> Self {
        self.refresh_after = after;
        self
    }

    /// Builds or refreshes the index of `root` on `machine` and returns how many paths it holds. Blocks for the first
    /// walk of a root; call it off the UI thread.
    pub fn warm(
        &self,
        machine: &str,
        files: &Arc<dyn Files>,
        root: &str,
    ) -> Result<usize, FileError> {
        Ok(self.index(machine, files, root)?.rows.len())
    }

    /// The best `limit` files of `root` for `query` (words separated by spaces, each of which must match): the files
    /// changed last, for an empty query. The first ask of a root waits for its walk; call it off the UI thread.
    pub fn search(
        &self,
        machine: &str,
        files: &Arc<dyn Files>,
        root: &str,
        query: &str,
        limit: usize,
    ) -> Result<QuickSearch, FileError> {
        let index = self.index(machine, files, root)?;
        Ok(search_index(&index, files.as_ref(), root, query, limit))
    }

    fn slot(&self, machine: &str, root: &str) -> Arc<Slot> {
        let mut roots = self.roots.lock();
        if let Some(at) = roots.iter().position(|(m, r, _)| m == machine && r == root) {
            let item = roots.remove(at);
            let slot = item.2.clone();
            roots.insert(0, item);
            return slot;
        }
        let slot = Arc::new(Slot::default());
        roots.insert(0, (machine.to_owned(), root.to_owned(), slot.clone()));
        roots.truncate(ROOTS_KEPT);
        slot
    }

    /// The index of a root: the one in memory (starting a refresh behind it when old), else a new walk, which asks
    /// for the same root wait for rather than repeat.
    fn index(
        &self,
        machine: &str,
        files: &Arc<dyn Files>,
        root: &str,
    ) -> Result<Arc<Index>, FileError> {
        let slot = self.slot(machine, root);
        let mut state = slot.state.lock();
        loop {
            if let Some(index) = state.index.clone() {
                if index.built.elapsed() >= self.refresh_after && !state.building {
                    state.building = true;
                    drop(state);
                    self.refresh(slot, files.clone(), root.to_owned());
                }
                return Ok(index);
            }
            if !state.building {
                state.building = true;
                break;
            }
            slot.ready.wait(&mut state);
        }
        drop(state);
        let building = Building(&slot);
        let built = Index::build(files.as_ref(), root, &self.limits).map(Arc::new)?;
        building.finish(Some(built.clone()));
        Ok(built)
    }

    /// Walks `root` again on a thread of its own; the old index keeps answering until the new one is in.
    fn refresh(&self, slot: Arc<Slot>, files: Arc<dyn Files>, root: String) {
        let limits = self.limits;
        let worker = slot.clone();
        let spawned = std::thread::Builder::new()
            .name("herdr-quick-refresh".to_owned())
            .spawn(move || {
                let building = Building(&worker);
                if let Ok(index) = Index::build(files.as_ref(), &root, &limits) {
                    building.finish(Some(Arc::new(index)));
                }
            });
        if spawned.is_err() {
            drop(Building(&slot));
        }
    }
}
