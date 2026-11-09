//! What the engine tests share: a running engine against a scripted herdr, and polling.
#![allow(dead_code)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use herdr_desktop_native::engine::{Config, Engine, LinkKind};
use herdr_desktop_native::fixture::Fixture;
use serde_json::{Value, json};

/// An engine on a fresh data directory, connected to a fixture, with a count of the ticks it sent.
pub struct Rig {
    pub engine: Engine,
    pub ticks: Arc<AtomicUsize>,
    pub dir: tempfile::TempDir,
}

/// Starts the engine on fixture `name` and waits until the local machine is online.
pub fn start(name: &str) -> Rig {
    start_in(name, tempfile::tempdir().expect("a temp dir"))
}

/// [`start`] on an existing data directory (to see what survives a restart).
pub fn start_in(name: &str, dir: tempfile::TempDir) -> Rig {
    start_fixture(Fixture::load(name).expect("the fixture loads"), dir)
}

/// [`start`] on a fixture a test built itself (`Fixture::from_json`), for the answers one test needs.
pub fn start_with(fixture: Value) -> Rig {
    let fixture = Fixture::from_json(&fixture).expect("the fixture is valid");
    start_fixture(fixture, tempfile::tempdir().expect("a temp dir"))
}

fn start_fixture(fixture: Fixture, dir: tempfile::TempDir) -> Rig {
    let ticks = Arc::new(AtomicUsize::new(0));
    let counter = ticks.clone();
    let engine = Engine::start(Config {
        data_dir: dir.path().to_path_buf(),
        fixture: Some(fixture),
        on_tick: Arc::new(move || {
            counter.fetch_add(1, Ordering::Relaxed);
        }),
    })
    .expect("the engine starts");
    let rig = Rig { engine, ticks, dir };
    wait_for("the local machine to connect", || {
        rig.engine.machine_statuses()[0].state == LinkKind::Online
    });
    rig
}

impl Rig {
    pub fn fixture(&self) -> &Fixture {
        self.engine.fixture().expect("a fixture")
    }

    /// The `params` of every `method` request the scripted herdr served.
    pub fn sent(&self, method: &str) -> Vec<Value> {
        self.fixture()
            .requests(Some(method))
            .into_iter()
            .map(|r| r.params)
            .collect()
    }

    /// Waits for the preview of an agent (its prompt included) to be read, and returns the board.
    pub fn board_with_previews(&self) -> herdr_desktop_native::engine::BoardState {
        let mut last = None;
        wait_for("the previews to be read", || {
            let board = self.engine.board();
            let ready = board
                .rows()
                .filter(|r| !r.offline)
                .all(|r| board.previews.contains_key(&r.key()));
            last = Some(board);
            ready
        });
        last.expect("the board was read at least once")
    }
}

/// Polls `cond` until it holds; panics naming `what` after ten seconds.
pub fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// A `pane_updated` event for `pane` (a JSON pane object) with a new content revision.
pub fn pane_updated(pane: Value, revision: u64) -> Value {
    let mut pane = pane;
    pane["revision"] = json!(revision);
    json!({"event": "pane_updated", "data": {"pane": pane}})
}
