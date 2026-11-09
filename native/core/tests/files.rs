//! Files: this computer's and a remote machine's, the viewer, `Send a file`, and the page tunnel.
//!
//! The remote side is the real `fs.py` on a local python3, reached through a stand-in `ssh` that runs the
//! generated remote command with `sh -c` (so the real quoting and base64 wrapper are what execute). Every
//! behaviour that both machines must share is checked against both.

use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use herdr_core::files::{
    EntryKind, FileError, FileErrorKind, Files, IMAGE_CAP, LocalFiles, PICTURE_DATA_CAP,
    RemoteFiles, TEXT_CAP, Tunnel, UploadError, ViewKind, candidates, find_path, join,
    localhost_port, open, parent, path_from_uri, upload, uri_from_path, validate_path,
};
use herdr_core::files::{
    FetchError, LineIndex, MEDIA_CHUNK, MediaCache, fetch, find_line, list_archive, peek,
    picture_data_url, probe_codecs, read_lines, scan_lines,
};
use herdr_core::ssh::{SshClient, SshTarget};

/// A stand-in `ssh` that runs the remote command locally. `-O` requests are logged and succeed.
struct Rig {
    dir: tempfile::TempDir,
    home: PathBuf,
}

impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let log = dir.path().join("control.log");
        let script = format!(
            r#"#!/bin/sh
for a; do
  [ "$a" = "--" ] && break
  if [ "$a" = "-O" ]; then echo "$*" >> "{log}"; exit 0; fi
done
while [ "$1" != "--" ]; do shift; done
shift
shift
HOME="{home}" exec sh -c "exec $1"
"#,
            log = log.display(),
            home = home.display()
        );
        let path = dir.path().join("ssh");
        std::fs::write(&path, script).unwrap();
        Self { dir, home }
    }

    fn client(&self) -> SshClient {
        SshClient::with_control_dir(self.dir.path().join("control"))
            .program("/bin/sh")
            .program_arg(self.dir.path().join("ssh"))
    }

    fn target() -> SshTarget {
        SshTarget::new("box", None, None, None).unwrap()
    }

    fn remote(&self) -> RemoteFiles {
        RemoteFiles::new(self.client(), Self::target())
    }

    fn control_log(&self) -> String {
        std::fs::read_to_string(self.dir.path().join("control.log")).unwrap_or_default()
    }
}

