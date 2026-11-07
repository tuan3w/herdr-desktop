//! Delivery on macOS through `osascript`'s `display notification`.
//!
//! What this can and cannot do, so nothing here pretends otherwise:
//!
//! * it shows a title and a body. There are no answer buttons, so a notification is news, never an
//!   approval: the person answers in the app;
//! * a click does not come back to the app (the notification belongs to `osascript`, and macOS opens
//!   Script Editor for it), so nothing opens the agent from a notification, and a notification cannot be
//!   withdrawn when its agent stops needing the person ([`Sink::close`] has nothing to call);
//! * macOS attributes the notification to Script Editor: the person allows it once in System Settings >
//!   Notifications, and nothing is shown until they do.
//!
//! The text never enters the script: the script is fixed and the title and body are arguments after
//! `--`, so a command with quotes, backslashes or a newline reaches the screen as it is and cannot
//! become AppleScript. The module has no macOS-only API, so its argument rules are tested everywhere.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::path::Path;
use std::process::{Command, Stdio};

use crossbeam_channel::Sender;

use super::policy::Notification;
use super::{Input, Sink, Support};

/// By absolute path: a `PATH` entry must not decide which program is sent the text of a command.
const OSASCRIPT: &str = "/usr/bin/osascript";

/// The fixed script: title first, body second.
const SCRIPT: [&str; 3] = [
    "on run argv",
    "display notification (item 2 of argv) with title (item 1 of argv)",
    "end run",
];

/// Notifications on a Mac. Nothing comes back from the desktop, so the notifier's input channel is not kept.
pub struct AppleScriptSink;

impl AppleScriptSink {
    /// A sink; `_events` is the channel clicks would arrive on if the desktop sent any.
    pub fn new(_events: Sender<Input>) -> Self {
        Self
    }

    /// Whether `osascript` is there. Actions and markup are never available.
    pub fn support(&self) -> Result<Support, String> {
        if Path::new(OSASCRIPT).exists() {
            Ok(Support {
                actions: false,
                markup: false,
            })
        } else {
            Err(format!(
                "{OSASCRIPT} is missing, so this Mac cannot show notifications"
            ))
        }
    }
}

/// The arguments of `osascript` that show `n`: the script, then `--` so that a body that starts with a dash is
/// not read as an option, then the title and the body.
fn arguments(n: &Notification) -> Vec<String> {
    let mut args = Vec::with_capacity(2 * SCRIPT.len() + 3);
    for line in SCRIPT {
        args.extend(["-e".to_owned(), line.to_owned()]);
    }
    args.extend(["--".to_owned(), n.title.clone(), n.body.clone()]);
    args
}

impl Sink for AppleScriptSink {
    fn show(&self, n: &Notification) -> Result<(), String> {
        let child = Command::new(OSASCRIPT)
            .args(arguments(n))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot run {OSASCRIPT}: {e}"))?;
        // The notifier thread must not wait for the desktop: reap the child elsewhere and say if it failed.
        let spawned = std::thread::Builder::new()
            .name("herdr-notify-osascript".to_owned())
            .spawn(move || match child.wait_with_output() {
                Ok(out) if out.status.success() => {}
                Ok(out) => eprintln!(
                    "herdr-desktop: osascript could not show a notification: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
                Err(e) => eprintln!("herdr-desktop: osascript did not finish: {e}"),
            });
        spawned
            .map(drop)
            .map_err(|e| format!("cannot start a thread: {e}"))
    }

    /// A notification of `osascript` cannot be withdrawn.
    fn close(&self, _id: u64) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(title: &str, body: &str) -> Notification {
        Notification {
            id: 1,
            title: title.to_owned(),
            body: body.to_owned(),
            buttons: Vec::new(),
            persistent: true,
            target: super::super::Target::Board,
        }
    }

    #[test]
    fn a_command_with_quotes_and_dashes_reaches_the_screen_as_an_argument_and_never_as_script() {
        let body = "rm -rf \"$HOME\" \\ ; end run\ndisplay notification \"owned\"\n-e evil";
        let args = arguments(&note("1 agent needs you", body));
        let dashes = args.iter().position(|a| a == "--").unwrap();
        // Everything the script is made of comes before `--`; what follows is exactly title and body.
        assert_eq!(&args[dashes + 1..], ["1 agent needs you", body]);
        let script: Vec<&str> = args[..dashes]
            .iter()
            .filter(|a| *a != "-e")
            .map(String::as_str)
            .collect();
        assert_eq!(script, SCRIPT);
        assert!(!script.iter().any(|l| l.contains(body)));
    }

    #[test]
    fn a_mac_notification_says_it_has_no_buttons() {
        let (tx, _rx) = crossbeam_channel::unbounded();
        if let Ok(support) = AppleScriptSink::new(tx).support() {
            assert!(!support.actions && !support.markup);
        }
    }
}
