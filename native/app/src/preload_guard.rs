//! Starts the process again without an `LD_PRELOAD` allocator that mishandles C23 `free_sized`.
//!
//! GTK 4.22 on glibc 2.43 releases memory with `free_sized(ptr, size)`, and `ptr` is `NULL` for some objects (a
//! `GtkActionMuxer` that is finalized, which every widget with actions owns). C23 defines that as a no-op. A preloaded
//! jemalloc 5.3.1 queues the `NULL` in its thread cache instead, so a later `malloc` returns `NULL`: Rust's allocator
//! aborts with `memory allocation of 5 bytes failed`, or the cache flush faults inside GTK (`SIGSEGV`). Whenever the
//! widget tree of a window changes (a chat tab replaced by the terminal mirror, a tab closed) the person's whole app
//! dies without a message; see `docs/upstream/nsh-selectable-textview-in-list.md` for the stacks.
//!
//! The code that frees is not ours and the preload is the person's choice (here `export LD_PRELOAD=libjemalloc.so.2` in
//! a shell profile reaches every program started from that shell). A process cannot unload what the loader mapped, so
//! the guard runs before `main` (a constructor), finds the preload entries that define `free_sized`, and executes the
//! same binary again with those entries removed from `LD_PRELOAD`. It says so on stderr, and
//! `HERDR_DESKTOP_KEEP_PRELOAD=1` keeps the preload (to reproduce the failure).

use std::ffi::{CStr, c_char, c_int, c_void};

const RTLD_LAZY: c_int = 1;
const RTLD_NOLOAD: c_int = 4;

