;; replace
;; Kotlin (tree-sitter-kotlin-ng ships no query). Later patterns win over earlier ones for the same node.
;; The grammar has no literal nodes for true/false/null: they are plain identifiers.

;; ---- names -----------------------------------------------------------------------------------
(identifier) @variable
((identifier) @type
  (#match? @type "^[A-Z]"))
((identifier) @constant.builtin
  (#any-of? @constant.builtin "true" "false" "null"))
((identifier) @variable.parameter
  (#eq? @variable.parameter "it"))

(navigation_expression (identifier) @property .)
((navigation_expression (identifier) @type .)
  (#match? @type "^[A-Z][a-z]"))

(this_expression) @variable.builtin
(super_expression) @variable.builtin

;; declarations of properties: members of a class are properties, locals stay variables
(class_body (property_declaration (variable_declaration (identifier) @property)))
(enum_class_body (property_declaration (variable_declaration (identifier) @property)))
(source_file (property_declaration (variable_declaration (identifier) @property)))
;; after the members so that one pattern makes constants of members too (a pattern rooted at
;; source_file or class_body for it costs a live match across the whole file)
((identifier) @constant
  (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))
(enum_entry (identifier) @constant)

;; ---- packages and imports --------------------------------------------------------------------
(package_header (qualified_identifier (identifier) @module))
(import (qualified_identifier (identifier) @module))
((import (qualified_identifier (identifier) @type .))
  (#match? @type "^[A-Z]"))
((import (qualified_identifier (identifier) @constant .))
  (#match? @constant "^_*[A-Z][A-Z0-9_]+$"))
(import "as" . (identifier) @type)

;; ---- types -----------------------------------------------------------------------------------
(user_type (identifier) @type)
((user_type (identifier) @type.builtin)
  (#any-of? @type.builtin "Int" "Long" "Short" "Byte" "UInt" "ULong" "UShort" "UByte" "Float" "Double"
    "Boolean" "Char" "String" "Unit" "Any" "Nothing" "Number"))
((user_type (identifier) @module . (identifier))
  (#match? @module "^[a-z]"))
((property_declaration (user_type (identifier) @property .))
  (#match? @property "^[a-z]"))
(type_parameter (identifier) @type)
(class_declaration name: (identifier) @type)
(object_declaration name: (identifier) @type)
(companion_object name: (identifier) @type)
(type_alias type: (identifier) @type)
(constructor_invocation (type (user_type (identifier) @type)))
(nullable_type "?" @punctuation.delimiter)

;; ---- functions -------------------------------------------------------------------------------
(function_declaration name: (identifier) @function.def)
(call_expression . (identifier) @function.call)
(call_expression (navigation_expression (identifier) @function.method.call .))
((call_expression . (identifier) @type)
  (#match? @type "^[A-Z]"))
((call_expression (navigation_expression (identifier) @type .))
  (#match? @type "^[A-Z]"))
(infix_expression (_) . (identifier) @function.call . (_))
(callable_reference (identifier) @function.call .)
(constructor_delegation_call ["this" "super"] @variable.builtin)

;; ---- parameters ------------------------------------------------------------------------------
(parameter (identifier) @variable.parameter)
(class_parameter . (identifier) @variable.parameter)
(class_parameter (modifiers) . (identifier) @variable.parameter)
(class_parameter ["val" "var"] . (identifier) @property)
(lambda_parameters (variable_declaration (identifier) @variable.parameter))
(lambda_parameters (multi_variable_declaration (variable_declaration (identifier) @variable.parameter)))
(catch_block (identifier) @variable.parameter)
(setter (identifier) @variable.parameter)
(value_argument . (identifier) @variable.parameter . "=")

;; ---- literals --------------------------------------------------------------------------------
[(number_literal) (float_literal)] @number
[(string_literal) (multiline_string_literal) (character_literal)] @string
(escape_sequence) @string.escape
(interpolation) @none
[(line_comment) (block_comment) (shebang)] @comment
(label) @label
((label) @keyword.control
  (#match? @keyword.control "^(break|continue|return)@$"))
(return_expression label: (identifier) @label)

;; ---- keywords --------------------------------------------------------------------------------
["fun" "val" "var" "class" "interface" "object" "typealias" "package" "import" "constructor" "init"
 "companion" "by" "get" "set" "where" "is" "!is" "as" "as?" "in" "!in" "field" "property" "receiver"
 "param" "setparam" "delegate" "file" "dynamic"] @keyword

["if" "else" "when" "for" "while" "do" "try" "catch" "finally" "return" "return@" "throw"] @keyword.control
((identifier) @keyword.control
  (#any-of? @keyword.control "break" "continue"))
(for_statement "in" @keyword.control)

[(visibility_modifier) (inheritance_modifier) (member_modifier) (function_modifier) (property_modifier)
 (class_modifier) (parameter_modifier) (platform_modifier) (reification_modifier) (variance_modifier)] @keyword.modifier

;; ---- operators and punctuation ---------------------------------------------------------------
["+" "-" "*" "/" "%" "++" "--" "=" "+=" "-=" "*=" "/=" "%=" "==" "!=" "===" "!==" "<" ">" "<=" ">="
 "&&" "||" "!" "!!" "?:" ".." "..<" "->" "&"] @operator
[";" "." "," ":" "::" "?."] @punctuation.delimiter
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
(type_arguments ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)

(interpolation ["$" "${" "}"] @string.interpolation)
;; ---- annotations: the whole thing, its arguments included ------------------------------------
(annotation) @attribute
(file_annotation) @attribute
(annotation _ @attribute)
(annotation (_ _ @attribute))
(annotation (_ (_ _ @attribute)))
(annotation (_ (_ (_ _ @attribute))))
(annotation (_ (_ (_ (_ _ @attribute)))))
(annotation (_ (_ (_ (_ (_ _ @attribute))))))
(annotation (_ (_ (_ (_ (_ (_ _ @attribute)))))))
(file_annotation _ @attribute)
(file_annotation (_ _ @attribute))
(file_annotation (_ (_ _ @attribute)))
