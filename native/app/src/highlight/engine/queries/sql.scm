; SQL: the stock query classifies the keywords; these patterns refine it. Later patterns win.

; An identifier nobody claims below is a column.
(identifier) @property

; ---- keywords the stock query files under other names --------------------------------------------

(keyword_null) @constant
[(keyword_true) (keyword_false)] @constant
(column_definition (keyword_null) @keyword)
(constraint (keyword_null) @keyword)

; asc/desc/default/collate and friends read as plain keywords, not decorators.
[
  (keyword_asc) (keyword_desc) (keyword_nulls) (keyword_last) (keyword_first) (keyword_default)
  (keyword_collate) (keyword_preceding) (keyword_following) (keyword_terminated) (keyword_escaped)
  (keyword_delimited) (keyword_replication) (keyword_always) (keyword_generated) (keyword_engine)
  (keyword_concurrently)
] @keyword
[
  (keyword_unsigned) (keyword_auto_increment) (keyword_immutable) (keyword_atomic) (keyword_parallel)
  (keyword_leakproof) (keyword_safe) (keyword_cost) (keyword_strict)
] @keyword.modifier
(keyword_current_timestamp) @constant

; Storage and lifetime qualifiers.
[
  (keyword_materialized) (keyword_recursive) (keyword_temp) (keyword_temporary) (keyword_unlogged)
  (keyword_external) (keyword_volatile)
] @keyword.modifier

; The end of a CASE belongs to the CASE.
(case (keyword_end) @keyword.control)

; Index methods are not calls.
[(keyword_gist) (keyword_btree) (keyword_hash) (keyword_spgist) (keyword_gin) (keyword_brin)] @keyword
(keyword_array) @type.builtin
(keyword_object_id) @type.builtin

; ---- literals ------------------------------------------------------------------------------------

((literal) @number
  (#match? @number "^[-+]?([0-9][0-9_]*\\.?[0-9_]*|\\.[0-9]+)([eE][-+]?[0-9]+)?$"))
(comment) @comment
(marginalia) @comment
(parameter) @variable.parameter

; ---- identifiers ---------------------------------------------------------------------------------

; Tables, views and CTEs are named like types; columns are properties; aliases and qualifiers are variables.
(object_reference name: (identifier) @type)
(object_reference schema: (identifier) @namespace)
(object_reference database: (identifier) @namespace)
(field name: (identifier) @property)
(field (object_reference name: (identifier) @variable))
(field (object_reference schema: (identifier) @type))
(field (object_reference (object_reference name: (identifier) @type)))
(column_definition name: (identifier) @property)
(cte (identifier) @type)
(create_view (identifier) @type)
(create_index (identifier) @type)
(subquery name: (identifier) @variable)
(relation alias: (identifier) @variable)
(term alias: (identifier) @variable)
(insert alias: (identifier) @variable)
(function_argument (identifier) @variable.parameter)
(assignment left: (field name: (identifier) @property))

; Calls: built-in and user functions alike.
(invocation (object_reference name: (identifier) @function.call))
(invocation (object_reference schema: (identifier) @namespace))
(create_function (object_reference name: (identifier) @function.def))
(drop_function (object_reference name: (identifier) @function.call))
((term value: (cast name: (keyword_cast) @function.call)))

(function_language (identifier) @constant)
(interval) @string
(interval (keyword_interval) @type.builtin)
((field name: (identifier) @constant)
  (#match? @constant "^(?i)(current_timestamp|current_date|current_time|localtime|localtimestamp|current_user|session_user)$"))
(constraint name: (identifier) @type)

; ---- operators -----------------------------------------------------------------------------------

"::" @operator
["+" "-" "*" "/" "%" "^" ":=" "=" "<" "<=" "!=" ">=" ">" "<>"] @operator
(op_other) @operator
(op_unary_other) @operator
["(" ")" "[" "]"] @punctuation.bracket
[";" "," "."] @punctuation.delimiter
(field column: (identifier) @property)
(column (identifier) @property)
((identifier) @variable.parameter
  (#match? @variable.parameter "^@"))
