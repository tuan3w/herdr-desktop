;; replace
; Zig: complete query. Later patterns beat earlier ones on the same node, inner nodes beat outer.

; ---- base ----
(identifier) @variable
(builtin_type) @type.builtin
"anyframe" @type.builtin
(comment) @comment
(block_label (identifier) @label)
(break_label (identifier) @label)

; ---- literals ----
(string) @string
(multiline_string) @string
(character) @string
(escape_sequence) @string.escape
(integer) @number
(float) @number
(boolean) @boolean
["null" "undefined" "unreachable"] @constant

; ---- naming conventions: PascalCase is a type, ALL_CAPS a constant ----
((identifier) @type
  (#match? @type "^[A-Z][A-Za-z0-9_]*$"))
((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))
((identifier) @variable.builtin
  (#eq? @variable.builtin "self"))
((identifier) @none
  (#eq? @none "_"))

; ---- declarations ----
(variable_declaration (identifier) @type "=" [(struct_declaration) (enum_declaration) (union_declaration) (opaque_declaration)])
(variable_declaration (identifier) @module (builtin_function (builtin_identifier) @_import (#any-of? @_import "@import" "@cImport")))
(function_declaration name: (identifier) @function.def)
(function_signature name: (identifier) @function.def)
(parameter name: (identifier) @variable.parameter)
((parameter name: (identifier) @variable.builtin)
  (#eq? @variable.builtin "self"))
(parameter type: (identifier) @type)
(payload (identifier) @variable.parameter)
(error_set_declaration (identifier) @constant)

; ---- fields and members ----
(container_field name: (identifier) @property)
(field_expression member: (identifier) @property)
(field_initializer . (identifier) @property)
; .Variant enum literals
(field_expression . member: (identifier) @constant)
(initializer_list (assignment_expression left: (field_expression . member: (identifier) @property)))
(initializer_list (field_initializer . (identifier) @property))
((field_expression member: (identifier) @constant)
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))
((field_expression member: (identifier) @type)
  (#match? @type "^[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$"))

; ---- std and error sets ----
((identifier) @module
  (#eq? @module "std"))
((field_expression object: (identifier) @_s member: (identifier) @module)
  (#eq? @_s "std")
  (#match? @module "^[a-z]"))
((field_expression object: (field_expression object: (identifier) @_s member: (identifier) @module))
  (#eq? @_s "std")
  (#match? @module "^[a-z]"))

; ---- calls ----
(builtin_identifier) @function.macro
(call_expression function: (identifier) @function.call)
(call_expression function: (field_expression member: (identifier) @function.method.call))
; std.debug.print and friends are plain functions of a namespace
((call_expression function: (field_expression object: (identifier) @_root member: (identifier) @function.call))
  (#eq? @_root "std"))
((call_expression function: (field_expression object: (field_expression object: (identifier) @_root) member: (identifier) @function.call))
  (#eq? @_root "std"))
((call_expression function: (field_expression object: (field_expression object: (field_expression object: (identifier) @_root)) member: (identifier) @function.call))
  (#eq? @_root "std"))
; a PascalCase call builds a type
((call_expression function: (identifier) @type)
  (#match? @type "^[A-Z]"))
((call_expression function: (field_expression member: (identifier) @type))
  (#match? @type "^[A-Z]"))

(enum_declaration (container_field type: (identifier) @constant))
(enum_declaration (container_field name: (identifier) @constant))
(error_type (identifier) @constant)

; ---- keywords ----
["if" "else" "switch" "for" "while" "break" "continue" "return" "try" "catch" "defer" "errdefer" "await" "resume"] @keyword.control
["var" "fn" "struct" "union" "enum" "opaque" "test" "error" "asm" "usingnamespace" "and" "or" "orelse"] @keyword
["const" "pub" "export" "extern" "inline" "noinline" "comptime" "packed" "threadlocal" "volatile" "allowzero" "noalias" "align" "callconv" "linksection" "addrspace" "async" "suspend" "nosuspend"] @keyword.modifier
(variable_declaration "const" @keyword)
(comptime_declaration "comptime" @keyword.modifier)

; ---- operators and punctuation ----
["=" "*=" "*%=" "*|=" "/=" "%=" "+=" "+%=" "+|=" "-=" "-%=" "-|=" "<<=" "<<|=" ">>=" "&=" "^=" "|=" "!" "~" "-" "-%" "&" "==" "!=" ">" ">=" "<=" "<" "^" "|" "<<" ">>" "<<|" "+" "++" "+%" "+|" "-|" "*" "/" "%" "**" "*%" "*|" "||" ".*" ".?" "?" ".." "..." "=>"] @operator
["[" "]" "(" ")" "{" "}"] @punctuation.bracket
[";" "." "," ":"] @punctuation.delimiter
(payload "|" @punctuation.bracket)
