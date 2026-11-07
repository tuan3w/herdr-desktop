//! The tree-sitter engine: a grammar and its highlight query per language, compiled once; a parse that
//! reuses the last tree when the text only grew or changed in the middle; and the captures of a byte
//! range turned into [`Span`]s, innermost capture first and later patterns over earlier ones.
//!
//! Queries are the grammar crate's own `highlights.scm` followed by the overlay in `queries/` (a later
//! pattern wins over an earlier one for the same node), or a complete query of ours where the stock one
//! is too coarse to be worth keeping.

use std::ops::Range;
use std::sync::OnceLock;

use std::ops::ControlFlow;
use std::time::{Duration, Instant};
use streaming_iterator::StreamingIterator;

use tree_sitter::{
    InputEdit, Language, ParseOptions, ParseState, Parser, Point, Query, QueryCursor, Tree,
};

use super::lang::Lang;
use super::post;
use super::role::{Role, Span};

/// A language ready to highlight: its grammar, its query, and the role of every capture.
pub struct Grammar {
    pub lang: Lang,
    language: Language,
    query: Query,
    /// By capture index; `None` captures clear what an earlier pattern painted (`@none`).
    roles: Vec<Capture>,
}

#[derive(Clone, Copy, Debug)]
enum Capture {
    /// Not a highlight (`@_name`, `@injection.*`, `@local.*`).
    Skip,
    /// `@none`: back to plain.
    Clear,
    Role(Role),
}

static GRAMMARS: [OnceLock<Option<Grammar>>; Lang::ALL.len()] =
    [const { OnceLock::new() }; Lang::ALL.len()];

fn slot(lang: Lang) -> usize {
    Lang::ALL.iter().position(|l| *l == lang).unwrap_or(0)
}

/// Whether the grammar of `lang` is compiled already (a highlight then costs no setup).
pub fn loaded(lang: Lang) -> bool {
    GRAMMARS[slot(lang)].get().is_some()
}

/// The grammar of `lang`, compiled on first use (a TypeScript query takes tens of milliseconds to
/// compile, so the first block of a language belongs on a background thread).
pub fn grammar(lang: Lang) -> Option<&'static Grammar> {
    GRAMMARS[slot(lang)]
        .get_or_init(|| Grammar::build(lang))
        .as_ref()
}

impl Grammar {
    fn build(lang: Lang) -> Option<Grammar> {
        // A query that does not compile is a bug of ours (a test names it); the block is then plain.
        Grammar::try_build(lang).ok()
    }

    /// Compiles the grammar and query of `lang`; `Err` says why a query is wrong (its text and place).
    pub fn try_build(lang: Lang) -> Result<Grammar, String> {
        let (language, source) =
            sources(lang).ok_or_else(|| format!("{lang:?} has no tree-sitter grammar"))?;
        let query = Query::new(&language, &source).map_err(|e| format!("{lang:?}: {e}"))?;
        let roles = query
            .capture_names()
            .iter()
            .map(|name| capture(name))
            .collect();
        Ok(Grammar {
            lang,
            language,
            query,
            roles,
        })
    }

    pub fn language(&self) -> &Language {
        &self.language
    }

    /// The capture names the query uses (for tests and the bake-off).
    pub fn capture_names(&self) -> &[&str] {
        self.query.capture_names()
    }
}

/// The role a capture name stands for, by its longest known prefix: `function.method.call` finds
/// `function.method.call`, else `function.method`, else `function`.
fn capture(name: &str) -> Capture {
    if name.starts_with('_')
        || name.starts_with("injection")
        || name.starts_with("local")
        || name == "spell"
        || name == "nospell"
    {
        return Capture::Skip;
    }
    if name == "none" {
        return Capture::Clear;
    }
    let mut key = name;
    loop {
        if let Some(role) = role_of(key) {
            return Capture::Role(role);
        }
        match key.rfind('.') {
            Some(dot) => key = &key[..dot],
            None => return Capture::Skip,
        }
    }
}

