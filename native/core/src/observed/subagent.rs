//! Where a subagent's own transcript is on the machine: the host half of herdr-mobile's `SubagentLogs.pathOf`.
//!
//! The pure path rules are each kind's ([`claude::subagent_log_path`], [`omp::subagent_log_path`], Codex's thread
//! id); this does the looking, through [`LocateCtx::files`] only: a `stat` of the file, and for Claude Code a
//! `list` of the `subagents/` folder and reads of its `.meta.json` files (at most [`claude::MAX_META_BYTES`]
//! each) while the parent's log has not yet said the agent's id. Nothing is put in a shell; every path built
//! from a log is validated before it is used.

use crate::files::{EntryKind, FileErrorKind};
use crate::observed::model::{LocateCtx, Location, Locator, SubagentInfo};
use crate::observed::{claude, kinds, locate, omp};

/// What an open subagent chat says while its transcript is not there yet.
const NOT_YET: &str = "Waiting for the subagent to write its transcript";

/// Finds the transcript of one subagent of the session logged at `parent_log`, for agents of kind `kind`
/// (`claude`, `omp`, `codex`).
pub struct SubagentLocator {
    /// The parent's kind id.
    pub kind: &'static str,
    /// The parent's log, when it has been found.
    pub parent_log: Option<String>,
    /// The subagent as the parent's log last described it.
    pub info: SubagentInfo,
}

/// An omp subagent's name is its file name: only a plain token may become one.
fn is_plain_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        && !name.starts_with('.')
}

impl SubagentLocator {
    /// The path the transcript has, or will have once the subagent writes it; `None` while it cannot be told.
    fn path(&self, ctx: &LocateCtx<'_>) -> Option<String> {
        let parent = self.parent_log.as_deref()?;
        match self.kind {
            "claude" => claude::subagent_log_path(parent, &self.info).or_else(|| {
                // Before the call returned only the meta files say which agent the call started.
                let call = self.info.call_id.as_deref()?;
                let dir = claude::subagent_dir(parent)?;
                let listing = ctx.files.list(&dir).ok()?;
                listing.entries.iter().find_map(|e| {
                    let id = claude::meta_agent_id(&e.name)?;
                    if e.kind != EntryKind::File || e.size as usize > claude::MAX_META_BYTES {
                        return None;
                    }
                    let meta = ctx
                        .files
                        .read(&format!("{dir}/{}", e.name), 0, claude::MAX_META_BYTES)
                        .ok()?;
                    (claude::meta_tool_use_id(&meta.data).as_deref() == Some(call))
                        .then(|| claude::subagent_log_path_for(parent, id))
                        .flatten()
                })
            }),
            "omp" => is_plain_name(&self.info.name)
                .then(|| omp::subagent_log_path(parent, &self.info))
                .flatten()
                .filter(|p| locate::is_readable_log_path(p)),
            _ => None,
        }
    }
}

impl Locator for SubagentLocator {
    fn may_locate(&self, _: &crate::schema::AgentInfo) -> bool {
        true
    }

