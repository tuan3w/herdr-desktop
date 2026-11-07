;; replace
; C: complete query, and the base of C++ (cpp.scm only adds to it, so every node used here exists in both grammars).
; Later patterns beat earlier ones on the same node, inner nodes beat outer.

; ---- base ----
(identifier) @variable
(field_identifier) @property
(type_identifier) @type
(primitive_type) @type.builtin
(sized_type_specifier) @type.builtin
(statement_identifier) @label
(comment) @comment

; ---- literals ----
(string_literal) @string
(system_lib_string) @string
(char_literal) @string
(escape_sequence) @string.escape
(number_literal) @number
[(true) (false)] @boolean
(null) @constant

; ---- constants ----
((identifier) @constant
  (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))
(enumerator name: (identifier) @constant)
((identifier) @constant
  (#any-of? @constant "stdin" "stdout" "stderr" "errno"))
; a type name in an expression position, e.g. va_arg(ap, int)
((identifier) @type.builtin
  (#any-of? @type.builtin "int" "char" "short" "long" "float" "double" "unsigned" "signed" "void" "bool"))

; ---- preprocessor ----
["#include" "#define" "#if" "#ifdef" "#ifndef" "#else" "#elif" "#elifdef" "#elifndef" "#endif" "defined"] @keyword.directive
(preproc_directive) @keyword.directive
(preproc_def name: (identifier) @constant)
(preproc_function_def name: (identifier) @function.macro)
(preproc_params (identifier) @variable.parameter)
((preproc_arg) @number
  (#match? @number "^\\s*-?(0[xXbB][0-9a-fA-F']+|[0-9][0-9.eE']*)[uUlLfF]*\\s*$"))
((preproc_arg) @string
  (#match? @string "^\\s*[LuU]?\"[^\"]*\"\\s*$"))
(preproc_ifdef name: (identifier) @constant)
(preproc_elifdef name: (identifier) @constant)

; ---- functions ----
(function_declarator declarator: (identifier) @function.def)
(call_expression function: (identifier) @function.call)
(call_expression function: (field_expression field: (field_identifier) @function.call))
; ALL_CAPS calls are macros
((call_expression function: (identifier) @function.macro)
  (#match? @function.macro "^_*[A-Z][A-Z0-9_]+$"))

((call_expression function: (identifier) @keyword)
  (#any-of? @keyword "_Static_assert" "static_assert"))

; ---- parameters ----
(parameter_declaration declarator: (identifier) @variable.parameter)
(parameter_declaration declarator: (pointer_declarator declarator: (identifier) @variable.parameter))
(parameter_declaration declarator: (pointer_declarator declarator: (pointer_declarator declarator: (identifier) @variable.parameter)))
(parameter_declaration declarator: (array_declarator declarator: (identifier) @variable.parameter))
(parameter_declaration declarator: (pointer_declarator declarator: (array_declarator declarator: (identifier) @variable.parameter)))
(parameter_declaration declarator: (function_declarator declarator: (parenthesized_declarator (pointer_declarator declarator: (identifier) @variable.parameter))))

; ---- keywords ----
["if" "else" "switch" "case" "default" "for" "while" "do" "break" "continue" "return" "goto"] @keyword.control
["typedef" "struct" "union" "enum" "sizeof" "alignof" "_Alignof" "offsetof" "_Generic"] @keyword
(storage_class_specifier) @keyword.modifier
(type_qualifier) @keyword.modifier
(linkage_specification "extern" @keyword.modifier)
(alignas_qualifier "alignas" @keyword)
["__attribute__" "__declspec" "asm" "__asm__"] @keyword

; ---- operators and punctuation ----
["--" "-" "-=" "->" "=" "!=" "*" "*=" "&" "&&" "&=" "+" "++" "+=" "<" "<=" "<<" "<<=" "==" ">" ">=" ">>" ">>=" "||" "|" "|=" "^" "^=" "%" "%=" "/" "/=" "!" "~"] @operator
(conditional_expression ["?" ":"] @operator)
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["," ";" ":" "..."] @punctuation.delimiter
(field_expression operator: _ @punctuation.delimiter)
(field_expression "." @punctuation.delimiter)
(field_designator "." @punctuation.delimiter)

; ---- attributes (whole thing; must come last) ----
(attribute_specifier) @attribute
(attribute_declaration) @attribute
(attribute_specifier _ @attribute)
(attribute_specifier (argument_list _ @attribute))
(attribute_declaration _ @attribute)
(attribute_declaration (attribute _ @attribute))
(attribute_declaration (attribute (argument_list _ @attribute)))
(ms_declspec_modifier) @attribute
