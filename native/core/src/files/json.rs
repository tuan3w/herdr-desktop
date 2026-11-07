//! Laying out JSON for reading: a minified document becomes indented lines, without touching a single value.
//!
//! The text is checked as JSON first (`serde_json`, which only validates here), then re-indented token by token, so a
//! number is the digits the file has (`12345678901234567890` stays whole, `1e3` stays `1e3`) and a string is its escaped
//! form exactly. Parsing and printing through a value type would round big integers and reorder nothing: this does
//! neither.

/// The most nesting that is laid out; deeper is almost surely not a document a person reads.
const DEPTH_MAX: usize = 256;

/// `text` indented by two spaces per level, one value per line, or `None` when it is not valid JSON (or is nested
/// absurdly deep). Empty `{}` and `[]` stay on one line.
pub fn pretty(text: &str) -> Option<String> {
    if serde_json::from_str::<serde::de::IgnoredAny>(text).is_err() {
        return None;
    }
    let mut out = String::with_capacity(text.len() + text.len() / 4);
    let mut depth = 0usize;
    let mut chars = text.chars().peekable();
    let newline = |out: &mut String, depth: usize| {
        out.push('\n');
        for _ in 0..depth {
            out.push_str("  ");
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                out.push('"');
                while let Some(s) = chars.next() {
                    out.push(s);
                    if s == '\\' {
                        if let Some(next) = chars.next() {
                            out.push(next);
                        }
                    } else if s == '"' {
                        break;
                    }
                }
            }
            '{' | '[' => {
                out.push(c);
                // Skip whitespace to see whether it closes at once.
                while chars.peek().is_some_and(|w| w.is_whitespace()) {
                    chars.next();
                }
                if matches!(chars.peek(), Some('}' | ']')) {
                    out.push(chars.next()?);
                } else {
                    depth += 1;
                    if depth > DEPTH_MAX {
                        return None;
                    }
                    newline(&mut out, depth);
                }
            }
            '}' | ']' => {
                depth = depth.saturating_sub(1);
                newline(&mut out, depth);
                out.push(c);
            }
            ',' => {
                out.push(',');
                newline(&mut out, depth);
            }
            ':' => out.push_str(": "),
            w if w.is_whitespace() => {}
            other => out.push(other),
        }
    }
    Some(out)
}

/// Whether `text` is one long line that [`pretty`] would improve: more than 200 characters on one line.
pub fn is_minified(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.len() > 200 && !trimmed.contains('\n')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minified_document_is_indented_and_values_are_untouched() {
        let src = r#"{"id":12345678901234567890,"n":1e3,"s":"a \"b\", c: d","list":[1,2,{"x":null}],"empty":{},"e2":[ ]}"#;
        let pretty = pretty(src).unwrap();
        assert_eq!(
            pretty,
            "{\n  \"id\": 12345678901234567890,\n  \"n\": 1e3,\n  \"s\": \"a \\\"b\\\", c: d\",\n  \"list\": [\n    1,\n    2,\n    {\n      \"x\": null\n    }\n  ],\n  \"empty\": {},\n  \"e2\": []\n}"
        );
        // The same data once laid out: nothing but whitespace changed.
        let strip = |s: &str| {
            let mut in_str = false;
            let mut esc = false;
            s.chars()
                .filter(|&c| {
                    if in_str {
                        if esc {
                            esc = false;
                        } else if c == '\\' {
                            esc = true;
                        } else if c == '"' {
                            in_str = false;
                        }
                        return true;
                    }
                    if c == '"' {
                        in_str = true;
                    }
                    !c.is_whitespace()
                })
                .collect::<String>()
        };
        assert_eq!(strip(&pretty), strip(src));
    }

    #[test]
    fn invalid_json_is_none_and_never_half_formatted() {
        assert_eq!(pretty("{\"a\":}"), None);
        assert_eq!(pretty("plain words"), None);
        assert_eq!(pretty(""), None);
    }

    #[test]
    fn a_scalar_and_nesting_past_the_limit() {
        assert_eq!(pretty("42").unwrap(), "42");
        let deep = format!("{}{}", "[".repeat(300), "]".repeat(300));
        assert_eq!(pretty(&deep), None);
    }

    #[test]
    fn one_long_line_is_minified_a_short_one_or_many_lines_is_not() {
        assert!(is_minified(&format!("[{}1]", "1,".repeat(150))));
        assert!(!is_minified("{\"a\":1}"));
        assert!(!is_minified(&format!(
            "{}\n{}",
            "x".repeat(150),
            "y".repeat(150)
        )));
    }
}
