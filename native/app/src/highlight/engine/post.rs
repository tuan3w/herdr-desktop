//! What a grammar leaves to us, found from the text of a captured node: a comment that documents
//! (`///`, `/** */`), the `TODO` inside a comment, and the escapes inside a string. They are computed
//! per captured node, so painting one byte range gives the same answer as painting the whole text.

use super::lang::Lang;
use super::role::Role;

/// A range inside one node (offsets from the node's start) and what it is.
pub type Inner = (usize, usize, Role);

/// Whether a comment documents: `///` and `//!`, `/**` and `/*!`, and Lua's `---`.
pub fn is_doc(lang: Lang, comment: &str) -> bool {
    let c = comment.as_bytes();
    let starts = |p: &str| comment.starts_with(p);
    if starts("///") {
        return !starts("////");
    }
    if starts("//!") || starts("/*!") {
        return true;
    }
    if starts("/**") {
        return !starts("/**/") && !starts("/***");
    }
    lang == Lang::Lua && starts("---") && !starts("----") && c.len() > 3
}

const MARKERS: [&str; 8] = [
    "TODO", "FIXME", "XXX", "HACK", "NOTE", "BUG", "SAFETY", "WARN",
];

/// The `TODO` markers of a comment: the word, its `(owner)` and a `:` after it, when it stands as a
/// word of its own in capitals.
pub fn todos(comment: &str, out: &mut Vec<Inner>) {
    let bytes = comment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_uppercase()
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_')
        {
            for marker in MARKERS {
                if comment[i..].starts_with(marker) {
                    let mut end = i + marker.len();
                    if bytes
                        .get(end)
                        .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
                    {
                        continue;
                    }
                    if bytes.get(end) == Some(&b'(')
                        && let Some(close) = comment[end..]
                            .find(')')
                            .filter(|c| *c < 40 && !comment[end..end + c].contains('\n'))
                    {
                        end += close + 1;
                    }
                    if bytes.get(end) == Some(&b':') {
                        end += 1;
                    }
                    out.push((i, end, Role::Todo));
                    i = end - 1;
                    break;
                }
            }
        }
        i += 1;
    }
}

/// Whether a language's string literals have backslash escapes at all.
fn has_escapes(lang: Lang) -> bool {
    !matches!(
        lang,
        Lang::Sql | Lang::Css | Lang::Html | Lang::Markdown | Lang::Diff | Lang::Dockerfile
    )
}

/// Whether the literal that opens with `opener` takes backslash escapes: not a raw string (`r"`,
/// `r#"`, `R"(`, a Go backtick, Swift's `#"`) and not a quoted string of a language whose single
/// quotes are literal (shell, Ruby, PHP, TOML, YAML).
fn escapes_in(lang: Lang, opener: &str) -> bool {
    let b = opener.as_bytes();
    let Some(q) = b.iter().position(|c| matches!(c, b'"' | b'\'' | b'`')) else {
        return false;
    };
    let prefix = &opener[..q];
    let raw_prefix = prefix.contains(['r', 'R']) && !matches!(lang, Lang::Ruby | Lang::Php);
    if raw_prefix || prefix.contains('#') {
        return false;
    }
    match b[q] {
        b'`' => lang != Lang::Go && !matches!(lang, Lang::Bash | Lang::Markdown),
        b'\'' => !matches!(
            lang,
            Lang::Bash | Lang::Ruby | Lang::Php | Lang::Toml | Lang::Yaml
        ),
        _ => true,
    }
}

/// The escapes of a string literal (or of the content between its quotes). `opener` is the text the
/// literal starts with: the node's own start, else its parent's.
pub fn escapes(lang: Lang, opener: &str, text: &str, out: &mut Vec<Inner>) {
    if !has_escapes(lang) || !escapes_in(lang, opener) {
        return;
    }
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        let Some(&c) = b.get(i) else { break };
        let hex = |from: usize, n: usize| {
            (from..from + n)
                .take_while(|j| b.get(*j).is_some_and(u8::is_ascii_hexdigit))
                .count()
        };
        i += match c {
            b'x' => 1 + hex(i + 1, 2),
            b'u' if b.get(i + 1) == Some(&b'{') => text[i..].find('}').map_or(1, |e| e + 1),
            b'u' => 1 + hex(i + 1, 4),
            b'U' => 1 + hex(i + 1, 8),
            b'N' if b.get(i + 1) == Some(&b'{') => text[i..].find('}').map_or(1, |e| e + 1),
            b'0'..=b'7' => (0..3)
                .take_while(|j| b.get(i + j).is_some_and(|d| (b'0'..=b'7').contains(d)))
                .count(),
            _ => text[i..].chars().next().map_or(1, char::len_utf8),
        };
        out.push((start, i.min(b.len()), Role::Escape));
    }
}

/// The first byte of a node's text is a quote or a literal prefix: it is the opener itself.
pub fn opens_string(text: &str) -> bool {
    let b = text.as_bytes();
    b.iter()
        .take(4)
        .position(|c| matches!(c, b'"' | b'\'' | b'`'))
        .is_some_and(|q| b[..q].iter().all(|c| c.is_ascii_alphabetic() || *c == b'#'))
}