fn role_of(key: &str) -> Option<Role> {
    use Role::*;
    Some(match key {
        "comment" => Comment,
        "comment.documentation" | "comment.doc" | "doc" => DocComment,
        "comment.todo" | "comment.note" | "comment.warning" | "comment.error" => Todo,
        "keyword"
        | "keyword.function"
        | "keyword.type"
        | "keyword.import"
        | "keyword.include"
        | "keyword.operator"
        | "keyword.special"
        | "keyword.coroutine.declaration" => Keyword,
        "keyword.control"
        | "keyword.conditional"
        | "keyword.repeat"
        | "keyword.return"
        | "keyword.exception"
        | "keyword.coroutine"
        | "keyword.debug"
        | "conditional"
        | "repeat"
        | "exception"
        | "include" => Control,
        "keyword.modifier"
        | "keyword.storage"
        | "storage"
        | "storage.modifier"
        | "type.qualifier"
        | "keyword.directive.modifier" => Modifier,
        "keyword.directive" | "keyword.preproc" | "preproc" | "macro" | "function.macro"
        | "function.special" | "constant.macro" => Macro,
        "operator" => Operator,
        "punctuation" | "punctuation.bracket" | "punctuation.delimiter" | "punctuation.special" => {
            Punctuation
        }
        "punctuation.interpolation" | "string.interpolation" | "embedded" => Interpolation,
        "function"
        | "function.call"
        | "function.builtin"
        | "function.method.builtin"
        | "method.call" => Function,
        "function.def"
        | "function.definition"
        | "function.method.def"
        | "method.def"
        | "function.method.definition" => FunctionDef,
        "function.method" | "function.method.call" | "method" => Method,
        "constructor" | "type" | "type.definition" | "type.parameter" | "type.enum"
        | "type.enum.variant" | "class" | "interface" | "enum" | "struct" => Type,
        "type.builtin" => TypeBuiltin,
        "constant"
        | "constant.builtin"
        | "boolean"
        | "constant.character"
        | "variable.builtin.constant" => Constant,
        "number"
        | "number.float"
        | "constant.numeric"
        | "float"
        | "constant.numeric.integer"
        | "constant.numeric.float" => Number,
        "string"
        | "character"
        | "string.special"
        | "string.special.path"
        | "string.quoted"
        | "text"
        | "string.template" => String,
        "string.escape" | "escape" | "constant.character.escape" | "character.special" => Escape,
        "string.regexp" | "string.regex" | "regexp" => Regexp,
        "string.documentation" => DocComment,
        "string.special.symbol" | "symbol" | "constant.symbol" => Constant,
        "string.special.key" | "string.key" => Property,
        "string.special.url" | "string.uri" | "text.uri" | "markup.link.url" | "markup.link"
        | "markup.link.label" | "markup.link.text" | "text.reference" | "link" => Link,
        "property"
        | "variable.member"
        | "field"
        | "property.definition"
        | "variable.other.member" => Property,
        "variable" | "variable.other" => Variable,
        "variable.parameter" | "parameter" | "variable.parameter.definition" => Parameter,
        "variable.builtin"
        | "variable.parameter.builtin"
        | "variable.language"
        | "variable.special" => SelfValue,
        "module" | "namespace" | "module.builtin" => Namespace,
        "tag" | "tag.builtin" | "tag.name" => Tag,
        "tag.attribute" | "attribute.name" | "tag.attr" => Attribute,
        "tag.delimiter" => Punctuation,
        "attribute" | "attribute.builtin" | "annotation" | "decorator" => Decorator,
        "label" | "lifetime" => Label,
        "markup.heading" | "text.title" | "heading" | "markup.heading.marker" => Heading,
        "markup.italic" | "text.emphasis" | "emphasis" => Emphasis,
        "markup.bold" | "markup.strong" | "text.strong" | "strong" => Strong,
        "markup"
        | "markup.raw"
        | "markup.raw.block"
        | "markup.list"
        | "markup.quote"
        | "text.literal"
        | "markup.strikethrough"
        | "text.strike"
        | "markup.list.checked"
        | "markup.list.unchecked"
        | "markup.raw.inline"
        | "markup.raw.delimiter" => Markup,
        "diff.plus" | "markup.inserted" | "diff.addition" => DiffAdd,
        "diff.minus" | "markup.deleted" | "diff.deletion" => DiffRemove,
        "diff.delta" | "diff.meta" | "diff.header" => DiffMeta,
        "error" | "invalid" => Error,
        _ => return None,
    })
}

