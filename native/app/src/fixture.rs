//! A scripted herdr for tests: `fixtures/herdr/<name>.json` becomes a [`FakeHerdr`] the engine connects
//! to instead of the owner's real one.
//!
//! The seam is closed in production: `Herdr.configure({ fixture })` loads one only when the environment
//! variable [`TEST_FLAG`] is `1` (the Makefile and the TSX tests set it). Fixtures are synthetic; never
//! put a real pane in one.
//!
//! # The format
//!
//! ```json
//! {
//!   "snapshot": { "version": "0.9.5", "protocol": 22, "workspaces": [], "tabs": [], "panes": [], "agents": [] },
//!   "panes": { "w1:p1": { "screen": ["plain row", "..."], "ansi": ["optional rows with \u001b[31mSGR\u001b[0m"] } },
//!   "events": [ { "event": "pane_updated", "data": { "pane": { } } } ],
//!   "answers": { "workspace.create": { "type": "ok" } },
//!   "worktrees": { "repos": [ { "root": "/src/api", "linked": [ { "path": "/src/api-x", "branch": "feature/x" } ], "untrusted": false } ], "create_at": "/tmp" }
//! }
//! ```
//!
//! * `snapshot` is what `session.snapshot` answers (the bare snapshot object).
//! * `panes` is what `pane.read` shows: `screen` rows as plain text, and optionally the same rows with
//!   escape sequences for `format: "ansi"` reads (without them the plain rows serve both). A `lines`
//!   parameter keeps the last rows.
//! * `events` are sent to every event subscriber when it subscribes.
//! * `worktrees` makes the fake answer `worktree.list` and `worktree.create` from repositories held in memory
//!   (a created worktree joins its repository); `create_at` is where created worktrees are, so a test can name a folder
//!   that exists. Without the key the herdr is one that has no worktrees (`unknown_method`).
//! * `answers` overrides the result of any method; without an entry the mutating methods succeed
//!   (`{"type":"ok"}`, or the shape herdr uses for the methods that create something).
//!
//! `ping`, `session.snapshot`, `pane.read` and `pane.get` are always answered from the current state,
//! which a test changes with [`Fixture::set_snapshot`] and [`Fixture::set_screen`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use herdr_core::testing::{FakeHerdr, FakeRepo, FakeWorktrees, Recorded, Script};
use serde_json::{Map, Value, json};

/// The environment variable that must be `1` for a fixture to be honoured.
pub const TEST_FLAG: &str = "HERDR_DESKTOP_TEST";

/// Overrides where fixtures are looked for (a directory holding `<name>.json`).
pub const FIXTURES_ENV: &str = "HERDR_DESKTOP_FIXTURES";

/// Methods that succeed with `{"type":"ok"}` unless a fixture answers them itself.
const OK_METHODS: &[&str] = &[
    "pane.send_text",
    "pane.send_keys",
    "pane.send_input",
    "pane.close",
    "pane.focus",
    "pane.rename",
    "tab.close",
    "tab.focus",
    "tab.rename",
    "workspace.close",
    "workspace.focus",
    "workspace.rename",
    "agent.send_keys",
    "agent.rename",
];

/// Whether the test seam is open (`HERDR_DESKTOP_TEST=1`).
pub fn test_seam_open() -> bool {
    std::env::var(TEST_FLAG).is_ok_and(|v| v == "1")
}

/// What `pane.read` shows of one pane.
#[derive(Clone, Default)]
struct Screen {
    rows: Vec<String>,
    ansi: Option<Vec<String>>,
    revision: u64,
}

/// The parts of the fake that tests change while it runs.
struct State {
    snapshot: Mutex<Value>,
    screens: Mutex<HashMap<String, Screen>>,
    revision: AtomicU64,
    ssh_faults: Mutex<HashMap<String, String>>,
}

/// A running scripted herdr. Dropping it stops the server and removes its socket directory.
pub struct Fixture {
    fake: FakeHerdr,
    worktrees: Option<Arc<FakeWorktrees>>,
    state: Arc<State>,
    dir: PathBuf,
}

