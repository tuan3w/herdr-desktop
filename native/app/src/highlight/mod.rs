//! Syntax highlighting for the one code renderer (`CodeView`, `CodeDiff`, `components/code-block.tsx`).
//!
//! * [`engine`] reads text into spans of roles (tree-sitter queries of ours, a TextMate fallback), keeps the last
//!   parse of a block that grows, and builds the lines and diff rows a view draws. It has no widget in it, so it is
//!   tested, benchmarked and measured without a window.
//! * [`view`] draws them natively (`CodeView`, `CodeDiff`); [`api`] is the `Code` module TSX asks about a block.

pub mod api;
mod engine;
pub mod view;

pub use engine::*;
