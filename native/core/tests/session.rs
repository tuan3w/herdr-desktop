//! Agent sessions end to end: the real keeper script (herdr-mobile's python) on this computer, driving
//! herdr-mobile's scripted ACP agent (`fake_acp_agent.py`), through `KeeperHost`, the session thread and
//! the hub. A remote machine is played by a stand-in `ssh` that runs the remote command locally with
//! `sh -c` (so the real generated remote script, base64 wrapper, installer and `attach --z` all run).
//!
//! Hermetic: every test has its own `HOME` and a `PATH` that holds only a scripted `omp` and the
//! system; no real agent is ever started (`claude`, `codex` and `pi` would fall back to `npx`), and the
//! keepers a test starts are ended by the rig when it ends.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use herdr_core::board::{Board, FirstSeen, SessionRow};
use herdr_core::link::LinkState;
use herdr_core::schema::{AgentStatus, Snapshot};
use herdr_core::session::{
    Ask, FieldAnswer, HubConfig, ItemKind, KeeperError, KeeperHost, KeeperState, MAX_ATTACHED,
    Refusal, Role, SendOutcome, SessionHandle, SessionHub, SessionPhase, SessionSnapshot,
};
use herdr_core::ssh::{SshClient, SshTarget};
use herdr_core::store::Reviewed;

const T: Duration = Duration::from_secs(40);
const LOCAL: &str = "local";

fn find_in_path(name: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| panic!("{name} is not installed"))
}

/// The scripted agent: herdr-mobile's `fake_acp_agent.py` plus what this app's tests need, kept in this repository so the
/// tests run on a machine (CI) that has no herdr-mobile checkout.
fn fake_agent() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake_acp_agent.py")
}

/// Polls until the condition holds; a test never sleeps a fixed time.
fn eventually<R>(what: &str, mut condition: impl FnMut() -> Option<R>) -> R {
    let deadline = Instant::now() + T;
    loop {
        if let Some(found) = condition() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn write_executable(path: &Path, text: &str) {
    std::fs::write(path, text).expect("write");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}

/// A working directory with its own home, a bin folder holding a scripted `omp`, and a folder to run in.
struct Rig {
    dir: tempfile::TempDir,
    home: PathBuf,
    bin: PathBuf,
    work: PathBuf,
    /// Hosts whose keepers are ended when the rig drops.
    hosts: parking_lot::Mutex<Vec<Arc<KeeperHost>>>,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("home");
        let bin = dir.path().join("bin");
        let work = dir.path().join("work");
        for d in [&home, &bin, &work] {
            std::fs::create_dir_all(d).expect("mkdir");
        }
        write_executable(
            &bin.join("omp"),
            &format!("#!/bin/sh\nexec python3 {}\n", fake_agent().display()),
        );
        for tool in ["python3", "base64", "sh"] {
            std::os::unix::fs::symlink(find_in_path(tool), bin.join(tool)).expect("link");
        }
        // A machine whose shell works but that has no python3.
        let nopy = dir.path().join("nopy");
        std::fs::create_dir_all(&nopy).expect("mkdir");
        for tool in ["base64", "sh"] {
            std::os::unix::fs::symlink(find_in_path(tool), nopy.join(tool)).expect("link");
        }
        Self {
            dir,
            home,
            bin,
            work,
            hosts: parking_lot::Mutex::new(Vec::new()),
        }
    }

    fn path(&self) -> String {
        format!("{}:/usr/bin:/bin", self.bin.display())
    }

    fn local(&self) -> Arc<KeeperHost> {
        self.local_with(&[])
    }

    fn local_with(&self, env: &[(&str, &str)]) -> Arc<KeeperHost> {
        let mut host = KeeperHost::local(&self.home).env("PATH", self.path());
        for (k, v) in env {
            host = host.env(*k, *v);
        }
        self.track(host)
    }

    /// A stand-in ssh: ignores ssh's options and runs the remote command word locally with the rig's
    /// home and a PATH of only the scripted bin (so no python3 means exit 78).
    fn remote(&self, dest: &str) -> Arc<KeeperHost> {
        let ssh = self.dir.path().join("ssh");
        write_executable(
            &ssh,
            &format!(
                r#"#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
dest=$1
shift
case "$dest" in
  no-python) exec /usr/bin/env -i PATH="{nopy}" HOME="{home}" /bin/sh -c "exec $1";;
esac
echo $$ >> "{pids}"
exec /usr/bin/env -i PATH="{bin}" HOME="{home}" /bin/sh -c "exec $1"
"#,
                bin = self.bin.display(),
                nopy = self.dir.path().join("nopy").display(),
                pids = self.dir.path().join("ssh-pids").display(),
                home = self.home.display()
            ),
        );
        let client = SshClient::with_control_dir(self.dir.path().join("control"))
            .program("/bin/sh")
            .program_arg(ssh);
        let target = SshTarget::new(dest, None, None, None).expect("target");
        // The install's source script is read from a home of its own, like another computer's.
        let own_home = self.dir.path().join("desktop-home");
        std::fs::create_dir_all(&own_home).expect("mkdir");
        self.track(KeeperHost::remote(client, target, own_home))
    }

    fn track(&self, host: KeeperHost) -> Arc<KeeperHost> {
        let host = Arc::new(host);
        self.hosts.lock().push(host.clone());
        host
    }

    fn cwd(&self) -> String {
        self.work.display().to_string()
    }

    fn hub(&self, host: Arc<KeeperHost>) -> SessionHub {
        let hub = SessionHub::new(HubConfig::new(Arc::new(|| {})));
        hub.set_host(LOCAL, host);
        hub
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        for host in self.hosts.lock().iter() {
            if let Ok(all) = host.list_if_installed() {
                for keeper in all {
                    let _ = host.kill(&keeper.id);
                }
            }
        }
    }
}

