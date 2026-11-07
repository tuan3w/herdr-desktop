;; replace
;; PHP. Later patterns beat earlier ones on the same node; inner nodes beat outer ones.
;; Text outside `<?php ... ?>` (the `text` node) is left plain.

(php_tag) @tag
(php_end_tag) @tag

; ---- names: generic, then naming conventions, then context ---------------------------------------

; Constants are ALL_CAPS names, classes are CamelCase names. A `$name` keeps the inner `name`
; as a variable (the last pattern of this block).
((name) @constant
  (#match? @constant "^_?[A-Z][A-Z0-9_]+$"))
((name) @constant.builtin
  (#match? @constant.builtin "^__[A-Z][A-Z0-9_]+__$"))
((name) @type
  (#match? @type "^_?[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$"))
(variable_name) @variable
(variable_name (name) @variable)

(dynamic_variable_name "$" @variable)
((variable_name) @variable.builtin
  (#eq? @variable.builtin "$this"))
((variable_name (name) @variable.builtin)
  (#eq? @variable.builtin "this"))
(relative_scope) @variable.builtin

; ---- literals ------------------------------------------------------------------------------------

(integer) @number
(float) @number
(boolean) @constant
(null) @constant
(comment) @comment

(string) @string
(encapsed_string) @string
(heredoc) @string
(nowdoc) @string
(escape_sequence) @string.escape
; `{$a->b}` and `"$a->b"`: the expression inside is code, only the braces are interpolation.
(encapsed_string [(member_access_expression) (nullsafe_member_access_expression) (subscript_expression) (function_call_expression) (member_call_expression) (class_constant_access_expression) (scoped_property_access_expression) (dynamic_variable_name)] @none)
(heredoc_body [(member_access_expression) (nullsafe_member_access_expression) (subscript_expression) (function_call_expression) (member_call_expression) (class_constant_access_expression) (scoped_property_access_expression) (dynamic_variable_name)] @none)
(encapsed_string (variable_name) @variable)
(heredoc_body (variable_name) @variable)
(encapsed_string (variable_name (name) @variable))
(heredoc_body (variable_name (name) @variable))

; ---- keywords ------------------------------------------------------------------------------------

["function" "fn" "class" "interface" "trait" "enum" "extends" "implements" "namespace" "use" "const" "declare"
 "enddeclare" "new" "clone" "instanceof" "insteadof" "as" "global" "echo" "print" "include" "include_once"
 "require" "require_once" "unset" "list" "array"] @keyword
["and" "or" "xor"] @keyword
["if" "elseif" "else" "endif" "switch" "case" "default" "endswitch" "match" "for" "endfor" "foreach"
 "endforeach" "while" "endwhile" "do" "break" "continue" "return" "throw" "try" "catch" "finally"
 "yield" "yield from" "goto" "exit"] @keyword.control
(foreach_statement "as" @keyword.control)
(function_static_declaration "static" @keyword.modifier)
(enum_case "case" @keyword)
[(visibility_modifier) (static_modifier) (final_modifier) (abstract_modifier) (readonly_modifier) (var_modifier)] @keyword.modifier
(named_label_statement) @label
(goto_statement (name) @label)

; ---- operators and punctuation -------------------------------------------------------------------

["+" "-" "*" "/" "%" "**" "." "=" "==" "===" "!=" "!==" "<>" "<" ">" "<=" ">=" "<=>" "&&" "||" "!" "??"
 "??=" "?" "&" "|" "^" "~" "<<" ">>" "++" "--" "+=" "-=" "*=" "/=" ".=" "%=" "**=" "&=" "|=" "^=" "<<="
 ">>=" "=>" "|>" "@" "..."] @operator

["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["," ";" ":" "->" "?->" "::" "\\"] @punctuation.delimiter
(encapsed_string ["{" "}"] @string.interpolation)
(heredoc_body ["{" "}"] @string.interpolation)

; ---- types ---------------------------------------------------------------------------------------

(primitive_type) @type.builtin
(cast_type) @type.builtin
(named_type (name) @type)
(named_type (qualified_name (name) @type))
(named_type (name) @type.builtin
  (#any-of? @type.builtin "self" "static" "parent" "iterable" "mixed" "never" "callable"))
(base_clause (name) @type)
(base_clause (qualified_name (name) @type))
(class_interface_clause (name) @type)
(class_interface_clause (qualified_name (name) @type))
(use_declaration (name) @type)
(use_declaration (qualified_name (name) @type))
(object_creation_expression (name) @type)
(object_creation_expression (qualified_name (name) @type))
(binary_expression operator: "instanceof" right: (name) @type)
(binary_expression operator: "instanceof" right: (qualified_name (name) @type))

(class_declaration name: (name) @type)
(interface_declaration name: (name) @type)
(trait_declaration name: (name) @type)
(enum_declaration name: (name) @type)

; ---- namespaces ----------------------------------------------------------------------------------

(namespace_name (name) @namespace)
(namespace_use_clause [(name) (qualified_name (name))] @type)
(namespace_use_clause (qualified_name (name) @type))
(namespace_use_clause alias: (name) @type)
(namespace_use_clause (qualified_name prefix: (namespace_name (name) @namespace)))
(namespace_use_clause type: "function" [(name) @function.call (qualified_name (name) @function.call)])
(namespace_use_clause type: "const" [(name) @constant (qualified_name (name) @constant)])
(namespace_definition name: (namespace_name (name) @namespace))
(qualified_name prefix: (namespace_name (name) @namespace))
(relative_name prefix: (namespace_name (name) @namespace))
(relative_name "namespace" @namespace)

; ---- definitions and calls -----------------------------------------------------------------------

(function_definition name: (name) @function.def)
(method_declaration name: (name) @function.def)
(enum_case name: (name) @constant)
(const_element (name) @constant)

(function_call_expression function: (name) @function.call)
(function_call_expression function: (qualified_name (name) @function.call))
(function_call_expression function: (relative_name (name) @function.call))
(member_call_expression name: (name) @function.method.call)
(nullsafe_member_call_expression name: (name) @function.method.call)
(scoped_call_expression name: (name) @function.method.call)
(scoped_call_expression scope: (name) @type)
(scoped_call_expression scope: (qualified_name (name) @type))
(array_creation_expression "array" @function.call)
(list_literal "list" @function.call)
(exit_statement "exit" @keyword.control)

; ---- members, constants --------------------------------------------------------------------------

(property_element (variable_name) @property)
(property_element (variable_name (name) @property))
(member_access_expression name: (name) @property)
(nullsafe_member_access_expression name: (name) @property)
(scoped_property_access_expression scope: (name) @type)
(scoped_property_access_expression scope: (qualified_name (name) @type))
(scoped_property_access_expression name: (variable_name) @property)
(scoped_property_access_expression name: (variable_name (name) @property))
(class_constant_access_expression . (name) @type)
(class_constant_access_expression . (qualified_name (name) @type))
(class_constant_access_expression (name) @constant .)
(class_constant_access_expression (name) @keyword .
  (#eq? @keyword "class"))
(class_constant_access_expression . (relative_scope) @variable.builtin)

; ---- parameters ----------------------------------------------------------------------------------

(simple_parameter name: (variable_name) @variable.parameter)
(simple_parameter name: (variable_name (name) @variable.parameter))
(variadic_parameter name: (variable_name) @variable.parameter)
(variadic_parameter name: (variable_name (name) @variable.parameter))
(property_promotion_parameter name: (variable_name) @variable.parameter)
(property_promotion_parameter name: (variable_name (name) @variable.parameter))
(argument name: (name) @variable.parameter)
(declare_directive ["strict_types" "ticks" "encoding"] @property)

; ---- attributes: the whole `#[ ... ]` ------------------------------------------------------------

(attribute_list) @attribute
(attribute_group ["#[" "]" ","] @attribute)
(attribute (name) @attribute)
(attribute (qualified_name (name) @attribute))
(attribute (qualified_name prefix: (namespace_name (name) @attribute)))
(attribute (qualified_name "\\" @attribute))
(attribute (qualified_name prefix: "\\" @attribute))
(attribute (relative_name (name) @attribute))
(attribute parameters: (arguments ["(" ")" ","] @attribute))
(attribute parameters: (arguments (argument name: (name) @attribute)))
(attribute parameters: (arguments (argument [(string) (encapsed_string) (integer) (float) (boolean) (null)] @attribute)))
(attribute parameters: (arguments (argument (name) @attribute)))
(attribute parameters: (arguments (argument (class_constant_access_expression) @attribute)))
(attribute parameters: (arguments (argument ":" @attribute)))
(attribute parameters: (arguments (argument (array_creation_expression ["[" "]" ","] @attribute))))
(attribute parameters: (arguments (argument (array_creation_expression (array_element_initializer [(string) (encapsed_string) (integer) (float) (boolean) (null) (name)] @attribute)))))
(attribute parameters: (arguments (argument (array_creation_expression (array_element_initializer "=>" @attribute)))))