// ---- sources: grammar + query text per language ------------------------------------------------

macro_rules! overlay {
    ($name:literal) => {
        include_str!(concat!("queries/", $name, ".scm"))
    };
}

/// The stock query of the grammar crate followed by our overlays. An overlay whose first line is
/// `;; replace` drops the stock query and every overlay before it: where the stock one is too coarse
/// to be worth keeping, ours is complete.
fn join(parts: &[&str]) -> String {
    let start = parts
        .iter()
        .rposition(|p| p.starts_with(";; replace"))
        .unwrap_or(0);
    parts[start..].join("\n")
}

fn sources(lang: Lang) -> Option<(Language, String)> {
    Some(match lang {
        Lang::TypeScript => (
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            join(&[
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_typescript::HIGHLIGHTS_QUERY,
                overlay!("javascript"),
                overlay!("typescript"),
            ]),
        ),
        Lang::Tsx => (
            tree_sitter_typescript::LANGUAGE_TSX.into(),
            join(&[
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_javascript::JSX_HIGHLIGHT_QUERY,
                tree_sitter_typescript::HIGHLIGHTS_QUERY,
                overlay!("javascript"),
                overlay!("typescript"),
                overlay!("jsx"),
            ]),
        ),
        Lang::JavaScript => (
            tree_sitter_javascript::LANGUAGE.into(),
            join(&[
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_javascript::JSX_HIGHLIGHT_QUERY,
                overlay!("javascript"),
                overlay!("jsx"),
            ]),
        ),
        Lang::Rust => (
            tree_sitter_rust::LANGUAGE.into(),
            join(&[tree_sitter_rust::HIGHLIGHTS_QUERY, overlay!("rust")]),
        ),
        Lang::Python => (
            tree_sitter_python::LANGUAGE.into(),
            join(&[tree_sitter_python::HIGHLIGHTS_QUERY, overlay!("python")]),
        ),
        Lang::Go => (
            tree_sitter_go::LANGUAGE.into(),
            join(&[tree_sitter_go::HIGHLIGHTS_QUERY, overlay!("go")]),
        ),
        Lang::Java => (
            tree_sitter_java::LANGUAGE.into(),
            join(&[tree_sitter_java::HIGHLIGHTS_QUERY, overlay!("java")]),
        ),
        Lang::Kotlin => (
            tree_sitter_kotlin_ng::LANGUAGE.into(),
            overlay!("kotlin").to_string(),
        ),
        Lang::C => (
            tree_sitter_c::LANGUAGE.into(),
            join(&[tree_sitter_c::HIGHLIGHT_QUERY, overlay!("c")]),
        ),
        Lang::Cpp => (
            tree_sitter_cpp::LANGUAGE.into(),
            join(&[
                tree_sitter_c::HIGHLIGHT_QUERY,
                tree_sitter_cpp::HIGHLIGHT_QUERY,
                overlay!("c"),
                overlay!("cpp"),
            ]),
        ),
        Lang::Swift => (
            tree_sitter_swift::LANGUAGE.into(),
            join(&[tree_sitter_swift::HIGHLIGHTS_QUERY, overlay!("swift")]),
        ),
        Lang::Ruby => (
            tree_sitter_ruby::LANGUAGE.into(),
            join(&[tree_sitter_ruby::HIGHLIGHTS_QUERY, overlay!("ruby")]),
        ),
        Lang::Php => (
            tree_sitter_php::LANGUAGE_PHP.into(),
            join(&[tree_sitter_php::HIGHLIGHTS_QUERY, overlay!("php")]),
        ),
        Lang::Bash => (
            tree_sitter_bash::LANGUAGE.into(),
            join(&[tree_sitter_bash::HIGHLIGHT_QUERY, overlay!("bash")]),
        ),
        Lang::Sql => (
            tree_sitter_sequel::LANGUAGE.into(),
            join(&[tree_sitter_sequel::HIGHLIGHTS_QUERY, overlay!("sql")]),
        ),
        Lang::Json => (
            tree_sitter_json::LANGUAGE.into(),
            join(&[tree_sitter_json::HIGHLIGHTS_QUERY, overlay!("json")]),
        ),
        Lang::Yaml => (
            tree_sitter_yaml::LANGUAGE.into(),
            join(&[tree_sitter_yaml::HIGHLIGHTS_QUERY, overlay!("yaml")]),
        ),
        Lang::Toml => (
            tree_sitter_toml_ng::LANGUAGE.into(),
            join(&[tree_sitter_toml_ng::HIGHLIGHTS_QUERY, overlay!("toml")]),
        ),
        Lang::Html => (
            tree_sitter_html::LANGUAGE.into(),
            join(&[tree_sitter_html::HIGHLIGHTS_QUERY, overlay!("html")]),
        ),
        Lang::Css => (
            tree_sitter_css::LANGUAGE.into(),
            join(&[tree_sitter_css::HIGHLIGHTS_QUERY, overlay!("css")]),
        ),
        Lang::Markdown => (
            tree_sitter_md::LANGUAGE.into(),
            join(&[tree_sitter_md::HIGHLIGHT_QUERY_BLOCK, overlay!("markdown")]),
        ),
        // The crate that exists for it is built on tree-sitter 0.20 and cannot share this core: TextMate.
        Lang::Dockerfile => return None,
        Lang::Diff => (
            tree_sitter_diff::LANGUAGE.into(),
            join(&[tree_sitter_diff::HIGHLIGHTS_QUERY, overlay!("diff")]),
        ),
        Lang::Lua => (
            tree_sitter_lua::LANGUAGE.into(),
            join(&[tree_sitter_lua::HIGHLIGHTS_QUERY, overlay!("lua")]),
        ),
        Lang::Zig => (
            tree_sitter_zig::LANGUAGE.into(),
            join(&[tree_sitter_zig::HIGHLIGHTS_QUERY, overlay!("zig")]),
        ),
        Lang::Dart => (
            tree_sitter_dart::LANGUAGE.into(),
            join(&[tree_sitter_dart::HIGHLIGHTS_QUERY, overlay!("dart")]),
        ),
    })
}

