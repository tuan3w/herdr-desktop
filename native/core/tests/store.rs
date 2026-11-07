//! The files the app keeps: round trips, atomicity, permissions and what happens to a file it cannot read.

use std::os::unix::fs::PermissionsExt;

use herdr_core::store::{Machine, Machines, ReviewKey, Reviewed, Settings, Store};
use serde_json::json;
use tempfile::tempdir;

fn remote(id: &str, name: &str) -> Machine {
    Machine {
        id: id.into(),
        name: name.into(),
        dest: format!("dev@{name}"),
        port: Some(2222),
        session: Some("work".into()),
        enabled: true,
    }
}

#[test]
fn machines_survive_a_restart_and_this_computer_is_always_first() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let mut machines = Machines::default();
    machines.upsert(remote("m1", "box"));
    machines.upsert(remote("m2", "lab"));
    store.save_machines(&machines).unwrap();

    let loaded = Store::open(dir.path()).unwrap().machines();
    assert_eq!(loaded.warning, None);
    let all = loaded.value.all();
    assert_eq!(
        all.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["local", "m1", "m2"]
    );
    assert_eq!(all[0].name, "This computer");
    assert_eq!(all[1], remote("m1", "box"));
}

#[test]
fn upserting_replaces_removing_removes_and_the_local_machine_is_never_stored() {
    let mut machines = Machines::default();
    machines.upsert(remote("m1", "box"));
    let mut edited = remote("m1", "box");
    edited.enabled = false;
    machines.upsert(edited.clone());
    machines.upsert(Machine::local());
    assert_eq!(machines.all().len(), 2);
    assert_eq!(machines.get("m1"), Some(edited));
    assert!(machines.remove("m1"));
    assert!(!machines.remove("m1"));
    assert_eq!(machines.all().len(), 1);
    assert_eq!(machines.get("local"), Some(Machine::local()));
}

#[test]
fn new_machine_ids_never_collide() {
    let mut machines = Machines::default();
    for _ in 0..5 {
        let id = machines.next_id();
        assert!(machines.get(&id).is_none());
        machines.upsert(remote(&id, "box"));
    }
    assert_eq!(machines.all().len(), 6);
}

#[test]
fn reviewed_marks_survive_a_restart() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let mut reviewed = Reviewed::default();
    assert!(reviewed.review(ReviewKey::new("local", "w1:p2", 7)));
    assert!(
        !reviewed.review(ReviewKey::new("local", "w1:p2", 7)),
        "marking twice changes nothing"
    );
    store.save_reviewed(&reviewed).unwrap();

    let loaded = Store::open(dir.path()).unwrap().reviewed().value;
    assert!(loaded.is_reviewed(&ReviewKey::new("local", "w1:p2", 7)));
    assert!(
        !loaded.is_reviewed(&ReviewKey::new("local", "w1:p2", 8)),
        "a later finished state is a new one"
    );
    assert!(!loaded.is_reviewed(&ReviewKey::new("other", "w1:p2", 7)));
}

#[test]
fn reconcile_drops_marks_for_agents_that_left_the_done_state_or_the_machine() {
    let snap = |status: &str| {
        herdr_core::schema::Snapshot::from_result(&json!({"snapshot": {"agents": [
            {"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "t", "agent_status": status, "state_change_seq": 7},
            {"pane_id": "w1:p2", "workspace_id": "w1", "tab_id": "t", "agent_status": "done", "state_change_seq": 2}
        ]}}))
        .unwrap()
    };
    let mut reviewed = Reviewed::default();
    reviewed.review(ReviewKey::new("box", "w1:p1", 7));
    reviewed.review(ReviewKey::new("box", "w1:p2", 2));
    reviewed.review(ReviewKey::new("box", "w1:gone", 1));
    reviewed.review(ReviewKey::new("lab", "w9:p1", 1));

    assert!(reviewed.reconcile("box", &snap("done")));
    assert_eq!(
        reviewed.len(),
        3,
        "only the agent that no longer exists lost its mark"
    );
    // Left `done`: a later finish must not be able to match the old mark (herdr's counters restart with its server).
    assert!(reviewed.reconcile("box", &snap("working")));
    assert!(!reviewed.is_reviewed(&ReviewKey::new("box", "w1:p1", 7)));
    assert!(
        reviewed.is_reviewed(&ReviewKey::new("lab", "w9:p1", 1)),
        "another machine is untouched"
    );

    reviewed.forget_machine("lab");
    assert!(!reviewed.is_reviewed(&ReviewKey::new("lab", "w9:p1", 1)));
}

#[test]
fn settings_keep_what_they_do_not_know_and_refuse_the_version_key() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let mut settings = Settings::default();
    settings.set("minContrast", 4.5).unwrap();
    settings.set("announceOutput", true).unwrap();
    settings.set("phrases", ["continue", "yes"]).unwrap();
    assert!(settings.set("v", 2).is_err());
    store.save_settings(&settings).unwrap();

    let mut loaded = Store::open(dir.path()).unwrap().settings().value;
    assert_eq!(loaded.get::<f64>("minContrast"), Some(4.5));
    assert!(loaded.get_or("announceOutput", false));
    assert_eq!(
        loaded.get::<Vec<String>>("phrases"),
        Some(vec!["continue".into(), "yes".into()])
    );
    assert_eq!(
        loaded.get::<bool>("minContrast"),
        None,
        "the wrong type reads as unset"
    );
    assert_eq!(loaded.get_or("missing", 3), 3);
    assert!(loaded.remove("announceOutput"));
    assert!(!loaded.remove("announceOutput"));
    assert_eq!(loaded.keys().count(), 2);
}

