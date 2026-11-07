//! Why a session operation did not happen, in the words the person reads.
//!
//! The keeper commands end with a status that means something (`keeper_command.dart` in herdr-mobile
//! lists them); [`KeeperError::from_exit`] maps each to a kind with the phone's wording, so both apps
//! say the same thing about the same failure.

use thiserror::Error;

use crate::wire::WireError;

/// The keeper commands' exit statuses.
pub mod exit {
    /// Bad arguments: a bug in the caller.
    pub const USAGE: i32 = 64;
    /// The keeper script is not on the machine.
    pub const NOT_INSTALLED: i32 = 65;
    /// The folder is not there, or there is no such keeper.
    pub const GONE: i32 = 66;
    /// The keeper's agent has exited.
    pub const EXITED: i32 = 67;
    /// The agent is not installed on the machine.
    pub const AGENT_MISSING: i32 = 69;
    /// The agent failed to start or to answer `initialize`.
    pub const AGENT_FAILED: i32 = 70;
    /// `python3` is missing.
    pub const NO_PYTHON: i32 = 78;
    /// The shell found no `python3` to run (`exec: not found`).
    pub const COMMAND_NOT_FOUND: i32 = 127;
}

/// What went wrong with a keeper operation.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum KeeperError {
    /// `python3` is missing on the machine.
    #[error("{0}")]
    NoPython(String),
    /// The keeper script is not on the machine and could not be put there.
    #[error("{0}")]
    NotInstalled(String),
    /// The folder or the session does not exist on the machine.
    #[error("{0}")]
    Gone(String),
    /// The session's agent has exited.
    #[error("{0}")]
    AgentExited(String),
    /// The agent is not installed on the machine.
    #[error("{0}")]
    AgentMissing(String),
    /// The agent failed to start or to answer `initialize`.
    #[error("{0}")]
    AgentFailed(String),
    /// The app asked the keeper something it does not understand: a bug.
    #[error("{0}")]
    BadArguments(String),
    /// A value the person gave is not acceptable (never sent anywhere).
    #[error("{0}")]
    Invalid(String),
    /// Four sessions are attached on this machine already.
    #[error("{0}")]
    TooMany(String),
    /// A session this app did not start is not this app's to end.
    #[error("{0}")]
    NotOwned(String),
    /// There is no such machine, or it has no session channel.
    #[error("{0}")]
    NoMachine(String),
    /// The connection to the machine failed: [`WireError`] says whether retrying can help.
    #[error("{0}")]
    Wire(WireError),
    /// Anything else (a command that ended with another status, a file that could not be written).
    #[error("{0}")]
    Other(String),
}

impl KeeperError {
    /// Maps an exit status and the command's last words to an error. `what` completes "Couldn't …".
    pub fn from_exit(code: i32, stderr: &str, what: &str) -> Self {
        let said = excerpt(stderr);
        let or = |fallback: &str| {
            if said.is_empty() {
                fallback.to_owned()
            } else {
                said.clone()
            }
        };
        match code {
            exit::GONE => Self::Gone(or("That folder or session doesn’t exist on the machine.")),
            exit::EXITED => Self::AgentExited(or("The agent of this session has exited.")),
            exit::AGENT_MISSING => {
                Self::AgentMissing(or("That agent isn’t installed on the machine."))
            }
            exit::NOT_INSTALLED => {
                Self::NotInstalled(or("The agent helper isn’t installed on the machine."))
            }
            exit::AGENT_FAILED => Self::AgentFailed(or("The agent exited while starting.")),
            exit::NO_PYTHON => Self::NoPython(or("Agent sessions need python3 on this machine.")),
            exit::USAGE => Self::BadArguments(or(
                "The app asked the machine something it didn’t understand.",
            )),
            126 | exit::COMMAND_NOT_FOUND => Self::NoPython(or(
                "The machine couldn’t run the command (command not found).",
            )),
            other => Self::Other(or(&format!("Couldn’t {what} (exit status {other})."))),
        }
    }

    /// Whether trying the same thing again cannot help (the phone's `fatal`).
    pub fn is_fatal(&self) -> bool {
        match self {
            Self::NotInstalled(_) | Self::AgentFailed(_) | Self::Other(_) => false,
            Self::Wire(e) => e.is_fatal(),
            _ => true,
        }
    }

    /// The text to show.
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl From<WireError> for KeeperError {
    fn from(e: WireError) -> Self {
        Self::Wire(e)
    }
}

/// The last part of `text`, which is where an error message is.
pub(crate) fn excerpt(text: &str) -> String {
    const MAX: usize = 400;
    let t = text.trim();
    // The keeper prefixes its own words; the person does not need to know which program said them.
    let t = t.trim_start_matches("herdr-mobile: ");
    if t.chars().count() <= MAX {
        return t.to_owned();
    }
    let skip = t.chars().count() - MAX;
    let tail: String = t.chars().skip(skip).collect();
    format!("…{tail}")
}

/// Why the person's action did nothing. Nothing was sent to the agent.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Refusal {
    /// The session is not open yet.
    #[error("The session is not open yet")]
    NotReady,
    /// A prompt or a turn is running.
    #[error("The agent is working; try again when the turn ends")]
    Busy,
    /// A request was answered in the first 400 ms after it appeared: that press was meant for something else.
    #[error("That came too soon after the question appeared")]
    TooSoon,
    /// The request has no such answer.
    #[error("That answer is not offered")]
    NoSuchOption,
    /// Nothing waits for an answer.
    #[error("Nothing is waiting for an answer")]
    NothingWaiting,
    /// The request on the person's screen is no longer the one that waits, or its content changed. Nothing was sent.
    #[error("The question changed")]
    Changed,
    /// The session is over; nothing can reach the agent.
    #[error("The session has ended")]
    Ended,
    /// A field of the question does not take what was given, and why.
    #[error("{0}")]
    Invalid(String),
    /// Ten messages are queued already.
    #[error("{0} messages are queued already")]
    QueueFull(usize),
    /// A file to send could not be read.
    #[error("{0}")]
    CannotRead(String),
    /// What the person wants cannot be done from here now (the terminal needs them, a question waits first,
    /// the pane did not take it); the text says what to do.
    #[error("{0}")]
    Blocked(String),
    /// The session's thread is gone.
    #[error("The session is not running")]
    Stopped,
}