// ---- painting ---------------------------------------------------------------------------------

/// What one query run found: the captured ranges in query order.
struct Hit {
    start: usize,
    end: usize,
    pattern: usize,
    capture: Capture,
}

/// The spans of `range` of `text` under `tree`: the captures painted largest first, so the innermost
/// wins, and among equals the later pattern. Spans are clipped to `range`.
pub fn paint(grammar: &Grammar, tree: &Tree, text: &str, range: Range<usize>) -> Vec<Span> {
    let mut dense = vec![0u8; text.len()];
    paint_into(&mut dense, grammar, tree, text, range.clone());
    spans_of(&dense[range.clone()], range.start)
}

/// Paints the captures inside `range` into `dense`, one byte of role + 1 per byte of `text`.
fn paint_into(dense: &mut [u8], grammar: &Grammar, tree: &Tree, text: &str, range: Range<usize>) {
    if range.is_empty() {
        return;
    }
    let mut cursor = QueryCursor::new();
    cursor.set_byte_range(range.clone());
    let mut hits: Vec<Hit> = Vec::new();
    let mut inner: Vec<post::Inner> = Vec::new();
    let mut matches = cursor.matches(&grammar.query, tree.root_node(), text.as_bytes());
    while let Some(m) = matches.next() {
        for c in m.captures() {
            let capture = grammar.roles[c.index as usize];
            if matches!(capture, Capture::Skip) {
                continue;
            }
            let node = c.node;
            let (start, end) = (
                node.start_byte().max(range.start),
                node.end_byte().min(range.end),
            );
            if start >= end {
                continue;
            }
            let mut capture = capture;
            let own = node.start_byte()..node.end_byte();
            // What the text of the node adds, as absolute byte ranges.
            inner.clear();
            let mut found: Vec<post::Inner> = Vec::new();
            let mut base = own.start;
            match capture {
                Capture::Role(Role::Comment) => {
                    let body = &text[own.clone()];
                    if post::is_doc(grammar.lang, body) {
                        capture = Capture::Role(Role::DocComment);
                    }
                    post::todos(body, &mut found);
                }
                Capture::Role(Role::DocComment) => post::todos(&text[own.clone()], &mut found),
                Capture::Role(Role::String) => {
                    let body = &text[own.clone()];
                    if post::opens_string(body) {
                        post::escapes(grammar.lang, body, body, &mut found);
                    } else if let Some(parent) = node.parent() {
                        // The content of a string without its quotes: the escapes sit between this
                        // fragment and its neighbours, as nodes of their own that carry no capture.
                        let opener = &text[parent.start_byte()..parent.end_byte()];
                        let from = node
                            .prev_sibling()
                            .map_or(parent.start_byte(), |n| n.end_byte())
                            .min(own.start);
                        let to = node
                            .next_sibling()
                            .map_or(parent.end_byte(), |n| n.start_byte())
                            .max(own.end);
                        base = from;
                        post::escapes(grammar.lang, opener, &text[from..to], &mut found);
                    }
                }
                _ => {}
            }
            inner.extend(found.into_iter().map(|(a, b, r)| (base + a, base + b, r)));
            hits.push(Hit {
                start,
                end,
                pattern: m.pattern_index,
                capture,
            });
            for &(a, b, role) in &inner {
                let (a, b) = (a.max(range.start), b.min(range.end));
                if a < b {
                    hits.push(Hit {
                        start: a,
                        end: b,
                        pattern: usize::MAX,
                        capture: Capture::Role(role),
                    });
                }
            }
        }
    }
    // Largest first; among equal sizes the earlier pattern first so the later one paints over it.
    hits.sort_by(|a, b| {
        (b.end - b.start)
            .cmp(&(a.end - a.start))
            .then(a.pattern.cmp(&b.pattern))
    });
    for hit in &hits {
        let value = match hit.capture {
            Capture::Role(role) => role as u8 + 1,
            _ => 1 + Role::Plain as u8,
        };
        dense[hit.start..hit.end].fill(value);
    }
}