fn s(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

/// Runs `check` once against this computer's files and once against a remote machine's.
fn on_both(check: impl Fn(&dyn Files, &Path)) {
    let work = tempfile::tempdir().unwrap();
    check(&LocalFiles::new(), work.path());
    let work = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    check(&rig.remote(), work.path());
}

fn kind(e: &FileError) -> FileErrorKind {
    e.kind
}

// ---- paths ------------------------------------------------------------------------------------

#[test]
fn only_absolute_bounded_paths_without_nul_are_passed_on() {
    for ok in [
        "/",
        "/home/me/a b",
        "~",
        "~/x",
        "/x;rm -rf ~",
        "/new\nline",
        "/'quote'",
    ] {
        assert!(validate_path(ok).is_ok(), "{ok:?}");
    }
    for bad in [
        "",
        "relative/path",
        "./x",
        "../x",
        "~other/x",
        "-rf",
        "/a\0b",
        &format!("/{}", "x".repeat(4096)),
    ] {
        assert!(validate_path(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn a_listed_name_can_never_climb_out_of_its_folder() {
    assert_eq!(join("/a/b/", "c").unwrap(), "/a/b/c");
    assert_eq!(join("/", "c").unwrap(), "/c");
    for bad in ["", ".", "..", "x/y", "../x", "a\0"] {
        assert!(join("/a", bad).is_err(), "{bad:?}");
    }
}

// ---- listing, reading -----------------------------------------------------------------------

#[test]
fn a_folder_lists_folders_first_then_names_without_regard_to_case() {
    on_both(|files, work| {
        std::fs::create_dir(work.join("zeta")).unwrap();
        std::fs::create_dir(work.join(".hidden")).unwrap();
        std::fs::write(work.join("Banana.txt"), "12345").unwrap();
        std::fs::write(work.join("apple.txt"), "").unwrap();
        symlink(work.join("zeta"), work.join("to-zeta")).unwrap();
        symlink(work.join("nowhere"), work.join("broken")).unwrap();
        let listing = files.list(&s(work)).unwrap();
        let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            [
                ".hidden",
                "to-zeta",
                "zeta",
                "apple.txt",
                "Banana.txt",
                "broken"
            ],
            "folders (a link to one too) first, then files, a dead link among them"
        );
        let by = |name: &str| listing.entries.iter().find(|e| e.name == name).unwrap();
        assert_eq!(by("Banana.txt").size, 5);
        assert_eq!(by("Banana.txt").kind, EntryKind::File);
        assert!(by("to-zeta").link && by("to-zeta").kind == EntryKind::Dir);
        assert_eq!(by("broken").kind, EntryKind::Other);
        assert!(!by("broken").readable);
        assert!(by("zeta").modified.is_some());
        assert!(!listing.truncated);
    });
}

#[test]
fn an_entry_nobody_may_read_is_listed_and_says_so() {
    on_both(|files, work| {
        let locked = work.join("locked.txt");
        std::fs::write(&locked, "secret").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let listing = files.list(&s(work)).unwrap();
        let entry = &listing.entries[0];
        // Root reads anything: the claim only holds for the ordinary user the app runs as.
        if rustix::process::getuid().as_raw() != 0 {
            assert!(!entry.readable);
            assert_eq!(
                kind(&files.read(&s(&locked), 0, 10).unwrap_err()),
                FileErrorKind::Denied
            );
        }
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
    });
}

#[test]
fn errors_name_what_went_wrong() {
    on_both(|files, work| {
        std::fs::write(work.join("file"), "x").unwrap();
        std::fs::create_dir(work.join("dir")).unwrap();
        assert_eq!(
            kind(&files.list(&s(&work.join("nope"))).unwrap_err()),
            FileErrorKind::NotFound
        );
        assert_eq!(
            kind(&files.list(&s(&work.join("file"))).unwrap_err()),
            FileErrorKind::NotADirectory
        );
        assert_eq!(
            kind(&files.read(&s(&work.join("dir")), 0, 1).unwrap_err()),
            FileErrorKind::IsADirectory
        );
        assert_eq!(
            kind(&files.stat(&s(&work.join("nope"))).unwrap_err()),
            FileErrorKind::NotFound
        );
        assert_eq!(
            kind(&files.list("relative").unwrap_err()),
            FileErrorKind::Invalid
        );
    });
}

#[test]
fn a_file_is_read_in_ranges_and_the_end_is_not_an_error() {
    on_both(|files, work| {
        let path = work.join("n.bin");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
        std::fs::write(&path, &bytes).unwrap();
        let p = s(&path);
        let a = files.read(&p, 0, 300).unwrap();
        assert_eq!((a.size, a.data.as_slice()), (1000, &bytes[..300]));
        let b = files.read(&p, 900, 300).unwrap();
        assert_eq!(b.data, &bytes[900..], "the end of the file is a short read");
        assert!(files.read(&p, 5000, 10).unwrap().data.is_empty());
        let stat = files.stat(&p).unwrap();
        assert_eq!(
            (stat.kind, stat.size, stat.readable),
            (EntryKind::File, 1000, true)
        );
        assert_eq!(files.stat(&s(work)).unwrap().kind, EntryKind::Dir);
    });
}

#[test]
fn the_home_folder_is_what_a_leading_tilde_means() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("note.txt"), "hi").unwrap();
    let local = LocalFiles::with_home(home.path());
    assert_eq!(local.read("~/note.txt", 0, 10).unwrap().data, b"hi");
    assert_eq!(local.list("~").unwrap().entries[0].name, "note.txt");

    let rig = Rig::new();
    std::fs::write(rig.home.join("note.txt"), "remote hi").unwrap();
    let remote = rig.remote();
    assert_eq!(remote.read("~/note.txt", 0, 20).unwrap().data, b"remote hi");
    assert_eq!(remote.list("~").unwrap().path, s(&rig.home));
}

// ---- hostile names ------------------------------------------------------------------------------

const HOSTILE: &[&str] = &[
    "a; touch PWNED #",
    "$(touch PWNED)",
    "`touch PWNED`",
    "it's \"quoted\"",
    "two\nlines",
    "-rf",
    "tab\there",
    "back\\slash",
    "| touch PWNED",
    "& touch PWNED &",
    "$HOME",
    "ünïcödé 日本語",
];

#[test]
fn a_crafted_name_is_only_ever_a_name() {
    let work = tempfile::tempdir().unwrap();
    let rig = Rig::new();
    let remote = rig.remote();
    let local = LocalFiles::new();
    for (n, name) in HOSTILE.iter().enumerate() {
        let dir = work.path().join(name);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join(name), format!("content {n}")).unwrap();
    }
    for (which, files) in [&remote as &dyn Files, &local].into_iter().enumerate() {
        let listing = files.list(&s(work.path())).unwrap();
        assert_eq!(
            listing.entries.len(),
            HOSTILE.len(),
            "every hostile folder is listed by its own name"
        );
        for (n, name) in HOSTILE.iter().enumerate() {
            let folder = join(&s(work.path()), name).unwrap();
            let inside = files.list(&folder).unwrap();
            assert!(inside.entries.iter().any(|e| e.name == *name), "{name:?}");
            let file = join(&folder, name).unwrap();
            assert_eq!(
                files.read(&file, 0, 100).unwrap().data,
                format!("content {n}").as_bytes()
            );
            // Writing under such a name creates exactly that file.
            let target = join(&folder, &format!("new{which} {name}")).unwrap();
            files.put(&target, 0, b"data").unwrap();
            files.commit(&target, false).unwrap();
            assert_eq!(files.read(&target, 0, 10).unwrap().data, b"data");
        }
    }
    // Nothing a name tried to run ran: no PWNED file anywhere we or the shell could have made one.
    for place in [
        work.path().to_path_buf(),
        std::env::current_dir().unwrap(),
        rig.home.clone(),
    ] {
        assert!(
            !place.join("PWNED").exists(),
            "{} holds a file a crafted name created",
            place.display()
        );
    }
}

#[test]
fn a_path_that_is_a_shell_command_reads_nothing_and_runs_nothing() {
    let rig = Rig::new();
    let remote = rig.remote();
    let marker = rig.dir.path().join("MARKER");
    for path in [
        format!("/x'; touch {}; echo '", marker.display()),
        format!("/$(touch {})", marker.display()),
        format!("/`touch {}`", marker.display()),
        format!("/x\ntouch {}", marker.display()),
    ] {
        assert_eq!(
            kind(&remote.read(&path, 0, 10).unwrap_err()),
            FileErrorKind::NotFound,
            "{path:?}"
        );
        assert_eq!(
            kind(&remote.list(&path).unwrap_err()),
            FileErrorKind::NotFound
        );
    }
    assert!(!marker.exists());
}

// ---- viewer -------------------------------------------------------------------------------------

fn view(
    files: &dyn Files,
    path: &Path,
    cache: &Path,
) -> Result<herdr_core::files::FileView, FileError> {
    open(files, &s(path), cache, "m1")
}

#[test]
fn text_markdown_binary_and_folders_are_told_apart_by_what_they_hold() {
    on_both(|files, work| {
        let cache = work.join("cache");
        std::fs::write(work.join("main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(work.join("README.md"), "# Title\n").unwrap();
        std::fs::write(work.join("blob"), [0u8, 1, 2, 0xff, 0xfe]).unwrap();
        std::fs::write(work.join("empty"), "").unwrap();
        std::fs::write(work.join("latin1.txt"), [0x63, 0x61, 0x66, 0xe9]).unwrap();
        std::fs::create_dir(work.join("sub")).unwrap();
        let text = view(files, &work.join("main.rs"), &cache).unwrap();
        assert_eq!(
            (text.kind, text.text.as_deref(), text.notice.as_deref()),
            (ViewKind::Text, Some("fn main() {}\n"), None)
        );
        assert_eq!(text.name, "main.rs");
        let md = view(files, &work.join("README.md"), &cache).unwrap();
        assert_eq!(
            (md.kind, md.text.as_deref()),
            (ViewKind::Markdown, Some("# Title\n"))
        );
        let binary = view(files, &work.join("blob"), &cache).unwrap();
        assert_eq!(
            (binary.kind, binary.text, binary.size),
            (ViewKind::Binary, None, 5)
        );
        assert_eq!(
            view(files, &work.join("empty"), &cache)
                .unwrap()
                .text
                .as_deref(),
            Some("")
        );
        assert_eq!(
            view(files, &work.join("latin1.txt"), &cache).unwrap().kind,
            ViewKind::Binary,
            "not UTF-8 is not text"
        );
        assert_eq!(
            kind(&view(files, &work.join("sub"), &cache).unwrap_err()),
            FileErrorKind::IsADirectory
        );
    });
}

#[test]
fn a_text_file_over_the_cap_is_paged_not_cut_and_a_binary_one_is_not_text() {
    on_both(|files, work| {
        std::fs::write(
            work.join("big.txt"),
            "日".repeat((TEXT_CAP as usize) / 3 + 1000),
        )
        .unwrap();
        let v = view(files, &work.join("big.txt"), &work.join("cache")).unwrap();
        assert_eq!((v.kind, v.large), (ViewKind::Text, true));
        assert_eq!(
            v.text, None,
            "nothing of it is held: the viewer pages through it"
        );
        let mut binary = vec![0u8; TEXT_CAP as usize + 10];
        binary[100] = 1;
        std::fs::write(work.join("big.bin"), binary).unwrap();
        let v = view(files, &work.join("big.bin"), &work.join("cache")).unwrap();
        assert_eq!((v.kind, v.large), (ViewKind::Binary, false));
    });
}

#[test]
fn media_pdf_archives_and_tables_are_told_apart_by_name_and_read_nothing() {
    on_both(|files, work| {
        for (name, kind) in [
            ("clip.mp4", ViewKind::Video),
            ("tone.flac", ViewKind::Audio),
            ("paper.pdf", ViewKind::Pdf),
            ("bundle.zip", ViewKind::Archive),
            ("rows.csv", ViewKind::Csv),
        ] {
            std::fs::write(work.join(name), "a,b\n1,2\n").unwrap();
            let v = view(files, &work.join(name), &work.join("cache")).unwrap();
            assert_eq!(v.kind, kind, "{name}");
        }
        let video = view(files, &work.join("clip.mp4"), &work.join("cache")).unwrap();
        assert_eq!((video.text, video.image), (None, None));
        let table = view(files, &work.join("rows.csv"), &work.join("cache")).unwrap();
        assert_eq!(table.text.as_deref(), Some("a,b\n1,2\n"));
    });
}

#[test]
fn a_picture_is_a_file_on_this_computer_and_a_remote_one_is_kept_once() {
    let work = tempfile::tempdir().unwrap();
    let picture = work.path().join("shot.png");
    let bytes: Vec<u8> = (0..70_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&picture, &bytes).unwrap();
    let cache = work.path().join("cache");

    let local = view(&LocalFiles::new(), &picture, &cache).unwrap();
    assert_eq!(
        (local.kind, local.image.as_deref()),
        (ViewKind::Image, Some(picture.as_path()))
    );
    assert!(
        !cache.exists(),
        "a local picture is shown where it is, not copied"
    );

    let rig = Rig::new();
    let remote = rig.remote();
    let first = view(&remote, &picture, &cache).unwrap();
    let copy = first.image.clone().unwrap();
    assert!(copy.starts_with(&cache) && copy.extension().unwrap() == "png");
    assert_eq!(std::fs::read(&copy).unwrap(), bytes);
    std::fs::write(&copy, b"marker").unwrap();
    assert_eq!(
        view(&remote, &picture, &cache).unwrap().image,
        Some(copy.clone())
    );
    assert_eq!(
        std::fs::read(&copy).unwrap(),
        b"marker",
        "the same file is not fetched again"
    );
    // A changed file is a new picture.
    std::fs::write(&picture, [&bytes[..], b"more"].concat()).unwrap();
    assert_ne!(view(&remote, &picture, &cache).unwrap().image, Some(copy));
    assert!(
        std::fs::read_dir(&cache)
            .unwrap()
            .all(|e| e.unwrap().path().extension().unwrap() != "part")
    );
}

#[test]
fn a_picture_over_the_cap_is_not_opened_and_says_how_big_it_is() {
    let work = tempfile::tempdir().unwrap();
    let huge = work.path().join("huge.jpg");
    std::fs::File::create(&huge)
        .unwrap()
        .set_len(IMAGE_CAP + 1)
        .unwrap();
    let v = view(&LocalFiles::new(), &huge, work.path()).unwrap();
    assert_eq!((v.kind, v.image), (ViewKind::Image, None));
    assert!(v.notice.unwrap().contains("up to 40 MB"));
}

#[test]
fn a_picture_travels_as_a_data_address_of_its_own_type_and_bytes_never_as_a_file_address() {
    use std::io::Read;
    let work = tempfile::tempdir().unwrap();
    // Tiny real headers; the name lies for the last one, the bytes win.
    let png = [0x89, b'P', b'N', b'G', 13, 10, 26, 10, 1, 2, 3];
    let gif = *b"GIF89a\x01\x00\x01\x00\x00\x00";
    let webp = *b"RIFF\x04\x00\x00\x00WEBPVP8 ";
    let svg = b"<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>";
    let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 16];
    for (name, bytes, mime) in [
        ("a.png", &png[..], "image/png"),
        ("b.gif", &gif[..], "image/gif"),
        ("c.webp", &webp[..], "image/webp"),
        ("d.svg", &svg[..], "image/svg+xml"),
        ("e.jpg", &jpeg[..], "image/jpeg"),
        ("f.png", &jpeg[..], "image/jpeg"),
    ] {
        let path = work.path().join(name);
        std::fs::write(&path, bytes).unwrap();
        let url = picture_data_url(&path).unwrap();
        let (head, body) = url.split_once(";base64,").unwrap();
        assert_eq!(head, format!("data:{mime}"), "{name}");
        // Decode with the system's base64 to prove the bytes are the file's.
        let mut child = std::process::Command::new("base64")
            .arg("-d")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut child.stdin.take().unwrap(), body.as_bytes()).unwrap();
        let mut out = Vec::new();
        child.stdout.take().unwrap().read_to_end(&mut out).unwrap();
        child.wait().unwrap();
        assert_eq!(out, bytes, "{name}");
    }
}

#[test]
fn a_picture_over_the_window_cap_is_not_read_and_says_to_open_it() {
    let work = tempfile::tempdir().unwrap();
    let big = work.path().join("big.png");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(PICTURE_DATA_CAP + 1)
        .unwrap();
    let v = view(&LocalFiles::new(), &big, work.path()).unwrap();
    assert_eq!((v.kind, v.image), (ViewKind::Image, None));
    let notice = v.notice.unwrap();
    assert!(notice.contains("too large to show here") && notice.contains("Open or Reveal"));
    assert!(picture_data_url(&big).is_err());
}

// ---- send a file ----------------------------------------------------------------------------------

fn send(files: &dyn Files, source: &Path, dest: &Path, replace: bool) -> Result<u64, UploadError> {
    upload(
        files,
        source,
        &s(dest),
        replace,
        1000,
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
}

#[test]
fn a_file_arrives_whole_in_pieces_and_with_progress() {
    on_both(|files, work| {
        let source = work.join("from.bin");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(4500).collect();
        std::fs::write(&source, &bytes).unwrap();
        let dest = work.join("to.bin");
        let mut seen = Vec::new();
        let sent = upload(
            files,
            &source,
            &s(&dest),
            false,
            1000,
            &AtomicBool::new(false),
            &mut |a, b| seen.push((a, b)),
        )
        .unwrap();
        assert_eq!(sent, 4500);
        assert_eq!(std::fs::read(&dest).unwrap(), bytes);
        assert_eq!(seen.last(), Some(&(4500, 4500)));
        assert!(
            seen.windows(2).all(|w| w[0].0 < w[1].0),
            "progress only moves forward"
        );
        let empty = work.join("empty");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(
            send(files, &empty, &work.join("empty-copy"), false).unwrap(),
            0
        );
        assert!(work.join("empty-copy").exists());
        let names: Vec<_> = std::fs::read_dir(work)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(
            names.iter().all(|n| !n.ends_with(".herdr-part")),
            "no half-made file is left: {names:?}"
        );
    });
}

#[test]
fn a_name_that_is_taken_is_never_overwritten_unless_asked() {
    on_both(|files, work| {
        let source = work.join("new.txt");
        std::fs::write(&source, "new").unwrap();
        let dest = work.join("old.txt");
        std::fs::write(&dest, "old").unwrap();
        match send(files, &source, &dest, false) {
            Err(UploadError::Machine(e)) => assert_eq!(e.kind, FileErrorKind::Exists),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "old",
            "the file that was there is untouched"
        );
        assert!(!work.join(".old.txt.herdr-part").exists());
        send(files, &source, &dest, true).unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
        match send(files, &source, work, false) {
            Err(UploadError::Machine(e)) => assert_eq!(e.kind, FileErrorKind::IsADirectory),
            other => panic!("{other:?}"),
        }
    });
}

#[test]
fn a_file_that_appears_while_sending_is_not_overwritten_either() {
    // The up-front check passes; the move at the end is what refuses, atomically.
    on_both(|files, work| {
        let source = work.join("a.txt");
        std::fs::write(&source, vec![b'x'; 3000]).unwrap();
        let dest = work.join("race.txt");
        let flag = AtomicBool::new(false);
        let result = upload(
            files,
            &source,
            &s(&dest),
            false,
            1000,
            &flag,
            &mut |sent, _| {
                if sent == 2000 {
                    std::fs::write(&dest, "somebody else's").unwrap();
                }
            },
        );
        assert!(
            matches!(&result, Err(UploadError::Machine(e)) if e.kind == FileErrorKind::Exists),
            "{result:?}"
        );
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "somebody else's");
        assert!(!work.join(".race.txt.herdr-part").exists());
    });
}

#[test]
fn stopping_an_upload_leaves_nothing_behind() {
    on_both(|files, work| {
        let source = work.join("a.bin");
        std::fs::write(&source, vec![1u8; 5000]).unwrap();
        let dest = work.join("stopped.bin");
        let cancel = AtomicBool::new(false);
        let result = upload(
            files,
            &source,
            &s(&dest),
            false,
            1000,
            &cancel,
            &mut |sent, _| {
                if sent >= 2000 {
                    cancel.store(true, Ordering::Relaxed);
                }
            },
        );
        assert_eq!(result, Err(UploadError::Cancelled));
        assert!(!dest.exists() && !work.join(".stopped.bin.herdr-part").exists());
    });
}

#[test]
fn only_files_are_sent() {
    on_both(|files, work| {
        std::fs::create_dir(work.join("folder")).unwrap();
        assert!(matches!(
            send(files, &work.join("folder"), &work.join("x"), false),
            Err(UploadError::Source(_))
        ));
        assert!(matches!(
            send(files, &work.join("missing"), &work.join("x"), false),
            Err(UploadError::Source(_))
        ));
        assert!(matches!(
            send(files, &work.join("folder"), Path::new("relative"), false),
            Err(UploadError::Machine(_))
        ));
    });
}

#[test]
fn a_lost_chunk_is_refused_rather_than_assembled_into_a_corrupt_file() {
    on_both(|files, work| {
        let dest = s(&work.join("gap.bin"));
        files.put(&dest, 0, b"first").unwrap();
        let skipped = files.put(&dest, 10, b"third").unwrap_err();
        assert!(skipped.message.contains("out of order"), "{skipped}");
        files.discard(&dest).unwrap();
        files.discard(&dest).unwrap();
        assert!(!work.join("gap.bin").exists());
    });
}

// ---- remote machines that cannot do it -------------------------------------------------------------

#[test]
fn a_machine_without_python3_says_so() {
    let rig = Rig::new();
    let empty = tempfile::tempdir().unwrap();
    let script = rig.dir.path().join("ssh-nopython");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nwhile [ \"$1\" != \"--\" ]; do shift; done\nshift\nshift\nexec /usr/bin/env -i PATH=\"{}\" /bin/sh -c \"exec $1\"\n",
            empty.path().display()
        ),
    )
    .unwrap();
    let client = SshClient::with_control_dir(rig.dir.path().join("control2"))
        .program("/bin/sh")
        .program_arg(&script);
    let files = RemoteFiles::new(client, Rig::target());
    // `sh` and `base64` are not on that PATH either, so the wrapper cannot even start: the machine is
    // unusable, and the error says what failed rather than inventing a listing.
    let err = files.list("/").unwrap_err();
    assert!(
        matches!(err.kind, FileErrorKind::Unsupported | FileErrorKind::Other),
        "{err}"
    );
}

