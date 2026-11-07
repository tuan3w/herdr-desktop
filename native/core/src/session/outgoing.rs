//! What a message carries besides its words, made ready to send: files and folders the person mentioned or attached
//! (they are on the agent's machine), and pictures they pasted or dropped (they are on this computer, prepared by
//! `crate::compose`).
//!
//! Reading happens here, on the caller's thread, never on the session's: a 5 MB picture or a file on another machine
//! takes as long as the machine takes, and the session thread must keep answering the agent meanwhile. What a block
//! becomes depends on what the agent said it takes (`promptCapabilities`):
//!
//! | Thing | Agent takes pictures / embedded context | Otherwise |
//! |---|---|---|
//! | a picture file or a pasted picture | an `image` block with the bytes | a `resource_link` (a pasted picture of a REMOTE session is refused: the machine cannot open a path of this computer) |
//! | a text file of at most [`EMBED_MAX`] bytes | an embedded `resource` with its text (Zed does the same) | a `resource_link` |
//! | any other file, a folder | a `resource_link` | a `resource_link` |

use super::error::Refusal;
use super::types::SessionSnapshot;
use super::vendored::attach::{self, Attachment, MAX_PICTURE_BYTES, MAX_PICTURES_TOTAL};
use crate::files::{EntryKind, Files};

/// The biggest text file sent as the text itself: past it the agent is told where the file is and reads it as it
/// needs (a whole file in the prompt is tokens spent before the agent decided it needs them).
pub const EMBED_MAX: u64 = 32 * 1024;

/// What the agent said a prompt may carry.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Caps {
    /// `promptCapabilities.image`.
    pub pictures: bool,
    /// `promptCapabilities.embeddedContext`.
    pub embedded: bool,
}

impl Caps {
    /// What `snapshot`'s agent said.
    pub fn of(snapshot: &SessionSnapshot) -> Self {
        Self {
            pictures: snapshot.accepts_pictures,
            embedded: snapshot.acp.accepts_embedded,
        }
    }
}

/// A picture of this computer the message carries: a prepared one (`crate::compose::prepare`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pasted {
    /// The file, on this computer.
    pub path: String,
    /// What the transcript calls it.
    pub name: String,
    /// Its `[Image #n]` number in the text.
    pub number: u32,
}

/// A message's files and pictures, read and ready. Opaque: the session turns it into content blocks.
#[derive(Clone, Debug, Default)]
pub struct Outgoing {
    pub(super) files: Vec<Attachment>,
}

impl Outgoing {
    /// How many things go with the message.
    pub fn len(&self) -> usize {
        self.files.len()
    }

    /// Nothing goes with the message but its words.
    pub fn is_empty(&self) -> bool {
        self.files.is_empty()
    }
}

/// What a message that comes back to the box held: the files (paths on the agent's machine) and the pictures of this
/// computer, told apart.
pub(super) fn split(files: &[Attachment]) -> (Vec<String>, Vec<Pasted>) {
    let paths = files
        .iter()
        .filter(|f| !f.pasted)
        .map(|f| f.path.clone())
        .collect();
    let pictures = files
        .iter()
        .filter(|f| f.pasted)
        .map(|f| Pasted {
            path: f.path.clone(),
            name: f.name.clone(),
            number: f.number,
        })
        .collect();
    (paths, pictures)
}

fn refuse(path: &str, e: &crate::files::FileError) -> Refusal {
    Refusal::CannotRead(format!(
        "Could not read {}: {}",
        attach::attachment(path, "").short(),
        e.message
    ))
}

/// Reads all of `path` (at most `size` bytes: what `stat` said).
fn read_all(fs: &dyn Files, path: &str, size: u64) -> Result<Vec<u8>, Refusal> {
    let chunk = fs
        .read(path, 0, usize::try_from(size).unwrap_or(usize::MAX))
        .map_err(|e| refuse(path, &e))?;
    Ok(chunk.data)
}

/// The type a text file is embedded with. Agents show it as the label of the context block.
fn text_mime(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("md" | "markdown") => "text/markdown",
        Some("json") => "application/json",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("csv") => "text/csv",
        Some("xml") => "application/xml",
        Some("yaml" | "yml") => "application/yaml",
        _ => "text/plain",
    }
}

