//! Cost of one keystroke in quick open over a big project: `cargo bench --bench quick`.
//!
//! 100,000 synthetic paths (folders three to six deep, names with an extension) stand in for a root's walk; the index is
//! made once, then every query is asked many times. Each line printed is `<query> p50_us=<n> p95_us=<n> matches=<n>`
//! over those asks, so a script can read the numbers. The budget is well under 50 ms.

use std::hint::black_box;
use std::sync::Arc;
use std::time::Instant;

use herdr_core::files::{
    Chunk, FileError, FileErrorKind, Files, Listing, LocalFiles, Quick, Stat, Tree, TreeEntry,
    TreeLimits,
};

const WORDS: [&str; 32] = [
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
    "components",
    "lib",
    "native",
    "core",
    "app",
    "tests",
    "fixtures",
    "utils",
];
const EXTENSIONS: [&str; 6] = ["rs", "tsx", "ts", "md", "json", "py"];

/// A machine whose only skill is handing over a fixed list of paths.
struct Fixed(Vec<TreeEntry>);

fn nothing<T>() -> Result<T, FileError> {
    Err(FileError::new(FileErrorKind::Unsupported, "bench"))
}

impl Files for Fixed {
    fn list(&self, _: &str) -> Result<Listing, FileError> {
        nothing()
    }
    fn stat(&self, _: &str) -> Result<Stat, FileError> {
        nothing()
    }
    fn read(&self, _: &str, _: u64, _: usize) -> Result<Chunk, FileError> {
        nothing()
    }
    fn put(&self, _: &str, _: u64, _: &[u8]) -> Result<(), FileError> {
        nothing()
    }
    fn commit(&self, _: &str, _: bool) -> Result<(), FileError> {
        nothing()
    }
    fn discard(&self, _: &str) -> Result<(), FileError> {
        nothing()
    }
    fn tree(&self, _: &str, _: &TreeLimits) -> Result<Tree, FileError> {
        Ok(Tree {
            entries: self.0.clone(),
            truncated: false,
        })
    }
}

fn paths(n: usize) -> Vec<TreeEntry> {
    (0..n)
        .map(|i| {
            let depth = 3 + i % 4;
            let mut path = String::new();
            for level in 0..depth {
                let word = WORDS[(i / (level + 1) * 7 + level * 13 + i / 5) % WORDS.len()];
                path.push_str(word);
                path.push('/');
            }
            path.push_str(WORDS[(i * 11 + i / 3) % WORDS.len()]);
            path.push_str(&format!(
                "-{}.{}",
                i % 977,
                EXTENSIONS[i % EXTENSIONS.len()]
            ));
            TreeEntry {
                path,
                modified: (i as i64 * 7919) % 1_000_000,
            }
        })
        .collect()
}

fn main() {
    // A real walk, when asked for one: `HERDR_BENCH_ROOT=/some/big/folder cargo bench --bench quick`.
    if let Ok(root) = std::env::var("HERDR_BENCH_ROOT") {
        for (what, walk) in [("first", false), ("ignored", true)] {
            let started = Instant::now();
            let limits = if walk {
                TreeLimits::IGNORED
            } else {
                TreeLimits::INDEX
            };
            let local = LocalFiles::new();
            let tree = if walk {
                local.tree_ignored(&root, &limits)
            } else {
                local.tree(&root, &limits)
            }
            .expect("the root can be walked");
            println!(
                "walk {what} paths={} truncated={} walk_ms={}",
                tree.entries.len(),
                tree.truncated,
                started.elapsed().as_millis()
            );
        }
    }
    let files: Arc<dyn Files> = Arc::new(Fixed(paths(100_000)));
    let quick = Quick::new();
    let built = Instant::now();
    let indexed = quick
        .warm("bench", &files, "/root")
        .expect("the fixed tree always lists");
    println!(
        "index paths={indexed} build_ms={}",
        built.elapsed().as_millis()
    );
    for query in [
        "",
        "p",
        "pal",
        "palette",
        "pal.tsx",
        "comp pal",
        "core/pars",
        "native app schema",
        "zzzzzz",
        "wbskt",
    ] {
        const RUNS: usize = 60;
        let mut micros: Vec<u128> = Vec::with_capacity(RUNS);
        let mut matches = 0;
        for _ in 0..RUNS {
            let started = Instant::now();
            let found = quick
                .search("bench", &files, "/root", black_box(query), 50)
                .expect("the index is in memory");
            micros.push(started.elapsed().as_micros());
            matches = found.total;
            black_box(&found);
        }
        micros.sort_unstable();
        println!(
            "{query:?} p50_us={} p95_us={} matches={matches}",
            micros[RUNS / 2],
            micros[RUNS * 95 / 100]
        );
    }
}