#[test]
fn an_unreachable_machine_is_unreachable_not_empty() {
    let rig = Rig::new();
    let client =
        SshClient::with_control_dir(rig.dir.path().join("control3")).program("/nonexistent/ssh");
    let err = RemoteFiles::new(client, Rig::target())
        .list("/")
        .unwrap_err();
    assert_eq!(err.kind, FileErrorKind::Unreachable);
}

// ---- names an agent prints and addresses a drop delivers --------------------------------------------

#[test]
fn a_relative_path_is_looked_for_in_the_pane_folder_and_two_above_it() {
    assert_eq!(
        candidates("/w/proj/sub", "docs/x.md"),
        ["/w/proj/sub/docs/x.md", "/w/proj/docs/x.md", "/w/docs/x.md"]
    );
    assert_eq!(
        candidates("/w/proj", "a/src/main.rs"),
        [
            "/w/proj/a/src/main.rs",
            "/w/proj/src/main.rs",
            "/w/a/src/main.rs",
            "/w/src/main.rs",
            "/a/src/main.rs",
            "/src/main.rs"
        ],
        "git's a/ prefix is a second try in each folder"
    );
    assert_eq!(candidates("/", "x"), ["/x"]);
    // `./` and `../` name their place from the pane's folder: only there, `..` folded.
    assert_eq!(candidates("/w", "./x"), ["/w/x"]);
    assert_eq!(
        candidates("/w/proj/sub", "../docs/x.md"),
        ["/w/proj/docs/x.md"]
    );
    assert_eq!(
        candidates("/w", "../../x"),
        ["/x"],
        "above the root is the root"
    );
    assert_eq!(candidates("~/proj", "../x"), ["~/x"]);
    assert_eq!(candidates("/w/proj", ".."), ["/w"]);
    for own in ["/etc/hosts", "~/notes.md", "~"] {
        assert_eq!(
            candidates("/w/proj", own),
            [own],
            "an absolute path is only itself"
        );
    }
    assert!(candidates("/w", "").is_empty() && candidates("/w", "a\0b").is_empty());
}