/// `files` (absolute paths on the agent's machine: files and folders) and `pasted` (pictures of this computer) as
/// the attachments of one message in a session whose folder is `cwd`. `local` says the agent's machine is this
/// computer. A picture file gets the number after the highest of `pasted`, so `[Image #n]` in the text stays true.
///
/// # Errors
/// [`Refusal::CannotRead`] for a file that cannot be read, [`Refusal::Invalid`] for a pasted picture an agent on
/// another machine cannot be given, or for more picture bytes than one message may carry.
pub fn build(
    fs: &dyn Files,
    local: bool,
    cwd: &str,
    files: &[String],
    pasted: &[Pasted],
    caps: Caps,
) -> Result<Outgoing, Refusal> {
    let mut out = Vec::with_capacity(files.len() + pasted.len());
    let mut carried: u64 = 0;

    let mut ordered: Vec<&Pasted> = pasted.iter().collect();
    ordered.sort_by_key(|p| p.number);
    for p in ordered {
        let bytes = std::fs::read(&p.path)
            .map_err(|e| Refusal::CannotRead(format!("Could not read {}: {e}", p.name)))?;
        let mime = if p.path.ends_with(".png") {
            "image/png"
        } else {
            "image/jpeg"
        };
        let mut a = attach::attachment(&p.path, "");
        a.name = p.name.clone();
        a.picture = Some(mime);
        a.size = bytes.len() as u64;
        a.number = p.number;
        a.pasted = true;
        if caps.pictures {
            if a.size > MAX_PICTURE_BYTES {
                return Err(Refusal::Invalid(format!(
                    "{} is over {} MB",
                    p.name,
                    MAX_PICTURE_BYTES >> 20
                )));
            }
            carried += a.size;
            if carried > MAX_PICTURES_TOTAL {
                return Err(Refusal::Invalid(format!(
                    "These pictures are more than the {} MB one message carries. Remove some.",
                    MAX_PICTURES_TOTAL >> 20
                )));
            }
            a.data = Some(attach::base64(&bytes));
        } else if local {
            // The agent is on this computer: it opens the file the link names.
            a.link = true;
        } else {
            return Err(Refusal::Invalid(
                "This agent cannot see pictures, and it runs on another machine that cannot open this one. \
                 Save the picture to the project and mention it, or remove it."
                    .to_owned(),
            ));
        }
        out.push(a);
    }

    let mut next = pasted.iter().map(|p| p.number).max().unwrap_or(0);
    for path in files {
        let stat = fs.stat(path).map_err(|e| refuse(path, &e))?;
        let mut a = attach::attachment(path, cwd);
        a.size = stat.size;
        match stat.kind {
            EntryKind::Dir => {
                if !a.name.ends_with('/') {
                    a.name.push('/');
                }
                a.picture = None;
            }
            _ if a.picture.is_some() => {
                if caps.pictures
                    && stat.size <= MAX_PICTURE_BYTES
                    && carried + stat.size <= MAX_PICTURES_TOTAL
                {
                    let bytes = read_all(fs, path, stat.size)?;
                    carried += bytes.len() as u64;
                    a.data = Some(attach::base64(&bytes));
                } else {
                    a.link = true;
                }
                next += 1;
                a.number = next;
            }
            _ if caps.embedded && stat.size <= EMBED_MAX => {
                let bytes = read_all(fs, path, stat.size)?;
                // A binary file is a link: embedding bytes as "text" would be noise in the prompt.
                if let Ok(text) = String::from_utf8(bytes)
                    && !text.contains('\0')
                {
                    a.text = Some(text);
                    a.text_mime = Some(text_mime(path));
                }
            }
            _ => {}
        }
        out.push(a);
    }
    Ok(Outgoing { files: out })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::LocalFiles;

    fn fs() -> LocalFiles {
        LocalFiles::new()
    }

    fn write(dir: &std::path::Path, name: &str, bytes: &[u8]) -> String {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().expect("parent")).expect("dirs");
        std::fs::write(&p, bytes).expect("write");
        p.display().to_string()
    }

    const BOTH: Caps = Caps {
        pictures: true,
        embedded: true,
    };

    #[test]
    fn a_small_text_file_is_embedded_when_the_agent_takes_it_and_linked_otherwise() {
        let dir = tempfile::tempdir().expect("dir");
        let cwd = dir.path().display().to_string();
        let notes = write(dir.path(), "src/notes.md", b"# notes\n");
        let with =
            build(&fs(), true, &cwd, std::slice::from_ref(&notes), &[], BOTH).expect("built");
        assert_eq!(with.files[0].text.as_deref(), Some("# notes\n"));
        assert_eq!(with.files[0].name, "src/notes.md");
        let without = build(
            &fs(),
            true,
            &cwd,
            &[notes],
            &[],
            Caps {
                embedded: false,
                ..BOTH
            },
        )
        .expect("built");
        assert_eq!(without.files[0].text, None);
    }

    #[test]
    fn a_big_file_a_binary_file_and_a_folder_are_links() {
        let dir = tempfile::tempdir().expect("dir");
        let cwd = dir.path().display().to_string();
        let big = write(dir.path(), "big.txt", &vec![b'a'; (EMBED_MAX + 1) as usize]);
        let bin = write(dir.path(), "blob.dat", b"ab\0cd");
        let folder = dir.path().join("src");
        std::fs::create_dir(&folder).expect("dir");
        let out = build(
            &fs(),
            true,
            &cwd,
            &[big, bin, folder.display().to_string()],
            &[],
            BOTH,
        )
        .expect("built");
        assert!(
            out.files
                .iter()
                .all(|f| f.text.is_none() && f.data.is_none())
        );
        assert_eq!(out.files[2].name, "src/", "a folder says it is one");
    }

    #[test]
    fn a_picture_file_travels_with_its_bytes_and_a_number_after_the_pasted_ones() {
        let dir = tempfile::tempdir().expect("dir");
        let cwd = dir.path().display().to_string();
        let shot = write(dir.path(), "shot.png", b"png bytes");
        let pasted = write(dir.path(), "tmp/aa.png", b"pasted bytes");
        let out = build(
            &fs(),
            true,
            &cwd,
            &[shot],
            &[Pasted {
                path: pasted,
                name: "pasted.png".into(),
                number: 2,
            }],
            BOTH,
        )
        .expect("built");
        assert_eq!(out.len(), 2);
        assert_eq!(out.files[0].number, 2, "pasted pictures first, by number");
        assert_eq!(
            out.files[0].data.as_deref(),
            Some(attach::base64(b"pasted bytes").as_str())
        );
        assert_eq!(out.files[1].number, 3);
        assert!(out.files[1].data.is_some());
    }

    #[test]
    fn an_agent_that_cannot_see_gets_a_link_here_and_a_refusal_for_a_remote_machine() {
        let dir = tempfile::tempdir().expect("dir");
        let cwd = dir.path().display().to_string();
        let pasted = write(dir.path(), "tmp/aa.png", b"pasted bytes");
        let blind = Caps {
            pictures: false,
            embedded: true,
        };
        let one = [Pasted {
            path: pasted,
            name: "pasted.png".into(),
            number: 1,
        }];
        let local = build(&fs(), true, &cwd, &[], &one, blind).expect("a link");
        assert!(local.files[0].link && local.files[0].data.is_none());
        let remote = build(&fs(), false, &cwd, &[], &one, blind);
        let Err(Refusal::Invalid(why)) = remote else {
            panic!("a remote machine cannot open this computer's file");
        };
        assert!(why.contains("cannot see pictures"), "{why}");
    }

    #[test]
    fn pictures_past_the_total_a_message_carries_are_refused_and_picture_files_become_links() {
        let dir = tempfile::tempdir().expect("dir");
        let cwd = dir.path().display().to_string();
        let big = vec![0_u8; (MAX_PICTURE_BYTES - 1) as usize];
        let pasted: Vec<Pasted> = (1..=5)
            .map(|n| Pasted {
                path: write(dir.path(), &format!("tmp/{n}.png"), &big),
                name: format!("p{n}.png"),
                number: n,
            })
            .collect();
        let Err(Refusal::Invalid(why)) = build(&fs(), true, &cwd, &[], &pasted, BOTH) else {
            panic!("five 5 MB pictures are more than 20 MB");
        };
        assert!(why.contains("20 MB"), "{why}");
        // Picture FILES degrade instead: the agent can open them itself.
        let files: Vec<String> = (1..=5)
            .map(|n| write(dir.path(), &format!("f{n}.png"), &big))
            .collect();
        let out = build(&fs(), true, &cwd, &files, &[], BOTH).expect("built");
        assert_eq!(out.files.iter().filter(|f| f.data.is_some()).count(), 4);
        assert!(out.files[4].link);
    }

    #[test]
    fn a_missing_file_says_which() {
        let dir = tempfile::tempdir().expect("dir");
        let gone = dir.path().join("gone.rs").display().to_string();
        let Err(Refusal::CannotRead(why)) = build(&fs(), true, "/", &[gone], &[], BOTH) else {
            panic!("a deleted file cannot be sent");
        };
        assert!(why.contains("gone.rs"), "{why}");
    }
}
