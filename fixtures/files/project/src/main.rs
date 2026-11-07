//! The settlement job: one line per merchant, never two.

use std::collections::BTreeMap;

struct Payment {
    merchant: String,
    cents: u64,
}

fn settle(payments: &[Payment]) -> BTreeMap<&str, u64> {
    let mut totals = BTreeMap::new();
    for p in payments {
        *totals.entry(p.merchant.as_str()).or_insert(0) += p.cents;
    }
    totals
}

fn main() {
    let payments = vec![
        Payment { merchant: "acme".into(), cents: 1250 },
        Payment { merchant: "acme".into(), cents: 300 },
        Payment { merchant: "globex".into(), cents: 990 },
    ];
    for (merchant, cents) in settle(&payments) {
        println!("{merchant}: {}.{:02}", cents / 100, cents % 100);
    }
}
