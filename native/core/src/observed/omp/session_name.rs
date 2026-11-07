//! What an omp session log says the session is called, and what the person said last: the two things the
//! board can name an agent by.
//!
//! Read from two slices of the file, not the whole of it (a log runs to megabytes): the head, where omp keeps
//! its title record (a fixed-width first line it rewrites in place; older logs put the title in the `session`
//! entry), and the tail, for a later `title_change` and the last message of the person. Records that are not
//! understood are skipped: the log is omp's own and its shape is not ours to rely on (the mapper reads the
//! same entries).

use serde_json::Value;

/// The longest prompt kept, in characters. The board cuts it again to fit.
pub const PROMPT_CHARS: usize = 60;

/// What the board can name an omp agent by.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionName {
    /// The session's title, trimmed.
    pub title: Option<String>,
    /// The first line of the last thing the person typed, whitespace folded and cut to [`PROMPT_CHARS`].
    pub last_prompt: Option<String>,
}

/// The name of a session from `head` (the first bytes of its log, decoded as text) and `tail` (the last ones).
/// A `tail` that starts in the middle of the file (`tail_starts_mid_line`) has its first line dropped: it is a
/// fragment.
pub fn parse_session_name(head: &str, tail: &str, tail_starts_mid_line: bool) -> SessionName {
    let mut name = SessionName::default();
    scan(&mut name, head, false, false);
    scan(&mut name, tail, tail_starts_mid_line, true);
    name
}

fn scan(name: &mut SessionName, text: &str, drop_first: bool, read_prompts: bool) {
    for line in split_lines(text).into_iter().skip(usize::from(drop_first)) {
        // A line cut by the slice, or not JSON, is skipped.
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !entry.is_object() {
            continue;
        }
        match entry.get("type").and_then(Value::as_str) {
            Some("session" | "title" | "title_change") => {
                if let Some(t) = entry.get("title").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        name.title = Some(t.to_owned());
                    }
                }
            }
            Some("message") if read_prompts => {
                if let Some(p) = entry.get("message").and_then(prompt_of) {
                    name.last_prompt = Some(p);
                }
            }
            _ => {}
        }
    }
}

