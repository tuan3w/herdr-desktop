//! What the app keeps on disk: machines, the "reviewed" marks, settings and what was visited last.
//!
//! Each is one small versioned JSON file (`{"v":1,...}`) in the data directory, written atomically
//! (temp file in the same directory, then `rename`) with mode 0600 in a 0700 directory. A file the
//! app cannot read is never lost and never silently replaced: it is renamed to `<name>.corrupt` (or
//! `<name>.newer` when a newer app wrote it), the store starts empty and says so in the returned
//! warning.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::recents::{Entry, Recents};
use crate::schema::{AgentStatus, Snapshot};

/// Identifies a machine across the app: `"local"` for this computer, a generated id otherwise.
pub type MachineId = String;

/// The id of the implicit machine this app runs on.
pub const LOCAL_ID: &str = "local";

/// The directory name under `dirs::data_dir()`.
const APP_DIR: &str = "dev.herdrmobile.herdr_desktop";

/// The format version every file is written with.
const VERSION: u64 = 1;

/// A machine whose herdr the app supervises.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub id: MachineId,
    pub name: String,
    /// `user@host` or an ssh config alias; empty for this computer. Validated by the ssh module
    /// before any process starts, only stored here.
    pub dest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The herdr session name on that machine; `None` is the default session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub enabled: bool,
}

impl Machine {
    /// This computer: always present, never stored, reached over herdr's local socket.
    pub fn local() -> Self {
        Self {
            id: LOCAL_ID.to_owned(),
            name: "This computer".to_owned(),
            dest: String::new(),
            port: None,
            session: None,
            enabled: true,
        }
    }

    /// Whether this is [`Machine::local`].
    pub fn is_local(&self) -> bool {
        self.id == LOCAL_ID
    }
}

/// The machines the person added (never the implicit local one).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Machines {
    remote: Vec<Machine>,
}

impl Machines {
    /// This computer first, then the added machines in the order they were added.
    pub fn all(&self) -> Vec<Machine> {
        std::iter::once(Machine::local())
            .chain(self.remote.iter().cloned())
            .collect()
    }

    /// The machine with this id (the local one included).
    pub fn get(&self, id: &str) -> Option<Machine> {
        if id == LOCAL_ID {
            Some(Machine::local())
        } else {
            self.remote.iter().find(|m| m.id == id).cloned()
        }
    }

    /// An id no stored machine has.
    pub fn next_id(&self) -> MachineId {
        (1u64..)
            .map(|n| format!("m{n}"))
            .find(|id| !self.remote.iter().any(|m| &m.id == id))
            .expect("an unbounded range always yields a free id")
    }

    /// Adds the machine, or replaces the one with its id. The local machine is not stored.
    pub fn upsert(&mut self, machine: Machine) {
        if machine.is_local() {
            return;
        }
        match self.remote.iter_mut().find(|m| m.id == machine.id) {
            Some(slot) => *slot = machine,
            None => self.remote.push(machine),
        }
    }

    /// Removes the machine; false when there was none.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.remote.len();
        self.remote.retain(|m| m.id != id);
        self.remote.len() != before
    }
}

/// One finished state of one agent: reviewed means the person looked at exactly this episode.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ReviewKey {
    pub machine: MachineId,
    pub pane_id: String,
    /// The agent's `state_change_seq` while it was done.
    pub seq: u64,
}

impl ReviewKey {
    /// The key of an agent's current episode.
    pub fn new(machine: &str, pane_id: &str, seq: u64) -> Self {
        Self {
            machine: machine.to_owned(),
            pane_id: pane_id.to_owned(),
            seq,
        }
    }
}

/// The finished episodes the person has looked at. A `done` agent is "to review" until its key is here.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Reviewed {
    keys: BTreeSet<ReviewKey>,
}

impl Reviewed {
    /// Whether this episode was reviewed.
    pub fn is_reviewed(&self, key: &ReviewKey) -> bool {
        self.keys.contains(key)
    }

    /// Marks an episode reviewed; false when it already was.
    pub fn review(&mut self, key: ReviewKey) -> bool {
        self.keys.insert(key)
    }

    /// Takes the mark back; false when there was none.
    pub fn unreview(&mut self, key: &ReviewKey) -> bool {
        self.keys.remove(key)
    }