/// Runs of one non-plain value in `paint` (value = role + 1, 0 = nothing) as spans.
pub(super) fn spans_of(paint: &[u8], base: usize) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut i = 0;
    while i < paint.len() {
        let v = paint[i];
        let mut j = i + 1;
        while j < paint.len() && paint[j] == v {
            j += 1;
        }
        if v > 1 {
            spans.push(Span::new(base + i, base + j, Role::from_u8(v - 1)));
        }
        i = j;
    }
    spans
}

// ---- parsing ----------------------------------------------------------------------------------

/// A parser that remembers the last tree of one text so an append or a middle edit reparses only
/// what changed.
pub struct Parse {
    parser: Parser,
    tree: Option<Tree>,
    text: String,
}

impl Parse {
    pub fn new(grammar: &Grammar) -> Option<Parse> {
        let mut parser = Parser::new();
        parser.set_language(&grammar.language).ok()?;
        Some(Parse {
            parser,
            tree: None,
            text: String::new(),
        })
    }

    /// Parses `text` within `budget`, reusing the previous tree. Returns the tree and the byte range
    /// that is not what it was before (the edit, widened by the grammar's changed ranges), or the
    /// whole text the first time; `None` when the parse took longer than `budget`. A grammar can
    /// loop on some unfinished text (tree-sitter-kotlin-ng does on `val a = 1` then a lone `@`), and
    /// a block that is still being written is exactly that, so a parse never runs unbounded: the next
    /// chunk starts from scratch.
    pub fn update(&mut self, text: &str, budget: Duration) -> Option<(&Tree, Range<usize>)> {
        let old = std::mem::take(&mut self.text);
        let (tree, dirty) = match self.tree.take() {
            Some(mut tree) if !old.is_empty() => {
                let (prefix, suffix) = common_edges(old.as_bytes(), text.as_bytes());
                let edit = InputEdit {
                    start_byte: prefix,
                    old_end_byte: old.len() - suffix,
                    new_end_byte: text.len() - suffix,
                    start_position: point_at(old.as_bytes(), prefix),
                    old_end_position: point_at(old.as_bytes(), old.len() - suffix),
                    new_end_position: point_at(text.as_bytes(), text.len() - suffix),
                };
                tree.edit(&edit);
                let new = self.parse_within(text, Some(&tree), budget)?;
                let mut dirty = prefix..text.len() - suffix;
                for r in tree.changed_ranges(&new) {
                    dirty.start = dirty.start.min(r.start_byte);
                    dirty.end = dirty.end.max(r.end_byte);
                }
                (new, dirty)
            }
            _ => (self.parse_within(text, None, budget)?, 0..text.len()),
        };
        self.text = text.to_string();
        Some((&*self.tree.insert(tree), dirty))
    }
}

