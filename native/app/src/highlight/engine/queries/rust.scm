;; replace
; Rust: complete query. Later patterns beat earlier ones on the same node, inner nodes beat outer.

; ---- base: every identifier is a variable until something says better ----
(identifier) @variable
(metavariable) @variable.parameter
(field_identifier) @property
(shorthand_field_identifier) @variable
(type_identifier) @type
(primitive_type) @type.builtin
(fragment_specifier) @type.builtin

; ---- comments ----
(line_comment) @comment
(block_comment) @comment
(line_comment _ @comment)
(block_comment _ @comment)

; ---- literals ----
(string_literal) @string
(raw_string_literal) @string
(char_literal) @string
(escape_sequence) @string.escape
(integer_literal) @number
(float_literal) @number
(boolean_literal) @boolean

; ---- constants and constructors ----
; ALL_CAPS and CamelCase bare names are constants / enum members / None-like values.
((identifier) @constant
  (#match? @constant "^[A-Z]"))
((identifier) @type
  (#eq? @type "Self"))
(const_item name: (identifier) @constant)
(static_item name: (identifier) @constant)
(const_parameter name: (identifier) @constant)
(enum_variant name: (identifier) @constant)

; ---- functions, methods, macros ----
(function_item name: (identifier) @function.def)
(function_signature_item name: (identifier) @function.def)

(call_expression function: (identifier) @function.call)
; a CamelCase call is a tuple-struct constructor, except the prelude's variants
((call_expression function: (identifier) @type)
  (#match? @type "^[A-Z]"))
((call_expression function: (identifier) @constant)
  (#any-of? @constant "Some" "Ok" "Err"))
(call_expression function: (field_expression field: (field_identifier) @function.method.call))
(call_expression function: (scoped_identifier name: (identifier) @function.call))
(generic_function function: (identifier) @function.call)
(generic_function function: (scoped_identifier name: (identifier) @function.call))
(generic_function function: (field_expression field: (field_identifier) @function.method.call))

(macro_invocation macro: (identifier) @function.macro "!" @function.macro)
(macro_invocation macro: (scoped_identifier name: (identifier) @function.macro) "!" @function.macro)
(macro_definition name: (identifier) @function.macro)
"macro_rules!" @function.macro

; ---- parameters ----
(parameter pattern: (identifier) @variable.parameter)
(parameter pattern: (_ (identifier) @variable.parameter))
(parameter pattern: (_ (_ (identifier) @variable.parameter)))
(closure_parameters (identifier) @variable.parameter)
(closure_parameters (_ (identifier) @variable.parameter))
(closure_parameters (_ (_ (identifier) @variable.parameter)))
(closure_parameters (_ pattern: (identifier) @variable.parameter))
(variadic_parameter pattern: (identifier) @variable.parameter)
(self) @variable.builtin

; ---- paths: namespaces, types, enum members ----
(mod_item name: (identifier) @module)
(scoped_identifier path: (identifier) @module)
(scoped_identifier path: (scoped_identifier name: (identifier) @module))
(scoped_type_identifier path: (identifier) @module)
(scoped_type_identifier path: (scoped_identifier name: (identifier) @module))
(scoped_use_list path: (identifier) @module)
(scoped_use_list path: (scoped_identifier name: (identifier) @module))
(use_declaration argument: (identifier) @module)
(use_list (identifier) @module)
(use_as_clause alias: (identifier) @module)
(use_wildcard (identifier) @module)
(use_wildcard (scoped_identifier name: (identifier) @module))
; the last segment of a path is a module unless it is called or CamelCase
(scoped_identifier name: (identifier) @module)
(scoped_identifier name: (identifier) @type
  (#match? @type "^[A-Z]"))
(scoped_identifier name: (identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))
((scoped_identifier path: (identifier) @_enum name: (identifier) @constant)
  (#match? @_enum "^[A-Z]")
  (#match? @constant "^[A-Z]"))
(scoped_identifier path: (identifier) @type
  (#match? @type "^[A-Z]"))
(scoped_identifier path: (identifier) @type.builtin
  (#any-of? @type.builtin "i8" "i16" "i32" "i64" "i128" "isize" "u8" "u16" "u32" "u64" "u128" "usize" "f32" "f64" "bool" "char" "str"))
(scoped_identifier path: (scoped_identifier name: (identifier) @type)
  (#match? @type "^[A-Z]"))
(scoped_type_identifier path: (identifier) @type
  (#match? @type "^[A-Z]"))
(use_list (identifier) @type
  (#match? @type "^[A-Z]"))
(use_declaration argument: (identifier) @type
  (#match? @type "^[A-Z]"))
(call_expression function: (scoped_identifier name: (identifier) @function.call))
(generic_function function: (scoped_identifier name: (identifier) @function.call))
(macro_invocation macro: (scoped_identifier name: (identifier) @function.macro))
; Enum::Variant { .. } as a struct literal or pattern
(struct_expression name: (scoped_type_identifier
  path: (identifier) @_enum
  name: (type_identifier) @constant)
  (#match? @_enum "^[A-Z]"))
(struct_pattern type: (scoped_type_identifier
  path: (identifier) @_enum
  name: (type_identifier) @constant)
  (#match? @_enum "^[A-Z]"))
(crate) @keyword
(super) @keyword
(use_list (self) @keyword)
(scoped_use_list (self) @keyword)
(scoped_identifier (self) @keyword)

; ---- keywords ----
["if" "else" "match" "loop" "while" "for" "in" "break" "continue" "return" "yield" "await" "try"] @keyword.control
(impl_item "for" @keyword)
(for_lifetimes "for" @keyword)
["let" "fn" "struct" "enum" "trait" "impl" "type" "use" "mod" "as" "union" "dyn" "where" "gen" "static" "const"] @keyword
["pub" "unsafe" "async" "extern" "move" "ref" "default" "raw"] @keyword.modifier
(mutable_specifier) @keyword.modifier
(function_modifiers "const" @keyword.modifier)
(pointer_type "const" @keyword.modifier)

; ---- lifetimes and labels ----
(lifetime) @label
(lifetime (identifier) @label)
(label) @label
(label (identifier) @label)

; ---- operators and punctuation ----
["+" "-" "*" "/" "%" "^" "!" "&" "|" "&&" "||" "<<" ">>" "=" "==" "!=" "<" ">" "<=" ">="
 "+=" "-=" "*=" "/=" "%=" "^=" "&=" "|=" "<<=" ">>=" "@" ".." "..." "..=" "=>" "->" "?"] @operator
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
(type_arguments ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)
(bracketed_type ["<" ">"] @punctuation.bracket)
(closure_parameters "|" @punctuation.bracket)
["::" ":" "." "," ";"] @punctuation.delimiter
(macro_invocation "!" @function.macro)

; ---- inside macro arguments (token trees are not parsed as expressions) ----
(token_tree "." . (identifier) @property)
(token_tree (identifier) @function.call . (token_tree . "("))
(token_tree "." . (identifier) @function.method.call . (token_tree . "("))
(token_tree (identifier) @function.macro . "!" @function.macro)
((token_tree (identifier) @type . "::")
  (#match? @type "^[A-Z]"))
((token_tree (identifier) @module . "::")
  (#match? @module "^[a-z_]"))

(visibility_modifier) @keyword.modifier
(visibility_modifier _ @keyword.modifier)
"$" @punctuation.delimiter

; ---- attributes: the whole item, brackets included (must come last) ----
(attribute_item) @attribute
(inner_attribute_item) @attribute
(attribute_item _ @attribute)
(inner_attribute_item _ @attribute)
(attribute _ @attribute)
(attribute arguments: (token_tree _ @attribute))
(attribute arguments: (token_tree (token_tree _ @attribute)))
(attribute arguments: (token_tree (token_tree (token_tree _ @attribute))))
(attribute arguments: (token_tree (token_tree (token_tree (token_tree _ @attribute)))))

