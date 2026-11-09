//! Turns off WebKitGTK's DMA-BUF renderer before anything starts, unless the person chose for themselves.
//!
//! WebKitGTK (2.42 and later) draws a web view through GBM buffers, and when the GPU cannot give it an EGL display
//! (no render node, a driver without GBM, a desktop where GTK itself says "Unable to create a GL context") it prints
//! `Could not create GBM EGL display: EGL_NOT_INITIALIZED. Aborting...` and aborts the whole process. The person pressed a
//! link and the app vanished (owner, 2026-11-09, an X11 desktop). Reproduced here by hiding `/dev/dri` (bwrap) and opening
//! a page: the host died. With `WEBKIT_DISABLE_DMABUF_RENDERER=1` WebKit draws into shared memory instead, which every
//! machine has; a page is a panel the person reads, not a game, so the copy costs nothing they would notice. A value the
//! person set (even `0`) is left as it is.

const KEY: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

extern "C" fn run() {
    if std::env::var_os(KEY).is_none() {
        // SAFETY: a constructor runs before `main`, while the process has one thread, so nothing reads the environment
        // concurrently.
        unsafe { std::env::set_var(KEY, "1") };
    }
}

/// The loader calls this before `main` (`.init_array`). `native` (in `lib.rs`) names it so that the linker keeps the object.
#[used]
#[unsafe(link_section = ".init_array")]
pub static INIT: extern "C" fn() = run;
