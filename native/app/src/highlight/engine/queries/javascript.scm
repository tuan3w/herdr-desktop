;; replace
;; JavaScript core, shared by the javascript, typescript and tsx grammars: only nodes and tokens
;; that exist in all three. Later patterns win over earlier ones for the same node.

;; ---- names -----------------------------------------------------------------------------------
(identifier) @variable
(shorthand_property_identifier_pattern) @variable
(property_identifier) @property
(shorthand_property_identifier) @property
(private_property_identifier) @property
(statement_identifier) @label

;; PascalCase reads as a type / class / component; ALL_CAPS as a constant.
((identifier) @type
  (#match? @type "^[A-Z]"))
([(identifier) (shorthand_property_identifier) (shorthand_property_identifier_pattern)] @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))
((identifier) @constant.builtin
  (#any-of? @constant.builtin "NaN" "Infinity"))
((identifier) @variable.builtin
  (#eq? @variable.builtin "arguments"))

;; Enum-like and constant-like members: Level.Debug, Number.MAX_SAFE_INTEGER, Math.PI.
(member_expression
  object: (identifier) @_obj
  property: (property_identifier) @constant
  (#match? @_obj "^[A-Z]")
  (#match? @constant "^[A-Z]"))

;; Namespace-like globals.
((identifier) @module
  (#any-of? @module "Math" "JSON" "Reflect" "Intl" "Atomics" "WebAssembly"))
(member_expression
  object: (identifier) @module
  (#any-of? @module "console" "window" "document" "globalThis" "process" "navigator" "module" "exports"))

(this) @variable.builtin
(super) @variable.builtin

;; ---- functions -------------------------------------------------------------------------------
(call_expression
  function: (identifier) @function.call
  (#not-match? @function.call "^[A-Z]"))
(call_expression
  function: (member_expression
    property: (property_identifier) @function.method.call))
(call_expression
  function: (member_expression
    property: (private_property_identifier) @function.method.call))
(call_expression
  function: (member_expression
    object: (identifier) @_o
    property: (property_identifier) @type
    (#match? @_o "^[A-Z]")
    (#match? @type "^[A-Z]")))
(call_expression
  function: (parenthesized_expression (identifier) @function.call))

;; class A extends ns.Base
(_ "extends" . (member_expression object: (identifier) @module property: (property_identifier) @type))
(new_expression
  constructor: (identifier) @type)
(new_expression
  constructor: (member_expression
    object: (identifier) @module
    property: (property_identifier) @type))

(function_expression name: (identifier) @function.def)
(function_declaration name: (identifier) @function.def)
(generator_function name: (identifier) @function.def)
(generator_function_declaration name: (identifier) @function.def)
(method_definition name: (property_identifier) @function.method.def)
(method_definition name: (private_property_identifier) @function.method.def)
(pair
  key: (property_identifier) @function.method.def
  value: [(function_expression) (arrow_function) (generator_function)])
(assignment_expression
  left: (member_expression property: (property_identifier) @function.method.def)
  right: [(function_expression) (arrow_function)])
(variable_declarator
  name: (identifier) @function.def
  value: [(function_expression) (arrow_function) (generator_function)])
(assignment_expression
  left: (identifier) @function.def
  right: [(function_expression) (arrow_function)])
;; class fields holding functions (field_definition in javascript, public_field_definition in typescript)
(_
  property: (property_identifier) @function.method.def
  value: [(function_expression) (arrow_function)])

;; ---- parameters ------------------------------------------------------------------------------
(formal_parameters
  (_) @variable.parameter
  (#match? @variable.parameter "^[A-Za-z_$][A-Za-z0-9_$]*$"))
(formal_parameters (_ left: (identifier) @variable.parameter))
(formal_parameters (_ (rest_pattern (identifier) @variable.parameter)))
(formal_parameters (_ (shorthand_property_identifier_pattern) @variable.parameter))
(formal_parameters (_ (_ (shorthand_property_identifier_pattern) @variable.parameter)))
(formal_parameters (_ "..." . (identifier) @variable.parameter))
(formal_parameters (_ (pair_pattern value: (identifier) @variable.parameter)))
(formal_parameters (_ (_ (pair_pattern value: (identifier) @variable.parameter))))
(formal_parameters (_ (pair_pattern value: (assignment_pattern left: (identifier) @variable.parameter))))
(arrow_function parameter: (identifier) @variable.parameter)
(catch_clause parameter: (identifier) @variable.parameter)

;; ---- literals --------------------------------------------------------------------------------
[(true) (false) (null) (undefined)] @constant.builtin
(number) @number
(string) @string
(template_string) @string
(escape_sequence) @string.escape
(regex) @string.regexp
(regex "/" @string.regexp)
(template_substitution) @none

(comment) @comment
(hash_bang_line) @comment

;; ---- keywords --------------------------------------------------------------------------------
["const" "let" "var" "function" "class" "extends" "new" "typeof" "instanceof" "void" "delete"
 "import" "export" "from" "as" "in" "debugger" "with"] @keyword
(import) @keyword

["if" "else" "for" "while" "do" "break" "continue" "return" "switch" "case" "default" "try"
 "catch" "finally" "throw" "yield" "await" "of"] @keyword.control
(export_statement "default" @keyword)
(for_in_statement "in" @keyword.control)

["async" "static" "get" "set"] @keyword.modifier

;; ---- operators and punctuation ---------------------------------------------------------------
["-" "--" "-=" "+" "++" "+=" "*" "*=" "**" "**=" "/" "/=" "%" "%=" "<" "<=" "<<" "<<=" "=" "==" "==="
 "!" "!=" "!==" "=>" ">" ">=" ">>" ">>=" ">>>" ">>>=" "~" "^" "&" "|" "^=" "&=" "|=" "&&" "||"
 "??" "&&=" "||=" "??=" "..."] @operator
(generator_function "*" @operator)
(generator_function_declaration "*" @operator)
(method_definition "*" @operator)

[";" "." "," ":" (optional_chain)] @punctuation.delimiter
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
(ternary_expression ["?" ":"] @operator)
(meta_property ["meta" "target"] @variable.builtin)
(namespace_import (identifier) @module)
(namespace_export (identifier) @module)

;; interpolation delimiters after the brackets: they must win over them
(template_substitution
  "${" @string.interpolation
  "}" @string.interpolation)

;; ---- decorators: the whole thing, its arguments included ------------------------------------
(decorator) @attribute
(decorator _ @attribute)
(decorator (_ _ @attribute))
(decorator (_ (_ _ @attribute)))
(decorator (_ (_ (_ _ @attribute))))
(decorator (_ (_ (_ (_ _ @attribute)))))
(decorator (_ (_ (_ (_ (_ _ @attribute))))))
(decorator (_ (_ (_ (_ (_ (_ _ @attribute)))))))
(decorator (_ (_ (_ (_ (_ (_ (_ _ @attribute))))))))
