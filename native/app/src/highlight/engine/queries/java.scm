;; replace
;; Java. Later patterns win over earlier ones for the same node.

;; ---- names -----------------------------------------------------------------------------------
(identifier) @variable
(type_identifier) @type
((type_identifier) @keyword
  (#eq? @keyword "var"))

;; PascalCase reads as a class (System, Collectors, Level); ALL_CAPS as a constant.
((identifier) @type
  (#match? @type "^[A-Z]"))
((identifier) @constant
  (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))

;; packages and imports: lowercase scopes are namespaces, the final PascalCase name is a type
(package_declaration [(identifier) (scoped_identifier)] @module)
(import_declaration [(identifier) (scoped_identifier)] @module)
(scoped_identifier scope: (identifier) @module)
(scoped_identifier name: (identifier) @module)
((scoped_identifier name: (identifier) @type)
  (#match? @type "^[A-Z]"))
((scoped_identifier scope: (identifier) @type)
  (#match? @type "^[A-Z]"))
((scoped_identifier name: (identifier) @constant)
  (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))

(field_access field: (identifier) @property)
(field_access field: (identifier) @constant
  (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))
(field_access field: (identifier) @type
  (#match? @type "^[A-Z][a-z]"))
(field_declaration
  declarator: (variable_declarator name: (identifier) @property))
(field_declaration
  declarator: (variable_declarator name: (identifier) @constant
    (#match? @constant "^_*[A-Z][A-Z0-9_]+$")))
(constant_declaration
  declarator: (variable_declarator name: (identifier) @constant))
(enum_constant name: (identifier) @constant)
(element_value_pair key: (identifier) @property)
(record_declaration
  parameters: (formal_parameters
    (formal_parameter name: (identifier) @property)))

(this) @variable.builtin
(super) @variable.builtin
(wildcard "?" @operator)

;; ---- types -----------------------------------------------------------------------------------
[(boolean_type) (integral_type) (floating_point_type) (void_type)] @type.builtin
(class_declaration name: (identifier) @type)
(interface_declaration name: (identifier) @type)
(enum_declaration name: (identifier) @type)
(record_declaration name: (identifier) @type)
(annotation_type_declaration name: (identifier) @type)

;; ---- functions -------------------------------------------------------------------------------
(method_declaration name: (identifier) @function.method.def)
(constructor_declaration name: (identifier) @function.method.def)
(compact_constructor_declaration name: (identifier) @function.method.def)
(annotation_type_element_declaration name: (identifier) @function.method.def)
(method_invocation name: (identifier) @function.call)
(method_invocation
  object: (_)
  name: (identifier) @function.method.call)
(method_reference "::" . (identifier) @function.method.call)
(explicit_constructor_invocation constructor: (_) @variable.builtin)

;; ---- parameters ------------------------------------------------------------------------------
(formal_parameter name: (identifier) @variable.parameter)
(spread_parameter (variable_declarator name: (identifier) @variable.parameter))
(catch_formal_parameter name: (identifier) @variable.parameter)
(lambda_expression parameters: (identifier) @variable.parameter)
(inferred_parameters (identifier) @variable.parameter)
(record_declaration
  parameters: (formal_parameters
    (formal_parameter name: (identifier) @property)))


;; ---- literals --------------------------------------------------------------------------------
[(decimal_integer_literal) (hex_integer_literal) (octal_integer_literal) (binary_integer_literal)
 (decimal_floating_point_literal) (hex_floating_point_literal)] @number
[(string_literal) (character_literal)] @string
(escape_sequence) @string.escape
[(true) (false) (null_literal)] @constant.builtin
(string_interpolation) @none
[(line_comment) (block_comment)] @comment

;; ---- keywords --------------------------------------------------------------------------------
["class" "interface" "enum" "record" "@interface" "package" "import" "extends" "implements" "new"
 "instanceof" "throws" "module" "requires" "exports" "opens" "uses" "provides" "with" "to"
 "transitive" "permits" "when"] @keyword

["if" "else" "for" "while" "do" "break" "continue" "return" "switch" "case" "try" "catch"
 "finally" "throw" "yield" "assert"] @keyword.control
(switch_label "default" @keyword.control)

["public" "private" "protected" "static" "final" "abstract" "native" "strictfp" "transient"
 "volatile" "synchronized" "sealed" "non-sealed" "open"] @keyword.modifier
(modifiers "default" @keyword.modifier)
(import_declaration "static" @keyword)
(synchronized_statement "synchronized" @keyword)
(annotation_type_element_declaration "default" @keyword)
(wildcard (super) @keyword)
(import_declaration "static" (scoped_identifier name: (identifier) @function.call
  (#match? @function.call "^[a-z]")))
(break_statement (identifier) @label)
(continue_statement (identifier) @label)
(labeled_statement (identifier) @label)

;; ---- operators and punctuation ---------------------------------------------------------------
["!" "!=" "%" "%=" "&" "&&" "&=" "*" "*=" "+" "++" "+=" "-" "--" "-=" "->" "/" "/=" "<" "<<"
 "<<=" "<=" "=" "==" ">" ">=" ">>" ">>=" ">>>" ">>>=" "^" "^=" "|" "|=" "||" "~" "..."] @operator
(ternary_expression ["?" ":"] @operator)
[";" "." "," ":" "::"] @punctuation.delimiter
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
(type_arguments ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)
(dimensions ["[" "]"] @punctuation.bracket)
(string_interpolation
  "\\{" @string.interpolation
  "}" @string.interpolation)
;; ---- annotations: the whole thing, its arguments included ------------------------------------
(annotation) @attribute
(marker_annotation) @attribute
(annotation _ @attribute)
(annotation (_ _ @attribute))
(annotation (_ (_ _ @attribute)))
(annotation (_ (_ (_ _ @attribute))))
(annotation (_ (_ (_ (_ _ @attribute)))))
(annotation (_ (_ (_ (_ (_ _ @attribute))))))
(marker_annotation _ @attribute)
(marker_annotation (_ _ @attribute))
