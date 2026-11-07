//! Which language a block of code is: from a fence's info string, a file name, a shebang, or (last) a
//! cheap look at the text. The list is the languages with a tree-sitter grammar; everything else is
//! found by the TextMate fallback (`tm.rs`) under the name it was given.

/// A language with a tree-sitter grammar and hand-tuned queries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Lang {
    TypeScript,
    Tsx,
    JavaScript,
    Rust,
    Python,
    Go,
    Java,
    Kotlin,
    C,
    Cpp,
    Swift,
    Ruby,
    Php,
    Bash,
    Sql,
    Json,
    Yaml,
    Toml,
    Html,
    Css,
    Markdown,
    Dockerfile,
    Diff,
    Lua,
    Zig,
    Dart,
}

impl Lang {
    pub const ALL: [Lang; 26] = [
        Lang::TypeScript,
        Lang::Tsx,
        Lang::JavaScript,
        Lang::Rust,
        Lang::Python,
        Lang::Go,
        Lang::Java,
        Lang::Kotlin,
        Lang::C,
        Lang::Cpp,
        Lang::Swift,
        Lang::Ruby,
        Lang::Php,
        Lang::Bash,
        Lang::Sql,
        Lang::Json,
        Lang::Yaml,
        Lang::Toml,
        Lang::Html,
        Lang::Css,
        Lang::Markdown,
        Lang::Dockerfile,
        Lang::Diff,
        Lang::Lua,
        Lang::Zig,
        Lang::Dart,
    ];

