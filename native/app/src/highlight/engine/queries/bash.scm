;; replace
;; Bash. Later patterns beat earlier ones on the same node; inner nodes beat outer ones.

(comment) @comment

; ---- commands ------------------------------------------------------------------------------------

; The first word of a command: a program or a shell builtin.
(command name: (command_name (word) @function.call))
(command name: (command_name (string) @function.call))
(command name: (command_name (simple_expansion) @function.call))
; `[` is the test builtin, written as brackets.
(command name: (command_name (word) @punctuation.bracket)
  (#eq? @punctuation.bracket "["))
((word) @punctuation.bracket
  (#eq? @punctuation.bracket "]"))
; Builtins that leave the flow of the script.
(command name: (command_name (word) @keyword.control)
  (#any-of? @keyword.control "exit" "return" "break" "continue" "exec"))

; Flags: `-x`, `--long`, `-euo`, `--include=` (the word before an `=` and its value).
((command argument: (word) @variable.parameter)
  (#match? @variable.parameter "^-"))
((command argument: (concatenation . (word) @variable.parameter))
  (#match? @variable.parameter "^-"))
((declaration_command (word) @variable.parameter)
  (#match? @variable.parameter "^[-+]"))
((unset_command (word) @variable.parameter)
  (#match? @variable.parameter "^-"))

; ---- words that are numbers ----------------------------------------------------------------------

(number) @number
(file_descriptor) @number
((word) @number
  (#match? @number "^[0-9][0-9_]*(\\.[0-9]+)?$"))

; ---- strings and heredocs ------------------------------------------------------------------------

[(string) (raw_string) (ansi_c_string) (translated_string)] @string
[(heredoc_start) (heredoc_body) (heredoc_end)] @string
(regex) @string.regexp

; ---- variables and expansions --------------------------------------------------------------------

(variable_name) @variable
(simple_expansion) @variable
(variable_assignment name: (variable_name) @variable)
(variable_assignment name: (subscript name: (variable_name) @variable))
(for_statement variable: (variable_name) @variable)
(declaration_command (variable_name) @variable)
(unset_command (variable_name) @variable)
(c_style_for_statement (variable_name) @variable)

; ALL_CAPS names are environment-style constants.
((simple_expansion) @constant
  (#match? @constant "^\\$[A-Z_][A-Z0-9_]+$"))
((variable_name) @constant
  (#match? @constant "^[A-Z_][A-Z0-9_]+$"))

; `${ ... }`: the delimiters; the parameter name and operators inside are code.
(expansion) @none
(expansion (variable_name) @variable)
((expansion (variable_name) @constant)
  (#match? @constant "^[A-Z_][A-Z0-9_]+$"))
(expansion (special_variable_name) @variable)
(expansion (subscript name: (variable_name) @variable))
(expansion (string) @string)
(expansion (raw_string) @string)
(expansion (simple_expansion) @variable)
(expansion operator: _ @operator)
(command_substitution) @none
(process_substitution) @none
(arithmetic_expansion) @none

; ---- keywords ------------------------------------------------------------------------------------

["function" "declare" "typeset" "unset" "unsetenv" "select"] @keyword
["local" "readonly" "export"] @keyword.modifier
["if" "then" "elif" "else" "fi" "for" "in" "do" "done" "while" "until" "case" "esac"] @keyword.control

; ---- definitions ---------------------------------------------------------------------------------

(function_definition name: (word) @function.def)

; ---- operators and punctuation -------------------------------------------------------------------

["=" "+=" "==" "!=" "=~" "<" ">" ">>" "<<" "<<-" "<<<" ">&" "<&" ">|" "&>" "&>>" "<&-" ">&-" "|" "|&" "&&" "||" "!" "-a" "-o"
 "+" "-" "*" "/" "%" "**" "++" "--" "<=" ">=" "?" ":" "~" "^" "&" "|=" "<<=" ">>=" "&=" "^=" "*=" "/=" "%=" "-=" "^^" ",,"] @operator
(test_operator) @operator
(binary_expression operator: _ @operator)
(unary_expression operator: _ @operator)
(postfix_expression operator: _ @operator)

["(" ")" "((" "))" "[" "]" "[[" "]]" "{" "}"] @punctuation.bracket
[";" ";;" ";&" ";;&"] @punctuation.delimiter

(expansion ["${" "}"] @string.interpolation)
(command_substitution ["$(" ")" "`"] @string.interpolation)
(process_substitution ["<(" ">(" ")"] @string.interpolation)
(arithmetic_expansion ["$((" "))" "$["] @string.interpolation)
(expansion (regex) @none)
(postfix_expression (word) @variable)
(arithmetic_expansion (binary_expression left: (word) @variable))
(arithmetic_expansion (binary_expression right: (word) @variable))
(c_style_for_statement (binary_expression left: (word) @variable))
(c_style_for_statement (binary_expression right: (word) @variable))