#[test]
fn a_relative_path_is_found_in_the_session_folder_then_the_project_and_a_miss_names_the_folder() {
    let work = tempfile::tempdir().unwrap();
    let root = work.path().join("proj");
    let sub = root.join("deep/er/sub");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::create_dir_all(root.join(".scratch/shots")).unwrap();
    std::fs::write(root.join(".scratch/shots/a.png"), b"png").unwrap();
    std::fs::write(sub.join("here.md"), b"x").unwrap();
    std::fs::write(root.join("deep/up.md"), b"x").unwrap();
    let files = LocalFiles::new();
    let s = |p: &Path| p.to_str().unwrap().to_owned();
    let folders = [s(&sub), s(&root)];

    // Three folders below the project: not within the two above the session's folder, found in the project.
    let (path, stat) = find_path(&files, &folders, ".scratch/shots/a.png").unwrap();
    assert_eq!(path, s(&root.join(".scratch/shots/a.png")));
    assert_eq!(stat.kind, EntryKind::File);
    // The session's folder wins, `./` and `../` are its own.
    assert_eq!(
        find_path(&files, &folders, "./here.md").unwrap().0,
        s(&sub.join("here.md"))
    );
    assert_eq!(
        find_path(&files, &folders, "../../up.md").unwrap().0,
        s(&root.join("deep/up.md"))
    );
    let (dir, stat) = find_path(&files, &folders, "../../er").unwrap();
    assert_eq!((dir, stat.kind), (s(&root.join("deep/er")), EntryKind::Dir));
    // `./` is the session's folder only: the project's copy is not what it names.
    assert_eq!(
        find_path(&files, &folders, "./.scratch/shots/a.png")
            .unwrap_err()
            .kind,
        FileErrorKind::NotFound
    );

    let miss = find_path(&files, &folders, ".scratch/x.png").unwrap_err();
    assert_eq!(miss.kind, FileErrorKind::NotFound);
    assert_eq!(miss.message, format!(".scratch/x.png isn't in {}", s(&sub)));
    let gone = find_path(&files, &folders, "/nowhere/x.png").unwrap_err();
    assert_eq!(gone.message, "/nowhere/x.png does not exist");
    // Without a folder a relative path is not guessed at: never a validation error about its shape.
    let lost = find_path(&files, &[], "x.png").unwrap_err();
    assert_eq!(lost.kind, FileErrorKind::Invalid);
    assert_eq!(lost.message, "Cannot tell which folder x.png is in");
    // What reaches the machine is still checked: a NUL is never a path.
    assert!(find_path(&files, &folders, "a\0b").is_err());
}

