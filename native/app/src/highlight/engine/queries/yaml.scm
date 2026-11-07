;; replace
; YAML: keys are properties, scalars keep their kind, anchors/aliases are labels.
(comment) @comment

; scalars
(string_scalar) @string
(double_quote_scalar) @string
(single_quote_scalar) @string
(block_scalar) @string
(escape_sequence) @string.escape
[(integer_scalar) (float_scalar) (timestamp_scalar)] @number
[(boolean_scalar) (null_scalar)] @constant
; YAML 1.1 spellings the grammar's core schema treats as plain strings
((string_scalar) @constant (#any-of? @constant "yes" "no" "Yes" "No" "YES" "NO" "on" "off" "On" "Off" "ON" "OFF" "y" "n"))

; dates and timestamps (the core schema has no timestamp type)
((string_scalar) @number (#match? @number "^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9:.]+([ ]?(Z|[+-][0-9:]+))?)?$"))

; anchors, aliases, tags
[(anchor) (alias)] @label
(tag) @type
((tag) @type.builtin (#match? @type.builtin "^!!"))

; directives and document markers
[(yaml_directive) (tag_directive) (reserved_directive)] @keyword.directive
["---" "..."] @punctuation.special

; punctuation
["," "-" ":" "?" ">" "|"] @punctuation.delimiter
["[" "]" "{" "}"] @punctuation.bracket

; mapping keys come last so they override the scalar kind of the key text
(block_mapping_pair key: (flow_node) @property)
(flow_pair key: (flow_node) @property)
