//! The skills an agent in a pane can run, read from the folders the agent reads them from on the pane's machine:
//! its log never lists them (omp's) or lists them only once a prompt was sent (Claude Code's `skill_listing`), so
//! the chat's `/` list would lack them.
//!
//! Where each agent looks, from its own source:
//! - omp (`discovery/builtin.ts`, `claude.ts`, `agents.ts`, `codex.ts`): `.omp/skills` in the folder and its
//!   parents, then `~/.omp/agent/skills` (both need a `description`), then `.claude/skills`, `.agents/skills`,
//!   `.agent/skills` and `.codex/skills` the same way, each also under the home folder. A skill is typed
//!   `/skill:<name>` (`getSkillSlashCommandName`). Its plugin skills (`~/.claude/plugins/cache`, omp plugins) are not
//!   read here.
//! - Claude Code: `.claude/skills` in the folder and its parents, then `~/.claude/skills`; typed `/<name>`.
//!
//! The walk up stops at the folder that holds `.git` (the repository's root) and never treats the home folder as a
//! project. A skill is `<dir>/<name>/SKILL.md`; its frontmatter's `name` (else the folder's name), `description` and
//! `argument-hint` say what the list shows. The first skill of a name wins, in the order above.
//!
//! Every read goes through [`Files`] (this computer, or another over its ssh connection) and blocks: call
//! [`SkillScan::scan`] off the UI thread. A scan lists the folders again and reads only the `SKILL.md` files it has
//! not read (or whose folder changed), so a refresh costs a few listings.

use std::collections::{HashMap, HashSet};

use super::model::{CommandKind, SlashCommand, cut_text};
use crate::files::{EntryKind, FileError, FileErrorKind, Files};

/// How many parent folders the walk up looks into at most.
const MAX_LEVELS: usize = 12;
/// The most skills listed.
const MAX_SKILLS: usize = 300;
/// How much of a `SKILL.md` is read: the frontmatter is at its top.
const HEAD_BYTES: usize = 8 * 1024;
/// The longest description kept, in characters (as Claude's own listing is cut).
const DESCRIPTION_CHARS: usize = 140;

/// Which agent's folders and form of name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// omp: `/skill:<name>`.
    Omp,
    /// Claude Code: `/<name>`.
    Claude,
}

impl Layout {
    /// The layout of the agent whose herdr label is `kind` (`omp`, `claude`); `None` for an agent whose skills are
    /// not read from its folders.
    pub fn of(kind: &str) -> Option<Self> {
        match kind {
            "omp" => Some(Self::Omp),
            "claude" => Some(Self::Claude),
            _ => None,
        }
    }

    /// Where skills are, in the order their names win: the folder under a project folder, the one under the home
    /// folder, and whether a skill there needs a description.
    fn sources(self) -> &'static [(&'static str, &'static str, bool)] {
        match self {
            Self::Omp => &[
                (".omp/skills", ".omp/agent/skills", true),
                (".claude/skills", ".claude/skills", false),
                (".agents/skills", ".agents/skills", false),
                (".agent/skills", ".agent/skills", false),
                (".codex/skills", ".codex/skills", false),
            ],
            Self::Claude => &[(".claude/skills", ".claude/skills", false)],
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::Omp => "skill:",
            Self::Claude => "",
        }
    }
}

/// What one `SKILL.md` says, by the folder's time when it was read.
#[derive(Debug, Clone)]
struct Read {
    modified: Option<i64>,
    skill: Option<Skill>,
}

#[derive(Debug, Clone)]
struct Skill {
    name: String,
    description: String,
    hint: Option<String>,
}

/// The skills of one agent's panes, with what was read kept between scans.
#[derive(Debug)]
pub struct SkillScan {
    layout: Layout,
    /// By `SKILL.md` path.
    read: HashMap<String, Read>,
}

impl SkillScan {
    pub fn new(layout: Layout) -> Self {
        Self {
            layout,
            read: HashMap::new(),
        }
    }

    /// The skills an agent working in `cwd` can run, as the `/` list offers them. Errs only when the machine could
    /// not be asked (a dropped connection): a folder that is not there is no skills.
    pub fn scan(&mut self, files: &dyn Files, cwd: &str) -> Result<Vec<SlashCommand>, FileError> {
        let home = files.list("~")?.path.trim_end_matches('/').to_owned();
        let projects = project_dirs(files, cwd, &home)?;
        let mut seen_paths: HashSet<String> = HashSet::new();
        let mut names: HashSet<String> = HashSet::new();
        let mut out = Vec::new();
        for &(in_project, in_home, needs_description) in self.layout.sources() {
            let first = in_project.split('/').next().unwrap_or(in_project);
            let dirs = projects
                .iter()
                .filter(|(_, has)| has.contains(first))
                .map(|(dir, _)| format!("{dir}/{in_project}"))
                .chain(std::iter::once(format!("{home}/{in_home}")));
            for dir in dirs {
                for skill in self.skills_in(files, &dir, &mut seen_paths)? {
                    if out.len() >= MAX_SKILLS {
                        break;
                    }
                    if needs_description && skill.description.is_empty() {
                        continue;
                    }
                    let name = format!("{}{}", self.layout.prefix(), skill.name);
                    if names.insert(name.clone()) {
                        out.push(SlashCommand {
                            name,
                            description: skill.description,
                            hint: skill.hint,
                            kind: CommandKind::Skill,
                        });
                    }
                }
            }
        }
        self.read.retain(|path, _| seen_paths.contains(path));
        Ok(out)
    }

