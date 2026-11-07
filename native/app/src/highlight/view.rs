//! `CodeView` and `CodeDiff`: the one renderer of code in the chat (markdown fences, tool output, diffs,
//! a file later), drawn natively from the highlighter's spans.
//!
//! Why not `TextView` or `DiffView` (nsh's): their colours are a fixed palette of eight kinds of token
//! (`nsh-base/src/syntax.rs`), they cannot be given ours, and a code block there has no gutter, marks,
//! folds, copy or fade. Why not `Text` spans from TSX: a 3,000-line block would be 3,000 mounted rows
//! and every streamed chunk would cross the JS boundary. Here the spans never leave Rust, a long block
//! is a virtual list, and the colours are theme tokens (`code-*`, `lib/theme/code.ts`), so a theme or
//! appearance change restyles without highlighting again.
//!
//! Highlighting runs off the engine thread unless it is cheap (the grammar is loaded and the text is
//! small); until a result arrives the text shows with the spans of what it grew from, so a streamed
//! block never flashes plain.

mod model;
mod palette;
mod render;

pub use self::model::{
    CodeDiff, CodeDiffApi, CodeDiffEvent, CodeDiffProps, CodeView, CodeViewProps,
};