#[test]
fn a_dropped_file_address_becomes_a_local_path_and_back() {
    assert_eq!(
        path_from_uri("file:///home/me/a%20b%C3%A9.txt").as_deref(),
        Some("/home/me/a bé.txt")
    );
    assert_eq!(
        path_from_uri("file://localhost/tmp/x").as_deref(),
        Some("/tmp/x")
    );
    for not in [
        "https://x/y",
        "file://otherhost/x",
        "file:relative",
        "file:///a%zz",
        "file:///a%00b",
        "file:///a%",
        "/plain/path",
    ] {
        assert_eq!(path_from_uri(not), None, "{not}");
    }
    for path in ["/tmp/a b/ü?#%.png", "/plain/x.txt", "/a'b\"c"] {
        assert_eq!(path_from_uri(&uri_from_path(path)).as_deref(), Some(path));
    }
    assert_eq!(uri_from_path("/tmp/a b.png"), "file:///tmp/a%20b.png");
}

#[test]
fn the_parent_of_a_path_is_its_folder() {
    assert_eq!(parent("/a/b").as_deref(), Some("/a"));
    assert_eq!(parent("/a/b/").as_deref(), Some("/a"));
    assert_eq!(parent("/a").as_deref(), Some("/"));
    assert_eq!(parent("/").as_deref(), Some("/"));
    assert_eq!(parent("rel"), None);
}

