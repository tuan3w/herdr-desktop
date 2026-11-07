//! What the person visited, newest first: the memory behind `ctrl+tab`, the Switcher and (later) the palette's ranking.
//!
//! A key names a destination (`agent:<machine>/<pane>`, `project:<key>`); this module does not interpret it. Each
//! entry keeps its last [`SAMPLES`] visit times and a running count, which is what a frecency needs (Firefox's
//! shape: how often, weighted by how recently). Only ids, counts and times are kept, never what a pane showed.
//! Time is passed in (milliseconds since the epoch) so every rule is testable without a clock.

use serde::{Deserialize, Serialize};

/// Visit times kept per entry: enough to tell a habit from a one-off.
pub const SAMPLES: usize = 10;

/// Entries kept in all; the least recently visited go first.
pub const CAP: usize = 500;

/// Half-life of a visit's weight, in days.
const HALF_LIFE_DAYS: f64 = 7.0;

const DAY_MS: f64 = 86_400_000.0;

/// One destination and when it was visited.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub key: String,
    /// The last [`SAMPLES`] visit times, oldest first.
    pub visits: Vec<u64>,
    /// Every visit ever counted, the sampled ones included.
    pub count: u64,
}

impl Entry {
    /// When it was visited last.
    pub fn last(&self) -> u64 {
        self.visits.last().copied().unwrap_or(0)
    }

    /// `(visits / samples) * sum(2^(-age_days / half-life))` over the sampled visits: the more often and the more
    /// recently, the higher. Zero for an entry never visited.
    pub fn frecency(&self, now: u64) -> f64 {
        if self.visits.is_empty() {
            return 0.0;
        }
        let weight: f64 = self
            .visits
            .iter()
            .map(|&at| {
                let age_days = now.saturating_sub(at) as f64 / DAY_MS;
                (-age_days / HALF_LIFE_DAYS).exp2()
            })
            .sum();
        self.count as f64 / self.visits.len() as f64 * weight
    }
}

/// The visited destinations, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Recents {
    entries: Vec<Entry>,
}

impl Recents {
    /// Builds from stored entries: newest first, capped, with every entry's samples bounded.
    pub fn from_entries(mut entries: Vec<Entry>) -> Self {
        for entry in &mut entries {
            entry.visits.sort_unstable();
            let extra = entry.visits.len().saturating_sub(SAMPLES);
            entry.visits.drain(..extra);
            entry.count = entry.count.max(entry.visits.len() as u64);
        }
        entries.retain(|e| !e.visits.is_empty());
        entries.sort_by_key(|e| std::cmp::Reverse(e.last()));
        entries.dedup_by(|a, b| a.key == b.key);
        entries.truncate(CAP);
        Self { entries }
    }

    /// The entries as stored.
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    /// Notes a visit to `key` at `now`: it becomes the newest entry.
    pub fn visit(&mut self, key: &str, now: u64) {
        let mut entry = match self.entries.iter().position(|e| e.key == key) {
            Some(at) => self.entries.remove(at),
            None => Entry {
                key: key.to_owned(),
                visits: Vec::new(),
                count: 0,
            },
        };
        // A clock that stepped back must not put the newest visit before an older one.
        let at = now.max(entry.last());
        entry.visits.push(at);
        if entry.visits.len() > SAMPLES {
            entry.visits.remove(0);
        }
        entry.count += 1;
        // Keep the order by last visit: the visited entry is newest unless another has a later stamp (a stepped clock).
        let place = self.entries.iter().take_while(|e| e.last() > at).count();
        self.entries.insert(place, entry);
        self.entries.truncate(CAP);
    }

    /// Forgets `key`; false when it was not there.
    pub fn forget(&mut self, key: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.key != key);
        self.entries.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 86_400_000;

    #[test]
    fn the_latest_visit_is_first_and_a_revisit_moves_it_up() {
        let mut r = Recents::default();
        r.visit("a", 1_000);
        r.visit("b", 2_000);
        r.visit("c", 3_000);
        r.visit("a", 4_000);
        let keys: Vec<_> = r.entries().iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["a", "c", "b"]);
        assert_eq!(r.entries()[0].count, 2);
    }

    #[test]
    fn samples_are_bounded_but_the_count_is_not() {
        let mut r = Recents::default();
        for n in 0..25 {
            r.visit("a", 1_000 + n);
        }
        let e = &r.entries()[0];
        assert_eq!(e.visits.len(), SAMPLES);
        assert_eq!(e.count, 25);
        assert_eq!(e.last(), 1_024);
    }

    #[test]
    fn the_least_recent_entries_go_when_the_cap_is_reached() {
        let mut r = Recents::default();
        for n in 0..(CAP as u64 + 5) {
            r.visit(&format!("k{n}"), n + 1);
        }
        assert_eq!(r.entries().len(), CAP);
        assert!(r.entries().iter().all(|e| e.key != "k0"));
        assert_eq!(r.entries()[0].key, format!("k{}", CAP + 4));
    }

    #[test]
    fn a_clock_that_steps_back_never_reorders_history() {
        let mut r = Recents::default();
        r.visit("a", 10_000);
        r.visit("a", 5_000);
        assert_eq!(r.entries()[0].visits, [10_000, 10_000]);
    }

    #[test]
    fn frecency_rewards_frequent_and_recent_visits() {
        let now = 100 * DAY;
        let mut often = Recents::default();
        for n in 0..5 {
            often.visit("a", now - n * 1_000);
        }
        let mut once = Recents::default();
        once.visit("a", now);
        let mut old = Recents::default();
        old.visit("a", now - 30 * DAY);
        let f = |r: &Recents| r.entries()[0].frecency(now);
        assert!(f(&often) > f(&once), "five visits beat one");
        assert!(f(&once) > f(&old), "now beats a month ago");
        assert!((f(&once) - 1.0).abs() < 1e-9, "one visit just now weighs 1");
    }

    #[test]
    fn stored_entries_are_repaired_on_load() {
        let r = Recents::from_entries(vec![
            Entry {
                key: "x".into(),
                visits: vec![],
                count: 3,
            },
            Entry {
                key: "a".into(),
                visits: vec![5, 1, 3],
                count: 0,
            },
            Entry {
                key: "b".into(),
                visits: (0..40).collect(),
                count: 40,
            },
        ]);
        let keys: Vec<_> = r.entries().iter().map(|e| e.key.as_str()).collect();
        assert_eq!(
            keys,
            ["b", "a"],
            "an entry never visited is dropped, newest first"
        );
        assert_eq!(r.entries()[1].visits, [1, 3, 5]);
        assert_eq!(r.entries()[1].count, 3);
        assert_eq!(r.entries()[0].visits.len(), SAMPLES);
    }

    #[test]
    fn forgetting_drops_an_entry() {
        let mut r = Recents::default();
        r.visit("agent:a", 1);
        r.visit("project:p", 3);
        assert!(r.forget("agent:a"));
        assert!(!r.forget("agent:a"));
        assert_eq!(r.entries().len(), 1);
    }
}
