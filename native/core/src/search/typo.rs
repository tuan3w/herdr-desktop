//! Typo tolerance: a word one edit away (a letter missing, added, wrong or two neighbours swapped) from a query word.
//! Only used when a strict search found almost nothing, and only for words of four letters or more: on a short word one
//! edit is a different word.

/// Whether `a` and `b` are the same, or differ by one insertion, deletion, substitution or adjacent swap.
pub fn within_one(a: &[char], b: &[char]) -> bool {
    let (la, lb) = (a.len(), b.len());
    if la.abs_diff(lb) > 1 {
        return false;
    }
    let common = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    if common == la && common == lb {
        return true;
    }
    let (ra, rb) = (&a[common..], &b[common..]);
    match la.cmp(&lb) {
        std::cmp::Ordering::Equal => {
            // One substitution, or one adjacent swap.
            ra[1..] == rb[1..]
                || (ra.len() >= 2 && ra[0] == rb[1] && ra[1] == rb[0] && ra[2..] == rb[2..])
        }
        std::cmp::Ordering::Less => ra == &rb[1..],
        std::cmp::Ordering::Greater => &ra[1..] == rb,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn one_edit_is_within_and_two_are_not() {
        assert!(within_one(&w("link"), &w("link")));
        assert!(within_one(&w("lnik"), &w("link")), "a swap");
        assert!(within_one(&w("paymnets"), &w("payments")), "a swap");
        assert!(
            within_one(&w("paymens"), &w("payments")),
            "a letter missing"
        );
        assert!(
            within_one(&w("paymentss"), &w("payments")),
            "a letter added"
        );
        assert!(within_one(&w("payrents"), &w("payments")), "a letter wrong");
        assert!(!within_one(&w("pymnts"), &w("payments")));
        assert!(!within_one(&w("abcd"), &w("badc")), "two swaps");
    }
}
