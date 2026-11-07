//! The embedded terminal (prototype, off by default): see `docs/specs/terminal.md`.

#[cfg(all(unix, feature = "terminal"))]
mod emulator;
pub mod frame;
pub mod keys;
#[cfg(all(unix, feature = "terminal"))]
pub mod pty;
pub mod session;
pub mod types;
mod view;

pub use view::Terminal;

#[cfg(all(test, unix, feature = "terminal"))]
mod tests;