// ---- pages ---------------------------------------------------------------------------------------

#[test]
fn only_a_machines_own_loopback_addresses_are_tunnelled() {
    let some = |url: &str| localhost_port(url);
    assert_eq!(
        some("http://localhost:5173/app?x=1#top"),
        Some(("http".into(), 5173, "/app?x=1#top".into()))
    );
    assert_eq!(
        some("http://127.0.0.1:8080"),
        Some(("http".into(), 8080, String::new()))
    );
    assert_eq!(
        some("HTTP://LocalHost:3000/"),
        Some(("http".into(), 3000, "/".into()))
    );
    assert_eq!(
        some("https://localhost/"),
        Some(("https".into(), 443, "/".into()))
    );
    assert_eq!(
        some("http://[::1]:9000/x"),
        Some(("http".into(), 9000, "/x".into()))
    );
    assert_eq!(some("http://[::1]/"), Some(("http".into(), 80, "/".into())));
    assert_eq!(
        some("http://0.0.0.0:4000/"),
        Some(("http".into(), 4000, String::new()).tap_path("/"))
    );
    for not in [
        "http://example.com:8080/",
        "http://localhost.evil.com:80/",
        "http://localhost@evil.example/",
        "http://evil.example@localhost:80/",
        "http://localhost:0/",
        "http://localhost:99999/",
        "http://localhost:abc/",
        "ftp://localhost:21/",
        "file:///etc/passwd",
        "localhost:3000",
        "javascript:alert(1)",
    ] {
        assert_eq!(some(not), None, "{not}");
    }
}

