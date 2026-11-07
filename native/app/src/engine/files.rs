//! The files and pages of a machine: which implementation serves it, and where copies are kept.

use std::path::PathBuf;
use std::sync::Arc;

use herdr_core::files::{Files, LocalFiles, RemoteFiles, Tunnel};
use herdr_core::git::{Git, LocalGit, RemoteGit, UndoStore};
use herdr_core::ssh::SshTarget;
use herdr_core::store::Machine;

use super::{Fleet, unknown};

impl Fleet {
    /// The machine `id`, or the sentence for an unknown one.
    fn machine_of(&self, id: &str) -> Result<Machine, String> {
        self.machines.lock().get(id).ok_or_else(|| unknown(id))
    }

    /// The target and ssh client of a remote machine, or why it cannot be reached at all.
    fn remote_of(
        &self,
        machine: &Machine,
    ) -> Result<(herdr_core::ssh::SshClient, SshTarget), String> {
        let client = self.ssh.clone().ok_or_else(|| {
            "ssh is unavailable: its control directory could not be created".to_owned()
        })?;
        let target = SshTarget::new(
            &machine.dest,
            machine.port,
            machine.session.as_deref(),
            None,
        )
        .map_err(|e| e.to_string())?;
        Ok((client, target))
    }

    /// The files of machine `id`: this computer's through `std::fs`, another machine's through its
    /// shared ssh connection.
    pub fn files_of(&self, id: &str) -> Result<Arc<dyn Files>, String> {
        let machine = self.machine_of(id)?;
        if machine.is_local() {
            return Ok(Arc::new(LocalFiles::new()));
        }
        let (client, target) = self.remote_of(&machine)?;
        Ok(Arc::new(RemoteFiles::new(client, target)))
    }

    /// The git of machine `id`: this computer's through `std::process::Command`, another machine's through its
    /// shared ssh connection.
    pub fn git_of(&self, id: &str) -> Result<Git, String> {
        let machine = self.machine_of(id)?;
        if machine.is_local() {
            return Ok(Git::new(Arc::new(LocalGit::new())));
        }
        let (client, target) = self.remote_of(&machine)?;
        Ok(Git::new(Arc::new(RemoteGit::new(client, target))))
    }

    /// Where a reverted change waits for `Undo` (ten minutes): inside the data directory, which only this user can read.
    pub fn changes_undo(&self) -> UndoStore {
        UndoStore::new(self.store.dir().join("changes-undo"))
    }

    /// Whether machine `id` is the computer the app runs on.
    pub fn is_local_machine(&self, id: &str) -> Result<bool, String> {
        Ok(self.machine_of(id)?.is_local())
    }

    /// A forward from this computer to `remote_port` on machine `id`'s localhost. Blocks (ssh): call it
    /// off the UI thread. This computer needs none: its pages are already reachable.
    pub fn open_tunnel(&self, id: &str, remote_port: u16) -> Result<Tunnel, String> {
        let machine = self.machine_of(id)?;
        if machine.is_local() {
            return Err(
                "This computer's pages open in the browser; they need no tunnel".to_owned(),
            );
        }
        let (client, target) = self.remote_of(&machine)?;
        Tunnel::open(client, target, remote_port).map_err(|e| e.message)
    }

    /// Where copies of remote pictures are kept: inside the data directory, emptied when the engine starts
    /// (a copy is only a cache, and a long-running app must not grow without bound).
    pub fn files_cache(&self) -> PathBuf {
        self.store.dir().join("cache").join("files")
    }
}

impl Fleet {
    /// Where the test seam puts its scripted folder (`Files.testTree`).
    pub fn test_tree_dir(&self) -> PathBuf {
        self.store.dir().join("test-tree")
    }
}
