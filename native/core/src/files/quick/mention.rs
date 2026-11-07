//! What a `@` in a message can mean: the files AND folders of the project, best first, with what the person is
//! working on lifted.
//!
//! It answers from the index quick open keeps (`Index`), so a keystroke folds only the query. Differences from
//! `Quick::search`, each for the message box:
//!
//! - folders are candidates (an agent is as often pointed at `src/auth/` as at a file); they are derived from the
//!   file paths once per index, never walked again;
//! - the files the person is working on come first: `HotPaths` (what they opened or mentioned last, then what git says
//!   changed) adds a bonus smaller than the gap between a good and a poor match, so a hot file wins a near tie and
//!   never a bad match;
//! - an empty query lists the hot paths, then the top-level folders, then the files changed last, so a bare `@` is a
//!   map of where the work is;
//! - a query that matches almost nothing is tried again with one typo allowed in the file name (`mian.rs`);
//! - files git ignores are never listed: an `.env` is not something to offer to a prompt.

use std::collections::HashMap;

use super::*;
use crate::search::within_one;

/// Added to a match for a path the person opened or mentioned recently: most recent first. A whole-name match scores
/// 100 to 160 and a scattered one 30 to 50 less (measured with `nucleo`), so these lift a tie and nothing more.
const RECENT_BONUS: u32 = 24;
const RECENT_STEP: u32 = 2;
const RECENT_FLOOR: u32 = 8;
/// Added to a match for a path git says changed.
const CHANGED_BONUS: u32 = 12;

/// A query with fewer matches than this is asked again with a typo allowed.
const TYPO_BELOW: usize = 3;
/// The shortest word that is tried with a typo: on a short word one edit is another word.
const TYPO_FROM: usize = 4;

/// Why a path is lifted above the rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hot {
    /// The person opened or mentioned it lately.
    Recent,
    /// Git says it changed.
    Changed,
}

/// The paths the person is working on, relative to the root, `/` separated; a folder has no trailing slash. The
/// order of `recent` is the order of their last use, newest first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HotPaths {
    pub recent: Vec<String>,
    pub changed: Vec<String>,
}

impl HotPaths {
    fn bonus_of(&self) -> HashMap<&str, (u32, Hot)> {
        let mut map = HashMap::with_capacity(self.recent.len() + self.changed.len());
        for (i, p) in self.changed.iter().enumerate() {
            let _ = i;
            map.insert(p.trim_end_matches('/'), (CHANGED_BONUS, Hot::Changed));
        }
        for (i, p) in self.recent.iter().enumerate() {
            let bonus = RECENT_BONUS
                .saturating_sub(RECENT_STEP * i as u32)
                .max(RECENT_FLOOR);
            map.insert(p.trim_end_matches('/'), (bonus, Hot::Recent));
        }
        map
    }
}

/// One file or folder a `@` can name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MentionHit {
    /// Relative to the root, `/` separated.
    pub path: String,
    /// The last part of `path`.
    pub name: String,
    /// The folder part of `path`; empty at the root.
    pub dir: String,
    /// A folder.
    pub folder: bool,
    /// The matched characters of `path` as flat UTF-16 pairs (see `QuickHit::marks`); empty for an empty query and
    /// for a match that needed a typo.
    pub marks: Vec<u32>,
    /// Why it is lifted, when it is.
    pub hot: Option<Hot>,
    /// Found by allowing a typo in the name.
    pub typo: bool,
}

/// What a query found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mentions {
    pub hits: Vec<MentionHit>,
    /// Every match, whatever the limit.
    pub total: usize,
    /// The paths (files and folders) in the index.
    pub indexed: usize,
    pub truncated: bool,
    /// Microseconds the ranking took (not the walk).
    pub took_us: u64,
}