fn messages(s: &SessionSnapshot, role: Role) -> Vec<String> {
    s.items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Message { role: r, text, .. } if *r == role => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn notes(s: &SessionSnapshot) -> Vec<String> {
    s.items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Note(t) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

fn wait_idle(handle: &SessionHandle) -> Arc<SessionSnapshot> {
    eventually("the session to open and rest", || {
        let s = handle.snapshot();
        (s.phase == SessionPhase::Idle).then_some(s)
    })
}

/// Answers a permission as soon as the 400 ms guard lets it through.
fn answer_when_allowed(handle: &SessionHandle, option: &str) {
    eventually("the answer to be accepted", || {
        let s = handle.snapshot();
        let w = s.waiting.first()?;
        match handle.answer_permission(&w.request_id, &w.digest, option) {
            Err(Refusal::TooSoon) => None,
            other => {
                other.expect("the answer is accepted");
                Some(())
            }
        }
    });
}

// ---- the keeper commands -----------------------------------------------------------------------

#[test]
fn the_start_form_lists_the_agents_the_machine_can_run() {
    let rig = Rig::new();
    let routes = rig.local().probe().expect("probe");
    assert!(routes.iter().any(|r| r.id == "omp"), "{routes:?}");

    // Without omp on the path it is not offered; without python3 the machine says so.
    let host = Arc::new(KeeperHost::local(&rig.home).env("PATH", "/usr/bin:/bin"));
    assert!(host.probe().expect("probe").iter().all(|r| r.id != "omp"));
    let host = Arc::new(KeeperHost::local(&rig.home).env("PATH", "/nonexistent"));
    assert!(matches!(host.probe(), Err(KeeperError::NoPython(_))));
}

#[test]
fn a_keeper_command_that_fails_says_why_in_the_phones_words() {
    let rig = Rig::new();
    let host = rig.local();
    let missing = rig.dir.path().join("nowhere").display().to_string();
    assert!(matches!(
        host.start("omp", &missing),
        Err(KeeperError::Gone(_))
    ));

    let no_omp = Arc::new(KeeperHost::local(&rig.home).env("PATH", "/usr/bin:/bin"));
    match no_omp.start("omp", &rig.cwd()) {
        Err(KeeperError::AgentMissing(m)) => assert!(m.contains("omp"), "{m}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(host.kill("zzzzzz"), Err(KeeperError::Gone(_))));
    for bad in ["", "a b", "../x"] {
        assert!(
            matches!(host.kill(bad), Err(KeeperError::Invalid(_))),
            "{bad}"
        );
    }
    assert!(matches!(
        host.start("not-an-agent", &rig.cwd()),
        Err(KeeperError::Invalid(_))
    ));
    // A bad exit status the app does not know is not fatal; a missing agent is.
    assert!(!KeeperError::from_exit(1, "", "start").is_fatal());
    assert!(KeeperError::from_exit(69, "", "start").is_fatal());
}

#[test]
fn the_list_has_what_the_board_needs() {
    let rig = Rig::new();
    let host = rig.local();
    let info = host.start("omp", &rig.cwd()).expect("start");
    assert_eq!(info.agent, "omp");
    assert_eq!(info.state, KeeperState::Running);
    let listed = host.list().expect("list");
    assert!(listed.iter().any(|k| k.id == info.id && k.cwd == rig.cwd()));
    host.kill(&info.id).expect("kill");
    assert!(host.list().expect("list").iter().all(|k| k.id != info.id));
}

// ---- a conversation ----------------------------------------------------------------------------

#[test]
fn a_prompt_streams_into_the_transcript_and_the_turn_is_summed_up() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    let opened = wait_idle(&session);
    assert_eq!(opened.agent, "omp");
    assert_eq!(opened.cwd, rig.cwd());

    assert_eq!(session.send("plain", &[]), Ok(SendOutcome::Sent));
    let done = eventually("the agent's answer and the end of the turn", || {
        let s = session.snapshot();
        let ended = s
            .items
            .iter()
            .any(|i| matches!(i.kind, ItemKind::Done { .. }));
        (ended && s.phase == SessionPhase::Idle).then_some(s)
    });
    assert_eq!(messages(&done, Role::User), ["plain"]);
    assert_eq!(messages(&done, Role::Agent), ["Hello"]);
    assert!(!done.running);
}

#[test]
fn a_permission_is_answered_only_by_the_person_and_only_for_what_they_saw() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    session.send("ask", &[]).expect("send");

    let blocked = eventually("the permission request", || {
        let s = session.snapshot();
        (s.phase == SessionPhase::BlockedOnPermission).then_some(s)
    });
    let waiting = blocked.waiting.first().expect("a request waits").clone();
    let Ask::Permission(view) = &waiting.ask else {
        panic!("a permission")
    };
    assert_eq!(view.title, "Run: ls -la");
    let labels: Vec<_> = view.choices.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(labels, ["Allow once", "Reject"]);

    // Nothing is sent for another request, for a changed question, or for an option that is not offered.
    assert_eq!(
        session.answer_permission("\"other\"", &waiting.digest, "allow"),
        Err(Refusal::Changed)
    );
    assert_eq!(
        session.answer_permission(&waiting.request_id, "0000", "allow"),
        Err(Refusal::Changed)
    );
    assert_eq!(
        session.answer_permission(&waiting.request_id, &waiting.digest, "sudo"),
        Err(Refusal::NoSuchOption)
    );
    assert_eq!(session.snapshot().phase, SessionPhase::BlockedOnPermission);

    answer_when_allowed(&session, "allow");

    // The question follows: answered in one go, the first field chosen by index.
    let asking = eventually("the question", || {
        let s = session.snapshot();
        (s.phase == SessionPhase::BlockedOnQuestion).then_some(s)
    });
    let question = asking.waiting.first().expect("waits").clone();
    let Ask::Question(form) = &question.ask else {
        panic!("a question")
    };
    assert_eq!(form.message, "Pick one?\nsecond line");
    assert_eq!(form.fields[0].choices.len(), 2);
    // An answer to a different field count is refused and leaves the question where it was.
    let too_many = vec![FieldAnswer::default(), FieldAnswer::default()];
    assert!(matches!(
        session.answer_question(&question.request_id, &question.digest, &too_many),
        Err(Refusal::Invalid(_))
    ));
    eventually("the answer to be accepted", || {
        match session.answer_question(
            &question.request_id,
            &question.digest,
            &[FieldAnswer {
                choice: Some(1),
                ..FieldAnswer::default()
            }],
        ) {
            Err(Refusal::TooSoon) => None,
            other => {
                other.expect("accepted");
                Some(())
            }
        }
    });

    let end = eventually("the turn to finish", || {
        let s = session.snapshot();
        (s.phase == SessionPhase::Idle && !messages(&s, Role::Agent).is_empty()).then_some(s)
    });
    // The agent says which answers reached it: the permission's option and that the form was accepted.
    assert_eq!(
        messages(&end, Role::Agent).last().map(String::as_str),
        Some("answered:allow/accept")
    );
    assert!(notes(&end).iter().any(|n| n == "Answered: Allow once"));
    assert_eq!(end.title.as_deref(), Some("Fake title"));
}

#[test]
fn withdrawing_a_request_cancels_it_and_refusing_stops_nothing_by_itself() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    session.send("perm:rm -rf /tmp/x", &[]).expect("send");
    let blocked = eventually("the request", || {
        let s = session.snapshot();
        s.needs_you().then_some(s)
    });
    let w = blocked.waiting[0].clone();
    let Ask::Permission(view) = &w.ask else {
        panic!("a permission")
    };
    // The command the person approves is shown whole, and the same rules the terminal prompts use say
    // why it deserves a second look.
    assert_eq!(view.title, "rm -rf /tmp/x");
    eventually("the dismissal to be accepted", || {
        match session.dismiss(&w.request_id, &w.digest) {
            Err(Refusal::TooSoon) => None,
            other => {
                other.expect("accepted");
                Some(())
            }
        }
    });
    let end = eventually("the session to rest", || {
        let s = session.snapshot();
        (!s.needs_you() && s.phase == SessionPhase::Idle).then_some(s)
    });
    assert!(notes(&end).iter().any(|n| n == "Cancelled the request"));
}

#[test]
fn a_message_sent_while_the_agent_works_waits_and_goes_when_the_turn_ends() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    session.send("slow", &[]).expect("send");
    eventually("the turn to start", || {
        session.snapshot().running.then_some(())
    });
    assert_eq!(session.send("plain", &[]), Ok(SendOutcome::Queued));
    let queued = session.snapshot().queue.clone();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].text, "plain");

    // Stopping is the person's own: the queue goes on once the turn has ended.
    session.cancel().expect("cancel");
    let end = eventually("the queued message to go and be answered", || {
        let s = session.snapshot();
        (s.queue.is_empty() && messages(&s, Role::Agent).iter().any(|m| m == "Hello")).then_some(s)
    });
    assert_eq!(messages(&end, Role::User), ["slow", "plain"]);
}