impl Parse {
    fn parse_within(&mut self, text: &str, old: Option<&Tree>, budget: Duration) -> Option<Tree> {
        let bytes = text.as_bytes();
        let started = Instant::now();
        let mut stop = |_: &ParseState| {
            if started.elapsed() > budget {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        };
        let tree = self.parser.parse_with_options(
            &mut |i, _| {
                if i < bytes.len() {
                    &bytes[i..]
                } else {
                    &[][..]
                }
            },
            old,
            Some(ParseOptions::new().progress_callback(&mut stop)),
        );
        if tree.is_none() {
            // A cancelled parse leaves the parser mid-way: it must start clean.
            self.parser.reset();
        }
        tree
    }
}

/// How many leading and trailing bytes `a` and `b` share, without the two overlapping and on
/// character boundaries of both.
fn common_edges(a: &[u8], b: &[u8]) -> (usize, usize) {
    let max = a.len().min(b.len());
    let mut prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    while prefix > 0 && (is_continuation(a.get(prefix)) || is_continuation(b.get(prefix))) {
        prefix -= 1;
    }
    let mut suffix = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take(max - prefix)
        .take_while(|(x, y)| x == y)
        .count();
    while suffix > 0
        && (is_continuation(a.get(a.len() - suffix)) || is_continuation(b.get(b.len() - suffix)))
    {
        suffix -= 1;
    }
    (prefix, suffix)
}

fn is_continuation(byte: Option<&u8>) -> bool {
    byte.is_some_and(|b| b & 0xC0 == 0x80)
}

/// The row and column (bytes) of byte `offset`.
fn point_at(text: &[u8], offset: usize) -> Point {
    let head = &text[..offset];
    let row = head.iter().filter(|b| **b == b'\n').count();
    let column = head.len() - head.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    Point { row, column }
}

// ---- languages inside languages ----------------------------------------------------------------

/// Whether a tree-sitter grammar with our queries exists for `lang` (else TextMate reads it).
pub fn supports(lang: Lang) -> bool {
    lang != Lang::Dockerfile
}

/// Whether `lang` holds other languages (fenced code, `<script>`), which makes every update a full
/// repaint: these documents are short, and an injected block can change with a byte far from it.
pub fn injects(lang: Option<Lang>) -> bool {
    matches!(lang, Some(Lang::Markdown | Lang::Html))
}

/// The grammar of Markdown's inline layer (emphasis, code spans, links).
fn markdown_inline() -> Option<&'static Grammar> {
    static INLINE: OnceLock<Option<Grammar>> = OnceLock::new();
    INLINE
        .get_or_init(|| {
            let language: Language = tree_sitter_md::INLINE_LANGUAGE.into();
            let source = join(&[
                tree_sitter_md::HIGHLIGHT_QUERY_INLINE,
                overlay!("markdown_inline"),
            ]);
            let query = Query::new(&language, &source)
                .map_err(|e| log::error!("markdown inline query: {e}"))
                .ok()?;
            let roles = query
                .capture_names()
                .iter()
                .map(|name| capture(name))
                .collect();
            Some(Grammar {
                lang: Lang::Markdown,
                language,
                query,
                roles,
            })
        })
        .as_ref()
}

