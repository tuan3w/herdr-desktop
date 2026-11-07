//! Helpers shared by the prompt tests.

use herdr_core::prompt::{self, PromptInfo, Risk};

/// A screen written as a Rust string: one leading newline is not a row, so the
/// first real row can start with the spaces it has on screen.
pub fn rows(screen: &str) -> Vec<String> {
    screen
        .strip_prefix('\n')
        .unwrap_or(screen)
        .split('\n')
        .map(str::to_owned)
        .collect()
}

/// What the detector makes of `screen`.
pub fn detect(screen: &str) -> Option<PromptInfo> {
    prompt::detect(&rows(screen))
}

/// The prompt of `screen`, which must have one.
pub fn found(screen: &str) -> PromptInfo {
    detect(screen).unwrap_or_else(|| panic!("no prompt found in:\n{screen}"))
}

/// The subject, `""` when there is none.
pub fn subject(p: &PromptInfo) -> &str {
    p.subject.as_deref().unwrap_or("")
}

/// The reason of every reply.
pub fn risks(p: &PromptInfo) -> Vec<Option<Risk>> {
    p.options.iter().map(|r| r.risk).collect()
}

/// Whether any reply asks for a second tap.
pub fn any_confirm(p: &PromptInfo) -> bool {
    p.options.iter().any(|r| r.needs_confirm())
}

/// `label | keys | confirm|plain` per reply, for compact expectations.
pub fn replies(p: &PromptInfo) -> Vec<String> {
    p.options
        .iter()
        .map(|r| {
            fmt(
                &r.label,
                &r.keys.iter().map(String::as_str).collect::<Vec<_>>(),
                r.needs_confirm(),
            )
        })
        .collect()
}

/// The same line for an expected reply.
pub fn fmt(label: &str, keys: &[&str], confirm: bool) -> String {
    format!(
        "{label} | {} | {}",
        keys.join(","),
        if confirm { "confirm" } else { "plain" }
    )
}
