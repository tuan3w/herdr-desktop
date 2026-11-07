//! The `Code` module: what TSX needs to know about a block before it draws it.

use nsh_core::prelude::*;

use super::{Lang, Syntax, samples};

/// What a block of code is, found without highlighting it.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct CodeInfo {
    /// The language as a label (`TypeScript`), empty when the text is plain.
    pub language: String,
    /// How many lines the text has.
    pub lines: u32,
}

/// A synthetic block for labs and screenshots.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct CodeSample {
    /// The fence word.
    pub fence: String,
    /// A file name the language also follows from.
    pub path: String,
    /// The text.
    pub text: String,
}

/// Facts about code blocks.
#[module]
pub struct Code;

#[module]
impl Code {
    /// The label of the language a fence word, a file name or the text's first lines name, and the
    /// line count. A language the long-tail grammars know is labelled by its grammar's name; plain
    /// text and unknown words have an empty language. Loads the grammar set on the first word that
    /// needs it, so call it once per block, not per frame.
    pub fn describe(code: String, language: Option<String>, path: Option<String>) -> CodeInfo {
        let syntax = match Lang::detect(language.as_deref(), path.as_deref(), &code) {
            Some(lang) => Syntax::Tree(lang),
            None => Syntax::resolve(language.as_deref(), path.as_deref(), &code),
        };
        let lines = code.split_inclusive('\n').count() as u32;
        CodeInfo {
            language: syntax.label().unwrap_or_default(),
            lines,
        }
    }

    /// Compiles the grammars of the languages chat code is mostly in, and loads the long-tail grammar
    /// set, on a background thread: the first block of a language otherwise pays 15 to 260 ms for it
    /// (`docs/specs/chat-craft.md`, "Measured"). Returns at once; call it once when the first chat opens.
    pub fn warm() {
        let _ = std::thread::Builder::new()
            .name("herdr-highlight-warm".into())
            .spawn(|| {
                use Lang::*;
                for lang in [
                    TypeScript, Tsx, Rust, Python, Bash, Json, Markdown, Diff, Go, Css, Html, Yaml,
                    Sql,
                ] {
                    let _ = super::grammar(lang);
                }
                let _ = super::Syntax::resolve(Some("dockerfile"), None, "");
            });
    }

    /// Synthetic code in every language the highlighter reads: for labs and screenshots, never real code.
    pub fn samples() -> Vec<CodeSample> {
        samples::ALL
            .iter()
            .map(|(fence, path, text)| CodeSample {
                fence: (*fence).into(),
                path: (*path).into(),
                text: (*text).into(),
            })
            .collect()
    }
}
