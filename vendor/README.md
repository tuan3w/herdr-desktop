# vendor

## nsh-platform-linux

nsh 0.4.0's GTK backend never lets an nsh-drawn view take the keyboard focus (every `NshView` is `set_focusable(false)` and the `focusable` prop is not read), so on Linux Tab reaches only the text fields: not tabs, buttons, answer chips or rows. macOS does not have the problem. nsh main fixed it in `crates/nsh-platform-linux/src/key_focus.rs` (commit 9315b278, "core: Open context menus from the keyboard and screen readers"), but no release carries it: the newest is 0.4.0, and main cannot be used for this app (its window API changed, and its Linux host needs gstreamer to build).

This directory is the crates.io 0.4.0 crate with that one fix backported:

- `src/key_focus.rs` is new: the file of commit 9315b278 without the Shift+F10 and Menu-key context menu, which needs a newer core.
- `src/view.rs`: `NshView::focus` offers the view to GTK's Tab walk; the comment on `set_focusable(false)` says why.
- `src/mount.rs`: `focus()` and `blur()` on a view that is not an input.
- `src/surface.rs`: installs it. `src/lib.rs`: the module. `src/input.rs`: `modifiers` is `pub(crate)`.

`.cargo/config.toml` points `[patch.crates-io]` at it, so every Linux host built for the app (`nsh test --target linux`, `nsh run`, `nsh package`) carries the fix. macOS builds ignore it.

Remove this directory and the patch when nsh publishes a release that has `key_focus.rs`, and move the pin to that release.
