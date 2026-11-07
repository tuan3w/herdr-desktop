//! Syntax highlighting for the one code renderer (`CodeView`, `components/code-block.tsx`).
//!
//! Two engines end in the same [`Span`]s of [`Role`]s: tree-sitter with hand-tuned queries for the
//! languages in [`Lang`], and a TextMate fallback (syntect, the grammars nsh already ships) for the long
//! tail. A [`Session`] re-highlights a block that grows or is edited: it reuses the last parse, paints
//! only the part that changed and keeps the spans before it, so what is already coloured never flickers.

pub mod diff;
mod lang;
pub mod lines;
mod post;
mod role;
pub mod samples;
mod session;
mod tm;
mod ts;

pub use lang::{Lang, fence_word};
pub use role::{Role, Span};
pub use session::{Highlighter, Syntax, Update};
pub use ts::{Grammar, grammar, loaded};

/// The spans of `text` as `lang` reads it: one full parse. Meant for a background thread: the first
/// block of a language also compiles its query.
pub fn highlight(lang: Lang, text: &str) -> Vec<Span> {
    highlight_syntax(&Syntax::Tree(lang), text)
}

/// The spans of `text` read as `syntax`: one full pass.
pub fn highlight_syntax(syntax: &Syntax, text: &str) -> Vec<Span> {
    let mut h = Highlighter::new(syntax);
    h.update(text);
    h.spans().to_vec()
}

#[cfg(test)]
mod tests;