impl Fixture {
    /// Loads `<fixtures dir>/<name>.json` and starts serving it.
    pub fn load(name: &str) -> Result<Self, String> {
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(format!(
                "fixture name `{name}` may only use letters, digits, - and _"
            ));
        }
        let dir = fixtures_dir()
            .ok_or_else(|| "no fixtures directory found (set HERDR_DESKTOP_FIXTURES)".to_owned())?;
        let path = dir.join(format!("{name}.json"));
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("fixture {}: {e}", path.display()))?;
        let value: Value =
            serde_json::from_str(&text).map_err(|e| format!("fixture {}: {e}", path.display()))?;
        Self::from_json(&value).map_err(|e| format!("fixture {}: {e}", path.display()))
    }

    /// Starts serving a fixture given as JSON (the format above).
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let object = value.as_object().ok_or("must be a JSON object")?;
        for key in object.keys() {
            if !["snapshot", "panes", "events", "answers", "worktrees"].contains(&key.as_str()) {
                return Err(format!("unknown key `{key}`"));
            }
        }
        let snapshot = object
            .get("snapshot")
            .cloned()
            .ok_or("`snapshot` is required")?;
        if !snapshot.is_object() {
            return Err("`snapshot` must be an object".to_owned());
        }
        let mut screens = HashMap::new();
        if let Some(panes) = object.get("panes") {
            for (pane, spec) in panes.as_object().ok_or("`panes` must be an object")? {
                screens.insert(pane.clone(), screen_from(pane, spec)?);
            }
        }
        let events: Vec<Value> = match object.get("events") {
            None => Vec::new(),
            Some(Value::Array(events)) => events.clone(),
            Some(_) => return Err("`events` must be an array".to_owned()),
        };
        let answers: Map<String, Value> = match object.get("answers") {
            None => Map::new(),
            Some(Value::Object(answers)) => answers.clone(),
            Some(_) => return Err("`answers` must be an object".to_owned()),
        };

        let state = Arc::new(State {
            snapshot: Mutex::new(snapshot),
            screens: Mutex::new(screens),
            revision: AtomicU64::new(1),
            ssh_faults: Mutex::new(HashMap::new()),
        });
        let worktrees = object.get("worktrees").map(worktrees_from).transpose()?;
        let mut script = script(&state, events, answers);
        if let Some(fake) = &worktrees {
            script = script.worktrees(fake.clone());
        }
        let dir = socket_dir()?;
        let fake = FakeHerdr::start(&dir, script)
            .map_err(|e| format!("cannot start the fake herdr: {e}"))?;
        Ok(Self {
            fake,
            worktrees,
            state,
            dir,
        })
    }

    /// The in-memory repositories the fake serves worktrees from, when the fixture has any.
    pub fn worktrees(&self) -> Option<&Arc<FakeWorktrees>> {
        self.worktrees.as_ref()
    }

    /// The socket the engine's local machine connects to.
    pub fn socket_path(&self) -> &Path {
        self.fake.socket_path()
    }

    /// Every request served so far, oldest first, optionally of one method.
    pub fn requests(&self, method: Option<&str>) -> Vec<Recorded> {
        match method {
            Some(method) => self.fake.requests_of(method),
            None => self.fake.requests(),
        }
    }

    /// Sends an event (`{"event","data"}`) to every subscriber.
    pub fn push_event(&self, event: Value) {
        self.fake.push_event(event);
    }

    /// What `session.snapshot` answers now (the bare snapshot object).
    pub fn snapshot(&self) -> Value {
        lock(&self.state.snapshot).clone()
    }

    /// The rows `pane.read` shows for `pane` now (plain text); empty for a pane the fixture lacks.
    pub fn screen(&self, pane: &str) -> Vec<String> {
        lock(&self.state.screens)
            .get(pane)
            .map(|s| s.rows.clone())
            .unwrap_or_default()
    }

    /// Replaces what `session.snapshot` and `pane.get` answer; the link reads it on its next refresh.
    pub fn set_snapshot(&self, snapshot: Value) {
        *lock(&self.state.snapshot) = snapshot;
    }

    /// Replaces the rows `pane.read` shows for `pane` (plain text; the ansi form is the same rows).
    pub fn set_screen(&self, pane: &str, rows: Vec<String>) {
        let revision = self.state.revision.fetch_add(1, Ordering::Relaxed) + 1;
        lock(&self.state.screens).insert(
            pane.to_owned(),
            Screen {
                rows,
                ansi: None,
                revision,
            },
        );
    }

    /// Scripts what `ssh` prints (and exits 255 with) when the engine tries to reach `dest`, instead of
    /// starting it: `REMOTE HOST IDENTIFICATION HAS CHANGED!` makes the machine need attention, `ssh: connect to
    /// host x port 22: Connection refused` makes it retry. The text goes through the same classifier as real
    /// ssh output. `None` takes the script away. Only machines added after the call are affected.
    pub fn set_ssh_fault(&self, dest: &str, stderr: Option<String>) {
        let mut faults = lock(&self.state.ssh_faults);
        match stderr {
            Some(stderr) => faults.insert(dest.to_owned(), stderr),
            None => faults.remove(dest),
        };
    }

    /// What ssh is scripted to print for `dest`, if anything.
    pub fn ssh_fault(&self, dest: &str) -> Option<String> {
        lock(&self.state.ssh_faults).get(dest).cloned()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // `fake` is dropped after this body; the socket file goes with it, then the directory is removed
        // by the next fixture or the OS temp cleaner if this fails while the socket still exists.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn worktrees_from(spec: &Value) -> Result<Arc<FakeWorktrees>, String> {
    let text = |v: &Value, key: &str| -> Result<String, String> {
        v.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("worktrees: `{key}` must be a string"))
    };
    let mut repos = Vec::new();
    for repo in spec
        .get("repos")
        .and_then(Value::as_array)
        .ok_or("worktrees: `repos` must be an array")?
    {
        let mut made = FakeRepo::new(&text(repo, "root")?);
        for linked in repo
            .get("linked")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
        {
            made = made.linked(&text(linked, "path")?, &text(linked, "branch")?);
        }
        if repo.get("untrusted").and_then(Value::as_bool) == Some(true) {
            made = made.untrusted();
        }
        repos.push(made);
    }
    let fake = FakeWorktrees::new(repos);
    if let Some(at) = spec.get("create_at") {
        fake.create_at(
            at.as_str()
                .ok_or("worktrees: `create_at` must be a string")?,
        );
    }
    Ok(fake)
}

