;; replace
; Go: complete query. Later patterns beat earlier ones on the same node, inner nodes beat outer.

; ---- base ----
(identifier) @variable
(field_identifier) @property
(type_identifier) @type
(package_identifier) @module
(label_name) @label
(comment) @comment

; ---- literals ----
(interpreted_string_literal) @string
(raw_string_literal) @string
(rune_literal) @string
(escape_sequence) @string.escape
[(int_literal) (float_literal) (imaginary_literal)] @number
[(true) (false)] @boolean
[(nil) (iota)] @constant.builtin

; ---- types ----
((type_identifier) @type.builtin
  (#any-of? @type.builtin
    "bool" "string" "error" "any" "comparable" "byte" "rune" "uintptr"
    "int" "int8" "int16" "int32" "int64" "uint" "uint8" "uint16" "uint32" "uint64"
    "float32" "float64" "complex64" "complex128"))
(type_parameter_declaration name: (identifier) @type)

; ---- constants ----
((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))
(const_spec name: (identifier) @constant)

; ---- functions and methods ----
(function_declaration name: (identifier) @function.def)
(method_declaration name: (field_identifier) @function.def)
(method_elem name: (field_identifier) @function.def)

(call_expression function: (identifier) @function.call)
(call_expression function: (selector_expression field: (field_identifier) @function.method.call))
(call_expression function: (parenthesized_expression (identifier) @function.call))
((call_expression function: (identifier) @function.builtin)
  (#any-of? @function.builtin
    "append" "cap" "clear" "close" "complex" "copy" "delete" "imag" "len" "make" "max" "min" "new" "panic" "print" "println" "real" "recover"))
; conversions to builtin types look like calls
((call_expression function: (identifier) @type.builtin)
  (#any-of? @type.builtin
    "bool" "string" "byte" "rune" "uintptr" "any"
    "int" "int8" "int16" "int32" "int64" "uint" "uint8" "uint16" "uint32" "uint64"
    "float32" "float64" "complex64" "complex128"))
; a standard-library package used as a qualifier
((selector_expression operand: (identifier) @module)
  (#any-of? @module
    "fmt" "os" "io" "errors" "strings" "strconv" "time" "sync" "context" "http" "json" "bytes" "bufio"
    "sort" "math" "log" "slog" "filepath" "regexp" "reflect" "atomic" "rand" "runtime" "testing" "utf8"
    "unicode" "signal" "flag" "slices" "maps" "cmp" "ioutil" "syscall" "sql" "xml" "csv" "base64" "exec"))

((call_expression function: (selector_expression operand: (identifier) @_pkg field: (field_identifier) @function.call))
  (#any-of? @_pkg
    "fmt" "os" "io" "errors" "strings" "strconv" "time" "sync" "context" "http" "json" "bytes" "bufio"
    "sort" "math" "log" "slog" "filepath" "regexp" "reflect" "atomic" "rand" "runtime" "testing" "utf8"
    "unicode" "signal" "flag" "slices" "maps" "cmp" "ioutil" "syscall" "sql" "xml" "csv" "base64" "exec"))
((identifier) @none
  (#eq? @none "_"))

; ---- parameters, receivers, fields ----
(parameter_declaration name: (identifier) @variable.parameter)
(variadic_parameter_declaration name: (identifier) @variable.parameter)
(method_declaration receiver: (parameter_list (parameter_declaration name: (identifier) @variable.builtin)))
(field_declaration name: (field_identifier) @property)
(keyed_element key: (literal_element (identifier) @property))
(field_declaration tag: (_) @attribute)

; ---- keywords ----
["if" "else" "for" "range" "switch" "case" "default" "select" "break" "continue" "return" "go" "defer" "goto" "fallthrough"] @keyword.control
["package" "import" "func" "type" "var" "const" "struct" "interface" "map" "chan"] @keyword

; ---- operators and punctuation ----
["--" "-" "-=" ":=" "!" "!=" "..." "*" "*=" "/" "/=" "&" "&&" "&=" "&^" "&^=" "%" "%=" "^" "^=" "+" "++" "+=" "<-" "<" "<<" "<<=" "<=" "=" "==" ">" ">=" ">>" ">>=" "|" "|=" "||" "~"] @operator
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["." "," ";" ":"] @punctuation.delimiter