#[test]
fn a_queued_message_can_be_taken_back() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    session.send("quiet", &[]).expect("send");
    eventually("the turn to start", || {
        session.snapshot().running.then_some(())
    });
    session.send("draft", &[]).expect("queue");
    let id = session.snapshot().queue[0].id;
    let back = session.unqueue(id).expect("call").expect("still waiting");
    assert_eq!(back.text, "draft");
    assert!(session.snapshot().queue.is_empty());
    assert_eq!(session.unqueue(id).expect("call"), None);
    session.cancel().expect("cancel");
}

// ---- leaving and coming back -------------------------------------------------------------------

#[test]
fn closing_the_connection_leaves_the_agent_running_and_attaching_replays_the_conversation() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    let id = session.id().to_owned();
    wait_idle(&session);
    session.send("plain", &[]).expect("send");
    eventually("the answer", || {
        messages(&session.snapshot(), Role::Agent)
            .contains(&"Hello".to_owned())
            .then_some(())
    });

    hub.detach(LOCAL, &id);
    assert!(!session.is_open());
    // The keeper and its agent are still there.
    let kept = rig.local().list().expect("list");
    assert!(kept.iter().any(|k| k.id == id && k.alive()), "{kept:?}");

    let again = hub.attach(LOCAL, &id).expect("attach");
    let replayed = eventually("the replay", || {
        let s = again.snapshot();
        (s.phase == SessionPhase::Idle && messages(&s, Role::Agent).contains(&"Hello".to_owned()))
            .then_some(s)
    });
    assert_eq!(messages(&replayed, Role::User), ["plain"]);
    // And the session is usable again.
    assert_eq!(again.send("plain", &[]), Ok(SendOutcome::Sent));
}