#[test]
fn files_are_private_and_no_temp_file_is_left_behind() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("herdr");
    let store = Store::open(&data).unwrap();
    store.save_machines(&Machines::default()).unwrap();
    store.save_settings(&Settings::default()).unwrap();
    assert_eq!(
        std::fs::metadata(&data).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        std::fs::metadata(data.join("machines.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let mut names: Vec<_> = std::fs::read_dir(&data)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["machines.json", "settings.json"]);
}

#[test]
fn a_file_that_cannot_be_read_is_kept_aside_and_reported() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    for (content, label) in [
        ("{ not json", "invalid JSON"),
        ("[1,2]", "an array"),
        (r#"{"machines": []}"#, "no version"),
    ] {
        std::fs::write(dir.path().join("machines.json"), content).unwrap();
        let loaded = store.machines();
        assert_eq!(
            loaded.value.all().len(),
            1,
            "{label}: starts with this computer only"
        );
        let warning = loaded
            .warning
            .unwrap_or_else(|| panic!("{label}: no warning"));
        assert!(warning.contains("machines.json"), "{warning}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("machines.json.corrupt")).unwrap(),
            content,
            "{label}: nothing is lost"
        );
        assert!(!dir.path().join("machines.json").exists());
    }
}

#[test]
fn a_file_with_a_machine_it_cannot_read_is_kept_aside_too() {
    let dir = tempdir().unwrap();
    std::fs::write(
        dir.path().join("machines.json"),
        r#"{"v":1,"machines":[{"id":"m1"}]}"#,
    )
    .unwrap();
    let loaded = Store::open(dir.path()).unwrap().machines();
    assert!(loaded.warning.is_some());
    assert!(dir.path().join("machines.json.corrupt").exists());
}

#[test]
fn a_file_from_a_newer_app_is_not_overwritten() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let newer = r#"{"v":99,"machines":[]}"#;
    std::fs::write(dir.path().join("machines.json"), newer).unwrap();
    let loaded = store.machines();
    assert!(loaded.warning.unwrap().contains("newer"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("machines.json.newer")).unwrap(),
        newer
    );
}

#[test]
fn a_missing_file_is_just_empty() {
    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    assert_eq!(store.reviewed().warning, None);
    assert!(store.reviewed().value.is_empty());
    assert_eq!(store.settings().warning, None);
}

#[test]
fn an_empty_path_means_a_private_directory_of_its_own() {
    let a = Store::open("").unwrap();
    let b = Store::open("").unwrap();
    assert_ne!(a.dir(), b.dir());
    assert!(a.dir().is_dir());
    assert_eq!(
        std::fs::metadata(a.dir()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let _ = std::fs::remove_dir_all(a.dir());
    let _ = std::fs::remove_dir_all(b.dir());
}

#[test]
fn recents_survive_a_restart_newest_first_and_a_foreign_file_is_set_aside() {
    use herdr_core::recents::Recents;

    let dir = tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let mut recents = Recents::default();
    recents.visit("agent:local/w1:p1", 1_000);
    recents.visit("project:payments", 2_000);
    store.save_recents(&recents).unwrap();
    let mode = std::fs::metadata(dir.path().join("recents.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);

    let loaded = Store::open(dir.path()).unwrap().recents();
    assert_eq!(loaded.warning, None);
    assert_eq!(loaded.value, recents);

    std::fs::write(
        dir.path().join("recents.json"),
        "{\"v\":1,\"recents\":\"nope\"}",
    )
    .unwrap();
    let broken = Store::open(dir.path()).unwrap().recents();
    assert!(broken.warning.is_some());
    assert!(broken.value.entries().is_empty());
    assert!(dir.path().join("recents.json.corrupt").exists());
}
