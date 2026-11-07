;; replace
; CSS: selectors, properties, values, at-rules.
(comment) @comment

; punctuation
["," ";" ":" "::" "." "#"] @punctuation.delimiter
["{" "}" "(" ")" "[" "]"] @punctuation.bracket

; selectors
(tag_name) @tag
(universal_selector) @tag
(nesting_selector) @operator
(class_selector "." @type (class_name) @type)
(id_selector "#" @label (id_name) @label)
(namespace_name) @namespace
(pseudo_class_selector ":" @keyword (class_name) @keyword)
(pseudo_element_selector "::" @keyword (tag_name) @keyword)
(attribute_name) @tag.attribute
(attribute_selector (plain_value) @string)
["~" ">" "+" "*" "/" "=" "^=" "|=" "~=" "$=" "*="] @operator
"-" @operator

; declarations
(property_name) @property
((property_name) @variable (#match? @variable "^--"))
((plain_value) @variable (#match? @variable "^--"))
(feature_name) @property

; values
(string_value) @string
(color_value) @constant
(color_value "#" @constant)
(integer_value) @number
(float_value) @number
(unit) @number
; the lexer glues `/` and a fraction onto the unit (font: 14px/1.4, 50.5%): re-join them into the number
((plain_value) @number (#match? @number "^([a-z]+|%)?/[0-9.]+[a-z%]*$"))
((plain_value) @number (#match? @number "^[.][0-9]+[a-z%]*$"))
(function_name) @function
((call_expression (function_name) @_f (arguments (plain_value) @string)) (#eq? @_f "url"))
(important) @keyword

; at-rules
(at_keyword) @keyword
["@media" "@import" "@charset" "@namespace" "@supports" "@keyframes" "@scope"] @keyword
[(to) (from)] @keyword
["and" "or" "not" "only" "of" "selector"] @keyword

; Streaming: inside a block that is still open the grammar cannot tell `color: re` from a nested
; selector `a:hover`, and hands over an error node; read it as a declaration being typed.
(ERROR (tag_name) @property . ":")
(ERROR (pseudo_class_selector (tag_name) @property ":" @punctuation.delimiter (class_name) @none))