#[test]
fn a_connection_that_dies_ends_the_session_here_without_blaming_the_agent() {
    let rig = Rig::new();
    let hub = rig.hub(rig.remote("devbox"));
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    let id = session.id().to_owned();
    wait_idle(&session);
    // The hub lists the machine in the background (once at start, once more after `start`), and each
    // listing is an ssh of its own that the stand-in also records: the last pid in the file may be one
    // of those, and killing it changes nothing. The poller is one thread, so once the new session is on
    // the board every listing has ended and the only ssh still alive is the one carrying the connection.
    eventually("the listing that shows the session", || {
        (!hub.rows().is_empty()).then_some(())
    });
    // Signal 0 asks whether the process exists, on every unix (macOS has no /proc).
    let alive = |pid: i32| {
        rustix::process::Pid::from_raw(pid)
            .is_some_and(|p| rustix::process::test_kill_process(p).is_ok())
    };
    let pid = eventually("exactly one ssh to be alive", || {
        let pids: Vec<i32> = std::fs::read_to_string(rig.dir.path().join("ssh-pids"))
            .ok()?
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .filter(|p| alive(*p))
            .collect();
        (pids.len() == 1).then(|| pids[0])
    });
    // What a dropped ssh looks like from here: the process that carries the connection is gone. It is
    // this test's own child.
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(pid).expect("pid"),
        rustix::process::Signal::KILL,
    )
    .expect("kill our own child");
    let s = eventually("the session to notice", || {
        let s = session.snapshot();
        matches!(s.phase, SessionPhase::Ended(_)).then_some(s)
    });
    assert!(
        s.connection_lost,
        "the agent did not exit: only the connection did"
    );
    assert!(!session.is_open());
    // The agent is still there, and attaching again is the way back.
    assert!(
        rig.remote("devbox")
            .list()
            .expect("list")
            .iter()
            .any(|k| k.id == id && k.alive())
    );
    assert!(hub.handle(LOCAL, &id).is_none());
    let again = hub.attach(LOCAL, &id).expect("attach again");
    wait_idle(&again);
}

