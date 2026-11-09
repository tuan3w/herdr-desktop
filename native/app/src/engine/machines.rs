//! The machine list: add, change, remove, test, and the `~/.ssh/config` aliases that fill the form.
//!
//! A machine is validated (`SshTarget::new`) before it is stored or any process starts. There is no
//! password and no key here: `ssh` brings its own identity, agent and host-key trust.

use std::sync::Arc;
use std::time::Duration;

use herdr_core::link::LocalWire;
use herdr_core::ssh::SshTarget;
use herdr_core::store::Machine;
use herdr_core::wire::Wire;
use serde_json::json;

use super::{Fleet, unknown};

/// How long a connection test may take: an ssh login with a slow network needs more than a request.
const TEST_TIMEOUT: Duration = Duration::from_secs(30);

/// What the machine form submits.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MachineInput {
    /// The machine being changed; `None` adds a new one.
    pub id: Option<String>,
    /// What the person calls it.
    pub name: String,
    /// `user@host` or an ssh config alias; empty only for a connection test of this computer.
    pub dest: String,
    /// The ssh port when not the default.
    pub port: Option<u16>,
    /// herdr's session on that machine; the default session when `None` or empty.
    pub session: Option<String>,
    /// Whether the machine is switched on.
    pub enabled: bool,
}

/// How a connection test ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connection {
    /// Whether herdr answered.
    pub ok: bool,
    /// herdr's version when it answered.
    pub version: Option<String>,
    /// Workspaces herdr has, when it answered.
    pub workspaces: Option<usize>,
    /// What to show: `Connected · herdr 0.9.5 · 3 workspaces`, or why not and what to do.
    pub message: String,
}

impl Fleet {
    /// This computer first, then the machines that were added.
    pub fn machines(&self) -> Vec<Machine> {
        self.machines.lock().all()
    }

    /// Adds a machine or changes one. Returns it as stored. A change of destination, port or session
    /// starts a fresh link; a change of `enabled` switches the existing one.
    pub fn save_machine(&self, input: MachineInput) -> Result<Machine, String> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err("Give the machine a name".to_owned());
        }
        let dest = input.dest.trim();
        let session = input
            .session
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        SshTarget::new(dest, input.port, session, None).map_err(|e| e.to_string())?;

        let mut machines = self.machines.lock();
        let id = match &input.id {
            Some(id) if id == herdr_core::store::LOCAL_ID => {
                return Err("This computer is always listed and cannot be changed".to_owned());
            }
            Some(id) => {
                if machines.get(id).is_none() {
                    return Err(unknown(id));
                }
                id.clone()
            }
            None => machines.next_id(),
        };
        let machine = Machine {
            id,
            name: name.to_owned(),
            dest: dest.to_owned(),
            port: input.port,
            session: session.map(str::to_owned),
            enabled: input.enabled,
        };
        let before = machines.get(&machine.id);
        machines.upsert(machine.clone());
        self.store
            .save_machines(&machines)
            .map_err(|e| format!("cannot save the machines: {e}"))?;

        let moved = before.as_ref().is_some_and(|b| {
            b.dest != machine.dest || b.port != machine.port || b.session != machine.session
        });
        match (&before, moved) {
            (None, _) => {
                self.start_link(&machine);
            }
            (Some(_), true) => {
                self.drop_link(&machine.id);
                self.first_seen.lock().forget_machine(&machine.id);
                self.previews.forget_machine(&machine.id);
                // Its old board must not seed the new link; the saved chats go once the old host's sessions let go (below).
                self.cache.forget_machine(&machine.id);
                self.start_link(&machine);
            }
            (Some(_), false) => {
                if let Some(link) = self.link(&machine.id) {
                    link.set_enabled(machine.enabled);
                }
            }
        }
        drop(machines);
        self.sync_keeper_host(&machine, moved || before.is_none());
        if moved {
            // After the old host's sessions let go (they save their copies as they do): what was kept was another computer's.
            self.cache.forget_machine(&machine.id);
        }
        self.bump();
        Ok(machine)
    }

    /// Removes a machine and everything remembered about it (its reviewed marks included).
    pub fn remove_machine(&self, id: &str) -> Result<(), String> {
        if id == herdr_core::store::LOCAL_ID {
            return Err("This computer is always listed and cannot be removed".to_owned());
        }
        let mut machines = self.machines.lock();
        if !machines.remove(id) {
            return Err(unknown(id));
        }
        self.store
            .save_machines(&machines)
            .map_err(|e| format!("cannot save the machines: {e}"))?;
        drop(machines);
        self.drop_link(id);
        self.sessions.remove_host(id);
        self.first_seen.lock().forget_machine(id);
        self.previews.forget_machine(id);
        self.cache.forget_machine(id);
        {
            let mut reviewed = self.reviewed.lock();
            reviewed.forget_machine(id);
            if let Err(e) = self.store.save_reviewed(&reviewed) {
                return Err(format!(
                    "the machine was removed, but its marks could not be saved: {e}"
                ));
            }
        }
        self.refresh_machine_watches(id);
        self.bump();
        Ok(())
    }

    /// The PIDs of the ssh processes this machine's link started and that are still running: the only
    /// processes the app may signal for it (tests cut a connection with them). Empty for this computer.
    pub fn ssh_children(&self, machine: &str) -> Vec<u32> {
        self.link(machine)
            .map(|link| link.wire().child_pids())
            .unwrap_or_default()
    }

    /// Takes a link out and stops it on its own thread: stopping waits for its request in flight, which
    /// the caller (the UI) must not.
    fn drop_link(&self, id: &str) {
        let mut links = self.links.write();
        if let Some(at) = links.iter().position(|(m, _)| m == id) {
            let (_, link) = links.remove(at);
            std::thread::spawn(move || drop(link));
        }
    }

    /// Connects once without touching the machine list: `ping`, then the snapshot for a count. An empty
    /// destination tests this computer. Blocks for up to 30 s; call it off the UI thread.
    pub fn test_connection(&self, input: &MachineInput) -> Connection {
        let failure = |message: String| Connection {
            ok: false,
            version: None,
            workspaces: None,
            message,
        };
        let wire: Arc<dyn Wire> = if input.dest.trim().is_empty() {
            Arc::new(LocalWire::new(&self.local_socket))
        } else {
            let machine = Machine {
                id: "test".to_owned(),
                name: input.name.clone(),
                dest: input.dest.trim().to_owned(),
                port: input.port,
                session: input.session.clone().filter(|s| !s.trim().is_empty()),
                enabled: true,
            };
            self.remote_wire(&machine)
        };
        let pong = match wire.request("ping", json!({}), TEST_TIMEOUT) {
            Ok(pong) => pong,
            Err(e) => return failure(e.message),
        };
        let version = pong
            .get("version")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        let workspaces = wire
            .request("session.snapshot", json!({}), TEST_TIMEOUT)
            .ok()
            .and_then(|r| herdr_core::schema::Snapshot::from_result(&r).ok())
            .map(|s| s.workspaces.len());
        let mut message = match &version {
            Some(v) => format!("Connected · herdr {v}"),
            None => "Connected".to_owned(),
        };
        if let Some(n) = workspaces {
            message.push_str(&format!(
                " · {n} {}",
                if n == 1 { "workspace" } else { "workspaces" }
            ));
        }
        Connection {
            ok: true,
            version,
            workspaces,
            message,
        }
    }
}
