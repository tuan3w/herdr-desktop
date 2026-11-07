//! The TextMate fallback for the long tail: syntect with the grammars nsh already ships (bat's, through
//! two-face), parsed line by line with the parser state kept every few lines so that a block that grew,
//! or was edited at its end, resumes where it stopped. TextMate scopes map to the same [`Role`]s the
//! tree-sitter queries use, so a language that moves between engines keeps its colours.
//!
//! The first block of any language loads the grammar set (about 25 ms) and compiles that grammar's
//! regexes: it belongs on a background thread.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::OnceLock;

use syntect::parsing::{ParseState, Scope, ScopeStack, SyntaxReference, SyntaxSet};

use super::lang::Lang;
use super::role::{Role, Span};

static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();

/// bat's grammars; lines are parsed with their line breaks.
pub fn syntaxes() -> &'static SyntaxSet {
    SYNTAXES.get_or_init(two_face::syntax::extra_newlines)
}

/// The grammar for a fence word or extension (`dockerfile`, `ex`, `hs`, `cs`, `tf`...), by name
/// or extension, case-insensitive, with the names fences use that are neither.
pub fn find(name: &str) -> Option<&'static SyntaxReference> {
    let name = name.trim();
    let alias = match name.to_ascii_lowercase().as_str() {
        "" | "text" | "txt" | "plain" | "plaintext" | "log" | "output" => return None,
        "docker" | "containerfile" => "Dockerfile",
        "c#" | "csharp" => "cs",
        "f#" | "fsharp" => "fs",
        "objective-c" | "objc" => "m",
        "make" | "makefile" => "Makefile",
        "elixir" => "ex",
        "haskell" => "hs",
        "terraform" | "hcl" | "tfvars" => "tf",
        "proto" | "protobuf" => "proto",
        "ps1" | "powershell" | "pwsh" => "ps1",
        "gql" => "graphql",
        "latex" => "tex",
        "nginx" => "nginx",
        "ini" | "cfg" | "conf" | "properties" => "ini",
        _ => name,
    };
    let set = syntaxes();
    set.find_syntax_by_token(alias)
        .filter(|s| s.name != "Plain Text")
}

/// The scope of one token as a role: the innermost scope of the stack that has one.
fn role_of(stack: &ScopeStack) -> Role {
    thread_local! {
        static CACHE: RefCell<HashMap<Scope, Option<Role>>> = RefCell::default();
    }
    let scopes = stack.as_slice();
    let in_call = scopes
        .iter()
        .any(|s| s.build_string().starts_with("meta.function-call"));
    CACHE.with_borrow_mut(|cache| {
        for scope in scopes.iter().rev() {
            let found = *cache
                .entry(*scope)
                .or_insert_with(|| scope_role(&scope.build_string()));
            if let Some(role) = found {
                return if role == Role::FunctionDef && in_call {
                    Role::Function
                } else {
                    role
                };
            }
        }
        Role::Plain
    })
}

