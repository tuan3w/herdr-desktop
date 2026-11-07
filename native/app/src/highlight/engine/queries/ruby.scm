;; replace
;; Ruby. Later patterns beat earlier ones on the same node; inner nodes beat outer ones.

; ---- names ---------------------------------------------------------------------------------------

(identifier) @variable

; A name that ends in ? or ! is a method even when written bare.
((identifier) @function.method.call
  (#match? @function.method.call "[?!]$"))

(constant) @type
((constant) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))

[(instance_variable) (class_variable)] @property
(global_variable) @variable

(self) @variable.builtin
(super) @variable.builtin
(nil) @constant
[(true) (false)] @constant
[(file) (line) (encoding)] @constant.builtin
((identifier) @constant.builtin
  (#match? @constant.builtin "^__(FILE|LINE|ENCODING|method|dir__)__?$"))

; ---- literals ------------------------------------------------------------------------------------

[(integer) (float) (rational) (complex)] @number
(comment) @comment

[(simple_symbol) (delimited_symbol) (bare_symbol) (symbol_array)] @constant
(string) @string
(bare_string) @string
(chained_string) @string
(character) @string
(subshell) @string
(string_array) @string
(heredoc_beginning) @string
(heredoc_body) @string
(heredoc_end) @string
(escape_sequence) @string.escape
(regex) @string.regexp
(regex (escape_sequence) @string.regexp)

; `#{ ... }`: the delimiters, the code inside is code.
(interpolation) @none
(interpolation ["#{" "}"] @string.interpolation)

; ---- keywords ------------------------------------------------------------------------------------

["def" "class" "module" "alias" "undef" "BEGIN" "END" "defined?"] @keyword
["and" "or" "not"] @keyword
["if" "elsif" "else" "unless" "while" "until" "for" "case" "when" "then" "in" "begin" "rescue" "ensure"
 "return" "next" "break" "redo" "retry" "yield"] @keyword.control
(do_block "do" @keyword)
(do "do" @keyword.control)
(do_block "end" @keyword)
(method "end" @keyword)
(singleton_method "end" @keyword)
(class "end" @keyword)
(module "end" @keyword)
(singleton_class "end" @keyword)
(singleton_class "class" @keyword)
(do "end" @keyword.control)
(if "end" @keyword.control)
(unless "end" @keyword.control)
(case "end" @keyword.control)
(case_match "end" @keyword.control)
(begin "end" @keyword.control)
(if_modifier "if" @keyword.control)
(unless_modifier "unless" @keyword.control)
(while_modifier "while" @keyword.control)
(until_modifier "until" @keyword.control)
(rescue_modifier "rescue" @keyword.control)

; ---- operators and punctuation -------------------------------------------------------------------

(binary operator: _ @operator)
(unary operator: _ @operator)
(operator_assignment operator: _ @operator)
["=" "=>" "->" "!" "?" ".." "..." "~"] @operator
(conditional ":" @operator)
(superclass "<" @operator)
(splat_argument "*" @operator)
(hash_splat_argument "**" @operator)
(block_argument "&" @operator)

["(" ")" "[" "]" "{" "}" "%w(" "%i("] @punctuation.bracket
["," ";" "." "::" "&." ":"] @punctuation.delimiter
(block_parameters "|" @punctuation.bracket)

; ---- definitions ---------------------------------------------------------------------------------

(method name: (_) @function.def)
(singleton_method name: (_) @function.def)
(setter (identifier) @function.def)
(alias name: (_) @function.def alias: (_) @function.def)

(class name: (constant) @type)
(class name: (scope_resolution name: (constant) @type))
(superclass (constant) @type)
(superclass (scope_resolution name: (constant) @type))
(module name: (constant) @namespace)
(module name: (scope_resolution name: (constant) @namespace))

; ---- calls ---------------------------------------------------------------------------------------

(call !receiver method: [(identifier) (constant)] @function.call)
(call receiver: (_) method: [(identifier) (constant)] @function.method.call)

; Class-level declarations: attr_*, include, ... are macros; private & co. are modifiers.
(call !receiver method: (identifier) @function.macro
  (#any-of? @function.macro "attr_reader" "attr_writer" "attr_accessor" "attr" "include" "extend" "prepend" "alias_method" "define_method" "delegate" "scope" "has_many" "has_one" "belongs_to" "validates" "before_action" "after_action"))
((identifier) @keyword.modifier
  (#any-of? @keyword.modifier "private" "protected" "public" "module_function" "private_class_method" "public_class_method" "private_constant"))
(call !receiver method: (identifier) @keyword.modifier
  (#any-of? @keyword.modifier "private" "protected" "public" "module_function" "private_class_method" "public_class_method" "private_constant"))
(call !receiver method: (identifier) @keyword.control
  (#any-of? @keyword.control "raise" "fail" "throw" "catch" "loop"))
((identifier) @keyword.control
  (#any-of? @keyword.control "raise" "fail" "loop"))

; ---- scopes and constants ------------------------------------------------------------------------

(scope_resolution scope: (constant) @namespace)
(scope_resolution scope: (scope_resolution name: (constant) @namespace))
(scope_resolution scope: (scope_resolution scope: (constant) @namespace))
(scope_resolution name: (constant) @type)
(scope_resolution name: (constant) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))

; ---- parameters ----------------------------------------------------------------------------------

(method_parameters (identifier) @variable.parameter)
(lambda_parameters (identifier) @variable.parameter)
(block_parameters (identifier) @variable.parameter)
(destructured_parameter (identifier) @variable.parameter)
(optional_parameter name: (identifier) @variable.parameter)
(keyword_parameter name: (identifier) @variable.parameter)
(splat_parameter "*" @variable.parameter (identifier) @variable.parameter)
(hash_splat_parameter "**" @variable.parameter (identifier) @variable.parameter)
(block_parameter "&" @variable.parameter (identifier) @variable.parameter)

; `key: value`: a keyword argument in a call, a key in a hash literal.
(hash (pair key: (hash_key_symbol) @property))
(hash (pair key: (simple_symbol) @property))
(argument_list (pair key: (hash_key_symbol) @variable.parameter))
(call arguments: (argument_list (pair key: (hash_key_symbol) @variable.parameter)))
(keyword_pattern key: (hash_key_symbol) @property)
