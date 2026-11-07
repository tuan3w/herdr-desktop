//! Tappable URLs and file paths in one row of terminal text.
//!
//! A port of herdr-mobile's `terminal_links.dart`, rule for rule: a hand-written scanner rather
//! than one big regular expression, because it runs for every visible row on every repaint and a
//! regex with this many alternations is slow to build and open to catastrophic backtracking on
//! hostile output. It makes a single forward pass, tries a candidate only where one may start and
//! never re-reads characters it has already classified.
//!
//! A path is linked only when it looks like a FILE: it ends in `name.ext` (or is a well-known
//! extension-less name such as `Makefile`, `/etc/hosts`, `.gitignore`), with an optional
//! `:line[:col]`, `(line,col)` or `#L12`. Folders, slash commands (`/model`), `and/or`, dates,
//! versions and web addresses without a scheme stay plain text: a missed link costs a copy and
//! paste, a wrong one is an underline in the way of every dense listing.
//!
//! Differences from the Dart original, all deliberate: the scan limit counts UTF-16 units as
//! there but indexes are `char`s, and `\p{M}` (marks) is approximated by "zero display width"
//! because the standard library has no general-category lookup.

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// What a [`Link`] opens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    /// An `http://` or `https://` address.
    Url,
    /// A file path on the machine the pane runs on.
    Path,
}

/// A stretch of one row that can be opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// What it opens.
    pub kind: LinkKind,
    /// Exactly as displayed, e.g. `src/main.rs:42:7` or `https://x.dev/a`.
    pub text: String,
    /// The URL, or the path without its `:line:col` / `(line,col)` / `#L12` suffix and, in a git
    /// diff header, without git's `a/` or `b/`.
    pub target: String,
    /// One-based line the text points at, when it gave one.
    pub line: Option<u32>,
    /// One-based column, when it gave one.
    pub col: Option<u32>,
    /// Zero-based index of the row (0 for [`detect_links`] on a lone line).
    pub row: usize,
    /// First display column of `text`: wide characters before it count two, combining marks none.
    pub start_col: u16,
    /// Display column just past `text`.
    pub end_col: u16,
}

/// How many UTF-16 units of a row are scanned. Terminal output can hold multi-megabyte lines
/// (minified bundles, base64 blobs); a link is only useful on a screen-sized line, so anything
/// past this is ignored instead of paying for it on every repaint.
const MAX_SCAN_UNITS: usize = 2000;

/// Line and column numbers longer than this are not positions (timestamps, sizes).
const MAX_POSITION_DIGITS: usize = 7;

/// Longest extension a relative path may end in.
const MAX_EXTENSION_LENGTH: usize = 8;

/// Longest entry of the known-extension list; lets longer extensions skip the lookup.
const MAX_KNOWN_EXTENSION: usize = 12;

/// Longest entry of the known-name lists; lets longer names skip the lookups.
const MAX_KNOWN_LENGTH: usize = 16;

/// Links in one line of visible text (ANSI already stripped), sorted by start and never
/// overlapping. Only the first 2000 UTF-16 units are examined. `row` of every link is 0.
pub fn detect_links(text: &str) -> Vec<Link> {
    detect_row(text, 0)
}

/// [`detect_links`] for row `row` of a screen.
pub(super) fn detect_row(text: &str, row: usize) -> Vec<Link> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut units = 0;
    let mut cut = text.len();
    for (at, c) in text.char_indices() {
        units += c.len_utf16();
        if units > MAX_SCAN_UNITS {
            cut = at;
            break;
        }
    }
    let text = &text[..cut];
    let chars: Vec<char> = text.chars().collect();
    Scanner {
        text,
        s: &chars,
        row,
        links: Vec::new(),
        token_start: 0,
        columns: None,
    }
    .scan()
}

/// Whether `path` is a slash command (`/model`, `/compact`, `/resume`): one segment after the
/// leading slash and no dot. Never a file path, wherever it comes from.
pub fn looks_like_slash_command(path: &str) -> bool {
    let mut chars = path.chars();
    if chars.next() != Some('/') {
        return false;
    }
    let rest = chars.as_str();
    !rest.is_empty() && !rest.contains(['/', '.'])
}

fn is_ascii_digit(c: char) -> bool {
    c.is_ascii_digit()
}

fn is_ascii_letter(c: char) -> bool {
    c.is_ascii_alphabetic()
}

fn is_ascii_alnum(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// Letters, digits and marks of any script. Marks belong to a word because decomposed Vietnamese
/// text carries its diacritics as separate code points.
fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || (c.width() == Some(0) && !c.is_control())
}

