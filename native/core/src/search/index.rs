//! The index: items prepared once (folded text, words for typo matching), and the search over them.
//!
//! A query is split into words; every word must match some field of an item (AND), and the item's score is the sum of
//! each word's best field (`score * weight`), times a frecency boost and the context boosts. Names match by
//! subsequence, long text only by word start or substring. Only when that finds fewer than [`TYPO_BELOW`] items does a
//! second pass allow one typo in words of four letters or more.

use parking_lot::Mutex;

use super::frecency::boost;
use super::matcher::{Haystack, Needle, Scorer, runs};
use super::query::{Filter, Parsed, parse};
use super::typo::within_one;
use super::{Focus, Kind, KindSet};

/// How a field is matched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A name or a short label: by subsequence, so `pgw` finds `payment gateway`.
    Name,
    /// Long text: by the start of a word or a substring only.
    Text,
}

/// Text of an item besides its title that a query may match, and how much a match there counts.
#[derive(Debug, Clone)]
pub struct Field {
    pub text: String,
    pub weight: f32,
    pub mode: Mode,
}

impl Field {
    pub fn name(text: impl Into<String>, weight: f32) -> Self {
        Self {
            text: text.into(),
            weight,
            mode: Mode::Name,
        }
    }

    pub fn text(text: impl Into<String>, weight: f32) -> Self {
        Self {
            text: text.into(),
            weight,
            mode: Mode::Text,
        }
    }
}

/// Weight of a synonym (a command's keyword or verb): below the title, so the command's own name wins.
const ALIAS_WEIGHT: f32 = 0.7;

/// A thing that can be found. The producer decides what is searchable and how much it counts; nothing here knows what
/// an agent or a command is beyond its [`Kind`].
#[derive(Debug, Clone)]
pub struct Item {
    pub kind: Kind,
    /// What a hit underlines. Matched at weight 1, as `title_mode` says.
    pub title: String,
    /// `Text` for a title that is a line of prose (a message), `Name` for a name.
    pub title_mode: Mode,
    pub fields: Vec<Field>,
    /// Synonyms: shown as `Title (alias)` by the producer when one of these won.
    pub aliases: Vec<String>,
    /// From the recents store, at open ([`super::frecency::frecency`]).
    pub frecency: f64,
    /// The project it belongs to (its key), for the context boost.
    pub project: Option<String>,
    /// The machine it is on (its id), for the context boost.
    pub machine: Option<String>,
    /// For `on:` filters.
    pub machine_name: String,
    /// For `in:` filters.
    pub project_name: String,
    /// For `is:` filters: `needs`, `review`, `working`, `idle`, `chat`, `terminal`, `pinned`, `unread`.
    pub tags: Vec<&'static str>,
    /// Cannot be run: ranked after everything that can.
    pub disabled: bool,
}

struct Prepared {
    kind: Kind,
    title: Haystack,
    title_mode: Mode,
    fields: Vec<(Haystack, f32, Mode)>,
    aliases: Vec<Haystack>,
    /// Words of the title and the aliases, for the typo pass.
    words: Vec<Vec<char>>,
    frecency_boost: f64,
    project: Option<String>,
    machine: Option<String>,
    machine_name: String,
    project_name: String,
    tags: Vec<&'static str>,
    disabled: bool,
}

/// One hit.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    /// Index into the items the index was made from.
    pub item: usize,
    pub score: f64,
    /// Runs `[start, end)` of characters of the item's title that matched, in the original text.
    pub marks: Vec<(u32, u32)>,
    /// The alias that won, when the title did not match: the producer shows `Title (alias)`.
    pub alias: Option<usize>,
}

/// A search.
#[derive(Debug, Clone)]
pub struct Request {
    pub query: String,
    pub kinds: KindSet,
    pub focus: Focus,
    pub limit: usize,
    /// At most this many hits of a kind (`All` shows up to three messages).
    pub caps: Vec<(Kind, usize)>,
}

/// The answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub hits: Vec<Hit>,
    /// Matches in all, before `limit`.
    pub total: usize,
    /// The query held a filter (`on:`, `in:`, `is:`) that was understood.
    pub filters: Vec<String>,
}

/// The last query's matches, for the next one to start from when it only adds to it.
struct Last {
    key: String,
    kinds: KindSet,
    filters: Vec<Filter>,
    matched: Vec<u32>,
}

pub struct Index {
    items: Vec<Prepared>,
    scorer: Mutex<Scorer>,
    last: Mutex<Option<Last>>,
}

/// Below this many strict matches the typo pass runs.
pub const TYPO_BELOW: usize = 3;

/// Points a typo match scores per letter: below a strict match of the same word.
const TYPO_PER_CHAR: f64 = 12.0;

