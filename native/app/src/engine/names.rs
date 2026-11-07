//! What the agents' own session logs call their panes, for the board.
//!
//! omp titles its terminal `π > <folder>` until it has a name of its own, and a board of those reads as one
//! name repeated. herdr says where omp's log is (`agent_session`); the head and tail of that file hold the
//! session's title and the person's last message. [`PaneSessionNames`] decides which panes need a read and
//! when (herdr-mobile's rules: two reads at once, one per state episode, a failed read waits five minutes);
//! this runs the reads on their own threads and tells the board when a name arrived, so the board's `name` is
//! the log's where the pane's title is only the folder.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use herdr_core::board::LogNames;
use herdr_core::link::LinkState;
use herdr_core::observed::names::{
    LogName, PaneSessionNames, ReadFailed, ReadJob, Subject, read_session_slices,
};
use herdr_core::observed::omp::session_name::parse_session_name;

use super::Fleet;

/// Milliseconds since the Unix epoch.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl Fleet {
    /// Every pane's agent as the name reader looks at it.
    fn name_subjects(&self) -> Vec<Subject> {
        let mut subjects = Vec::new();
        for (machine, link) in self.entries() {
            let live = link.state() == LinkState::Online;
            let snapshot = link.snapshot();
            for agent in &snapshot.agents {
                let workspace = snapshot
                    .workspace(&agent.workspace_id)
                    .map(|w| w.label.as_str());
                subjects.push(Subject::of(
                    &machine.id,
                    live,
                    agent.agent_status,
                    agent,
                    snapshot.pane(&agent.pane_id),
                    workspace,
                ));
            }
        }
        subjects
    }

    /// Looks at the fleet and starts the reads it needs. Cheap: it only queues, and reads run on their own
    /// threads. Call it whenever the board is pulled.
    pub(super) fn sync_log_names(&self) {
        let subjects = self.name_subjects();
        let jobs = self.pane_names.lock().sync(&subjects, true, now_ms());
        self.start_name_reads(jobs);
    }

    fn start_name_reads(&self, jobs: Vec<ReadJob>) {
        let Some(me) = self.me.get().and_then(std::sync::Weak::upgrade) else {
            return;
        };
        for job in jobs {
            let me = Arc::clone(&me);
            let spawned = std::thread::Builder::new()
                .name("herdr-log-name".to_owned())
                .spawn(move || {
                    let outcome = me.read_log_name(&job);
                    me.finish_log_name(&job, outcome);
                });
            if let Err(e) = spawned {
                eprintln!("herdr-desktop: cannot start a log name read: {e}");
            }
        }
    }

    /// Reads one log: the machine's files, the head and tail of the file, omp's session-name parser.
    fn read_log_name(
        &self,
        job: &ReadJob,
    ) -> Result<herdr_core::observed::names::ReadDone, ReadFailed> {
        let files = self.files_of(&job.machine).map_err(|_| ReadFailed)?;
        let slices =
            read_session_slices(&*files, &job.path, job.needs_name).map_err(|_| ReadFailed)?;
        Ok(slices.done(|head, tail, mid_line| {
            let name = parse_session_name(head, tail, mid_line);
            LogName {
                title: name.title,
                last_prompt: name.last_prompt,
            }
        }))
    }

    fn finish_log_name(
        &self,
        job: &ReadJob,
        outcome: Result<herdr_core::observed::names::ReadDone, ReadFailed>,
    ) {
        let subjects = self.name_subjects();
        let (finished, names) = {
            let mut reader = self.pane_names.lock();
            let finished = reader.finish(job, outcome, &subjects, true, now_ms());
            let names = finished.changed.then(|| names_of(&reader, &subjects));
            (finished, names)
        };
        if let Some(names) = names {
            *self.log_names.write() = names;
            self.bump();
        }
        self.start_name_reads(finished.start);
    }
}

/// The names the reader holds, for the panes that have one.
fn names_of(reader: &PaneSessionNames, subjects: &[Subject]) -> LogNames {
    let mut names = BTreeMap::new();
    for s in subjects {
        if let Some(name) = reader.name_for(&s.machine, &s.pane, s.log_path.as_deref()) {
            names.insert((s.machine.clone(), s.pane.clone()), name.clone());
        }
    }
    names
}