/// Whitespace, control characters and the box/block glyphs the terminal view draws itself: they
/// end words.
fn is_separator(c: char) -> bool {
    let u = c as u32;
    if u < 0x80 {
        return u <= 0x20 || u == 0x7f;
    }
    matches!(u, 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0x2500..=0x259f)
}

/// Characters that may directly precede a path: anything else means the path would be glued to a
/// longer word (`x-foo/bar.txt`, `a.b.c.dart`). `*` and `|` are the markdown emphasis and table
/// marks around paths, `>` follows arrows and redirects (`2>/tmp/err.log`).
fn is_path_boundary(c: char) -> bool {
    is_separator(c)
        || matches!(
            c,
            '(' | '[' | '{' | '<' | '>' | '"' | '\'' | '`' | '=' | ',' | ';' | ':' | '*' | '|'
        )
}

/// Characters a URL never contains: whitespace, box glyphs and the delimiters that wrap URLs in
/// prose, markdown autolinks and quoted strings.
fn is_url_terminator(c: char) -> bool {
    is_separator(c) || matches!(c, '<' | '>' | '"')
}

/// Extensions that make a bare `name.ext` (no directory) worth linking. Kept closed because any
/// word ending in `.something` would otherwise match (`e.g`, `www.x.com`, `10.0.0.1`). Inside a
/// path with a directory any alphanumeric extension counts.
fn is_known_extension(ext: &str) -> bool {
    matches!(
        ext,
        // Source.
        "dart" | "py" | "pyi" | "pyw" | "js" | "ts" | "tsx" | "jsx" | "mjs" | "cjs" | "mts"
        | "cts" | "vue" | "svelte" | "astro" | "rs" | "go" | "c" | "h" | "cc" | "cpp" | "hpp"
        | "cxx" | "hxx" | "cs" | "java" | "kt" | "kts" | "swift" | "rb" | "php" | "sh" | "bash"
        | "zsh" | "fish" | "ps1" | "bat" | "lua" | "sql" | "r" | "scala" | "ex" | "exs" | "erl"
        | "hs" | "ml" | "clj" | "zig" | "nim" | "jl" | "sol" | "tf" | "tfvars" | "hcl" | "nix"
        | "prisma" | "graphql" | "gql" | "gradle" | "proto" | "cmake" | "make" | "mk"
        | "gemspec" | "patch" | "diff"
        // Text, markup, data, configuration.
        | "md" | "mdx" | "txt" | "rst" | "adoc" | "tex" | "bib" | "log" | "json" | "jsonc"
        | "json5" | "jsonl" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "env" | "lock"
        | "properties" | "plist" | "xml" | "html" | "htm" | "xhtml" | "css" | "scss" | "sass"
        | "less" | "csv" | "tsv" | "parquet" | "srt" | "vtt" | "ejs" | "erb" | "hbs" | "j2"
        | "tmpl" | "service" | "pem" | "crt" | "ipynb" | "dockerfile"
        // Documents, images, media, archives, binaries.
        | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "epub" | "png"
        | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "heic" | "avif" | "tiff"
        | "psd" | "mp3" | "mp4" | "mov" | "wav" | "flac" | "ogg" | "m4a" | "webm" | "mkv"
        | "avi" | "ttf" | "otf" | "woff" | "woff2" | "zip" | "tar" | "gz" | "tgz" | "xz" | "bz2"
        | "zst" | "7z" | "rar" | "jar" | "apk" | "aab" | "ipa" | "dmg" | "deb" | "rpm" | "so"
        | "dll" | "exe" | "db" | "sqlite" | "sqlite3" | "wasm" | "onnx" | "gguf"
        | "safetensors"
    )
}

/// File names that are unmistakably files without any extension (and a few with one), wherever
/// they stand.
fn is_known_name(name: &str) -> bool {
    matches!(
        name,
        "Makefile"
            | "GNUmakefile"
            | "Dockerfile"
            | "Containerfile"
            | "Procfile"
            | "Gemfile"
            | "Rakefile"
            | "Podfile"
            | "Brewfile"
            | "Vagrantfile"
            | "Jenkinsfile"
            | "Justfile"
            | "Caddyfile"
            | "Fastfile"
            | "Pipfile"
            | "LICENSE"
            | "LICENCE"
            | "README"
            | "CHANGELOG"
            | "CONTRIBUTING"
            | "CODEOWNERS"
            | "COPYING"
            | "go.mod"
            | "go.sum"
    )
}

