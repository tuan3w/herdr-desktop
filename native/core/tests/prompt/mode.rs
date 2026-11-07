//! How a session mode lowers the guard: the modes the four routes send, their
//! spellings, and modes nobody listed.

use herdr_core::prompt::{ModeRisk, assess_mode};

fn risk(id: &str, name: Option<&str>) -> ModeRisk {
    assess_mode(Some(id), name).risk
}

// What each route sends: id, name, expected risk.
const KNOWN: &[(&str, &str, ModeRisk)] = &[
    // Claude Code
    ("default", "Default", ModeRisk::None),
    ("plan", "Plan Mode", ModeRisk::None),
    ("dontAsk", "Don't Ask", ModeRisk::None),
    ("acceptEdits", "Accept Edits", ModeRisk::Elevated),
    ("auto", "Auto", ModeRisk::Elevated),
    (
        "bypassPermissions",
        "Bypass Permissions",
        ModeRisk::Dangerous,
    ),
    // Codex
    ("read-only", "Read-only", ModeRisk::None),
    ("workspace-write", "Workspace access", ModeRisk::None),
    ("agent", "Auto review", ModeRisk::Elevated),
    ("agent-full-access", "Full access", ModeRisk::Dangerous),
    // omp
    ("plan", "Plan", ModeRisk::None),
];

#[test]
fn known_modes_are_classified_by_id_and_by_name() {
    for (id, name, expected) in KNOWN {
        assert_eq!(risk(id, Some(name)), *expected, "{id} ({name})");
        assert_eq!(risk(id, None), *expected, "{id}: the id alone");
        let a = assess_mode(Some(id), Some(name));
        assert_eq!(
            a.reason.is_none(),
            *expected == ModeRisk::None,
            "{id}: a reason exactly when risky"
        );
        assert_eq!(a.is_risky(), *expected != ModeRisk::None, "{id}");
    }
}

#[test]
fn one_mode_many_spellings() {
    for s in [
        "bypassPermissions",
        "bypass_permissions",
        "bypass-permissions",
        "BYPASSPERMISSIONS",
        "Bypass Permissions",
        "  bypass permissions  ",
        "bypass\u{200B}Permissions",
        "bypass\u{202E}Permissions",
    ] {
        assert_eq!(risk(s, None), ModeRisk::Dangerous, "{s}");
    }
    for s in [
        "agent-full-access",
        "agent_full_access",
        "AGENT FULL ACCESS",
        "Full access",
        "FULL-ACCESS",
        "danger-full-access",
    ] {
        assert_eq!(risk(s, None), ModeRisk::Dangerous, "{s}");
    }
    for s in [
        "acceptEdits",
        "accept_edits",
        "ACCEPT EDITS",
        "Accept Edits",
    ] {
        assert_eq!(risk(s, None), ModeRisk::Elevated, "{s}");
    }
    for s in ["Auto", "AUTO", " auto "] {
        assert_eq!(risk(s, None), ModeRisk::Elevated, "{s}");
    }
}

#[test]
fn the_worse_of_id_and_name_wins() {
    assert_eq!(
        risk("default", Some("Bypass Permissions")),
        ModeRisk::Dangerous
    );
    assert_eq!(
        risk("bypassPermissions", Some("Default")),
        ModeRisk::Dangerous
    );
    assert_eq!(risk("default", Some("Accept Edits")), ModeRisk::Elevated);
    assert_eq!(risk("default", Some("Default")), ModeRisk::None);
}

#[test]
fn words_that_mean_no_checks_are_dangerous() {
    for s in [
        "bypass",
        "bypass-all",
        "super-bypass",
        "yolo",
        "YOLO mode",
        "full-access",
        "fullAccess",
        "dangerously-skip-permissions",
        "dangerouslyAllowAll",
        "skip-permissions",
        "skipPermissions",
        "no-sandbox",
    ] {
        let a = assess_mode(Some(s), None);
        assert_eq!(a.risk, ModeRisk::Dangerous, "{s}");
        assert!(a.reason.is_some(), "{s}");
    }
}

#[test]
fn words_that_mean_asks_for_less_are_elevated() {
    for s in [
        "auto-accept",
        "autoApprove",
        "auto_edit",
        "accept-all",
        "unrestricted",
        "never-ask",
        "no-prompts",
        "autonomous",
        "Auto mode",
        "dont-ask-again",
    ] {
        assert_eq!(risk(s, None), ModeRisk::Elevated, "{s}");
    }
}

#[test]
fn plain_unknown_names_are_none() {
    for s in [
        "custom",
        "author",
        "Chế độ an toàn",
        "安全模式",
        "review",
        "architect",
        "ask",
        "code",
        "",
        "   ",
        "\u{202E}",
    ] {
        assert_eq!(risk(s, None), ModeRisk::None, "{s:?}");
    }
    assert_eq!(assess_mode(None, None).risk, ModeRisk::None);
    assert_eq!(assess_mode(None, None).reason, None);
}

#[test]
fn the_reason_names_the_mode_cleaned_and_capped() {
    let a = assess_mode(Some(&format!("yolo\u{202E}-{}", "x".repeat(100))), None);
    let reason = a.reason.unwrap();
    assert!(
        reason.contains("looks like it skips permission checks"),
        "{reason}"
    );
    assert!(!reason.contains('\u{202E}'));
    assert!(reason.chars().count() < 120, "{reason}");
    assert_eq!(
        assess_mode(Some("autonomous"), None).reason.as_deref(),
        Some("The mode \"autonomous\" may ask for less than usual.")
    );
}

#[test]
fn descriptions_are_never_read() {
    // Claude's own `default` says it "prompts for dangerous operations".
    assert_eq!(risk("default", Some("Default")), ModeRisk::None);
}