#[test]
fn an_agent_that_exits_ends_the_session_and_says_so() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    session.send("exit:3", &[]).expect("send");
    let s = eventually("the end", || {
        let s = session.snapshot();
        matches!(s.phase, SessionPhase::Ended(_)).then_some(s)
    });
    assert!(!s.connection_lost);
    // Nothing can reach an agent that is gone.
    eventually("the connection to close", || {
        (!session.is_open()).then_some(())
    });
    assert_eq!(session.send("plain", &[]), Err(Refusal::Ended));
}

#[test]
fn what_the_machine_no_longer_keeps_is_said_at_the_top() {
    let rig = Rig::new();
    // A keeper that keeps only a few messages drops the oldest turns of the replay.
    let host = rig.local_with(&[("HERDR_KEEPER_LOG_MESSAGES", "6")]);
    let hub = rig.hub(host);
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    let id = session.id().to_owned();
    wait_idle(&session);
    for n in 0..6 {
        session.send("plain", &[]).expect("send");
        eventually(&format!("turn {n} to end"), || {
            let s = session.snapshot();
            (!s.running
                && s.phase == SessionPhase::Idle
                && s.queue.is_empty()
                && messages(&s, Role::User).len() == n + 1
                && messages(&s, Role::Agent).len() > n)
                .then_some(())
        });
    }
    hub.detach(LOCAL, &id);
    let again = hub.attach(LOCAL, &id).expect("attach");
    let s = eventually("the replay", || {
        let s = again.snapshot();
        (s.phase == SessionPhase::Idle).then_some(s)
    });
    let notice = s.earlier_notice.clone().expect("a notice");
    assert!(
        notice.starts_with("Earlier messages are no longer kept on the machine ("),
        "{notice}"
    );
    assert!(messages(&s, Role::User).len() < 6);
}