/// Dot files that are files, not folders (`~/.config` is a folder).
fn is_known_dotfile(name: &str) -> bool {
    matches!(
        name,
        ".gitignore"
            | ".gitattributes"
            | ".gitmodules"
            | ".gitkeep"
            | ".mailmap"
            | ".dockerignore"
            | ".npmignore"
            | ".npmrc"
            | ".nvmrc"
            | ".yarnrc"
            | ".editorconfig"
            | ".eslintrc"
            | ".eslintignore"
            | ".prettierrc"
            | ".prettierignore"
            | ".babelrc"
            | ".flake8"
            | ".pylintrc"
            | ".python-version"
            | ".tool-versions"
            | ".ruby-version"
            | ".node-version"
            | ".htaccess"
            | ".clang-format"
            | ".clang-tidy"
            | ".env"
            | ".env.local"
            | ".env.example"
            | ".env.development"
            | ".env.production"
            | ".env.test"
            | ".bashrc"
            | ".bash_profile"
            | ".bash_history"
            | ".zshrc"
            | ".zprofile"
            | ".zsh_history"
            | ".profile"
            | ".vimrc"
            | ".inputrc"
            | ".gitconfig"
    )
}

/// System files without an extension that only count with a directory in front (`/etc/hosts`):
/// the bare word `hosts` is prose.
fn is_known_dir_name(name: &str) -> bool {
    matches!(
        name,
        "hosts"
            | "passwd"
            | "group"
            | "fstab"
            | "shadow"
            | "hostname"
            | "crontab"
            | "sudoers"
            | "authorized_keys"
            | "known_hosts"
            | "id_rsa"
            | "id_ed25519"
            | "cpuinfo"
            | "meminfo"
            | "syslog"
    )
}

/// Top-level domains of web addresses typed without a scheme (`github.com/a/b.go`): not files on
/// this machine. Only those that are not also a file extension.
fn is_domain_suffix(suffix: &str) -> bool {
    matches!(
        suffix,
        "com"
            | "org"
            | "net"
            | "io"
            | "dev"
            | "app"
            | "ai"
            | "edu"
            | "gov"
            | "co"
            | "info"
            | "xyz"
            | "me"
            | "us"
            | "uk"
            | "de"
            | "fr"
            | "jp"
            | "cn"
            | "ru"
            | "tech"
            | "cloud"
            | "site"
            | "online"
    )
}

/// A parsed `:12:5`-style position and the index just past it.
struct Position {
    line: u32,
    column: Option<u32>,
    end: usize,
}

/// One pass over one row; owns the results.
struct Scanner<'a> {
    text: &'a str,
    s: &'a [char],
    row: usize,
    links: Vec<Link>,
    /// Start of the whitespace-delimited token being scanned; bounds the look-behind for
    /// `user@host:` prefixes.
    token_start: usize,
    /// Display column of every char boundary, built when the first link is found.
    columns: Option<Vec<u16>>,
}

