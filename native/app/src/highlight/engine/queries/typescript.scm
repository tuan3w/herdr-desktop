;; TypeScript (typescript and tsx grammars), on top of javascript.scm.

;; ---- types -----------------------------------------------------------------------------------
(type_identifier) @type
(predefined_type) @type.builtin
(this_type) @variable.builtin
(nested_type_identifier module: (identifier) @module)
(nested_identifier (identifier) @module)
(nested_identifier (property_identifier) @module)
(template_literal_type) @string
(template_type) @none
(template_type
  "${" @string.interpolation
  "}" @string.interpolation)

(type_arguments ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)
(type_predicate name: (identifier) @variable.parameter)
(asserts (identifier) @variable.parameter)

(enum_declaration name: (identifier) @type)
(enum_body name: (property_identifier) @constant)
(enum_assignment name: (property_identifier) @constant)
(internal_module name: (identifier) @module)
(import_alias (identifier) @type)

;; ---- functions, members ---------------------------------------------------------------------
(function_signature name: (identifier) @function.def)
(method_signature name: (property_identifier) @function.method.def)
(abstract_method_signature name: (property_identifier) @function.method.def)
(property_signature
  name: (property_identifier) @function.method.def
  type: (type_annotation [(function_type) (parenthesized_type (function_type))]))
(public_field_definition
  name: (property_identifier) @function.method.def
  value: [(function_expression) (arrow_function)])

;; ---- parameters ------------------------------------------------------------------------------
(required_parameter pattern: (identifier) @variable.parameter)
(optional_parameter pattern: (identifier) @variable.parameter)
(required_parameter pattern: (rest_pattern (identifier) @variable.parameter))
(required_parameter pattern: (array_pattern (identifier) @variable.parameter))
(required_parameter pattern: (object_pattern (shorthand_property_identifier_pattern) @variable.parameter))
(required_parameter pattern: (object_pattern (pair_pattern value: (identifier) @variable.parameter)))
(required_parameter pattern: (object_pattern (object_assignment_pattern left: (shorthand_property_identifier_pattern) @variable.parameter)))
(required_parameter pattern: (this) @variable.builtin)
(index_signature name: (identifier) @variable.parameter)

;; ---- keywords --------------------------------------------------------------------------------
["enum" "interface" "type" "namespace" "module" "declare" "implements" "keyof" "infer" "is"
 "asserts" "satisfies" "global" "require" "using"] @keyword
(extends_clause "extends" @keyword)
(extends_type_clause "extends" @keyword)
(constraint "extends" @keyword)
(conditional_type "extends" @keyword)
(mapped_type_clause "in" @keyword)

["abstract" "readonly" "accessor"] @keyword.modifier
(accessibility_modifier) @keyword.modifier
(override_modifier) @keyword.modifier

;; ---- operators and punctuation ---------------------------------------------------------------
["?:" "+?:" "-?:" "|" "&"] @operator
(non_null_expression "!" @operator)
(optional_parameter "?" @punctuation.delimiter)
(property_signature "?" @punctuation.delimiter)
(method_signature "?" @punctuation.delimiter)
(public_field_definition ["?" "!"] @punctuation.delimiter)
(optional_type "?" @punctuation.delimiter)
(union_type "|" @operator)
(intersection_type "&" @operator)
(function_type "=>" @operator)
(constructor_type "=>" @operator)
(object_type ["{" "}" "{|" "|}"] @punctuation.bracket)
(conditional_type ["?" ":"] @operator)

;; import type { A } / import { type A }
(import_specifier "type" (identifier) @type)
(import_statement "type" (import_clause (named_imports (import_specifier name: (_) @type))))
(export_statement "type" (export_clause (export_specifier name: (_) @type)))

;; the optional-call token of `fn?.()` (no optional_chain node)
"?." @punctuation.delimiter
