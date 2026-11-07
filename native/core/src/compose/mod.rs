//! The chat's message box, the parts that are not a screen: pictures made ready to send (`image`) and the files a
//! picture is saved to when the agent cannot see it (`save_to_project`).
//!
//! What goes out with a message (links, embedded text, picture blocks) is `session::outgoing`; this module makes the
//! pictures that it reads.

mod image;
mod project;

pub use image::{
    Fit, LONG_EDGE, MAX_BYTES, MAX_PICTURES, MAX_SOURCE, PREVIEW_MAX, Picture, PictureError, THUMB,
    prepare, sniff, thumbnail_of,
};
pub use project::{ATTACHMENTS_DIR, purge, save_to_project};