#[test]
fn a_past_session_can_be_continued_in_a_new_keeper() {
    let rig = Rig::new();
    let store = rig.dir.path().join("store.json");
    std::fs::write(
        &store,
        serde_json::json!({"sessions": [{
            "sessionId": "old-1", "cwd": rig.cwd(), "title": "Yesterday's work",
            "updatedAt": "2026-11-06T10:00:00Z", "messageCount": 2,
            "updates": [
                {"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "earlier question"}},
                {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "earlier answer"}}
            ]
        }]})
        .to_string(),
    )
    .expect("store");
    let host = rig.local_with(&[("FAKE_ACP_STORE", &store.display().to_string())]);
    let hub = rig.hub(host);

    let past = hub
        .history(LOCAL, "omp", Some(&rig.cwd()))
        .expect("history");
    assert!(past.can_list && past.can_load);
    assert_eq!(past.sessions.len(), 1);
    assert_eq!(past.sessions[0].title.as_deref(), Some("Yesterday's work"));
    assert_eq!(past.sessions[0].message_count, Some(2));

    let session = hub
        .resume(LOCAL, "omp", &rig.cwd(), &past.sessions[0].session_id)
        .expect("resume");
    let s = eventually("the old conversation to replay", || {
        let s = session.snapshot();
        (s.phase == SessionPhase::Idle && !messages(&s, Role::Agent).is_empty()).then_some(s)
    });
    assert_eq!(messages(&s, Role::User), ["earlier question"]);
    assert_eq!(messages(&s, Role::Agent), ["earlier answer"]);
}

#[test]
fn a_machine_taken_away_takes_its_sessions_with_it() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    eventually("the session on the board", || {
        (!hub.rows().is_empty()).then_some(())
    });
    hub.remove_host(LOCAL);
    assert!(!session.is_open(), "its connection closed with its host");
    assert!(hub.rows().is_empty());
    assert!(matches!(hub.list(LOCAL), Err(KeeperError::NoMachine(_))));
    assert!(matches!(
        hub.attach(LOCAL, session.id()),
        Err(KeeperError::NoMachine(_))
    ));
    // The agent was not stopped: only this app's view of it went.
    assert!(
        rig.local()
            .list()
            .expect("list")
            .iter()
            .any(|k| k.id == session.id() && k.alive())
    );
}

// ---- limits, ownership and the board --------------------------------------------------------------

#[test]
fn at_most_four_sessions_are_open_on_a_machine() {
    let rig = Rig::new();
    let hub = rig.hub(rig.local());
    let mut open = Vec::new();
    for _ in 0..MAX_ATTACHED {
        let s = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
        wait_idle(&s);
        open.push(s);
    }
    match hub.start(LOCAL, "omp", &rig.cwd()) {
        Err(KeeperError::TooMany(m)) => assert!(m.contains('4'), "{m}"),
        Err(other) => panic!("{other:?}"),
        Ok(_) => panic!("a fifth session opened"),
    }
    // Nothing was started for the refused one.
    assert_eq!(rig.local().list().expect("list").len(), MAX_ATTACHED);
    // Closing one makes room.
    let first = open[0].id().to_owned();
    hub.detach(LOCAL, &first);
    let again = hub.attach(LOCAL, &first).expect("room again");
    wait_idle(&again);
}

#[test]
fn only_a_keeper_this_app_started_is_ended_by_it() {
    let rig = Rig::new();
    let saved = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let mut config = HubConfig::new(Arc::new(|| {}));
    let sink = saved.clone();
    config.on_owned = Arc::new(move |all| *sink.lock() = all.to_vec());
    let hub = SessionHub::new(config);
    hub.set_host(LOCAL, rig.local());

    // A keeper somebody else started (the phone, a terminal) is not ours.
    let foreign = rig.local().start("omp", &rig.cwd()).expect("start");
    let refused = hub.kill(LOCAL, &foreign.id);
    assert!(
        matches!(refused, Err(KeeperError::NotOwned(_))),
        "{refused:?}"
    );
    assert!(
        rig.local()
            .list()
            .expect("list")
            .iter()
            .any(|k| k.id == foreign.id && k.alive())
    );

    let ours = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    assert_eq!(*saved.lock(), [format!("{LOCAL}/{}", ours.id())]);
    wait_idle(&ours);
    hub.kill(LOCAL, ours.id()).expect("ours is ended");
    assert!(saved.lock().is_empty());
    assert!(
        rig.local()
            .list()
            .expect("list")
            .iter()
            .all(|k| k.id != ours.id())
    );
    assert!(
        rig.local()
            .list()
            .expect("list")
            .iter()
            .any(|k| k.id == foreign.id)
    );
}

