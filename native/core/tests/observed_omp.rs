//! The real omp mapper, kind and keeper `follow`, together: an omp log on disk (synthetic, shaped like omp's own)
//! becomes the chat the screens render, and an omp tool call with its result becomes a tool row.

use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

use herdr_core::observed::kinds::kind_for;
use herdr_core::observed::model::{Location, Locator};
use herdr_core::observed::session::{PaneIo, PaneState};
use herdr_core::schema::AgentStatus;
use herdr_core::session::{
    HubConfig, ItemKind, KeeperHost, Role, SessionHub, SessionPhase, ToolStatus,
};
use serde_json::{Value, json};

struct Pane {
    log: String,
}

impl PaneIo for Pane {
    fn state(&self) -> PaneState {
        PaneState::Agent {
            status: AgentStatus::Idle,
            cwd: Some("/home/dev/payments-api".into()),
            title: Some("π > payments-api".into()),
        }
    }
    fn locate(&self, _: &dyn Locator) -> Location {
        Location::Located(self.log.clone())
    }
    fn read_screen(&self) -> Result<String, String> {
        Ok(String::new())
    }
    fn send_input(&self, _: &str, _: &[String]) -> Result<(), String> {
        Ok(())
    }
    fn send_keys(&self, _: &[String]) -> Result<(), String> {
        Ok(())
    }
    fn read_file(&self, _: &str, _: usize) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
}

fn eventually<R>(what: &str, mut condition: impl FnMut() -> Option<R>) -> R {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(found) = condition() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn line(v: Value) -> String {
    format!("{v}\n")
}

#[test]
fn an_omp_log_becomes_a_chat_with_its_tool_rows_and_follows_what_omp_appends() {
    let dir = tempfile::tempdir().expect("tempdir");
    let home = dir.path().join("home");
    let log = home.join(".omp/agent/sessions/-payments-api/2026-11-06_abc.jsonl");
    std::fs::create_dir_all(log.parent().expect("parent")).expect("mkdir");
    std::fs::write(
        &log,
        [
            line(json!({"type": "session", "id": "sess", "cwd": "/home/dev/payments-api"})),
            line(json!({"type": "message", "id": "u1", "message": {"role": "user", "content": [{"type": "text", "text": "list the files"}]}})),
            line(json!({"type": "message", "id": "a1", "message": {"role": "assistant", "stopReason": "stop",
                "content": [{"type": "text", "text": "Here they are."}]}})),
        ]
        .concat(),
    )
    .expect("write");

    let hub = SessionHub::new(HubConfig::new(Arc::new(|| {})));
    hub.set_host(
        "local",
        Arc::new(KeeperHost::local(&home).env("PATH", "/usr/bin:/bin")),
    );
    let kind = kind_for("omp").expect("omp is a kind");
    assert_eq!((kind.id, kind.label), ("omp", "omp"));
    let chat = hub
        .observe(
            "local",
            "w1:p1",
            kind,
            Arc::new(Pane {
                log: log.display().to_string(),
            }),
        )
        .expect("observe");

    let s = eventually("the replay", || {
        let s = chat.snapshot();
        (s.phase == SessionPhase::Idle && s.items.len() == 2).then_some(s)
    });
    let texts: Vec<(Role, String)> = s
        .items
        .iter()
        .filter_map(|i| match &i.kind {
            ItemKind::Message { role, text, .. } => Some((*role, text.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        texts,
        [
            (Role::User, "list the files".to_owned()),
            (Role::Agent, "Here they are.".to_owned())
        ]
    );
    assert!(s.observed.as_ref().expect("observed").turn_ended);
    // omp's own title is `π > payments-api`: only the folder says nothing, so the chat is named by it.
    assert_eq!(s.title.as_deref(), Some("π > payments-api"));

    // omp appends a tool call and its result: one tool row, finished.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&log)
        .expect("log");
    write!(
        file,
        "{}{}",
        line(json!({"type": "message", "id": "a2", "message": {"role": "assistant", "stopReason": "toolUse",
            "content": [{"type": "toolCall", "id": "call_1", "name": "bash", "arguments": {"command": "ls"}}]}})),
        line(json!({"type": "message", "id": "r1", "message": {"role": "toolResult", "toolCallId": "call_1", "toolName": "bash",
            "content": [{"type": "text", "text": "Cargo.toml\nsrc"}], "isError": false}})),
    )
    .expect("append");
    let tool = eventually("the tool row", || {
        chat.snapshot().items.iter().find_map(|i| match &i.kind {
            ItemKind::Tool(t) if t.status == ToolStatus::Completed => Some(t.clone()),
            _ => None,
        })
    });
    assert_eq!(tool.subject.as_deref(), Some("ls"));
    assert_eq!(tool.head, ["Cargo.toml", "src"]);
}
