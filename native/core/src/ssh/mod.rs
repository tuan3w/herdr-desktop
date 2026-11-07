//! `ssh`: remote machines through the system `ssh` binary, no in-process SSH stack.
//!
//! `ssh` brings `~/.ssh/config`, agents, ProxyJump and Tailscale SSH; one `ControlMaster` connection
//! per machine is shared by the relay, the event stream and one-shot commands. A small python relay
//! (`relay.py`) runs next to herdr because herdr's socket serves one request per connection.
//! Everything that reaches the remote shell is quoted by [`shq`], and every destination, session and
//! socket path is validated in [`SshTarget::new`] before any process starts.

mod classify;
mod command;
mod config;
mod proc;
mod relay;
mod validate;
mod wire;

pub use classify::{SSH_FAILED, classify_ssh};
pub(crate) use command::spawn_error;
pub use command::{Output, SshClient, control_dir_for};
pub use config::{config_hosts, default_config_path};
pub(crate) use proc::{Proc, spawn};
pub use relay::{
    BRIDGE_SCRIPT, COMPRESS_MIN, READY_LINE, RELAY_SCRIPT, argv_command, base64, bridge_command,
    relay_command, socket_word, wrap_sh,
};
pub use validate::{InvalidTarget, SshTarget, shq, validate_dest, validate_name};
pub use wire::SshWire;