#[test]
fn a_session_that_needs_the_person_is_counted_with_the_terminal_agents_that_do() {
    let rig = Rig::new();
    let changes = Arc::new(AtomicUsize::new(0));
    let counter = changes.clone();
    let hub = SessionHub::new(HubConfig::new(Arc::new(move || {
        counter.fetch_add(1, Ordering::Relaxed);
    })));
    hub.set_host(LOCAL, rig.local());
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    let board = |rows: &[SessionRow], state: LinkState| {
        Board::from(
            &[(LOCAL.to_owned(), Arc::new(Snapshot::default()), state)],
            herdr_core::board::BoardExtras {
                sessions: rows,
                names: &Default::default(),
                pins: &Default::default(),
            },
            &Reviewed::default(),
            &FirstSeen::new(),
            Instant::now(),
        )
    };

    let rows = eventually("the session on the board", || {
        let rows = hub.rows();
        (!rows.is_empty()).then_some(rows)
    });
    assert_eq!(rows[0].status, AgentStatus::Idle);
    let idle = board(&rows, LinkState::Online);
    assert_eq!((idle.counts.needs_you, idle.counts.idle), (0, 1));

    session.send("ask", &[]).expect("send");
    let rows = eventually("the session to need you", || {
        let rows = hub.rows();
        (rows.first()?.status == AgentStatus::Blocked).then_some(rows)
    });
    let blocked = board(&rows, LinkState::Online);
    assert_eq!(blocked.counts.needs_you, 1);
    assert_eq!(
        blocked.needs_you[0].key(),
        format!("{LOCAL}/session:{}", session.id())
    );
    assert!(blocked.needs_you[0].session);
    // The same session on a machine that is not connected is listed dimmed and not counted.
    let offline = board(&rows, LinkState::Offline);
    assert_eq!((offline.counts.needs_you, offline.counts.offline), (0, 1));
    assert!(offline.needs_you[0].offline);
    assert!(changes.load(Ordering::Relaxed) > 0, "the screens were told");
}

// ---- another machine --------------------------------------------------------------------------

#[test]
fn a_remote_machine_gets_the_keeper_installed_once_asked_and_runs_sessions_through_it() {
    let rig = Rig::new();
    let host = rig.remote("devbox");
    // Asking what is there does not install anything on a machine.
    assert!(matches!(
        host.list_if_installed(),
        Err(KeeperError::NotInstalled(_))
    ));
    assert!(!rig.home.join(".herdr-mobile/desktop").exists());

    let hub = rig.hub(host);
    let routes = hub.probe(LOCAL).expect("probe installs, then asks");
    assert!(routes.iter().any(|r| r.id == "omp"));
    let installed: Vec<_> = std::fs::read_dir(rig.home.join(".herdr-mobile/desktop"))
        .expect("dir")
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("keeper-"))
        .collect();
    assert_eq!(installed.len(), 1);
    let mode = installed[0].metadata().expect("meta").permissions().mode() & 0o777;
    assert_eq!(mode, 0o700, "the script is private");

    // A whole conversation over `attach --z`: long replies travel deflated.
    let session = hub.start(LOCAL, "omp", &rig.cwd()).expect("start");
    wait_idle(&session);
    session.send("long:200", &[]).expect("send");
    let s = eventually("200 chunks", || {
        let s = session.snapshot();
        (s.phase == SessionPhase::Idle && messages(&s, Role::Agent).len() >= 200).then_some(s)
    });
    assert_eq!(messages(&s, Role::Agent).len(), 200);
    // And back after closing: the replay arrives through the same zipped stream.
    let id = session.id().to_owned();
    hub.detach(LOCAL, &id);
    let again = hub.attach(LOCAL, &id).expect("attach");
    let s = eventually("the replay", || {
        let s = again.snapshot();
        (s.phase == SessionPhase::Idle && messages(&s, Role::Agent).len() >= 200).then_some(s)
    });
    assert_eq!(messages(&s, Role::User), ["long:200"]);
}