/// The folders above the files of `index`, as rows: each once, dated by its newest file.
fn folder_rows(index: &Index) -> Vec<Row> {
    let mut newest: HashMap<&str, i64> = HashMap::new();
    for row in &index.rows {
        let mut path = row.path.as_str();
        while let Some(at) = path.rfind('/') {
            path = &path[..at];
            let slot = newest.entry(path).or_insert(row.modified);
            *slot = (*slot).max(row.modified);
        }
    }
    let mut all: Vec<(&str, i64)> = newest.into_iter().collect();
    all.sort_unstable_by(|a, b| a.0.cmp(b.0));
    all.into_iter()
        .map(|(path, modified)| {
            Row::new(TreeEntry {
                path: path.to_owned(),
                modified,
            })
        })
        .collect()
}

fn hit_of(row: &Row, folder: bool, marks: Vec<u32>, hot: Option<Hot>, typo: bool) -> MentionHit {
    MentionHit {
        path: row.path.clone(),
        name: row.path[row.name_at..].to_owned(),
        dir: row.path[..row.name_at.saturating_sub(1)].to_owned(),
        folder,
        marks,
        hot,
        typo,
    }
}

impl Index {
    fn folders(&self) -> &[Row] {
        self.dirs.get_or_init(|| folder_rows(self))
    }
}

/// A row and whether it is a folder, in one list so ranking runs once.
struct Candidate<'a> {
    row: &'a Row,
    folder: bool,
}

fn mentions_in(index: &Index, query: &str, limit: usize, hot: &HotPaths) -> Mentions {
    let started = Instant::now();
    let words = Words::new(query);
    let bonus = hot.bonus_of();
    let folders = index.folders();
    let all: Vec<Candidate<'_>> = index
        .rows
        .iter()
        .map(|row| Candidate { row, folder: false })
        .chain(folders.iter().map(|row| Candidate { row, folder: true }))
        .collect();
    let mut scorer = Scorer::new(true);

    let mut ranked: Vec<(u64, usize)> = if words.needles.is_empty() {
        all.iter()
            .enumerate()
            .filter_map(|(i, c)| empty_rank(c, &bonus, &hot.recent).map(|rank| (rank, i)))
            .collect()
    } else {
        all.iter()
            .enumerate()
            .filter_map(|(i, c)| {
                let score = words.score(&mut scorer, c.row)?;
                let lift = bonus.get(c.row.path.as_str()).map_or(0, |b| b.0);
                Some((u64::from(score) + u64::from(lift), i))
            })
            .collect()
    };
    let mut total = ranked.len();
    let order = |a: &(u64, usize), b: &(u64, usize)| {
        b.0.cmp(&a.0)
            .then_with(|| all[a.1].row.path.len().cmp(&all[b.1].row.path.len()))
            .then_with(|| all[a.1].row.path.cmp(&all[b.1].row.path))
    };
    if ranked.len() > limit {
        ranked.select_nth_unstable_by(limit, order);
        ranked.truncate(limit);
    }
    ranked.sort_unstable_by(order);

    let mut hits: Vec<MentionHit> = ranked
        .iter()
        .map(|&(_, i)| {
            let c = &all[i];
            let marks = if words.needles.is_empty() {
                Vec::new()
            } else {
                words.marks(&mut scorer, c.row)
            };
            hit_of(
                c.row,
                c.folder,
                marks,
                bonus.get(c.row.path.as_str()).map(|b| b.1),
                false,
            )
        })
        .collect();

    // Almost nothing matched: one letter wrong, missing or swapped in the name is still the file they meant.
    if total < TYPO_BELOW && hits.len() < limit {
        let typos = typo_matches(&all, &words, &hits);
        total += typos.len();
        hits.extend(
            typos
                .into_iter()
                .take(limit - hits.len())
                .map(|i| hit_of(all[i].row, all[i].folder, Vec::new(), None, true)),
        );
    }

    Mentions {
        hits,
        total,
        indexed: all.len(),
        truncated: index.truncated,
        took_us: started.elapsed().as_micros() as u64,
    }
}