trait TapPath {
    fn tap_path(self, path: &str) -> Self;
}

impl TapPath for (String, u16, String) {
    fn tap_path(mut self, path: &str) -> Self {
        self.2 = path.to_owned();
        self
    }
}

#[test]
fn a_tunnel_binds_only_the_loopback_address_and_goes_away_with_its_tab() {
    let rig = Rig::new();
    let tunnel = Tunnel::open(rig.client(), Rig::target(), 5173).unwrap();
    let port = tunnel.local_port();
    assert!(port > 0 && tunnel.remote_port() == 5173);
    let log = rig.control_log();
    assert!(
        log.contains(&format!("-O forward -L 127.0.0.1:{port}:localhost:5173")),
        "the forward is bound to 127.0.0.1 only: {log}"
    );
    assert!(!log.contains("cancel"));
    tunnel.close();
    tunnel.close();
    drop(tunnel);
    let log = rig.control_log();
    assert_eq!(
        log.matches("-O cancel").count(),
        1,
        "closed once however often it is closed: {log}"
    );
    assert!(log.contains(&format!("-O cancel -L 127.0.0.1:{port}:localhost:5173")));
}

#[test]
fn a_tunnel_that_cannot_be_made_says_why_and_a_refused_login_is_not_retried() {
    let rig = Rig::new();
    let failing = rig.dir.path().join("ssh-refuse");
    std::fs::write(
        &failing,
        "#!/bin/sh\necho 'box: Permission denied (publickey).' >&2\nexit 255\n",
    )
    .unwrap();
    let client = SshClient::with_control_dir(rig.dir.path().join("control4"))
        .program("/bin/sh")
        .program_arg(&failing);
    let err = Tunnel::open(client, Rig::target(), 80).unwrap_err();
    assert!(err.is_fatal(), "{err:?}");
}

/// Real ssh to `$HERDR_DESKTOP_SSH_TEST` (for example `me@localhost`): lists a folder, uploads a file and
/// reaches a local web server through a real forward. `cargo test -- --ignored`.
#[test]
#[ignore = "needs a reachable ssh destination in HERDR_DESKTOP_SSH_TEST"]
fn real_ssh_lists_uploads_and_forwards() {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    let Some(dest) = std::env::var("HERDR_DESKTOP_SSH_TEST")
        .ok()
        .filter(|d| !d.is_empty())
    else {
        panic!("HERDR_DESKTOP_SSH_TEST is not set");
    };
    let data = tempfile::tempdir().unwrap();
    let client = SshClient::new(data.path()).unwrap();
    let target = SshTarget::new(&dest, None, None, None).unwrap();
    let files = RemoteFiles::new(client.clone(), target.clone());
    let work = tempfile::tempdir().unwrap();
    std::fs::write(work.path().join("hello.txt"), "hello over ssh").unwrap();
    std::fs::create_dir(work.path().join("it's; $(odd)")).unwrap();
    let listing = files.list(&s(work.path())).unwrap();
    assert_eq!(listing.entries[0].name, "it's; $(odd)");
    let v = open(
        &files,
        &s(&work.path().join("hello.txt")),
        data.path(),
        "real",
    )
    .unwrap();
    assert_eq!(v.text.as_deref(), Some("hello over ssh"));
    let src = work.path().join("src.bin");
    std::fs::write(&src, vec![7u8; 5_000_000]).unwrap();
    let dest_file = work.path().join("sent.bin");
    upload(
        &files,
        &src,
        &s(&dest_file),
        false,
        2 * 1024 * 1024,
        &AtomicBool::new(false),
        &mut |_, _| {},
    )
    .unwrap();
    assert_eq!(std::fs::read(&dest_file).unwrap().len(), 5_000_000);

    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let served = server.local_addr().unwrap().port();
    let thread = std::thread::spawn(move || {
        let (mut conn, _) = server.accept().unwrap();
        let mut buf = [0u8; 256];
        let _ = conn.read(&mut buf);
        conn.write_all(b"HTTP/1.0 200 OK\r\n\r\nthrough the tunnel")
            .unwrap();
    });
    let tunnel = Tunnel::open(client, target, served).unwrap();
    let mut conn = TcpStream::connect(("127.0.0.1", tunnel.local_port())).unwrap();
    conn.write_all(b"GET / HTTP/1.0\r\n\r\n").unwrap();
    let mut body = String::new();
    conn.read_to_string(&mut body).unwrap();
    assert!(body.ends_with("through the tunnel"), "{body}");
    thread.join().unwrap();
    tunnel.close();
    assert!(
        TcpStream::connect(("127.0.0.1", tunnel.local_port())).is_err(),
        "the port is closed once the tunnel is"
    );
}

// ---- media, archives, big text: the same readers over a machine that is reached by ssh ----------------------------

fn pattern(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i % 251) as u8).collect()
}