fn screen_from(pane: &str, spec: &Value) -> Result<Screen, String> {
    let rows = |key: &str| -> Result<Option<Vec<String>>, String> {
        match spec.get(key) {
            None => Ok(None),
            Some(Value::Array(rows)) => rows
                .iter()
                .map(|r| {
                    r.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| format!("pane {pane}: `{key}` rows must be strings"))
                })
                .collect::<Result<Vec<_>, _>>()
                .map(Some),
            Some(_) => Err(format!("pane {pane}: `{key}` must be an array of rows")),
        }
    };
    Ok(Screen {
        rows: rows("screen")?.ok_or_else(|| format!("pane {pane}: `screen` is required"))?,
        ansi: rows("ansi")?,
        revision: 1,
    })
}

/// Where fixtures live: `$HERDR_DESKTOP_FIXTURES`, else `fixtures/herdr` under the working directory
/// (`nsh test` runs in the app directory), else the repository's own, found from this crate's manifest.
fn fixtures_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(FIXTURES_ENV).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let candidates = [
        std::env::current_dir().ok()?.join("fixtures/herdr"),
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/herdr"),
    ];
    candidates.into_iter().find(|d| d.is_dir())
}

fn socket_dir() -> Result<PathBuf, String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    // A unix socket path must stay short, so this is directly under the temp directory.
    let dir = std::env::temp_dir().join(format!(
        "hdf-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

fn script(state: &Arc<State>, events: Vec<Value>, answers: Map<String, Value>) -> Script {
    let mut script = Script::new().on_events(events);

    let s = state.clone();
    script = script.on_with("ping", move |_| {
        let snapshot = lock(&s.snapshot);
        Ok(json!({
            "type": "pong",
            "version": snapshot.get("version").cloned().unwrap_or(Value::Null),
            "protocol": snapshot.get("protocol").cloned().unwrap_or(json!(22)),
        }))
    });

    let s = state.clone();
    script = script.on_with("session.snapshot", move |_| {
        Ok(json!({"type": "session_snapshot", "snapshot": lock(&s.snapshot).clone()}))
    });

    let s = state.clone();
    script = script.on_with("pane.get", move |params| {
        let id = params
            .get("pane_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let snapshot = lock(&s.snapshot);
        let pane = snapshot
            .get("panes")
            .and_then(Value::as_array)
            .and_then(|panes| {
                panes
                    .iter()
                    .find(|p| p.get("pane_id").and_then(Value::as_str) == Some(id))
            });
        match pane {
            Some(pane) => Ok(json!({"type": "pane_info", "pane": pane})),
            None => Err(("pane_not_found".to_owned(), format!("no pane {id}"))),
        }
    });

    let s = state.clone();
    script = script.on_with("pane.read", move |params| read(&s, params));

    for method in OK_METHODS {
        script = script.on(method, json!({"type": "ok"}));
    }
    script = create_methods(script);
    for (method, result) in answers {
        script = script.on(&method, result);
    }
    script
}

/// What the methods that create something answer by default: ids that tests can recognise.
fn create_methods(script: Script) -> Script {
    let pane = |id: &str, workspace: &str, tab: &str| {
        json!({"pane_id": id, "workspace_id": workspace, "tab_id": tab, "terminal_id": "t-new",
               "focused": false, "agent_status": "unknown", "revision": 1})
    };
    let tab = |id: &str, workspace: &str| {
        json!({"tab_id": id, "workspace_id": workspace, "number": 1, "label": "new", "focused": false,
               "pane_count": 1, "agent_status": "unknown"})
    };
    let created_tab = tab("w9:t1", "w9");
    let root = pane("w9:p1", "w9", "w9:t1");
    let workspace = json!({"workspace_id": "w9", "number": 9, "label": "new", "focused": false,
        "pane_count": 1, "tab_count": 1, "active_tab_id": "w9:t1", "agent_status": "unknown"});
    script
        .on(
            "workspace.create",
            json!({"type": "workspace_created", "workspace": workspace, "tab": created_tab, "root_pane": root}),
        )
        .on(
            "tab.create",
            json!({"type": "tab_created", "tab": tab("w1:t9", "w1"), "root_pane": pane("w1:p9", "w1", "w1:t9")}),
        )
        .on(
            "pane.split",
            json!({"type": "pane_info", "pane": pane("w1:p8", "w1", "w1:t1")}),
        )
        .on_with("agent.start", |params| {
            let id = params.get("pane_id").cloned().unwrap_or(Value::Null);
            Ok(json!({"type": "agent_started", "argv": [],
                "agent": {"pane_id": id, "workspace_id": "w9", "tab_id": "w9:t1", "agent_status": "working"}}))
        })
}

/// `pane.read`: the pane's rows as plain text or ansi, the last `lines` of them.
fn read(state: &State, params: &Value) -> Result<Value, (String, String)> {
    let id = params
        .get("pane_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let source = params
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("visible");
    let format = params
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("text");
    let screens = lock(&state.screens);
    let Some(screen) = screens.get(id) else {
        return Err(("pane_not_found".to_owned(), format!("no pane {id}")));
    };
    let rows = if format == "ansi" {
        screen.ansi.as_ref().unwrap_or(&screen.rows)
    } else {
        &screen.rows
    };
    let keep = match params.get("lines").and_then(Value::as_u64) {
        Some(n) => usize::try_from(n).unwrap_or(usize::MAX).min(rows.len()),
        None => rows.len(),
    };
    let shown = &rows[rows.len() - keep..];
    let separator = if format == "ansi" { "\r\n" } else { "\n" };
    let snapshot = lock(&state.snapshot);
    let pane = snapshot
        .get("panes")
        .and_then(Value::as_array)
        .and_then(|panes| {
            panes
                .iter()
                .find(|p| p.get("pane_id").and_then(Value::as_str) == Some(id))
        });
    let field = |name: &str| {
        pane.and_then(|p| p.get(name))
            .cloned()
            .unwrap_or_else(|| json!(""))
    };
    Ok(json!({
        "type": "pane_read",
        "read": {
            "pane_id": id,
            "workspace_id": field("workspace_id"),
            "tab_id": field("tab_id"),
            "source": source,
            "format": format,
            "text": shown.join(separator),
            "revision": screen.revision,
            "truncated": keep < rows.len(),
        }
    }))
}
