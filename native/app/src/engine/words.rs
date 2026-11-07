//! The words the board says: the status line, the window title and how long ago. herdr-mobile's
//! (`agents_screen.dart` `_StatusLine`, `Elapsed.compact`), so the two apps read the same.

use std::time::Duration;

use herdr_core::board::Counts;

/// The window title: `(2) Herdr Desktop` while agents need the person, else `Herdr Desktop`.
pub fn window_title(needs_you: usize) -> String {
    if needs_you == 0 {
        "Herdr Desktop".to_owned()
    } else {
        format!("({needs_you}) Herdr Desktop")
    }
}

/// `12s`-less compact time: `<1m`, `4m`, `1h`, `1h 05m`, `3d`. Changes at most once a minute, so a label
/// that shows it does not tick.
pub fn compact(d: Duration) -> String {
    let minutes = d.as_secs() / 60;
    let hours = minutes / 60;
    if minutes < 1 {
        "<1m".to_owned()
    } else if hours < 1 {
        format!("{minutes}m")
    } else if hours < 24 {
        match minutes % 60 {
            0 => format!("{hours}h"),
            m => format!("{hours}h {m:02}m"),
        }
    } else {
        format!("{}d", hours / 24)
    }
}

/// `heard just now`, or `heard 3m ago`: how fresh the board is, from the connected machine heard from
/// longest ago, so one that stopped answering shows before it is declared offline.
pub fn heard(oldest: Duration) -> String {
    if oldest < Duration::from_secs(60) {
        "heard just now".to_owned()
    } else {
        format!("heard {} ago", compact(oldest))
    }
}

/// The board's one status line: `2 need you · 3 to review · 3 working · heard just now · 1 not connected`.
///
/// A board with nothing waiting or working says `nothing running`, so the line always answers "is
/// everything alive?". Finished agents on a machine that is not connected are said, not counted:
/// `3 to review, 1 offline`, or `2 offline to review` when none can be marked now.
pub fn status_line(counts: &Counts, review_offline: usize, heard: Option<&str>) -> String {
    let mut facts: Vec<String> = Vec::new();
    if counts.needs_you > 0 {
        let verb = if counts.needs_you == 1 {
            "needs"
        } else {
            "need"
        };
        facts.push(format!("{} {verb} you", counts.needs_you));
    }
    if counts.to_review > 0 {
        let mut fact = format!("{} to review", counts.to_review);
        if review_offline > 0 {
            fact.push_str(&format!(", {review_offline} offline"));
        }
        facts.push(fact);
    } else if review_offline > 0 {
        facts.push(format!("{review_offline} offline to review"));
    }
    if counts.working > 0 {
        facts.push(format!("{} working", counts.working));
    } else if counts.needs_you == 0 {
        facts.push("nothing running".to_owned());
    }
    facts.extend(heard.map(str::to_owned));
    if counts.machines_not_connected > 0 {
        facts.push(format!("{} not connected", counts.machines_not_connected));
    }
    facts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(needs_you: usize, to_review: usize, working: usize, down: usize) -> Counts {
        Counts {
            needs_you,
            to_review,
            working,
            machines_not_connected: down,
            ..Counts::default()
        }
    }

    #[test]
    fn the_status_line_reads_as_on_the_phone() {
        let cases = [
            (
                counts(2, 3, 3, 0),
                0,
                Some("heard just now"),
                "2 need you · 3 to review · 3 working · heard just now",
            ),
            (counts(1, 0, 0, 0), 0, None, "1 needs you"),
            (
                counts(0, 0, 0, 0),
                0,
                Some("heard just now"),
                "nothing running · heard just now",
            ),
            (
                counts(0, 0, 0, 1),
                0,
                None,
                "nothing running · 1 not connected",
            ),
            (
                counts(0, 3, 0, 1),
                1,
                None,
                "3 to review, 1 offline · nothing running · 1 not connected",
            ),
            (
                counts(0, 0, 2, 0),
                2,
                None,
                "2 offline to review · 2 working",
            ),
        ];
        for (counts, offline, heard, want) in cases {
            assert_eq!(status_line(&counts, offline, heard), want);
        }
    }

    #[test]
    fn the_title_carries_the_count_that_needs_you() {
        assert_eq!(window_title(0), "Herdr Desktop");
        assert_eq!(window_title(2), "(2) Herdr Desktop");
    }

    #[test]
    fn elapsed_time_is_compact_and_changes_once_a_minute() {
        let s = Duration::from_secs;
        assert_eq!(compact(s(59)), "<1m");
        assert_eq!(compact(s(60)), "1m");
        assert_eq!(compact(s(59 * 60 + 59)), "59m");
        assert_eq!(compact(s(3600)), "1h");
        assert_eq!(compact(s(3600 + 5 * 60)), "1h 05m");
        assert_eq!(compact(s(86_400 * 3 + 7200)), "3d");
        assert_eq!(heard(s(30)), "heard just now");
        assert_eq!(heard(s(180)), "heard 3m ago");
    }
}