    /// How many episodes are marked.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// Whether nothing is marked.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Drops the marks a live snapshot of `machine` makes meaningless: an agent herdr no longer has,
    /// or one that is not `done` any more. A mark names one finished episode; once the agent left it,
    /// the mark must not be able to match a later one (herdr's sequence numbers start over when its
    /// server restarts). Returns whether anything was dropped.
    pub fn reconcile(&mut self, machine: &str, live: &Snapshot) -> bool {
        let before = self.keys.len();
        self.keys.retain(|k| {
            k.machine != machine
                || live
                    .agents
                    .iter()
                    .any(|a| a.pane_id == k.pane_id && a.agent_status == AgentStatus::Done)
        });
        self.keys.len() != before
    }

    /// Drops every mark of a machine that was removed.
    pub fn forget_machine(&mut self, machine: &str) {
        self.keys.retain(|k| k.machine != machine);
    }
}

/// The app's settings: an open JSON object so each feature adds typed accessors without a schema
/// migration. Keys are stored beside the `v` field.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Settings {
    map: Map<String, Value>,
}

impl Settings {
    /// The value of `key`, if present and of type `T`.
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.map.get(key).and_then(|v| T::deserialize(v).ok())
    }

    /// [`Settings::get`] with a default for a missing or unreadable value.
    pub fn get_or<T: DeserializeOwned>(&self, key: &str, default: T) -> T {
        self.get(key).unwrap_or(default)
    }

    /// Sets `key`. `v` is reserved for the file's version and is refused.
    pub fn set<T: Serialize>(&mut self, key: &str, value: T) -> Result<(), serde_json::Error> {
        if key == "v" {
            return Err(serde::ser::Error::custom("the key `v` is the file version"));
        }
        self.map
            .insert(key.to_owned(), serde_json::to_value(value)?);
        Ok(())
    }

    /// Removes `key`; false when it was not set.
    pub fn remove(&mut self, key: &str) -> bool {
        self.map.remove(key).is_some()
    }

    /// Every stored key.
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.map.keys().map(String::as_str)
    }
}

/// A value read from disk, with what went wrong if the file could not be used.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded<T> {
    pub value: T,
    /// Set when the file was unreadable and was kept aside; the value is then empty.
    pub warning: Option<String>,
}

/// The data directory and the files in it.
#[derive(Debug, Clone)]
pub struct Store {
    dir: PathBuf,
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

impl Store {
    /// `<data dir>/dev.herdrmobile.herdr_desktop`, the directory the app uses when nothing else is given.
    pub fn default_dir() -> PathBuf {
        dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(APP_DIR)
    }

    /// Opens (creating, mode 0700) the directory. An empty path means a fresh directory under the
    /// system temp dir, for tests and for a host with no data directory.
    pub fn open(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref();
        let dir = if dir.as_os_str().is_empty() {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            std::env::temp_dir().join(format!("herdr-desktop-{}-{n}", std::process::id()))
        } else {
            dir.to_path_buf()
        };
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        Ok(Self { dir })
    }

    /// The directory files live in.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Loads `machines.json`.
    pub fn machines(&self) -> Loaded<Machines> {
        #[derive(Deserialize)]
        struct File {
            machines: Vec<Machine>,
        }
        self.load("machines.json", |doc| {
            let file: File =
                serde_json::from_value(Value::Object(doc)).map_err(|e| e.to_string())?;
            let mut machines = Machines::default();
            for m in file.machines {
                machines.upsert(m);
            }
            Ok(machines)
        })
    }

    /// Writes `machines.json`.
    pub fn save_machines(&self, machines: &Machines) -> io::Result<()> {
        self.write(
            "machines.json",
            [("machines", serde_json::to_value(&machines.remote)?)],
        )
    }

    /// Loads `reviewed.json`.
    pub fn reviewed(&self) -> Loaded<Reviewed> {
        #[derive(Deserialize)]
        struct File {
            reviewed: Vec<ReviewKey>,
        }
        self.load("reviewed.json", |doc| {
            let file: File =
                serde_json::from_value(Value::Object(doc)).map_err(|e| e.to_string())?;
            Ok(Reviewed {
                keys: file.reviewed.into_iter().collect(),
            })
        })
    }