/// The spans of a whole document with the languages inside it painted over the host's own.
pub fn paint_with_injections(grammar: &Grammar, tree: &Tree, text: &str) -> Vec<Span> {
    let mut dense = vec![0u8; text.len()];
    paint_into(&mut dense, grammar, tree, text, 0..text.len());
    let mut injections: Vec<(Range<usize>, Lang)> = Vec::new();
    let mut inline: Vec<tree_sitter::Range> = Vec::new();
    collect(
        grammar.lang,
        tree.root_node(),
        text,
        &mut injections,
        &mut inline,
    );
    if grammar.lang == Lang::Markdown
        && !inline.is_empty()
        && let Some(ig) = markdown_inline()
    {
        let mut parser = Parser::new();
        // One parse per inline range: an unclosed backtick or `**` in one paragraph must not
        // swallow the blocks after it.
        if parser.set_language(&ig.language).is_ok() {
            for range in &inline {
                if parser
                    .set_included_ranges(std::slice::from_ref(range))
                    .is_ok()
                    && let Some(itree) = parser.parse(text, None)
                {
                    paint_into(
                        &mut dense,
                        ig,
                        &itree,
                        text,
                        range.start_byte..range.end_byte,
                    );
                }
            }
        }
    }
    for (range, lang) in injections {
        let inner = super::highlight(lang, &text[range.clone()]);
        dense[range.clone()].fill(0);
        for span in inner {
            dense[range.start + span.start as usize..range.start + span.end as usize]
                .fill(span.role as u8 + 1);
        }
    }
    spans_of(&dense, 0)
}

/// Finds what is written in another language below `node`: fenced code with a language, `<script>`
/// and `<style>`, and (Markdown) the ranges the inline grammar reads.
fn collect(
    host: Lang,
    node: tree_sitter::Node,
    text: &str,
    injections: &mut Vec<(Range<usize>, Lang)>,
    inline: &mut Vec<tree_sitter::Range>,
) {
    let kind = node.kind();
    match (host, kind) {
        (Lang::Markdown, "inline" | "pipe_table_cell") => inline.push(node.range()),
        (Lang::Markdown, "fenced_code_block") => {
            let mut language = None;
            let mut content = None;
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                match child.kind() {
                    "info_string" => {
                        language = Some(text[child.start_byte()..child.end_byte()].to_string())
                    }
                    "code_fence_content" => content = Some(child.start_byte()..child.end_byte()),
                    _ => {}
                }
            }
            if let (Some(info), Some(range)) = (language, content)
                && let Some(lang) = Lang::from_name(&info)
            {
                injections.push((range, lang));
            }
            return;
        }
        (Lang::Html, "script_element") | (Lang::Html, "style_element") => {
            let mut cursor = node.walk();
            let mut tag = "";
            let mut raw = None;
            for child in node.children(&mut cursor) {
                match child.kind() {
                    "start_tag" => tag = &text[child.start_byte()..child.end_byte()],
                    "raw_text" => raw = Some(child.start_byte()..child.end_byte()),
                    _ => {}
                }
            }
            if let Some(range) = raw {
                let lang = if kind == "style_element" {
                    Lang::Css
                } else if tag.contains("json") {
                    Lang::Json
                } else if tag.contains("\"ts\"") || tag.contains("typescript") {
                    Lang::TypeScript
                } else {
                    Lang::JavaScript
                };
                injections.push((range, lang));
            }
            return;
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect(host, child, text, injections, inline);
    }
}