/// A TextMate scope as a role; `None` lets an enclosing scope decide.
fn scope_role(scope: &str) -> Option<Role> {
    use Role::*;
    let is = |p: &str| {
        scope
            .strip_prefix(p)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('.'))
    };
    Some(
        if is("comment.block.documentation")
            || is("comment.line.documentation")
            || is("comment.documentation")
            || is("string.quoted.docstring")
        {
            DocComment
        } else if is("comment") || is("punctuation.definition.comment") {
            Comment
        } else if is("string.regexp") {
            Regexp
        } else if is("constant.character.escape") || is("constant.character.entity") {
            Escape
        } else if is("punctuation.section.interpolation")
            || is("punctuation.definition.template-expression")
            || is("punctuation.definition.interpolation")
        {
            Interpolation
        } else if is("punctuation.definition.string") || is("string") {
            String
        } else if is("punctuation.definition.variable") {
            Variable
        } else if is("punctuation.definition.annotation")
            || is("punctuation.definition.decorator")
            || is("meta.annotation")
            || is("meta.decorator")
            || is("storage.type.annotation")
        {
            Decorator
        } else if is("punctuation.definition.heading") {
            Heading
        } else if is("punctuation.definition.bold")
            || is("punctuation.definition.italic")
            || is("punctuation.definition.raw")
            || is("punctuation.definition.list")
            || is("punctuation.definition.quote")
        {
            Markup
        } else if is("punctuation") {
            Punctuation
        } else if is("constant.numeric") {
            Number
        } else if is("constant.language")
            || is("constant.other")
            || is("support.constant")
            || is("variable.other.constant")
            || is("entity.name.constant")
            || is("constant")
        {
            Constant
        } else if is("keyword.operator.word")
            || is("keyword.operator.logical.python")
            || is("keyword.operator.new")
            || is("keyword.operator.expression")
            || is("keyword.operator.delete")
        {
            Keyword
        } else if is("keyword.operator") {
            Operator
        } else if is("keyword.control") {
            Control
        } else if is("keyword.other.special-method") {
            Function
        } else if is("keyword.control.import")
            || is("keyword.other")
            || is("keyword.declaration")
            || is("keyword")
        {
            Keyword
        } else if is("storage.modifier") {
            Modifier
        } else if is("storage.type.function")
            || is("storage.type.class")
            || is("storage.type.struct")
            || is("storage.type.enum")
            || is("storage.type.interface")
            || is("storage.type.trait")
            || is("storage.type.impl")
            || is("storage.type.module")
            || is("storage.type.namespace")
        {
            Keyword
        } else if is("storage.type") {
            TypeBuiltin
        } else if is("storage") {
            Keyword
        } else if is("entity.name.function.preprocessor")
            || is("meta.preprocessor")
            || is("support.macro")
            || is("entity.name.function.macro")
        {
            Macro
        } else if is("entity.name.function") || is("entity.name.method") {
            FunctionDef
        } else if is("support.function") || is("variable.function") {
            Function
        } else if is("entity.name.namespace")
            || is("entity.name.module")
            || is("entity.name.package")
        {
            Namespace
        } else if is("entity.name.tag") {
            Tag
        } else if is("entity.other.attribute-name") {
            Attribute
        } else if is("entity.name.label") {
            Label
        } else if is("entity.name.section") || is("markup.heading") {
            Heading
        } else if is("entity.name.class")
            || is("entity.name.struct")
            || is("entity.name.enum")
            || is("entity.name.interface")
            || is("entity.name.type")
            || is("entity.name.trait")
            || is("entity.other.inherited-class")
            || is("support.class")
        {
            Type
        } else if is("support.type.property-name")
            || is("variable.other.member")
            || is("variable.other.property")
            || is("variable.other.object.property")
            || is("meta.mapping.key")
            || is("entity.name.tag.yaml")
            || is("entity.name.tag.toml")
        {
            Property
        } else if is("support.type") {
            TypeBuiltin
        } else if is("variable.parameter") {
            Parameter
        } else if is("variable.language") {
            SelfValue
        } else if is("variable") || is("support.variable") {
            Variable
        } else if is("markup.bold") {
            Strong
        } else if is("markup.italic") {
            Emphasis
        } else if is("markup.underline.link") || is("markup.link") {
            Link
        } else if is("markup.raw")
            || is("markup.inline.raw")
            || is("markup.list")
            || is("markup.quote")
        {
            Markup
        } else if is("markup.inserted") {
            DiffAdd
        } else if is("markup.deleted") {
            DiffRemove
        } else if is("meta.diff") {
            DiffMeta
        } else if is("invalid") {
            Error
        } else {
            // `meta`, `source` and `text` are containers: an enclosing scope decides.
            return None;
        },
    )
}

