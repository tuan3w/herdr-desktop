//! Agent sessions in the engine: the [`SessionHub`], a keeper host per machine, and the test seam.
//!
//! The hub tells the engine when a listing or a session changed by the same `Bump` every other change
//! uses, so the UI keeps one change counter (`Herdr.onChange`) and pulls sessions with `Sessions.view`.
//! Which keepers this app started (the only ones it ends) is a setting, so a restart remembers.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};

use crossbeam_channel::Sender;
use herdr_core::session::{HubConfig, KeeperHost, SessionHub};
use herdr_core::ssh::SshTarget;
use herdr_core::store::{LOCAL_ID, Machine};
use serde_json::json;

use super::{Fleet, Note};

/// The setting that remembers the keepers this app started, as `machine/id`.
pub(super) const OWNED_KEY: &str = "sessions.owned";

/// Test seam: the path of a scripted ACP agent. Under a fixture the local machine's keeper runs in a
/// home of its own with this as its only agent (`omp`). Without the variable the repository's own
/// `native/core/tests/support/fake_acp_agent.py` runs (a superset of herdr-mobile's: every `FAKE_ACP_*`
/// variable of the test process reaches it, see the script's header).
pub const FAKE_AGENT_ENV: &str = "HERDR_DESKTOP_FAKE_AGENT";

/// The repository's scripted ACP agent, relative to this crate.
const FAKE_AGENT_IN_CORE: &str = "../core/tests/support/fake_acp_agent.py";

/// A cell the hub's callbacks reach the fleet through once it exists (the hub is built first).
pub(super) type FleetCell = Arc<OnceLock<Weak<Fleet>>>;

/// Builds the hub: changes bump the engine's tick, and the list of started keepers is saved as a setting.
pub(super) fn build_hub(owned: Vec<String>, notes: Sender<Note>, fleet: FleetCell) -> SessionHub {
    let mut config = HubConfig::new(Arc::new(move || {
        let _ = notes.send(Note::Bump);
    }));
    config.owned = owned;
    config.on_owned = Arc::new(move |all| {
        if let Some(fleet) = fleet.get().and_then(Weak::upgrade)
            && let Err(e) = fleet.set_setting(OWNED_KEY, json!(all))
        {
            eprintln!("herdr-desktop: cannot save the sessions this app started: {e}");
        }
    });
    SessionHub::new(config)
}

impl Fleet {
    /// The sessions: hosts, listings, attached conversations.
    pub fn sessions(&self) -> &SessionHub {
        &self.sessions
    }

    /// Under the test seam, ends the keepers the engine started: they live in a temporary home and a test
    /// that failed halfway must not leave an agent running. In production nothing is ended here, by design:
    /// the agents outlive the app.
    pub(super) fn end_seam_sessions(&self) {
        if self.fixture.is_none() {
            return;
        }
        if let Ok(all) = self.sessions.list(LOCAL_ID) {
            for keeper in all {
                let _ = self.sessions.kill(LOCAL_ID, &keeper.id);
            }
        }
    }

    /// Makes the hub's host for `machine` match the machine list: switched-off machines have none, and a
    /// machine whose address moved gets a new one (its sessions detach: they were on another computer).
    pub(super) fn sync_keeper_host(&self, machine: &Machine, moved: bool) {
        if !machine.enabled {
            self.sessions.remove_host(&machine.id);
            return;
        }
        if !moved && self.sessions.has_host(&machine.id) {
            return;
        }
        match self.keeper_host(machine) {
            Ok(host) => self.sessions.set_host(&machine.id, Arc::new(host)),
            Err(why) => {
                self.sessions.remove_host(&machine.id);
                eprintln!(
                    "herdr-desktop: no agent sessions on {}: {why}",
                    machine.name
                );
            }
        }
    }

    fn keeper_host(&self, machine: &Machine) -> Result<KeeperHost, String> {
        if machine.id == LOCAL_ID || machine.is_local() {
            return self.local_keeper_host();
        }
        let client = self
            .ssh
            .clone()
            .ok_or_else(|| "ssh is unavailable".to_owned())?;
        let target = SshTarget::new(
            &machine.dest,
            machine.port,
            machine.session.as_deref(),
            None,
        )
        .map_err(|e| e.to_string())?;
        Ok(KeeperHost::remote(client, target, self.script_home()?))
    }

    /// The computer's own keeper: in the person's home, or, under the test seam, in a home of its own so a
    /// test never touches the real one or starts a real agent.
    fn local_keeper_host(&self) -> Result<KeeperHost, String> {
        if self.fixture.is_none() {
            return Ok(KeeperHost::local(self.script_home()?));
        }
        let home = self.store.dir().join("session-home");
        let bin = home.join("bin");
        std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
        if let Some(agent) = fake_agent() {
            write_shim(&bin.join("omp"), &agent)?;
        }
        Ok(KeeperHost::local(&home).env("PATH", format!("{}:/usr/bin:/bin", bin.display())))
    }

    /// The person's home: where the keeper script is written locally and read from for a remote install.
    fn script_home(&self) -> Result<PathBuf, String> {
        if self.fixture.is_some() {
            return Ok(self.store.dir().join("session-home"));
        }
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|h| h.is_absolute())
            .ok_or_else(|| "there is no home folder".to_owned())
    }
}

/// The scripted agent the test seam runs as `omp`, if there is one.
fn fake_agent() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(FAKE_AGENT_ENV) {
        return Some(PathBuf::from(path));
    }
    Some(Path::new(env!("CARGO_MANIFEST_DIR")).join(FAKE_AGENT_IN_CORE))
        .filter(|path| path.is_file())
}

/// An `omp` that is the scripted agent.
fn write_shim(path: &Path, agent: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let text = format!(
        "#!/bin/sh\nexec python3 {}\n",
        herdr_core::ssh::shq(&agent.display().to_string())
    );
    std::fs::write(path, text).map_err(|e| e.to_string())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())
}
