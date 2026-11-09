//! Keeps GTK 4.22 from emptying a theme that is made of a resource, before anything starts.
//!
//! Yaru (Ubuntu's default) ships `gtk-4.0/gtk.css` as one line, an `@import` of a resource in the `gtk.gresource` beside
//! it. GTK registers that resource, parses the file, and drops the registration when the provider is reset. nsh sets
//! `gtk-interface-color-scheme` right after start (`nsh_platform_linux::system::environment_applied`); the provider
//! follows that setting, re-renders, resets itself (so unregisters the resource) and parses its cached `@import` again:
//! `Theme parser error: gtk.css:1:1-63: Failed to import … Yaru/4.0/gtk.css does not exist`. The theme is then empty, and
//! the window frame GTK draws is bare: the title bar has no background, its title and buttons are the default white, and
//! the menu row is white on white (owner, 2026-11-09, GNOME on Wayland). Reproduced without herdr: any GTK 4.22.4 program
//! that sets `gtk-interface-color-scheme` to light or dark after the theme loaded prints the same error. With the same
//! theme named in `GTK_THEME` (`GTK_THEME=Yaru`) GTK loads it once, from the environment, and the error does not occur;
//! the frame keeps the person's theme (a plain GTK window on X11 then shows Yaru's round window buttons).
//!
//! So when the person did not choose `GTK_THEME` and their theme is of that kind, this sets `GTK_THEME` to its name. The
//! content is drawn by nsh and does not use the theme. A `GTK_THEME` the person set (any value) is left as it is.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const KEY: &str = "GTK_THEME";
/// `gsettings` talks to dconf over the session bus; a broken bus must not hold the start up.
const ASK_LIMIT: Duration = Duration::from_millis(400);

/// The theme directories in the order GTK looks in them: the user's data, `~/.themes`, then `XDG_DATA_DIRS`.
fn theme_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home.as_ref().map(|h| h.join(".local/share")));
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    let mut dirs: Vec<PathBuf> = data_home.iter().map(|d| d.join("themes")).collect();
    dirs.extend(home.iter().map(|h| h.join(".themes")));
    dirs.extend(
        data_dirs
            .split(':')
            .filter(|d| !d.is_empty())
            .map(|d| Path::new(d).join("themes")),
    );
    dirs
}

/// Whether the theme `name`, found where GTK finds it, loads its CSS from a resource: a `gtk-4.*` folder with both
/// `gtk.css` and `gtk.gresource`.
fn is_resource_theme(name: &str, dirs: &[PathBuf]) -> bool {
    // A name with a separator would walk out of the theme folders.
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return false;
    }
    let Some(theme) = dirs.iter().map(|d| d.join(name)).find(|p| p.is_dir()) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(theme) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_name().to_string_lossy().starts_with("gtk-4.")
            && e.path().join("gtk.css").is_file()
            && e.path().join("gtk.gresource").is_file()
    })
}

/// `'Yaru'` as `gsettings get` prints it, without the quotes.
fn parse_gsettings_string(out: &str) -> Option<&str> {
    let name = out.trim().strip_prefix('\'')?.strip_suffix('\'')?;
    (!name.is_empty()).then_some(name)
}

/// The theme GNOME says is current, or `None` where `gsettings` is missing, slow or has no such key.
fn current_theme() -> Option<String> {
    let mut child = Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if start.elapsed() > ASK_LIMIT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
    let mut out = String::new();
    std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
    parse_gsettings_string(&out).map(str::to_owned)
}

extern "C" fn run() {
    if std::env::var_os(KEY).is_some() {
        return;
    }
    let Some(name) = current_theme() else {
        return;
    };
    if is_resource_theme(&name, &theme_dirs()) {
        // SAFETY: a constructor runs before `main`, while the process has one thread (the child above is another
        // process), so nothing reads the environment concurrently.
        unsafe { std::env::set_var(KEY, name) };
    }
}

/// The loader calls this before `main` (`.init_array`). `native` (in `lib.rs`) names it so that the linker keeps the object.
#[used]
#[unsafe(link_section = ".init_array")]
pub static INIT: extern "C" fn() = run;

#[cfg(test)]
mod tests {
    use super::*;

    fn theme(root: &Path, name: &str, version: &str, files: &[&str]) {
        let dir = root.join(name).join(version);
        std::fs::create_dir_all(&dir).unwrap();
        for f in files {
            std::fs::write(dir.join(f), "").unwrap();
        }
    }

    #[test]
    fn a_theme_that_imports_its_resource_is_found() {
        let root = tempfile::tempdir().unwrap();
        theme(
            root.path(),
            "Yaru",
            "gtk-4.0",
            &["gtk.css", "gtk.gresource"],
        );
        assert!(is_resource_theme("Yaru", &[root.path().into()]));
    }

    #[test]
    fn a_theme_of_plain_css_is_left_alone() {
        let root = tempfile::tempdir().unwrap();
        theme(
            root.path(),
            "Plain",
            "gtk-4.0",
            &["gtk.css", "gtk-dark.css"],
        );
        assert!(!is_resource_theme("Plain", &[root.path().into()]));
    }

    #[test]
    fn a_gtk3_resource_does_not_count() {
        let root = tempfile::tempdir().unwrap();
        theme(root.path(), "Old", "gtk-3.0", &["gtk.css", "gtk.gresource"]);
        assert!(!is_resource_theme("Old", &[root.path().into()]));
    }

    #[test]
    fn the_first_folder_that_has_the_theme_decides() {
        let user = tempfile::tempdir().unwrap();
        let system = tempfile::tempdir().unwrap();
        theme(user.path(), "Yaru", "gtk-4.0", &["gtk.css"]);
        theme(
            system.path(),
            "Yaru",
            "gtk-4.0",
            &["gtk.css", "gtk.gresource"],
        );
        let dirs = [user.path().into(), system.path().into()];
        assert!(!is_resource_theme("Yaru", &dirs));
    }

    #[test]
    fn a_name_cannot_leave_the_theme_folders() {
        let root = tempfile::tempdir().unwrap();
        theme(
            root.path(),
            "Yaru",
            "gtk-4.0",
            &["gtk.css", "gtk.gresource"],
        );
        let inner = root.path().join("themes");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(!is_resource_theme("../Yaru", &[inner]));
    }

    #[test]
    fn gsettings_output_is_read_without_its_quotes() {
        assert_eq!(parse_gsettings_string("'Yaru'\n"), Some("Yaru"));
        assert_eq!(parse_gsettings_string("''\n"), None);
        assert_eq!(parse_gsettings_string("No such schema"), None);
    }
}