    /// The skills of one skills folder, in its listing's order.
    fn skills_in(
        &mut self,
        files: &dyn Files,
        dir: &str,
        seen: &mut HashSet<String>,
    ) -> Result<Vec<Skill>, FileError> {
        let listing = match files.list(dir) {
            Ok(l) => l,
            Err(e) if absent(&e) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut out = Vec::new();
        for entry in listing.entries {
            if entry.kind != EntryKind::Dir || entry.name.starts_with('.') {
                continue;
            }
            let path = format!("{dir}/{}/SKILL.md", entry.name);
            seen.insert(path.clone());
            let fresh = self
                .read
                .get(&path)
                .is_some_and(|r| r.modified.is_some() && r.modified == entry.modified);
            if !fresh {
                let skill = match files.read(&path, 0, HEAD_BYTES) {
                    Ok(chunk) => parse_skill(&String::from_utf8_lossy(&chunk.data), &entry.name),
                    Err(e) if absent(&e) => None,
                    Err(e) => return Err(e),
                };
                self.read.insert(
                    path.clone(),
                    Read {
                        modified: entry.modified,
                        skill,
                    },
                );
            }
            if let Some(skill) = self.read.get(&path).and_then(|r| r.skill.clone()) {
                out.push(skill);
            }
        }
        Ok(out)
    }
}

fn absent(e: &FileError) -> bool {
    matches!(
        e.kind,
        FileErrorKind::NotFound
            | FileErrorKind::Denied
            | FileErrorKind::NotADirectory
            | FileErrorKind::IsADirectory
    )
}

/// `cwd` and its parents up to the repository's root (the folder holding `.git`), never the home folder or `/`,
/// each with the names it holds.
fn project_dirs(
    files: &dyn Files,
    cwd: &str,
    home: &str,
) -> Result<Vec<(String, HashSet<String>)>, FileError> {
    let mut out = Vec::new();
    let mut dir = cwd.trim_end_matches('/').to_owned();
    for _ in 0..MAX_LEVELS {
        if dir.is_empty() || dir == home || !dir.starts_with('/') {
            break;
        }
        let names: HashSet<String> = match files.list(&dir) {
            Ok(l) => l.entries.into_iter().map(|e| e.name).collect(),
            Err(e) if absent(&e) => break,
            Err(e) => return Err(e),
        };
        let root = names.contains(".git");
        out.push((dir.clone(), names));
        if root {
            break;
        }
        match dir.rfind('/') {
            Some(at) => dir.truncate(at),
            None => break,
        }
    }
    Ok(out)
}

/// A skill's name, description and argument hint from the frontmatter of its `SKILL.md`; the folder's name when
/// the frontmatter has none. `None` for a name that could not be typed.
fn parse_skill(text: &str, folder: &str) -> Option<Skill> {
    let front = front_matter(text);
    let field = |key: &str| {
        front
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    };
    let name = field("name").unwrap_or(folder).trim().to_owned();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_whitespace) {
        return None;
    }
    Some(Skill {
        name,
        description: cut_text(field("description").unwrap_or(""), DESCRIPTION_CHARS),
        hint: field("argument-hint").map(str::to_owned),
    })
}

/// The top-level `key: value` pairs of the YAML frontmatter that opens `text`, each value on one line with its
/// white space folded: a folded or literal block (`>`, `|`) and a plain value continued on indented lines are
/// joined, quotes are removed. Nested keys and lists are not read.
fn front_matter(text: &str) -> Vec<(String, String)> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Vec::new();
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for line in lines {
        if line.trim_end() == "---" {
            break;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented {
            if let Some((_, value)) = out.last_mut() {
                if !value.is_empty() {
                    value.push(' ');
                }
                value.push_str(line.trim());
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let value = if matches!(value, ">" | "|" | ">-" | "|-" | ">+" | "|+") {
            ""
        } else {
            unquote(value)
        };
        out.push((key.trim().to_owned(), value.to_owned()));
    }
    for (_, value) in &mut out {
        *value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    out
}

fn unquote(value: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(q).and_then(|v| v.strip_suffix(q)) {
            return inner;
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_skill_is_named_by_its_frontmatter_else_its_folder_and_long_values_are_joined() {
        let s = parse_skill(
            "---\nname: herdr-design\ndescription: >\n  Design the window\n  from the supervisor's side.\nargument-hint: \"[screen]\"\n---\n# Body",
            "folder",
        )
        .expect("skill");
        assert_eq!(s.name, "herdr-design");
        assert_eq!(
            s.description,
            "Design the window from the supervisor's side."
        );
        assert_eq!(s.hint.as_deref(), Some("[screen]"));

        let bare = parse_skill("# no frontmatter", "tdd").expect("skill");
        assert_eq!((bare.name.as_str(), bare.description.as_str()), ("tdd", ""));

        let plain = parse_skill(
            "---\ndescription: 'Quoted: with a colon'\n  and more\n---\n",
            "x",
        )
        .expect("skill");
        assert_eq!(plain.description, "Quoted: with a colon and more");
    }

    #[test]
    fn a_name_that_cannot_be_typed_is_no_skill_and_a_long_description_is_cut() {
        assert!(parse_skill("---\nname: two words\n---\n", "x").is_none());
        let long = format!("---\ndescription: {}\n---\n", "word ".repeat(100));
        let s = parse_skill(&long, "x").expect("skill");
        assert!(s.description.chars().count() <= DESCRIPTION_CHARS);
    }
}
