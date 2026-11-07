//! Local port forwards on a machine's shared connection (`ssh -O forward`), for pages a machine serves.

use std::process::{Command, Stdio};
use std::time::Duration;

use super::SshClient;
use crate::ssh::classify::{SSH_FAILED, classify_ssh};
use crate::ssh::validate::SshTarget;
use crate::wire::WireError;

/// How long the connection may take to come up when no master is running yet.
const MASTER_TIMEOUT: Duration = Duration::from_secs(30);

impl SshClient {
    /// Makes `127.0.0.1:local_port` on this computer reach `localhost:remote_port` as the machine sees
    /// it, over the machine's shared connection: no new login, and no listener on any other address.
    ///
    /// A shared connection is started first when none is running (an idle one lingers for
    /// `ControlPersist` seconds, so a forward set up after the link dropped still works). The forward
    /// lives as long as that connection or until [`SshClient::cancel_forward`].
    pub fn forward(
        &self,
        target: &SshTarget,
        local_port: u16,
        remote_port: u16,
    ) -> Result<(), WireError> {
        // `true` costs nothing and makes ControlMaster=auto open the master that `-O forward` needs.
        self.run_checked(target, &["true"], &[], MASTER_TIMEOUT)?;
        self.control(target, "forward", local_port, remote_port)
    }

    /// Removes a forward made by [`SshClient::forward`] (a forward that is already gone is not an error).
    pub fn cancel_forward(
        &self,
        target: &SshTarget,
        local_port: u16,
        remote_port: u16,
    ) -> Result<(), WireError> {
        self.control(target, "cancel", local_port, remote_port)
    }

    fn control(
        &self,
        target: &SshTarget,
        request: &str,
        local_port: u16,
        remote_port: u16,
    ) -> Result<(), WireError> {
        let spec = forward_spec(local_port, remote_port);
        let mut command = Command::new(&self.program);
        command.args(self.args(target, &["-O", request, "-L", &spec], None));
        let output = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(super::spawn_error)?;
        if output.status.success() {
            return Ok(());
        }
        let code = output.status.code();
        let stderr = String::from_utf8_lossy(&output.stderr);
        if code == Some(SSH_FAILED) {
            return Err(classify_ssh(code, &stderr, target.dest()));
        }
        Err(WireError::retryable(format!(
            "could not {request} the port forward on {}: {}",
            target.dest(),
            stderr.lines().last().unwrap_or("ssh refused").trim()
        )))
    }
}

/// The `-L` argument: bound to the loopback address only, so the page is reachable from this
/// computer and nowhere else on the network. The machine resolves `localhost` itself, which is how a
/// dev server that listens on IPv6 only is still found.
pub(crate) fn forward_spec(local_port: u16, remote_port: u16) -> String {
    format!("127.0.0.1:{local_port}:localhost:{remote_port}")
}