    /// The name shown on a block's label.
    pub const fn label(self) -> &'static str {
        match self {
            Lang::TypeScript => "TypeScript",
            Lang::Tsx => "TSX",
            Lang::JavaScript => "JavaScript",
            Lang::Rust => "Rust",
            Lang::Python => "Python",
            Lang::Go => "Go",
            Lang::Java => "Java",
            Lang::Kotlin => "Kotlin",
            Lang::C => "C",
            Lang::Cpp => "C++",
            Lang::Swift => "Swift",
            Lang::Ruby => "Ruby",
            Lang::Php => "PHP",
            Lang::Bash => "Shell",
            Lang::Sql => "SQL",
            Lang::Json => "JSON",
            Lang::Yaml => "YAML",
            Lang::Toml => "TOML",
            Lang::Html => "HTML",
            Lang::Css => "CSS",
            Lang::Markdown => "Markdown",
            Lang::Dockerfile => "Dockerfile",
            Lang::Diff => "Diff",
            Lang::Lua => "Lua",
            Lang::Zig => "Zig",
            Lang::Dart => "Dart",
        }
    }

    /// The language a fence's info string names (`tsx`, `rust,no_run`, `{.python .numberLines}`,
    /// `ts title="a.ts"`, `language-go`), or a file extension without its dot.
    pub fn from_name(name: &str) -> Option<Lang> {
        let name = fence_word(name);
        let lower = name.to_ascii_lowercase();
        Some(match lower.as_str() {
            "ts" | "typescript" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "js" | "javascript" | "jsx" | "mjs" | "cjs" | "node" | "json5x" => Lang::JavaScript,
            "rs" | "rust" => Lang::Rust,
            "py" | "python" | "python3" | "py3" | "pyi" => Lang::Python,
            "go" | "golang" => Lang::Go,
            "java" => Lang::Java,
            "kt" | "kts" | "kotlin" => Lang::Kotlin,
            "c" | "h" => Lang::C,
            "cpp" | "c++" | "cc" | "cxx" | "hpp" | "hh" | "hxx" | "cplusplus" => Lang::Cpp,
            "swift" => Lang::Swift,
            "rb" | "ruby" | "rake" | "gemspec" => Lang::Ruby,
            "php" => Lang::Php,
            "sh" | "bash" | "zsh" | "shell" | "shellscript" | "console" | "shell-session"
            | "ksh" | "fish" => Lang::Bash,
            "sql" | "psql" | "pgsql" | "mysql" | "sqlite" | "postgresql" | "plsql" | "tsql" => {
                Lang::Sql
            }
            "json" | "jsonc" | "json5" | "geojson" | "jsonl" | "ndjson" => Lang::Json,
            "yaml" | "yml" => Lang::Yaml,
            "toml" => Lang::Toml,
            "html" | "htm" | "xhtml" | "svg" | "xml" | "vue" | "svelte" => Lang::Html,
            "css" | "scss" | "less" | "postcss" => Lang::Css,
            "md" | "markdown" | "mdx" => Lang::Markdown,
            "dockerfile" | "docker" | "containerfile" => Lang::Dockerfile,
            "diff" | "patch" | "udiff" | "git" => Lang::Diff,
            "lua" => Lang::Lua,
            "zig" => Lang::Zig,
            "dart" => Lang::Dart,
            _ => return None,
        })
    }

    /// The language of a file by its name (`Dockerfile`, `main.rs`, `x.tar.gz` is none).
    pub fn from_path(path: &str) -> Option<Lang> {
        let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let lower = file.to_ascii_lowercase();
        if lower == "dockerfile"
            || lower.starts_with("dockerfile.")
            || lower.ends_with(".dockerfile")
        {
            return Some(Lang::Dockerfile);
        }
        match lower.as_str() {
            "gemfile" | "rakefile" | "podfile" | "vagrantfile" | ".bashrc" | ".zshrc"
            | ".profile" | ".bash_profile" | "pkgbuild" => {
                return Some(if lower.starts_with('.') || lower == "pkgbuild" {
                    Lang::Bash
                } else {
                    Lang::Ruby
                });
            }
            "cargo.lock" | "poetry.lock" | "pipfile" => return Some(Lang::Toml),
            "package.json" | "tsconfig.json" | ".eslintrc" | ".prettierrc" => {
                return Some(Lang::Json);
            }
            _ => {}
        }
        let (_, ext) = file.rsplit_once('.')?;
        Lang::from_name(ext)
    }

    /// The language a `#!` line names (`#!/usr/bin/env python3`, `#!/bin/bash -e`).
    pub fn from_shebang(text: &str) -> Option<Lang> {
        let first = text.lines().next()?;
        let rest = first.strip_prefix("#!")?.trim();
        let mut words = rest.split_whitespace();
        let mut program = words.next()?.rsplit('/').next()?;
        if program == "env" {
            // `env -S node --flag` and `env FOO=1 python`: the first word that is a program.
            program = words.find(|w| !w.starts_with('-') && !w.contains('='))?;
        }
        let program = program.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
        match program {
            "python" | "python3" | "pypy" => Some(Lang::Python),
            "node" | "nodejs" | "deno" | "bun" => Some(Lang::JavaScript),
            "ts-node" | "tsx" => Some(Lang::TypeScript),
            "ruby" => Some(Lang::Ruby),
            "php" => Some(Lang::Php),
            "lua" | "luajit" => Some(Lang::Lua),
            "sh" | "bash" | "zsh" | "ksh" | "dash" | "fish" | "ash" => Some(Lang::Bash),
            _ => None,
        }
    }

    /// A guess from the text itself, for a fence with no language: only what is nearly certain
    /// (a shebang, a diff, a JSON document, a shell prompt line, HTML), because a wrong guess
    /// colours prose as code.
    pub fn sniff(text: &str) -> Option<Lang> {
        if let Some(lang) = Lang::from_shebang(text) {
            return Some(lang);
        }
        let head = text.trim_start();
        if head.is_empty() {
            return None;
        }
        let first = head.lines().next().unwrap_or("");
        if first.starts_with("diff --git ")
            || first.starts_with("--- a/")
            || first.starts_with("@@ -")
        {
            return Some(Lang::Diff);
        }
        if (first.starts_with("--- ") && head.lines().nth(1).is_some_and(|l| l.starts_with("+++ ")))
            || first.starts_with("Index: ")
        {
            return Some(Lang::Diff);
        }
        if head.starts_with("<?php") {
            return Some(Lang::Php);
        }
        let lower = head
            .get(..head.len().min(64))
            .unwrap_or(head)
            .to_ascii_lowercase();
        if lower.starts_with("<!doctype html") || lower.starts_with("<html") {
            return Some(Lang::Html);
        }
        if (head.starts_with('{') || head.starts_with('['))
            && head.trim_end().ends_with(['}', ']'])
            && head.contains('"')
            && head.contains(':')
            && head.lines().count() > 1
        {
            return Some(Lang::Json);
        }
        if first.starts_with("$ ")
            || first.starts_with("# ") && head.lines().nth(1).is_some_and(|l| l.starts_with("$ "))
        {
            return Some(Lang::Bash);
        }
        if first.starts_with("FROM ")
            && head
                .lines()
                .any(|l| l.starts_with("RUN ") || l.starts_with("COPY "))
        {
            return Some(Lang::Dockerfile);
        }
        if first.starts_with("use ") && first.ends_with(';') && first.contains("::")
            || head.starts_with("fn main()")
            || head.starts_with("pub fn ")
            || head.starts_with("#[derive")
        {
            return Some(Lang::Rust);
        }
        if first.starts_with("package ") && head.lines().any(|l| l.starts_with("func ")) {
            return Some(Lang::Go);
        }
        if first.starts_with("def ") && first.trim_end().ends_with(':')
            || first.starts_with("import ") && head.contains("\ndef ")
            || first.starts_with("from ") && first.contains(" import ")
        {
            return Some(Lang::Python);
        }
        if first.starts_with("import ") && first.contains(" from ")
            || first.starts_with("export ")
            || first.starts_with("const ") && first.contains(" = ")
            || first.starts_with("interface ")
        {
            return Some(Lang::TypeScript);
        }
        None
    }

    /// The language for a block: its fence word, else the file it came from, else the text.
    pub fn detect(fence: Option<&str>, path: Option<&str>, text: &str) -> Option<Lang> {
        fence
            .and_then(Lang::from_name)
            .or_else(|| path.and_then(Lang::from_path))
            .or_else(|| {
                // Only an empty or unknown fence is sniffed: `text` and `plain` mean "do not colour".
                let fence = fence.map(fence_word).unwrap_or("");
                let plain = ["text", "txt", "plain", "plaintext", "output", "log", "none"];
                if plain.iter().any(|p| fence.eq_ignore_ascii_case(p)) {
                    None
                } else if fence.is_empty() {
                    Lang::sniff(text)
                } else {
                    None
                }
            })
    }
}

/// The language word of a fence's info string: the first word, without braces, a dot, a
/// `language-` prefix or a `,option` tail.
pub fn fence_word(info: &str) -> &str {
    let info = info.trim().trim_start_matches('{').trim_start_matches('.');
    let word = info
        .split(|c: char| c.is_whitespace() || c == ',' || c == '{' || c == '}' || c == '=')
        .next()
        .unwrap_or("");
    let word = word.trim_start_matches('.');
    word.strip_prefix("language-")
        .or_else(|| word.strip_prefix("lang-"))
        .unwrap_or(word)
}
