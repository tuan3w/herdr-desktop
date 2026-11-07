;; replace
;; Dart. Later patterns beat earlier ones on the same node; inner nodes beat outer ones.

; ---- names: generic, then naming conventions -----------------------------------------------------

(identifier) @variable

; UpperCamelCase names are classes (`Entry(...)`, `Level.debug`); ALL_CAPS names are constants.
((identifier) @type
  (#match? @type "^_?[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$"))
((identifier) @constant
  (#match? @constant "^_?[A-Z][A-Z0-9_]+$"))

; ---- comments and literals -----------------------------------------------------------------------

(comment) @comment
(block_comment) @comment
(documentation_comment) @comment.documentation
(documentation_block_comment) @comment.documentation

[(decimal_integer_literal) (hex_integer_literal) (decimal_floating_point_literal)] @number
[(true) (false) (null_literal)] @constant
(symbol_literal) @constant

(string_literal) @string
(uri) @string
(library_export uri: (configurable_uri) @string)
(escape_sequence) @string.escape

; `$name` and `${expr}`: the delimiters are interpolation, the expression is code.
(template_substitution) @none
(template_substitution (identifier_dollar_escaped) @variable)
(template_substitution (identifier) @variable)

; ---- types ---------------------------------------------------------------------------------------

(type_identifier) @type
(void_type) @type.builtin
"Function" @type.builtin
"dynamic" @type.builtin
(type_parameter (type_identifier) @type)
((type_identifier) @type.builtin
  (#any-of? @type.builtin "int" "double" "num" "String" "bool" "List" "Set" "Map" "Runes" "Symbol" "Future" "Stream" "Iterable" "Never" "dynamic" "Object" "Null" "Record" "Type" "Function" "FutureOr"))

; ---- functions and methods -----------------------------------------------------------------------

(function_signature name: (identifier) @function.def)
(getter_signature name: (identifier) @function.def)
(setter_signature name: (identifier) @function.def)
(method_signature (function_signature name: (identifier) @function.def))
(method_signature (getter_signature name: (identifier) @function.def))
(method_signature (setter_signature name: (identifier) @function.def))

(constructor_signature name: (identifier) @type)
(constant_constructor_signature name: (identifier) @type)
(factory_constructor_signature name: (identifier) @type)
(redirecting_factory_constructor_signature name: (identifier) @type)
(primary_constructor name: (identifier) @type)
; The second name of `Circle.unit()` / `factory Circle.from()` names the constructor.
(constructor_signature "." . (identifier) @function.def)
(constant_constructor_signature "." . (identifier) @function.def)
(factory_constructor_signature "." . (identifier) @function.def)
(redirecting_factory_constructor_signature "." . (identifier) @function.def)

(call_expression function: (identifier) @function.call)
(call_expression function: (member_expression property: (identifier) @function.method.call))
(call_expression function: (null_aware_member_expression property: (identifier) @function.method.call))
(cascade_call_expression property: (identifier) @function.method.call)
(call_expression function: (static_member_shorthand (identifier) @function.method.call))
; A class instantiated without `new`: `StateError(...)`, `Entry(...)`.
(call_expression function: (identifier) @type
  (#match? @type "^_?[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$"))
(constructor_invocation constructor: (identifier) @function.method.call)
(const_object_expression constructor: (identifier) @function.method.call)
(new_expression constructor: (identifier) @function.method.call)

; ---- members -------------------------------------------------------------------------------------

[
  (member_expression)
  (null_aware_member_expression)
  (cascade_member_expression)
  (cascade_null_aware_member_expression)
] property: (identifier) @property
(call_expression function: (member_expression property: (identifier) @function.method.call))
(call_expression function: (null_aware_member_expression property: (identifier) @function.method.call))
(cascade_call_expression property: (identifier) @function.method.call)
(member_expression property: (identifier) @constant
  (#match? @constant "^_?[A-Z][A-Z0-9_]+$"))
(null_aware_member_expression property: (identifier) @constant
  (#match? @constant "^_?[A-Z][A-Z0-9_]+$"))
(static_member_shorthand (identifier) @property)
(record_field (label (identifier) @property))
(object_pattern (label (identifier) @property))
(record_pattern (label (identifier) @property))
(extension_type_representation name: (identifier) @property)

; ---- declarations --------------------------------------------------------------------------------

(class_declaration name: (identifier) @type)
(mixin_declaration (identifier) @type)
(extension_declaration name: (identifier) @type)
(extension_type_declaration name: (extension_type_name (identifier) @type))
(enum_declaration name: (identifier) @type)
(enum_entry name: (identifier) @constant)
(type_alias (type_identifier) @type)
(import_specification alias: (identifier) @namespace)
(library_name (dotted_identifier_list (identifier) @namespace))
(part_of_directive (dotted_identifier_list (identifier) @namespace))

; ---- parameters ----------------------------------------------------------------------------------

(formal_parameter (identifier) @variable.parameter)
(field_formal_parameter (identifier) @variable.parameter)
(super_formal_parameter (identifier) @variable.parameter)
(named_argument (label (identifier) @variable.parameter))

; ---- keywords ------------------------------------------------------------------------------------

[
  "class" "enum" "export" "extends" "extension" "implements" "import" "library" "mixin" "new" "part"
  "typedef" "with" "get" "set" "operator" "var" "hide" "show" "deferred" "of" "type" "augment" "is" "as"
] @keyword
[
  "abstract" "base" "const" "covariant" "external" "factory" "final" "inline" "interface" "late"
  "native" "required" "sealed" "static" "inout" "out"
] @keyword.modifier
[
  "assert" "break" "case" "catch" "continue" "default" "do" "else" "finally" "for" "if" "in" "on"
  "rethrow" "return" "switch" "throw" "try" "when" "while" "async" "async*" "sync*"
] @keyword.control
(mixin_declaration "on" @keyword)
(extension_declaration "on" @keyword)
(await_expression "await" @keyword.control)
(yield_statement "yield" @keyword.control)
(yield_each_statement "yield" @keyword.control)
(is_operator) @keyword
(type_cast "as" @keyword)
(cast_pattern "as" @keyword)
(import_specification "as" @keyword)
(extension_type_declaration "type" @keyword)

"this" @variable.builtin
"super" @variable.builtin
((identifier) @variable.builtin
  (#any-of? @variable.builtin "this" "super"))

; ---- operators and punctuation -------------------------------------------------------------------

[
  (relational_operator) (prefix_operator) (negation_operator) (binary_operator) (additive_operator)
  (multiplicative_operator) (shift_operator) (equality_operator) (bitwise_operator) (increment_operator)
] @operator
["=" "+=" "-=" "*=" "/=" "%=" "~/=" "<<=" ">>=" ">>>=" "&=" "^=" "|=" "??=" "==" "+" "-" "*" "/" "%" "~/"
 "<<" ">>" ">>>" "&" "^" "|" "&&" "||" "??" "!" "~" ".." "?.." "..." "...?" "=>" "?"] @operator

["(" ")" "[" "]" "{" "}"] @punctuation.bracket
(type_arguments ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)
["," ";" ":" "." "?."] @punctuation.delimiter
"#" @punctuation.special

(template_substitution ["$" "{" "}"] @string.interpolation)

; ---- annotations: the whole `@name(args)` --------------------------------------------------------

(annotation) @attribute
(annotation "@" @attribute)
(annotation name: (identifier) @attribute)
(annotation name: (qualified_name (type_identifier) @attribute))
(annotation name: (qualified_name (identifier) @attribute))
(annotation (type_arguments ["<" ">"] @attribute))
(annotation (type_arguments (type (type_identifier) @attribute)))
(annotation_open_paren) @attribute
(annotation_arguments ")" @attribute)
(annotation_arguments "," @attribute)
(annotation_arguments (identifier) @attribute)
(annotation_arguments [(string_literal) (decimal_integer_literal) (decimal_floating_point_literal) (true) (false) (null_literal)] @attribute)
(annotation_arguments (named_argument (label (identifier) @attribute)))
(annotation_arguments (named_argument (label ":" @attribute)))
(annotation_arguments (named_argument [(identifier) (string_literal) (decimal_integer_literal) (decimal_floating_point_literal) (true) (false) (null_literal)] @attribute))
