//! What a span of code is, for colouring: one closed list the theme (`lib/theme/code.ts`) gives a colour
//! per appearance and the renderer gives a weight. Both engines (tree-sitter, TextMate) end here, so a
//! language that moves from one to the other keeps its colours.

/// A kind of token. The order is the wire order (`as u8`); `lib/theme/code.ts` lists the same names in
/// the same order and a test on each side pins the count.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum Role {
    /// Identifiers and everything else without a role of its own: the code's own colour.
    Plain = 0,
    Comment,
    /// `///`, `/** */`, docstrings.
    DocComment,
    /// `TODO`, `FIXME`, `NOTE`, `HACK`, `XXX` inside a comment.
    Todo,
    /// `fn`, `let`, `class`, `import`, `def`: what declares or brings in.
    Keyword,
    /// `if`, `for`, `return`, `match`, `await`: what steers the flow.
    Control,
    /// `pub`, `static`, `async`, `mut`, `const`, `readonly`: a declaration's adjectives.
    Modifier,
    Operator,
    Punctuation,
    /// A call: `parse(x)`.
    Function,
    /// The name in a declaration: `fn parse`.
    FunctionDef,
    /// A call through a receiver: `x.parse()`.
    Method,
    /// `println!`, `#define`d names, preprocessor lines.
    Macro,
    /// Classes, structs, interfaces, enums, aliases and where they are named.
    Type,
    /// `int`, `string`, `u32`: the language's own types.
    TypeBuiltin,
    /// `true`, `null`, `nil`, `None`, and constants by name.
    Constant,
    Number,
    String,
    /// `\n`, `\u00e9`, `{{`.
    Escape,
    Regexp,
    /// `${`, `}` and `#{` around a value in a string.
    Interpolation,
    /// A field or a key: `obj.name`, `{ name: 1 }`, YAML and JSON keys.
    Property,
    Variable,
    Parameter,
    /// `this`, `self`, `super`, `cls`.
    SelfValue,
    /// A module or package path: `std::fmt`, `package main`.
    Namespace,
    /// An HTML or JSX tag name.
    Tag,
    /// An attribute name of a tag, or an annotation's argument name.
    Attribute,
    /// `@Injectable`, `#[derive]`, `@dataclass`.
    Decorator,
    /// A `goto` label, a lifetime (`'a`), a CSS at-rule name.
    Label,
    /// Markdown headings and section names.
    Heading,
    /// Markdown `_emphasis_`.
    Emphasis,
    /// Markdown `**strong**`.
    Strong,
    /// URLs and link text.
    Link,
    /// Markdown inline code, list markers, rules and quote bars: markup's own marks.
    Markup,
    /// A diff's added line.
    DiffAdd,
    /// A diff's removed line.
    DiffRemove,
    /// `@@ -1,4 +1,5 @@` and `diff --git`, `index`, `---`, `+++`.
    DiffMeta,
    /// What the grammar could not read.
    Error,
}

impl Role {
    /// How many roles there are.
    pub const COUNT: usize = Role::Error as usize + 1;

    /// Every role in wire order.
    pub const ALL: [Role; Role::COUNT] = [
        Role::Plain,
        Role::Comment,
        Role::DocComment,
        Role::Todo,
        Role::Keyword,
        Role::Control,
        Role::Modifier,
        Role::Operator,
        Role::Punctuation,
        Role::Function,
        Role::FunctionDef,
        Role::Method,
        Role::Macro,
        Role::Type,
        Role::TypeBuiltin,
        Role::Constant,
        Role::Number,
        Role::String,
        Role::Escape,
        Role::Regexp,
        Role::Interpolation,
        Role::Property,
        Role::Variable,
        Role::Parameter,
        Role::SelfValue,
        Role::Namespace,
        Role::Tag,
        Role::Attribute,
        Role::Decorator,
        Role::Label,
        Role::Heading,
        Role::Emphasis,
        Role::Strong,
        Role::Link,
        Role::Markup,
        Role::DiffAdd,
        Role::DiffRemove,
        Role::DiffMeta,
        Role::Error,
    ];

    /// The token the theme names it by (`code-<name>`).
    pub const fn name(self) -> &'static str {
        match self {
            Role::Plain => "plain",
            Role::Comment => "comment",
            Role::DocComment => "doc",
            Role::Todo => "todo",
            Role::Keyword => "keyword",
            Role::Control => "control",
            Role::Modifier => "modifier",
            Role::Operator => "operator",
            Role::Punctuation => "punctuation",
            Role::Function => "function",
            Role::FunctionDef => "function-def",
            Role::Method => "method",
            Role::Macro => "macro",
            Role::Type => "type",
            Role::TypeBuiltin => "type-builtin",
            Role::Constant => "constant",
            Role::Number => "number",
            Role::String => "string",
            Role::Escape => "escape",
            Role::Regexp => "regexp",
            Role::Interpolation => "interpolation",
            Role::Property => "property",
            Role::Variable => "variable",
            Role::Parameter => "parameter",
            Role::SelfValue => "self",
            Role::Namespace => "namespace",
            Role::Tag => "tag",
            Role::Attribute => "attribute",
            Role::Decorator => "decorator",
            Role::Label => "label",
            Role::Heading => "heading",
            Role::Emphasis => "emphasis",
            Role::Strong => "strong",
            Role::Link => "link",
            Role::Markup => "markup",
            Role::DiffAdd => "diff-add",
            Role::DiffRemove => "diff-remove",
            Role::DiffMeta => "diff-meta",
            Role::Error => "error",
        }
    }

    /// The role from its wire number (anything past the list is plain).
    pub fn from_u8(n: u8) -> Role {
        Role::ALL
            .get(usize::from(n))
            .copied()
            .unwrap_or(Role::Plain)
    }

    /// Whether the renderer draws it bold.
    pub const fn bold(self) -> bool {
        matches!(self, Role::Heading | Role::Strong | Role::FunctionDef)
    }

    /// Whether the renderer draws it slanted.
    pub const fn italic(self) -> bool {
        matches!(self, Role::Emphasis)
    }

    /// Whether the renderer underlines it.
    pub const fn underline(self) -> bool {
        matches!(self, Role::Link)
    }
}

/// A coloured run: bytes `start..end` of the text are `role`. A highlighter returns these sorted and
/// not overlapping; bytes between spans are [`Role::Plain`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
    pub role: Role,
}

impl Span {
    pub fn new(start: usize, end: usize, role: Role) -> Span {
        Span {
            start: start as u32,
            end: end as u32,
            role,
        }
    }

    pub fn range(&self) -> std::ops::Range<usize> {
        self.start as usize..self.end as usize
    }
}
