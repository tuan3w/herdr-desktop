//! Where Claude Code keeps a subagent's transcript: the pure path rules of herdr-mobile's
//! `claude_subagent_logs.dart`.
//!
//! Beside the session log `<dir>/<session>.jsonl` Claude writes `<dir>/<session>/subagents/agent-<id>.jsonl`
//! and an `agent-<id>.meta.json` that names the call that started the agent (`toolUseId`). The id is in the
//! parent's log once the call returned; before that only the meta files say it.
//!
//! **Not ported:** everything that touches the machine (`pathOf`'s `stat` of the file, `list` of the folder
//! to find a meta file, reading meta files, the `running` decision from a transcript's modification time).
//! The host layer does those through `Files` and uses [`subagent_dir`], [`meta_agent_id`],
//! [`meta_tool_use_id`] and [`subagent_log_path_for`] for every rule that is not I/O.

use serde_json::Value;

use crate::observed::model::SubagentInfo;

/// The biggest `.meta.json` worth reading: they are about 200 bytes.
pub const MAX_META_BYTES: usize = 8 * 1024;

/// The longest log path accepted, in UTF-16 code units (Dart's `String.length`).
const MAX_LOG_PATH: usize = 4096;

/// A plain token: what an agent id looks like (`a6c798c858e96e728`). Ids come from a log.
pub fn is_agent_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A log path worth reading: absolute, a `.jsonl`, no control characters and no `..` segment
/// (herdr-mobile's `isReadableLogPath`).
fn is_readable_log_path(path: &str) -> bool {
    path.starts_with('/')
        && path.ends_with(".jsonl")
        && path.encode_utf16().count() <= MAX_LOG_PATH
        && !path.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
        && !path.split('/').any(|s| s == "..")
}

/// The folder of the subagent transcripts of the session logged in `parent_log_path`; `None` when that is not
/// a `.jsonl` path.
pub fn subagent_dir(parent_log_path: &str) -> Option<String> {
    parent_log_path
        .strip_suffix(".jsonl")
        .map(|stem| format!("{stem}/subagents"))
}

/// The transcript of agent `agent_id` of the session logged in `parent_log_path`; `None` when the id is not a
/// plain token or the result is not a readable log path.
pub fn subagent_log_path_for(parent_log_path: &str, agent_id: &str) -> Option<String> {
    if !is_agent_id(agent_id) {
        return None;
    }
    let path = format!("{}/agent-{agent_id}.jsonl", subagent_dir(parent_log_path)?);
    is_readable_log_path(&path).then_some(path)
}

/// Where the transcript of `info` is, by the id the parent's log gave it (`SubagentInfo::log_id`); `None`
/// while the log has not said it (the host then looks the call up in the meta files: [`meta_tool_use_id`]).
/// The file may not exist yet: the host stats it before following.
pub fn subagent_log_path(parent_log_path: &str, info: &SubagentInfo) -> Option<String> {
    subagent_log_path_for(parent_log_path, info.log_id.as_deref()?)
}

/// The agent id in the name of a meta file (`agent-<id>.meta.json`).
pub fn meta_agent_id(file_name: &str) -> Option<&str> {
    let id = file_name
        .strip_prefix("agent-")?
        .strip_suffix(".meta.json")?;
    is_agent_id(id).then_some(id)
}

/// The id of the call that started the agent, from the bytes of its meta file; `None` for a file over
/// [`MAX_META_BYTES`], one that is not JSON, or one without a `toolUseId`.
pub fn meta_tool_use_id(bytes: &[u8]) -> Option<String> {
    if bytes.len() > MAX_META_BYTES {
        return None;
    }
    let json: Value = serde_json::from_slice(bytes).ok()?;
    let call = json.get("toolUseId")?.as_str()?;
    (!call.is_empty()).then(|| call.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARENT: &str =
        "/home/dev/.claude/projects/-home-dev-project/5a1d0000-0000-4000-8000-000000000001.jsonl";

    fn info(log_id: Option<&str>) -> SubagentInfo {
        let mut info = SubagentInfo::new("List files");
        info.log_id = log_id.map(str::to_owned);
        info
    }

    #[test]
    fn the_transcript_sits_in_the_subagents_folder_named_by_the_agent_id() {
        assert_eq!(
            subagent_log_path(PARENT, &info(Some("a6c798c858e96e728"))).as_deref(),
            Some(
                "/home/dev/.claude/projects/-home-dev-project/5a1d0000-0000-4000-8000-000000000001/subagents/agent-a6c798c858e96e728.jsonl"
            )
        );
    }

    #[test]
    fn no_id_yet_means_no_path() {
        assert_eq!(subagent_log_path(PARENT, &info(None)), None);
    }

    #[test]
    fn an_id_that_is_not_a_plain_token_is_never_put_in_a_path() {
        for bad in [
            "",
            "../../../../etc/passwd",
            "a/b",
            "a b",
            "a.b",
            &"x".repeat(65),
        ] {
            assert_eq!(subagent_log_path(PARENT, &info(Some(bad))), None, "{bad}");
        }
    }

    #[test]
    fn a_parent_that_is_not_a_jsonl_log_has_no_subagent_folder() {
        assert_eq!(subagent_dir("/home/dev/notes.txt"), None);
        assert_eq!(subagent_log_path_for("/home/dev/notes.txt", "abc123"), None);
    }

    #[test]
    fn a_parent_path_that_is_not_readable_gives_no_path() {
        // Relative, a `..` segment, a control character.
        for parent in ["rel/x.jsonl", "/home/../etc/x.jsonl", "/home/dev/x\n.jsonl"] {
            assert_eq!(subagent_log_path_for(parent, "abc"), None, "{parent:?}");
        }
    }

    #[test]
    fn a_meta_file_names_its_agent() {
        assert_eq!(
            meta_agent_id("agent-a6c798c858e96e728.meta.json"),
            Some("a6c798c858e96e728")
        );
        for other in [
            "agent-a6c798c858e96e728.jsonl",
            "agent-.meta.json",
            "agent-a b.meta.json",
            "x-abc.meta.json",
        ] {
            assert_eq!(meta_agent_id(other), None, "{other}");
        }
    }

    #[test]
    fn a_meta_file_names_the_call_that_started_the_agent() {
        assert_eq!(
            meta_tool_use_id(br#"{"agentType":"general-purpose","toolUseId":"toolu_01"}"#)
                .as_deref(),
            Some("toolu_01")
        );
        assert_eq!(meta_tool_use_id(br#"{"toolUseId":""}"#), None);
        assert_eq!(meta_tool_use_id(br#"{"toolUseId":5}"#), None);
        assert_eq!(meta_tool_use_id(b"not json"), None);
        let big = format!(
            r#"{{"toolUseId":"t","pad":"{}"}}"#,
            "x".repeat(MAX_META_BYTES)
        );
        assert_eq!(meta_tool_use_id(big.as_bytes()), None);
    }
}
