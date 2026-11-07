//! Cost of one keystroke in the palette: `cargo bench --bench search`.
//!
//! The candidates are synthetic and shaped like the app's: agents with a project, a machine and a long last
//! message, projects, commands with synonyms. Each line printed is `<name> p50_us=<n> p95_us=<n>` over the keystrokes of
//! a typed query (every prefix of it, so the narrowing from the last query is exercised as it is in the app), so a script
//! can read the numbers.

use std::hint::black_box;
use std::time::Instant;

use herdr_core::search::{Field, Focus, Index, Item, Kind, KindSet, Mode, Request};

const WORDS: [&str; 24] = [
    "payments",
    "ledger",
    "gateway",
    "refactor",
    "migrate",
    "upgrade",
    "docs",
    "infra",
    "router",
    "billing",
    "search",
    "palette",
    "review",
    "deploy",
    "cache",
    "queue",
    "schema",
    "parser",
    "render",
    "theme",
    "session",
    "keeper",
    "websocket",
    "notify",
];

fn word(i: usize, k: usize) -> &'static str {
    WORDS[(i * 7 + k * 13 + i / 5) % WORDS.len()]
}

fn items(n: usize) -> Vec<Item> {
    (0..n)
        .map(|i| {
            let project = word(i, 1);
            let machine = ["gpu-box", "this computer", "build-farm"][i % 3];
            let message = format!(
                "I changed the {} and the {}, then ran the {} tests; the {} still fails when the {} is empty",
                word(i, 2),
                word(i, 3),
                word(i, 4),
                word(i, 5),
                word(i, 6)
            );
            Item {
                kind: if i % 10 == 0 { Kind::Command } else { Kind::Agent },
                title: format!("{} {} {}", word(i, 0), word(i, 2), i),
                title_mode: Mode::Name,
                fields: vec![
                    Field::name(project, 0.6),
                    Field::name(machine, 0.4),
                    Field::text(message, 0.2),
                ],
                aliases: vec![format!("start {}", word(i, 3))],
                frecency: if i % 17 == 0 { 3.0 } else { 0.0 },
                project: Some(project.to_owned()),
                machine: Some(machine.to_owned()),
                machine_name: machine.to_owned(),
                project_name: project.to_owned(),
                tags: vec!["chat"],
                disabled: false,
            }
        })
        .collect()
}

fn run(n: usize, query: &str) -> (u128, u128) {
    let items = items(n);
    let index = Index::new(&items);
    let kinds = KindSet::of(&[Kind::Agent, Kind::Command]);
    let mut samples = Vec::new();
    for _ in 0..40 {
        let mut typed = String::new();
        for c in query.chars() {
            typed.push(c);
            let req = Request {
                query: typed.clone(),
                kinds,
                focus: Focus::default(),
                limit: 50,
                caps: Vec::new(),
            };
            let started = Instant::now();
            black_box(index.search(&req));
            samples.push(started.elapsed().as_micros());
        }
    }
    samples.sort_unstable();
    (
        samples[samples.len() / 2],
        samples[samples.len() * 95 / 100],
    )
}

fn main() {
    for n in [2_000, 5_000] {
        for query in ["pay", "ledger gateway", "mgrate"] {
            let (p50, p95) = run(n, query);
            println!("search n={n} query={query:?} p50_us={p50} p95_us={p95}");
        }
    }
    let index_started = Instant::now();
    black_box(Index::new(&items(2_000)));
    println!(
        "index n=2000 build_us={}",
        index_started.elapsed().as_micros()
    );
}
