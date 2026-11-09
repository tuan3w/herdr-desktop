//! Observed sessions in the engine: a pane's agent shown as a chat from its own log (`Show chat`).
//!
//! `herdr-core` reads the log and drives the dialog; this is the pane it reads and types into ([`FleetPane`]):
//! the state herdr last reported, the machine's files and herdr link for locating the log, and the pane's own
//! requests (`pane.read`, `pane.send_input`, `pane.send_keys`) over the machine's shared connection.

use std::sync::{Arc, Weak};

use herdr_core::files::FileErrorKind;
use herdr_core::observed::kinds::{ObservedKind, kind_for};
use herdr_core::observed::model::{LocateCtx, Location, Locator};
use herdr_core::observed::session::{ObservedHandle, PaneIo, PaneState};
use herdr_core::schema::clean_terminal_title;
use serde_json::json;

use super::{Engine, Fleet, REQUEST_TIMEOUT, unknown};

/// The rows of a pane an ask dialog is read from: a dialog is a few rows high, but the agent's chrome around it
/// can be tall.
const SCREEN_LINES: u32 = 60;

/// One pane of one machine, as the observed session needs it.
struct FleetPane {
    fleet: Weak<Fleet>,
    machine: String,
    pane: String,
}

impl FleetPane {
    fn fleet(&self) -> Result<Arc<Fleet>, String> {
        self.fleet
            .upgrade()
            .ok_or_else(|| "The app is closing.".to_owned())
    }
}

impl PaneIo for FleetPane {
    fn state(&self) -> PaneState {
        let Ok(fleet) = self.fleet() else {
            return PaneState::Gone;
        };
        let Some(link) = fleet.link(&self.machine) else {
            return PaneState::Gone;
        };
        let snapshot = link.snapshot();
        match (snapshot.agent(&self.pane), snapshot.pane(&self.pane)) {
            (Some(agent), pane) => PaneState::Agent {
                status: agent.agent_status,
                cwd: agent
                    .cwd
                    .clone()
                    .or_else(|| pane.and_then(|p| p.cwd.clone())),
                title: agent
                    .terminal_title_stripped
                    .as_deref()
                    .or(agent.terminal_title.as_deref())
                    .map(clean_terminal_title)
                    .filter(|t| !t.is_empty()),
            },
            (None, Some(_)) => PaneState::NotAgent,
            (None, None) => PaneState::Gone,
        }
    }

    fn locate(&self, locator: &dyn Locator) -> Location {
        let Ok(fleet) = self.fleet() else {
            return Location::Unlinked("The app is closing.".to_owned());
        };
        let Some(link) = fleet.link(&self.machine) else {
            return Location::Unlinked(unknown(&self.machine));
        };
        let snapshot = link.snapshot();
        let Some(agent) = snapshot.agent(&self.pane) else {
            return Location::Unlinked("herdr no longer lists this pane.".to_owned());
        };
        let files = match fleet.files_of(&self.machine) {
            Ok(files) => files,
            Err(why) => return Location::Unlinked(why),
        };
        let wire = link.wire();
        locator.locate(&LocateCtx {
            agent,
            pane: snapshot.pane(&self.pane),
            files: &*files,
            wire: &*wire,
            home: None,
        })
    }

    fn read_screen(&self) -> Result<String, String> {
        let fleet = self.fleet()?;
        let link = fleet
            .link(&self.machine)
            .ok_or_else(|| unknown(&self.machine))?;
        let result = link
            .wire()
            .request(
                "pane.read",
                json!({"pane_id": self.pane, "source": "visible", "format": "text", "lines": SCREEN_LINES, "strip_ansi": true}),
                REQUEST_TIMEOUT,
            )
            .map_err(|e| e.message)?;
        result
            .pointer("/read/text")
            .and_then(|t| t.as_str())
            .map(str::to_owned)
            .ok_or_else(|| "herdr's pane.read answer has no text".to_owned())
    }

    fn send_input(&self, text: &str, keys: &[String]) -> Result<(), String> {
        self.fleet()?
            .send_input(&self.machine, &self.pane, text, keys)
    }

    fn send_keys(&self, keys: &[String]) -> Result<(), String> {
        self.fleet()?.send_keys(&self.machine, &self.pane, keys)
    }

    fn read_file(&self, path: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
        let files = self.fleet()?.files_of(&self.machine)?;
        match files.read(path, 0, limit) {
            Ok(chunk) => Ok(Some(chunk.data)),
            Err(e) if e.kind == FileErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.message),
        }
    }

    fn files(&self) -> Option<Arc<dyn herdr_core::files::Files>> {
        self.fleet().ok()?.files_of(&self.machine).ok()
    }
}

impl Engine {
    /// The kind of observed session the agent in `pane` of `machine` can be, when it can be one: omp, Claude Code
    /// or Codex, and the agent's log can be told (herdr names it, or its own folders do).
    pub fn observed_kind(&self, machine: &str, pane: &str) -> Option<&'static ObservedKind> {
        let link = self.fleet.link(machine)?;
        let snapshot = link.snapshot();
        let agent = snapshot.agent(pane)?;
        let label = herdr_core::observed::locate::kind_of(agent)?;
        let kind = kind_for(label)?;
        kind.locator.may_locate(agent).then_some(kind)
    }

    /// Starts reading the log of the agent in `pane` as a chat. Errors say why a pane cannot be one.
    pub fn observe(&self, machine: &str, pane: &str) -> Result<ObservedHandle, String> {
        let kind = self.observed_kind(machine, pane).ok_or_else(|| {
            "This agent has no session log this app can read. Use the terminal.".to_owned()
        })?;
        let io = Arc::new(FleetPane {
            fleet: Arc::downgrade(&self.fleet),
            machine: machine.to_owned(),
            pane: pane.to_owned(),
        });
        self.fleet
            .sessions()
            .observe(machine, pane, kind, io)
            .map_err(|e| e.message())
    }
}
