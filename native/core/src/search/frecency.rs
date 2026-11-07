//! Frecency: how often and how recently something was chosen, as a gentle boost on a match score. Firefox's shape (the
//! urlbar's double exponential decay over a sample of recent visits); the half-life depends on what is chosen, since a
//! command is run less often than an agent is visited. All constants are starting values, tuned by the golden tests.

use crate::recents::Entry;

const DAY_MS: f64 = 86_400_000.0;

/// Half-life, in days, of a visit's weight.
pub fn half_life_days(kind: super::Kind) -> f64 {
    use super::Kind::*;
    match kind {
        Agent | Project | Machine | Message => 7.0,
        File => 14.0,
        Command | Setting | Theme => 21.0,
    }
}

/// `(count / samples) * sum(2^(-age / half-life))` over the sampled visits; zero for an entry never visited.
pub fn frecency(entry: &Entry, now: u64, half_life_days: f64) -> f64 {
    if entry.visits.is_empty() {
        return 0.0;
    }
    let weight: f64 = entry
        .visits
        .iter()
        .map(|&at| {
            let age_days = now.saturating_sub(at) as f64 / DAY_MS;
            (-age_days / half_life_days).exp2()
        })
        .sum();
    entry.count as f64 / entry.visits.len() as f64 * weight
}

/// The factor a score is multiplied by: 1 for something never chosen, at most 1.6, so that a good match always beats a
/// frequent bad one.
pub fn boost(frecency: f64) -> f64 {
    1.0 + 0.6 * (frecency / 3.0).tanh()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(visits: &[u64], count: u64) -> Entry {
        Entry {
            key: "k".into(),
            visits: visits.to_vec(),
            count,
        }
    }

    #[test]
    fn recent_and_frequent_outweigh_old_and_rare() {
        let now = 100 * DAY_MS as u64;
        let day = DAY_MS as u64;
        let fresh = frecency(&entry(&[now - day, now], 2), now, 7.0);
        let old = frecency(&entry(&[now - 60 * day], 1), now, 7.0);
        assert!(fresh > old * 20.0);
        assert_eq!(frecency(&entry(&[], 0), now, 7.0), 0.0);
    }

    #[test]
    fn the_boost_is_bounded() {
        assert_eq!(boost(0.0), 1.0);
        assert!(boost(1e9) <= 1.6 + 1e-9);
        assert!(boost(2.0) > boost(1.0));
    }
}