#[test]
fn another_machines_video_is_copied_in_one_megabyte_reads_into_a_cache_that_holds_its_cap() {
    on_both(|files, work| {
        let data = pattern(MEDIA_CHUNK * 5 / 2);
        std::fs::write(work.join("clip.mp4"), &data).unwrap();
        std::fs::write(work.join("other.mp4"), pattern(MEDIA_CHUNK * 2)).unwrap();
        let cache = MediaCache::new(work.join("cache"), 4 * MEDIA_CHUNK as u64);
        let one = |name: &str, cancel: &AtomicBool| {
            let path = s(&work.join(name));
            let stat = files.stat(&path).unwrap();
            let mut last = (0, 0);
            let copy = fetch(
                files,
                &cache,
                "m",
                &path,
                stat.size,
                stat.modified,
                cancel,
                &mut |d, t| last = (d, t),
            )?;
            assert_eq!(last.0, last.1, "the last progress is the whole file");
            Ok::<_, FetchError>(copy)
        };
        let copy = one("clip.mp4", &AtomicBool::new(false)).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), data, "a byte-exact copy");
        cache.unpin(&copy);
        // A second file does not fit beside the first: the first goes, and the folder stays within its cap.
        let other = one("other.mp4", &AtomicBool::new(false)).unwrap();
        assert!(!copy.exists() && other.exists());
        assert!(cache.used() <= cache.cap());
        // A cancel leaves no part file behind.
        cache.unpin(&other);
        let cancelled = one("clip.mp4", &AtomicBool::new(true)).unwrap_err();
        assert_eq!(cancelled, FetchError::Cancelled);
        let names: Vec<_> = std::fs::read_dir(work.join("cache"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert!(
            names.iter().all(|p| p.extension().unwrap() != "part"),
            "{names:?}"
        );
    });
}

#[test]
fn the_codecs_of_a_movie_are_read_from_its_headers_on_both_machines() {
    on_both(|files, work| {
        let mp4 = |kind: &[u8; 4], body: &[u8]| {
            let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            out.extend_from_slice(kind);
            out.extend_from_slice(body);
            out
        };
        let mut hdlr = vec![0u8; 8];
        hdlr.extend_from_slice(b"vide");
        let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
        stsd.extend(mp4(b"hvc1", &[0; 8]));
        let stbl = mp4(b"stbl", &mp4(b"stsd", &stsd));
        let mdia = [mp4(b"hdlr", &hdlr), mp4(b"minf", &stbl)].concat();
        let moov = mp4(b"moov", &mp4(b"trak", &mp4(b"mdia", &mdia)));
        let movie = [
            mp4(b"ftyp", b"isom\0\0\0\0isom"),
            mp4(b"mdat", &pattern(300_000)),
            moov,
        ]
        .concat();
        std::fs::write(work.join("clip.mp4"), movie).unwrap();
        let codecs = probe_codecs(files, &s(&work.join("clip.mp4"))).unwrap();
        assert_eq!(codecs.video.as_deref(), Some("H.265"));
        assert_eq!(codecs.describe().as_deref(), Some("H.265 video"));
    });
}

#[test]
fn a_peek_shows_four_kilobytes_of_a_binary_and_names_it() {
    on_both(|files, work| {
        let mut elf = b"\x7fELF\x02\x01\x01".to_vec();
        elf.extend(pattern(200_000));
        std::fs::write(work.join("tool"), elf).unwrap();
        let p = peek(files, &s(&work.join("tool"))).unwrap();
        assert_eq!((p.size, p.shown, p.rows.len()), (200_007, 4096, 256));
        assert_eq!(p.detected.as_deref(), Some("ELF executable"));
        assert!(
            p.rows[0].starts_with("00000000  7f 45 4c 46 02 01 01 00"),
            "{}",
            p.rows[0]
        );
    });
}

#[test]
fn an_archive_is_listed_without_unpacking_it_on_both_machines() {
    on_both(|files, work| {
        let zip = work.join("a.zip");
        let status = std::process::Command::new("python3")
            .args(["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('src/main.rs','fn main(){}'); z.writestr('README.md','hi'); z.close()"])
            .arg(&zip)
            .status()
            .unwrap();
        assert!(status.success());
        let listing = list_archive(files, &s(&zip)).unwrap();
        assert_eq!(listing.format, "zip");
        let names: Vec<_> = listing
            .entries
            .iter()
            .map(|e| (e.name.as_str(), e.size))
            .collect();
        assert_eq!(names, vec![("src/main.rs", 11), ("README.md", 2)]);
    });
}

#[test]
fn a_big_log_is_paged_and_searched_by_lines_on_both_machines() {
    on_both(|files, work| {
        let log: String = (0..60_000)
            .map(|i| {
                format!(
                    "{i:06} {}\n",
                    if i == 45_678 { "the NEEDLE" } else { "hay" }
                )
            })
            .collect();
        std::fs::write(work.join("big.log"), &log).unwrap();
        let path = s(&work.join("big.log"));
        let size = files.stat(&path).unwrap().size;
        let index = parking_lot::Mutex::new(LineIndex::new(size));
        scan_lines(files, &path, &index, &AtomicBool::new(false)).unwrap();
        assert_eq!(index.lock().lines, 60_000);
        let page = read_lines(files, &path, &index, 45_670, 3).unwrap();
        assert_eq!(page, vec!["045670 hay", "045671 hay", "045672 hay"]);
        let hit = find_line(
            files,
            &path,
            &index,
            "needle",
            None,
            true,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(hit, Some(45_678));
    });
}