/// The lines of `text` as Dart's `LineSplitter` cuts them: `\n`, `\r\n` and a lone `\r` end a line, and a
/// text that ends with a line break has no empty last line.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                lines.push(&text[start..i]);
                start = i + 1;
            }
            b'\r' => {
                lines.push(&text[start..i]);
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// The first line of what the person typed, or `None` for a message that is not theirs, has no text, or is a
/// slash command or a system note (those say nothing about the work).
fn prompt_of(message: &Value) -> Option<String> {
    if message.get("role").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let text = match message.get("content")? {
        Value::String(s) => s.as_str(),
        Value::Array(blocks) => blocks.iter().find_map(|b| {
            (b.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| b.get("text").and_then(Value::as_str))
                .flatten()
        })?,
        _ => return None,
    };
    for raw in split_lines(text) {
        let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            continue;
        }
        if line.starts_with('/') || line.starts_with('<') {
            return None;
        }
        if line.chars().count() <= PROMPT_CHARS {
            return Some(line);
        }
        let kept: String = line.chars().take(PROMPT_CHARS - 1).collect();
        return Some(format!("{}…", kept.trim_end()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(v: Value) -> String {
        format!("{v}\n")
    }

    fn user(content: Value) -> String {
        line(json!({"type": "message", "message": {"role": "user", "content": content}}))
    }

    fn assistant(text: &str) -> String {
        line(json!({"type": "message", "message": {"role": "assistant",
            "content": [{"type": "text", "text": text}]}}))
    }

    fn text(s: &str) -> Value {
        json!([{"type": "text", "text": s}])
    }

    #[test]
    fn the_title_comes_from_omps_fixed_width_first_line() {
        let head = line(
            json!({"type": "title", "v": 1, "updatedAt": "2026-10-07T10:00:00Z",
            "title": "  Fix the retry failures  ", "pad": " ".repeat(80)}),
        );
        let name = parse_session_name(&head, &head, false);
        assert_eq!(name.title.as_deref(), Some("Fix the retry failures"));
    }

    #[test]
    fn the_title_comes_from_the_session_entry_of_an_older_log() {
        let head = line(
            json!({"type": "session", "cwd": "/home/dev/project", "title": "Old style title"}),
        );
        assert_eq!(
            parse_session_name(&head, "", false).title.as_deref(),
            Some("Old style title")
        );
    }

    #[test]
    fn a_later_title_change_in_the_tail_wins_over_the_head() {
        let head = line(json!({"type": "title", "title": "First title"}));
        let tail = user(text("hello")) + &line(json!({"type": "title_change", "title": "Renamed"}));
        assert_eq!(
            parse_session_name(&head, &tail, true).title.as_deref(),
            Some("Renamed")
        );
    }

    #[test]
    fn an_empty_or_missing_title_is_no_title() {
        let head =
            line(json!({"type": "title", "title": "   "})) + &line(json!({"type": "session"}));
        assert_eq!(parse_session_name(&head, "", false).title, None);
    }

    #[test]
    fn the_last_prompt_is_the_first_line_of_the_last_message_with_text() {
        let tail = user(text("Fix the retry test\nand explain why it was flaky"))
            + &assistant("Done.")
            + &user(text("Now  add a   regression test\nfor the parser"));
        assert_eq!(
            parse_session_name("", &tail, false).last_prompt.as_deref(),
            Some("Now add a regression test")
        );
    }

    #[test]
    fn a_plain_string_counts_and_images_and_the_agents_own_messages_are_skipped() {
        let tail = user(json!("Rotate the staging certificates"))
            + &user(json!([{"type": "image", "data": "AAAA"}]))
            + &assistant("Rotated.");
        assert_eq!(
            parse_session_name("", &tail, false).last_prompt.as_deref(),
            Some("Rotate the staging certificates")
        );
    }

    #[test]
    fn a_slash_command_or_a_system_note_says_nothing_about_the_work() {
        let tail = user(text("Profile the training step"))
            + &user(text("/compact"))
            + &user(text("<system-reminder>be brief</system-reminder>"));
        assert_eq!(
            parse_session_name("", &tail, false).last_prompt.as_deref(),
            Some("Profile the training step")
        );
    }

    #[test]
    fn a_long_prompt_is_cut_on_a_character_boundary_with_an_ellipsis() {
        let long = "Hà Nội ".repeat(20);
        let p = parse_session_name("", &user(text(&long)), false)
            .last_prompt
            .unwrap();
        let n = p.chars().count();
        assert!(n <= PROMPT_CHARS);
        // Only a trailing space is given up.
        assert!(n > PROMPT_CHARS - 4);
        assert!(p.ends_with('\u{2026}'));
        assert!(!p.contains(" \u{2026}"));
        assert!(p.starts_with("Hà Nội Hà Nội"));
    }

    #[test]
    fn the_head_is_not_searched_for_prompts() {
        let head = user(text("The very first message"));
        assert_eq!(parse_session_name(&head, "", false).last_prompt, None);
    }

    #[test]
    fn the_first_line_of_a_tail_that_starts_mid_file_is_a_fragment() {
        let whole = user(text("A complete message"));
        // The second half of a record (cut on a character boundary: the line is ASCII).
        let fragment = &whole[whole.len() / 2..];
        let tail = format!("{fragment}{}", user(text("The real last one")));
        let name = parse_session_name("", &tail, true);
        assert_eq!(name.last_prompt.as_deref(), Some("The real last one"));
    }

    #[test]
    fn lines_that_are_not_json_or_not_objects_are_skipped_not_fatal() {
        let text = format!(
            "not json\n[1,2]\n\"x\"\n{}{{\"type\":\"messa",
            line(json!({"type": "title", "title": "Survivor"}))
        );
        let name = parse_session_name(&text, &text, false);
        assert_eq!(name.title.as_deref(), Some("Survivor"));
        assert_eq!(name.last_prompt, None);
    }

    #[test]
    fn a_lone_carriage_return_ends_a_line_like_a_newline() {
        assert_eq!(split_lines("a\r\nb\rc\n"), ["a", "b", "c"]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
        assert_eq!(split_lines("\n"), [""]);
    }
}
