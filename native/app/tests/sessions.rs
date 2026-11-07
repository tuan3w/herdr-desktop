//! Agent sessions in the engine: the board counts them with the terminal agents, a restart remembers which
//! keepers this app started, and a session is never read as if it were a pane. The keeper is herdr-mobile's
//! real python script driving its scripted ACP agent, in a home of its own (the fixture seam).

mod common;

use common::{start, start_in, wait_for};
use herdr_core::session::{Refusal, SessionPhase};
use herdr_desktop_native::engine::Engine;

/// Ends the keepers a test started, even when it fails.
struct Keepers<'a>(&'a Engine);

impl Drop for Keepers<'_> {
    fn drop(&mut self) {
        if let Ok(all) = self.0.sessions().list("local") {
            for keeper in all {
                let _ = self.0.sessions().kill("local", &keeper.id);
            }
        }
    }
}

fn cwd(rig: &common::Rig) -> String {
    let dir = rig.dir.path().join("work");
    std::fs::create_dir_all(&dir).expect("a folder to work in");
    dir.display().to_string()
}

#[test]
fn a_session_that_needs_you_is_on_the_board_counted_and_titled_with_the_agents_that_do() {
    let rig = start("empty");
    let _end = Keepers(&rig.engine);
    let session = rig
        .engine
        .sessions()
        .start("local", "omp", &cwd(&rig))
        .expect("a session starts");
    wait_for("the session to open", || {
        session.snapshot().phase == SessionPhase::Idle
    });

    wait_for("the session on the board", || {
        rig.engine.board().rows().any(|r| r.session)
    });
    let idle = rig.engine.board();
    let row = idle
        .rows()
        .find(|r| r.session)
        .expect("the session is on the board");
    assert_eq!(row.pane_id, session.id());
    assert_eq!(row.key(), format!("local/session:{}", session.id()));
    assert_eq!(
        (idle.board.counts.needs_you, idle.board.counts.idle),
        (0, 1)
    );

    session.send("ask", &[]).expect("sent");
    wait_for("the session to need you", || {
        rig.engine.board().board.counts.needs_you == 1
    });
    let blocked = rig.engine.board();
    assert_eq!(blocked.title, "(1) Herdr Desktop");
    assert!(
        blocked.status_line.contains("1 needs you") || blocked.status_line.contains("1 need you"),
        "{}",
        blocked.status_line
    );
    // A session has no pane: nothing was read for a preview, and no keeper id went to herdr as a pane.
    assert!(
        rig.sent("pane.read")
            .iter()
            .all(|p| !p.to_string().contains(session.id())),
        "a session was read as a pane"
    );
    assert!(blocked.previews.keys().all(|k| !k.contains("session:")));
    // The change counter moved, so a screen pulls.
    assert!(rig.ticks.load(std::sync::atomic::Ordering::Relaxed) > 0);
}

#[test]
fn a_restart_remembers_which_keepers_this_app_started_and_only_those_can_be_ended() {
    let rig = start("empty");
    let id = {
        let session = rig
            .engine
            .sessions()
            .start("local", "omp", &cwd(&rig))
            .expect("a session starts");
        wait_for("the session to open", || {
            session.snapshot().phase == SessionPhase::Idle
        });
        let id = session.id().to_owned();
        assert_eq!(
            rig.engine.setting("sessions.owned"),
            Some(serde_json::json!([format!("local/{id}")]))
        );
        // Leaves the agent running: a restart is not an end.
        rig.engine.sessions().detach("local", &id);
        id
    };
    let common::Rig { engine, dir, .. } = rig;
    // The end of a real process leaves the keepers running; dropping the engine would end the ones the
    // test seam started (so a failed test leaves nothing behind).
    std::mem::forget(engine);

    let rig = start_in("empty", dir);
    let _end = Keepers(&rig.engine);
    assert!(rig.engine.sessions().owns("local", &id));
    wait_for("the session to be listed again", || {
        rig.engine.sessions().rows().iter().any(|r| r.id == id)
    });
    // It is still there and still ours: attach, and end it.
    let again = rig.engine.sessions().attach("local", &id).expect("attach");
    wait_for("the replay", || {
        again.snapshot().phase == SessionPhase::Idle
    });
    rig.engine
        .sessions()
        .kill("local", &id)
        .expect("ours is ended");
    wait_for("the setting to forget it", || {
        rig.engine.setting("sessions.owned") == Some(serde_json::json!([]))
    });
    // Ending it closed this app's connection to it.
    assert_eq!(again.send("plain", &[]), Err(Refusal::Stopped));
}
