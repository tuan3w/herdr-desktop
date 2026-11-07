;; replace
; Lua: complete query. Later patterns beat earlier ones on the same node, inner nodes beat outer.

; ---- base ----
(identifier) @variable
(comment) @comment
(hash_bang_line) @comment

; ---- literals ----
(string) @string
(escape_sequence) @string.escape
(number) @number
[(true) (false)] @boolean
(nil) @constant
(vararg_expression) @constant

; ---- names with a meaning ----
((identifier) @type
  (#match? @type "^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$"))
((identifier) @constant
  (#match? @constant "^[A-Z][A-Z_0-9]+$"))
((identifier) @constant
  (#any-of? @constant "_G" "_ENV" "_VERSION"))
((identifier) @variable.builtin
  (#eq? @variable.builtin "self"))
((dot_index_expression table: (identifier) @module)
  (#any-of? @module "string" "table" "math" "os" "io" "coroutine" "debug" "utf8" "package" "bit32" "jit" "ffi"))
(label_statement) @label
(label_statement (identifier) @label)
(goto_statement (identifier) @label)

; ---- tables and fields ----
(field name: (identifier) @property)
(dot_index_expression field: (identifier) @property)
; metamethod keys: __index, __newindex, __call, ...
((field name: (identifier) @constant)
  (#match? @constant "^__[a-z]+$"))
((dot_index_expression field: (identifier) @constant)
  (#match? @constant "^__[a-z]+$"))

; ---- parameters ----
(parameters (identifier) @variable.parameter)

; ---- definitions ----
(function_declaration name: (identifier) @function.def)
(function_declaration name: (dot_index_expression field: (identifier) @function.def))
(function_declaration name: (method_index_expression method: (identifier) @function.def))
(assignment_statement
  (variable_list . name: (identifier) @function.def)
  (expression_list . value: (function_definition)))
(assignment_statement
  (variable_list . name: (dot_index_expression field: (identifier) @function.def))
  (expression_list . value: (function_definition)))
(table_constructor (field name: (identifier) @function.def value: (function_definition)))

; ---- calls ----
(function_call name: (identifier) @function.call)
(function_call name: (dot_index_expression field: (identifier) @function.call))
(function_call name: (method_index_expression method: (identifier) @function.method.call))
((function_call name: (identifier) @function.builtin)
  (#any-of? @function.builtin
    "assert" "collectgarbage" "dofile" "error" "getfenv" "getmetatable" "ipairs" "load" "loadfile"
    "loadstring" "module" "next" "pairs" "pcall" "print" "rawequal" "rawget" "rawlen" "rawset" "require"
    "select" "setfenv" "setmetatable" "tonumber" "tostring" "type" "unpack" "warn" "xpcall"))

; ---- keywords ----
(attribute (identifier) @keyword.modifier)
["if" "then" "elseif" "else" "for" "while" "do" "repeat" "until" "return" "goto" "in"] @keyword.control
(break_statement) @keyword.control
["function" "local" "global"] @keyword
(do_statement ["do" "end"] @keyword)
(function_declaration "end" @keyword)
(function_definition "end" @keyword)
(if_statement "end" @keyword.control)
(for_statement "end" @keyword.control)
(while_statement "end" @keyword.control)

; ---- operators and punctuation ----
(binary_expression operator: _ @operator)
(unary_expression operator: _ @operator)
"=" @operator
["and" "or" "not"] @keyword
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
(attribute ["<" ">"] @punctuation.bracket)
[";" ":" "," "."] @punctuation.delimiter
