;; JSX (javascript and tsx grammars), on top of javascript.scm / typescript.scm.

;; Lowercase names are DOM tags; PascalCase and member names are components.
(jsx_opening_element name: (identifier) @tag)
(jsx_closing_element name: (identifier) @tag)
(jsx_self_closing_element name: (identifier) @tag)
(jsx_opening_element name: (identifier) @type (#match? @type "^[A-Z]"))
(jsx_closing_element name: (identifier) @type (#match? @type "^[A-Z]"))
(jsx_self_closing_element name: (identifier) @type (#match? @type "^[A-Z]"))
(jsx_opening_element name: (member_expression object: (identifier) @type property: (property_identifier) @type))
(jsx_closing_element name: (member_expression object: (identifier) @type property: (property_identifier) @type))
(jsx_self_closing_element name: (member_expression object: (identifier) @type property: (property_identifier) @type))
(jsx_namespace_name (identifier) @tag)

(jsx_attribute (property_identifier) @tag.attribute)
(jsx_attribute (jsx_namespace_name (identifier) @tag.attribute))
(jsx_attribute "=" @punctuation.delimiter)

(jsx_opening_element ["<" ">"] @punctuation.bracket)
(jsx_closing_element ["</" ">"] @punctuation.bracket)
(jsx_self_closing_element ["<" "/>"] @punctuation.bracket)

(jsx_expression ["{" "}"] @punctuation.bracket)
(html_character_reference) @string.escape
