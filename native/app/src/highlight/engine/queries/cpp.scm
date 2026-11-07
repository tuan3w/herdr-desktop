; C++: refinements on top of the C overlay (which is the complete base). Later patterns win.

; ---- namespaces and types ----
(namespace_identifier) @module
((namespace_identifier) @type
  (#match? @type "^[A-Z]"))
(auto) @type.builtin
(this) @variable.builtin
(concept_definition name: (identifier) @type)
(raw_string_literal) @string
(user_defined_literal (number_literal) (literal_suffix) @number)
(user_defined_literal (string_literal) (literal_suffix) @string)

((identifier) @constant
  (#match? @constant "^k[A-Z]"))

; ---- functions and methods ----
(function_declarator declarator: (qualified_identifier name: (identifier) @function.def))
(function_declarator declarator: (qualified_identifier name: (qualified_identifier name: (identifier) @function.def)))
(function_declarator declarator: (field_identifier) @function.def)
(function_declarator declarator: (destructor_name) @function.def)
(function_declarator declarator: (qualified_identifier name: (destructor_name) @function.def))
(function_declarator declarator: (operator_name) @function.def)
(function_declarator declarator: (qualified_identifier name: (operator_name) @function.def))
(function_declarator declarator: (operator_name _ @function.def))
(function_declarator declarator: (qualified_identifier name: (operator_name _ @function.def)))
(function_declarator declarator: (template_function name: (identifier) @function.def))

(call_expression function: (field_expression field: (field_identifier) @function.method.call))
(call_expression function: (field_expression field: (template_method name: (field_identifier) @function.method.call)))
(call_expression function: (qualified_identifier name: (identifier) @function.call))
(call_expression function: (qualified_identifier name: (qualified_identifier name: (identifier) @function.call)))
(call_expression function: (qualified_identifier name: (qualified_identifier name: (qualified_identifier name: (identifier) @function.call))))
(call_expression function: (template_function name: (identifier) @function.call))
(call_expression function: (qualified_identifier name: (template_function name: (identifier) @function.call)))
((call_expression function: (qualified_identifier name: (identifier) @function.macro))
  (#match? @function.macro "^_*[A-Z][A-Z0-9_]+$"))
((call_expression function: (template_function name: (identifier) @keyword))
  (#any-of? @keyword "static_cast" "dynamic_cast" "const_cast" "reinterpret_cast"))

; ---- parameters ----
(parameter_declaration declarator: (reference_declarator (identifier) @variable.parameter))
(optional_parameter_declaration declarator: (identifier) @variable.parameter)
(optional_parameter_declaration declarator: (pointer_declarator declarator: (identifier) @variable.parameter))
(optional_parameter_declaration declarator: (reference_declarator (identifier) @variable.parameter))
(variadic_parameter_declaration declarator: (variadic_declarator (identifier) @variable.parameter))
(variadic_parameter_declaration declarator: (reference_declarator (variadic_declarator (identifier) @variable.parameter)))
(variadic_parameter_declaration declarator: (reference_declarator (identifier) @variable.parameter))
(parameter_declaration declarator: (pointer_declarator declarator: (reference_declarator (identifier) @variable.parameter)))

; ---- keywords ----
["try" "catch" "throw" "co_await" "co_return" "co_yield"] @keyword.control
["class" "namespace" "template" "typename" "using" "concept" "requires" "new" "delete" "decltype" "operator" "static_assert"] @keyword
["constexpr" "constinit" "consteval" "explicit" "final" "friend" "mutable" "noexcept" "override" "private" "protected" "public" "virtual"] @keyword.modifier
(virtual_specifier) @keyword.modifier
(explicit_function_specifier) @keyword.modifier
(default_method_clause "default" @keyword)
(delete_method_clause "delete" @keyword)

; ---- punctuation ----
"::" @punctuation.delimiter
(template_argument_list ["<" ">"] @punctuation.bracket)
(template_parameter_list ["<" ">"] @punctuation.bracket)
(lambda_capture_specifier ["[" "]"] @punctuation.bracket)
(operator_name "operator" @function.def)
(raw_string_literal _ @string)
(template_parameter_list (parameter_declaration type: [(primitive_type) (sized_type_specifier)] declarator: (identifier) @constant))
(template_parameter_list (optional_parameter_declaration type: [(primitive_type) (sized_type_specifier)] declarator: (identifier) @constant))
(destructor_name) @function.def
(destructor_name _ @function.def)