impl Scanner<'_> {
    fn n(&self) -> usize {
        self.s.len()
    }

    fn scan(mut self) -> Vec<Link> {
        let n = self.n();
        let mut i = 0;
        while i < n {
            let c = self.s[i];
            if is_separator(c) {
                i += 1;
                self.token_start = i;
                continue;
            }
            let mut next = None;
            if (c as u32 | 0x20) == 0x68 {
                next = self.try_url(i);
            }
            i = match next {
                Some(next) => next,
                None if i == 0 => self.try_path(i),
                // `</div>`: a slash right after `<` closes a tag, it does not start an absolute
                // path. `<~/a>` and `<src/a>` are still paths.
                None if self.boundary_before(i) && !(c == '/' && self.s[i - 1] == '<') => {
                    self.try_path(i)
                }
                None => i + 1,
            };
        }
        self.links
    }

    // -- columns --------------------------------------------------------------------------

    /// Display column at char index `at`. A boundary inside a grapheme cluster reads as the end
    /// of that cluster, so a link never starts or ends between a base character and its mark.
    fn column_at(&mut self, at: usize) -> u16 {
        if self.columns.is_none() {
            let mut columns = Vec::with_capacity(self.n() + 1);
            let mut column = 0usize;
            columns.push(0);
            for cluster in self.text.graphemes(true) {
                let chars = cluster.chars().count();
                column += cluster.width();
                let shown = u16::try_from(column).unwrap_or(u16::MAX);
                columns.extend(std::iter::repeat_n(shown, chars));
            }
            self.columns = Some(columns);
        }
        self.columns.as_ref().map_or(0, |columns| columns[at])
    }

    fn slice(&self, from: usize, to: usize) -> String {
        self.s[from..to].iter().collect()
    }

    fn emit(
        &mut self,
        kind: LinkKind,
        start: usize,
        target_end: usize,
        text_end: usize,
        extra: Extra,
    ) {
        let target_start = extra.target_start.unwrap_or(start);
        let link = Link {
            kind,
            text: self.slice(start, text_end),
            target: self.slice(target_start, target_end),
            line: extra.line,
            col: extra.column,
            row: self.row,
            start_col: self.column_at(start),
            end_col: self.column_at(text_end),
        };
        self.links.push(link);
    }

    /// Whether a path may start at `i` (> 0): the character before it ends a word. A non-ASCII
    /// character counts when it is not a letter, digit or mark (`→ a/b.dart`, `“a/b.dart”`),
    /// except `…`: what follows an ellipsis is the tail of a longer path, and linking the tail
    /// would open the wrong file. Stars end a word only as markdown emphasis (`**a.dart**`):
    /// after a word they are a glob (`foo*/bar.md`), and what follows is its tail.
    fn boundary_before(&self, i: usize) -> bool {
        let c = self.s[i - 1];
        if c.is_ascii() {
            if c != '*' {
                return is_path_boundary(c);
            }
            let mut j = i - 1;
            while i - j <= 4 && self.s[j] == '*' {
                if j == 0 {
                    return true;
                }
                j -= 1;
            }
            return self.s[j] != '*' && self.boundary_before(j + 1);
        }
        if is_separator(c) {
            return true;
        }
        if c == '\u{2026}' {
            return false;
        }
        !is_word_char(c)
    }

    // -- URLs -----------------------------------------------------------------------------

    /// Parses a URL starting at `i`; returns the index to resume scanning at, or `None` if
    /// there is no URL here.
    fn try_url(&mut self, i: usize) -> Option<usize> {
        let n = self.n();
        // `http` must not be the tail of a longer word.
        if i > 0 && is_ascii_alnum(self.s[i - 1]) {
            return None;
        }
        let mut p = i + 4;
        if p + 3 > n || !self.matches_http(i) {
            return None;
        }
        if self.s[p].eq_ignore_ascii_case(&'s') {
            p += 1;
        }
        if p + 3 > n || self.s[p] != ':' || self.s[p + 1] != '/' || self.s[p + 2] != '/' {
            return None;
        }
        let host_start = p + 3;
        if host_start >= n {
            return None;
        }
        let first = self.s[host_start];
        if !(is_ascii_alnum(first) || first == '[' || !first.is_ascii()) || is_url_terminator(first)
        {
            return None;
        }

        let mut run_end = host_start;
        // Opens minus closes so far.
        let (mut parens, mut brackets, mut braces) = (0i64, 0i64, 0i64);
        while run_end < n {
            let c = self.s[run_end];
            if is_url_terminator(c) {
                break;
            }
            match c {
                '(' => parens += 1,
                ')' => parens -= 1,
                '[' => brackets += 1,
                ']' => brackets -= 1,
                '{' => braces += 1,
                '}' => braces -= 1,
                _ => {}
            }
            run_end += 1;
        }

        // Trailing punctuation belongs to the sentence around the URL. A closing bracket stays
        // only while it pairs with an earlier opening one; the counters above make that O(1) per
        // trimmed character. `<`, `>` and `"` never get here: they already ended the run.
        let mut end = run_end;
        'trim: while end > host_start {
            match self.s[end - 1] {
                ')' => {
                    if parens >= 0 {
                        break 'trim;
                    }
                    parens += 1;
                }
                ']' => {
                    if brackets >= 0 {
                        break 'trim;
                    }
                    brackets += 1;
                }
                '}' => {
                    if braces >= 0 {
                        break 'trim;
                    }
                    braces += 1;
                }
                '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '*' | '_' => {}
                _ => break 'trim,
            }
            end -= 1;
        }
        self.emit(LinkKind::Url, i, end, end, Extra::default());
        Some(run_end)
    }

    /// Whether the four chars at `i` spell `http`, in any case.
    fn matches_http(&self, i: usize) -> bool {
        "http"
            .chars()
            .enumerate()
            .all(|(k, want)| self.s[i + k].eq_ignore_ascii_case(&want))
    }

    // -- paths ----------------------------------------------------------------------------

    /// Whether the char at `k` may be part of a path. `*`, `?`, `[`, `=`, `#` and `:` are
    /// deliberately absent so a path stops before globs, query strings, fragments and `:line`.
    fn is_path_char(&self, k: usize) -> bool {
        let c = self.s[k];
        if c.is_ascii() {
            return is_ascii_alnum(c) || matches!(c, '_' | '-' | '.' | '+' | '@' | '~' | '%' | '/');
        }
        is_word_char(c)
    }

    /// Tries a path at `i` (already at a legal boundary); returns the index to resume scanning
    /// at, always greater than `i`.
    fn try_path(&mut self, i: usize) -> usize {
        let n = self.n();
        let mut run_end = i;
        while run_end < n && self.is_path_char(run_end) {
            run_end += 1;
        }
        if run_end == i {
            return i + 1;
        }
        // Whatever happens, no other path can start before the run ends: its first character
        // would have to follow a boundary, and boundaries are not path characters.
        if run_end < n && self.continues_as_glob_or_query(run_end) {
            return run_end;
        }

        let mut end = run_end;
        while end > i && self.s[end - 1] == '.' {
            end -= 1;
        }
        if end == i
            || !self.is_path(i, end)
            || self.is_scp_remote_path(i)
            || self.is_foreign_path(i)
            || self.is_include_operand(i, end)
        {
            return run_end;
        }

        let mut extra = Extra {
            target_start: Some(i + self.git_prefix_length(i, end)),
            ..Extra::default()
        };
        let mut text_end = end;
        if end == run_end {
            if let Some(position) = self.position_suffix(end) {
                extra.line = Some(position.line);
                extra.column = position.column;
                text_end = position.end;
            } else if self.is_call(i, end) {
                return run_end;
            } else {
                extra.line = self.named_line(end);
            }
        }
        self.emit(LinkKind::Path, i, end, text_end, extra);
        text_end
    }

    /// Whether the char right after a path run shows the token is a glob (`[`, or `*` with path
    /// characters after it) or carries a query string (`?x`): such text is a pattern, not a
    /// file. A star with nothing after it is markdown emphasis (`**lib/a.dart**`).
    fn continues_as_glob_or_query(&self, k: usize) -> bool {
        let n = self.n();
        match self.s[k] {
            '*' => {
                let mut j = k + 1;
                while j < n && self.s[j] == '*' {
                    j += 1;
                }
                j < n && self.is_path_char(j)
            }
            '[' => true,
            '?' => k + 1 < n && self.is_path_char(k + 1),
            _ => false,
        }
    }

    /// Whether a path at `i` is the remote half of `user@host:/path`, which belongs to scp/rsync
    /// rather than the local file system.
    fn is_scp_remote_path(&self, i: usize) -> bool {
        if i == 0 || self.s[i - 1] != ':' {
            return false;
        }
        (self.token_start..i.saturating_sub(1)).any(|k| self.s[k] == '@')
    }

    /// Whether the path at `i` follows `C:` (a Windows drive) or `package:` (a Dart package
    /// uri): neither names a file under the machine's folders.
    fn is_foreign_path(&self, i: usize) -> bool {
        if i < 2 || self.s[i - 1] != ':' {
            return false;
        }
        let before = self.s[i - 2];
        if is_ascii_letter(before) && (i == 2 || !is_ascii_alnum(self.s[i - 3])) {
            return true;
        }
        i >= 8 && self.starts_with(i - 8, "package") && (i == 8 || !is_ascii_alnum(self.s[i - 9]))
    }

    /// Whether `s[i..end]` is the header named by `#include <x.h>`: a system header, not a file
    /// in the folder.
    fn is_include_operand(&self, i: usize, end: usize) -> bool {
        if i == 0 || self.s[i - 1] != '<' || end >= self.n() || self.s[end] != '>' {
            return false;
        }
        let k = self.s[..i].iter().take_while(|&&c| c <= ' ').count();
        self.starts_with(k, "#include") || self.starts_with(k, "#import")
    }

    /// Whether the name at `s[i..end]` is a call (`console.log("x")`, `res.json()`): a bare name
    /// followed directly by `(` is code, not a file.
    fn is_call(&self, i: usize, end: usize) -> bool {
        end < self.n() && self.s[end] == '(' && !self.s[i..end].contains(&'/')
    }

    /// 2 when the path at `i` is the `a/` or `b/` side of a git diff header (`--- a/x`,
    /// `+++ b/x`, `diff --git a/x b/x`): those prefixes are git's, the target is the path
    /// without them. Anywhere else `a/` is a folder.
    fn git_prefix_length(&self, i: usize, end: usize) -> usize {
        if end - i < 3 || self.s[i + 1] != '/' || !matches!(self.s[i], 'a' | 'b') {
            return 0;
        }
        let header = (i == 4 && (self.starts_with(0, "--- ") || self.starts_with(0, "+++ ")))
            || (i >= 11 && self.starts_with(0, "diff --git "));
        if header { 2 } else { 0 }
    }

    fn starts_with(&self, at: usize, pattern: &str) -> bool {
        (at..)
            .zip(pattern.chars())
            .all(|(k, want)| self.s.get(k) == Some(&want))
    }

    /// Whether `s[i..e]` (trailing dots already removed) is worth linking: it must look like a
    /// FILE. A folder, a slash command (`/model`), a bare word with a slash (`and/or`), a date, a
    /// version, a fraction or a web address typed without its scheme is not.
    ///
    /// The last segment decides: a well-known name (`Makefile`, `/etc/hosts`, `.gitignore`) or
    /// `stem.ext` with a stem and a short alphanumeric extension that is not all digits. On its
    /// own (no directory) the extension must also be a known one, so `e.g` and `www.x.com` stay
    /// words. An absolute path with one segment (`/model`, `/compact`) needs a dotted name, which
    /// is what separates a file in `/` from a slash command.
    fn is_path(&self, i: usize, e: usize) -> bool {
        let first = self.s[i];
        if first == '-' {
            return false; // `--flag/x`, `-rw-r--r--`
        }
        // First character after any `/`, `~/`, `./`, `../` prefix.
        let mut body = i;
        let mut absolute = false;
        let mut prefixed = false;
        if first == '/' {
            body = i + 1;
            absolute = true;
        } else if (first == '~' || first == '.') && i + 1 < e && self.s[i + 1] == '/' {
            body = i + 2;
            prefixed = true;
        } else if first == '.' && i + 2 < e && self.s[i + 1] == '.' && self.s[i + 2] == '/' {
            body = i + 3;
            prefixed = true;
        }

        // Walk the segments once: reject empty ones (`a//b`), `...`-style dot runs and folders
        // (a trailing slash), remember where the last slash is and whether any letter or digit
        // exists.
        let mut alnum = false;
        let mut segment_start = body;
        let mut segment_is_dots = true;
        let mut last_slash: Option<usize> = None;
        for k in body..=e {
            let at_end = k == e;
            let c = if at_end { '/' } else { self.s[k] };
            if c == '/' {
                let length = k - segment_start;
                if length == 0 {
                    return false; // `a//b`, `/`, `src/`: empty or folder
                }
                if segment_is_dots && length > 2 {
                    return false;
                }
                if !at_end {
                    last_slash = Some(k);
                }
                segment_start = k + 1;
                segment_is_dots = true;
            } else {
                if c != '.' {
                    segment_is_dots = false;
                }
                if is_ascii_alnum(c) || !c.is_ascii() {
                    alnum = true;
                }
            }
        }
        if !alnum {
            return false;
        }

        let segment = last_slash.map_or(body, |slash| slash + 1);
        let has_dir = absolute || prefixed || last_slash.is_some();
        let lonely_absolute = absolute && last_slash.is_none();

        if e - segment <= MAX_KNOWN_LENGTH {
            let name = self.slice(segment, e);
            if is_known_name(&name) {
                return !lonely_absolute || name.contains('.');
            }
            if is_known_dotfile(&name) {
                return true;
            }
            if has_dir
                && !lonely_absolute
                && (is_known_dir_name(&name) || (name == "config" && self.in_dot_folder(segment)))
            {
                return true;
            }
        }

        let mut dot = e - 1;
        while dot >= segment && self.s[dot] != '.' {
            if dot == 0 {
                return false;
            }
            dot -= 1;
        }
        if dot <= segment {
            return false; // no extension, or an empty stem
        }
        let extension_length = e - dot - 1;
        if extension_length
            > if has_dir {
                MAX_EXTENSION_LENGTH
            } else {
                MAX_KNOWN_EXTENSION
            }
        {
            return false;
        }
        let mut digits = true;
        for k in dot + 1..e {
            let c = self.s[k];
            if !is_ascii_alnum(c) {
                return false;
            }
            if !is_ascii_digit(c) {
                digits = false;
            }
        }
        if digits {
            return false; // `1.2.3`, `a/b.5`: a version or a number
        }
        if !has_dir {
            return self.is_bare_file(segment, dot, e);
        }
        // A date or a fraction has no letter before the extension (`2024/01/5.md`).
        if !self.has_letter(if prefixed { segment } else { body }, dot) {
            return false;
        }
        prefixed || absolute || !self.starts_with_domain(i, e)
    }

    /// Whether the file name `s[i..e]` with its extension starting after `dot` reads as a file
    /// on its own: a known extension (or a known name before it: `Dockerfile.dev`), no `@` (an
    /// address), and a stem that starts like a name. A one-letter extension (`main.c`, `util.h`)
    /// needs a plain stem of two letters or more, so initials and `a.b.c` stay words.
    fn is_bare_file(&self, i: usize, dot: usize, e: usize) -> bool {
        let stem_known = dot - i <= MAX_KNOWN_LENGTH && is_known_name(&self.slice(i, dot));
        if !stem_known && !self.extension_is_known(dot + 1, e) {
            return false;
        }
        if !stem_known && e - dot == 2 {
            if dot - i < 2 {
                return false;
            }
            if self.s[i..dot].contains(&'.') {
                return false;
            }
        }
        if self.s[i..dot].contains(&'@') {
            return false; // an email address
        }
        if stem_known {
            return true;
        }
        let first = self.s[i];
        if is_ascii_letter(first) || !first.is_ascii() {
            return true;
        }
        // `2024-report.pdf`, `__init__.py`, `.eslintrc.json` but not `1.md`.
        (is_ascii_digit(first) || first == '_' || first == '.') && self.has_letter(i, dot)
    }

    /// Whether `s[from..to]` is a known extension, compared without case and without allocating.
    fn extension_is_known(&self, from: usize, to: usize) -> bool {
        if to - from > MAX_KNOWN_EXTENSION {
            return false;
        }
        let mut buffer = [0u8; MAX_KNOWN_EXTENSION];
        for (slot, &c) in buffer.iter_mut().zip(&self.s[from..to]) {
            *slot = c.to_ascii_lowercase() as u8;
        }
        std::str::from_utf8(&buffer[..to - from]).is_ok_and(is_known_extension)
    }

    /// Whether the segment starting at `segment` follows `.ssh/` or `.git/`.
    fn in_dot_folder(&self, segment: usize) -> bool {
        segment >= 5
            && (self.starts_with(segment - 5, ".ssh/") || self.starts_with(segment - 5, ".git/"))
    }

    /// Whether the first segment of the relative path `s[i..e]` is a host name (`github.com`,
    /// `example.com`): such a path is a web address.
    fn starts_with_domain(&self, i: usize, e: usize) -> bool {
        let mut slash = i;
        while slash < e && self.s[slash] != '/' {
            slash += 1;
        }
        let mut dot = slash - 1;
        while dot > i && self.s[dot] != '.' {
            dot -= 1;
        }
        if dot <= i || slash - dot - 1 > 6 {
            return false;
        }
        is_domain_suffix(&self.slice(dot + 1, slash).to_lowercase())
    }

    /// Whether `s[from..to]` contains a letter. Every non-ASCII character in a path run is a
    /// letter, digit or mark; counting them all as letters is close enough to tell `2024-01-05`
    /// from `báo-cáo`.
    fn has_letter(&self, from: usize, to: usize) -> bool {
        self.s[from..to]
            .iter()
            .any(|&c| is_ascii_letter(c) || !c.is_ascii())
    }

    // -- suffixes -------------------------------------------------------------------------

    /// End of the digit run starting at `from`, unless it is 1 to 7 digits long.
    fn position_digits_end(&self, from: usize) -> Option<usize> {
        let mut k = from;
        while k < self.n() && is_ascii_digit(self.s[k]) {
            k += 1;
        }
        (1..=MAX_POSITION_DIGITS).contains(&(k - from)).then_some(k)
    }

    fn number(&self, from: usize, to: usize) -> u32 {
        self.s[from..to]
            .iter()
            .fold(0, |acc, c| acc * 10 + c.to_digit(10).unwrap_or(0))
    }

    /// Parses `:LINE`, `:LINE:COL` (either may carry a `-END` range), `#L12`, `#L12C3`,
    /// `#L12-L20`, `(LINE)`, `(LINE,COL)` or `(LINE, COL)` directly at `at`.
    fn position_suffix(&self, at: usize) -> Option<Position> {
        let n = self.n();
        if at >= n {
            return None;
        }
        match self.s[at] {
            ':' => {
                let line_end = self.position_digits_end(at + 1)?;
                let line = self.number(at + 1, line_end);
                if line_end < n
                    && self.s[line_end] == ':'
                    && let Some(column_end) = self.position_digits_end(line_end + 1)
                {
                    return Some(Position {
                        line,
                        column: Some(self.number(line_end + 1, column_end)),
                        end: self.range_end(column_end),
                    });
                }
                // `file.dart:12:` ends with the separator, which is not part of the link.
                Some(Position {
                    line,
                    column: None,
                    end: self.range_end(line_end),
                })
            }
            '#' => self.fragment_position(at),
            '(' => {
                let line_end = self.position_digits_end(at + 1)?;
                if line_end >= n {
                    return None;
                }
                let line = self.number(at + 1, line_end);
                match self.s[line_end] {
                    ')' => Some(Position {
                        line,
                        column: None,
                        end: line_end + 1,
                    }),
                    ',' => {
                        let mut column_start = line_end + 1;
                        if column_start < n && self.s[column_start] == ' ' {
                            column_start += 1;
                        }
                        let column_end = self.position_digits_end(column_start)?;
                        if column_end >= n || self.s[column_end] != ')' {
                            return None;
                        }
                        Some(Position {
                            line,
                            column: Some(self.number(column_start, column_end)),
                            end: column_end + 1,
                        })
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// End of an optional `-END` or `-END:COL` range directly at `at`, else `at`:
    /// `a.dart:12-20` is one link to line 12.
    fn range_end(&self, at: usize) -> usize {
        if at + 1 >= self.n() || self.s[at] != '-' {
            return at;
        }
        let Some(to) = self.position_digits_end(at + 1) else {
            return at;
        };
        if to < self.n()
            && self.s[to] == ':'
            && let Some(column) = self.position_digits_end(to + 1)
        {
            return column;
        }
        to
    }

    /// `#L12`, `#L12C3`, `#L12-L20` and `#L12C3-L20C5` (GitHub style).
    fn fragment_position(&self, at: usize) -> Option<Position> {
        let n = self.n();
        if at + 2 >= n || self.s[at + 1] != 'L' {
            return None;
        }
        let line_end = self.position_digits_end(at + 2)?;
        let line = self.number(at + 2, line_end);
        let mut column = None;
        let mut end = line_end;
        if let Some(column_end) = self.fragment_column_end(end) {
            column = Some(self.number(end + 1, column_end));
            end = column_end;
        }
        if end + 1 < n
            && self.s[end] == '-'
            && self.s[end + 1] == 'L'
            && let Some(to) = self.position_digits_end(end + 2)
        {
            end = to;
            if let Some(to_column) = self.fragment_column_end(end) {
                end = to_column;
            }
        }
        Some(Position { line, column, end })
    }

    /// End of `C<digits>` at `at`.
    fn fragment_column_end(&self, at: usize) -> Option<usize> {
        if at + 1 < self.n() && self.s[at] == 'C' {
            self.position_digits_end(at + 1)
        } else {
            None
        }
    }

    /// The line a path is followed by in words: Python tracebacks name it after the path
    /// (`"/x/y.py", line 12`), prose in brackets (`a.dart (line 12)`, `a.dart (lines 12-20)`).
    /// Returns the line number when `at` (just past the path) continues like that; the displayed
    /// link stays the bare path.
    fn named_line(&self, at: usize) -> Option<u32> {
        let n = self.n();
        let mut k = at;
        if k < n && self.s[k] == '"' {
            k += 1;
        }
        if k < n && self.s[k] == ',' {
            k = self.skip_spaces(k + 1)?;
        } else {
            k = self.skip_spaces(k)?;
            if k >= n || self.s[k] != '(' {
                return None;
            }
            k += 1;
        }
        if !self.starts_with(k, "line") {
            return None;
        }
        k += 4;
        if k < n && self.s[k] == 's' {
            k += 1; // `lines`
        }
        k = self.skip_spaces(k)?;
        let line_end = self.position_digits_end(k)?;
        Some(self.number(k, line_end))
    }

    /// Index after the spaces at `from`; `None` if there is not at least one.
    fn skip_spaces(&self, from: usize) -> Option<usize> {
        let mut k = from;
        while k < self.n() && self.s[k] == ' ' {
            k += 1;
        }
        (k != from).then_some(k)
    }
}

/// What a path link carries besides its span.
#[derive(Default)]
struct Extra {
    target_start: Option<usize>,
    line: Option<u32>,
    column: Option<u32>,
}
