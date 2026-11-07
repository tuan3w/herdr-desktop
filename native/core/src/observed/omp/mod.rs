//! omp's session log as an observed chat: the log mapper, how a session is named, where a subagent's
//! transcript is, and the message that asks omp to stop background jobs.
//!
//! A port of herdr-mobile's `omp_log_mapper.dart`, `omp_session_name.dart`, the subagent part of
//! `omp_kind.dart` and `stopMessageForOmp`. The question tool's keys and the menus are the ask driver's.

mod mapper;
pub mod session_name;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

pub use mapper::OmpMapper;

use crate::files::Entry;
use crate::observed::model::{LogMapper, SubagentInfo};

/// A new mapper for one omp session log.
pub fn new_mapper() -> Box<dyn LogMapper> {
    Box::new(OmpMapper::new())
}

/// Ids come from an agent's log or wire; they go into a message to the agent. Only plain tokens pass:
/// `[A-Za-z0-9_.:-]` and 1 to 64 of them.
pub fn is_safe_background_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// The message that asks omp to stop `ids` (`write proc://<id>/kill`). `None` when there is nothing to ask or
/// an id is not a plain token.
pub fn stop_message<'a>(ids: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let ids: Vec<&str> = ids.into_iter().collect();
    if ids.is_empty() || !ids.iter().all(|id| is_safe_background_id(id)) {
        return None;
    }
    let calls: Vec<String> = ids
        .iter()
        .map(|id| format!("{id} (write proc://{id}/kill)"))
        .collect();
    let noun = if ids.len() == 1 { "job" } else { "jobs" };
    Some(format!(
        "Stop these background {noun} now: {}. Do nothing else.",
        calls.join(", ")
    ))
}

/// The folder next to a log that holds its subagents' files: the log's path without `.jsonl`. `None` for a
/// path that is not a `.jsonl` file.
pub fn artifact_dir(parent_log_path: &str) -> Option<&str> {
    parent_log_path.strip_suffix(".jsonl")
}

/// Where the transcript of subagent `info` is: `<parent log minus .jsonl>/<name>.jsonl`. The name comes from
/// the parent's log, so the caller must check the result is a readable log path (as the locator does for any
/// log) before it reads the file.
pub fn subagent_log_path(parent_log_path: &str, info: &SubagentInfo) -> Option<String> {
    Some(format!(
        "{}/{}.jsonl",
        artifact_dir(parent_log_path)?,
        info.name
    ))
}

/// What the files beside a subagent's log prove about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentState {
    /// Its transcript was written to recently.
    Running,
    /// omp wrote its result file (`<name>.md` or `<name>.json`).
    Finished,
}

/// The subagents among `infos` that the entries of their folder (`artifact_dir`, as listed by the
/// machine) prove running or finished; every other one is left to the parent log's own status.
///
/// Port of `OmpSubagentLogs.refine` without its host call: the caller lists the folder and passes the entries,
/// the current time and how recent a write must be, all in seconds since the epoch / seconds.
pub fn refine_subagents(
    entries: &[Entry],
    infos: &[SubagentInfo],
    now_secs: i64,
    running_secs: i64,
) -> BTreeMap<String, SubagentState> {
    // base name -> extension -> modified
    let mut files: BTreeMap<&str, BTreeMap<&str, Option<i64>>> = BTreeMap::new();
    for e in entries {
        let Some(dot) = e.name.rfind('.').filter(|d| *d > 0) else {
            continue;
        };
        files
            .entry(&e.name[..dot])
            .or_default()
            .insert(&e.name[dot + 1..], e.modified);
    }
    let mut refined = BTreeMap::new();
    for s in infos {
        let Some(exts) = files.get(s.name.as_str()) else {
            continue;
        };
        if exts.contains_key("md") || exts.contains_key("json") {
            // omp writes the result file when the subagent ends: the one proof.
            refined.insert(s.name.clone(), SubagentState::Finished);
        } else if let Some(modified) = exts.get("jsonl") {
            // A quiet log proves nothing: a subagent that backgrounds a long job and calls `wait` writes
            // nothing until it returns. Only a recent write is a fact.
            if modified.is_some_and(|at| now_secs - at <= running_secs) {
                refined.insert(s.name.clone(), SubagentState::Running);
            }
        }
    }
    refined
}