    /// Writes `reviewed.json`.
    pub fn save_reviewed(&self, reviewed: &Reviewed) -> io::Result<()> {
        self.write(
            "reviewed.json",
            [("reviewed", serde_json::to_value(&reviewed.keys)?)],
        )
    }

    /// Loads `settings.json`.
    pub fn settings(&self) -> Loaded<Settings> {
        self.load("settings.json", |doc| Ok(Settings { map: doc }))
    }

    /// Writes `settings.json`.
    pub fn save_settings(&self, settings: &Settings) -> io::Result<()> {
        self.write(
            "settings.json",
            settings.map.iter().map(|(k, v)| (k.as_str(), v.clone())),
        )
    }

    /// Loads `recents.json`.
    pub fn recents(&self) -> Loaded<Recents> {
        #[derive(Deserialize)]
        struct File {
            recents: Vec<Entry>,
        }
        self.load("recents.json", |doc| {
            let file: File =
                serde_json::from_value(Value::Object(doc)).map_err(|e| e.to_string())?;
            Ok(Recents::from_entries(file.recents))
        })
    }

    /// Writes `recents.json`.
    pub fn save_recents(&self, recents: &Recents) -> io::Result<()> {
        self.write(
            "recents.json",
            [("recents", serde_json::to_value(recents.entries())?)],
        )
    }

    fn load<T: Default>(
        &self,
        name: &str,
        build: impl FnOnce(Map<String, Value>) -> Result<T, String>,
    ) -> Loaded<T> {
        let path = self.dir.join(name);
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                return Loaded {
                    value: T::default(),
                    warning: None,
                };
            }
            Err(e) => {
                return Loaded {
                    value: T::default(),
                    warning: Some(format!("{name} could not be read: {e}")),
                };
            }
        };
        match parse(&bytes, build) {
            Ok(value) => Loaded {
                value,
                warning: None,
            },
            Err((suffix, reason)) => {
                let kept = self.dir.join(format!("{name}.{suffix}"));
                let moved = fs::rename(&path, &kept);
                let warning = match moved {
                    Ok(()) => format!("{name} {reason}; it was kept as {}", kept.display()),
                    Err(e) => format!("{name} {reason}, and could not be set aside: {e}"),
                };
                Loaded {
                    value: T::default(),
                    warning: Some(warning),
                }
            }
        }
    }

    fn write<'a>(
        &self,
        name: &str,
        fields: impl IntoIterator<Item = (&'a str, Value)>,
    ) -> io::Result<()> {
        let mut doc = Map::new();
        doc.insert("v".to_owned(), Value::from(VERSION));
        doc.extend(fields.into_iter().map(|(k, v)| (k.to_owned(), v)));
        let mut bytes = serde_json::to_vec_pretty(&Value::Object(doc))?;
        bytes.push(b'\n');

        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = self
            .dir
            .join(format!(".{name}.{}-{n}.tmp", std::process::id()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&tmp, self.dir.join(name))
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }
}

/// Reads and migrates one file; `Err((suffix to keep it under, reason))` when it cannot be used.
fn parse<T>(
    bytes: &[u8],
    build: impl FnOnce(Map<String, Value>) -> Result<T, String>,
) -> Result<T, (&'static str, String)> {
    let Value::Object(mut doc) = serde_json::from_slice(bytes)
        .map_err(|e| ("corrupt", format!("is not valid JSON ({e})")))?
    else {
        return Err(("corrupt", "is not a JSON object".to_owned()));
    };
    let version = doc
        .remove("v")
        .and_then(|v| v.as_u64())
        .ok_or(("corrupt", "has no version".to_owned()))?;
    if version > VERSION {
        return Err((
            "newer",
            format!("was written by a newer version of the app (format {version})"),
        ));
    }
    let doc = migrate(version, doc).map_err(|e| ("corrupt", e))?;
    build(doc).map_err(|e| ("corrupt", format!("cannot be read ({e})")))
}

/// Brings a document of an older format up to [`VERSION`]. Format 1 is the first, so there is
/// nothing to convert yet; the match is where the next format's conversion goes.
fn migrate(version: u64, doc: Map<String, Value>) -> Result<Map<String, Value>, String> {
    match version {
        VERSION => Ok(doc),
        other => Err(format!("has an unknown format ({other})")),
    }
}
