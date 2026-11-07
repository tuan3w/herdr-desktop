//! Prints the board of the live local herdr: section counts from `session.snapshot` (read-only).
//!
//! `cargo run --example board` and compare with
//! `herdr api snapshot | jq '[.result.snapshot.agents[].agent_status] | group_by(.) | map({(.[0]): length}) | add'`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use herdr_core::board::{Board, FirstSeen};
use herdr_core::link::{LinkState, LocalWire, default_socket_path};
use herdr_core::schema::Snapshot;
use herdr_core::store::{LOCAL_ID, Reviewed};
use herdr_core::wire::Wire;
use serde_json::json;

fn main() {
    let wire = LocalWire::new(default_socket_path());
    let result = match wire.request("session.snapshot", json!({}), Duration::from_secs(10)) {
        Ok(result) => result,
        Err(e) => {
            eprintln!("session.snapshot failed: {e}");
            std::process::exit(1);
        }
    };
    let snapshot = match Snapshot::from_result(&result) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };

    let mut raw = std::collections::BTreeMap::new();
    for agent in &snapshot.agents {
        *raw.entry(format!("{:?}", agent.agent_status).to_lowercase())
            .or_insert(0usize) += 1;
    }
    println!(
        "herdr {} (protocol {}), {} agents in {} panes",
        snapshot.version,
        snapshot.protocol,
        snapshot.agents.len(),
        snapshot.panes.len()
    );
    println!("status counts: {raw:?}");

    let now = Instant::now();
    let mut first_seen = FirstSeen::new();
    first_seen.observe(LOCAL_ID, &snapshot, now);
    let board = Board::from(
        &[(LOCAL_ID.to_owned(), snapshot.clone(), LinkState::Online)],
        herdr_core::board::BoardExtras::NONE,
        &Reviewed::default(),
        &first_seen,
        now,
    );
    let c = board.counts;
    println!(
        "board: needs_you={} to_review={} working={} idle={} offline={} projects={}",
        c.needs_you,
        c.to_review,
        c.working,
        c.idle,
        c.offline,
        board.projects.len()
    );
}