    fn locate(&self, ctx: &LocateCtx<'_>) -> Location {
        if self.parent_log.is_none() {
            return Location::NotYet("Waiting for the agent’s log".to_owned());
        }
        if self.kind == "codex" {
            // A Codex subagent is a thread of its own, found by its id like any session.
            return match self.info.log_id.as_deref() {
                Some(id) => kinds::codex_locator().locate_by_id(ctx.files, ctx.home, id),
                None => Location::NotYet(NOT_YET.to_owned()),
            };
        }
        let Some(path) = self.path(ctx) else {
            return Location::NotYet(NOT_YET.to_owned());
        };
        match ctx.files.stat(&path) {
            Ok(stat) if stat.kind == EntryKind::File => Location::Located(path),
            Ok(_) => Location::Unlinked("The subagent’s transcript is not a file.".to_owned()),
            Err(e) if e.kind == FileErrorKind::NotFound => Location::NotYet(NOT_YET.to_owned()),
            Err(e) if e.kind == FileErrorKind::Denied => Location::Unlinked(format!(
                "The subagent’s transcript cannot be read: {}",
                e.message
            )),
            // The link may come back: look again later.
            Err(_) => Location::NotYet(NOT_YET.to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::Value;

    use super::*;
    use crate::files::LocalFiles;
    use crate::schema::AgentInfo;
    use crate::wire::{EventStream, Wire, WireError};

    struct NoWire;

    impl Wire for NoWire {
        fn request(&self, _: &str, _: Value, _: Duration) -> Result<Value, WireError> {
            Err(WireError::retryable("no herdr here"))
        }
        fn events(&self, _: &[Value]) -> Result<Box<dyn EventStream>, WireError> {
            Err(WireError::retryable("no herdr here"))
        }
    }

    fn info(name: &str, log_id: Option<&str>, call_id: Option<&str>) -> SubagentInfo {
        let mut info = SubagentInfo::new(name);
        info.log_id = log_id.map(str::to_owned);
        info.call_id = call_id.map(str::to_owned);
        info
    }

    fn locate_in(locator: &SubagentLocator) -> Location {
        let files = LocalFiles::new();
        let agent = AgentInfo::default();
        locator.locate(&LocateCtx {
            agent: &agent,
            pane: None,
            files: &files,
            wire: &NoWire,
            home: None,
        })
    }

    fn write(path: &std::path::Path, body: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, body).expect("write");
    }

    #[test]
    fn a_claude_subagent_is_found_by_the_id_the_parent_gave_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = dir.path().join("s1.jsonl");
        write(&parent, "{}\n");
        let sub = dir
            .path()
            .join("s1/subagents/agent-a0f00d00c0ffee001.jsonl");
        let at = SubagentLocator {
            kind: "claude",
            parent_log: Some(parent.display().to_string()),
            info: info("List files", Some("a0f00d00c0ffee001"), Some("toolu_1")),
        };
        // Not written yet: an empty chat that waits, not a failure.
        assert!(matches!(locate_in(&at), Location::NotYet(_)));
        write(&sub, "{}\n");
        assert_eq!(locate_in(&at), Location::Located(sub.display().to_string()));
    }

    #[test]
    fn before_the_call_returned_the_meta_file_names_the_agent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = dir.path().join("s1.jsonl");
        write(&parent, "{}\n");
        let folder = dir.path().join("s1/subagents");
        write(
            &folder.join("agent-aother.meta.json"),
            r#"{"toolUseId":"toolu_other"}"#,
        );
        write(&folder.join("agent-aother.jsonl"), "{}\n");
        write(
            &folder.join("agent-amine.meta.json"),
            r#"{"toolUseId":"toolu_mine"}"#,
        );
        write(&folder.join("agent-amine.jsonl"), "{}\n");
        let at = SubagentLocator {
            kind: "claude",
            parent_log: Some(parent.display().to_string()),
            info: info("Mine", None, Some("toolu_mine")),
        };
        assert_eq!(
            locate_in(&at),
            Location::Located(folder.join("agent-amine.jsonl").display().to_string())
        );
    }

    #[test]
    fn an_id_from_a_log_that_is_not_a_plain_token_never_becomes_a_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = dir.path().join("s1.jsonl");
        write(&parent, "{}\n");
        write(&dir.path().join("x.jsonl"), "{}\n");
        let claude = SubagentLocator {
            kind: "claude",
            parent_log: Some(parent.display().to_string()),
            info: info("Evil", Some("../../x"), None),
        };
        assert!(matches!(locate_in(&claude), Location::NotYet(_)));
        let omp = SubagentLocator {
            kind: "omp",
            parent_log: Some(parent.display().to_string()),
            info: info("../x", None, None),
        };
        assert!(matches!(locate_in(&omp), Location::NotYet(_)));
    }

    #[test]
    fn an_omp_subagent_is_its_name_beside_the_parent_log() {
        let dir = tempfile::tempdir().expect("tempdir");
        let parent = dir.path().join("2026-11-08_s.jsonl");
        write(&parent, "{}\n");
        let sub = dir.path().join("2026-11-08_s/PongReply.jsonl");
        write(&sub, "{}\n");
        let at = SubagentLocator {
            kind: "omp",
            parent_log: Some(parent.display().to_string()),
            info: info("PongReply", None, None),
        };
        assert_eq!(locate_in(&at), Location::Located(sub.display().to_string()));
    }

    #[test]
    fn without_the_parent_log_or_a_thread_id_it_waits() {
        let none = SubagentLocator {
            kind: "claude",
            parent_log: None,
            info: info("A", Some("a1"), None),
        };
        assert!(matches!(locate_in(&none), Location::NotYet(_)));
        let codex = SubagentLocator {
            kind: "codex",
            parent_log: Some("/home/dev/.codex/sessions/r.jsonl".into()),
            info: info("B", None, None),
        };
        assert!(matches!(locate_in(&codex), Location::NotYet(_)));
    }
}