/// A parser state to resume from: the first byte of a line.
struct Checkpoint {
    byte: usize,
    parse: ParseState,
    stack: ScopeStack,
}

/// How many lines apart parser states are kept.
const EVERY: usize = 8;

/// A TextMate grammar run over one growing text.
pub struct Tm {
    syntax: &'static SyntaxReference,
    checkpoints: Vec<Checkpoint>,
    text: String,
    spans: Vec<Span>,
}

impl Tm {
    pub fn new(syntax: &'static SyntaxReference) -> Tm {
        Tm {
            syntax,
            checkpoints: Vec::new(),
            text: String::new(),
            spans: Vec::new(),
        }
    }

    /// Highlights `text`, resuming at the last checkpoint before the first line that differs from
    /// the previous text. Returns all spans and the byte range that was parsed again.
    pub fn update(&mut self, text: &str) -> (&[Span], Range<usize>) {
        let set = syntaxes();
        // The first byte that differs, moved back to the start of its line.
        let same = self
            .text
            .as_bytes()
            .iter()
            .zip(text.as_bytes())
            .take_while(|(a, b)| a == b)
            .count();
        let line_start = text[..same.min(text.len())]
            .rfind('\n')
            .map_or(0, |i| i + 1);
        while self.checkpoints.last().is_some_and(|c| c.byte > line_start) {
            self.checkpoints.pop();
        }
        if self.checkpoints.is_empty() {
            self.checkpoints.push(Checkpoint {
                byte: 0,
                parse: ParseState::new(self.syntax),
                stack: ScopeStack::new(),
            });
        }
        let from = self.checkpoints.last().map_or(0, |c| c.byte);
        let (mut parse, mut stack) = self
            .checkpoints
            .last()
            .map(|c| (c.parse.clone(), c.stack.clone()))
            .unwrap_or_else(|| (ParseState::new(self.syntax), ScopeStack::new()));
        self.spans.retain(|s| (s.end as usize) <= from);
        let mut line_no = self.checkpoints.len() * EVERY - EVERY;
        let mut offset = from;
        for line in syntect::util::LinesWithEndings::from(&text[from..]) {
            let Ok(ops) = parse.parse_line(line, set) else {
                break;
            };
            let mut at = 0;
            let push = |stack: &ScopeStack, start: usize, end: usize, spans: &mut Vec<Span>| {
                if start < end {
                    let role = role_of(stack);
                    if role != Role::Plain {
                        // Trailing line breaks carry no colour worth drawing.
                        let piece = &line[start..end];
                        let trimmed = piece.trim_end_matches(['\n', '\r']).len();
                        if trimmed > 0 {
                            push_span(
                                spans,
                                Span::new(offset + start, offset + start + trimmed, role),
                            );
                        }
                    }
                }
            };
            for (pos, op) in ops {
                push(&stack, at, pos, &mut self.spans);
                at = pos;
                let _ = stack.apply(&op);
            }
            push(&stack, at, line.len(), &mut self.spans);
            offset += line.len();
            line_no += 1;
            if line_no.is_multiple_of(EVERY) {
                self.checkpoints.push(Checkpoint {
                    byte: offset,
                    parse: parse.clone(),
                    stack: stack.clone(),
                });
            }
        }
        self.text.clear();
        self.text.push_str(text);
        (&self.spans, from..text.len())
    }
}

/// Appends `span`, joining it to the previous one when they touch and are the same role.
pub(super) fn push_span(spans: &mut Vec<Span>, span: Span) {
    if let Some(last) = spans.last_mut()
        && last.end == span.start
        && last.role == span.role
    {
        last.end = span.end;
        return;
    }
    spans.push(span);
}

/// The grammar names of the tree-sitter languages that TextMate should read instead (`Dockerfile`).
pub fn tm_name(lang: Lang) -> &'static str {
    match lang {
        Lang::Dockerfile => "Dockerfile",
        other => other.label(),
    }
}