/// The rank of a candidate when nothing is typed: the hot paths first (recent in order, then changed), then the
/// top-level folders, then the files changed last. Folders below the top are not listed: they are one keystroke away.
fn empty_rank(
    c: &Candidate<'_>,
    bonus: &HashMap<&str, (u32, Hot)>,
    recent: &[String],
) -> Option<u64> {
    const TIER: u64 = 1 << 40;
    if let Some((lift, hot)) = bonus.get(c.row.path.as_str()) {
        return Some(match hot {
            Hot::Recent => 4 * TIER + u64::from(*lift) * 1024 + c.row.modified.max(0) as u64 % 1024,
            Hot::Changed => 3 * TIER + c.row.modified.max(0) as u64,
        });
    }
    let _ = recent;
    if c.folder {
        // Only the top level, newest first.
        return (!c.row.path.contains('/')).then_some(2 * TIER + c.row.modified.max(0) as u64);
    }
    Some(TIER + c.row.modified.max(0) as u64)
}

/// The indexes of candidates one typo away from the (single) typed word, best name first; none for a query of several
/// words or short ones, and none already in `found`.
fn typo_matches(all: &[Candidate<'_>], words: &Words, found: &[MentionHit]) -> Vec<usize> {
    let [word] = words.needles.as_slice() else {
        return Vec::new();
    };
    if word.len() < TYPO_FROM || words.slashed[0] {
        return Vec::new();
    }
    let needle: Vec<char> = word.text().chars().collect();
    let mut out: Vec<usize> = Vec::new();
    for (i, c) in all.iter().enumerate() {
        if found.iter().any(|h| h.path == c.row.path) {
            continue;
        }
        let name: Vec<char> = c.row.name_hay.text().chars().collect();
        let stem: &[char] = match name.iter().rposition(|ch| *ch == '.') {
            Some(dot) if dot > 0 => &name[..dot],
            _ => &name,
        };
        if within_one(&needle, &name) || within_one(&needle, stem) {
            out.push(i);
        }
    }
    out.sort_by(|a, b| {
        all[*a]
            .row
            .path
            .len()
            .cmp(&all[*b].row.path.len())
            .then_with(|| all[*a].row.path.cmp(&all[*b].row.path))
    });
    out
}

impl Quick {
    /// The best `limit` files and folders of `root` for what follows a `@` (see the module). The first ask of a root
    /// waits for its walk; call it off the UI thread.
    ///
    /// # Errors
    /// What the walk of the root says when it fails.
    pub fn mentions(
        &self,
        machine: &str,
        files: &Arc<dyn Files>,
        root: &str,
        query: &str,
        limit: usize,
        hot: &HotPaths,
    ) -> Result<Mentions, FileError> {
        let index = self.index(machine, files, root)?;
        Ok(mentions_in(&index, query, limit, hot))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index_of(paths: &[(&str, i64)]) -> Index {
        Index {
            rows: paths
                .iter()
                .map(|(p, m)| {
                    Row::new(TreeEntry {
                        path: (*p).to_owned(),
                        modified: *m,
                    })
                })
                .collect(),
            truncated: false,
            built: Instant::now(),
            ignored: OnceLock::new(),
            dirs: OnceLock::new(),
        }
    }

    fn project() -> Index {
        index_of(&[
            ("README.md", 10),
            ("Cargo.toml", 20),
            ("src/main.rs", 50),
            ("src/lib.rs", 40),
            ("src/auth/login.rs", 30),
            ("src/auth/token.rs", 31),
            ("components/palette.tsx", 60),
            ("components/session-composer.tsx", 70),
            ("docs/ACP.md", 5),
        ])
    }

    fn paths(m: &Mentions) -> Vec<&str> {
        m.hits.iter().map(|h| h.path.as_str()).collect()
    }

    #[test]
    fn folders_are_candidates_with_the_files_below_them_giving_their_date() {
        let m = mentions_in(&project(), "auth", 10, &HotPaths::default());
        assert_eq!(m.hits[0].path, "src/auth");
        assert!(m.hits[0].folder);
        assert!(paths(&m).contains(&"src/auth/login.rs"));
        let rows = folder_rows(&project());
        let src = rows.iter().find(|r| r.path == "src").expect("src");
        assert_eq!(src.modified, 50, "the newest file below it");
    }

    #[test]
    fn typing_letters_of_the_name_out_of_order_still_finds_the_file_and_marks_them() {
        let m = mentions_in(&project(), "sescomp", 10, &HotPaths::default());
        assert_eq!(m.hits[0].path, "components/session-composer.tsx");
        assert!(!m.hits[0].marks.is_empty());
        let m = mentions_in(&project(), "src/ma", 10, &HotPaths::default());
        assert_eq!(m.hits[0].path, "src/main.rs");
    }

    #[test]
    fn a_hot_file_wins_a_near_tie_and_never_a_poor_match() {
        let idx = index_of(&[
            ("a/render.rs", 1),
            ("b/render.rs", 2),
            ("c/reader-new-doc-extra.rs", 3),
        ]);
        let none = mentions_in(&idx, "render", 5, &HotPaths::default());
        assert_eq!(
            none.hits[0].path, "a/render.rs",
            "equals: shorter path, then name"
        );
        let hot = HotPaths {
            recent: vec!["b/render.rs".into()],
            changed: vec![],
        };
        let lifted = mentions_in(&idx, "render", 5, &hot);
        assert_eq!(lifted.hits[0].path, "b/render.rs");
        assert_eq!(lifted.hits[0].hot, Some(Hot::Recent));
        // A hot file that barely matches stays below the exact name.
        let poor = HotPaths {
            recent: vec!["c/reader-new-doc-extra.rs".into()],
            changed: vec![],
        };
        let m = mentions_in(&idx, "render", 5, &poor);
        assert_ne!(m.hits[0].path, "c/reader-new-doc-extra.rs");
    }

    #[test]
    fn a_bare_at_lists_what_is_hot_then_the_top_folders_then_what_changed_last() {
        let hot = HotPaths {
            recent: vec!["docs/ACP.md".into(), "src/lib.rs".into()],
            changed: vec!["Cargo.toml".into()],
        };
        let m = mentions_in(&project(), "", 8, &hot);
        assert_eq!(
            paths(&m)[..3],
            ["docs/ACP.md", "src/lib.rs", "Cargo.toml"],
            "recent in the order of use, then changed"
        );
        let rest = &paths(&m)[3..];
        let folders: Vec<_> = m
            .hits
            .iter()
            .filter(|h| h.folder)
            .map(|h| h.path.as_str())
            .collect();
        assert_eq!(
            folders,
            ["components", "src", "docs"],
            "top level only, newest first"
        );
        assert!(
            !rest.contains(&"src/auth"),
            "a folder below the top is one keystroke away"
        );
        assert!(m.hits.iter().all(|h| h.marks.is_empty()));
    }

    #[test]
    fn one_wrong_missing_or_swapped_letter_in_a_name_is_forgiven_only_when_little_matches() {
        let idx = project();
        for typo in ["mian.rs", "mai.rs", "maiin.rs", "palete"] {
            let m = mentions_in(&idx, typo, 5, &HotPaths::default());
            let want = if typo == "palete" {
                "components/palette.tsx"
            } else {
                "src/main.rs"
            };
            assert!(
                m.hits
                    .iter()
                    .any(|h| h.path == want && h.typo || h.path == want),
                "{typo}: {:?}",
                paths(&m)
            );
        }
        // Short words are not guessed at: one edit is another word.
        assert!(
            mentions_in(&idx, "mn", 5, &HotPaths::default())
                .hits
                .iter()
                .all(|h| !h.typo)
        );
        // A query that matches plenty is not second-guessed.
        assert!(
            mentions_in(&idx, "src", 5, &HotPaths::default())
                .hits
                .iter()
                .all(|h| !h.typo)
        );
    }

    #[test]
    fn the_limit_cuts_the_list_and_total_says_how_many_there_were() {
        let m = mentions_in(&project(), "s", 3, &HotPaths::default());
        assert_eq!(m.hits.len(), 3);
        assert!(m.total > 3);
    }
}
