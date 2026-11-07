;; replace
;; Swift. Later patterns win over earlier ones for the same node.

;; ---- names -----------------------------------------------------------------------------------
(simple_identifier) @variable
(type_identifier) @type
((simple_identifier) @type
  (#match? @type "^[A-Z]"))
((simple_identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))
((simple_identifier) @keyword.control
  (#any-of? @keyword.control "fallthrough" "defer"))
((simple_identifier) @variable.builtin
  (#eq? @variable.builtin "self"))
((simple_identifier) @variable.parameter
  (#match? @variable.parameter "^\\$[0-9]+$"))
((type_identifier) @type.builtin
  (#any-of? @type.builtin "Int" "Int8" "Int16" "Int32" "Int64" "UInt" "UInt8" "UInt16" "UInt32" "UInt64"
    "Double" "Float" "Bool" "String" "Character" "Void" "Any" "AnyObject" "Never"))
((simple_identifier) @type.builtin
  (#any-of? @type.builtin "Int" "Int8" "Int16" "Int32" "Int64" "UInt" "UInt8" "UInt16" "UInt32" "UInt64"
    "Double" "Float" "Bool" "String" "Character" "Void" "Any" "AnyObject" "Never"))

(self_expression) @variable.builtin
(super_expression) @variable.builtin

;; members
(class_body (property_declaration (pattern (simple_identifier) @property)))
(enum_class_body (property_declaration (pattern (simple_identifier) @property)))
(protocol_property_declaration (pattern (simple_identifier) @property))
(navigation_suffix suffix: (simple_identifier) @property)
(value_argument name: (value_argument_label (simple_identifier) @variable.parameter))
(enum_entry name: (simple_identifier) @constant)
(enum_type_parameters (simple_identifier) @variable.parameter)
(tuple_type_item name: (simple_identifier) @variable.parameter)

;; ---- types -----------------------------------------------------------------------------------
(type_parameter (type_identifier) @type)
(optional_type "?" @punctuation.delimiter)
(type_arguments ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)
"Protocol" @keyword
"Type" @keyword

;; ---- functions -------------------------------------------------------------------------------
(function_declaration name: (simple_identifier) @function.def)
(protocol_function_declaration name: (simple_identifier) @function.def)
(init_declaration "init" @function.def)
(deinit_declaration "deinit" @function.def)
(subscript_declaration "subscript" @function.def)

;; a call is a "(" or a trailing closure after the callee; a "[" suffix is a subscript
(call_expression
  . (simple_identifier) @function.call
  (call_suffix (value_arguments "(")))
(call_expression
  . (simple_identifier) @function.call
  (call_suffix (lambda_literal)))
(call_expression
  . (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @function.method.call))
  (call_suffix (value_arguments "(")))
(call_expression
  . (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @function.method.call))
  (call_suffix (lambda_literal)))
(call_expression
  . (prefix_expression (simple_identifier) @function.method.call)
  (call_suffix))
((call_expression
    . (simple_identifier) @type
    (call_suffix))
  (#match? @type "^[A-Z]"))
((call_expression . (simple_identifier) @keyword.control)
  (#eq? @keyword.control "defer"))
((navigation_suffix suffix: (simple_identifier) @type)
  (#match? @type "^[A-Z]"))
(prefix_expression "." (simple_identifier) @constant)
(pattern "." . (simple_identifier) @constant)
(if_statement "." . (simple_identifier) @constant)
(guard_statement "." . (simple_identifier) @constant)
(while_statement "." . (simple_identifier) @constant)
(import_declaration (identifier (simple_identifier) @module))

;; ---- parameters ------------------------------------------------------------------------------
(parameter external_name: (simple_identifier) @variable.parameter)
(parameter name: (simple_identifier) @variable.parameter)
(lambda_parameter name: (simple_identifier) @variable.parameter)
(lambda_parameter external_name: (simple_identifier) @variable.parameter)
(catch_block error: (pattern (simple_identifier) @variable.parameter))
((simple_identifier) @none
  (#eq? @none "_"))

;; ---- literals --------------------------------------------------------------------------------
[(integer_literal) (hex_literal) (oct_literal) (bin_literal) (real_literal)] @number
[(boolean_literal) (nil_literal)] @constant.builtin
(special_literal) @constant.macro
(regex_literal) @string.regexp
;; strings are painted by their fragments, not as a whole: an interpolation \( ) is code in between
[(line_str_text) (multi_line_str_text) (raw_str_part) (raw_str_end_part) "\"" "\"\"\""] @string
(str_escaped_char) @string.escape
[(comment) (multiline_comment) (shebang_line)] @comment
(statement_label) @label

;; ---- keywords --------------------------------------------------------------------------------
["func" "let" "var" "struct" "class" "enum" "protocol" "extension" "typealias" "associatedtype" "actor"
 "import" "init" "deinit" "subscript" "operator" "precedencegroup" "macro" "some" "any"
 "is" "as" "willSet" "didSet" "get" "set" "_modify" "in" "case"
 (throws) (where_keyword) (getter_specifier) (setter_specifier) (modify_specifier) (as_operator)] @keyword
(else) @keyword.control

["if" "guard" "switch" "for" "while" "repeat" "return" "break" "continue" "fallthrough" "do"
 "await" "yield" (throw_keyword) (catch_keyword) (try_operator) (default_keyword)] @keyword.control
(switch_entry "case" @keyword.control)
(for_statement "in" @keyword.control)
(lambda_literal "in" @keyword)

["async" "static" "final" "override" "convenience" "required" "lazy" "weak" "unowned" "mutating"
 "nonmutating" "nonisolated" "indirect" "dynamic" "optional" "inout" "borrowing" "consuming" "isolated"
 "public" "private" "fileprivate" "internal" "open" "package" "postfix" "prefix" "infix"
 "distributed"] @keyword.modifier
[(visibility_modifier) (member_modifier) (function_modifier) (property_modifier) (parameter_modifier)
 (inheritance_modifier) (mutation_modifier) (ownership_modifier) (property_behavior_modifier)] @keyword.modifier

[(directive) (diagnostic)] @keyword.directive
[(availability_condition) (playground_literal) (key_path_string_expression) (selector_expression)
 (external_macro_definition)] @function.macro

;; ---- operators and punctuation ---------------------------------------------------------------
(custom_operator) @operator
["+" "-" "*" "/" "%" "=" "+=" "-=" "*=" "/=" "%=" "<" ">" "<<" ">>" "<=" ">=" "++" "--" "^" "&" "&&"
 "|" "||" "~" "!=" "!==" "==" "===" "??" "->" "..<" "..." "\\" (bang)] @operator
(ternary_expression ["?" ":"] @operator)
[";" "." "," ":"] @punctuation.delimiter
["(" ")" "[" "]" "{" "}"] @punctuation.bracket
(type_arguments ["<" ">"] @punctuation.bracket)
(type_parameters ["<" ">"] @punctuation.bracket)

;; ---- attributes: the whole thing, its arguments included -------------------------------------
(attribute) @attribute
["@autoclosure" "@escaping"] @attribute
(attribute _ @attribute)
(attribute (_ _ @attribute))
(attribute (_ (_ _ @attribute)))
(attribute (_ (_ (_ _ @attribute))))
(attribute (_ (_ (_ (_ _ @attribute)))))
(attribute (_ (_ (_ (_ (_ _ @attribute))))))

;; interpolation delimiters last: they must win over the bracket punctuation
(line_string_literal ["\\(" ")"] @string.interpolation)
(multi_line_string_literal ["\\(" ")"] @string.interpolation)
(raw_str_interpolation [(raw_str_interpolation_start) ")"] @string.interpolation)