impl Index {
    pub fn new(items: &[Item]) -> Self {
        let prepared = items
            .iter()
            .map(|i| {
                let title = Haystack::new(&i.title);
                let aliases: Vec<Haystack> = i.aliases.iter().map(|a| Haystack::new(a)).collect();
                let words = title
                    .text()
                    .split(|c: char| !c.is_alphanumeric())
                    .chain(
                        aliases
                            .iter()
                            .flat_map(|a| a.text().split(|c: char| !c.is_alphanumeric())),
                    )
                    .filter(|w| w.chars().count() >= 3)
                    .map(|w| w.chars().collect())
                    .collect();
                Prepared {
                    kind: i.kind,
                    title,
                    title_mode: i.title_mode,
                    fields: i
                        .fields
                        .iter()
                        .map(|f| (Haystack::new(&f.text), f.weight, f.mode))
                        .filter(|(h, _, _)| !h.is_empty())
                        .collect(),
                    aliases,
                    words,
                    frecency_boost: boost(i.frecency),
                    project: i.project.clone(),
                    machine: i.machine.clone(),
                    machine_name: super::fold::fold_text(&i.machine_name),
                    project_name: super::fold::fold_text(&i.project_name),
                    tags: i.tags.clone(),
                    disabled: i.disabled,
                }
            })
            .collect();
        Self {
            items: prepared,
            scorer: Mutex::new(Scorer::new(false)),
            last: Mutex::new(None),
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Ranks the items against `req`. The same index and request always give the same order.
    pub fn search(&self, req: &Request) -> Page {
        let parsed = parse(&req.query);
        let needles: Vec<Needle> = parsed.words.iter().map(|w| Needle::new(w)).collect();
        let filters: Vec<String> = parsed.filters.iter().map(Filter::text).collect();
        let key = parsed.key();
        let mut scorer = self.scorer.lock();

        // A query that only adds to the last one (a character typed) searches only the last one's matches.
        let from: Option<Vec<u32>> = {
            let last = self.last.lock();
            last.as_ref()
                .filter(|l| {
                    !l.key.is_empty()
                        && key.starts_with(&l.key)
                        && l.kinds == req.kinds
                        && l.filters == parsed.filters
                })
                .map(|l| l.matched.clone())
        };

        let mut strict: Vec<Scored> = Vec::new();
        let mut visit = |at: usize, strict: &mut Vec<Scored>| {
            let item = &self.items[at];
            if !req.kinds.has(item.kind) || !passes(item, &parsed.filters) {
                return;
            }
            if let Some(s) = self.score(&mut scorer, item, &needles, &key, req, at) {
                strict.push(s);
            }
        };
        match &from {
            Some(set) => set.iter().for_each(|&at| visit(at as usize, &mut strict)),
            None => (0..self.items.len()).for_each(|at| visit(at, &mut strict)),
        }

        let mut typo = false;
        if strict.len() < TYPO_BELOW && needles.iter().any(|n| n.len() >= 4) {
            let seen: std::collections::HashSet<usize> = strict.iter().map(|s| s.item).collect();
            let mut extra = Vec::new();
            for (at, item) in self.items.iter().enumerate() {
                if seen.contains(&at) || !req.kinds.has(item.kind) || !passes(item, &parsed.filters)
                {
                    continue;
                }
                if let Some(s) = self.score_with_typos(&mut scorer, item, &needles, &key, req, at) {
                    extra.push(s);
                }
            }
            typo = !extra.is_empty();
            strict.extend(extra);
        }

        *self.last.lock() = (!typo && !key.is_empty()).then(|| Last {
            key: key.clone(),
            kinds: req.kinds,
            filters: parsed.filters.clone(),
            matched: strict.iter().map(|s| s.item as u32).collect(),
        });

        strict.sort_by(|a, b| self.order(a, b));
        let total = strict.len();
        let mut taken = [0usize; Kind::COUNT];
        let mut hits = Vec::with_capacity(req.limit.min(total));
        for s in strict {
            if hits.len() >= req.limit {
                break;
            }
            let kind = self.items[s.item].kind;
            let capped = req
                .caps
                .iter()
                .any(|&(k, cap)| k == kind && taken[kind as usize] >= cap);
            if capped {
                continue;
            }
            taken[kind as usize] += 1;
            hits.push(self.hit(&mut scorer, s, &needles));
        }
        Page {
            hits,
            total,
            filters,
        }
    }

    fn order(&self, a: &Scored, b: &Scored) -> std::cmp::Ordering {
        let (ia, ib) = (&self.items[a.item], &self.items[b.item]);
        ia.disabled
            .cmp(&ib.disabled)
            .then(b.score.total_cmp(&a.score))
            .then(b.prefix.cmp(&a.prefix))
            .then(ia.title.text().len().cmp(&ib.title.text().len()))
            .then(a.item.cmp(&b.item))
    }

    /// The strict score of `item` for all words, or `None` when some word matches nowhere.
    fn score(
        &self,
        scorer: &mut Scorer,
        item: &Prepared,
        needles: &[Needle],
        key: &str,
        req: &Request,
        at: usize,
    ) -> Option<Scored> {
        let mut total = 0.0;
        let mut alias = None;
        for needle in needles {
            let (best, via) = best_field(scorer, item, needle)?;
            total += best;
            if via.is_some() {
                alias = alias.or(via);
            }
        }
        Some(self.finish(item, req, at, total, (needles, key), alias))
    }

    /// As [`Index::score`], but a word may match one typo away from a word of the title or an alias.
    fn score_with_typos(
        &self,
        scorer: &mut Scorer,
        item: &Prepared,
        needles: &[Needle],
        key: &str,
        req: &Request,
        at: usize,
    ) -> Option<Scored> {
        let mut total = 0.0;
        let mut used_typo = false;
        for needle in needles {
            if let Some((best, _)) = best_field(scorer, item, needle) {
                total += best;
                continue;
            }
            if needle.len() < 4 {
                return None;
            }
            let word: Vec<char> = needle.text().chars().collect();
            if !item.words.iter().any(|w| within_one(&word, w)) {
                return None;
            }
            used_typo = true;
            total += TYPO_PER_CHAR * needle.len() as f64;
        }
        used_typo.then(|| self.finish(item, req, at, total, (needles, key), None))
    }

    fn finish(
        &self,
        item: &Prepared,
        req: &Request,
        at: usize,
        raw: f64,
        (needles, key): (&[Needle], &str),
        alias: Option<usize>,
    ) -> Scored {
        let mut score = raw * item.frecency_boost;
        if item.project.is_some() && item.project == req.focus.project {
            score *= 1.2;
        }
        if item.machine.is_some() && item.machine == req.focus.machine {
            score *= 1.05;
        }
        let prefix = needles
            .first()
            .is_some_and(|n| item.title.text().starts_with(n.text()));
        // Typing a name in full finds that name first, even over something chosen far more often.
        if !key.is_empty() && key == item.title.text() {
            score *= 2.0;
        }
        Scored {
            item: at,
            score,
            prefix,
            alias,
        }
    }

    fn hit(&self, scorer: &mut Scorer, s: Scored, needles: &[Needle]) -> Hit {
        let item = &self.items[s.item];
        let mut indices = Vec::new();
        for needle in needles {
            // Only title matches are underlined; a long-text hit shows its own words.
            let mut one = Vec::new();
            if item.title_mode == Mode::Name
                && scorer.fuzzy_marks(&item.title, needle, &mut one).is_some()
            {
                indices.extend(one);
            } else if let Some(at) = item.title.text().find(needle.text()) {
                let from = item.title.text()[..at].chars().count() as u32;
                indices.extend((from..from + needle.len() as u32).map(|i| item.title.original(i)));
            }
        }
        indices.sort_unstable();
        indices.dedup();
        Hit {
            item: s.item,
            score: s.score,
            marks: runs(&indices),
            alias: s.alias,
        }
    }
}

struct Scored {
    item: usize,
    score: f64,
    prefix: bool,
    alias: Option<usize>,
}

/// The best weighted score of `needle` over the fields of `item`, and which alias gave it when an alias did.
fn best_field(
    scorer: &mut Scorer,
    item: &Prepared,
    needle: &Needle,
) -> Option<(f64, Option<usize>)> {
    let mut best: Option<(f64, Option<usize>)> = None;
    let mut consider = |score: f64, via: Option<usize>| {
        if best.is_none_or(|(b, _)| score > b) {
            best = Some((score, via));
        }
    };
    let title = match item.title_mode {
        Mode::Name => scorer.fuzzy(&item.title, needle),
        Mode::Text => scorer.word_or_substring(&item.title, needle),
    };
    if let Some(s) = title {
        consider(f64::from(s), None);
    }
    for (at, alias) in item.aliases.iter().enumerate() {
        if let Some(s) = scorer.fuzzy(alias, needle) {
            consider(f64::from(s) * f64::from(ALIAS_WEIGHT), Some(at));
        }
    }
    for (field, weight, mode) in &item.fields {
        let s = match mode {
            Mode::Name => scorer.fuzzy(field, needle),
            Mode::Text => scorer.word_or_substring(field, needle),
        };
        if let Some(s) = s {
            consider(f64::from(s) * f64::from(*weight), None);
        }
    }
    best
}

fn passes(item: &Prepared, filters: &[Filter]) -> bool {
    filters.iter().all(|f| match f {
        Filter::On(v) => item.machine_name.contains(v.as_str()),
        Filter::In(v) => item.project_name.contains(v.as_str()),
        Filter::Is(v) => item.tags.iter().any(|t| t.starts_with(v.as_str())),
    })
}

impl Parsed {
    /// What identifies the query for narrowing: its words, in order, one space apart.
    fn key(&self) -> String {
        self.words.join(" ")
    }
}