#[test]
fn a_remote_machine_without_python_says_so() {
    let rig = Rig::new();
    let host = rig.remote("no-python");
    match host.probe() {
        Err(KeeperError::NoPython(m)) => assert!(m.contains("python3"), "{m}"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn nothing_the_person_typed_runs_in_a_remote_shell() {
    let rig = Rig::new();
    let host = rig.remote("devbox");
    host.probe().expect("probe installs");
    let marker = rig.dir.path().join("pwned");
    for evil in [
        format!("/tmp/x'; touch {}; '", marker.display()),
        format!("/tmp/$(touch {})", marker.display()),
        format!("/tmp/`touch {}`", marker.display()),
        format!("/tmp/x\" ; touch {} ; \"", marker.display()),
        format!("/tmp/x && touch {}", marker.display()),
    ] {
        // The folder does not exist, which is all the keeper says: the text was one word to the shell.
        match host.start("omp", &evil) {
            Err(KeeperError::Gone(m)) => assert!(m.contains("does not exist"), "{m}"),
            other => panic!("{evil}: {other:?}"),
        }
        assert!(!marker.exists(), "a command ran for {evil}");
    }
    // A newline would end the word: it never gets that far.
    assert!(matches!(
        host.start("omp", "/tmp/a\ntouch x"),
        Err(KeeperError::Invalid(_))
    ));
    assert!(matches!(
        host.history("omp; id", None),
        Err(KeeperError::Invalid(_))
    ));
}

// ---- the real agent ---------------------------------------------------------------------------------

/// A real `omp acp` in a scratch folder, one harmless prompt, then the session is ended. Not run by
/// default: it needs omp, its login, and writes `~/.herdr-mobile/keepers` and omp's own session store.
/// `HERDR_DESKTOP_REAL_OMP=<scratch folder> cargo test --test session real_omp -- --ignored --nocapture`.
#[test]
#[ignore = "starts the real omp"]
fn real_omp_answers_one_harmless_prompt() {
    let folder = std::env::var("HERDR_DESKTOP_REAL_OMP")
        .expect("HERDR_DESKTOP_REAL_OMP names a scratch folder");
    std::fs::create_dir_all(&folder).expect("scratch folder");
    let home = dirs::home_dir().expect("home");
    let hub = SessionHub::new(HubConfig::new(Arc::new(|| {})));
    hub.set_host(LOCAL, Arc::new(KeeperHost::local(home)));
    let session = hub.start(LOCAL, "omp", &folder).expect("omp starts");
    let id = session.id().to_owned();
    let opened = eventually("omp to open the session", || {
        let s = session.snapshot();
        match s.phase {
            SessionPhase::Idle => Some(s),
            SessionPhase::Ended(ref why) => panic!("the session ended: {why}"),
            _ => None,
        }
    });
    println!(
        "options: {:?}",
        opened
            .options
            .iter()
            .map(|o| (&o.name, &o.current))
            .collect::<Vec<_>>()
    );
    session
        .send(
            "Reply with the single word pong. Do not use any tools.",
            &[],
        )
        .expect("sent");
    let end = eventually("the turn to end", || {
        let s = session.snapshot();
        // Nothing is ever approved by this test: a request would fail it.
        assert!(!s.needs_you(), "omp asked for something: {:?}", s.waiting);
        s.items
            .iter()
            .any(|i| matches!(i.kind, ItemKind::Done { .. }))
            .then_some(s)
    });
    println!("agent said: {:?}", messages(&end, Role::Agent));
    println!("notes: {:?}", notes(&end));
    hub.kill(LOCAL, &id)
        .expect("ends the keeper this test started");
}