unsafe extern "C" {
    fn dlopen(file: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
}

/// What the preload list becomes: the entries to keep and the ones that define `free_sized` (to drop).
#[derive(Debug, PartialEq, Eq)]
struct Split {
    keep: Vec<String>,
    drop: Vec<String>,
}

/// Splits `LD_PRELOAD` (entries separated by spaces or colons) by `defines`, which says whether an entry defines
/// `free_sized`.
fn split(preload: &str, defines: impl Fn(&str) -> bool) -> Split {
    let mut out = Split {
        keep: Vec::new(),
        drop: Vec::new(),
    };
    for entry in preload.split([' ', ':']).filter(|e| !e.is_empty()) {
        if defines(entry) {
            out.drop.push(entry.to_owned());
        } else {
            out.keep.push(entry.to_owned());
        }
    }
    out
}

/// Whether the library the loader already mapped for `entry` exports `free_sized`.
fn defines_free_sized(entry: &str) -> bool {
    let Ok(path) = std::ffi::CString::new(entry) else {
        return false;
    };
    // SAFETY: `RTLD_NOLOAD` only looks up a library that is already mapped (it loads nothing and runs no code); the
    // handle is released again at once.
    unsafe {
        let handle = dlopen(path.as_ptr(), RTLD_LAZY | RTLD_NOLOAD);
        if handle.is_null() {
            return false;
        }
        let name: &CStr = c"free_sized";
        let found = !dlsym(handle, name.as_ptr()).is_null();
        dlclose(handle);
        found
    }
}

/// The arguments this process was started with (`argv`, from the kernel: the Rust runtime has not read them yet when a
/// constructor runs).
fn arguments() -> Option<Vec<std::ffi::OsString>> {
    use std::os::unix::ffi::OsStringExt;
    let raw = std::fs::read("/proc/self/cmdline").ok()?;
    let mut args: Vec<std::ffi::OsString> = raw
        .split(|b| *b == 0)
        .map(|a| std::ffi::OsString::from_vec(a.to_vec()))
        .collect();
    // The command line ends with a terminating NUL: one empty piece too many.
    if args.last().is_some_and(|a| a.is_empty()) {
        args.pop();
    }
    (!args.is_empty()).then_some(args)
}

fn guard() {
    use std::os::unix::process::CommandExt;
    if std::env::var_os("HERDR_DESKTOP_KEEP_PRELOAD").is_some() {
        return;
    }
    let Some(preload) = std::env::var("LD_PRELOAD").ok().filter(|p| !p.is_empty()) else {
        return;
    };
    let parts = split(&preload, defines_free_sized);
    if parts.drop.is_empty() {
        return;
    }
    let Some(args) = arguments() else { return };
    eprintln!(
        "herdr-desktop: {} replaces free_sized, which GTK 4.22 calls with NULL (jemalloc 5.3.1 then hands out NULL from malloc); \
         starting again without it (HERDR_DESKTOP_KEEP_PRELOAD=1 keeps it)",
        parts.drop.join(", ")
    );
    let mut command = std::process::Command::new("/proc/self/exe");
    command.arg0(&args[0]).args(&args[1..]);
    if parts.keep.is_empty() {
        command.env_remove("LD_PRELOAD");
    } else {
        command.env("LD_PRELOAD", parts.keep.join(":"));
    }
    // `exec` returns only when it failed: the process goes on as it is, as it did before the guard existed.
    let error = command.exec();
    eprintln!("herdr-desktop: could not start again without the preload: {error}");
}

extern "C" fn run() {
    guard();
}

/// The loader calls this before `main` (`.init_array`). `native` (in `lib.rs`) names it so that the linker keeps the object.
#[used]
#[unsafe(link_section = ".init_array")]
pub static INIT: extern "C" fn() = run;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_entries_that_define_free_sized_go() {
        let parts = split(
            "/usr/local/lib/libjemalloc.so.2:/opt/other.so /opt/third.so",
            |e| e.contains("jemalloc"),
        );
        assert_eq!(parts.drop, ["/usr/local/lib/libjemalloc.so.2"]);
        assert_eq!(parts.keep, ["/opt/other.so", "/opt/third.so"]);
    }

    #[test]
    fn a_list_without_such_an_entry_is_left_alone() {
        let parts = split("/opt/a.so::/opt/b.so", |_| false);
        assert!(parts.drop.is_empty());
        assert_eq!(parts.keep, ["/opt/a.so", "/opt/b.so"]);
    }

    #[test]
    fn a_library_that_is_not_mapped_defines_nothing() {
        assert!(!defines_free_sized("/nonexistent/libnothing.so"));
    }

    /// Where a jemalloc that a person might preload lives on the usual distributions.
    const JEMALLOC: [&str; 3] = [
        "/usr/local/lib/libjemalloc.so.2",
        "/usr/lib/x86_64-linux-gnu/libjemalloc.so.2",
        "/usr/lib64/libjemalloc.so.2",
    ];

    /// The body of the child process of `a_preloaded_free_sized_never_hands_out_null`: what the guard left of
    /// `LD_PRELOAD`, then C23 `free_sized(NULL, 0)` called as GTK calls it, then five small allocations.
    #[test]
    fn child_probe() {
        if std::env::var_os("HERDR_DESKTOP_GUARD_CHILD").is_none() {
            return;
        }
        unsafe extern "C" {
            fn malloc(size: usize) -> *mut c_void;
        }
        let name: &CStr = c"free_sized";
        // SAFETY: `free_sized(NULL, 0)` is a no-op by C23; the lookup finds the one in effect (libc's, or a preload's).
        let nulls = unsafe {
            let found = dlsym(std::ptr::null_mut(), name.as_ptr());
            if found.is_null() {
                println!("PROBE skipped");
                return;
            }
            let free_sized: extern "C" fn(*mut c_void, usize) = std::mem::transmute(found);
            for _ in 0..3 {
                free_sized(std::ptr::null_mut(), 0);
            }
            (0..5).filter(|_| malloc(5).is_null()).count()
        };
        println!(
            "PROBE preload={:?} nulls={nulls}",
            std::env::var("LD_PRELOAD").unwrap_or_default()
        );
    }

    /// Starts this test binary with a preloaded jemalloc (when the machine has one) and reads what the child saw: when
    /// that jemalloc defines `free_sized` the guard must have removed it, and `malloc` never returns `NULL`.
    #[test]
    fn a_preloaded_free_sized_never_hands_out_null() {
        let Some(lib) = JEMALLOC.iter().find(|p| std::path::Path::new(p).exists()) else {
            return;
        };
        let defines =
            std::fs::read(lib).is_ok_and(|bytes| bytes.windows(10).any(|w| w == b"free_sized"));
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "preload_guard::tests::child_probe",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("LD_PRELOAD", lib)
            .env("HERDR_DESKTOP_GUARD_CHILD", "1")
            .env_remove("HERDR_DESKTOP_KEEP_PRELOAD")
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.status.success(),
            "the child failed ({}): {text}{}",
            out.status,
            String::from_utf8_lossy(&out.stderr)
        );
        let probe = text
            .lines()
            .find(|l| l.contains("PROBE"))
            .unwrap_or_else(|| panic!("no probe line: {text}"));
        assert!(
            probe.contains("nulls=0") || probe.contains("skipped"),
            "{probe}"
        );
        if defines {
            assert!(
                probe.contains("preload=\"\""),
                "the guard kept {lib}: {probe}"
            );
        }
    }
}
